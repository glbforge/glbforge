/**
 * GLBForge companion — Electron main process.
 *
 * One transparent, frameless, always-on-top window renders a GLB with its
 * animation clips (three.js in renderer/). A localhost HTTP server on
 * GLBFORGE_COMPANION_PORT (default 4747) is the asset server for the renderer
 * and the control surface an agent drives. Every reply is an envelope:
 * { ok, summary, data, state } — state is the body after the call, so an
 * agent never has to follow up with /state to learn what it just did.
 *
 *   GET  /state                        everything: model, clips, playing (with clip time), bubble, gesture, window, brain, recent events
 *   GET  /events?since=<n>             the event log (clicks, drags, messages, replies, tool calls)
 *   POST /load     {path}              load another .glb
 *   POST /play     {clip, loop}        a baked clip by name; loop=false: once, then back to idle
 *   POST /emote    {gesture}           hop | spin | nod | shake | wave — procedural, any GLB
 *   POST /say      {text, seconds}     speech bubble
 *   POST /move     {x, y} | {corner}   move the window
 *   POST /snapshot {out?}              PNG of the window, file or base64
 *   POST /chat     {text}              talk to the character (embedded brain answers; external brain: queued for /listen)
 *   POST /event    {text, source}      tell the character something happened (CI failed, task done); it reacts
 *   GET  /listen?timeout=25            external brain: long-poll the next unanswered message / event
 *   POST /reply    {id, text, seconds} external brain: answer an item from /listen (bubble + marks it answered)
 *   POST /quit
 *
 * Brain: GLBFORGE_COMPANION_BRAIN = sdk (default: Claude Agent SDK on the user's
 * Claude Code login) | external (any MCP client via /listen + /reply) | off.
 * Nothing here is networked beyond 127.0.0.1 except the brain's own model calls.
 */
import { app, BrowserWindow, ipcMain, screen } from 'electron';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createBrain } from './brain.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// three is served to the renderer from wherever it resolves: under companion/ in a checkout, hoisted in an npx cache.
// three's exports map hides package.json; its main entry is <dir>/build/three.module.js (or three.cjs) — walk up to the package dir.
const THREE_DIR = path.resolve(path.dirname(createRequire(import.meta.url).resolve('three')), '..');
const PORT = Number(process.env.GLBFORGE_COMPANION_PORT || 4747);
const SIZE = Number(process.env.GLBFORGE_COMPANION_SIZE || 320);
const HEIGHT = Math.round(SIZE * 1.3);   // the extra band on top is where the speech bubble lives
const BRAIN_MODE = (process.env.GLBFORGE_COMPANION_BRAIN || 'sdk').toLowerCase();
const argModel = process.argv.slice(1).find((a) => /\.(glb|gltf)$/i.test(a)) || process.env.GLBFORGE_COMPANION_MODEL || null;
const STARTED = Date.now();

let win = null;
let modelPath = argModel ? path.resolve(argModel) : null;
let modelBytes = null;
const state = { model: modelPath, model_bytes: null, clips: [], playing: null, bubble: null, loaded: false, error: null, triangles: null, meshes: null };
let brain = null;

// ---------------------------------------------------------------- event log + inbox (for an external brain)
const events = [];
let eventSeq = 0;
function pushEvent(kind, fields = {}) {
  const e = { id: ++eventSeq, t: new Date().toISOString(), kind, ...fields };
  events.push(e);
  if (events.length > 200) events.splice(0, events.length - 200);
  for (const w of listeners.splice(0)) w(e);
  return e;
}
const inbox = [];          // unanswered user messages / events when the brain is external
const listeners = [];      // /listen long-poll waiters
const answered = new Set();

// ---------------------------------------------------------------- renderer RPC
const pending = new Map();
let seq = 0;
function ask(cmd, payload = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!win) return reject(new Error('window not ready'));
    const id = ++seq;
    pending.set(id, { resolve, reject });
    win.webContents.send('companion:cmd', { id, cmd, payload });
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`renderer did not answer "${cmd}" within ${timeoutMs} ms`)); }, timeoutMs);
  });
}
ipcMain.on('companion:reply', (_e, { id, ok, result, error }) => {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  ok ? p.resolve(result) : p.reject(new Error(error));
});
ipcMain.on('companion:state', (_e, patch) => Object.assign(state, patch));
ipcMain.on('companion:event', (_e, { kind, ...fields }) => pushEvent(kind, fields));
ipcMain.handle('companion:chat', async (_e, { text }) => chat(text, 'typed'));

// ---------------------------------------------------------------- drag + cursor
let drag = null;
ipcMain.on('companion:drag-start', () => {
  const c = screen.getCursorScreenPoint();
  const [x, y] = win.getPosition();
  drag = { ox: c.x - x, oy: c.y - y, start: c, moved: false, last: c, vx: 0, timer: setInterval(() => {
    const p = screen.getCursorScreenPoint();
    if (Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > 3) drag.moved = true;
    drag.vx = p.x - drag.last.x; drag.last = p;
    if (drag.moved) { win.setPosition(Math.round(p.x - drag.ox), Math.round(p.y - drag.oy)); win.webContents.send('companion:drag', { vx: drag.vx }); }
  }, 16) };
});
ipcMain.handle('companion:drag-end', () => {
  if (!drag) return { moved: false };
  clearInterval(drag.timer);
  const moved = drag.moved;
  drag = null;
  if (moved) pushEvent('drag', { position: position() });
  return { moved };
});
ipcMain.handle('companion:cursor', () => {
  if (!win) return null;
  const c = screen.getCursorScreenPoint();
  const [x, y] = win.getPosition();
  const [w, h] = win.getSize();
  return { x: (c.x - x) / w, y: (c.y - y) / h };   // window-normalized; may be outside [0,1]
});

// ---------------------------------------------------------------- window
function position() { if (!win) return null; const [x, y] = win.getPosition(); const [w, h] = win.getSize(); return { x, y, width: w, height: h }; }
function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    width: SIZE, height: HEIGHT,
    x: workArea.x + workArea.width - SIZE - 24, y: workArea.y + workArea.height - HEIGHT - 24,
    transparent: true, frame: false, hasShadow: false, resizable: false, alwaysOnTop: true,
    skipTaskbar: true, fullscreenable: false, minimizable: false, title: 'GLBForge companion',
    webPreferences: { preload: path.join(HERE, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadURL(`http://127.0.0.1:${PORT}/`);
  win.on('closed', () => { win = null; });
}

// ---------------------------------------------------------------- body actions (shared by HTTP, MCP bridge and the brain)
async function fullState() {
  let live = {};
  try { live = await ask('state', {}, 2000); } catch { /* renderer busy: cached fields only */ }
  const { workArea } = screen.getPrimaryDisplay();
  return {
    model: state.model, model_bytes: state.model_bytes, loaded: state.loaded, error: state.error,
    triangles: state.triangles, meshes: state.meshes,
    clips: state.clips, idle_clip: state.clips.find((c) => /idle/i.test(c.name))?.name ?? state.clips[0]?.name ?? null,
    playing: live.playing ?? state.playing, clip_time_seconds: live.clip_time ?? null, loop: live.loop ?? null,
    gesture: live.gesture ?? null, bubble: live.bubble ?? state.bubble, bubble_remaining_seconds: live.bubble_remaining ?? null,
    thinking: live.thinking ?? false, chat_open: live.chat_open ?? false, gaze: live.gaze ?? null,
    window: position(), work_area: workArea, port: PORT, size: { width: SIZE, height: HEIGHT }, uptime_seconds: Math.round((Date.now() - STARTED) / 1000),
    brain: brain ? brain.status() : { mode: BRAIN_MODE, available: false },
    inbox_pending: inbox.length,
    recent_events: events.slice(-10),
  };
}
const compactState = (s) => ({ playing: s.playing, bubble: s.bubble, gesture: s.gesture, thinking: s.thinking, inbox_pending: s.inbox_pending, window: s.window });

const body = {
  async say({ text, seconds }) {
    text = String(text ?? '');
    const secs = Number(seconds ?? Math.min(12, 2 + text.length / 12));
    const r = await ask('say', { text, seconds: secs });
    state.bubble = text || null;
    pushEvent('say', { text, seconds: secs });
    const notes = [];
    if (text.length > 140) notes.push(`${text.length} characters: the bubble wraps to ~${Math.ceil(text.length / 34)} lines and shrinks; under 120 reads best`);
    return { shown: !!text, text, seconds: secs, chars: text.length, hides_at: new Date(Date.now() + secs * 1000).toISOString(), notes };
  },
  async emote({ gesture, seconds }) {
    const r = await ask('emote', { gesture, seconds });
    pushEvent('emote', { gesture });
    const baked = state.clips.find((c) => c.name.toLowerCase() === String(gesture).toLowerCase());
    return { ...r, notes: baked ? [`this model also has a baked "${baked.name}" clip (${baked.duration}s): play(clip="${baked.name}", loop=false) uses the authored motion instead of the procedural one`] : [] };
  },
  async play({ clip, loop = true, speed = 1 }) {
    const r = await ask('play', { clip, loop, speed });
    state.playing = r.playing;
    pushEvent('play', { clip: r.playing, loop });
    const idle = state.clips.find((c) => /idle/i.test(c.name))?.name ?? null;
    return { ...r, returns_to: loop ? null : idle, ends_at: loop ? null : new Date(Date.now() + (r.duration / speed) * 1000).toISOString() };
  },
  async load(p) {
    const abs = path.resolve(p);
    const bytes = await fs.promises.readFile(abs);
    modelPath = abs; modelBytes = bytes;
    Object.assign(state, { model: abs, model_bytes: bytes.byteLength, loaded: false, error: null, clips: [], playing: null, triangles: null, meshes: null });
    const r = await ask('load', { name: path.basename(abs), bytes: bytes.byteLength }, 30000);
    pushEvent('load', { model: abs, clips: r.clips });
    return { model: abs, bytes: bytes.byteLength, ...r, notes: r.clips.length ? [] : ['no animation clips: the model will gaze and gesture procedurally; run `glbforge animate` to give it an idle loop'] };
  },
  async snapshot(out) {
    if (!win) throw new Error('no window');
    const img = await win.webContents.capturePage();
    const png = img.toPNG();
    if (out) { await fs.promises.mkdir(path.dirname(out), { recursive: true }); await fs.promises.writeFile(out, png); }
    return { png_base64: out ? undefined : png.toString('base64'), out: out ?? null, bytes: png.byteLength, size: img.getSize() };
  },
  state: fullState,
};

// ---------------------------------------------------------------- chat + events → brain
/** The bubble shows text verbatim: fold the markdown a model reaches for anyway into plain text. */
function plain(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, ''))
    .replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1$2').replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '').replace(/^\s*[-*•]\s+/gm, '· ')
    .replace(/\n{2,}/g, '\n').trim();
}
async function chat(text, source) {
  text = String(text ?? '').trim();
  if (!text) throw new Error('text required');
  const item = pushEvent('user', { text, source });
  if (brain?.available) return runBrain(text, item);
  inbox.push(item);
  await ask('thinking', { on: true, hint: 'waiting for a brain to answer (external mode)' }).catch(() => {});
  return { queued: true, id: item.id, mode: 'external', hint: 'an external brain must call /listen then /reply; nothing answers until it does' };
}
async function nudge(text, source) {
  const item = pushEvent('event', { text, source });
  if (brain?.available) return runBrain(`[event from ${source || 'system'}] ${text}\n\nReact briefly as the character: a short bubble and, if it fits, a gesture.`, item);
  inbox.push(item);
  return { queued: true, id: item.id, mode: 'external' };
}
async function runBrain(prompt, item) {
  await ask('thinking', { on: true }).catch(() => {});
  let streamed = '';
  try {
    const r = await brain.think(prompt, {
      onText: (delta) => { streamed += delta; win?.webContents.send('companion:stream', { text: streamed, done: false }); },
      onTool: (name, input) => pushEvent('tool', { name, input, in_reply_to: item.id }),
    });
    const shown = plain(r.reply || streamed || '');
    if (shown) { await ask('say', { text: shown, seconds: Math.min(20, 3 + shown.length / 10) }).catch(() => {}); state.bubble = shown; }
    answered.add(item.id);
    pushEvent('reply', { text: shown, in_reply_to: item.id, tools: r.tools.map((t) => t.name), duration_ms: r.duration_ms });
    return { reply: shown, tools: r.tools, session_id: r.session_id, duration_ms: r.duration_ms, mode: 'sdk' };
  } catch (e) {
    pushEvent('brain_error', { error: e.message, in_reply_to: item.id });
    if (!brain.available) {
      // Auth went away (or was never there): keep the message instead of losing it, and say what fixes it.
      inbox.push(item);
      await ask('thinking', { on: true, hint: brain.status().hint ?? e.message }).catch(() => {});
      return { queued: true, id: item.id, mode: 'external', reason: e.message, hint: brain.status().hint };
    }
    await ask('say', { text: '(brain error: ' + e.message.slice(0, 80) + ')', seconds: 6 }).catch(() => {});
    throw e;
  } finally {
    if (!inbox.some((i) => !answered.has(i.id))) await ask('thinking', { on: false }).catch(() => {});
  }
}

// ---------------------------------------------------------------- HTTP: assets + control
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.png': 'image/png' };
const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
  req.on('error', reject);
});
/** Envelope: ok + one-line summary + data + the body's state after the call. */
async function envelope(res, summary, data) {
  const s = await fullState();
  send(res, 200, { ok: true, summary, data, state: compactState(s) });
}
const fail = (res, code, message, extra = {}) => send(res, code, { ok: false, error: message, ...extra });

async function handle(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method === 'GET') {
    if (url.pathname === '/state') { const s = await fullState(); return send(res, 200, { ok: true, summary: summarize(s), data: s }); }
    if (url.pathname === '/events') { const since = Number(url.searchParams.get('since') || 0); return send(res, 200, { ok: true, data: { events: events.filter((e) => e.id > since), latest: eventSeq } }); }
    if (url.pathname === '/listen') {
      const timeout = Math.min(60, Number(url.searchParams.get('timeout') || 25)) * 1000;
      const next = inbox.find((i) => !answered.has(i.id));
      if (next) return send(res, 200, { ok: true, data: { item: next, pending: inbox.filter((i) => !answered.has(i.id)).length, hint: 'answer with POST /reply {id, text}' } });
      const item = await new Promise((resolve) => {
        const timer = setTimeout(() => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); resolve(null); }, timeout);
        const fn = (e) => { if (e.kind === 'user' || e.kind === 'event') { clearTimeout(timer); resolve(e); } else listeners.push(fn); };
        listeners.push(fn);
      });
      return send(res, 200, { ok: true, data: { item, pending: inbox.filter((i) => !answered.has(i.id)).length, hint: item ? 'answer with POST /reply {id, text}' : 'nothing within the timeout; call again' } });
    }
    if (url.pathname === '/model') {
      if (!modelBytes) return fail(res, 404, 'no model loaded');
      res.writeHead(200, { 'content-type': 'model/gltf-binary', 'content-length': modelBytes.byteLength });
      return res.end(modelBytes);
    }
    const rel = url.pathname === '/' ? '/renderer/index.html' : url.pathname;
    let file;
    if (rel.startsWith('/renderer/')) file = path.join(HERE, rel);
    else if (rel.startsWith('/node_modules/three/')) file = path.join(THREE_DIR, rel.slice('/node_modules/three/'.length));
    else { res.writeHead(404); return res.end(); }
    const base = rel.startsWith('/renderer/') ? HERE : THREE_DIR;
    if (!path.resolve(file).startsWith(base)) { res.writeHead(403); return res.end(); }
    try {
      const data = await fs.promises.readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      return res.end(data);
    } catch { res.writeHead(404); return res.end(); }
  }
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
  let b;
  try { b = await readBody(req); } catch (e) { return fail(res, 400, `bad JSON: ${e.message}`); }
  try {
    switch (url.pathname) {
      case '/load': {
        if (!b.path) return fail(res, 400, 'path required');
        const r = await body.load(b.path);
        return envelope(res, `Loaded ${path.basename(r.model)}: ${r.clips.length} clip(s)${r.idle ? `, playing ${r.idle}` : ''}`, r);
      }
      case '/play': { const r = await body.play(b); return envelope(res, `Playing "${r.playing}" ${r.loop ? 'on a loop' : `once (${r.duration.toFixed(1)}s, then back to ${r.returns_to ?? 'rest'})`}`, r); }
      case '/emote': { const r = await body.emote(b); return envelope(res, `Gesture "${r.gesture}" for ${r.seconds}s`, r); }
      case '/say': { const r = await body.say(b); return envelope(res, r.shown ? `Bubble shown for ${r.seconds}s (${r.chars} chars)` : 'Bubble hidden', r); }
      case '/move': {
        if (!win) return fail(res, 409, 'no window');
        const { workArea } = screen.getPrimaryDisplay();
        let { x, y } = b;
        if (b.corner) {
          const right = /right/.test(b.corner), bottom = /bottom/.test(b.corner);
          x = right ? workArea.x + workArea.width - SIZE - 24 : workArea.x + 24;
          y = bottom ? workArea.y + workArea.height - HEIGHT - 24 : workArea.y + 24;
        }
        if (typeof x !== 'number' || typeof y !== 'number') return fail(res, 400, 'x,y or corner required');
        win.setPosition(Math.round(x), Math.round(y), true);
        pushEvent('move', { position: position() });
        return envelope(res, `Window at ${Math.round(x)},${Math.round(y)}`, { position: position() });
      }
      case '/snapshot': { const r = await body.snapshot(b.out); return envelope(res, `Snapshot ${r.size.width}x${r.size.height}${r.out ? ` → ${r.out}` : ' (base64)'}`, r); }
      case '/chat': { const r = await chat(b.text, b.source || 'http'); return envelope(res, r.queued ? `Queued message #${r.id} for an external brain` : `Replied in ${r.duration_ms} ms with ${r.tools.length} tool call(s)`, r); }
      case '/event': { const r = await nudge(b.text, b.source); return envelope(res, r.queued ? `Queued event #${r.id} for an external brain` : `Reacted in ${r.duration_ms} ms`, r); }
      case '/reply': {
        const item = inbox.find((i) => i.id === Number(b.id)) ?? inbox.find((i) => !answered.has(i.id));
        if (!item) return fail(res, 404, 'nothing to reply to (inbox empty)');
        const r = await body.say({ text: b.text, seconds: b.seconds });
        answered.add(item.id);
        const idx = inbox.indexOf(item); if (idx >= 0) inbox.splice(idx, 1);
        pushEvent('reply', { text: b.text, in_reply_to: item.id, source: 'external' });
        if (!inbox.length) await ask('thinking', { on: false }).catch(() => {});
        return envelope(res, `Answered #${item.id}`, { ...r, in_reply_to: item.id, remaining: inbox.length });
      }
      case '/brain/reset': { const auth = brain?.reset ? await brain.reset() : null; return envelope(res, `Brain session reset (auth: ${auth ?? 'n/a'})`, brain ? brain.status() : {}); }
      case '/quit': send(res, 200, { ok: true, summary: 'Quitting' }); setTimeout(() => app.quit(), 50); return;
      default: return fail(res, 404, `unknown endpoint ${url.pathname}`, { endpoints: ['/state', '/events', '/listen', '/load', '/play', '/emote', '/say', '/move', '/snapshot', '/chat', '/event', '/reply', '/brain/reset', '/quit'] });
    }
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
function summarize(s) {
  const parts = [s.model ? path.basename(s.model) : 'no model', s.clips.length ? `${s.clips.length} clip(s)` : 'no clips', s.playing ? `playing ${s.playing}` : 'rest pose'];
  if (s.bubble) parts.push(`saying "${s.bubble.slice(0, 40)}"`);
  if (s.thinking) parts.push('thinking');
  parts.push(`brain ${s.brain.mode}${s.brain.available === false ? ' (unavailable)' : ''}`);
  if (s.inbox_pending) parts.push(`${s.inbox_pending} unanswered`);
  return parts.join(' · ');
}

const server = http.createServer((req, res) => { handle(req, res).catch((e) => fail(res, 500, e.message)); });

app.whenReady().then(async () => {
  if (BRAIN_MODE === 'sdk') {
    brain = await createBrain({ body, log: (m) => console.error(`[companion] ${m}`) });
    if (!brain.available) console.error(`[companion] brain unavailable, falling back to external mode: ${brain.reason}`);
    else brain.probe().then((auth) => { if (auth !== 'ok') { console.error(`[companion] brain: ${brain.status().hint}`); ask('say', { text: 'no brain yet: run `claude` + /login, or talk to me through an agent (companion_listen)', seconds: 12 }).catch(() => {}); } });
  } else {
    brain = { available: false, status: () => ({ mode: BRAIN_MODE, available: false }) };
  }
  server.listen(PORT, '127.0.0.1', async () => {
    if (modelPath) { try { modelBytes = await fs.promises.readFile(modelPath); state.model_bytes = modelBytes.byteLength; } catch (e) { state.error = `cannot read ${modelPath}: ${e.message}`; modelPath = null; state.model = null; } }
    createWindow();
    console.log(`glbforge companion: http://127.0.0.1:${PORT}  model=${modelPath ?? '(none — POST /load)'}  brain=${brain.available ? 'sdk' : BRAIN_MODE === 'sdk' ? 'external (sdk unavailable)' : BRAIN_MODE}`);
  });
  server.on('error', (e) => { console.error(`companion: cannot listen on ${PORT}: ${e.message}`); app.exit(1); });
});
app.on('window-all-closed', () => app.quit());
app.dock?.hide();
