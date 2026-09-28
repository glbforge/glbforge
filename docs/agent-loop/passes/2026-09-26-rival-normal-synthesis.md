# Pass — 2026-09-26 — bcab2a4
**Role:** rival

## Step 0 — claim check

`list_pull_requests` (GitHub MCP, `state: open`) returned 19 open PRs with
`agent-loop/`-prefixed branches. Eight are already `rival` passes:
`#51` (Pixar's USD reader vs. `toUsdz()`'s own summary), `#46` (gltfjsx node
naming vs. the scaffold viewer), `#45` (three.js `ExtrudeGeometry` vs.
`extrude_image` curve fidelity), `#44` (Draco vs. meshopt geometry
compression), `#42` (`buildLod`'s cluster fallback vs. gltfpack), `#40`
(optimize()'s SSIM gate vs. the `ssim.js` reference), `#39` (Manifold
watertight oracle vs. GLBForge's own claim), `#38` (GLBForge vs. the Khronos
`gltf-validator`). None of the eight touch **normal synthesis** — every one
compares either geometry compression, LOD/curve fidelity, watertightness,
SSIM math, or spec conformance. Left all eight untouched; did not duplicate.

## Role

`pnpm install && pnpm -r build` then `node scripts/ledger.mjs` printed
**rival** as least-recently-used (main's ledger still shows `rival: never`
because none of the eight open rival PRs above are merged — the rotation
can't see work sitting in unmerged branches, same gap the 2026-09-25 Draco
pass already flagged). Picked an axis none of the eight cover rather than a
variant of one already open.

## Ground truth

- `pnpm install && pnpm -r build`: clean, all six workspace packages build
  (companion excluded per `CLAUDE.md`, separate lockfile).
- `pnpm -r test`: 21 files / 177 passed + 3 skipped (LFS pointers) in core,
  13/13 meshy, 46/46 mcp, 2/2 studio, 5/10 cli (`test/inspect.test.ts`'s 5
  tests self-skip; pre-existing, unrelated to this pass), all green before
  any change.
- `pnpm probe -- --no-live --json /tmp/probe.json --markdown /tmp/probe.md`:
  28 tools, 3/3 advice actions resolved, 33/130 vocab codes exercised, 0
  undeclared/undocumented/schema-violating codes, no regressions vs.
  `docs/agent-loop/baseline.json`. `--no-live` honored (no glbforge.dev
  calls attempted — confirmed by re-running once without the flag first,
  which got the expected sandbox 403s from the allowlist, not a live-site
  finding).

## Rival work: `computeSmoothNormals()` vs. `@gltf-transform/functions`' `normals()`

`packages/core/src/normals.ts` is GLBForge's replacement for
`@gltf-transform/functions`' own `normals()`, used whenever a primitive
arrives with no `NORMAL` attribute — both in `optimize()`
(`packages/core/src/optimize.ts:336-344`, gated on `!prim.getAttribute
('NORMAL')`) and in the renderer's own fallback
(`packages/core/src/harness/render.ts:187`, so it's what an agent's MCP
thumbnail shows too, not just the optimized output). `CLAUDE.md` states the
reason as fact: "Never use gltf-transform's `normals()` — it produces flat
per-face normals. Use `computeSmoothNormals`... shared by the optimizer and
the renderer." True as stated, but "flat is wrong" and "smooth is right"
are not the same claim, and nothing in the code or docs says which meshes
`computeSmoothNormals` is wrong for. Read `packages/core/src/normals.ts` in
full: it accumulates area-weighted face normals per **welded position**
with no crease-angle threshold at all — every vertex is smoothed with every
triangle that touches its position, unconditionally. That is a specific,
testable claim: it will be correct for organic/curved meshes and wrong for
hard-edged ones, because welded hard edges are indistinguishable from
welded smooth regions once the `NORMAL` attribute is gone — the geometry
alone can't say "this corner is a crease."

**Method.** Built two synthetic documents directly with `@gltf-transform/core`
(no LFS fixtures needed, deterministic, reproducible from this file alone):
a unit cube (8 shared corners, 12 triangles, welded — the case with three
mutually perpendicular faces meeting at every vertex) and a UV sphere (12
rings × 16 segments, welded, radius 1 — the case with no true edges at all).
For each shape, built three renders through the project's own harness
(`renderRaw` + `verifyRig`'s 4 fixed cameras + `ssim`, i.e. the exact
machinery `optimize()` uses to gate "no visible loss"):

1. **Ground truth**, computed independently of either normals algorithm —
   for the cube, each face's canonical axis-aligned normal
   (`[±1,0,0]`/`[0,±1,0]`/`[0,0,±1]`), hand-assigned per unwelded corner, no
   trigonometry involved; for the sphere, the analytic radial normal
   (`normalize(position)`) on the same welded topology, so silhouette and
   tessellation match and only shading is being scored.
2. **GLBForge**: the welded doc, `NORMAL` computed by calling
   `computeSmoothNormals()` directly (the same call `optimize.ts` makes).
3. **Rival**: a clone of the same welded doc run through
   `document.transform(normals())` from `@gltf-transform/functions`
   (already a monorepo dependency — no new package installed, no network
   beyond what was already fetched by `pnpm install`).

Scored SSIM of (2) and (3) against (1) on `verifyRig()`'s four cameras
(256px, 2x supersample — smaller than `verifyRig`'s normal 512px only to
keep this a quick synthetic check; the rig geometry itself is untouched).

**Table** (mean SSIM over the 4 `verifyRig` views, ground truth = 1.0 by
construction):

| shape | GLBForge `computeSmoothNormals()` | rival `normals()` (flat, unwelds) |
|---|---:|---:|
| cube (hard edges) | **0.9614** (min view 0.9440) | 1.0000 |
| sphere (smooth, organic) | **0.9981** | 0.9174 (min view 0.9040) |

Both directions, read honestly:

- **Sphere: GLBForge wins by a wide margin**, as the code comment claims.
  0.9981 vs. 0.9174 is not close — the rival's flat per-face shading makes a
  12×16 sphere look like a faceted gem, exactly the "what web viewers
  produce" reasoning `CLAUDE.md` gives. This is the common case for this
  product (Meshy/fal.ai organic generations rarely ship hard edges), and the
  design is correct for it.
- **Cube: GLBForge loses.** 0.9614 mean, 0.9440 on the weakest view — close
  to or *inside* the range this repo already treats as visible loss: the
  published `minSsim` floors are 0.94 (`web`), 0.95 (`mobile-hero`), 0.96
  (`desktop-hero`) (`packages/core/src/profiles.ts:48,73,98`). A hard-edged,
  normal-less mesh run only through GLBForge's own normal synthesis renders
  at a fidelity comparable to what the project calibrated as its *simplification*
  floor — before any triangle is ever removed. The rival's `normals()` is a
  perfect 1.0 here because unwelding-then-flat-shading is definitionally
  correct for any polyhedron with no smooth regions, at the cost of tripling
  vertex count (unwelding every shared corner) and destroying the welded
  topology GLBForge's own watertightness/shell checks
  (`packages/core/src/inspect/topology.ts`) depend on — so "just call the
  rival's `normals()` instead" is not a free win, it trades this rendering
  gap for breaking the topology invariants a different part of the pipeline
  relies on.

**Why this matters for GLBForge specifically, not just as trivia**: the
forge/extrude path (`packages/core/src/extrude/index.ts:295,538`) always
writes its own explicit `NORMAL` and never hits this code — so the one part
of the product that deliberately produces hard, faceted, bevelled geometry
(the whole point of `extrude/bleed.ts`'s "opaque plate" convention) is safe.
The exposure is generated/imported meshes that arrive **without** `NORMAL`
at all and happen to have hard-surface geometry — e.g. an architectural,
mechanical, or prop asset from an image-to-3D generator, as opposed to the
organic character/creature case the reasoning in the code comment is
written for. Not exercised by any existing test: `grep -rn
"computeSmoothNormals" packages/core/test/` matches only through
`analyze.test.ts`'s "welds and fills normals on a dirty quad" test, which
uses a single quad (no adjacent hard edges to smooth incorrectly — a flat
quad's smoothed and flat normals are identical) and so cannot see this gap.

**Not fixed, deliberately.** `computeSmoothNormals` is called from the
renderer itself (`harness/render.ts:187`), which is the same code path
`verifyRig()` uses for every before/after SSIM comparison. `CLAUDE.md` is
explicit that changing what the renderer shades "changes every reported
number — treat `verifyRig()` as frozen... a deliberate pass of its own"
requiring recalibration against the LFS fixtures and republished profiles.
Adding a crease-angle threshold (the standard fix: only accumulate a
vertex's normal across faces whose dihedral angle is below some cutoff,
splitting the vertex otherwise) would change shading for every currently
normal-less asset that has *any* per-vertex angle above the cutoff —
including ones already calibrated into `profiles.ts`'s `minSsim`
commentary. That recalibration is exactly the kind of pass `CLAUDE.md`
reserves as deliberate and separate; doing it inline here, on synthetic
fixtures only, would be guessing at the real-fixture impact rather than
measuring it.

## Verify

No source changed. `pnpm -r build && pnpm -r test`: unchanged, identical to
the ground-truth run. `pnpm probe -- --no-live --json /tmp/probe-after.json`:
same surface (28 tools), same advice (3/3 resolved), same vocab (33/130, 0
undeclared/undocumented/schema violations), "No regressions vs baseline"
reported again; `diff` against `/tmp/probe.json` shows only the timestamp
and per-run latency jitter (a few ms either direction on every tool, e.g.
`optimize_glb` p50 2869→2440ms) expected of two independent runs on shared
hardware — not a structural change. No `baseline.json` edit — nothing
moved. The reproduction script (in-memory
cube/sphere construction + the three-way render/SSIM comparison above) was
written to a scratch file outside the repo and deleted after use — it isn't
committed, since this pass makes no source change and the project's own
pass-file convention (e.g. `2026-09-25-rival-draco-vs-meshopt.md`) records
methodology and numbers in prose rather than checking in throwaway
comparison scripts. The exact construction (cube vertex/face table, UV
sphere parametrization, ground-truth normal assignment) is reproducible
from the "Method" section above using only `@gltf-transform/core` and
`@glbforge/core`'s existing exports (`computeSmoothNormals`, `renderRaw`,
`ssim`, `verifyRig`) plus `@gltf-transform/functions`' `normals()`.

### L15 · `open` · `computeSmoothNormals()` has no crease-angle threshold — it over-smooths hard edges on normal-less meshes, and there's no test for the case it doesn't handle

Measured: a welded, `NORMAL`-less unit cube rendered through
`computeSmoothNormals()` (as `optimize()` and the renderer's own fallback
both call it) scores 0.9614 mean SSIM against the cube's true (unwelded,
per-face) shading over `verifyRig()`'s 4 views (weakest view 0.9440) —
inside the range this repo's own published `minSsim` floors (0.94–0.96,
`profiles.ts`) treat as the edge of visible loss, before any simplification
is even applied. The same function scores 0.9981 on a smooth UV sphere
against the analytic ground truth, confirming the design is correct for
the organic/curved case the code comment argues for. `@gltf-transform/functions`'
`normals()` is the mirror image: 1.0000 on the cube (trivially correct,
since unwelding-then-flat-shading is definitionally right for any
polyhedron) but 0.9174 on the sphere (faceted, visibly wrong for a smooth
shape) — so neither function is a strict replacement for the other, and
GLBForge's choice is right for its dominant case (Meshy/fal.ai organic
generations) but silently wrong for hard-surface, normal-less input. Not
exercised by any existing test (the one normal-synthesis test uses a single
flat quad, where smooth and flat normals are identical by construction).
Not fixed here: `computeSmoothNormals` feeds the renderer `verifyRig()`
uses for every SSIM gate, so changing its algorithm is the kind of
shading-affecting change `CLAUDE.md` requires a dedicated recalibration
pass for (re-measure the LFS fixtures, republish profile commentary), not a
change to make speculatively on synthetic fixtures alone. Closing this
would mean either: (a) add a crease-angle threshold to
`computeSmoothNormals` (locking a vertex's per-face contribution when the
angle between adjacent face normals exceeds some cutoff, mirroring how
`skinning.ts` already locks vertices at joint boundaries for the same
kind of reason) as its own calibration pass, or (b) a documented decision
that hard-surface, normal-less input is out of scope and callers should
author `NORMAL` themselves for such assets — either is fine, but right now
neither is written down anywhere and the gap is silent.
