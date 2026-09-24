# Pass — 2026-09-23 — b59f0d2

**Role:** performance

## Step 0 — claim check

`gh pr list --state open` showed three `agent-loop/*` PRs: #20 (companion
reply-id, `newcomer-to-new-code`), #28 (rival: gltf-transform/gltfpack vs
`optimize()`), #29 (integrator: `glbforge scaffold`'s build/install path).
None touch `analyze/geometry.ts` or the topology hash path this pass ends up
in — clear ground.

## Role

`pnpm ledger` printed **rival** as least-recently-used. Rival is exactly what
PR #28 already is (open, unmerged) — repeating it would be the collision the
skill warns about. The next rung, **integrator**, is exactly what #29 already
is. Skipping two rungs in one pass is unusual, so it's worth being explicit:
this isn't reaching for an easier role, it's the same "already claimed, take
the next one down" rule the skill states, applied twice because both of the
next two rungs are claimed on the same day. **performance** is next
(0 passes, tied with `archaeologist`, alphabetically/table-order first) and
did run in this sandbox — the non-LFS `site/models/*.glb` fixtures
(`cat.glb`/`plush.glb`, ~150k triangles each; `neon.glb`, ~20k) are real
GLBForge output, large enough to profile honestly, so there was no need to
fall back further.

## Ground truth

```
pnpm install && pnpm -r build   # clean
pnpm -r test                    # 174/177 core (3 LFS-skip), 44/44 mcp, 2/2 studio,
                                 # 5/10 cli (5 gated-skip), 13/13 meshy — all green
pnpm probe -- --no-live         # no regressions vs baseline.json
```

## What was measured

ROLES.md frames this role around `inspect` — "the call you make after every
edit" — so I profiled it on real, non-LFS assets instead of the probe's tiny
synthetic fixtures, which are too small to show anything. Built a small
harness that imports `@glbforge/core`'s built `analyzeGeometry` directly and
times it warm (JIT-settled) against `site/models/cat.glb` (94,539 verts,
150k tri, 4 attribute semantics), `plush.glb` (150k tri, 2 semantics), and
`neon.glb` (~20k tri across 3 primitives, 2 semantics).

`analyze/geometry.ts`'s `computeTopology` — which backs `analyze()`,
`analyze_glb`, `analyze_performance`, `optimize()`'s bake-instances check,
and the CLI's `analyze` command — turned out to be a **second,
independently-slower implementation of a problem the codebase already
solved once**. `inspect/topology.ts` (shared by rule packs and
`inspectGeometry`) already replaced its own `Map`-keyed edge count with an
LSD radix sort, and `normals.ts`'s `canonicalByPosition` already replaced a
string-keyed vertex weld with open addressing — both documented in their own
files as measured wins. `analyze/geometry.ts` never got either change: it
still built a `'x|y|z'` string per vertex for the position weld, a second,
longer string per vertex (every attribute component concatenated) for the
redundant-vertex weld, and a `Map<number, number>` for edge incidence.
Measured on `cat.glb`, `analyzeGeometry(topology: true)` cost **~368ms
median** (10 warm runs) — `plush.glb` ~221ms, `neon.glb` ~32ms.

## What changed

Two changes, same shape as the fixes already shipped elsewhere in this file:

1. **Edge incidence** now reuses `inspect/topology.ts`'s radix sort directly
   (exported `sortPairs`, previously module-private) instead of a
   `Map<number, number>` keyed on the packed (min, max) pair.
2. **Vertex welding** (both the position-only key and the all-attribute key)
   now goes through a new `canonicalByAttributes` — open addressing over a
   combined per-component hash, generalizing `canonicalByPosition`'s
   3-fixed-axis technique to an arbitrary attribute list. A hash collision
   always falls through to a full raw-value equality check, so it can only
   ever be slower than the string-key version, never wrong — confirmed by
   `test/packs.test.ts`'s 27 frozen-finding-set cases passing unchanged.

**Found and fixed inside this same pass, before it shipped:** the first
version of `canonicalByAttributes` combined per-component hashes as
`h = imul(h ^ v, CONST)`, chained sequentially. On `neon.glb` specifically —
many vertices sharing one of a handful of exact `NORMAL` values, positions
all in a narrow magnitude band — this was *slower* than the string keys it
replaced (32ms → 44ms), the opposite of the intended fix. Diagnosed by
counting hash-table probes directly: **~100–150 average probes per lookup**
against an expected ~1–2 at this table's 0.5 load factor. Root cause:
multiplication mod 2^32 only mixes each output bit from input bits at or
below it, so masking the *low* bits of an XOR-of-products into a bucket
index only works when the inputs are already high-entropy in their low
bits — and float32 bit patterns of small integers (quantized attributes,
the common case for an optimized or Meshy-exported GLB) are not. Fixed by
running a MurmurHash3 finalizer (fmix32) over the combined hash before
masking, which spreads entropy from every input bit across all 32 output
bits regardless of where it started. Verified directly: avg probes on the
same asset dropped from ~100 to ~1.3.

## Numbers (10 warm runs each, median; direct `analyzeGeometry` calls, not the probe's tiny fixtures)

| asset | before | after | speedup |
|---|---|---|---|
| `cat.glb` (150k tri, 4 attrs) | 368ms | 95ms | 3.9x |
| `plush.glb` (150k tri, 2 attrs) | 221ms | 77ms | 2.9x |
| `neon.glb` (20k tri, 2 attrs) | 32ms | 13ms | 2.5x |

Probe (`pnpm probe -- --no-live`), before → after:

| tool | p50 before → after | p90 before → after |
|---|---|---|
| `optimize_glb` | 2242 → 1670 | 3117 → 2351 |
| `compare_glb` | 364 → 292 | 757 → 769 |
| `analyze_glb` | 40 → 38 | 444 → 234 |

`optimize_glb` and `analyze_glb` both call into `analyzeGeometry`; the
improvement shows up even on the probe's own (much smaller) fixtures.
`compare_glb`'s p90 is within noise (it doesn't call this path directly —
verified by checking its call chain, not assumed). The probe reported **no
regressions vs `baseline.json`**, so no re-freeze.

## Tests

`packages/core/test/analyze-topology-hash.test.ts` (new, 2 tests):

- An exact-value case (hand-built triangles with known duplicate/degenerate/
  boundary structure) — pins `computeTopology`'s semantics independent of
  implementation, the same thing `test/packs.test.ts`'s 27 cases already
  cover for the pipeline's own output but explicit and minimal here.
- A 48,400-vertex synthetic grid reproducing the exact shape that broke the
  pre-finalizer hash (repeated exact `NORMAL` values, narrow-band integer
  positions) — asserts the weld still reports **zero** false duplicates
  under heavy bucket collision. Deliberately **not** a latency assertion:
  `inspect/topology.ts`'s own "large index space" test
  (`test/packs.test.ts`) follows the same correctness-only convention for
  the same reason — a tight ms bound in CI measures runner noise, not the
  algorithm. The real numbers are in the table above, measured directly,
  not asserted in a test that would be flaky either too loose to catch
  anything or too tight to survive a slow runner.

Full suite after: 176/179 core (+2 tests, 3 LFS-skip unchanged), 44/44 mcp,
2/2 studio, 5/10 cli (unchanged), 13/13 meshy. `pnpm probe -- --gate
--no-live` passes. Ran the CI workflow's remaining steps locally too:
`node scripts/ledger.mjs --check`, the extrude→analyze dogfood, and the
`ship` dogfood (both ci-ring.png and ci-badge.png) — all pass unchanged.

### L12 · `fixed` · `analyze()`'s topology pass re-solved two problems the codebase had already solved faster elsewhere

`analyze/geometry.ts`'s `computeTopology` built a string key per vertex
(twice — once for the position-only weld, once for the all-attribute weld)
and counted edge incidence in a `Map<number, number>`, instead of reusing
`inspect/topology.ts`'s radix sort and a generalized version of
`normals.ts`'s open-addressing weld. Backs `analyze_glb`,
`analyze_performance`, the CLI's `analyze`, and `optimize()`'s
bake-instances check. Fixed: `canonicalByAttributes` (new, in
`analyze/geometry.ts`) for both welds, `inspect/topology.ts`'s `sortPairs`
exported and reused for edge incidence. ~2.5–3.9x faster on three real,
non-LFS `site/models/*.glb` assets (150k and 20k triangle scale); topology
output verified byte-identical via the full existing suite (particularly
`test/packs.test.ts`'s 27 frozen finding-set cases) plus a new exact-value
test. No baseline.json change — probe reported no regressions, and every
tool's numbers improved or stayed within noise.

### L13 · `open` · the already-shipped `canonicalByPosition` (normals.ts) has the same low-bit-masking weakness this pass fixed in `analyze/geometry.ts`

While diagnosing L12's hash-quality bug, checked whether
`normals.ts`'s `canonicalByPosition` — already in production, backing
`inspect/topology.ts`'s `meshTopology` (packs, `inspectGeometry`) and
`computeSmoothNormals` — has the same failure mode. It does:
`h = (imul(bx, P1) ^ imul(by, P2) ^ imul(bz, P3)) >>> 0; h &= mask;` masks
low bits straight into the bucket index with no finalizer, same as the code
this pass replaced. Reproduced directly (not inferred): a synthetic
quantized-position array (values rounded to integers in a ±32000 range, the
`KHR_mesh_quantization`-decoded case CLAUDE.md's `readFloat()` note exists
for) landed **~100 avg probes/lookup** at both 12,000 and 50,000 vertices,
against ~1–2 expected. Absolute cost stayed small at these sizes (~11ms) —
this function only hashes 3 components (position alone, not L12's
full-attribute case), so the clustering is real but not yet dramatic at the
scales tested here. Not fixed in this pass: `canonicalByPosition` backs
`test/packs.test.ts`'s frozen finding sets and `computeSmoothNormals`
(used throughout `optimize()`), so a change needs the same equivalence
rigor L12 got, and this pass was already substantial. Closing this would be
importing the same fmix32 finalizer this pass added into
`normals.ts`'s hash before the mask, then re-running the full suite +
`test/usd-oracle.py` if touched geometry that feeds USD export.

## Left open

- L13 above.
- Did not attempt to profile the LFS-gated Meshy fixtures (34–93MB,
  2M-triangle scale, where CLAUDE.md's own topology.ts comment cites the
  Map-vs-radix numbers) — not fetched in this sandbox. The three
  `site/models/*.glb` assets used instead are real GLBForge output at a
  meaningful scale (150k triangles), just not the full 2M CLAUDE.md
  documents elsewhere.
- Did not touch `optimize.ts`'s SSIM render pipeline, which dominates
  `optimize_glb`'s wall-clock (~55–70% of total, per a rough breakdown
  during profiling) — that's `verifyRig()`, explicitly frozen in CLAUDE.md;
  changing it is "a deliberate pass of its own," not a side effect of a
  topology fix.
