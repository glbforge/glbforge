# XUI Roadmap

Mission: **the web-readiness layer for AI-generated 3D** — generation is a
commodity; the gap between "generated" and "shipped" is the product.

## ✅ Done (v0.1 — validated end to end)

- [x] `@xui/core` analyze: stats, welded-space topology, 14 named lint rules, 3 budget profiles
- [x] `@xui/core` optimize: dedup → weld → simplify (error ladder) → smooth normals → WebP textures → meshopt
- [x] `@xui/core` extrude: raster trace → bevel (watertight: clamp probes + crack stitching) → texture projection
- [x] `@xui/cli`: analyze / optimize (+LODs) / extrude / scaffold / meshy, CI exit codes
- [x] `@xui/meshy`: typed client, polling w/ backoff — all 3 generation paths live-validated
- [x] `@xui/mcp`: 7 tools, validated via SDK client and in a live Claude Code session
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

- [ ] **KTX2/BasisU** texture option (GPU-resident compression — WebP decodes to full-size VRAM; mobile cares). Graceful fallback when toktx/basisu is missing
- [ ] **Runtime LODs in scaffold**: drei `<Detailed>` wiring + share textures across LOD files (texture-free LODs reusing the primary's material)
- [ ] **STL export** (`xui export --stl`): watertight extrusions make this nearly free — unlocks 3D-printing users (logo → desk object/keychain is a real creator use case)
- [ ] SVG input for extrude (path parsing + fill rules; raster already covers most creators)
- [ ] `xui watch <dir>`: drop a GLB → auto analyze/optimize/report
- [ ] Scaffold upgrades: auto-framing (`<Bounds>`), env presets, `<model-viewer>` AR export option (USDZ)
- [ ] Meshy surface area: remesh + retexture endpoints, auto-rigging passthrough, account balance check

## v0.4 — Distribution (make it findable)

- [ ] npm publish (`xui` bin via npx; check scope availability — @xui may be taken, decide name once)
- [ ] Per-package READMEs, docs site or GitHub README gallery with before/after numbers and screenshots
- [ ] Submit MCP server to registries / awesome-mcp lists; Meshy community (Discord) showcase
- [ ] **GitHub Action** (`xui-action`): PR comment with report-card diff when 3D assets change — the "Lighthouse CI" wedge into teams
- [ ] Launch content: the numbers sell it (89MB→5.5MB, 40KB beveled logo). three.js forum, r/threejs, X creative-coding

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
