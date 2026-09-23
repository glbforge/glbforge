# glbforge

**Make AI-generated 3D assets web-ready.** Generation is a commodity; the gap
between "generated" and "shipped" is what GLBForge closes — during authoring
(`inspect`, `diff`) and at the gate (`analyze`, `optimize`, `ship`).

```bash
# The read after every edit: shells, watertightness, size in metres, up axis,
# origin, unapplied transforms — named rules with causes and fixes, ~70ms
npx glbforge inspect model.glb --expect "chair, single-shell, watertight"

# What the last edit changed, and what it broke
npx glbforge diff before.glb after.glb --visual

# Anything -> web-ready in one call: a GLB is optimized, flat artwork is
# forged, a photo is generated — then analyzed, optimized and budget-gated
npx glbforge ship model.glb --profile mobile-hero

# Lighthouse-style report card against a web performance budget
npx glbforge analyze model.glb --profile mobile-hero

# Weld, simplify to budget, WebP/KTX2 textures, meshopt compression, LOD chain
npx glbforge optimize model.glb --ktx2 --lods 40000,10000

# Deterministic logo/SVG -> beveled, watertight 3D (no AI, no credits)
npx glbforge extrude logo.png --bevel 0.018

# Print-ready binary STL (mm-scaled, z-up, watertightness verdict)
npx glbforge stl model.glb --size 80

# USDZ for iOS AR Quick Look (binary crate, UsdPreviewSurface, UsdSkel)
npx glbforge usdz model.web.glb

# Looping motion baked in as an ordinary clip — no rig, no bones. Drives a
# pivot at the base centre; original nodes, skins and clips are untouched
npx glbforge animate model.glb --preset idle

# Put it on the desktop: a transparent always-on-top character that plays its
# clips, gazes at the cursor, and answers typed messages through an agent
npx glbforge companion model.glb

# React Three Fiber viewer with LOD switching + KTX2 decoding
npx glbforge scaffold model.web.glb -o viewer

# Meshy API: generate -> auto-optimize in one command (needs MESHY_API_KEY)
npx glbforge meshy image art.png --pbr --optimize

# Watch a folder: drop a GLB, get the optimized version
npx glbforge watch ./exports
```

Typical result on a raw Meshy High-Detail export: **89MB → 5.5MB (−94%)** in
~7 seconds, passing a 150k-triangle mobile budget — with `--ktx2` cutting GPU
texture memory a further 4–8x.

Budgets are contracts: `analyze` exits non-zero when an asset is over budget,
so it drops into CI like a linter, and profiles are versioned (`mobile-hero@1`
pins; a published cap never changes in place). "No visible loss" is measured,
not claimed: every `optimize` / `ship` renders four fixed cameras before and
after and gates the weakest SSIM on the profile's floor. A ready-made GitHub
Action posts report cards on PRs, and `npx glbforge init` wires the whole
thing into a project (npm scripts, MCP server, CLAUDE.md section): see the
repo.

Everything the CLI does is also an MCP tool
([`@glbforge/mcp`](https://www.npmjs.com/package/@glbforge/mcp), 28 of them),
so an agent gets the same pipeline without shelling out — every response
carries a stable code and a prim path, and validates against a published
schema.

Docs, GitHub Action, and MCP server: **https://github.com/glbforge/glbforge** · https://glbforge.dev
