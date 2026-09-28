# Pass — 2026-09-28 — 289eacd

**Role:** rival

## Step 0 — claim check

`gh`/`mcp__github__list_pull_requests` on `glbforge/glbforge`, open PRs whose
head starts with `agent-loop/`: 24 open, 14 of them `rival` (`#38`–`#58`),
none merged. `pnpm ledger` on `main` still prints `rival` as least-recently-used
because none of those 14 have landed — the same rotation blind spot `#38`'s
notes and `#40`, `#53`, `#56`, `#57` already flagged in prose. Not re-filing
that meta-observation as its own ledger entry: five passes have already
independently declined to (choosing to note it inline instead), and this
pass has nothing to add to it that #57's write-up didn't already say.

Read all 14 rival PR bodies in full (fetched via `pull_request_read`) before
picking a target, specifically to avoid a 15th restatement. They cluster
into: the SSIM gate's blindness to normal maps / metallic-roughness /
emissive / KTX2 (`#53`, `#56`, `#57`, `#58` — three distinct mechanisms, not
duplicates of each other), independent geometry/format oracles (Khronos
validator `#38`, Manifold `#39`, Pixar USD reader `#51`, `ssim.js` `#40`),
and fidelity/tooling comparisons (`gltfpack` LOD `#42`, Draco vs. meshopt
`#44`, three.js `ExtrudeGeometry` vs. `extrude_image` `#45`, `gltfjsx` node
naming `#46`, skinned-mesh triangle targets `#54`, hard-edge normals `#52`).
None of them touch `inspect/performance.ts`'s draw-call/triangle accounting,
so that's where this pass looked.

## Ground truth

`pnpm install && pnpm -r build`: 6 packages, clean. `pnpm -r test` before any
change: core 177/180 (3 skipped, LFS pointers), mcp 46/46, cli 5/10 (5
skipped, LFS), studio 2/2 — all green. `pnpm probe -- --no-live
--json /tmp/probe.json`: 28 tools, packages 0.8.0, advice 3/3 resolved (1),
0 new findings, 0 dangling, 33/130 codes exercised, no regressions vs
`baseline.json`.

## What was measured

`analyze_performance`'s `draw_call_estimate` (and the `max_draw_calls`
budget it's checked against) is documented, in the `mobile-hero` profile's
own published rationale, as **"the floor a renderer without instancing
support pays"** — one call per primitive per node that places it. That
rationale text also names the one case it flags as a cost multiplier in
passing ("two [materials] when a glass or emissive part is unavoidable")
without saying anything about draw calls specifically.

GLBForge can generate exactly that glass part itself: `extrude_image`'s
`preset: 'acrylic'` (a documented MCP/CLI option, `extrude/index.ts:663-672`)
sets `KHR_materials_transmission` with `transmissionFactor: 0.85` on the
forged material. I built one with the real CLI:

```
glbforge extrude assets/ci-badge.png --preset acrylic --bevel 0.02 --depth 0.08
```

→ 300 triangles, 1 primitive, 1 material. `analyze`'s own numbers:
`drawCallEstimate: 1`, comfortably inside every profile's `maxDrawCalls`.

**The independent oracle.** Real WebGL implementations of
`KHR_materials_transmission` (I verified three.js 0.169.0, the version this
repo's own Studio and `scaffold` output ship — `WebGLRenderer.js:1241/1259`)
render transmission by re-rendering the scene's *opaque* objects into an
offscreen target for the refraction background before the main pass, and —
when `WEBGL_multisampled_render_to_texture` isn't available (true for
software rasterizers, most Android GPUs, and this sandbox's SwiftShader) —
render a double-sided transmissive object's backside a second time
(`WebGLRenderer.js:1531-1548`). Neither cost is a three.js quirk-of-choice;
it's the documented technique for approximating refraction without ray
tracing, so any engine implementing the extension pays some version of it.

Built a real page (three.js `GLTFLoader`, headless Chromium via
`playwright-core`, `--use-gl=swiftshader`) that loads the acrylic badge and
reports `renderer.info.render.calls`/`.triangles` after one render, with an
environment map so transmission has something to refract:

| scene | GLBForge's floor (1 call/primitive/node) | measured real `render.calls` | measured triangles |
|---|---|---|---|
| badge alone | 1 | 1 | 300 |
| badge + one opaque ground plane | 2 | **3** | 304 |
| same, transmission forced to 0 (control) | 2 | 2 | 302 |
| badge + ground, material set `DoubleSide` | 2 | **4** | 604 |

The control row isolates the cause: identical scene, only the transmission
flag differs, and it alone accounts for the whole gap (2→3, 2→4). The
triangle counts corroborate the mechanism exactly: row 2's extra 4 triangles
are the ground plane's own 2 redrawn once more in the prepass; row 4's extra
304 are the badge's 300 redrawn backside plus the ground's 2 redrawn again.

This isn't a small miscount fixable by counting harder: the extra cost is a
function of *how much opaque geometry shares the scene*, which
`draw_call_estimate` cannot know from the asset file alone — a `max_draw_calls:
4` pass for an acrylic-preset asset can be handed to a scene where the real
number is already past that limit before the rest of the page's geometry is
even counted. `extrude_image` never sets `doubleSided` on any preset
(confirmed: `extrude/index.ts:273` always passes `false`), so row 4 is a
demonstration of the mechanism's ceiling, not a claim about GLBForge's own
default output; row 2 (badge + literally any other opaque prop or ground
plane in the same scene) is the realistic case and needed no artificial
setup to show a 50% gap.

## What changed

Added `TRANSMISSION_DRAW_COST_UNCOUNTED` (info) to the diagnostic catalog
(`inspect/diagnostics.ts`) and raise it from `analyzePerformance`
(`inspect/performance.ts`) whenever a mesh with triangles uses a material
already carrying the (pre-existing) `unsupportedFeatures: ['transmission']`
flag — no new parsing, reusing what `from-gltf.ts` already detects. The
message states only what's measured (the extension is present, the estimate
counts only this asset's own primitives) and defers the "real renderers pay
more" claim to the fix text rather than asserting a specific multiplier,
since the multiplier depends on the consuming scene, not this file.

Did not touch `max_draw_calls`, any profile number, or `draw_call_estimate`'s
formula — those are versioned contracts (`CLAUDE.md`) and this finding
doesn't call for a different number, it calls for the existing number to
carry a caveat when it's the wrong kind of promise for the material in
question. New fixture `transmissiveMaterialScene()` in
`test/agent-fixtures.ts` (a grid primitive with
`KHR_materials_transmission`, mirroring how `extrude/index.ts` sets it) and
a test in `test/inspect.test.ts` asserting the diagnostic fires (severity,
`data.materials`) on the transmissive fixture and not on the plain one, and
that `draw_call_estimate` itself is unchanged (1) — the point is the missing
caveat, not a different count. Ran `pnpm --filter @glbforge/mcp build` to
regenerate `docs/error-codes.md` and the 28 output schemas (the new code
appears in `diagnostic.json`'s enum); `pnpm docs:check` passes.

No `playwright-core`/browser dependency was added to any package — the
oracle ran from a scratch directory outside the repo, same reasoning `#57`
gave: a headless-browser dependency doesn't belong in this repo's default
(LFS-free, CI-portable) test suite, and the methodology above is written out
fully enough to rerun without it.

## Verify

`pnpm -r build && pnpm -r test`: core 178/181 (3 skipped LFS, +1 new test),
mcp 46/46, cli 5/10 (5 skipped LFS), studio 2/2 — all green.
`pnpm probe -- --no-live --json /tmp/probe-after.json`: 28 tools, advice 3/3
resolved, 0 new findings, 0 dangling, **33/131** codes exercised (131, not
130 — the catalog grew by the one new code; expected, not a regression), no
regressions vs `baseline.json`. Confirmed end-to-end against the real
acrylic badge GLB (not just the synthetic fixture): `analyzePerformance`
on the CLI-built file reports exactly one `TRANSMISSION_DRAW_COST_UNCOUNTED`
diagnostic, `prim_path` pointing at the transmissive primitive.

No `baseline.json` edit: nothing the probe measures moved except the vocab
denominator, which is supposed to move when the catalog grows.

## Left open

### L120 · `open` · `draw_call_estimate` doesn't count what a real renderer pays for `KHR_materials_transmission`

`extrude_image`'s `acrylic` preset produces a material whose true GPU
draw-call cost in any renderer implementing the extension (verified: three.js
0.169.0, the version this repo's own `scaffold` output and Studio ship)
depends on how much opaque geometry shares its scene — up to 1.5–2x the
"floor" `draw_call_estimate`/`max_draw_calls` promise, measured directly
(table above) against a real WebGL oracle, not GLBForge's own instrumented
renderer. This pass ships the missing caveat as a new advisory diagnostic
(`TRANSMISSION_DRAW_COST_UNCOUNTED`) rather than a different number, because
there's no single correct number to publish — it's a property of the scene
the asset will be dropped into, not the asset alone. **Closing this further
would take:** deciding whether `max_draw_calls`'s rationale text
(`profiles.ts`) should say so explicitly for any profile likely to see glass
presets, and/or whether `extrude_image`'s own tool description should warn
before the material ships, not just after `analyze` is called on the result.
Left both as the maintainer's call since either touches a versioned profile
or a shipped tool description.

Picked `L120` (`main`'s ledger tops out at `L14`) rather than the "obvious"
`L15`: `#38` already claimed `L30`–`L32`, `#39` claimed `L33`–`L35`, and
`#53`/`#56`/`#57` each separately picked `L15` — the exact rotation-blindspot
collision this file's Step 0 isn't re-filing. Jumping past the range every
open PR has already reached for is the only defense against being the *n*th
collision on it before a merge sorts the real numbering out.
