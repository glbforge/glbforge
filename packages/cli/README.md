# glbforge

**Make AI-generated 3D assets web-ready.** Generation is a commodity; the gap
between "generated" and "shipped" is what GLBForge closes.

```bash
# Lighthouse-style report card against a web performance budget
npx glbforge analyze model.glb --profile mobile-hero

# Weld, simplify to budget, WebP/KTX2 textures, meshopt compression, LOD chain
npx glbforge optimize model.glb --ktx2 --lods 40000,10000

# Deterministic logo/SVG -> beveled, watertight 3D (no AI, no credits)
npx glbforge extrude logo.png --bevel 0.018

# Print-ready binary STL (mm-scaled, z-up, watertightness verdict)
npx glbforge stl model.glb --size 80

# React Three Fiber viewer with LOD switching + KTX2 decoding
npx glbforge scaffold model.web.glb -o viewer

# Meshy API: generate -> auto-optimize in one command (needs MESHY_API_KEY)
npx glbforge meshy image art.png --pbr --optimize

# Watch a folder: drop a GLB, get the optimized version
npx glbforge watch ./exports
```

Typical result on a raw Meshy High-Detail export: **89MB → 5.5MB (−94%)** in
~7 seconds, passing a 150k-triangle mobile budget — with `--ktx2` cutting GPU
texture memory a further 4x.

Budgets are contracts: `analyze` exits non-zero when an asset is over budget,
so it drops into CI like a linter. A ready-made GitHub Action posts report
cards on PRs: see the repo.

Docs, GitHub Action, and MCP server: **https://github.com/glbforge/glbforge** · https://glbforge.dev
