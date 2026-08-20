# @glbforge/core

The engine behind [glbforge](https://www.npmjs.com/package/glbforge): pure
TypeScript analysis, optimization, extrusion, and export for glTF/GLB assets.

- `analyze(doc, {profile})` — geometry/texture/material stats, welded-space
  topology (boundary, non-manifold, truly-redundant vertices), named lint
  rules with fixes, budget scoring
- `optimize(doc, {profile, textureFormat})` — dedup → palette/join → weld →
  meshopt-simplify (error ladder) → smooth normals → WebP or KTX2 → meshopt
- `extrudeImage(bytes, opts)` — raster/SVG silhouette → beveled watertight
  mesh with the source image projected as texture
- `toStl(doc, {targetSizeMm})` — binary STL, world transforms baked, z-up
- Profiles: `mobile-hero`, `desktop-hero`, `product-configurator`

Docs: **https://github.com/glbforge/glbforge**
