# Pass — 2026-09-25 — 8b223a6
**Role:** rival

## Step 0 — claim check

`gh pr list --state open` (via the GitHub MCP tools; `gh` itself isn't
available here) showed eleven open PRs. Ten carry `agent-loop/`-prefixed
branches: `#40`/`#39`/`#38`/`#28` **rival** (SSIM-vs-`ssim.js`,
watertightness-vs-Manifold, spec-conformance-vs-`gltf-validator`,
size/speed-vs-`gltfpack`/`gltf-transform`), `#37` saboteur (`NaN` vertex
envelope crash), `#34` newcomer-to-new-code (companion npm `files`), `#32`
newcomer (`extrude --json` alpha leak), `#31` archaeologist (ROADMAP T7),
`#30` performance (`analyze()`'s topology pass), `#29` integrator
(`scaffold`'s build/install path), `#20` (companion reply-id, no role
prefix visible from title). One more, `#41`, is not `agent-loop/`-prefixed
(a CI workflow change) — outside this loop's convention, left untouched.

Read all four rival PRs' pass files in full before picking anything: `#28`
compared file size/wall-clock against `gltf-transform`-CLI and `gltfpack`
with simplification *disabled* (`--simplify false` / `-cc`, geometry-only
compression) specifically to isolate texture/quantization; `#38` compared
spec conformance against the Khronos reference validator; `#39` compared
STL watertightness against `manifold-3d`; `#40` cross-checked the SSIM
*metric itself* against `ssim.js`. None of the four touches simplification
quality — `#28` explicitly turned it off on both sides to keep its
comparison clean. `pnpm ledger` still prints `rival` as least-recently-used
(main's ledger only goes to `L11` and can't see any of the four unmerged
rival passes), so this pass keeps the role and picks the one axis none of
them measured: **does GLBForge's own LOD/decimation step preserve geometric
shape as well as a rival's, at a matched triangle budget?** Zero file or
fixture overlap with any of the four (they touch `optimize.ts`/`render.ts`/
`detect.ts`/new test files only; this pass touches `test/lod.test.ts`).

## Ground truth

`pnpm install && pnpm -r build`: clean, six packages. `pnpm -r test` before
any change: 177/180 core (3 skipped, LFS), 46/46 mcp, 5/10 cli (5 skipped,
LFS), 2/2 studio, all green. `pnpm probe -- --no-live`: 28 tools, 3/3 advice
resolved, 33/130 codes, no regressions vs `baseline.json`. Only known item:
`L4` (`site/llms.txt`'s 0.9.0 line vs 0.8.0 packages) — a release call,
left alone.

## What was measured

Installed `gltfpack@1.2.0` (npm, meshoptimizer's own tool — same rival
`#28` used, but this time with `-si` *enabled*: simplification, not
disabled) in a scratch directory; no other network needed. The metric:
GLBForge's own `alignmentScore` (`harness/align.ts`, exported, already used
by `test/analyze.test.ts`'s alignment-harness test and described in its own
docstring as mirroring "the axes of Meshy's public benchmark") — chamfer
distance and F-score@1%/2%, both symmetric, both deterministic (seeded
sampling, no `Math.random`). Neither GLBForge's optimizer nor `buildLod`
records or tests any geometric-error number today (confirmed by reading
`optimize.ts` and `lod.ts` in full: `simplifyPrimitive`'s meshopt
`resultError` return is read only into a debug log by `@gltf-transform/
functions` and never surfaces into GLBForge's own code; `simplifyDeform
ingPrimitive`'s returned `error` is discarded at its one call site,
`optimize.ts:313`; `LodResult` carries only `{ triangles, target, method,
steps }`). The only fidelity gate anywhere in the pipeline is SSIM,
image-space, from four fixed cameras.

Three real, non-LFS assets, all previously used by `#28`/`#38` (same
starting points, no cherry-picking): `cat.glb`, `plush.glb` (real meshes,
meshopt's ordinary edge-collapse path, no stall), and the same synthetic
layered/stacked forge logo `test/lod.test.ts` already builds and already
confirms goes non-manifold (`nonManifoldEdges > 0` after a full
`optimize()` pass) — the one case that exercises GLBForge's own
grid-clustering fallback (`clusterDecimate`) rather than meshopt.

For each: reduce to the same target triangle count via GLBForge's
`buildLod()` and via `gltfpack -si <ratio> -sp -sa -noq -vpf -vnf`
(`-sp` permissive mode so gltfpack can also cross attribute discontinuities
on the same non-manifold topology; `-sa` so it hits the ratio instead of
stalling short like GLBForge's own meshopt path would without a fallback;
`-noq -vpf -vnf` disable gltfpack's own quantization so the comparison
isn't confounded by unrelated precision loss). Score both against the
pre-simplification mesh with `alignmentScore`.

| asset | target ratio | GLBForge method | tris (GLBForge / gltfpack) | chamfer (GLBForge / gltfpack) | f-score@1% (GLBForge / gltfpack) | f-score@2% |
|---|---|---|---|---|---|---|
| cat.glb | 0.10 | simplify | 14,996 / 14,998 | 0.02201 / 0.02197 | 0.293 / 0.296 | 0.539 / 0.539 |
| plush.glb | 0.10 | simplify | 14,998 / 14,998 | 0.00879 / 0.00848 | 0.760 / 0.764 | 0.889 / 0.895 |
| forge logo | 0.125 | simplify | 18,750 / 18,748 | **0.00495 / 0.00539** | 0.999 / 0.944 | 1.000 / 1.000 |
| forge logo | 0.025 | simplify | 4,026 / 3,596 | 0.01739 / 0.01332 | 0.271 / 0.453 | 0.642 / 0.797 |
| forge logo | 1/150 | **cluster** | 960 / 967 | **0.03037 / 0.01197** | **0.152 / 0.607** | **0.282 / 0.808** |

Both meshopt-vs-meshopt rows (cat.glb, plush.glb — nearly identical
algorithms, expected) are close, GLBForge trailing gltfpack by under 2% of
chamfer on both, and GLBForge actually **wins** at a moderate forge-logo
ratio (0.125, still on the ordinary simplify path). The honest loss is the
last row: once the target is severe enough to force `clusterDecimate`
(triangle counts matched, 960 vs. 967 — not a budget difference), GLBForge
loses by **2.5x on chamfer and 4x on f-score@1%** to a rival simplifier
solving the same non-manifold-topology problem with permissive-mode
edge-collapse instead of grid clustering. This is the loop's own
`clusterDecimate`/`smoothPositions` path — used specifically on the forge's
own characteristic output (stacked layers, doubled shells) — trading shape
fidelity for reliability (it always reaches the target; meshopt does not),
with nothing today recording how much shape it gave up.

## What was fixed

Nothing in `packages/core/src` — the fix is a design call (see below), not
a bug. **Added:** a fourth test to `packages/core/test/lod.test.ts`,
`records how far the cluster-decimate fallback drifts from the source
surface, not just its triangle count`. It builds the same non-manifold
forge asset the existing cluster-fallback test uses, forces a target severe
enough to trigger `clusterDecimate` (confirms `lod.method === 'cluster'`,
same assertion style as the existing test), and asserts `alignmentScore`
against the pre-LOD mesh stays above a floor set from this pass's own
measurement (chamfer < 0.05, f-score@1% > 0.08, f-score@2% > 0.18 — real
margin below the ~0.030 / 0.152 / 0.282 measured here, not a rubber
stamp). No new dependency: `alignmentScore` is already public, already
deterministic (seeded sampling), already exercised by
`test/analyze.test.ts`. `gltfpack` was only used ad hoc in a scratch script
(not committed, not a devDependency) to produce the rival numbers above —
unlike `#39`/`#40`, this pass doesn't need the rival tool present at test
time, since the regression guard only pins GLBForge's own number, not a
head-to-head.

Ran the new test alone and against the full suite; deterministic across
two runs (same chamfer/f-score to the seeded-sampling precision the
existing determinism test already relies on).

### L37 · `open` · `buildLod`'s cluster-fallback path (grid clustering, used specifically on the forge's own non-manifold stacked-layer output) loses 2-4x on geometric fidelity to a rival simplifier at matched triangle budgets, and nothing records this happened

Measured above. `LodResult` reports `{ triangles, target, method, steps }`
— an agent calling `buildLod` and getting `method: 'cluster'` back has no
signal that this specific fallback, at this specific severity, cost it
meaningfully more shape than it would have on a rival tool at the same
triangle count. The information to compute that signal already exists
in-repo (`alignmentScore`/`sampleSurface`/`triangleSoup`, this pass's new
test uses exactly them) — the gap is that `buildLod` never calls it.

**Not fixed here**, deliberately: adding a fidelity number to `LodResult`
means running an extra alignment pass (sampling + nearest-surface-distance,
not free) on every LOD build, including the common case where meshopt
reaches the target cleanly and the number would just confirm "fine" — a
real perf/API-surface tradeoff for the maintainer to weigh, not a
one-line correctness fix, and `LodResult`'s shape is consumed by
`packages/mcp` and the CLI, so widening it is a small but real contract
change. A concrete, scoped starting point for whoever picks this up:
compute `alignmentScore(afterDoc, beforeSnapshot)` inside `buildLod` only
on the `method === 'cluster'` branch (the only path this pass found to be
the problem; the ordinary `simplify` path already wins or nearly ties
above), and surface it as an optional `LodResult.fidelity` field so
existing callers are unaffected. The new test in `lod.test.ts` is the
regression guard either way: if `clusterDecimate` or `smoothPositions`
regress further, this fails first.

## Verify

`pnpm -r build && pnpm -r test`: 178/181 core (+1 test, 3 skipped LFS
unchanged), 46/46 mcp, 5/10 cli (unchanged), 2/2 studio, all green.
`pnpm probe -- --no-live`: no regressions vs `baseline.json`; latency
deltas are normal host noise (a few ms, no systematic direction) — not
re-frozen.

## Left open

- `L37` above, with a scoped next step for whoever has the budget to weigh
  the perf/API-surface tradeoff.
- Didn't chase whether the *ordinary* meshopt path's small, consistent
  trailing gap on cat.glb/plush.glb (both real assets, both under 2% of
  chamfer) is worth investigating — it's small enough on real assets that
  it reads as "different simplifier, similar quality," not a defect; the
  forge-logo win at a moderate ratio (GLBForge *beats* gltfpack there)
  supports that reading rather than a systematic GLBForge weakness.
- Didn't try `gltf-transform` CLI's own `simplify()` — `gltfpack` already
  gave a clean, permissive-mode-capable comparison on the exact topology
  that matters (non-manifold forge output); a second rival on the same
  axis would be diminishing return for this pass's scope.
- `L4` (`site/llms.txt` version line) untouched, per the standing
  instruction.
