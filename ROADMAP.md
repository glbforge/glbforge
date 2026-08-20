# GLBForge Roadmap

Mission: **the web-readiness layer for AI-generated 3D** — generation is a
commodity; the gap between "generated" and "shipped" is the product.

## ✅ Done (v0.1 — validated end to end)

- [x] `@glbforge/core` analyze: stats, welded-space topology, 14 named lint rules, 3 budget profiles
- [x] `@glbforge/core` optimize: dedup → weld → simplify (error ladder) → smooth normals → WebP textures → meshopt
- [x] `@glbforge/core` extrude: raster trace → bevel (watertight: clamp probes + crack stitching) → texture projection
- [x] `glbforge` CLI: analyze / optimize (+LODs) / extrude / scaffold / meshy, CI exit codes
- [x] `@glbforge/meshy`: typed client, polling w/ backoff — all 3 generation paths live-validated
- [x] `@glbforge/mcp`: 7 tools, validated via SDK client and in a live Claude Code session
- [x] R3F viewer scaffold (offline-safe lighting, meshopt decoding)
- [x] 13 tests incl. real Meshy fixtures + watertightness assertions

## v0.2 — Hardening (make it trustworthy)

- [x] `git init` + **git LFS for fixtures** (they're 34–93MB — plain git will choke), MIT license
- [x] GitHub Actions CI: build + tests + CLI dogfood (extrude → analyze, exit-code enforced); fixture specs self-skip on LFS pointer files
- [x] `--json` output for `optimize` and `extrude` (parity with `analyze`; agents/CI need it)
- [x] Multi-material asset support in optimize: `palette` → `flatten` → `join` (draw-call reduction; tested 2 prims → 1)
- [x] Rule expansion: `mat/blend-without-alpha` (byte-level alpha sniffing, no decode), `tex/vram-estimate` (GPU memory vs budget, KTX2-aware). Deferred: normal-map Y-convention (needs pixel statistics, low signal)
- [x] Error-message pass: friendly ENOENT, photo-detection guidance in extrude, Meshy errors carry API messages
- [ ] Fixture zoo: collect GLBs from other generators (Tripo, Rodin, TRELLIS-class) — the per-generator rule corpus is the moat

## v0.3 — Features (make it more valuable)

- [x] **KTX2/BasisU** texture option (`--ktx2` / `textureFormat: 'ktx2'`): basisu or toktx backend, ETC1S for color / UASTC for normals, KHR_texture_basisu required, scaffold ships the transcoder + KTX2Loader wiring. Measured: 63.8MB → 16.0MB GPU memory on the lucky-cat fixture
- [x] **Runtime LODs in scaffold**: `--lods` files are now geometry-only (lod1 4.1MB→0.7MB, lod2 3.6MB→0.3MB); scaffold auto-detects `.lodN.glb` siblings and emits a `<Detailed>` viewer that shares the primary's materials at runtime (verified: 150k/40k/10k tris, all textured)
- [x] **STL export** (`glbforge stl`, MCP `export_stl`): binary STL, mm-scaled, z-up, watertightness verdict in output. Verified: beveled logo → 70mm watertight keychain; lucky cat → 60mm figurine
- [x] SVG input for extrude: sharp rasterizes at high density into the existing trace pipeline (vector fidelity is trace-grid-limited either way); verified watertight on a test SVG
- [x] `glbforge watch <dir>`: drop a GLB → auto analyze/optimize (debounced, own outputs excluded); verified live
- [x] Scaffold auto-framing via `<Bounds fit clip observe>`. Deferred: env presets, `<model-viewer>`/USDZ AR export
- [x] Meshy surface area: remesh + retexture endpoints (client/CLI/MCP, mock-tested) + `glbforge meshy balance` (live-validated). Deferred: auto-rigging passthrough

## v0.4 — Distribution (make it findable)

- [x] Name decided: **GLBForge** — glbforge.dev registered (Cloudflare); npm, GitHub org, and .com/.ai were all free at decision time
- [x] npm publish v0.1.0: `glbforge` + `@glbforge/core|meshy|mcp` all live and public (meshy/mcp sat in npm security review ~30min, then cleared). Cold-verified from the public registry: `npx glbforge analyze` and `npx @glbforge/mcp` both work
- [ ] Per-package READMEs, docs site or GitHub README gallery with before/after numbers and screenshots
- [ ] Submit MCP server to registries / awesome-mcp lists; Meshy community (Discord) showcase
- [x] **GitHub Action** (`uses: glbforge/glbforge@main`): analyzes changed GLB/glTF in PRs, posts a sticky report-card comment, gates on budget. Live-tested on PR #1 — score table + findings + fix hint posted by the bot
- [ ] Launch content: the numbers sell it (89MB→5.5MB, 40KB beveled logo). three.js forum, r/threejs, X creative-coding

## Pre-launch: Forge upgrades + hosted demo

- [x] **Layered color extrusion** (`--layers N`, studio "layered colors" toggle): k-means color
  quantization (majority-filtered labels kill AA halos) → per-color trace → stepped depths,
  backs coplanar, flat per-layer materials. Default 4 layers = exactly the mobile-hero
  draw-call budget. Verified: plushqlty logo → 4 layers, 41k tris, score 95
- [x] **Pillow relief** (`--pillow <m>`, studio toggle): exact EDT → `H·sqrt(min(D,R)/R)` dome on a ring-edge-aware subdivided front cap (T-junction-free by construction; watertight verified). Composes with layers = embroidered-patch look. Deferred: luminance emboss
- [x] **Material presets** (`--preset`, studio dropdown): enamel, chrome, neon (emissive from cluster colors / glows the artwork when textured), acrylic (KHR_materials_transmission), rubber
- [ ] glbforge.dev landing page + docs (Cloudflare Pages; CTA = `npx glbforge ui`)
- [ ] Hosted demo, phase 2: moat features account-free (size caps + rate limits);
  generation via BYOK **and** purchased credits (GitHub OAuth + Stripe, quota ledger,
  balance kill-switch via getBalance). Check Meshy ToS re: resale — an affiliate/volume
  arrangement may be the better structure

## v1.0 — Product bets (choose after usage data)

- [ ] Hosted drag-and-drop: GLB in → report + optimized asset out (free tier = lead gen)
- [ ] Team budgets: asset perf dashboards, budget history, Slack alerts ("asset over budget")
- [ ] Vertical templates: product-configurator starter, marketing-hero starter (paid)
- [ ] Seedance bridge (original vision, deferred deliberately): optimized 3D → turntable/hero video; 3D pose/camera scaffolds driving video generation

## Standing principles

- Deterministic core; generation is the only stochastic step
- Budgets are contracts (exit codes), not advice
- Every new generator artifact teaches a named rule
- Human approval points stay; outputs stay editable
