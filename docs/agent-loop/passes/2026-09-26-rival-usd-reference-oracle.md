# Pass — 2026-09-26 — bcab2a4
**Role:** rival

## Step 0 — claim check

`gh pr list --state open` (filtered to `agent-loop/*`) showed eight already-open
passes claiming **rival**: `#28` (gltf-transform/gltfpack vs. `optimize()` on
size/wall-clock), `#38` (Khronos `gltf-validator` vs. `inspect`/`analyze` on
spec conformance), `#39` (`manifold-3d` vs. `export_stl`'s watertight claim),
`#40` (`ssim.js` vs. the SSIM gate itself), `#42` (`gltfpack` vs. `buildLod`'s
cluster fallback on geometric fidelity), `#44` (Draco vs. meshopt geometry
compression), `#45` (three.js `ExtrudeGeometry` vs. `extrude_image` on curve
fidelity), `#46` (`gltfjsx` vs. `scaffold`'s node naming). Read all eight pass
files in full. Between them they cover every optimize/LOD/extrude/scaffold/STL
axis this repo has an obvious rival for. None of them installs the one rival
that actually matters for the USD writer: **Pixar's own reference USD
library** (`usd-core`, the authoritative implementation of the format
`usdc.ts`/`usdz.ts` target). `#28` and `#39` both explicitly noted "USDZ
already has its own conformance oracle" and moved on without running it —
correctly assuming it needs `pip install usd-core`, but, it turns out,
incorrectly assuming that's out of reach here.

## What was checked first: is the assumption even true?

This sandbox's own instructions say outbound HTTPS is "allowlisted to
npmjs.org and little else." Tested directly rather than inherited:

```
curl https://pypi.org/simple/usd-core/  → 200
curl https://registry.npmjs.org/three   → 200
```

PyPI is reachable. `python3 -m venv` + `pip install usd-core` succeeded (no
`usdchecker` CLI ships in the PyPI wheel — that's a source-build-only tool —
but the `pxr` Python module, the actual reference reader/writer used by
`test/usd-oracle.py` and `test/usd-reader-oracle.py`, works fully). Every
prior rival pass's assumption that this oracle can't run here was never
actually tested. It can.

## What was measured

Ran the existing opt-in oracle specs (`test/inspect.test.ts`,
`test/usdz.test.ts`, `test/usd-skel.test.ts`) with `GLBFORGE_PXR_PYTHON` set
for the first time in this loop's history: all 3 pass. (`#41`, also open,
separately wires this into CI — did not touch that file or its scope here,
only ran the specs it's trying to make un-skippable.)

Those specs all check a hand-built synthetic fixture against a hand-built
`.usda` twin of the same document, or a small purpose-built reader-torture
scene (49-vertex grid, blend shapes, variants). None of them run the
reference reader against **GLBForge's actual production output on a real
asset** — the same three `site/models/*.glb` files `#28` and `#38` already
used for their comparisons. Two further stress checks, neither covered by
any existing test or open PR:

**Real assets, independently counted.** Ran `glbforge usdz` on
`cat.glb`/`plush.glb`/`neon.glb` (multi-material, one multi-texture, all
already-optimized GLBForge output) and independently reopened each `.usdz`
with `pxr` (not this repo's reader — the actual reference one), counting
mesh prims, triangles (from `faceVertexCounts`), bound materials, and texture
shader inputs from scratch:

| asset | meshes | triangles | materials | textures | GLBForge's own summary |
|---|---:|---:|---:|---:|---|
| cat.glb | 1 | 149,996 | 1 | 3 | **matches exactly** |
| plush.glb | 4 | 149,992 | 4 | 0 | **matches exactly** |
| neon.glb | 3 | 20,024 | 3 | 0 | **matches exactly** |

**Scale the reader hasn't been tested at.** Every existing crate-reader test
fixture tops out at 49 points. Generated a 200×200 grid (40,000 points,
39,601 quads → 120,000 float components) with `pxr` directly — 800x more
vertex data than any committed fixture — and read it back with this repo's
own from-scratch `usdc-read.ts`. Motivation: the reader's `unpack()` only
recognizes the specialized int/float LUT/delta compression scheme
(`readCompressedInts` et al.) for scalar `Int`/`Float`/`Double`/`Half` arrays;
any other compressed array type falls through to `warnings.push('usdc:
compressed array of type ${type} not supported')` and returns `null` —
worth knowing whether `Vec3fArray` positions/normals, which is what actually
carries a mesh's geometry, ever go through that branch at real scale. They
don't: Pixar's crate format only special-cases POD scalar streams that way,
never `Vec3f`/`Vec3h`/etc., at any size tested. Both position and normal
arrays round-tripped byte-for-byte through this repo's reader at 40,000
points, no warnings.

## What was fixed

Nothing in `packages/core/src`. Every check above **agreed** — this is a
rival pass that did not find a row where GLBForge loses, after a real
attempt at three different angles (real-asset counts, a synthetic mesh two
orders of magnitude larger than any existing fixture, and just actually
running the opt-in oracle for the first time). Per the loop's own rule, that
is not manufactured as a finding — but the coverage gap it closes is real:
before this pass, nothing checked `toUsdz()`'s own reported card
(`meshes`/`triangles`/`materials`/`textures` — the numbers `glbforge usdz`
prints and an agent would read) against an independent reader on anything
but a synthetic build fixture.

### L15 · `fixed` · `toUsdz()`'s reported summary was never cross-checked against a real asset by the reference reader

Only synthetic build fixtures ever went through the Pixar oracle; the
`meshes`/`triangles`/`materials`/`textures` card an agent actually reads back
(`glbforge usdz`'s own output) had never been independently verified on real
production geometry. Added `packages/core/test/usd-summary-oracle.py` (opens
a `.usdz` with `pxr`, independently counts mesh prims/triangles/bound
materials/texture shader inputs from scratch) and a new `it.each` block in
`usdz.test.ts` running it against `plush.glb`/`cat.glb`/`neon.glb` through
the real `toUsdz()` path, opt-in behind `GLBFORGE_PXR_PYTHON` like every
other oracle test here. It's a regression guard, not a bug fix — the numbers
already matched (see the table above) — confirmed it actually exercises the
check by temporarily flipping one comparison field and watching it fail,
then reverted.

## Ground truth

`pnpm install && pnpm -r build`, `pnpm -r test` clean before any change (core
177/3skip, mcp 46/46, cli 5/5skip, studio 2/2, meshy clean) and after (core
180/3skip — +3 new tests from the `it.each`, everything else unchanged).
`pnpm --filter @glbforge/core test` with `GLBFORGE_PXR_PYTHON` set: all 4 USD
oracle specs pass (the 3 pre-existing + the new one). `pnpm probe --
--no-live`: 28 tools, no regressions vs. `baseline.json`, before and after —
latency deltas are normal host noise. `pnpm docs:check`: clean (this pass
adds no CLI verb, MCP tool, or public claim). No `baseline.json` edit —
nothing moved.

## Left open

- No behavior change to propose — the writer and reader agree with the
  reference implementation on everything tested here. A future rival pass
  with more budget could push harder in directions this one didn't reach:
  feeding a **foreign**, non-GLBForge-authored complex USD file (cameras,
  lights, non-mesh prims, nested variant sets with offset/scaled sublayers)
  into `inspect`/`analyze` — everything tested here was GLBForge's own
  writer output being read back by the reference, not the reverse; a real
  animated/skinned rig at the same 40k-point scale the geometry check used
  here (the existing `usd-skel` oracle fixture is a small synthetic
  cylinder); or an adversarial hand-crafted crate file (bad TOC offsets,
  truncated sections) as a `saboteur`-flavored follow-up, not a rival one.
- `L4` (`site/llms.txt` "0.9.0 line" vs. 0.8.0 packages) — untouched, a
  release call, per standing instruction.
