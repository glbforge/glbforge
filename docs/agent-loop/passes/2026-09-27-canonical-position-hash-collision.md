# Pass — 2026-09-27 — bcab2a4
**Role:** performance

## Step 0 — claim check, and a role swap

`gh pr list --state open` (via the GitHub MCP tools; no `gh` CLI in this
sandbox) returned 20 open `agent-loop/`-prefixed PRs. Counting by the role
each declares: **rival — 12** (`#28`, `#38`, `#39`, `#40`, `#42`, `#44`,
`#45`, `#46`, `#51`, `#52`, `#53`, `#54`), integrator 2 (`#29`, `#43`),
saboteur 1 (`#37`), newcomer 1 (`#32`), newcomer-to-new-code 1 (`#34`),
archaeologist 1 (`#31`), performance 1 (`#30`).

`pnpm ledger` still prints **rival** as least-recently-used, because
`main`'s ledger only sees merged passes and none of the twelve rival PRs
above are merged — the same blind spot `#43`'s (unmerged) `L39` already
documents. Taking rival again here would make it 13 open, unreviewed rival
passes against 1–2 for every other role — exactly the staleness the
rotation exists to prevent, just showing up as an unmerged backlog instead
of ledger history. `#52`'s own pass file made the same call for the same
reason at 8 open rival PRs; the backlog has only grown since. Skipped rival.

Read the ledger's next rung, **integrator**, but it already carries 2 open
PRs against every other untouched role's 0–1, so — to keep actually
diversifying the angle this loop looks from, not just mechanically walking
the table — took **performance** instead: 0 merged passes, exactly 1 open
PR (`#30`), tied for least-covered with `archaeologist`. `#30` is itself a
performance pass, still open, so I read it in full before doing anything
else.

## What `#30` (unmerged) already found, and why it's still open ground

`#30` (`agent-loop/2026-09-23-analyze-topology-weld-hash`) replaced
`analyze/geometry.ts`'s string-keyed vertex weld and `Map`-keyed edge count
with a radix sort and an open-addressing hash, 2.5–3.9x faster on real
150k-triangle assets. Its own pass file names a **second, deliberately
unfixed finding** discovered while diagnosing the first: `normals.ts`'s
`canonicalByPosition` — already shipped, not new code — has the identical
low-bit-masking weakness in its hash, at smaller absolute cost because it
only hashes 3 components instead of a full attribute set. `#30` explicitly
left it open ("this pass was already substantial") with the exact fix
named: import the same fmix32 finalizer before masking.

No open PR touches `normals.ts`'s hash. `#52` (rival, computeSmoothNormals
vs. gltf-transform's `normals()`) reads `canonicalByPosition` but only to
compare *shading* output on hard-edged vs. organic meshes — it makes no
source change and never looks at the hash function itself. `#37` (saboteur,
NaN vertex crash) touches `inspect/extent.ts`, a different file. Picked this
up rather than re-deriving a new performance angle, since it's the same
class of bug `#30` already proved out and measured, on a function three
call sites share (`computeSmoothNormals`, `optimize.ts`'s pre-simplify
weld ×2, and `inspect/topology.ts`'s welded-space topology — the function
CLAUDE.md itself times at "~70ms per 150k triangles, ~360ms per 2M").

## Ground truth

```
pnpm install && pnpm -r build   # clean, 6 packages
pnpm -r test                    # 177/180 core (3 skipped, LFS), 46/46 mcp,
                                 # 5/10 cli (5 skipped, LFS), 2/2 studio,
                                 # meshy clean — all green before any change
pnpm probe -- --no-live --json /tmp/probe.json --markdown /tmp/probe.md
```

Probe before: 28 tools, 3/3 advice actions resolved, 33/130 vocab codes,
0 undeclared/undocumented/schema-violating, no regressions vs.
`docs/agent-loop/baseline.json`. Only known item: `L4` (`site/llms.txt`
"0.9.0 line" vs. 0.8.0 packages) — a release call, left untouched.

## What was measured

Reproduced `#30`'s claim directly rather than trusting the unmerged pass
file's numbers. Built a synthetic 220×220 grid (48,400 vertices) whose
positions are quantized integer multiples in a narrow band — the shape a
`KHR_mesh_quantization`-decoded or regularly-tessellated asset produces —
and ran `canonicalByPosition` with an instrumented copy that counts probes:

```
grid 110x110 (12,100 verts): avg probes/lookup = 297.6
grid 220x220 (48,400 verts): avg probes/lookup = 153.5
```

Expected at this table's 0.5 load factor: ~1–2. Root cause is exactly what
`#30` diagnosed for its own hash: `Math.imul` mod 2^32 only mixes each
output bit from input bits at or below it, so XORing three products and
masking the *low* bits into a bucket index only works when the inputs are
already high-entropy in their low bits. A quantized position's float32 bit
pattern isn't — every vertex in a structured region collapses toward the
same handful of buckets.

Then measured on **real, non-LFS, checked-in assets** — not just the
synthetic grid — comparing the shipped hash against the same hash with a
MurmurHash3 finalizer (fmix32) added before the mask, timing
`canonicalByPosition` directly (8 warm runs, median):

| asset | vertices | before | after | speedup |
|---|---:|---:|---:|---:|
| `site/models/cat.glb` | 94,539 | 20.37ms | 3.41ms | 5.96x |
| `site/models/plush.glb` | 37,741 | 6.44ms | 0.57ms | 11.3x |
| `assets/sample-ring.glb` | 1,536 | 0.19ms | 0.02ms | 8.48x |

All three are real GLBForge-adjacent assets (not hand-picked pathological
cases), confirming this isn't only a synthetic-fixture problem — real
exported geometry has enough positional regularity to hit the same
clustering `#30` measured for its own (different) hash.

## What changed

`packages/core/src/normals.ts`'s `canonicalByPosition`: added the same
fmix32 finalizer (`h ^= h>>>16; h = imul(h, 0x85ebca6b); h ^= h>>>13; h =
imul(h, 0xc2b2ae35); h ^= h>>>16;`) between the existing spatial-hash
combination and the `h &= mask` step — the identical sequence `#30`'s
(unmerged) `analyze/geometry.ts` fix uses, so a hash collision still always
falls through to the existing full-component equality check and can only
ever be slower than correct, never wrong. No change to the function's
signature, its three call sites (`normals.ts`'s own `computeSmoothNormals`,
`optimize.ts:172,574`, `inspect/topology.ts:68`), or its output — same
canonical index for the same input, just found through fewer probes.

Verified the fix directly (not just via the timing table, which could pass
by coincidence): re-ran the instrumented probe-counter with the finalizer
added —

```
grid 110x110 (12,100 verts): avg probes/lookup = 1.70
grid 220x220 (48,400 verts): avg probes/lookup = 1.71
```

— landing exactly in the expected ~1–2 range.

New test `packages/core/test/normals.test.ts` (2 cases, correctness only,
no latency assertion — matching the convention `#30`'s own new test and
`inspect/topology.ts`'s existing "large index space" case both already use,
since a tight ms bound in CI measures runner noise, not the algorithm):

1. A 48,400-vertex quantized grid where every `(x, y)` is unique by
   construction — asserts zero false welds despite heavy bucket collision
   (a hash bug reporting a false match would collapse some of these; a
   broken probe sequence would hang the test runner).
2. The same grid duplicated once — asserts every vertex in the second copy
   welds onto its counterpart in the first, so real duplicates are still
   found correctly under collision, not just correctly *not* found.

Both cases pass identically before and after this change (the bug was pure
performance, not correctness — the old hash never returned a wrong answer,
only a slow one), which is why they're framed as a permanent regression
guard on the collision-heavy path rather than as a red-before/green-after
pair; the measured speedup above is the actual evidence for the fix.

## Verify

`pnpm -r build && pnpm -r test`: 179/182 core (+2 tests, 3 skips unchanged),
46/46 mcp, 5/10 cli (unchanged), 2/2 studio, meshy clean — all green,
including `test/packs.test.ts`'s 27 frozen finding-set cases (topology
output is byte-identical; only the bucket-probing order inside the hash
table changed) and `test/usdz.test.ts`/`test/usd-skel.test.ts` (geometry
feeding USD export is unchanged in value, only faster to weld). Did not run
the opt-in Pixar oracle (`GLBFORGE_PXR_PYTHON`) — no venv set up in this
session, and unlike `#30`'s change (which restructured edge-counting
output shape), this change cannot alter USD output: `canonicalByPosition`'s
contract (first-occurrence-wins canonical index for exact-duplicate
positions) is identical before and after, verified above, so anything
downstream that consumes its output is unaffected in value.

`pnpm probe -- --no-live --json /tmp/probe-after.json`:

```
optimize_glb    2352/2873 → 2083/2953 ms (p50/p90)
compare_glb      331/701  →  305/652
analyze_glb       36/349  →   37/277
inspect_report      3/205 →     4/208
audit_directory  104/115  →   84/95
diff                5/62  →     6/62
inspect             8/61  →     8/50
inspect_all         4/49  →     5/49
```

No regressions vs. `baseline.json` either run. The probe's own fixtures are
too small (a handful of primitives) to show this fix clearly — consistent
with `#30`'s own note that its topology win "shows up... even on the
probe's own (much smaller) fixtures" only marginally; the real evidence is
the direct-call table above on `site/models/*.glb`. No `baseline.json`
re-freeze: nothing moved outside normal host noise.

## Finding id

Checked the highest `### L<n>` heading across every open `agent-loop/` PR's
pass file, not just `main` (per `#43`'s unmerged `SKILL.md`/`README.md`
guidance, which is sound even though it hasn't merged): most open passes
independently claimed `L12`, `L13`, `L15`, or `L16` (several times over —
main's ledger only ever shows the next free id as of whichever `main`
commit each branched from, and most branched from the same one), but `#54`
(`2026-09-27-rival-skinned-lock-floor`) already noticed this and jumped to
`L60` for exactly that reason. Starting this one at **L70** to clear `#54`
with margin for whatever else lands first.

### L70 · `fixed` · `canonicalByPosition` (normals.ts) had the same low-bit-masking hash weakness `#30` found and fixed in `analyze/geometry.ts`

Measured: `packages/core/src/normals.ts`'s `canonicalByPosition` masked its
spatial hash's low bits directly into a bucket index with no finalizer,
averaging ~150–300 probes per lookup (expected ~1–2) on a synthetic
quantized grid, and running 6–11x slower than necessary on three real,
non-LFS assets (`site/models/cat.glb`, `site/models/plush.glb`,
`assets/sample-ring.glb`) — this function backs `computeSmoothNormals`,
`optimize()`'s pre-simplify weld (two call sites), and
`inspect/topology.ts`'s welded-space topology, the path CLAUDE.md itself
documents a latency budget for. Fixed by adding the same MurmurHash3
(fmix32) finalizer `#30` used for its own, unrelated hash in
`analyze/geometry.ts`, verified to restore ~1.7 avg probes/lookup and
5.96–11.3x faster real-asset timing, with output value unchanged (confirmed
via the full existing suite, particularly `test/packs.test.ts`'s 27 frozen
finding-set cases) plus two new correctness-under-collision tests in
`packages/core/test/normals.test.ts`. No `baseline.json` change — probe
reported no regressions on either side, and its own fixtures are too small
to show the effect (the real numbers are the direct-call table above).

## Left open

- `L4` (release-line drift) — untouched, a release call.
- The twelve open rival PRs and the id-collision hazard they (along with
  several other roles) have already produced across `L12`/`L13`/`L15`/`L16`
  is not this pass's to fix — `#43`'s `L39` already covers the mechanism,
  and reconciling seven-plus colliding headings is a merge-time job for
  whoever lands the backlog, per that pass's own note.
- Did not look for the same hash weakness anywhere else in the codebase
  beyond `analyze/geometry.ts` (already fixed by `#30`) and `normals.ts`
  (fixed here) — `inspect/topology.ts`'s edge-incidence hashing already
  uses a radix sort, not a spatial hash, so it isn't exposed to this
  specific failure mode; didn't audit every other `Math.imul`-based hash in
  the codebase for the same low-bit-masking pattern, which would be a
  reasonable next `performance` or `archaeologist` pass.
