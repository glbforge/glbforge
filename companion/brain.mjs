/**
 * The companion's brain: a Claude agent that owns the body.
 *
 * Built on the Claude Agent SDK, so it runs on the user's Claude Code login —
 * no API key to manage. Each user message (or an event posted to /event) is
 * one query(); the session id is resumed between turns so the character
 * remembers the conversation. The body is exposed as an in-process MCP
 * server (`body`: say, emote, play, look, status) and glbforge's MCP server is
 * attached read-only so the character can inspect its own mesh. No built-in
 * tools: the brain has no shell, no filesystem, and cannot call anything that
 * is not in allowedTools (unlisted calls are denied, not prompted).
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const PERSONA = `You are the character on the user's desktop: a 3D model living in a small always-on-top window. Your reply text is shown verbatim in your speech bubble — plain text only, no markdown, no headings, no bullet lists — so keep replies to one or two short sentences; call say() again for a second thought rather than writing a paragraph. You can move: emote() for a quick gesture, play() for one of your baked clips. You can look() at yourself as the user sees you, and status() tells you what is loaded and playing. When asked about your own mesh (triangles, size, materials, clips), use the glbforge inspect tools on your model path. Be warm, playful and honest: never claim to have done something a tool did not report. You have no shell and no filesystem.`;

export async function createBrain({ body, log = () => {}, model = process.env.GLBFORGE_COMPANION_BRAIN_MODEL || undefined }) {
  let sdk;
  try {
    sdk = await import('@anthropic-ai/claude-agent-sdk');
  } catch (e) {
    return { available: false, reason: `Claude Agent SDK not installed (${e.message}); run pnpm install in companion/`, status: () => ({ mode: 'external', available: false }) };
  }
  const { query, tool, createSdkMcpServer } = sdk;
  const { z } = await import('zod');

  const text = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
  const bodyServer = createSdkMcpServer({
    name: 'body', version: '0.1.0', alwaysLoad: true,
    instructions: 'Your body on the desktop. Everything the user sees goes through these.',
    tools: [
      tool('say', 'Show text in your speech bubble now (an interim remark while you work; your final reply is shown automatically). Keep it under ~120 characters.',
        { text: z.string().max(280), seconds: z.number().positive().max(60).optional() },
        async (a) => text(await body.say(a)), { annotations: { readOnlyHint: false, openWorldHint: false } }),
      tool('emote', 'A quick physical gesture: hop (joy / done), spin (excited), nod (yes), shake (no), wave (hello / goodbye). Works on any model.',
        { gesture: z.enum(['hop', 'spin', 'nod', 'shake', 'wave']) },
        async (a) => text(await body.emote(a)), { annotations: { readOnlyHint: false, openWorldHint: false } }),
      tool('play', 'Play one of your baked animation clips by name (see status().clips). loop=false plays it once and returns to idle.',
        { clip: z.string(), loop: z.boolean().default(false) },
        async (a) => text(await body.play(a)), { annotations: { readOnlyHint: false, openWorldHint: false } }),
      tool('look', 'See yourself as the user sees you: a PNG of your window.', {},
        async () => { const r = await body.snapshot(); return { content: [{ type: 'image', data: r.png_base64, mimeType: 'image/png' }, { type: 'text', text: JSON.stringify({ size: r.size }) }] }; },
        { annotations: { readOnlyHint: true, openWorldHint: false } }),
      tool('status', 'Your body right now: model path, clips, what is playing, bubble, window position, recent events.', {},
        async () => text(await body.state()), { annotations: { readOnlyHint: true, openWorldHint: false } }),
    ],
  });

  const glbforgePath = [path.join(HERE, '..', 'packages', 'mcp', 'dist', 'index.js')].find((p) => fs.existsSync(p)) ?? null;
  const mcpServers = { body: bodyServer, ...(glbforgePath ? { glbforge: { command: 'node', args: [glbforgePath] } } : {}) };
  const allowedTools = ['mcp__body__*', ...(glbforgePath ? ['mcp__glbforge__inspect', 'mcp__glbforge__inspect_all', 'mcp__glbforge__inspect_animation', 'mcp__glbforge__inspect_geometry', 'mcp__glbforge__inspect_materials', 'mcp__glbforge__render', 'mcp__glbforge__capabilities'] : [])];

  const stats = { mode: 'sdk', available: true, auth: 'unknown', hint: null, busy: false, session_id: null, turns: 0, cost_usd_total: 0, last_error: null, last_duration_ms: null, model: model ?? 'claude-code default', glbforge_tools: !!glbforgePath };
  const NOT_LOGGED_IN = /not logged in|please run \/login|authentication|api key/i;
  const LOGIN_HINT = 'the Claude CLI is not logged in: run `claude` and `/login` once (or export ANTHROPIC_API_KEY), then POST /brain/reset. Until then typed messages queue for an external brain (companion_listen / companion_reply).';
  function markUnavailable(reason) { stats.available = false; stats.auth = 'not-logged-in'; stats.hint = LOGIN_HINT; stats.last_error = reason; }

  /** Cheap startup check: one no-tool turn. Sets stats.auth so /state is honest before the first chat. */
  async function probe() {
    try {
      for await (const m of query({ prompt: 'Reply with exactly: pong', options: { tools: [], settingSources: [], maxTurns: 1, cwd: HERE, ...(model ? { model } : {}) } })) {
        if (m.type === 'result') { if (m.subtype === 'success' && !NOT_LOGGED_IN.test(m.result ?? '')) { stats.auth = 'ok'; stats.hint = null; } else markUnavailable(m.result ?? m.subtype); }
      }
    } catch (e) { markUnavailable(e.message); }
    return stats.auth;
  }

  /** One turn. Streams text deltas via onText, reports tool calls via onTool, returns the final reply. */
  async function think(prompt, { onText = () => {}, onTool = () => {} } = {}) {
    if (stats.busy) throw new Error('the brain is busy with the previous message; wait for it to finish');
    stats.busy = true;
    const started = Date.now();
    let final = '', tools = [];
    try {
      const q = query({
        prompt,
        options: {
          systemPrompt: PERSONA,
          mcpServers, allowedTools, tools: [],
          permissionMode: 'default',
          canUseTool: async (name) => ({ behavior: 'deny', message: `${name} is not available to the companion` }),
          settingSources: [],
          maxTurns: 10,
          includePartialMessages: true,
          cwd: HERE,
          ...(model ? { model } : {}),
          ...(stats.session_id ? { resume: stats.session_id } : {}),
        },
      });
      for await (const m of q) {
        if (m.type === 'system' && m.subtype === 'init') stats.session_id = m.session_id;
        else if (m.type === 'stream_event') {
          const e = m.event;
          if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') onText(e.delta.text);
        } else if (m.type === 'assistant') {
          for (const b of m.message?.content ?? []) if (b.type === 'tool_use') { tools.push({ name: b.name, input: b.input }); onTool(b.name, b.input); }
        } else if (m.type === 'result') {
          stats.session_id = m.session_id ?? stats.session_id;
          stats.cost_usd_total += m.total_cost_usd ?? 0;
          final = m.subtype === 'success' ? (m.result ?? '') : `(${m.subtype}${m.errors?.length ? `: ${m.errors.join('; ')}` : ''})`;
          if (m.subtype !== 'success') stats.last_error = final;
        }
      }
      stats.turns++;
      stats.last_error = null;
    } catch (e) {
      stats.last_error = e.message;
      if (NOT_LOGGED_IN.test(e.message)) markUnavailable(e.message);
      log(`brain error: ${e.message}`);
      throw e;
    } finally {
      stats.busy = false;
      stats.last_duration_ms = Date.now() - started;
    }
    return { reply: final, tools, session_id: stats.session_id, duration_ms: stats.last_duration_ms };
  }

  return {
    get available() { return stats.available; },
    think, probe, status: () => ({ ...stats }),
    reset: () => { stats.session_id = null; stats.turns = 0; stats.available = true; stats.auth = 'unknown'; stats.hint = null; stats.last_error = null; return probe(); },
  };
}
