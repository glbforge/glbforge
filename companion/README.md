# GLBForge companion

A GLB that lives on your desktop. One transparent, always-on-top window renders
the asset with its animation clips, turns a little toward your cursor, hops
when you click it, and drags anywhere. An agent drives it over localhost —
HTTP or MCP — so the model on screen *is* the agent's face: it can speak in a
bubble, gesture, switch clips, and take a snapshot to see what you see.

```
glbforge animate model.web.glb          # → model.idle.glb   (looping idle clip, no rig needed)
glbforge animate model.idle.glb -p hop --name hop -o model.idle.glb     # add a reaction clip
cd companion && pnpm install            # standalone: electron is not in the monorepo lockfile
pnpm start -- /abs/path/model.idle.glb
```

The window appears bottom-right. Click it: it hops and says hi. Drag it
anywhere. Quit with `POST /quit` or Cmd+Q while it is focused.

## Drive it from a shell

```bash
curl -s localhost:4747/state
curl -s -X POST localhost:4747/say   -d '{"text":"build is green","seconds":4}'
curl -s -X POST localhost:4747/emote -d '{"gesture":"nod"}'             # hop | spin | nod | shake | wave
curl -s -X POST localhost:4747/play  -d '{"clip":"hop","loop":false}'   # a baked clip, once, then back to idle
curl -s -X POST localhost:4747/move  -d '{"corner":"top-left"}'
curl -s -X POST localhost:4747/load  -d '{"path":"/abs/other.glb"}'
curl -s -X POST localhost:4747/snapshot -d '{"out":"/tmp/companion.png"}'
```

## Drive it from an agent (MCP)

`companion/mcp.mjs` is a stdio MCP server that forwards to the running window:
`companion_state`, `companion_load`, `companion_play`, `companion_emote`,
`companion_say`, `companion_move`, `companion_snapshot` (returns the PNG as an
image block, so the agent can check its own work). Register it next to
glbforge:

```json
"companion": { "command": "node", "args": ["companion/mcp.mjs"] }
```

A typical loop: `glbforge` `animate` → `companion_load` → `companion_say("hi")`
→ `companion_snapshot` to confirm. Nothing leaves 127.0.0.1.

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
- iOS has no equivalent: the home screen cannot host a live 3D view. The same
  asset reaches iPhone as AR Quick Look via `glbforge usdz`, which bakes the
  idle clip as xform time samples.
