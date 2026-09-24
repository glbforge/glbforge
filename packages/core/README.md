# @glbforge/core

The engine behind [glbforge](https://www.npmjs.com/package/glbforge): pure
TypeScript analysis, optimization, extrusion, and export for glTF/GLB assets.

- `inspectScene(ir, {profile, expect})` — semantic read for the edit loop:
  shells, watertightness, size in metres, up axis, origin landmark, node
  transforms; versioned rule packs, measured/heuristic certainty, causes
  with confidence, fixes
- `diffScenes(before, after, opts)` — what an edit changed and what it broke,
  per part; `diff@1` rules with regressions first
- `analyze(doc, {profile})` — geometry/texture/material stats, welded-space
  topology (boundary, non-manifold, truly-redundant vertices), named lint
  rules with fixes, budget scoring
- `optimize(doc, {profile, textureFormat})` — dedup → palette/join → weld →
  meshopt-simplify (error ladder) → smooth normals → WebP or KTX2 → meshopt
- `extrudeImage(bytes, opts)` — raster/SVG silhouette → extruded, optionally
  beveled mesh with the source image projected as texture; flat (bevel=0)
  output is edge-closed by construction, a beveled rim can self-intersect at
  a deeply concave silhouette corner
- `animate(doc, {preset, duration, amplitude})` — bake a looping procedural
  clip (idle, bob, spin, sway, breathe, hop) onto a pivot at the base centre,
  no rig required; amplitudes are fractions of the measured height, so the
  result is deterministic and re-running replaces the clip rather than
  stacking another one
- `toStl(doc, {targetSizeMm})` — binary STL, world transforms baked, z-up
- `toUsdz(doc, opts)` — iOS AR Quick Look: binary usdc (crate 0.8.0) written
  in pure TS, UsdPreviewSurface materials, UsdSkel skeletons and blend shapes
- Profiles: `mobile-hero`, `desktop-hero`, `product-configurator` (versioned;
  a published cap never changes in place)
- Isomorphic: `sharp` and `node:*` load lazily, browsers inject codecs

Docs: **https://github.com/glbforge/glbforge**
