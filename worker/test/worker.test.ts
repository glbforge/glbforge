/**
 * The worker handles money: credits are bought through Stripe and spent on
 * paid upstream generation. These specs run the real handler against a real
 * SQL engine (node:sqlite standing in for D1) with the upstreams stubbed, so
 * the statements under test are the ones that ship.
 */
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../index.js';

// Loaded through require: Vite does not know `node:sqlite` as a builtin.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const ORIGIN = 'https://glbforge.dev';
const SESSION_SECRET = 'test-session-secret';
const WEBHOOK_SECRET = 'whsec_test';
const UID = 'gh:42';

type Sqlite = InstanceType<typeof DatabaseSync>;

/** The slice of D1 the worker uses, backed by an in-memory SQLite database. */
function fakeD1(sqlite: Sqlite) {
  const statement = (sql: string, args: unknown[]) => ({
    sql, args,
    async first() { return (sqlite.prepare(sql).get(...(args as never[])) as Record<string, unknown>) ?? null; },
    async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...(args as never[])).changes) } }; },
    async all() { return { results: sqlite.prepare(sql).all(...(args as never[])) as Record<string, unknown>[] }; },
  });
  return {
    failNextBatchAfter: null as number | null,
    prepare: (sql: string) => ({ bind: (...args: unknown[]) => statement(sql, args) }),
    async exec(sql: string) { sqlite.exec(sql); },
    async batch(statements: ReturnType<typeof statement>[]) {
      sqlite.exec('BEGIN');
      try {
        const out = [];
        for (const [i, s] of statements.entries()) {
          if (this.failNextBatchAfter === i) { this.failNextBatchAfter = null; throw new Error('D1_ERROR: simulated'); }
          out.push(await s.run());
        }
        sqlite.exec('COMMIT');
        return out;
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

function sessionCookie(uid = UID, secret = SESSION_SECRET): string {
  const payload = Buffer.from(JSON.stringify({ uid, login: 'tester', exp: Date.now() + 60_000 })).toString('base64url');
  return `gf_s=${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

type Upstream = (url: string, init?: RequestInit) => Response | Promise<Response>;
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let sqlite: Sqlite;
let db: ReturnType<typeof fakeD1>;
let env: Record<string, unknown>;
let upstream: Upstream;
let upstreamCalls: string[];

const call = (path: string, init: RequestInit = {}) =>
  worker.fetch(new Request(ORIGIN + path, init), env as never);

const credits = () =>
  (sqlite.prepare('SELECT credits FROM users_v2 WHERE id = ?').get(UID) as { credits: number }).credits;

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:');
  db = fakeD1(sqlite);
  env = {
    DB: db, SESSION_SECRET, STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    MESHY_API_KEY: 'meshy-key', FAL_KEY: 'fal-key',
    ASSETS: { fetch: async () => new Response('asset') },
  };
  upstreamCalls = [];
  upstream = () => { throw new Error('unexpected upstream call'); };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    upstreamCalls.push(`${init?.method ?? 'GET'} ${url}`);
    return upstream(url, init);
  });
  // The first authenticated call creates the schema; then seed one user.
  await call('/api/auth/me', { headers: { cookie: sessionCookie() } });
  sqlite.prepare('INSERT INTO users_v2 (id, login, credits, created_at) VALUES (?, ?, ?, ?)').run(UID, 'tester', 10, 0);
});

afterEach(() => { vi.unstubAllGlobals(); sqlite.close(); });

describe('sessions', () => {
  it('accepts its own cookie and rejects one signed with another secret or altered after signing', async () => {
    const me = async (cookie: string) =>
      ((await (await call('/api/auth/me', { headers: { cookie } })).json()) as { user: unknown }).user;
    expect(await me(sessionCookie())).toEqual({ login: 'tester', credits: 10 });
    expect(await me(sessionCookie(UID, 'another-secret'))).toBeNull();
    const [payload, sig] = sessionCookie().slice('gf_s='.length).split('.');
    const forged = Buffer.from(JSON.stringify({ uid: 'gh:1', login: 'x', exp: Date.now() + 60_000 })).toString('base64url');
    expect(payload).not.toBe(forged);
    expect(await me(`gf_s=${forged}.${sig}`)).toBeNull();
    expect(await me('gf_s=not-base64!.%%%')).toBeNull();
  });

  it('refuses a cross-origin POST', async () => {
    const res = await call('/api/auth/logout', { method: 'POST', headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
  });
});

describe('stripe webhook', () => {
  const event = (over: Record<string, unknown> = {}, type = 'checkout.session.completed') => JSON.stringify({
    type,
    data: { object: { id: 'cs_1', payment_status: 'paid', metadata: { uid: UID, credits: '20' }, ...over } },
  });
  const sign = (payload: string, t = Math.floor(Date.now() / 1000), secret = WEBHOOK_SECRET) =>
    `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
  const deliver = (payload: string, signature: string) =>
    call('/api/billing/webhook', { method: 'POST', body: payload, headers: { 'stripe-signature': signature } });

  it('credits a paid checkout exactly once, however often it is delivered', async () => {
    const payload = event();
    expect((await deliver(payload, sign(payload))).status).toBe(200);
    expect((await deliver(payload, sign(payload))).status).toBe(200);
    expect(credits()).toBe(30);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM purchases').get()).toEqual({ n: 1 });
  });

  it('a failure part-way leaves no purchase row, so the redelivery still credits', async () => {
    const payload = event();
    db.failNextBatchAfter = 1; // credit applied, purchase insert fails
    expect((await deliver(payload, sign(payload))).status).toBe(500);
    expect(credits()).toBe(10);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM purchases').get()).toEqual({ n: 0 });
    expect((await deliver(payload, sign(payload))).status).toBe(200);
    expect(credits()).toBe(30);
  });

  it('rejects a bad signature, a stale timestamp and a malformed header', async () => {
    const payload = event();
    const stale = Math.floor(Date.now() / 1000) - 3600;
    for (const signature of [
      sign(payload, undefined, 'whsec_wrong'),
      sign(payload, stale),
      sign(event({ metadata: { uid: UID, credits: '9999' } })), // signature for a different body
      't=abc,v1=zz', '', 'v1=00',
    ]) {
      expect((await deliver(payload, signature)).status).toBe(400);
    }
    expect(credits()).toBe(10);
  });

  it('accepts any v1 in the header, as sent while a signing secret is rolled', async () => {
    const payload = event();
    const good = sign(payload);
    const t = good.slice(2, good.indexOf(','));
    const rolled = `t=${t},v1=${'0'.repeat(64)},${good.slice(good.indexOf('v1='))}`;
    expect((await deliver(payload, rolled)).status).toBe(200);
    expect(credits()).toBe(30);
  });

  it('holds an unpaid checkout until the async payment succeeds', async () => {
    const unpaid = event({ payment_status: 'unpaid' });
    expect((await deliver(unpaid, sign(unpaid))).status).toBe(200);
    expect(credits()).toBe(10);
    const paid = event({}, 'checkout.session.async_payment_succeeded');
    expect((await deliver(paid, sign(paid))).status).toBe(200);
    expect(credits()).toBe(30);
  });

  it('ignores credit amounts that are not positive integers', async () => {
    for (const bad of ['-5', '1.5', 'abc', '0']) {
      const payload = event({ id: `cs_${bad}`, metadata: { uid: UID, credits: bad } });
      expect((await deliver(payload, sign(payload))).status).toBe(200);
    }
    expect(credits()).toBe(10);
  });
});

describe('generation credits', () => {
  const generate = (query = '') => call(`/api/gen/image${query}`, {
    method: 'POST', body: new Uint8Array([1, 2, 3]), headers: { cookie: sessionCookie(), origin: ORIGIN },
  });
  const poll = (id: string, file = false) =>
    call(`/api/gen/tasks/${id}${file ? '/file' : ''}`, { headers: { cookie: sessionCookie() } });

  it('refuses to sell when the Meshy balance cannot be read, or is under the floor', async () => {
    for (const balance of [() => reply({ message: 'unauthorized' }, 401), () => new Response('<html>', { status: 502 }), () => reply({ balance: 99 }), () => reply({})]) {
      upstream = balance;
      expect((await generate()).status).toBe(503);
    }
    expect(credits()).toBe(10);
    expect(upstreamCalls.every((c) => c.endsWith('/openapi/v1/balance'))).toBe(true);
  });

  it('charges on submit, and refunds when the upstream refuses the task', async () => {
    upstream = (url) => url.endsWith('/balance') ? reply({ balance: 5000 }) : reply({ message: 'bad image' }, 400);
    const res = await generate('?pbr=true');
    expect(res.status).toBe(500);
    expect(credits()).toBe(10);
  });

  it('says 402 without charging when the account cannot cover the cost', async () => {
    sqlite.prepare('UPDATE users_v2 SET credits = 1 WHERE id = ?').run(UID);
    upstream = () => reply({ balance: 5000 });
    expect((await generate()).status).toBe(402);
    expect(credits()).toBe(1);
  });

  it('refunds a Meshy task that fails later — once — and closes its download', async () => {
    let status = 'IN_PROGRESS';
    upstream = (url) => url.endsWith('/balance') ? reply({ balance: 5000 })
      : url.endsWith('/image-to-3d') ? reply({ result: 'task-1' })
      : reply({ status, progress: 40, task_error: { message: 'mesh exploded' }, model_urls: { glb: 'https://cdn.example/m.glb' } });
    expect(await (await generate('?pbr=true')).json()).toMatchObject({ taskId: 'task-1', cost: 3 });
    expect(credits()).toBe(7);
    expect(await (await poll('task-1')).json()).toMatchObject({ status: 'IN_PROGRESS' });
    expect(credits()).toBe(7);

    status = 'FAILED';
    const [a, b] = await Promise.all([poll('task-1'), poll('task-1')]);
    expect(await a.json()).toMatchObject({ status: 'FAILED' });
    expect(await b.json()).toMatchObject({ status: 'FAILED' });
    expect(credits()).toBe(10);

    // Even if the upstream later reports success, a refunded task stays closed.
    status = 'SUCCEEDED';
    expect((await poll('task-1')).status).toBe(200);
    expect(await (await poll('task-1')).json()).toMatchObject({ status: 'FAILED' });
    expect((await poll('task-1', true)).status).toBe(410);
    expect(credits()).toBe(10);
  });

  it('does not refund, or call it failed, when the Meshy status check itself errors', async () => {
    upstream = (url) => url.endsWith('/balance') ? reply({ balance: 5000 })
      : url.endsWith('/image-to-3d') ? reply({ result: 'task-2' })
      : new Response('gateway', { status: 502 });
    await generate();
    expect((await poll('task-2')).status).toBe(502);
    expect(credits()).toBe(8);
  });

  it('fal: a completed run with no model is a failure and is refunded once', async () => {
    let resultStatus = 422;
    upstream = (url, init) => init?.method === 'POST' ? reply({ request_id: 'req-1' })
      : url.endsWith('/status') ? reply({ status: 'COMPLETED' })
      : reply({ detail: 'generation failed' }, resultStatus);
    expect(await (await generate('?provider=trellis')).json()).toMatchObject({ taskId: 'req-1', cost: 1 });
    expect(credits()).toBe(9);
    expect(await (await poll('req-1')).json()).toMatchObject({ status: 'FAILED' });
    expect(await (await poll('req-1')).json()).toMatchObject({ status: 'FAILED' });
    expect(credits()).toBe(10);
    resultStatus = 200;
    expect((await poll('req-1', true)).status).toBe(410);
  });

  it('fal: an upstream 5xx on the result is not a failed generation', async () => {
    upstream = (url, init) => init?.method === 'POST' ? reply({ request_id: 'req-2' })
      : url.endsWith('/status') ? reply({ status: 'COMPLETED' })
      : new Response('gateway', { status: 503 });
    await generate('?provider=trellis');
    expect(await (await poll('req-2')).json()).toMatchObject({ status: 'IN_PROGRESS' });
    expect((await poll('req-2', true)).status).toBe(502);
    expect(credits()).toBe(9);
  });

  it('fal: asking for the file before the run finishes is "not yet", not a refund', async () => {
    upstream = (url, init) => init?.method === 'POST' ? reply({ request_id: 'req-3' })
      : url.endsWith('/status') ? reply({ status: 'IN_PROGRESS' })
      : reply({ detail: 'Request is still in progress' }, 400);
    await generate('?provider=trellis');
    expect((await poll('req-3', true)).status).toBe(409);
    expect(await (await poll('req-3')).json()).toMatchObject({ status: 'IN_PROGRESS' });
    expect(credits()).toBe(9);
  });

  it('fal: a completed run with a model succeeds and streams it', async () => {
    upstream = (url, init) => init?.method === 'POST' ? reply({ request_id: 'req-4' })
      : url.endsWith('/status') ? reply({ status: 'COMPLETED' })
      : url.endsWith('.glb') ? new Response('glTF-bytes')
      : reply({ model_mesh: { url: 'https://cdn.example/out.glb' } });
    await generate('?provider=trellis');
    expect(await (await poll('req-4')).json()).toMatchObject({ status: 'SUCCEEDED', progress: 100 });
    const file = await poll('req-4', true);
    expect(file.headers.get('content-type')).toBe('model/gltf-binary');
    expect(await file.text()).toBe('glTF-bytes');
    expect(credits()).toBe(9);
  });

  it("another account cannot see, or trigger a refund on, someone else's task", async () => {
    upstream = (url) => url.endsWith('/balance') ? reply({ balance: 5000 })
      : url.endsWith('/image-to-3d') ? reply({ result: 'task-9' }) : reply({ status: 'FAILED' });
    await generate();
    const res = await call('/api/gen/tasks/task-9', { headers: { cookie: sessionCookie('gh:7') } });
    expect(res.status).toBe(404);
    expect(credits()).toBe(8);
  });

  it('adds the refund columns to a tasks table created before they existed', async () => {
    const old = new DatabaseSync(':memory:');
    old.exec('CREATE TABLE tasks (task_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL);');
    old.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?)').run('legacy', UID, 'image-to-3d', 0);
    env.DB = fakeD1(old);
    await call('/api/auth/me', { headers: { cookie: sessionCookie() } });
    old.prepare('INSERT INTO users_v2 (id, login, credits, created_at) VALUES (?, ?, ?, ?)').run(UID, 'tester', 10, 0);
    upstream = () => reply({ status: 'FAILED' });
    // No recorded cost: the task reads as failed, and nothing is paid out.
    expect(await (await call('/api/gen/tasks/legacy', { headers: { cookie: sessionCookie() } })).json()).toMatchObject({ status: 'FAILED' });
    expect(old.prepare('SELECT credits FROM users_v2 WHERE id = ?').get(UID)).toEqual({ credits: 10 });
    old.close();
  });
});
