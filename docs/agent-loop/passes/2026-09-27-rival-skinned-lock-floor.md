# Pass — 2026-09-27 — bcab2a4
**Role:** rival

## Step 0 — claim check

`gh pr list --state open` (filtered to `agent-loop/*`) showed nineteen open passes. Ten already claim
**rival**: `#28` (gltf-transform/gltfpack vs. `optimize()` on size/wall-clock), `#38` (Khronos
`gltf-validator` vs. spec conformance), `#39` (`manifold-3d` vs. `export_stl` watertightness),
`#40` (`ssim.js` vs. the SSIM math itself), `#42` (`gltfpack -si` vs. `buildLod`'s cluster fallback
on **static** geometry), `#44` (Draco vs. meshopt), `#45` (three.js `ExtrudeGeometry` vs.
`extrude_image` curve fidelity), `#46` (`gltfjsx` vs. `scaffold` node addressability), `#51`
(Pixar `pxr` vs. `toUsdz()`'s own summary), `#52` (gltf-transform's `normals()` vs.
`computeSmoothNormals()`), `#53` (SSIM blind spot on normal-map quality). Read all eleven bodies in
full. `#42` is the closest neighbor — it compares GLBForge's decimation fidelity against
`gltfpack` — but it explicitly scoped itself to **static, non-manifold geometry** (the forge's
cluster fallback) and never touches a **skinned** primitive, which goes through a completely
different code path (`skinning.ts`'s `simplifyDeformingPrimitive`, not `buildLod`). That path,
and rigged/animated content generally, is untouched by any open PR. This pass picks it.

`pnpm ledger` still prints `rival` as least-recently-used (main's ledger can't see the ten
unmerged rival passes — a known gap, `#38`'s `L32`/`#43`'s `L39`). Per `#43`'s already-open fix to
`SKILL.md` (unmerged, but read it), the next finding id should be higher than the highest id used
by *any* open pass, not just `main`. Highest seen across all eleven rival bodies plus `#30`'s `L13`
and `#43`'s `L39`: `L39`. This pass's finding starts at **L60** to leave headroom for whatever
merges before it does.

## Ground truth

`pnpm install && pnpm -r build`: clean, 6 packages. `pnpm -r test` before any change: 177/180 core
(3 skipped, LFS), 46/46 mcp, 5/10 cli (5 skipped, LFS), 2/2 studio, 13/13 meshy — all green.
`pnpm probe -- --no-live`: 28 tools, no regressions vs. `baseline.json`. Only known open item: `L4`
(`site/llms.txt`'s 0.9.0 line), a release call, left alone.

## What was measured

Built a synthetic two-joint rigged cylinder (60 rings × 90 segments, 5,400 vertices, 10,620
triangles, one morph target — same construction as `test/fixtures.ts`'s `makeRiggedCylinder`,
scaled up so decimation has real work to do) and ran it through two simplifiers targeting the same
triangle count:

- **GLBForge**: `glbforge optimize --target N` (bone-aware, `skinning.ts`).
- **Rival**: `gltfpack@1.2.0 -si <ratio> -sa` (meshoptimizer's own CLI, aggressive mode, skin data
  preserved — confirmed by its own report: `buffers: ... skin 128 bytes`).

At a moderate ratio (1,500 / 10,620 ≈ 14%), matched almost exactly (gltfpack landed at 1,499),
`alignmentScore` (this repo's own chamfer/F-score harness, `harness/align.ts`, run against the
un-simplified mesh as ground truth) shows **GLBForge winning**:

| method | chamfer | f-score@1% | f-score@2% |
|---|---:|---:|---:|
| GLBForge (bone-aware) | **0.00354** | **0.9930** | **0.9983** |
| gltfpack (`-si -sa`) | 0.00513 | 0.9898 | 0.9953 |

Pushed to an extreme target (300 triangles, ≈2.8%) to look for the loss `#42` found in the static
cluster fallback. Found something different and more interesting: **GLBForge doesn't lose the
fidelity contest — it silently fails to reach the target at all.**

```
GLBForge  --target 300  →  552 triangles delivered (84% over), boundBy: null, no warning
gltfpack  -si 0.02825 -sa →  245 triangles delivered (under target, as asked)
```

Root-caused with a direct call to `simplifyDeformingPrimitive` at escalating error tolerance —
0.1 (the optimizer's own ladder max), 0.3, 1, 10, 1000:

```
error=0.1:  trianglesAfter=556, lockedVertices=180
error=0.3:  trianglesAfter=544, lockedVertices=180
error=1:    trianglesAfter=544, lockedVertices=180
error=10:   trianglesAfter=544, lockedVertices=180
error=1000: trianglesAfter=544, lockedVertices=180
```

The count stops moving entirely past `error=0.3`, at any tolerance. `skinning.ts` locks every
vertex on the ring where the dominant joint changes (correctly — that's what stops a collapse from
shearing the rig, `CLAUDE.md`'s own invariant), but meshoptimizer's `simplifyWithAttributes`
cannot collapse a locked vertex under any error budget. For a mesh with one boundary ring, that's a
hard floor on triangle count that no amount of looser tolerance crosses — and `optimize()`'s error
ladder (`LADDER = [0.001, 0.01, 0.05, 0.1]`, `optimize.ts`) tops out at 0.1 regardless, so it never
even gets close to that floor before giving up.

Reproduced the same shape on the existing, smaller `makeRiggedCylinder()` fixture already in the
test suite (no custom asset needed for the regression test):

```
target=600: after=600  boundBy=budget
target=300: after=300  boundBy=budget
target=150: after=206  boundBy=null   (37% over, no signal)
target=50:  after=208  boundBy=null   (4.2x over, no signal)
target=20:  after=208  boundBy=null   (10.4x over, no signal)
```

`boundBy` stays `null` in every miss — its own doc comment already conceded this case
("no simplification was needed, or it ran out of rungs") without ever distinguishing "ran out of
rungs because it hit a diagnosable structural floor" from "ran out of rungs for no known reason."
Nothing in `steps`, `findings`, or the CLI's `printDiff` says a target was missed, because the
*profile's* triangle budget (150,000 for `mobile-hero`) is a completely different number from the
caller's explicit `--target`/`targetTriangles`, and only the former is checked against `analyze()`'s
pass/fail. An agent scripting `--target` for an animated character's LOD chain gets a green
"✓ within budget" verdict on an asset that missed the actual ask by up to 10x, with no code path
that would ever tell it.

### L60 · `fixed` · `optimize()`'s explicit triangle target can silently miss by 10x on skinned meshes

`packages/core/src/optimize.ts`:
- `OptimizeSummary.boundBy` gains a third state, `'locked'`, documented alongside the existing
  `'budget'`/`'fidelity'` states.
- `simplifyDeformingPrimitive`'s return value (previously discarded — the call site never read it)
  is now used: `lockedVertices` from the final ladder rung is tracked.
- After the ladder exhausts every rung and the asset is still over target, if a deforming
  primitive's locked vertices were the reason (locks were active in the final rung), `boundBy` is
  set to `'locked'` and a `steps` entry names the exact shortfall and cause — visible in both the
  CLI's human output (the steps header) and `--json`/MCP output (`summary.steps`,
  `summary.boundBy`) without any new field to thread through.

`packages/cli/src/report.ts`: widened the `boundBy` parameter type and added a yellow callout for
`boundBy === 'locked'`, mirroring the existing `fidelityLostAt === 'textures'` callout, so a human
running the CLI sees the miss even if they don't read the steps line.

New test in `packages/core/test/skinning.test.ts`: reproduces the exact scenario above on the
existing `makeRiggedCylinder()` fixture (`targetTriangles: 20` against a mesh whose lock floor sits
around 208), asserts `trianglesAfter > 20`, `boundBy === 'locked'`, and a `steps` entry mentioning
the stop. Confirmed red against the pre-fix `optimize.ts` (stashed just that file): `boundBy` came
back `null` instead of `'locked'`. Restored the fix, reran — green.

No change to `profiles.ts`, any rule pack, or `verifyRig()`. `boundBy` is a return-value union, not
a versioned budget/pack contract — the new variant is additive; existing `boundBy === 'fidelity'`/
`'budget'` checks anywhere downstream are unaffected.

## Verify

`pnpm -r build && pnpm -r test`: 178/181 core (+1 test, 3 skipped LFS unchanged), 46/46 mcp, 5/10
cli (unchanged), 2/2 studio, 13/13 meshy — all green. Rebuilt the MCP schemas (`emit-schemas.ts`,
unchanged — `boundBy` isn't part of any tool's Zod output schema, only the CLI's human/JSON
rendering) and the Studio (`pnpm --filter @glbforge/studio build`, isomorphic-core rule).
`pnpm docs:check`: clean, no new tool/verb/public claim (28 MCP tools, 21 CLI verbs, packages
0.8.0). `pnpm probe -- --no-live`, before → after:

```
optimize_glb    2014/3368 → 2279/3462 ms (p50/p90)
compare_glb      403/852  →  395/856
analyze_glb       48/489  →   46/423
inspect_report      4/287 →     4/282
audit_directory  123/128  →  120/130
diff                6/66  →    10/71
inspect             8/69  →     9/65
inspect_all         5/65  →     5/54
```

No regressions vs. baseline either run; deltas are normal host noise (this sandbox isn't the
committed baseline host). `baseline.json` untouched — nothing moved.

## Left open

- Only the specific, diagnosed mechanism (deforming-primitive joint-boundary locks) is labeled
  `'locked'`. A non-deforming primitive that plateaus against `LockBorder` for an unrelated reason
  still reports `boundBy: null` with no explanation — a real gap, but a different, unmeasured
  mechanism; not claimed as fixed here.
- Didn't raise the `LADDER`'s max error (0.1) or otherwise try to make bone-aware simplification
  reach further past the lock floor — the diagnostic above shows more error tolerance stops
  helping past ~0.3 regardless, so raising it wouldn't close the gap; the actual fix for "reach a
  lower triangle count on a heavily-jointed rig" is a real feature (unlocking interior-ring
  vertices with a smaller collapse budget, or accepting a rendering artifact) that needs a
  maintainer call on the tradeoff, not a silent-failure fix.
- Did not chase whether the same "ladder plateaus, `boundBy` stays `null`, nothing said" pattern
  also affects `buildLod`'s cluster fallback (`#42`'s ground) at extreme ratios — different code
  path, not measured here.
- `L4` (`site/llms.txt` version line) untouched, per standing instruction.
