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
  SESSION_SECRET?: string;
  MESHY_API_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
}

interface D1Database {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>;
      run(): Promise<{ meta: { changes: number } }>;
    };
  };
  exec(sql: string): Promise<unknown>;
}

const SIGNUP_CREDITS = 3;
const MESHY_BALANCE_FLOOR = 100;
const PACKS: Record<string, { credits: number; usd: number; label: string }> = {
  starter: { credits: 10, usd: 500, label: 'GLBForge — 10 generations' },
  studio: { credits: 40, usd: 1500, label: 'GLBForge — 40 generations' },
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

async function makeSession(env: Env, uid: number, login: string): Promise<string> {
  const exp = Date.now() + 30 * 24 * 3600 * 1000;
  const body = `${uid}.${login}.${exp}`;
  return `${body}.${await hmac(env.SESSION_SECRET!, body)}`;
}

async function readSession(env: Env, request: Request): Promise<{ uid: number; login: string } | null> {
  if (!env.SESSION_SECRET) return null;
  const cookie = request.headers.get('cookie') ?? '';
  const match = /(?:^|;\s*)gf_s=([^;]+)/.exec(cookie);
  if (!match) return null;
  const parts = match[1].split('.');
  if (parts.length !== 4) return null;
  const [uid, login, exp, sig] = parts;
  if (Number(exp) < Date.now()) return null;
  if ((await hmac(env.SESSION_SECRET, `${uid}.${login}.${exp}`)) !== sig) return null;
  return { uid: Number(uid), login };
}

const sessionCookie = (value: string, maxAge: number) =>
  `gf_s=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

// --- storage ---------------------------------------------------------------
async function ensureSchema(db: D1Database): Promise<void> {
  await db.exec(
    'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, login TEXT NOT NULL, credits INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);' +
    'CREATE TABLE IF NOT EXISTS tasks (task_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL);' +
    'CREATE TABLE IF NOT EXISTS purchases (session_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, credits INTEGER NOT NULL, created_at INTEGER NOT NULL);',
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
async function stripeCheckout(env: Env, uid: number, pack: string, origin: string): Promise<string> {
  const p = PACKS[pack];
  const params = new URLSearchParams({
    mode: 'payment',
    success_url: `${origin}/studio/?purchase=success`,
    cancel_url: `${origin}/studio/?purchase=cancelled`,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(p.usd),
    'line_items[0][price_data][product_data][name]': p.label,
    'metadata[uid]': String(uid),
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
      // ---- auth ----
      if (path === '/api/auth/login') {
        if (!env.GITHUB_CLIENT_ID) return json({ error: 'auth not configured yet' }, 503);
        const state = crypto.randomUUID();
        const target = new URL('https://github.com/login/oauth/authorize');
        target.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
        target.searchParams.set('redirect_uri', `${url.origin}/api/auth/callback`);
        target.searchParams.set('state', state);
        return new Response(null, {
          status: 302,
          headers: {
            location: target.toString(),
            'set-cookie': `gf_o=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
          },
        });
      }

      if (path === '/api/auth/callback') {
        if (!env.DB || !env.GITHUB_CLIENT_SECRET || !env.SESSION_SECRET) {
          return json({ error: 'auth not configured yet' }, 503);
        }
        const state = url.searchParams.get('state');
        const cookieState = /(?:^|;\s*)gf_o=([^;]+)/.exec(request.headers.get('cookie') ?? '')?.[1];
        if (!state || state !== cookieState) return json({ error: 'state mismatch — retry sign-in' }, 400);

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
        const userRes = await fetch('https://api.github.com/user', {
          headers: { authorization: `Bearer ${token.access_token}`, 'user-agent': 'glbforge' },
        });
        const ghUser = (await userRes.json()) as { id: number; login: string };

        await ensureSchema(env.DB);
        await env.DB.prepare(
          'INSERT INTO users (id, login, credits, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET login = excluded.login',
        ).bind(ghUser.id, ghUser.login, SIGNUP_CREDITS, Date.now()).run();

        return new Response(null, {
          status: 302,
          headers: {
            location: '/studio/',
            'set-cookie': sessionCookie(await makeSession(env, ghUser.id, ghUser.login), 30 * 24 * 3600),
          },
        });
      }

      if (path === '/api/auth/me') {
        const session = await readSession(env, request);
        if (!session || !env.DB) return json({ user: null });
        await ensureSchema(env.DB);
        const row = await env.DB.prepare('SELECT login, credits FROM users WHERE id = ?')
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
        if (!env.DB || !env.MESHY_API_KEY) return json({ error: 'generation not configured yet' }, 503);

        // Upstream kill-switch: stop selling what we can't deliver.
        const balanceRes = await meshy(env, 'GET', '/openapi/v1/balance');
        const { balance } = (await balanceRes.json()) as { balance: number };
        if (balance < MESHY_BALANCE_FLOOR) {
          return json({ error: 'generation is temporarily unavailable — try again later' }, 503);
        }

        // Atomic decrement: only succeeds while credits remain.
        await ensureSchema(env.DB);
        const dec = await env.DB.prepare('UPDATE users SET credits = credits - 1 WHERE id = ? AND credits > 0')
          .bind(session.uid).run();
        if (dec.meta.changes === 0) return json({ error: 'out of credits' }, 402);

        try {
          const mime = url.searchParams.get('mime') ?? 'image/png';
          const bytes = new Uint8Array(await request.arrayBuffer());
          if (bytes.length === 0 || bytes.length > 12 * 1024 * 1024) throw new Error('image must be 1 byte – 12MB');
          let b64 = '';
          for (let i = 0; i < bytes.length; i += 0x8000) {
            b64 += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          }
          const createRes = await meshy(env, 'POST', '/openapi/v1/image-to-3d', {
            image_url: `data:${mime};base64,${btoa(b64)}`,
            should_texture: true,
            enable_pbr: url.searchParams.get('pbr') === 'true',
          });
          const created = (await createRes.json()) as { result?: string; message?: string };
          if (!created.result) throw new Error(created.message ?? 'Meshy refused the task');
          await env.DB.prepare('INSERT INTO tasks (task_id, user_id, kind, created_at) VALUES (?, ?, ?, ?)')
            .bind(created.result, session.uid, 'image-to-3d', Date.now()).run();
          return json({ taskId: created.result, kind: 'image-to-3d' });
        } catch (err) {
          // Refund on any failure after the decrement.
          await env.DB.prepare('UPDATE users SET credits = credits + 1 WHERE id = ?').bind(session.uid).run();
          throw err;
        }
      }

      const taskMatch = /^\/api\/gen\/tasks\/([\w-]+)(\/file)?$/.exec(path);
      if (taskMatch) {
        const session = await readSession(env, request);
        if (!session || !env.DB) return json({ error: 'sign in required' }, 401);
        const owned = await env.DB.prepare('SELECT kind FROM tasks WHERE task_id = ? AND user_id = ?')
          .bind(taskMatch[1], session.uid).first<{ kind: string }>();
        if (!owned) return json({ error: 'no such task' }, 404);

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
      if (path === '/api/billing/packs') return json(PACKS);

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
          const uid = Number(metadata?.uid), credits = Number(metadata?.credits);
          if (uid && credits) {
            await ensureSchema(env.DB);
            // Idempotent: purchases.session_id is the primary key.
            const inserted = await env.DB.prepare(
              'INSERT OR IGNORE INTO purchases (session_id, user_id, credits, created_at) VALUES (?, ?, ?, ?)',
            ).bind(id, uid, credits, Date.now()).run();
            if (inserted.meta.changes === 1) {
              await env.DB.prepare('UPDATE users SET credits = credits + ? WHERE id = ?')
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
