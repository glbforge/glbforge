# GLBForge companion

A GLB that lives on your desktop and talks. One transparent, always-on-top
window renders the asset with its animation clips, turns a little toward your
cursor, leans into a drag, fidgets when ignored, hops when you click it, and
takes a typed message when you double-click it. Behind it is an agent: either
the embedded brain (a Claude agent on your Claude Code login) or any MCP
client that chooses to *be* the character. Either way the model on screen is
the agent's face: it speaks in a bubble, gestures, switches clips, and can
take a snapshot to see what you see.

```
glbforge animate model.web.glb          # → model.idle.glb   (looping idle clip, no rig needed)
glbforge animate model.idle.glb -p hop --name hop -o model.idle.glb     # add a reaction clip
cd companion && pnpm install            # standalone: electron stays out of the monorepo lockfile
pnpm start -- /abs/path/model.idle.glb
```

The window appears bottom-right. Click: it hops and says hi. Drag it
anywhere. Double-click (or press `/` while it has focus) to type to it; Esc
closes the box. Quit with `POST /quit` or Cmd+Q while it is focused.

## The brain

`GLBFORGE_COMPANION_BRAIN` picks who answers when you type:

| mode | who answers | needs |
|---|---|---|
| `sdk` (default) | an embedded Claude agent via the Claude Agent SDK, with the body as its tools and glbforge's inspect tools attached read-only, resumed across turns so it remembers the conversation | the Claude CLI logged in (`claude`, then `/login`) or `ANTHROPIC_API_KEY` |
| `external` | whichever MCP client calls `companion_listen` and answers with `companion_reply` — a Claude Code session, a script, anything | the MCP bridge registered (below) |
| `off` | nobody; typed messages queue in the inbox | — |

The embedded brain has no shell and no filesystem: its only tools are
`body.say / emote / play / look / status` and glbforge's `inspect*`, `render`
and `capabilities`, so it can tell you how many triangles it is made of but
cannot touch your machine. Any other tool call is denied, not prompted. It
runs on the CLI's own login, so nothing extra to configure; if the CLI is not
logged in the window says so, `/state` reports `brain.auth: not-logged-in`
with the fix, and typed messages queue for an external brain instead of being
lost. `POST /brain/reset` re-probes after you log in.

Model: whatever Claude Code defaults to (`GLBFORGE_COMPANION_BRAIN_MODEL`
overrides). Cost accrues on your Claude Code plan and `/state` reports the
running total the SDK measured. Measured on 2026-09-22 with the Opus default:
three turns (one with a glbforge inspect call) cost $1.04, 7–10 s each. For a
character that answers every click, start it with
`GLBFORGE_COMPANION_BRAIN_MODEL=sonnet`.

## Drive it from a shell

Every reply is an envelope, `{ ok, summary, data, state }`, where `state` is
the body *after* the call — an agent never has to follow up with `/state` to
learn what it just did.

```bash
curl -s localhost:4747/state
curl -s -X POST localhost:4747/chat  -d '{"text":"how many triangles are you?"}'      # the brain answers (sdk) or queues (external)
curl -s -X POST localhost:4747/event -d '{"text":"tests passed on main","source":"ci"}' # the character reacts
curl -s -X POST localhost:4747/say   -d '{"text":"build is green","seconds":4}'
curl -s -X POST localhost:4747/emote -d '{"gesture":"nod"}'             # hop | spin | nod | shake | wave
curl -s -X POST localhost:4747/play  -d '{"clip":"hop","loop":false}'   # a baked clip, once, then back to idle
curl -s -X POST localhost:4747/move  -d '{"corner":"top-left"}'
curl -s -X POST localhost:4747/load  -d '{"path":"/abs/other.glb"}'
curl -s -X POST localhost:4747/snapshot -d '{"out":"/tmp/companion.png"}'
curl -s "localhost:4747/events?since=0"
```

Give background work a face: a Claude Code `Stop` hook, a CI step or a cron
job can `POST /event` and the character will say something about it.

## Drive it — or be it — from an agent (MCP)

`companion/mcp.mjs` is a stdio MCP server that forwards to the running window.
Register it next to glbforge:

```json
"companion": { "command": "node", "args": ["companion/mcp.mjs"] }
```

Driving: `companion_state`, `companion_load`, `companion_play`,
`companion_emote`, `companion_say`, `companion_move`, `companion_snapshot`
(PNG as an image block), `companion_chat`, `companion_event`,
`companion_events`. Every mutating tool returns the state after the call and
notes what else you could do (an `emote hop` on a model with a baked `hop`
clip tells you to `play` it instead; a long `say` tells you it will wrap).

Being it: start the window with `GLBFORGE_COMPANION_BRAIN=external`, then
loop `companion_listen` (long-poll, up to 60 s) → think → `companion_reply`
(+ `companion_emote` if it fits). Whatever the user types into the window
arrives as the next item; events posted by hooks arrive the same way. This is
how a Claude Code session becomes the character without the SDK.

A typical authoring loop: `glbforge` `animate` → `companion_load` →
`companion_say("hi")` → `companion_snapshot` to confirm. Nothing leaves
127.0.0.1 except the embedded brain's own model calls.

## What it needs from the asset

- Any `.glb` three.js loads: WebP or PNG/JPEG textures, meshopt compression
  and quantization are fine (the default `optimize` output). KTX2 textures are
  **not** decoded here — use the `.web.glb`, not the `.ktx2.glb`.
- Clips are optional. Without any, the model still gazes, hops and gestures
  (procedural, on a wrapper group). With a clip named `idle`, it plays on a
  loop; any other clip can be triggered once as a reaction.
- The framing is computed from the rest pose (height normalized to 1, base at
  the bottom), so a baked rise of a few percent stays in view.

## Cost

It renders at 30 fps (`?fps=` on the window URL to change) and keeps
rendering while on screen; expect a few percent of one core plus the GPU's
share. Quit it when you want the machine back.

## Limits

- macOS is the tested platform (Electron transparent windows also work on
  Windows and most Linux compositors, untested here).
- It is a window, not a wallpaper: it floats above everything on every space,
  including full-screen apps, and hides from the Dock.
- No voice yet: text in, bubble out. Speech and lip-sync are the obvious next
  step and the place the VRM/Live2D companions are ahead.
- iOS has no equivalent: the home screen cannot host a live 3D view. The same
  asset reaches iPhone as AR Quick Look via `glbforge usdz`, which bakes the
  idle clip as xform time samples.
