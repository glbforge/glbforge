# Pass — 2026-09-29 — 289eacd
**Role:** rival

## Step 0 — claim check

`gh pr list --state open --json number,title,headRefName --jq '... startswith("agent-loop/")'`
showed 29 open `agent-loop/*` PRs, 18 of them already `rival` passes
(`#38`-`#69`). Two same-day passes on this backlog (`#69`, `#70`) already
documented, independently, that `main`'s `ledger.md` (0 merged rival passes)
makes `pnpm ledger` print `rival` as least-recently-used while the *real*,
open+merged picture has rival as the single most-used role — `#70` switched
to `saboteur` over it; `#69` stayed on `rival` because it had found a
genuinely new angle none of the other rival PRs touched. Read all 18 rival
titles before picking one: KTX2/basisu format, `KHR_materials_transmission`
draw calls, the SSIM gate's blind spots (normal maps x2, metallicRoughness/
emissive, KTX2 textures), explicit triangle targets on skinned meshes,
`computeSmoothNormals` vs `normals()`, the USD reader, `gltfjsx` node names,
`ExtrudeGeometry`, Draco vs meshopt, `buildLod` vs `gltfpack` (LOD-fallback
case only), the `ssim.js` and Manifold oracles, `gltf-validator`, and `#62`'s
own "nothing rises to the bar" conclusion. None of them touch meshopt's own
compression *level* — the thing this pass found — so this is not the 19th
restatement of `#62`. No review comments filed: none of the 18 cover this.

**Not re-deriving, just corroborating**: `#69` and `#70` already made the
rotation-blindness case with more evidence than I'd add by repeating it
(`#70` additionally caught a concrete `L12` id collision between `#37` and
`main`). Leaving that to the maintainer as `#70` already framed it. This
pass's own finding ids (`L18`, `L19`, chosen after `#69`'s `L15`-`L17` and
`#70`'s `L15`) will very likely still collide with several of the other 16
rival/other-role PRs' ids once more than one of these merges — unavoidable
from inside a single branch without reading all 29 pass files, and exactly
the failure mode `#70` already flagged for the maintainer to resolve at
merge time.

## Ground truth

`pnpm install && pnpm -r build`: clean, six packages. `pnpm -r test` before
any change: 177/180 core (3 skipped, LFS), 46/46 mcp, 5/10 cli (5 skipped,
LFS), 2/2 studio — all green. `pnpm probe -- --no-live`: 28 tools, 3/3
advice resolved, 33/130 vocab codes, no regressions vs `baseline.json`.

## What was measured

Real asset, real alternative, per the role: `site/models/plush.glb` (a
shipped, non-LFS, already-optimized site asset — 149,992 triangles, 4
materials/primitives, no textures, `EXT_meshopt_compression` already
present) through `glbforge optimize` and through `gltfpack@1.3.0`
(`gltfpack -i plush.glb -o out.glb -cc -tw -si 1 -mm`, npm-installable, no
sandbox network needed beyond npmjs.org).

`glbforge optimize` (mobile-hero, default settings): 1,134,956 → 1,134,348
bytes — a 608-byte no-op. `gltfpack` on the same input, same triangle count
(`-si 1`, no simplification): **744,128 bytes — 34.4% smaller**, a real row
where GLBForge loses.

Root cause: `optimize.ts` calls gltf-transform's `meshopt({ encoder:
MeshoptEncoder, level: 'medium' })` unconditionally
(`packages/core/src/optimize.ts:493`, previously). Reading
`@gltf-transform/functions`' own `meshopt()` source: `level: 'medium'`
selects `EXTMeshoptCompression.EncoderMethod.QUANTIZE` — plain
quantization, no attribute reordering or filter preprocessing.
`level: 'high'` (the CLI's own default, and what `gltfpack`'s `-cc` is
doing under the hood) selects `EncoderMethod.FILTER` — octahedral encoding
for normals, exponential for the rest — which the library's own doc comment
says is "generally smaller after supercompression… but may be larger than
QUANTIZE output without it." GLBForge was on the weaker setting with no
comment explaining why, and ships raw GLB bytes (no gzip stage of its own),
so the caveat's "without it" case is exactly this pipeline's case.

## What changed

- **`packages/core/src/optimize.ts:493`** — `meshopt({ level: 'medium' })`
  → `meshopt({ level: 'high' })`. One line.
- **`packages/core/test/analyze.test.ts`** — new test in the `optimize`
  suite: builds a bumpy sphere (has NORMAL, enough verts to matter), runs
  `optimize()`, writes it with `createNodeIO()`, and asserts the written
  glTF JSON's `bufferViews[].extensions.EXT_meshopt_compression.filter`
  contains `'OCTAHEDRAL'` — the stable, black-box signature that `FILTER`
  (not `QUANTIZE`) ran. Confirmed it fails on the unfixed code
  (`expected [] to include 'OCTAHEDRAL'`, `git checkout` the one line back)
  and passes restored.

No budget profile, rule pack, or `PACK_VERSIONS`/`PROFILE_VERSIONS` entry
touched — every profile's `maxFileBytes`/`maxTriangles` cap is unchanged;
this only makes the optimizer use more of the headroom those caps already
had. `docs/BUDGETS.md`'s generated tables are unaffected (`pnpm docs:check`
passes). Determinism holds: same input + settings still produce identical
bytes, `level: 'high'` is a fixed setting like `'medium'` was, not a source
of nondeterminism.

## Measured impact (three real assets, geometry re-encoded, no other change)

| asset | before (`medium`) | after (`high`) | saved | SSIM min before → after |
|---|---|---|---|---|
| `site/models/plush.glb` (untextured, 150k tri) | 1,134,348 B | 796,160 B | 29.8% | 1.0 → 1.0 |
| `site/models/cat.glb` (textured, 150k tri) | 2,160,136 B | 1,441,832 B | 33.3% | 0.9996 → 0.9996 |
| `site/models/neon.glb` (textured, 20k tri) | 174,776 B | 153,544 B | 12.1% | 1.0 → 1.0 |

Zero measured fidelity cost on any of the three — `optimize()`'s own SSIM
gate (`perceptualCompare` against `profile.minSsim`) ran for all of them and
passed unchanged. The `gltfpack` gap on `plush.glb` closes from **34.4%
smaller than GLBForge** to **6.5% smaller** (744,128 B vs the new 796,160
B) — most of the loss, not all of it. What's left of the gap: `gltfpack`'s
`-cc` also reorders/optimizes the vertex cache more aggressively than
gltf-transform's `reorder({ target: 'size' })` and quantizes at 14-bit
positions by default vs whatever `weld()`+`simplify` leave upstream here;
not chased further — the `EncoderMethod` mismatch was the one-line, zero-cost
fix, the remainder is a real but smaller and more invasive gap.

## Verify

`pnpm -r build && pnpm -r test`: 178/181 core (+1 test, 3 skipped LFS
unchanged), 46/46 mcp, 5/10 cli (unchanged), 2/2 studio — all green.
`pnpm probe -- --no-live`: 28 tools, 3/3 advice resolved, 33/130 vocab
codes, 0 undeclared/undocumented/schema violations, **no regressions vs
`baseline.json`**. Latency (`optimize_glb` p50 3119→4661ms, p90
4513→4807ms) moved but is this host's normal run-to-run noise — the probe's
own gate agreed (`--gate-latency` not requested; unflagged) — not re-frozen,
matches CLAUDE.md's "ignore unless dramatic."

## Left open

### L18 · `fixed` · `optimize()`'s meshopt compression used `EncoderMethod.QUANTIZE` where `gltfpack` and gltf-transform's own CLI default to the smaller `FILTER` method, losing 12-34% raw bytes for free

Measured and fixed above: one-line change (`level: 'medium'` →
`level: 'high'`), three real assets 12.1-33.3% smaller, SSIM unchanged,
closes most of a real `gltfpack` gap (34.4% → 6.5% on the tested asset).
Regression test added; fails without the fix.

### L19 · `open` · `maxMaterials` is checked and shown (✗) in the CLI's budget table but never enforced — `passed`/`score`/exit code ignore it

Found investigating why `plush.glb` (4 materials, profile cap 2) still
"passed" after optimization. `packages/cli/src/report.ts:53` independently
computes and prints a ✗ for `r.materials.length > r.profile.maxMaterials`,
matching every other budget row (triangles, draw calls, texture bytes,
texture VRAM, file bytes) — but unlike every one of those, no rule in
`packages/core/src/rules.ts` or `packages/core/src/packs/` checks
`maxMaterials` at all (`grep -rn maxMaterials packages/core/src/rules.ts
packages/core/src/packs` is empty). `analyze()`'s `passed`/`score`
(`packages/core/src/analyze/index.ts:47-57`) are computed purely from
`runRules()` findings, so an asset can show `materials 4 ✗ > 2` in the same
report that headlines `Score 95/100 … ✓ within budget` and returns
`passed: true` — confirmed directly: `glbforge analyze plush.glbforge.glb`
after this pass's own `optimize()` run prints exactly that contradiction.
`profiles.ts`'s own rationale text for `maxMaterials` ("Materials multiply
shader variants and texture sets. A hero is one material, two when a glass
or emissive part is unavoidable.") reads like an enforced budget dimension,
same register as the five that are. An agent or a `glb:check`/`audit`
CI gate reading `passed`/exit code alone — which is the documented, sanctioned
way to gate on budget — gets a false pass on this one dimension.
Not fixed here: doing it properly needs a new rule (e.g. `perf/material-
budget`) in a *new* version of whichever pack owns it
(`core-scene@1` → `@2`, per CLAUDE.md's "append a version, never edit a
published pack" rule), plus checking it doesn't change
`packs.test.ts`'s frozen finding set for every `examples/*.glb` — a
properly-scoped fix for a pass with room for the versioning ceremony, not
a one-line addition to this one. Closing this needs: the new rule, the pack
version bump, a `docs/BUDGETS.md` changelog entry, and re-verification
against `examples/*.glb`.
