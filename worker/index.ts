/**
 * GLBForge edge API — runs alongside the static site on the same Worker.
 * Static assets are served first (Cloudflare default); only paths with no
 * matching asset (i.e. /api/*) reach this script.
 *
 * Scope note: the in-browser studio deliberately probes /api/profiles to
 * decide local vs remote mode — this worker must 404 that path so the
 * hosted studio stays in local (in-browser) mode. Only auth, generation
 * proxy, and billing live here.
 *
 * Credits model: 1 credit = 1 Meshy generation. New accounts get
 * SIGNUP_CREDITS free; Stripe Checkout tops up. Decrements are atomic
 * (conditional UPDATE), and generation disables itself when the upstream
 * Meshy balance drops below MESHY_BALANCE_FLOOR.
 */

interface Env {
  ASSETS: { fetch: (req: Request) => Promise<Response> };
  DB?: D1Database;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
  MESHY_API_KEY?: string;
  FAL_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
}

interface D1Database {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>;
      run(): Promise<{ meta: { changes: number } }>;
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
    };
  };
  exec(sql: string): Promise<unknown>;
}

const SIGNUP_CREDITS = 6;
const MESHY_BALANCE_FLOOR = 100;
// Generation costs in GLBForge credits, tiered by provider + features.
// Open models on GPU inference cost a fraction of Meshy upstream.
const GEN_COST = { textured: 2, pbr: 3, hunyuan: 2, trellis: 1, triposr: 1 };
const FAL_MODELS: Record<string, string> = {
  hunyuan: 'fal-ai/hunyuan3d/v2',
  trellis: 'fal-ai/trellis',
  triposr: 'fal-ai/triposr',
};

/** Deep scan a fal result for the first .glb URL. */
function findGlbUrl(value: unknown): string | null {
  if (typeof value === 'string') return /^https?:\/\/\S+\.glb(\?\S*)?$/i.test(value) ? value : null;
  if (Array.isArray(value)) { for (const v of value) { const hit = findGlbUrl(v); if (hit) return hit; } return null; }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      const hit = findGlbUrl((value as Record<string, unknown>)[key]);
      if (hit) return hit;
    }
  }
  return null;
}

async function fal(env: Env, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch('https://queue.fal.run' + path, {
    method,
    headers: {
      authorization: `Key ${env.FAL_KEY}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
const PACKS: Record<string, { credits: number; usd: number; label: string }> = {
  starter: { credits: 20, usd: 500, label: 'GLBForge — 20 credits' },
  studio: { credits: 80, usd: 1500, label: 'GLBForge — 80 credits' },
};

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

// --- session cookies: uid.login.exp.hmac ---------------------------------
async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/[+/=]/g, (c) =>
    ({ '+': '-', '/': '_', '=': '' })[c]!,
  );
}

function b64url(s: string): string {
  return btoa(s).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]!);
}

async function makeSession(env: Env, uid: string, login: string): Promise<string> {
  const payload = b64url(JSON.stringify({ uid, login, exp: Date.now() + 30 * 24 * 3600 * 1000 }));
  return `${payload}.${await hmac(env.SESSION_SECRET!, payload)}`;
}

async function readSession(env: Env, request: Request): Promise<{ uid: string; login: string } | null> {
  if (!env.SESSION_SECRET) return null;
  const match = /(?:^|;\s*)gf_s=([^;]+)/.exec(request.headers.get('cookie') ?? '');
  if (!match) return null;
  const [payload, sig] = match[1].split('.');
  if (!payload || !sig) return null;
  if ((await hmac(env.SESSION_SECRET, payload)) !== sig) return null;
  try {
    const data = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { uid: string; login: string; exp: number };
    if (data.exp < Date.now()) return null;
    return { uid: data.uid, login: data.login };
  } catch { return null; }
}

const sessionCookie = (value: string, maxAge: number) =>
  `gf_s=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

// --- storage ---------------------------------------------------------------
async function ensureSchema(db: D1Database): Promise<void> {
  // users_v2 keys are provider-scoped strings ('gh:123', 'gg:1042...') so
  // multiple identity providers can't collide. v1 rows migrate as GitHub.
  await db.exec(
    'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, login TEXT NOT NULL, credits INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);' +
    'CREATE TABLE IF NOT EXISTS users_v2 (id TEXT PRIMARY KEY, login TEXT NOT NULL, credits INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);' +
    "INSERT OR IGNORE INTO users_v2 SELECT 'gh:' || id, login, credits, created_at FROM users;" +
    'CREATE TABLE IF NOT EXISTS tasks (task_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL);' +
    'CREATE TABLE IF NOT EXISTS purchases (session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, credits INTEGER NOT NULL, created_at INTEGER NOT NULL);',
  );
}

// --- meshy proxy -------------------------------------------------------------
const MESHY = 'https://api.meshy.ai';
async function meshy(env: Env, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(MESHY + path, {
    method,
    headers: {
      authorization: `Bearer ${env.MESHY_API_KEY}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// --- stripe (form-encoded REST; no SDK needed on workers) -------------------
async function stripeCheckout(env: Env, uid: string, pack: string, origin: string): Promise<string> {
  const p = PACKS[pack];
  const params = new URLSearchParams({
    mode: 'payment',
    success_url: `${origin}/studio/?purchase=success`,
    cancel_url: `${origin}/studio/?purchase=cancelled`,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(p.usd),
    'line_items[0][price_data][product_data][name]': p.label,
    'metadata[uid]': uid,
    'metadata[credits]': String(p.credits),
  });
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });
  const session = (await res.json()) as { url?: string; error?: { message: string } };
  if (!session.url) throw new Error(session.error?.message ?? 'checkout failed');
  return session.url;
}

async function verifyStripeSignature(env: Env, payload: string, header: string): Promise<boolean> {
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]));
  if (!parts.t || !parts.v1) return false;
  const expected = await (async () => {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET!),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${parts.t}.${payload}`));
    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  })();
  return expected === parts.v1;
}

// --- router -----------------------------------------------------------------
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);

    // CSRF floor for state-changing calls: must come from our own origin.
    if (request.method === 'POST') {
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin) return json({ error: 'cross-origin request refused' }, 403);
    }

    try {
      // ---- auth (provider-aware: github | google) ----
      if (path === '/api/auth/providers') {
        return json({
          rev: 'r3', // bump on worker changes to verify what's deployed
          github: !!env.GITHUB_CLIENT_ID,
          google: !!env.GOOGLE_CLIENT_ID,
          generators: {
            meshy: !!env.MESHY_API_KEY,
            ...(env.FAL_KEY ? { hunyuan: true, trellis: true, triposr: true } : {}),
          },
          costs: GEN_COST,
        });
      }

      if (path === '/api/auth/login') {
        const provider = url.searchParams.get('provider') === 'google' ? 'google' : 'github';
        const state = crypto.randomUUID();
        let target: URL;
        if (provider === 'google') {
          if (!env.GOOGLE_CLIENT_ID) return json({ error: 'Google sign-in not configured yet' }, 503);
          target = new URL('https://accounts.google.com/o/oauth2/v2/auth');
          target.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
          target.searchParams.set('response_type', 'code');
          target.searchParams.set('scope', 'openid email profile');
        } else {
          if (!env.GITHUB_CLIENT_ID) return json({ error: 'auth not configured yet' }, 503);
          target = new URL('https://github.com/login/oauth/authorize');
          target.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
        }
        target.searchParams.set('redirect_uri', `${url.origin}/api/auth/callback`);
        target.searchParams.set('state', state);
        return new Response(null, {
          status: 302,
          headers: {
            location: target.toString(),
            'set-cookie': `gf_o=${state}:${provider}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
          },
        });
      }

      if (path === '/api/auth/callback') {
        if (!env.DB || !env.SESSION_SECRET) return json({ error: 'auth not configured yet' }, 503);
        const state = url.searchParams.get('state');
        const cookieVal = /(?:^|;\s*)gf_o=([^;]+)/.exec(request.headers.get('cookie') ?? '')?.[1] ?? '';
        const [cookieState, provider = 'github'] = cookieVal.split(':');
        if (!state || state !== cookieState) return json({ error: 'state mismatch — retry sign-in' }, 400);

        let uid: string, login: string;
        if (provider === 'google') {
          const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: env.GOOGLE_CLIENT_ID!,
              client_secret: env.GOOGLE_CLIENT_SECRET!,
              code: url.searchParams.get('code') ?? '',
              grant_type: 'authorization_code',
              redirect_uri: `${url.origin}/api/auth/callback`,
            }),
          });
          const token = (await tokenRes.json()) as { access_token?: string };
          if (!token.access_token) return json({ error: 'Google sign-in failed' }, 401);
          const info = (await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
            headers: { authorization: `Bearer ${token.access_token}` },
          })).json()) as { sub: string; email?: string; name?: string };
          uid = `gg:${info.sub}`;
          login = info.email ?? info.name ?? `google-${info.sub.slice(0, 8)}`;
        } else {
          const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({
              client_id: env.GITHUB_CLIENT_ID,
              client_secret: env.GITHUB_CLIENT_SECRET,
              code: url.searchParams.get('code'),
            }),
          });
          const token = (await tokenRes.json()) as { access_token?: string };
          if (!token.access_token) return json({ error: 'GitHub sign-in failed' }, 401);
          const ghUser = (await (await fetch('https://api.github.com/user', {
            headers: { authorization: `Bearer ${token.access_token}`, 'user-agent': 'glbforge' },
          })).json()) as { id: number; login: string };
          uid = `gh:${ghUser.id}`;
          login = ghUser.login;
        }

        await ensureSchema(env.DB);
        await env.DB.prepare(
          'INSERT INTO users_v2 (id, login, credits, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET login = excluded.login',
        ).bind(uid, login, SIGNUP_CREDITS, Date.now()).run();

        return new Response(null, {
          status: 302,
          headers: {
            location: '/studio/',
            'set-cookie': sessionCookie(await makeSession(env, uid, login), 30 * 24 * 3600),
          },
        });
      }

      if (path === '/api/auth/me') {
        const session = await readSession(env, request);
        if (!session || !env.DB) return json({ user: null });
        await ensureSchema(env.DB);
        const row = await env.DB.prepare('SELECT login, credits FROM users_v2 WHERE id = ?')
          .bind(session.uid).first<{ login: string; credits: number }>();
        return json({ user: row ? { login: row.login, credits: row.credits } : null });
      }

      if (path === '/api/auth/logout' && request.method === 'POST') {
        return json({ ok: true }, 200, { 'set-cookie': sessionCookie('x', 0) });
      }

      // ---- generation proxy (credits) ----
      if (path === '/api/gen/image' && request.method === 'POST') {
        const session = await readSession(env, request);
        if (!session) return json({ error: 'sign in to generate' }, 401);
        if (!env.DB) return json({ error: 'generation not configured yet' }, 503);

        const provider = url.searchParams.get('provider') ?? 'meshy';
        if (provider === 'meshy' && !env.MESHY_API_KEY) return json({ error: 'Meshy generation not configured' }, 503);
        if (provider !== 'meshy' && (!env.FAL_KEY || !FAL_MODELS[provider])) {
          return json({ error: `${provider} generation not available` }, 503);
        }

        if (provider === 'meshy') {
          // Upstream kill-switch: stop selling what we can't deliver.
          const balanceRes = await meshy(env, 'GET', '/openapi/v1/balance');
          const { balance } = (await balanceRes.json()) as { balance: number };
          if (balance < MESHY_BALANCE_FLOOR) {
            return json({ error: 'generation is temporarily unavailable — try again later' }, 503);
          }
        }

        // Tiered cost; atomic decrement only succeeds with enough balance.
        const cost = provider === 'meshy'
          ? (url.searchParams.get('pbr') === 'true' ? GEN_COST.pbr : GEN_COST.textured)
          : (GEN_COST as Record<string, number>)[provider];
        await ensureSchema(env.DB);
        const dec = await env.DB.prepare('UPDATE users_v2 SET credits = credits - ? WHERE id = ? AND credits >= ?')
          .bind(cost, session.uid, cost).run();
        if (dec.meta.changes === 0) return json({ error: `needs ${cost} credits — buy more or drop PBR` }, 402);

        try {
          const mime = url.searchParams.get('mime') ?? 'image/png';
          const bytes = new Uint8Array(await request.arrayBuffer());
          if (bytes.length === 0 || bytes.length > 12 * 1024 * 1024) throw new Error('image must be 1 byte – 12MB');
          let b64 = '';
          for (let i = 0; i < bytes.length; i += 0x8000) {
            b64 += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          }
          const dataUri = `data:${mime};base64,${btoa(b64)}`;
          let taskId: string, kind: string;
          if (provider === 'meshy') {
            const createRes = await meshy(env, 'POST', '/openapi/v1/image-to-3d', {
              image_url: dataUri,
              should_texture: true,
              enable_pbr: url.searchParams.get('pbr') === 'true',
            });
            const created = (await createRes.json()) as { result?: string; message?: string };
            if (!created.result) throw new Error(created.message ?? 'Meshy refused the task');
            taskId = created.result;
            kind = 'image-to-3d';
          } else {
            const model = FAL_MODELS[provider];
            const submitRes = await fal(env, 'POST', `/${model}`, {
              image_url: dataUri, input_image_url: dataUri, input_image_urls: [dataUri],
              textured_mesh: true, texture: true,
            });
            const submitted = (await submitRes.json()) as { request_id?: string; detail?: string };
            if (!submitted.request_id) throw new Error(String(submitted.detail ?? `${provider} refused the task`));
            taskId = submitted.request_id;
            kind = `fal:${model}`;
          }
          await env.DB.prepare('INSERT INTO tasks (task_id, user_id, kind, created_at) VALUES (?, ?, ?, ?)')
            .bind(taskId, session.uid, kind, Date.now()).run();
          return json({ taskId, kind, cost });
        } catch (err) {
          // Refund on any failure after the decrement.
          await env.DB.prepare('UPDATE users_v2 SET credits = credits + ? WHERE id = ?').bind(cost, session.uid).run();
          throw err;
        }
      }

      if (path === '/api/gen/history') {
        const session = await readSession(env, request);
        if (!session || !env.DB) return json({ tasks: [] });
        await ensureSchema(env.DB);
        const rows = await env.DB.prepare(
          'SELECT task_id, kind, created_at FROM tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
        ).bind(session.uid).all<{ task_id: string; kind: string; created_at: number }>();
        return json({ tasks: rows.results ?? [] });
      }

      const taskMatch = /^\/api\/gen\/tasks\/([\w-]+)(\/file)?$/.exec(path);
      if (taskMatch) {
        const session = await readSession(env, request);
        if (!session || !env.DB) return json({ error: 'sign in required' }, 401);
        const owned = await env.DB.prepare('SELECT kind FROM tasks WHERE task_id = ? AND user_id = ?')
          .bind(taskMatch[1], session.uid).first<{ kind: string }>();
        if (!owned) return json({ error: 'no such task' }, 404);

        if (owned.kind.startsWith('fal:')) {
          const model = owned.kind.slice(4).split('/').slice(0, 2).join('/');
          if (!taskMatch[2]) {
            const statusRes = await fal(env, 'GET', `/${model}/requests/${taskMatch[1]}/status`);
            const st = (await statusRes.json()) as
              { status?: string; queue_position?: number; detail?: unknown };
            if (!statusRes.ok || !st.status) {
              // Surface upstream failures instead of masking them as queued.
              return json({
                status: 'IN_PROGRESS', progress: 5,
                error: `status check failed (HTTP ${statusRes.status})`,
              });
            }
            const progress = st.status === 'COMPLETED' ? 100 : st.status === 'IN_PROGRESS' ? 50 : 8;
            return json({
              status: st.status === 'COMPLETED' ? 'SUCCEEDED' : 'IN_PROGRESS',
              progress, error: null,
            });
          }
          const result = (await (await fal(env, 'GET', `/${model}/requests/${taskMatch[1]}`)).json()) as unknown;
          const glbUrl = findGlbUrl(result);
          if (!glbUrl) return json({ error: 'no model in result yet' }, 409);
          const glb = await fetch(glbUrl);
          return new Response(glb.body, { headers: { 'content-type': 'model/gltf-binary' } });
        }

        const taskRes = await meshy(env, 'GET', `/openapi/v1/${owned.kind}/${taskMatch[1]}`);
        const task = (await taskRes.json()) as {
          status: string; progress: number;
          task_error?: { message?: string }; model_urls?: { glb?: string };
        };
        if (!taskMatch[2]) {
          return json({
            status: task.status, progress: task.progress,
            error: task.task_error?.message ?? null,
          });
        }
        if (task.status !== 'SUCCEEDED' || !task.model_urls?.glb) {
          return json({ error: `task is ${task.status}` }, 409);
        }
        const glb = await fetch(task.model_urls.glb);
        return new Response(glb.body, {
          headers: { 'content-type': 'model/gltf-binary' },
        });
      }

      // ---- billing ----
      if (path === '/api/billing/packs') {
        return json({
          packs: PACKS,
          checkout: !!env.STRIPE_SECRET_KEY,
          webhook: !!env.STRIPE_WEBHOOK_SECRET,
          mode: env.STRIPE_SECRET_KEY?.startsWith('sk_test') ? 'test'
            : env.STRIPE_SECRET_KEY?.startsWith('sk_live') ? 'live' : null,
        });
      }

      if (path === '/api/billing/checkout' && request.method === 'POST') {
        const session = await readSession(env, request);
        if (!session) return json({ error: 'sign in first' }, 401);
        if (!env.STRIPE_SECRET_KEY) return json({ error: 'purchases are not open yet' }, 503);
        const { pack } = (await request.json()) as { pack: string };
        if (!PACKS[pack]) return json({ error: 'unknown pack' }, 400);
        return json({ url: await stripeCheckout(env, session.uid, pack, url.origin) });
      }

      if (path === '/api/billing/webhook' && request.method === 'POST') {
        if (!env.STRIPE_WEBHOOK_SECRET || !env.DB) return json({ error: 'not configured' }, 503);
        const payload = await request.text();
        const signature = request.headers.get('stripe-signature') ?? '';
        if (!(await verifyStripeSignature(env, payload, signature))) {
          return json({ error: 'bad signature' }, 400);
        }
        const event = JSON.parse(payload) as {
          type: string;
          data: { object: { id: string; metadata?: { uid?: string; credits?: string } } };
        };
        if (event.type === 'checkout.session.completed') {
          const { id, metadata } = event.data.object;
          const uid = metadata?.uid ?? '', credits = Number(metadata?.credits);
          if (uid && credits) {
            await ensureSchema(env.DB);
            // Idempotent: purchases.session_id is the primary key.
            const inserted = await env.DB.prepare(
              'INSERT OR IGNORE INTO purchases (session_id, user_id, credits, created_at) VALUES (?, ?, ?, ?)',
            ).bind(id, uid, credits, Date.now()).run();
            if (inserted.meta.changes === 1) {
              await env.DB.prepare('UPDATE users_v2 SET credits = credits + ? WHERE id = ?')
                .bind(credits, uid).run();
            }
          }
        }
        return json({ received: true });
      }

      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : 'internal error' }, 500);
    }
  },
};
