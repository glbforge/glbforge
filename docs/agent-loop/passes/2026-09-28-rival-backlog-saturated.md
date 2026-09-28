# Pass — 2026-09-28 — 289eacd

**Role:** rival

## Step 0 — claim check

`mcp__github__list_pull_requests` (`gh` itself isn't available in this
sandbox), open PRs whose head starts with `agent-loop/`: **25 open**, none
merged since `#20`. **16 already claim `rival`**: `#28`, `#38`, `#39`, `#40`,
`#42`, `#44`, `#45`, `#46`, `#51`, `#52`, `#53`, `#54`, `#56`, `#57`, `#58`,
`#61`. `pnpm ledger` on `main` still prints `rival` as least-recently-used
because none of the 16 are merged — the same rotation blind spot `#38`,
`#40`, `#53`, `#56`, `#57`, `#58` already flagged in prose, one after
another, each declining to re-file it as its own ledger entry. I'm the
seventh to see it and I'm not filing an eighth restatement either; it's
tracked, it's real, and it isn't this pass's fix.

Read all 16 rival PR bodies in full (`pull_request_read` on each) before
deciding whether a 17th has anything left to say. They cluster tightly:

- **The perceptual (SSIM) verification gate's blind spots** — `#53` (normal
  map re-encoded at quality 95, but the rasterizer never samples
  `normalTexture` at all, so the setting is unverifiable), `#57` (built an
  independent WebGL/three.js PBR oracle and found quality 95 vs. 82 scores
  within noise of each other on a real normal map — recommends lowering it),
  `#58` (metallicRoughness and emissive are *never* sampled either, a
  distinct mechanism from `#53`, proven with an independent WebGL oracle
  showing a 0.30 SSIM real-world gap the internal gate reports as 1.0),
  `#56` (`textureFormat: 'ktx2'` disables the decoder for *every* slot on
  *both* sides, triggers on the requested format alone even when textures
  are untouched, and the passing message overclaimed "no visible loss" —
  fixed the message, left the design gap open). Four distinct mechanisms,
  no file overlap, each explicit about what it didn't chase (`#58`
  specifically named occlusion textures as the same mechanism, not a new
  one, and declined to file a fifth near-duplicate).
- **Independent oracles on other axes** — Khronos `gltf-validator` (`#38`),
  `manifold-3d` watertightness (`#39`), `ssim.js` against the SSIM math
  itself (`#40`), Pixar's reference USD reader (`#51`).
- **Tooling/fidelity comparisons** — `gltfpack` LOD fidelity (`#42`), Draco
  vs. meshopt, raw bytes vs. gzip (`#44`), three.js `ExtrudeGeometry` vs.
  `extrude_image` curve fidelity (`#45`), `gltfjsx` node naming (`#46`),
  `computeSmoothNormals` vs. `gltf-transform`'s `normals()` on hard edges
  (`#52`), skinned-mesh triangle-target misses (`#54`).
- **`#61`** (today, same base commit as this pass): `draw_call_estimate`
  doesn't count the extra opaque-scene render pass a real renderer pays for
  `KHR_materials_transmission` — shipped a real diagnostic
  (`TRANSMISSION_DRAW_COST_UNCOUNTED`), the freshest and best-scoped find in
  the batch, on an axis (draw-call accounting) none of the other 15 touch.

## Ground truth

`pnpm install && pnpm -r build`: clean, 6 packages. `pnpm -r test`: core
177/180 (3 skipped, LFS pointers), mcp 46/46, cli 5/10 (5 skipped, LFS),
studio 2/2 — all green, matching every sibling pass's numbers. `pnpm probe --
--no-live --json /tmp/probe.json --markdown /tmp/probe.md`: 28 tools,
packages 0.8.0, advice 3/3 resolved (1), 0 new findings, 0 dangling, 33/130
vocab codes exercised, 0 undeclared/undocumented/schema violations, no
regressions vs. `baseline.json`.

## What I tried, past the 16

Rather than add a fifth voice to the SSIM cluster or reopen an axis the
existing 16 already cover, I spent this pass's budget looking for a
genuinely uncovered angle and came up with three candidates, each run for
real and each a dead end:

1. **`glbforge scaffold`'s `KTX2Loader` import.** `packages/cli/src/scaffold.ts`
   on `main` still imports `KTX2Loader` from `three/examples/jsm/...` (typed
   by `@types/three`), not `three-stdlib` — the exact mismatch that fails
   `tsc -b` in the emitted viewer's own `build` script. This looked fresh
   until I read `#29` (*integrator*, still open, unmerged): it already found
   this precisely, fixed the import, and added an end-to-end
   install-then-build regression test. Claimed; not touched here.

2. **Does `useGLTF(path, true, true, …)` in the scaffold actually wire up the
   meshopt decoder**, or is the comment above it ("drei's useGLTF wires up
   the meshopt decoder automatically") wrong? Read
   `@react-three/drei@9.122.0`'s `Gltf.js` directly (installed in this repo's
   own `node_modules`, not reimplemented): `useGLTF`'s third positional arg
   is `useMeshopt`, and the scaffold passes `true` explicitly. The comment is
   accurate and the call is correct — no bug.

3. **`gltf-transform inspect` vs. `glbforge analyze` scene-stat agreement** on
   `site/models/plush.glb` (a real, non-LFS, forge-produced asset no other
   rival pass has used — `#28`/`#42`/`#44`/`#53`/`#57`/`#58` all used
   `cat.glb`). Installed `@gltf-transform/cli@4.5.0` in a scratch directory
   and ran `gltf-transform inspect plush.glb` against
   `node packages/cli/dist/index.js analyze plush.glb --json`. Per-primitive
   triangle and vertex counts matched exactly across both tools on all four
   mesh layers (51,222/37,741; 31,008/22,934; 49,824/35,326; 17,938/11,523).
   An honest agreement, not a story — publishing "the numbers match" isn't
   the kind of table this role exists to produce, so I didn't write it up as
   a finding.

No basisu/toktx, Blender, or usdzconvert in this sandbox (confirmed:
`which blender basisu toktx` all empty) — closing off the remaining
alternative-tool comparisons the 16 open PRs haven't already exhausted with
what *is* reachable (npm packages, headless Chromium, `usd-core` via pip).

## What changed

Nothing in `src`. No new ledger entry — I raised or restated nothing; the
whole rotation-visibility observation above is prose, per the same standing
choice six sibling passes already made.

## Verify

No code changed: `pnpm -r build && pnpm -r test` is identical to ground
truth. `pnpm probe -- --no-live`: identical to `/tmp/probe.json`, no
regressions vs. `baseline.json`. No `baseline.json` edit.

## Left open

- The rotation-visibility gap (`rival` claimed 16 times among 25 open,
  unmerged `agent-loop/*` branches, while `integrator`/`performance`/
  `archaeologist` sit at 1–2 each) still holds and is now worse than when
  `#58` and `#61` last noted it. Restating in prose only, per the standing
  choice: merging or triaging even a handful of the open rival PRs — several
  are small, self-contained, and already have passing tests (`#61`'s
  transmission diagnostic; `#56`'s message-overclaim fix) — would let the
  next `pnpm ledger` read reality again.
- The four SSIM-cluster findings (`#53`, `#56`, `#57`, `#58`) all reduce to
  the same maintainer call: give `harness/render.ts` a real PBR shading term,
  which `CLAUDE.md` reserves for a dedicated `verifyRig()`-calibration pass
  with LFS access this sandbox doesn't have. Not attempted here for the same
  reason none of the four attempted it.
- `L4` (`site/llms.txt` version line) — untouched, a release call.
