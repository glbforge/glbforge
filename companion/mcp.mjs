#!/usr/bin/env node
/**
 * MCP bridge: lets any agent be — or drive — the companion on the desktop.
 *
 * Two ways in:
 *   drive it   companion_load / play / emote / say / move / snapshot / state
 *   be it      companion_listen (the next thing the user typed or an event),
 *              companion_reply (answer it in the bubble). Start the window with
 *              GLBFORGE_COMPANION_BRAIN=external so nothing else answers first.
 *
 * Every mutating tool returns the body's state after the call, so the agent
 * never has to follow up with companion_state to learn what it just did.
 * Forwards to the companion's localhost HTTP server; never leaves the machine.
 *
 * Register it next to glbforge in .mcp.json:
 *   "companion": { "command": "node", "args": ["companion/mcp.mjs"] }
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const PORT = Number(process.env.GLBFORGE_COMPANION_PORT || 4747);
const BASE = `http://127.0.0.1:${PORT}`;
const NOT_RUNNING = `The companion is not running on ${BASE}. Start it: cd companion && pnpm install && pnpm start -- /abs/path/model.glb  (GLBFORGE_COMPANION_PORT to change the port; GLBFORGE_COMPANION_BRAIN=external if this agent will answer the user itself).`;

async function call(method, path, body, timeoutMs = 30000) {
  let res;
  try {
    res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' ? `the companion did not answer within ${timeoutMs / 1000}s` : NOT_RUNNING);
  }
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
/** Envelope → MCP result: the summary first (what an agent reads), full data as structuredContent. */
const out = (env, extraContent = []) => ({
  content: [{ type: 'text', text: `${env.summary ? env.summary + '\n' : ''}${JSON.stringify({ data: env.data, state: env.state })}` }, ...extraContent],
  structuredContent: { summary: env.summary ?? null, data: env.data, state: env.state ?? null },
});
const wrap = (fn) => async (args) => { try { return await fn(args); } catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; } };

const server = new McpServer({ name: 'glbforge-companion', version: '0.2.0' });
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

server.tool('companion_state',
  'Everything about the desktop companion right now: model path, triangle count, clips with durations, the clip playing and where in it, gesture, bubble text and seconds left, whether it is thinking, window rectangle and screen work area, brain mode (sdk = it answers the user itself; external = you must answer via companion_listen/companion_reply), unanswered inbox count, the last 10 events. Call first; an error means it is not running and says how to start it.',
  {}, { title: 'Companion state', ...RO },
  wrap(async () => out(await call('GET', '/state'))));

server.tool('companion_load',
  'Load a .glb into the window (replaces the current one). Use the optimized .web.glb (KTX2 is not decoded). Returns the clips found and which one is the idle loop; notes say when there are no clips (run glbforge animate first).',
  { path: z.string().describe('Absolute path to the .glb') }, { title: 'Load a model', ...RW },
  wrap(async ({ path }) => out(await call('POST', '/load', { path }, 60000))));

server.tool('companion_play',
  'Play one of the model\'s baked clips by name (see companion_state.data.clips). loop=false plays it once and the reply says when it ends and which clip it returns to — the way to trigger a baked "hop" or "spin" as a reaction.',
  { clip: z.union([z.string(), z.number().int()]), loop: z.boolean().default(true), speed: z.number().positive().default(1) }, { title: 'Play a clip', ...RW },
  wrap(async (args) => out(await call('POST', '/play', args))));

server.tool('companion_emote',
  'A procedural gesture that works on any GLB: hop (joy / done), spin (excited), nod (yes), shake (no), wave (hello / goodbye). The reply notes when the model has a baked clip of the same name you could play instead.',
  { gesture: z.enum(['hop', 'spin', 'nod', 'shake', 'wave']), seconds: z.number().positive().optional() }, { title: 'Gesture', ...RW },
  wrap(async (args) => out(await call('POST', '/emote', args))));

server.tool('companion_say',
  'Show a speech bubble above the model. Under 120 characters reads best; the reply tells you how long it stays and warns when text will wrap and shrink. Empty text hides the bubble.',
  { text: z.string().max(280), seconds: z.number().positive().max(60).optional() }, { title: 'Say', ...RW },
  wrap(async (args) => out(await call('POST', '/say', args))));

server.tool('companion_move',
  'Move the window: a screen corner (bottom-right, bottom-left, top-right, top-left) or absolute x,y in screen pixels (companion_state.data.work_area has the bounds).',
  { corner: z.enum(['bottom-right', 'bottom-left', 'top-right', 'top-left']).optional(), x: z.number().optional(), y: z.number().optional() }, { title: 'Move window', ...RW },
  wrap(async (args) => out(await call('POST', '/move', args))));

server.tool('companion_snapshot',
  'What the user sees: a PNG of the companion window returned as an image (and saved to out when given). Use it to check a load, a pose or a bubble instead of asking the user.',
  { out: z.string().optional().describe('Absolute path to also save the PNG') }, { title: 'Snapshot', ...RO },
  wrap(async ({ out: file }) => {
    const env = await call('POST', '/snapshot', {});
    const png = env.data.png_base64;
    if (file) { const { writeFile, mkdir } = await import('node:fs/promises'); const { dirname } = await import('node:path'); await mkdir(dirname(file), { recursive: true }); await writeFile(file, Buffer.from(png, 'base64')); }
    return out({ ...env, data: { bytes: env.data.bytes, size: env.data.size, out: file ?? null } }, [{ type: 'image', data: png, mimeType: 'image/png' }]);
  }));

server.tool('companion_chat',
  'Send a message to the character as the user would. With the embedded brain (mode sdk) the character answers and the reply carries its words and the tools it used; in external mode the message is queued for whoever calls companion_listen.',
  { text: z.string().max(2000) }, { title: 'Chat', ...RW },
  wrap(async ({ text }) => out(await call('POST', '/chat', { text, source: 'mcp' }, 180000))));

server.tool('companion_event',
  'Tell the character something happened so it reacts on screen ("tests passed", "deploy failed on main", "user has been idle 20 min"). Use it from hooks and pipelines to give the user a face for background work.',
  { text: z.string().max(500), source: z.string().max(60).optional().describe('Who is reporting: ci, claude-code, cron…') }, { title: 'Report an event', ...RW },
  wrap(async (args) => out(await call('POST', '/event', args, 180000))));

server.tool('companion_listen',
  'BE the brain: wait up to timeout seconds for the next thing the user typed into the companion (or an event posted to it), then answer it with companion_reply. Returns item=null on timeout — call again. Only meaningful when the companion runs with GLBFORGE_COMPANION_BRAIN=external (companion_state.data.brain.mode).',
  { timeout: z.number().int().min(1).max(60).default(25) }, { title: 'Listen for the user', ...RO },
  wrap(async ({ timeout }) => out(await call('GET', `/listen?timeout=${timeout}`, undefined, (timeout + 5) * 1000))));

server.tool('companion_reply',
  'Answer an item from companion_listen: shows your text in the bubble and marks the message answered (id optional: the oldest unanswered). Keep it short; gesture with companion_emote if it fits.',
  { id: z.number().int().optional(), text: z.string().max(280), seconds: z.number().positive().max(60).optional() }, { title: 'Reply', ...RW },
  wrap(async (args) => out(await call('POST', '/reply', args))));

server.tool('companion_events',
  'The event log since an id: clicks, drags, typed messages, replies, tool calls the embedded brain made, loads. Use it to see what the user did while you were away.',
  { since: z.number().int().min(0).default(0) }, { title: 'Event log', ...RO },
  wrap(async ({ since }) => out(await call('GET', `/events?since=${since}`))));

await server.connect(new StdioServerTransport());
