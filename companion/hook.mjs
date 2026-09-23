#!/usr/bin/env node
/**
 * Claude Code hook → the companion. Reads the hook's JSON from stdin, turns
 * the event into a short line and a gesture, and POSTs it to the running
 * window as a *body* reaction (no brain turn, no cost). Always exits 0 and
 * stays quiet when the companion is not running, so it can never slow down
 * or break a Claude Code session. Installed by `glbforge-companion hooks
 * install` (or `glbforge companion --hooks`).
 */
import path from 'node:path';

const PORT = Number(process.env.GLBFORGE_COMPANION_PORT || 4747);
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', async () => {
  let input = {};
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* not JSON: still exit 0 */ }
  const where = input.cwd ? path.basename(input.cwd) : 'a session';
  const excerpt = (s, n = 90) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  let reaction = null;
  switch (input.hook_event_name) {
    case 'Stop':
      reaction = { kind: 'done', text: input.last_assistant_message ? `${where}: ${excerpt(input.last_assistant_message)}` : `${where}: done` };
      break;
    case 'StopFailure':
      reaction = { kind: 'error', text: `${where} stopped: ${input.matcher ?? input.error ?? 'API error'}` };
      break;
    case 'Notification': {
      const t = input.notification_type ?? '';
      if (/permission|needs_input|elicitation/.test(t)) reaction = { kind: 'attention', text: `${where} needs you: ${excerpt(input.message ?? t, 70)}` };
      else if (t === 'agent_completed') reaction = { kind: 'done', text: `${where}: ${excerpt(input.message ?? 'finished', 70)}` };
      else if (t === 'idle_prompt') reaction = { kind: 'attention', text: `${where} is waiting for you` };
      else reaction = { kind: 'info', text: `${where}: ${excerpt(input.message ?? t, 70)}` };
      break;
    }
    case 'SessionStart':
      if (input.source === 'startup' || input.source === undefined) reaction = { kind: 'info', text: `hi! a session started in ${where}` };
      break;
    case 'SessionEnd':
      if (input.reason !== 'clear' && input.reason !== 'resume') reaction = { kind: 'bye', text: `${where} closed` };
      break;
    case 'SubagentStop':
      reaction = { kind: 'info', text: `${where}: ${input.agent_type ?? 'a subagent'} finished` };
      break;
    default:
      reaction = { kind: 'info', text: `${where}: ${input.hook_event_name ?? 'event'}` };
  }
  if (!reaction) return process.exit(0);
  try {
    await fetch(`http://127.0.0.1:${PORT}/event`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...reaction, react: 'body', source: 'claude-code', session_id: input.session_id, cwd: input.cwd, event: input.hook_event_name }),
      signal: AbortSignal.timeout(2500),
    });
  } catch { /* companion not running: fine */ }
  process.exit(0);
});
