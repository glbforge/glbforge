# Pass — 2026-09-24 — 09397cd
**Role:** rival

## Step 0 — claim check

Nine open PRs, all `agent-loop/`-prefixed except two (`#36`
`fix/usdz-shared-skeleton`, `#35` `fix/draw-calls-unreachable-promise`, out
of loop scope, left alone). Two already claim **rival**: `#28`
(`gltf-transform`/`gltfpack` vs. `optimize()` on file size and wall-clock)
and `#38` (the Khronos `gltf-validator` vs. `inspect`/`analyze` on spec
conformance). Read both pass files in full. Neither touches STL export or
watertightness, and neither uses an independent geometry-validity oracle —
`#38` explicitly notes it skipped that ground ("USDZ already has its own
conformance oracle"; nothing plays that role for STL). This pass keeps the
role, picks a third alternative (the Manifold geometry library, `manifold-3d`
on npm — used by ManifoldCAD and OpenSCAD-alternatives) and a third axis
(print-solid validity of `export_stl`'s actual output), with zero file
overlap against either open PR's diff.

`#30` (performance, open) rewrote `analyze/geometry.ts`'s topology
computation; confirmed by diff (`git diff main..origin/<branch>`) that it
does not touch `analyze/index.ts` or `detect.ts`, which this pass edits — no
conflict.

## Ground truth

`pnpm install && pnpm -r build`: clean, 6 packages. `pnpm -r test`: 175/178
core (3 skipped, LFS), 44/44 mcp, 5/10 cli (5 skipped, LFS), 2/2 studio, 13/13
meshy — all green before any change. `pnpm probe -- --no-live`: 28 tools, no
baseline regressions, one pre-existing item (`L4`, `site/llms.txt`'s 0.9.0
line — a release call, left alone per the hard limits).

## What was measured

`export_stl`'s description and `detectGenerator`'s forge note both promise
"watertight by construction" for glbforge-extruded assets. Previous auditor
passes checked this claim against the *code that backs it*
(`docs/agent-loop/passes/2026-09-22-pass5-nothing-to-fix.md`: "traced to
`extrude/build.ts`'s documented last-mile watertightness pass and the
`topo/*` rules... the claim is backed by real, tested machinery") and found
nothing wrong — correctly, given what an auditor can check. What none of
that machinery can check is whether the claim is true in reality, because
`inspect`/`analyze`/`export_stl` all define "watertight" the same way
(`inspect/topology.ts`'s `meshTopology`: every edge shared by exactly two
triangles). That is *necessary* for a printable solid but not *sufficient* —
it cannot see a self-intersecting shell (two faces crossing in space), and
`extrude/build.ts`'s own `insetDirections` doc comment already names the
risk for the bevel path: "miter-limited scale so acute corners don't spike
and thin strokes don't self-intersect at small bevel radii" — a mitigation,
not a guarantee, of exactly the failure mode the "watertight by construction"
line promises can't happen.

Built 8 real STL exports (`glbforge stl`, this build) from real assets — two
checked-in fixtures forged with `glbforge extrude` at four settings, three
of the glbforge.dev showcase (`site/models/*.glb`, prior `optimize()`
output), and the existing `assets/sample-ring.glb` fixture — and checked
each one two ways: this build's own `watertight` flag, and an independent
oracle (`manifold-3d`, the Manifold geometry library: parse the binary STL
into a raw triangle soup, `Mesh.merge()` to weld it within tolerance the way
any consumer would, construct a `Manifold`, read `.status()`).

| file | GLBForge `watertight` | Manifold oracle | agree? |
|---|---|---|---|
| `badge-plain.stl` (no bevel) | yes | `NoError`, genus 0 | ✓ |
| `badge-bevel.stl` (`--bevel 0.005`) | **yes** | **`NotManifold`** | **✗ — false "watertight"** |
| `badge-layers.stl` | yes | `NoError`, genus 0 | ✓ |
| `ring-plain.stl` (`--bevel`, has a hole) | yes | `NoError`, genus 1 | ✓ |
| `sample-ring.stl` (checked-in fixture) | yes | `NoError`, genus 1 | ✓ |
| `cat.stl` (`site/models`, optimizer output) | **no** (40 non-manifold edges) | **`NoError`, genus 0** | **✗ — false "not watertight"** |
| `plush.stl` (`site/models`, optimizer output) | no (141 non-manifold edges) | `NotManifold` | ✓ (agree it's broken) |
| `neon.stl` (`site/models`, 44 disjoint shells) | yes | `NoError`, genus not meaningful for a disconnected mesh (ignored) | ✓ |

Two real disagreements, in opposite directions:

- **`badge-bevel.stl`**: GLBForge reports `watertight — print-ready`; an
  independent solid-modeling library refuses to construct a manifold from it
  at all. Root cause matches the `insetDirections` comment above: at a
  concave silhouette corner where the bevel inset is large relative to the
  local feature size, the beveled rim self-intersects in world space. Every
  edge is still paired exactly twice (each self-intersecting face pair
  belongs to its own otherwise-closed local topology), so the edge-count
  check — which is what "watertight" means everywhere in this codebase —
  cannot see it. Reproduced deterministically and in-process (not just via
  the CLI): `packages/core/test/watertight-vertex-pinch.test.ts`.
- **`cat.stl`**: the opposite mistake — GLBForge's own edge-count flags 40
  non-manifold edges (likely real duplicate/overlapping micro-geometry from
  the optimizer path), but Manifold's tolerance-based weld resolves it into
  a single valid, genus-0 solid anyway. An agent trusting the "not
  watertight" warning here would distrust or attempt to repair a mesh a real
  slicer would very likely print fine. Not fixed — the two checks disagree
  on where to draw a tolerance line, and picking one requires a
  cost/judgment call (raise the weld tolerance in the shared
  `canonicalByPosition` risks new false "closed" verdicts elsewhere; see
  `L13` on `#30`, open, about that same function's weld quality) that
  belongs with whoever owns that trade-off. Left as `L35` below with what
  closing it needs.

## What was fixed

`L33`: The "watertight by construction" promise was unconditional everywhere
it appears, independent of whether the asset was actually beveled — the one
case the mechanism it cites (`insetDirections`) explicitly cannot fully
guarantee. Made every instance state its actual, verified scope instead of
overclaiming:

- `packages/core/src/detect.ts` — `detectGenerator` now takes the
  already-computed `TopologyStats` (analyze/index.ts already has it; no new
  computation) and, for glbforge-forged assets, states what was actually
  measured: "not closed" with the real edge counts when topology says so,
  otherwise a note that a flat forge is edge-closed by construction but a
  beveled rim can still self-intersect at a deep concave corner — never the
  old unconditional claim either way.
- `packages/mcp/src/server.ts` — `export_stl`'s description now says what
  "watertightness" actually checks (edge-multiplicity) and names the beveled
  self-intersection gap explicitly, instead of promising it away.
- `README.md`, `packages/core/README.md`, `site/llms.txt` — the same
  unconditional "watertight"/"beveled watertight" phrasing, corrected the
  same way. `site/llms.txt` is the AI-facing scope statement CLAUDE.md names
  explicitly as a doc to keep in sync.

Deliberately **not fixed**: `extrude/build.ts`'s bevel geometry itself (the
actual self-intersection). That's real mesh-construction work
(`insetDirections`/the strip-building loop around
`packages/core/src/extrude/build.ts:110-220`), risks changing beveled output
byte-for-byte (SSIM-sensitive, per `CLAUDE.md`'s frozen-`verifyRig`
carefulness) for an unbounded set of silhouettes, and a wrong fix is worse
than an honest caveat. Left as `L34` below.

New tests:

- `packages/core/test/watertight-vertex-pinch.test.ts` — two cases. (1) A
  dependency-free, hand-built hourglass (two tetrahedra sharing one vertex)
  proves the *combinatorial* half of the blind spot on its own: `meshTopology`
  reports it watertight; a from-scratch vertex-link-connectivity check (no
  external library) proves the shared vertex has two disconnected triangle
  fans. (2) The *real* defect, end to end: `assets/ci-badge.png` (checked-in
  fixture) through `extrudeImage({bevel: 0.005})`, `toStl()` — the exact
  bytes `export_stl` ships — parsed and checked with `manifold-3d`. Confirmed
  both sub-tests fail without the reproduction (i.e. they exercise real
  code, not tautologies) and pass now; they're characterization tests for a
  defect that's still open (`L34`), not regression tests for a fix.
- `packages/core/test/detect.test.ts` — three cases pinning the corrected
  `detectGenerator` behaviour: hedges by default (no topology passed), says
  "not closed" plainly when topology says so, and never regresses to the old
  unconditional "watertight by construction" string. Fails on the
  pre-change code, passes after.

Added `manifold-3d` as a `packages/core` devDependency (test-only; not a
runtime import, doesn't touch the isomorphic-core browser path) — it's the
oracle this whole pass is built on, so the regression test uses the same
tool that found the bug rather than a hand-rolled substitute for the part
that actually needs an authority (geometric self-intersection, not just
combinatorics).

## Left open

- **`L34`** — the actual `extrude/build.ts` bevel self-intersection at
  concave corners. Reproduced deterministically
  (`watertight-vertex-pinch.test.ts`); not fixed here (see above). Closing
  it needs either a tighter miter/clamp bound in `insetDirections` or a
  post-build self-intersection repair pass, verified against a spread of
  concave silhouettes (thin strokes, sharp inner corners, small text) with
  the same `manifold-3d` oracle this pass introduces, plus a check that
  `extrudeImage`'s SSIM-relevant output for *unbeveled* callers is
  unaffected.
- **`L35`** — `cat.stl`'s false "not watertight" (see table above): GLBForge's
  exact-position-after-weld edge count disagrees with Manifold's
  tolerance-based weld on the optimizer's own output. Needs a decision on
  whether `canonicalByPosition`'s exact-match weld should gain a tolerance
  (interacts with `L13` on `#30`, open, about that function's weld quality
  under hash collisions — same function, different axis) or whether the
  disagreement is acceptable as "GLBForge is conservative, not wrong."
- Did not check `gltfpack`/`gltf-transform` output against the Manifold
  oracle (would extend `#28`'s ground, out of scope for a zero-overlap
  pass) or the USDZ path (already has `test/usd-oracle.py`).
- Did not attempt the `extrude/build.ts` fix itself — see above.

## Verify

`pnpm -r build && pnpm -r test`: 183/186 core (+5 tests: 2
`watertight-vertex-pinch`, 3 `detect`; 3 skipped, LFS, unchanged), 44/44 mcp,
5/10 cli (unchanged, gated), 2/2 studio, 13/13 meshy — all green.
`pnpm --filter @glbforge/studio build:site` re-run (core's `detect.ts` is
bundled into the Studio's local engine per `CLAUDE.md`'s isomorphic-core
rule; confirmed the old "watertight by construction" string is gone from
the rebuilt `site/studio/assets/local-engine-*.js`, and from the regenerated
`schemas/index.json`). `pnpm probe -- --no-live`: no baseline regressions;
latency numbers moved within normal host noise (`optimize_glb` p50 2192ms
vs. 2329ms before, `analyze_glb` p50 44ms vs. 39ms) — not touched by this
pass's code path, not re-frozen.

### L33 · `fixed` · `export_stl`/`detectGenerator`/README/`llms.txt` promised glbforge-extruded assets are "watertight by construction" unconditionally, including for beveled rims — the one case the mechanism they cite cannot fully guarantee

Measured: 8 real STL exports checked against an independent geometry-validity
oracle (`manifold-3d`); `badge-bevel.stl` (`glbforge extrude --bevel 0.005`
on the checked-in `assets/ci-badge.png`) reports `watertight: true` from this
build's own edge-count check while the oracle refuses to construct a valid
manifold from it (`NotManifold`) — a self-intersecting beveled rim at a
concave silhouette corner, the exact risk `insetDirections`'s own doc comment
names as a miter-limited mitigation, not a guarantee. Fixed by making every
instance of the claim (`packages/core/src/detect.ts`,
`packages/mcp/src/server.ts`'s `export_stl` description, `README.md`,
`packages/core/README.md`, `site/llms.txt`) state its actual, measured scope
instead of an unconditional promise. Regression tests:
`packages/core/test/detect.test.ts` (the note text, fails without the fix)
and `packages/core/test/watertight-vertex-pinch.test.ts` (the underlying
defect the note now hedges against, characterization — the defect itself is
`L34`, still open).

### L34 · `open` · `extrude/build.ts`'s beveled rim can self-intersect at a deeply concave silhouette corner; the edge-based watertight check cannot see it

Measured (see `L33`): `assets/ci-badge.png` through
`extrudeImage({bevel: 0.005})` produces a shell an independent oracle
(`manifold-3d`) refuses to accept as a valid manifold, while
`meshTopology`/`inspect`/`export_stl` all report it closed. Root cause
matches `insetDirections`'s own doc comment (miter-limited, not
self-intersection-proof). Reproduced deterministically:
`packages/core/test/watertight-vertex-pinch.test.ts`'s second case. Not
fixed — real mesh-construction work in `extrude/build.ts:110-220`
(`insetDirections` / the wall+bevel strip loop), with SSIM-sensitive output
for every existing beveled asset; closing it needs either a tighter
miter/clamp bound or a post-build self-intersection repair, verified across
a spread of concave silhouettes with the same oracle, plus confirmation the
unbeveled path (the common case) is untouched.

### L35 · `open` · GLBForge's edge-count "not watertight" disagrees with an independent oracle on `site/models/cat.glb`'s STL export — the opposite mistake from `L34`

Measured (see table above): `cat.stl` (this build's own `optimize()` output,
the glbforge.dev showcase asset) reports `not watertight` (40 non-manifold
edges) from `meshTopology`'s exact-position weld, while `manifold-3d`'s
tolerance-based weld constructs a single valid genus-0 solid from the same
triangle soup without complaint. An agent trusting the warning here would
distrust or attempt to repair a mesh independent tooling accepts. Not fixed:
the two checks disagree on where to draw a weld tolerance, and
`canonicalByPosition` (the shared exact-match weld backing `meshTopology`,
`inspect`, and the rule packs) is exactly the function `L13` on `#30` (open)
already flags for a hash-quality issue on a different axis — the same
function, so a tolerance change belongs in that same review rather than a
second uncoordinated edit. Closing this needs a decision on whether to add a
tolerance there (and re-verify every frozen `test/packs.test.ts` case and the
LFS calibration points per `CLAUDE.md`'s versioned-budgets rule) or document
the conservatism as intentional.
