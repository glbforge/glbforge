# Walk — 2026-09-22 — seed 20260922 — a PNG badge becomes a desktop companion

**The draw** (`pnpm random-task -- --seed 20260922`):

- **Start from:** a transparent-background PNG logo — `assets/ci-badge.png`
  (256×256 RGBA, the CI badge).
- **Goal:** give it a looping idle motion and a reaction clip, then put it on
  the desktop as a companion an agent can talk through.
- **Constraint:** every number reported must come from a tool, with the tool
  named.
- **Twist:** the profile is pinned to a version that is not the latest
  (`mobile-hero@1`; the server's latest is `@2`).

This draw needed two things that did not exist when it was drawn: a way to
bake motion into a GLB without a rig, and somewhere on the desktop for the
result to live. Both were built during the walk (`glbforge animate` / MCP
`animate`, and `companion/`), then the walk was done for real against the
built tools. The same walk was repeated on `examples/lucky-cat.web.glb`
(150k-triangle Meshy cat) to check the motion reads on a real asset.

## The walk

| # | tool + args | what it said | what I did next | verdict |
|---|---|---|---|---|
| 1 | `glbforge extrude assets/ci-badge.png -o badge.glb` | `1 shape(s), 0 hole(s), 72 tris [mode=alpha]` | optimize it | clear |
| 2 | `glbforge optimize badge.glb -p mobile-hero@1` | `SSIM 99.3% … within mobile-hero@1 budget (72.4% smaller)` | animate the `.web.glb` | clear — the pin was accepted and echoed back as `@1` |
| 3 | `glbforge animate badge.web.glb --json` | `clip "idle": rise 0.01398 m, yaw ±4°, tilt ±1.5°, 4 s, 121 keys, 2 channels; pivot [-0.002, -0.311, 0]; height 0.699 m` | add a reaction clip | clear |
| 4 | `glbforge animate badge.idle.glb -p hop --name hop -o badge.idle.glb` | `rises 84 mm, scales ±8.0% over 1.2s, 37 keys, pivot reused` | verify motion | clear |
| 5 | `glbforge inspect badge.idle.glb --json` | 3 nodes, root `GLBForge_Pivot`, `origin/not-at-base` info, **nothing about clips** | look for an animation read | guessed — see T1 |
| 6 | MCP `inspect_animation` (lucky-cat) | 3 moving clips, `has_motion: true` each, animated prim `/Asset/GLBForge_Pivot_1`; `ROOT_MOTION` info: "Strip root translation if the runtime expects in-place animation" | ignore the advice | wrong — see T2; also T3 |
| 7 | MCP `render_animation_strip animation=1 include_clip=true` (lucky-cat) | 8 labelled frames + GIF; the cat rises and squashes | ship | clear (4.9 s for 150k tris — acceptable, it is a render) |
| 8 | MCP `animate` on `badge.web.glb` | same numbers as step 3, **same sha256** `baf39d9f…`, `ANIMATION_BAKED` + `nextActions` → `render_animation_strip`, `export_usdz` | — | clear; deterministic across CLI and MCP |
| 9 | `glbforge usdz lucky-cat.idle.glb` | `! 3 clips animate nodes; exported "idle" as xform time samples (USD carries one timeline)` | inspect the usdz | clear |
| 10 | `glbforge inspect lucky-cat.idle.usdz` | same geometry findings as the GLB; `10 nodes (depth 4)` | — | guessed — see T4 |
| 11 | `cd companion && pnpm install && pnpm start -- badge.idle.glb` | window bottom-right, `GET /state`: `clips: [idle, hop], playing: idle` | drive it | clear |
| 12 | MCP `companion_load` / `companion_say` / `companion_snapshot` | `{"clips":["idle","hop"],"idle":"idle"}` in 360 ms; bubble shown; PNG returned as an image block, 640×640 | — | clear |

Timings, from the tools' own `duration_ms` (MCP) or `time` (CLI):

| step | ms |
|---|---|
| `glbforge animate` (150k-tri cat, CLI wall clock) | 657 |
| MCP `animate` (72-tri badge) | 71 |
| MCP `inspect_animation` (cat) | 199 |
| MCP `render_animation_strip` (cat, 8 frames + GIF) | 4850 |
| `companion_load` → renderer parsed and playing | 360 |

## Findings

### T1 · `open` · `inspect` does not say the asset moves

Step 5: the inspect summary lists the new root `GLBForge_Pivot` and 3 nodes,
but never that the file now carries two clips. An agent that just ran
`animate` and reads `inspect` — the tool the CLI's own `next:` line points
at — sees nothing changed except a node count. The CLI has no animation read
at all (`inspect_animation` exists on the MCP only). The `animate` command
now says so in its `next:` line, but the honest fix is one sentence in the
inspect summary: "2 clips, 6.0 s, all moving" when `has_animation`, and a
`--animation` section on the CLI.

### T2 · `fixed` · `ROOT_MOTION` fired on a closed-loop bob and advised deleting it

Step 6: the idle clip moves the pivot up 14 mm and back. `inspect_animation`
called that root motion and suggested "strip root translation if the runtime
expects in-place animation" — following it would remove the bob. Root motion
means the character travels: a net displacement between the clip's first and
last key. A loop that returns to where it started is in place by definition.
The rule now measures net displacement of a root node's translation over the
clip (> 1 mm) and reports the distance. Test: a closed bob is not root
motion; a clip whose root ends 0.5 m away is.

### T3 · `fixed` · clip durations reported with float32 noise

`duration_seconds: 1.2000000476837158` in the same reply, and in the strip's
labels. It is the float32 accessor value printed as a double — not a
measurement. Rounded to microseconds at the report boundary.

### T4 · `open` · `inspect` on a USDZ counts material/shader prims as nodes

Step 10: the same one-mesh asset is "3 nodes" as GLB and "10 nodes (depth 4)"
as USDZ, because `Materials`, the `Material`, its shaders and the primvar
reader are prims. An agent diffing before/after export sees a hierarchy
change that is not one. Either count only Xform/Mesh/SkelRoot prims as
nodes, or say "10 prims (1 transform, 1 mesh, 7 material)".

### T5 · `open` · `optimize --profile name@N` is accepted silently even when newer exists

Step 2: the pin worked and the report said `mobile-hero@1`. Nothing said
`@2` exists. Pinning is the contract, so silence is defensible, but one info
line ("pinned to @1; latest is @2, which changed X") would let an agent decide
rather than not know. Left open: it is a policy choice for the maintainer.

### T6 · `wontfix` · the companion cannot decode KTX2

`lucky-cat.ktx2.glb` will not load in the companion (no Basis transcoder
served). The `.web.glb` is the documented input and the README says so; the
transcoder is a 300 KB wasm that would have to be served from the companion
directory. Not worth it for a desktop window until someone asks.

### T7 · `open` · no CLI path to the companion

`glbforge companion model.glb` would be the obvious verb; it does not exist
because the CLI must not depend on Electron. The README's `pnpm start --
model.glb` is a two-directory hop an agent has to know. A `glbforge init
--companion` that writes the `.mcp.json` entry, or a `npx @glbforge/companion
model.glb` once it is published, would close it.

## What the walk produced

- `packages/core/src/animate.ts`: `animate(doc, { preset, duration,
  amplitude, fps, name })` — idle / bob / spin / sway / breathe / hop, closed
  loops, pivot pair at the base centre, idempotent re-runs, byte-deterministic.
- `toUsdz` bakes the first node clip as `xformOp:transform` time samples at
  30 fps; the pure-TS USD reader turns it back into a moving clip (test).
- `glbforge animate`, MCP `animate` (28 tools now), `ANIMATION_BAKED` /
  `ANIMATE_WARNING` codes, schema, docs.
- `companion/`: Electron window + localhost HTTP + MCP bridge; verified by
  snapshot (see the PNGs referenced in the PR).
- `scripts/random-task.mjs` and this directory.
