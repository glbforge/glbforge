/**
 * The companion's brain: a Claude agent that owns the body.
 *
 * Built on the Claude Agent SDK, so it runs on the user's Claude Code login —
 * no API key to manage. One persistent session (streaming input mode): the
 * Claude Code process stays alive between messages and the prompt cache stays
 * warm, so a message costs its own tokens plus a cache read of the prefix,
 * not a fresh prefix write. After IDLE_MS of silence the process is closed
 * and the next message resumes the same session id, so memory survives.
 *
 * The prefix is kept small on purpose: the body is an in-process MCP server
 * (say, emote, play, look, status) plus ONE glbforge tool, inspect_self,
 * which reaches glbforge's server lazily over stdio — attaching the whole
 * 28-tool server put ~18k tokens of schemas into every call. No built-in
 * tools: the brain has no shell and no filesystem; anything not listed is
 * denied, not prompted.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IDLE_MS = Number(process.env.GLBFORGE_COMPANION_BRAIN_IDLE_MS || 20 * 60 * 1000);

/** glbforge's MCP server, so the character can inspect its own mesh: GLBFORGE_MCP_SERVER, the monorepo checkout, or an installed @glbforge/mcp. */
function resolveGlbforgeMcp() {
  const fromEnv = process.env.GLBFORGE_MCP_SERVER;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const local = path.join(HERE, '..', 'packages', 'mcp', 'dist', 'index.js');
  if (fs.existsSync(local)) return local;
  try { return createRequire(import.meta.url).resolve('@glbforge/mcp/dist/index.js'); } catch { return null; }
}

const PERSONA = `You are the character on the user's desktop: a 3D model living in a small always-on-top window. Your reply text is shown verbatim in your speech bubble — plain text only, no markdown, no headings, no bullet lists — so keep replies to one or two short sentences; call say() again for a second thought rather than writing a paragraph. You can move: emote() for a quick gesture, play() for one of your baked clips. You can look() at yourself as the user sees you; status() tells you what is loaded and playing. When asked about your own mesh (triangles, size, materials, clips), call inspect_self and quote its numbers. Be warm, playful and honest: never claim to have done something a tool did not report. You have no shell and no filesystem.`;

export async function createBrain({ body, log = () => {}, model = process.env.GLBFORGE_COMPANION_BRAIN_MODEL || undefined }) {
  let sdk;
  try {
    sdk = await import('@anthropic-ai/claude-agent-sdk');
  } catch (e) {
    return { available: false, reason: `Claude Agent SDK not installed (${e.message}); run pnpm install in companion/`, status: () => ({ mode: 'external', available: false }) };
  }
  const { query, tool, createSdkMcpServer } = sdk;
  const { z } = await import('zod');

  // ---- one glbforge tool, reached lazily over stdio (schemas of the other 27 never enter the prompt)
  const glbforgePath = resolveGlbforgeMcp();
  const glbforgeServer = glbforgePath ? { command: 'node', args: [glbforgePath] } : { command: 'npx', args: ['-y', '@glbforge/mcp'] };
  let glbforgeClient = null;
  async function glbforge(toolName, args) {
    if (!glbforgeClient) {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
      const c = new Client({ name: 'glbforge-companion-brain', version: '0.8.0' });
      await c.connect(new StdioClientTransport({ ...glbforgeServer, stderr: 'ignore' }));
      glbforgeClient = c;
    }
    const r = await glbforgeClient.callTool({ name: toolName, arguments: args });
    return r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  }

  const text = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
  const bodyServer = createSdkMcpServer({
    name: 'body', version: '0.2.0', alwaysLoad: true,
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
      tool('inspect_self', 'Measure your own mesh with glbforge: scene (triangles, size in metres, shells, watertight, origin), animation (clips and whether they move), or materials (textures, PBR channels). Quote the numbers it returns.',
        { report: z.enum(['scene', 'animation', 'materials']).default('scene') },
        async ({ report }) => {
          const model = body.modelPath();
          if (!model) return { content: [{ type: 'text', text: 'no model is loaded' }], isError: true };
          try {
            const name = { scene: 'inspect', animation: 'inspect_animation', materials: 'inspect_materials' }[report];
            const out = await glbforge(name, { path: model });
            return { content: [{ type: 'text', text: out.slice(0, 6000) }] };
          } catch (e) {
            return { content: [{ type: 'text', text: `glbforge is not reachable (${e.message}); ${glbforgePath ? 'its server failed to start' : 'nothing is installed and npx could not fetch @glbforge/mcp'}` }], isError: true };
          }
        },
        { annotations: { readOnlyHint: true, openWorldHint: false } }),
    ],
  });

  const stats = {
    mode: 'sdk', available: true, auth: 'unknown', hint: null, busy: false, session_id: null, process: 'idle',
    turns: 0, cost_usd_total: 0, usage_total: { input: 0, cache_write: 0, cache_read: 0, output: 0 }, last_turn: null,
    last_error: null, last_duration_ms: null, model: model ?? 'claude-code default',
    glbforge_tools: glbforgePath ? 'local' : 'npx', glbforge_server: glbforgePath ?? 'npx -y @glbforge/mcp',
  };
  const NOT_LOGGED_IN = /not logged in|please run \/login|authentication|api key/i;
  const LOGIN_HINT = 'the Claude CLI is not logged in: run `claude` and `/login` once (or export ANTHROPIC_API_KEY), then POST /brain/reset. Until then typed messages queue for an external brain (companion_listen / companion_reply).';
  function markUnavailable(reason) { stats.available = false; stats.auth = 'not-logged-in'; stats.hint = LOGIN_HINT; stats.last_error = reason; }

  const options = () => ({
    systemPrompt: PERSONA,
    mcpServers: { body: bodyServer }, allowedTools: ['mcp__body__*'], tools: [],
    permissionMode: 'default',
    canUseTool: async (name) => ({ behavior: 'deny', message: `${name} is not available to the companion` }),
    settingSources: [],
    maxTurns: 6,
    includePartialMessages: true,
    cwd: HERE,
    ...(model ? { model } : {}),
    ...(stats.session_id ? { resume: stats.session_id } : {}),
  });

  /** Cheap startup check: one no-tool turn in its own throwaway session. Sets stats.auth so /state is honest before the first chat. */
  async function probe() {
    try {
      for await (const m of query({ prompt: 'Reply with exactly: pong', options: { tools: [], settingSources: [], maxTurns: 1, cwd: HERE, ...(model ? { model } : {}) } })) {
        if (m.type === 'result') { if (m.subtype === 'success' && !NOT_LOGGED_IN.test(m.result ?? '')) { stats.auth = 'ok'; stats.hint = null; } else markUnavailable(m.result ?? m.subtype); }
      }
    } catch (e) { markUnavailable(e.message); }
    return stats.auth;
  }

  // ---- the persistent session: one process, messages pushed into its input stream
  let session = null;   // { push, close }
  let costBeforeSession = 0;   // total_cost_usd is cumulative within a streaming session
  let turn = null;      // the in-flight turn's callbacks
  let idleTimer = null;
  function openSession() {
    const queue = []; let wake = null; let closed = false;
    async function* input() {
      while (!closed) {
        if (queue.length) { yield queue.shift(); continue; }
        await new Promise((r) => { wake = r; });
      }
    }
    const q = query({ prompt: input(), options: options() });
    stats.process = 'running';
    (async () => {
      try {
        for await (const m of q) route(m);
        turn?.reject(new Error('the brain session ended before answering'));
      } catch (e) {
        if (NOT_LOGGED_IN.test(e.message)) markUnavailable(e.message);
        stats.last_error = e.message;
        log(`brain session error: ${e.message}`);
        turn?.reject(e);
      } finally {
        closed = true; session = null; turn = null; stats.process = 'idle'; costBeforeSession = stats.cost_usd_total;
      }
    })();
    return {
      push(msg) { queue.push(msg); const w = wake; wake = null; w?.(); },
      close() { closed = true; const w = wake; wake = null; w?.(); },
    };
  }
  function route(m) {
    if (m.type === 'system' && m.subtype === 'init') { stats.session_id = m.session_id; return; }
    if (!turn) return;
    if (m.type === 'stream_event') {
      const e = m.event;
      if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') turn.onText(e.delta.text);
    } else if (m.type === 'assistant') {
      turn.calls++;
      for (const b of m.message?.content ?? []) if (b.type === 'tool_use') { turn.tools.push({ name: b.name, input: b.input }); turn.onTool(b.name, b.input); }
    } else if (m.type === 'result') {
      stats.session_id = m.session_id ?? stats.session_id;
      const u = m.usage ?? {};
      const usage = { input: u.input_tokens ?? 0, cache_write: u.cache_creation_input_tokens ?? 0, cache_read: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0 };
      for (const k of Object.keys(usage)) stats.usage_total[k] += usage[k];
      const sessionCost = m.total_cost_usd ?? 0;
      const turnCost = Math.max(0, costBeforeSession + sessionCost - stats.cost_usd_total);
      stats.cost_usd_total = costBeforeSession + sessionCost;
      stats.last_turn = { usage, model_calls: turn.calls, sdk_cost_usd: Math.round(turnCost * 1e4) / 1e4, duration_ms: m.duration_ms ?? null };
      const final = m.subtype === 'success' ? (m.result ?? '') : `(${m.subtype}${m.errors?.length ? `: ${m.errors.join('; ')}` : ''})`;
      if (m.subtype !== 'success') stats.last_error = final;
      const t = turn; turn = null;
      t.resolve({ reply: final, tools: t.tools, usage });
    }
  }
  function touchIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { session?.close(); log(`brain idle for ${IDLE_MS / 60000} min; process closed, session ${stats.session_id?.slice(0, 8)} resumes on the next message`); }, IDLE_MS);
    idleTimer.unref?.();
  }

  /** One turn. Streams text deltas via onText, reports tool calls via onTool, returns the final reply with its measured usage. */
  async function think(prompt, { onText = () => {}, onTool = () => {} } = {}) {
    if (stats.busy) throw new Error('the brain is busy with the previous message; wait for it to finish');
    stats.busy = true;
    const started = Date.now();
    try {
      if (!session) session = openSession();
      const result = await new Promise((resolve, reject) => {
        turn = { onText, onTool, tools: [], calls: 0, resolve, reject };
        session.push({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null });
      });
      stats.turns++;
      stats.last_error = null;
      return { ...result, session_id: stats.session_id, duration_ms: Date.now() - started };
    } catch (e) {
      stats.last_error = e.message;
      throw e;
    } finally {
      stats.busy = false;
      stats.last_duration_ms = Date.now() - started;
      touchIdle();
    }
  }

  return {
    get available() { return stats.available; },
    think, probe, status: () => ({ ...stats, idle_minutes: IDLE_MS / 60000 }),
    reset: () => { session?.close(); stats.session_id = null; stats.turns = 0; stats.available = true; stats.auth = 'unknown'; stats.hint = null; stats.last_error = null; return probe(); },
    close: () => { session?.close(); glbforgeClient?.close?.(); },
  };
}
