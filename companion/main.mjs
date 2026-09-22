/**
 * GLBForge companion — Electron main process.
 *
 * One transparent, frameless, always-on-top window renders a GLB with its
 * animation clips (three.js in renderer/). A localhost HTTP server on
 * GLBFORGE_COMPANION_PORT (default 4747) is both the asset server for the
 * renderer and the control surface an agent drives:
 *
 *   GET  /state                       what is loaded, playing, where the window is
 *   POST /load     {path}             load another .glb
 *   POST /play     {clip, loop}       play a clip by name or index (loop=false: once, then back to idle)
 *   POST /emote    {gesture}          hop | spin | nod | shake | wave — procedural, works on any GLB
 *   POST /say      {text, seconds}    speech bubble
 *   POST /move     {x, y} | {corner}  move the window
 *   POST /snapshot {out?}             PNG of the window (what the user sees), file or base64
 *   POST /quit
 *
 * Nothing here is networked beyond 127.0.0.1.
 */
import { app, BrowserWindow, ipcMain, screen } from 'electron';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.GLBFORGE_COMPANION_PORT || 4747);
const SIZE = Number(process.env.GLBFORGE_COMPANION_SIZE || 320);
const argModel = process.argv.slice(1).find((a) => /\.(glb|gltf)$/i.test(a)) || process.env.GLBFORGE_COMPANION_MODEL || null;

let win = null;
let modelPath = argModel ? path.resolve(argModel) : null;
let modelBytes = null;
const state = { model: modelPath, clips: [], playing: null, bubble: null, loaded: false, error: null };

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

// ---------------------------------------------------------------- drag + cursor
let drag = null;
ipcMain.on('companion:drag-start', () => {
  const c = screen.getCursorScreenPoint();
  const [x, y] = win.getPosition();
  drag = { ox: c.x - x, oy: c.y - y, start: c, moved: false, timer: setInterval(() => {
    const p = screen.getCursorScreenPoint();
    if (Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > 3) drag.moved = true;
    if (drag.moved) win.setPosition(Math.round(p.x - drag.ox), Math.round(p.y - drag.oy));
  }, 16) };
});
ipcMain.handle('companion:drag-end', () => {
  if (!drag) return { moved: false };
  clearInterval(drag.timer);
  const moved = drag.moved;
  drag = null;
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
function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    width: SIZE, height: SIZE,
    x: workArea.x + workArea.width - SIZE - 24, y: workArea.y + workArea.height - SIZE - 24,
    transparent: true, frame: false, hasShadow: false, resizable: false, alwaysOnTop: true,
    skipTaskbar: true, fullscreenable: false, minimizable: false, title: 'GLBForge companion',
    webPreferences: { preload: path.join(HERE, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadURL(`http://127.0.0.1:${PORT}/`);
  win.on('closed', () => { win = null; });
}

// ---------------------------------------------------------------- HTTP: assets + control
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.png': 'image/png' };
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
  req.on('error', reject);
});

async function loadModel(p) {
  const abs = path.resolve(p);
  const bytes = await fs.promises.readFile(abs);
  modelPath = abs; modelBytes = bytes;
  Object.assign(state, { model: abs, loaded: false, error: null, clips: [], playing: null });
  return ask('load', { name: path.basename(abs), bytes: bytes.byteLength });
}

async function handle(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method === 'GET') {
    if (url.pathname === '/state') {
      const [x, y] = win ? win.getPosition() : [null, null];
      return json(res, 200, { ...state, port: PORT, size: SIZE, position: { x, y } });
    }
    if (url.pathname === '/model') {
      if (!modelBytes) return json(res, 404, { error: 'no model loaded' });
      res.writeHead(200, { 'content-type': 'model/gltf-binary', 'content-length': modelBytes.byteLength });
      return res.end(modelBytes);
    }
    // static: renderer/ and node_modules/three (module imports)
    let rel = url.pathname === '/' ? '/renderer/index.html' : url.pathname;
    if (!rel.startsWith('/renderer/') && !rel.startsWith('/node_modules/three/')) { res.writeHead(404); return res.end(); }
    const file = path.join(HERE, rel);
    if (!file.startsWith(HERE)) { res.writeHead(403); return res.end(); }
    try {
      const data = await fs.promises.readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      return res.end(data);
    } catch { res.writeHead(404); return res.end(); }
  }
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
  let body;
  try { body = await readBody(req); } catch (e) { return json(res, 400, { error: `bad JSON: ${e.message}` }); }
  try {
    switch (url.pathname) {
      case '/load': {
        if (!body.path) return json(res, 400, { error: 'path required' });
        const r = await loadModel(body.path);
        return json(res, 200, { ok: true, ...r });
      }
      case '/play': return json(res, 200, { ok: true, ...(await ask('play', body)) });
      case '/emote': return json(res, 200, { ok: true, ...(await ask('emote', body)) });
      case '/say': {
        const text = String(body.text ?? '');
        const seconds = Number(body.seconds ?? Math.min(12, 2 + text.length / 12));
        state.bubble = text || null;
        return json(res, 200, { ok: true, ...(await ask('say', { text, seconds })) });
      }
      case '/move': {
        if (!win) return json(res, 409, { error: 'no window' });
        const { workArea } = screen.getPrimaryDisplay();
        let { x, y } = body;
        if (body.corner) {
          const right = /right/.test(body.corner), bottom = /bottom/.test(body.corner);
          x = right ? workArea.x + workArea.width - SIZE - 24 : workArea.x + 24;
          y = bottom ? workArea.y + workArea.height - SIZE - 24 : workArea.y + 24;
        }
        if (typeof x !== 'number' || typeof y !== 'number') return json(res, 400, { error: 'x,y or corner required' });
        win.setPosition(Math.round(x), Math.round(y), true);
        return json(res, 200, { ok: true, position: { x: Math.round(x), y: Math.round(y) } });
      }
      case '/snapshot': {
        if (!win) return json(res, 409, { error: 'no window' });
        const img = await win.webContents.capturePage();
        const png = img.toPNG();
        if (body.out) { await fs.promises.mkdir(path.dirname(body.out), { recursive: true }); await fs.promises.writeFile(body.out, png); return json(res, 200, { ok: true, out: body.out, bytes: png.byteLength, size: img.getSize() }); }
        return json(res, 200, { ok: true, png_base64: png.toString('base64'), bytes: png.byteLength, size: img.getSize() });
      }
      case '/quit': json(res, 200, { ok: true }); setTimeout(() => app.quit(), 50); return;
      default: return json(res, 404, { error: `unknown endpoint ${url.pathname}` });
    }
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}

const server = http.createServer((req, res) => { handle(req, res).catch((e) => json(res, 500, { error: e.message })); });

app.whenReady().then(() => {
  server.listen(PORT, '127.0.0.1', async () => {
    if (modelPath) { try { modelBytes = await fs.promises.readFile(modelPath); } catch (e) { state.error = `cannot read ${modelPath}: ${e.message}`; modelPath = null; state.model = null; } }
    createWindow();
    console.log(`glbforge companion: http://127.0.0.1:${PORT}  model=${modelPath ?? '(none — POST /load)'}`);
  });
  server.on('error', (e) => { console.error(`companion: cannot listen on ${PORT}: ${e.message}`); app.exit(1); });
});
app.on('window-all-closed', () => app.quit());
app.dock?.hide();
