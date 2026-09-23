/**
 * Install / remove the Claude Code hooks that give the companion eyes on every
 * session on this machine. Merges into the settings file (never replaces),
 * backs it up first, and is idempotent: our entries are recognised by the
 * hook.mjs path they run.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HOOK_SCRIPT = path.join(HERE, 'hook.mjs');
/** Event → matcher (null = every occurrence). Kept to what a face should react to. */
export const HOOK_EVENTS = {
  Stop: null,
  StopFailure: null,
  Notification: 'permission_prompt|idle_prompt|agent_needs_input|agent_completed|elicitation_dialog',
  SessionStart: 'startup',
  SessionEnd: null,
};

export function settingsPath(scope = 'user', cwd = process.cwd()) {
  return scope === 'user' ? path.join(os.homedir(), '.claude', 'settings.json') : path.join(cwd, '.claude', scope === 'local' ? 'settings.local.json' : 'settings.json');
}
// Shell form on purpose: Claude Code 2.1.x ignores the `args` exec form and runs the bare command.
const OURS = /companion[\\/]hook\.mjs/;
const isOurs = (h) => h?.type === 'command' && (OURS.test(String(h.command ?? '')) || (Array.isArray(h.args) && h.args.some((a) => OURS.test(String(a)))));
function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  try { return JSON.parse(text); } catch (e) { throw new Error(`${file} is not valid JSON (${e.message}); fix it before adding hooks — a broken settings file disables everything in it`); }
}
function writeSettings(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

export function installHooks({ scope = 'user', cwd = process.cwd(), port } = {}) {
  const file = settingsPath(scope, cwd);
  const cfg = readSettings(file);
  const hooks = (cfg.hooks ??= {});
  // Synchronous on purpose: the script returns in well under 100 ms, and an async Stop hook is killed when a
  // headless (-p) session exits right after it — the reaction never arrived in testing.
  const entry = { type: 'command', command: `node ${JSON.stringify(HOOK_SCRIPT)}`, timeout: 3 };
  const added = [], kept = [];
  for (const [event, matcher] of Object.entries(HOOK_EVENTS)) {
    const list = (hooks[event] ??= []);
    if (list.some((g) => (g.hooks ?? []).some(isOurs))) { kept.push(event); continue; }
    list.push({ ...(matcher ? { matcher } : {}), hooks: [entry] });
    added.push(event);
  }
  if (port && port !== 4747) { (cfg.env ??= {}).GLBFORGE_COMPANION_PORT = String(port); }
  if (added.length || port) writeSettings(file, cfg);
  return { file, added, kept, script: HOOK_SCRIPT };
}

export function removeHooks({ scope = 'user', cwd = process.cwd() } = {}) {
  const file = settingsPath(scope, cwd);
  const cfg = readSettings(file);
  const removed = [];
  for (const [event, list] of Object.entries(cfg.hooks ?? {})) {
    const before = list.length;
    const next = list.map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) })).filter((g) => g.hooks.length);
    if (next.length !== before || next.some((g, i) => g.hooks.length !== list[i]?.hooks?.length)) removed.push(event);
    if (next.length) cfg.hooks[event] = next; else delete cfg.hooks[event];
  }
  if (cfg.hooks && !Object.keys(cfg.hooks).length) delete cfg.hooks;
  if (removed.length) writeSettings(file, cfg);
  return { file, removed };
}

export function hooksStatus({ scope = 'user', cwd = process.cwd() } = {}) {
  const file = settingsPath(scope, cwd);
  const cfg = readSettings(file);
  const installed = Object.entries(cfg.hooks ?? {}).filter(([, list]) => list.some((g) => (g.hooks ?? []).some(isOurs))).map(([e]) => e);
  return { file, installed };
}
