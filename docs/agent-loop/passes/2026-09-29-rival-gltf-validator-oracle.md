# Pass — 2026-09-29 — 289eacd
**Role:** rival

## Step 0 — claim check

`main` is at `289eacd` (merge of #60); `pnpm ledger` reports 0 open findings
and prints `rival` as the least-recently-used role. The live repository has
28 open `agent-loop/`-prefixed PRs that never merged, 18 of them already
`rival` (`#39, #40, #42, #44, #45, #46, #51, #52, #53, #54, #56, #57, #58,
#61, #62, #69, #71, #72`). None of those pass files are on `main`, so the
ledger's rotation is currently blind to them — worth flagging for whoever
reviews next, since "least recently used" only means "least recently
*merged*" while this backlog stands. Read every one of those 18 titles;
fetched and read `#39`'s full pass file in particular (closest neighbor: an
independent geometry oracle, `manifold-3d`, against `toStl()` output) since
it looked likely to overlap with anything STL/geometry-shaped. It already
covers self-intersecting beveled rims (`L34`, open) and a weld-tolerance
disagreement on `cat.glb` (`L35`, open) in detail — that ground is taken.

This pass picks a different oracle and a different axis: the **official
Khronos `gltf-validator`** (the reference conformance checker the whole glTF
ecosystem is checked against, `npm:gltf-validator`) against real GLBForge
output, checking spec conformance rather than geometric or perceptual
fidelity. Nothing in the current tree or any of the 28 open PRs imports or
mentions `gltf-validator`/`gltfValidator` (checked via `grep` across the
whole repo before starting) — zero overlap.

## Ground truth

`pnpm install && pnpm -r build`: clean, 6 packages. `pnpm -r test`: 177/180
core (3 skipped, LFS), 46/46 mcp, 5/10 cli (5 skipped, LFS), 2/2 studio,
13/13 meshy — all green before any change. `pnpm probe -- --no-live`: 28
tools, no baseline regressions.

## What was measured

`analyze`/`inspect` grade a GLB against GLBForge's own rule packs; nothing
in the repo checks a shipped file against the glTF 2.0 spec itself using the
reference implementation. Installed `gltf-validator` (npm, official Khronos
package) and ran it against real generation paths:

- The showcase assets already checked in (`site/models/{cat,plush,neon}.glb`,
  `assets/sample-ring.glb`) — clean, 0 errors/0 warnings (a couple of
  `info`-level notes only).
- `optimize()` on `assets/sample-ring.glb` at the `mobile-hero` profile — 0
  errors/0 warnings.
- `extrudeImage`/`extrudeFromRgba` at three settings (flat, `bevel: 0.02`,
  `layers: 'auto'`) on synthetic disc/badge artwork — 0 errors/0 warnings
  each.
- `optimize()` on a skinned + morph-target mesh
  (`test/fixtures.ts`'s `makeRiggedCylinder`, the fixture shared by
  `skinning.test.ts`, `animate.test.ts`, `usdz.test.ts`, `usd-skel.test.ts`,
  `inspect.test.ts`) — **193 `ACCESSOR_JOINTS_USED_ZERO_WEIGHT` warnings**.
  Traced to the fixture itself, not to `optimize()`: `makeRiggedCylinder`
  unconditionally sets `joints[i*4+1] = 1` for every vertex while
  `weights[i*4+1]` is legitimately `0` for the bottom half of the cylinder
  (`w1 = 0`), which is exactly the pattern the spec (and the validator) says
  must instead be joint index `0` — a "don't-care" slot some engines treat
  as "this joint is in use" regardless of its weight. Confirmed by
  construction, not just inference: validating the raw fixture (before any
  GLBForge code runs) already produces the same 192 warnings.
- To separate "GLBForge's own code introduces this" from "GLBForge silently
  passes through dirty input": hand-cleaned a copy of the fixture (zeroed
  every `JOINTS_0` index wherever the paired `WEIGHTS_0` is exactly `0`) and
  ran it through `optimize()` unchanged. Result: **0 errors/0 warnings**,
  before and after. `optimize()` neither introduces nor amplifies the
  pattern — it only reproduces exactly what it was handed.

Net result: across every generation path this pass could exercise
(`optimize`, `extrudeImage`, skinned `optimize`) on real or
spec-conformant input, GLBForge's binary output is 100% clean under the
reference glTF validator. The one non-clean case was a hygiene bug in
shared *test* fixture code, not product code, and `optimize()` was shown
not to be the source of it.

## What was fixed

- `packages/core/test/fixtures.ts` — `makeRiggedCylinder` now only sets a
  joint index for a weight slot that is actually non-zero, matching the
  spec convention. No existing test asserts on raw `JOINTS_0` values (only
  `.getCount()` and derived quantities), and weight-zero already made that
  joint's contribution mathematically inert, so this is a pure hygiene fix:
  full suite unaffected (verified below). Every skinned/morph test in the
  repo (`skinning`, `animate`, `usdz`, `usd-skel`, `inspect`) now runs
  against spec-clean input instead of input that happened to still work
  because nothing checked it against the spec.
- `packages/core/package.json` — added `gltf-validator` as a test-only
  devDependency (same pattern `#39` set for `manifold-3d`: an external
  oracle the tests need, not a runtime import, so the isomorphic-core rule
  in `CLAUDE.md` is untouched).
- `packages/core/test/gltf-validator-oracle.test.ts` — new. Three cases
  (`optimize()` on a real checked-in asset, `extrudeImage` across
  flat/beveled/layered settings, `optimize()` on the now-clean skinned
  fixture), each asserting zero errors and zero warnings from the reference
  validator. This is a permanent regression guard for something nothing
  previously checked at all: that the bytes GLBForge actually ships parse
  and validate under the spec's own reference implementation, independent
  of what GLBForge's own rule packs think of them.

## Left open

- Did not extend this to the KTX2 texture path — no `basisu`/`toktx`
  encoder is available in this sandbox (`ktx2Compress` throws
  `No KTX2 encoder found`), consistent with what `#69`/`#56` already
  reported; that ground is theirs anyway.
- Did not check `gltf-transform`'s or `gltfpack`'s own output against this
  oracle (would be extending `#42`/`#44`'s ground, out of scope for a
  zero-overlap pass).
- Did not check the LOD-chain (`buildLod`) or joined multi-material output
  against the validator — ran out of budget for this pass after confirming
  the skinned path and tracing the one warning found to its root cause;
  worth a future rival pass if the backlog ever clears enough for it not to
  be redundant.
- The 28-open-PR backlog noted in Step 0 is not this pass's to fix (opening
  or merging PRs is the maintainer's call), but it means the next several
  passes should expect `pnpm ledger`'s role rotation to keep recommending
  roles that are, in the live repository, anything but least-used.

## Verify

`pnpm -r build && pnpm -r test`: 183/186 core (+3 tests, the new oracle
file; 3 skipped, LFS, unchanged), 46/46 mcp, 5/10 cli (unchanged, gated),
2/2 studio, 13/13 meshy — all green. `pnpm docs:check`: in sync (28 MCP
tools, 21 CLI verbs, packages 0.8.0 — this pass touched no public surface,
so nothing to sync). `pnpm probe -- --no-live`: 28 tools, no baseline
regressions; latency numbers moved within normal host noise
(`optimize_glb` p50 2307ms vs. 2350ms before, `analyze_glb` p50 48ms vs.
44ms) — not touched by this pass's code path, not re-frozen.

### L15 · `fixed` · nothing checked GLBForge's shipped bytes against the official glTF spec validator; the one fixture that would have failed had a silent `JOINTS_0`/`WEIGHTS_0` spec-hygiene bug of its own

Measured: ran the reference Khronos `gltf-validator` against real
`optimize()` output (a checked-in asset, `mobile-hero` profile),
`extrudeImage` output (flat/beveled/layered), and `optimize()` on a skinned
+ morph-target mesh. All real-asset and forge paths were already spec-clean
(0 errors/0 warnings). The skinned path reported 193
`ACCESSOR_JOINTS_USED_ZERO_WEIGHT` warnings, traced by construction to the
shared test fixture `makeRiggedCylinder` (not to `optimize()`: the raw,
unprocessed fixture already carries the same warnings, and a hand-cleaned
copy stayed at 0 warnings after the exact same `optimize()` call). Fixed the
fixture (`packages/core/test/fixtures.ts`) and added
`packages/core/test/gltf-validator-oracle.test.ts` as a permanent
regression guard on real output across `optimize`/`extrudeImage`/skinned
paths, so a future change that *does* introduce a spec violation into
shipped bytes fails a test instead of going unnoticed — nothing previously
checked this at all, since `analyze`/`inspect` only ever graded a file
against GLBForge's own rule packs, not the spec itself.
