#!/usr/bin/env node
/**
 * MCP bridge: lets an agent drive the running companion — load a GLB, play a
 * clip, gesture, speak, move, and *see* the window (snapshot returns the PNG).
 * Forwards to the companion's localhost HTTP server; never leaves the machine.
 *
 * Register it next to glbforge, e.g. in .mcp.json:
 *   "companion": { "command": "node", "args": ["companion/mcp.mjs"] }
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const PORT = Number(process.env.GLBFORGE_COMPANION_PORT || 4747);
const BASE = `http://127.0.0.1:${PORT}`;
const NOT_RUNNING = `The companion is not running on ${BASE}. Start it: cd companion && pnpm install && pnpm start -- /abs/path/model.glb (GLBFORGE_COMPANION_PORT to change the port).`;

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error(NOT_RUNNING);
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const text = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
const wrap = (fn) => async (args) => { try { return await fn(args); } catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; } };

const server = new McpServer({ name: 'glbforge-companion', version: '0.1.0' });
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

server.tool('companion_state', 'What the desktop companion is showing: model path, clips, the clip playing, speech bubble, window position. Call first; an error means it is not running and says how to start it.', {}, { title: 'Companion state', ...RO },
  wrap(async () => text(await call('GET', '/state'))));

server.tool('companion_load', 'Load a .glb into the companion window (replaces the current one). Use the optimized .web.glb; KTX2 textures are not decoded. If the file has an "idle" clip (glbforge animate makes one) it plays on a loop.', { path: z.string().describe('Absolute path to the .glb') }, { title: 'Load a model', ...RW },
  wrap(async ({ path }) => text(await call('POST', '/load', { path }))));

server.tool('companion_play', 'Play one of the model\'s animation clips by name (see companion_state.clips). loop=false plays it once and returns to idle — the way to trigger a baked "hop" or "spin" as a reaction.', { clip: z.union([z.string(), z.number().int()]), loop: z.boolean().default(true), speed: z.number().positive().default(1) }, { title: 'Play a clip', ...RW },
  wrap(async (args) => text(await call('POST', '/play', args))));

server.tool('companion_emote', 'A procedural gesture that works on any GLB, clip or not: hop | spin | nod | shake | wave. Use it to react (nod = yes, shake = no, hop = done, wave = hello).', { gesture: z.enum(['hop', 'spin', 'nod', 'shake', 'wave']), seconds: z.number().positive().optional() }, { title: 'Gesture', ...RW },
  wrap(async (args) => text(await call('POST', '/emote', args))));

server.tool('companion_say', 'Show a speech bubble above the model for a few seconds. Keep it short — it is a bubble, not a chat window. Empty text hides it.', { text: z.string().max(280), seconds: z.number().positive().max(60).optional() }, { title: 'Say', ...RW },
  wrap(async (args) => text(await call('POST', '/say', args))));

server.tool('companion_move', 'Move the window: a screen corner (bottom-right, bottom-left, top-right, top-left) or absolute x,y in screen pixels.', { corner: z.enum(['bottom-right', 'bottom-left', 'top-right', 'top-left']).optional(), x: z.number().optional(), y: z.number().optional() }, { title: 'Move window', ...RW },
  wrap(async (args) => text(await call('POST', '/move', args))));

server.tool('companion_snapshot', 'What the user sees: a PNG of the companion window, returned as an image (and written to out when given). Use it to check a load, a pose or a bubble instead of asking the user.', { out: z.string().optional().describe('Absolute path to also save the PNG') }, { title: 'Snapshot', ...RO },
  wrap(async ({ out }) => {
    const r = await call('POST', '/snapshot', {});
    const content = [{ type: 'image', data: r.png_base64, mimeType: 'image/png' }, { type: 'text', text: JSON.stringify({ bytes: r.bytes, size: r.size, out: out ?? null }) }];
    if (out) { const { writeFile, mkdir } = await import('node:fs/promises'); const { dirname } = await import('node:path'); await mkdir(dirname(out), { recursive: true }); await writeFile(out, Buffer.from(r.png_base64, 'base64')); }
    return { content };
  }));

await server.connect(new StdioServerTransport());
