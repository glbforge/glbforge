# GLBForge Roadmap

Mission: **the web-readiness layer for AI-generated 3D** — generation is a
commodity; the gap between "generated" and "shipped" is the product.

## Reframe (2026-09-11): from finishing gate to the agent's eyes during authoring

A tool invoked once per asset never becomes a habit. The inner loop is where
usage lives: an agent editing a mesh in Blender is blind after every bpy
call. Success metric: **invocations per asset** (~1 today, ~20 = in the
loop), to be instrumented locally, opt-in, keyed by lineage (not content
hash — every edit changes the hash). Ship narrow and fast: `inspect` and
`diff`. Blender is not needed for any v1 check (measured: 1.2 s per
headless call and wrong topology without a destructive merge; the IR
answers everything in tens of ms).

- [x] Rule packs (2026-09-11): slash ids are the public API, versioned by
  pack (`core-geometry@1`, `core-scene@1`), SCREAMING codes are aliases;
  severity is the profile's call (`authoring@1` vs `mobile-hero@1` on the
  same edges); certainty invariant (measured messages, causes with their
  own confidence); dogfood table freezes every example's findings —
  the pipeline is not exempt from the linter and a rule never softens for it
- [x] Welded topology engine (radix-sorted edge pairs + union-find shells):
  2M-tri raw Meshy 1.4 s → 0.36 s, 150k-tri hero ~70 ms, numbers unchanged
- [x] `inspectScene` report + `glbforge inspect` + MCP `inspect` (2026-09-11):
  shells / watertight / metres / up / origin landmark / unapplied,
  mirrored, non-uniform transforms; `front` always unknown
- [ ] `--expect` intent pack (`intent@1`): category → height range table,
  up-axis, units, shells, front
- [ ] `glbforge diff <before> <after>` + MCP `diff`: structural + topology
  regressions + optional 4-view render delta; diff edges feed lineage
- [ ] Usage counter (opt-in JSONL under `~/.config/glbforge/`, lineage =
  same path within a session ∪ diff edges ∪ explicit id); `glbforge usage`
- [ ] Pipeline tickets from the dogfood table: forge wall winding vs normals
  disagree on 100% of wall faces; ~~layered forge stacks by node translation~~
  (baked into vertices 2026-09-11, layer nodes are identity);
  some bevelled forge outputs have open edges despite the "watertight" claim

## Status after v0.5.0 (2026-09-08) — what's left

v0.5.0 shipped the six-item agent/quality pass: measured SSIM verification on
every optimization, the agent-friendly MCP (compact cards, drill-down,
previews, comparison sheets, `capabilities`), the Action's optimize-PR mode
(live-verified on PR #2/#3), `glbforge init` / `audit`, bone-aware skinning,
USDZ export, and versioned budget profiles with a published methodology.
Everything below is what remains, most urgent first.

**Verification debt (needs a device or a human)**
- [x] USDZ on an iPhone (2026-09-08): AR Quick Look opens the flat-material plush (crate 0.8.0), the textured cat (JPEG base color + PNG normal/ORM through channel outputs, `st` primvar), a skinned tube with a sampled clip, and the same tube with a blend shape — crate writer, UsdPreviewSurface, UsdSkel skeleton/clip/blend shapes, and the default-material fix are all verified on a real device
- [x] Stripe live-mode flip (2026-09-11): live `sk_live` + webhook secret on the worker, live event destination "GLBForge Billing" on the GLBForge Stripe account (`acct_1U6Rg8…`, separate from the CLI's default account), proven with a real $5 starter purchase → `cs_live_…` row in D1 + credits granted; first attempt was an issuer `insufficient_funds` decline via Link, retry with the card succeeded
- [ ] Meshy ToS resale check + `support@glbforge.dev` routing (pre-existing; gates real money)

**Near-term engineering (follow-through on v0.5.0)**
- [x] USDZ: binary `usdc` writer (2026-09-08) — crate 0.8.0 in pure TS (literal-only LZ4 + Pixar integer compression for structural sections, raw arrays); verified byte-layout against Pixar's writer and value-for-value against Pixar's reader (test/usd-oracle.py, `GLBFORGE_PXR_PYTHON`). Layer 5.4MB vs 13.4MB ASCII on the Meshy fixture
- [x] USDZ: UsdSkel (2026-09-08) — SkelRoot + Skeleton (parents-first joints, bind = inverse IBM, rest = local-to-parent-joint), SkelBindingAPI primvars (elementSize 4), first clip sampled at 30 fps into SkelAnimation (float3/quatf/half3 time samples; crate TimeSamples + DoubleVector + Quatf/Vec3h/Matrix4d arrays reverse-engineered from Pixar's writer). Oracle: Pixar's UsdSkel recomputes the test rig's upper joint at frame 30 as the authored 90°. iPhone-verified: the clip plays in AR Quick Look
- [x] USDZ: blend shapes (2026-09-08) — morph targets → BlendShape prims (dense offsets + normalOffsets), `skel:blendShapes` / `skel:blendShapeTargets` on the mesh, `blendShapeWeights` sampled from the glTF weights channel into the SkelAnimation; morph-only meshes get a one-joint skeleton. Oracle: Pixar's anim query returns weight 1 at the authored peak. iPhone-verified: the bulge plays with the bend. Also: unassigned primitives now bind a default material (an unbound Mesh rendered as RealityKit's magenta stripes on iPhone; fixed and verified on device)
- [x] Agent-oriented MCP feedback (2026-09-08, `docs/agent-feedback-gap-analysis.md`): common envelope `{ok, summary, duration_ms, errors[], data}` on every tool, enumerable codes + prim_path on every diagnostic (`docs/error-codes.md`, generated from `ERROR_CODES`), published `schemas/`; `validate` / `inspect_geometry` / `inspect_animation` / `inspect_materials` / `analyze_performance` (ios_ar / visionos / web) / `inspect_all` over a format-agnostic SceneIR; pure-TS USD readers (usda, usdc crate 0.4–0.10 with real LZ4 + integer decompression, usdz container) validated value-for-value against Pixar-written files; `render` (front / N-angle turntable / custom, posed via CPU skinning + morphs) and `render_animation_strip` (+GIF); `dry_run` / `diff` / `post_validation` on every mutating tool and every silent mutation reported. Fixtures + integration tests per failure mode; `validate(quick)` on 50k tris in tens of ms
- [ ] USD composition (references / payloads / variants) — the readers see one layer; arcs are reported as `UNRESOLVED_COMPOSITION_ARC`. Would need a small composition engine or flattening upstream
- [ ] Crate writer: real LZ4 matching if structural sections ever matter (they are KBs)
- [x] Action: `lods` and `target-triangles` inputs (2026-09-08) — both in the cache key, LOD files cached/staged/committed alongside, report rows carry each LOD's real triangle count and flag targets the simplifier could not reach. `replace: true` and `optimize-all` still only dry-run locally
- [x] LOD targets on seam-heavy / non-manifold meshes (2026-09-08): `buildLod` strips materials, welds by position, tries meshopt, and when topology stalls it (stacked forge layers share coplanar faces → 2.4k non-manifold edges → locked vertices) falls back to grid vertex clustering (binary-searched resolution, centroid positions, smooth normals regenerated). Sunburst LODs: 20k → 19,846, 5k → 4,764 (was stuck at ~48k); Meshy fixture unchanged (meshopt reaches 40k/10k). Reports say `grid-clustered`
- [ ] Perceptual verification for LOD chains: report SSIM per LOD as info (LODs are intentionally lossy, so no gate) so agents can pick switch distances from measured numbers
- [x] Studio (2026-09-08): visual-fidelity row (SSIM vs floor, weakest view) in the inspector; change-heatmap toggle overlays the reference · result · change sheet on the viewport (drawn via canvas in-browser, sharp on `glbforge ui`); USDZ export button (in-browser canvas transcode to PNG/JPEG, crate 0.8.0). Verified in both backends
- [ ] `init`: config paths for more clients (Codex, Windsurf, Zed); Cursor path is unit-tested only
- [ ] MCP progress notifications for long tools; MCP resources for intermediate artifacts (reports, LODs, render sheets)
- [ ] Documented composition patterns with filesystem / image-gen / Blender MCP servers
- [ ] Profiles v2: don't move caps without data — collect real device/network failures from users first (the methodology page commits to this)

**Longer-term (unchanged)**
- [ ] Fixture zoo + per-generator rules (self-feeding corpus); training-corpus target ~200 assets before a first TRELLIS/TripoSR fine-tune
- [ ] Scene-level budgets; pluggable retopo / UV / baking backends
- [ ] Distribution: per-package READMEs with before/after galleries, awesome-mcp lists, launch content
- [ ] v1.0 product bets (see below) — choose after usage data

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
- [x] Scaffold auto-framing via `<Bounds fit clip observe>`. Deferred: env presets. USDZ AR export shipped 2026-09-07 (see Pipeline depth)
- [x] Meshy surface area: remesh + retexture endpoints (client/CLI/MCP, mock-tested) + `glbforge meshy balance` (live-validated). Deferred: auto-rigging passthrough

## v0.4 — Distribution (make it findable)

- [x] Name decided: **GLBForge** — glbforge.dev registered (Cloudflare); npm, GitHub org, and .com/.ai were all free at decision time
- [x] npm publish v0.1.0: `glbforge` + `@glbforge/core|meshy|mcp` all live and public (meshy/mcp sat in npm security review ~30min, then cleared). Cold-verified from the public registry: `npx glbforge analyze` and `npx @glbforge/mcp` both work
- [ ] Per-package READMEs, docs site or GitHub README gallery with before/after numbers and screenshots
- [ ] Submit MCP server to registries / awesome-mcp lists; Meshy community (Discord) showcase
- [x] **GitHub Action** (`uses: glbforge/glbforge@main`): analyzes changed GLB/glTF in PRs, posts a sticky report-card comment, gates on budget. Live-tested on PR #1 — score table + findings + fix hint posted by the bot
- [x] **Action optimize mode** (2026-09-07): `optimize: true` optimizes failing changed assets (sibling `.web.glb` or `replace: true`), caches outputs by content hash + profile + CLI version via actions/cache (exact hits — deterministic), opens/updates a PR against the PR branch (peter-evans/create-pull-request) with a before/after + SSIM table; fork PRs get a workflow artifact; gate passes when the optimized output passes. Logic dry-run locally (cache hit byte-identical; gate 0 after optimize). Needs a live PR run to confirm the bot-branch plumbing
- [ ] Launch content: the numbers sell it (89MB→5.5MB, 40KB beveled logo). three.js forum, r/threejs, X creative-coding

## Pre-launch: Forge upgrades + hosted demo

- [x] **Layered color extrusion** (`--layers N`, studio "layered colors" toggle): k-means color
  quantization (majority-filtered labels kill AA halos) → per-color trace → stepped depths,
  backs coplanar, flat per-layer materials. Default 4 layers = exactly the mobile-hero
  draw-call budget. Verified: plushqlty logo → 4 layers, 41k tris, score 95
- [x] **Pillow relief** (`--pillow <m>`, studio toggle): exact EDT → `H·sqrt(min(D,R)/R)` dome on a ring-edge-aware subdivided front cap (T-junction-free by construction; watertight verified). Composes with layers = embroidered-patch look. Deferred: luminance emboss
- [x] **Material presets** (`--preset`, studio dropdown): enamel (layer-aware: metal base + gloss fills), chrome, neon (emissive from cluster colors / glows the artwork when textured), acrylic (KHR_materials_transmission), rubber
- [x] **Forge v2 quality pass** (post-launch): angle-aware Chaikin contour smoothing (rounds staircase noise, preserves star points and letter corners), artwork texture projection onto color layers (gradients survive + depth), luminance micro-relief, studio contact shadows. Full stack verified watertight (0/0/0) on real logos
- [x] glbforge.dev landing page (`site/`, zero-build static): live `<model-viewer>` embeds of forged assets (meshopt decoder wired), stats strip, pipeline grid, npx CTAs, MCP + Action snippets. Deploy = connect repo to Cloudflare Pages, output dir `site`
- [x] **Studio in the browser** (glbforge.dev/studio): core made isomorphic (lazy
  sharp/node imports, pluggable TextureEncoder, extrudeFromRgba); Studio auto-detects
  its backend (Express API locally, in-browser engine when static). Analyze, forge
  (layers/pillow/presets), optimize (meshopt WASM + canvas WebP), STL — all client-side,
  zero servers, assets never leave the visitor's device. Meshy + KTX2 route to npx.
- [x] Hosted generation, phase 2: purchased credits LIVE (GitHub + Google OAuth, tiered
  costs, packs, Stripe checkout + webhook proven in test mode, gen history). Still open:
  Stripe live-mode flip; Meshy ToS re: resale — an affiliate/volume arrangement may be
  the better structure

## Agent experience (from external product review, 2026-08-20)

- [x] `llms.txt` at glbforge.dev — accurate machine-readable scope so AI assistants describe the project correctly
- [x] MCP prompts (guided workflows): web-ready-mobile-hero, logo-keychain, audit-and-fix-folder
- [x] `audit_directory` tool — session-style multi-file analysis ("optimize everything failing in ./exports")
- [x] Machine-actionable findings: analyze_glb returns `nextActions` (concrete follow-up tool calls)
- [x] **Perceptual verification** (2026-09-07): `optimize`/`ship` render 4 fixed cameras before and after (software rasterizer, 2x SSAA, smooth shading, textured), score SSIM, gate the weakest view on the profile's `minSsim` floor. Failing SSIM = error finding `fidelity/perceptual` + non-zero exit; passing = info finding carrying the number. `glbforge verify a.glb b.glb`. Calibrated on the Meshy fixture: budget pass 0.958, 40k 0.896, 10k 0.73. Cameras are fixed to the reference frame (no re-framing into a pass). Also fixed: renderer/STL/align read raw quantized int16 positions from optimized GLBs (`readFloat` helper)
- [ ] Progress streaming for long tools (MCP progress notifications); polling tools cover generation today
- [x] **Agent-friendly MCP** (2026-09-07): compact cards (verdict, key numbers, top-3 findings, nextActions, drillDown) as text + `structuredContent`; `inspect_report` drill-down (findings filterable by rule prefix/severity, textures, materials, topology, geometry, scene, all); every GLB-touching tool returns a PNG (`preview: thumbnail|turntable|none`) from the software rasterizer; `render_preview` standalone; server split into `createServer()` + stdio bin, tested via the SDK's in-memory client (12 specs). Follow-up same day: `compare_glb` + reference|result|change-heatmap sheet on failing SSIM (`diffHeatmap` in core), `capabilities` tool (keys, KTX2 encoder, versions), tool annotations (readOnlyHint), sha256 on every written file, every error always in the compact card, `ship_asset` takes targetTriangles/lods; repo got its own CLAUDE.md
- [ ] MCP resources for intermediate artifacts (reports, LODs) — previews now ship inline as image blocks
- [x] **`glbforge init`** (2026-09-07): CLAUDE.md section between `<!-- glbforge:start/end -->` markers, `glb:*` npm scripts + devDependency, MCP registration merged into `.mcp.json` / `.cursor/mcp.json`; idempotent (second run = all unchanged), `--dry-run`, tested (3 specs). Plus `glbforge audit <dir>` (core `auditDirectory`, shared with the MCP tool) as the `glb:check` gate
- [ ] Documented composition patterns with filesystem/image-gen/Blender MCP servers
- [ ] Studio: "copy MCP command for this asset" (npx mode)

## Pipeline depth (review-sourced)

- [ ] Fixture zoo + per-generator rules for Hunyuan/TRELLIS/TripoSR/Tripo/Rodin (we now generate these in-house — self-feeding corpus)
- [x] **Animation/skinning** (2026-09-07): deforming prims (JOINTS_0 or morph targets) take `simplifyDeformingPrimitive` — meshopt `simplifyWithAttributes` with WEIGHTS_n + normalized per-target delta magnitude as attributes, vertex locks on dominant-joint edges, LockBorder, shared compaction remap for all attributes + targets. Skins/IBMs/clips untouched. `scene/animated-asset` info rule. Tested on a rigged cylinder (blend band survives, weights normalized, deterministic, GLB round trip)
- [x] **USDZ export** (2026-09-07): `glbforge usdz` / MCP `export_usdz` — UsdPreviewSurface (baseColor/MR channel outputs/normal/occlusion/emissive/alpha), WebP→PNG/JPEG via sharp, own store-only zip writer (64-byte aligned, fixed timestamps, deterministic). Static bind pose. Binary crate layer + iPhone verification landed 2026-09-08 (see Status section)
- [x] **Versioned budget profiles + methodology** (2026-09-07): `Profile.version` + per-cap `rationale`; `PROFILE_VERSIONS` keeps every published version frozen (tested); `getProfile('mobile-hero@1')` pins, bare name = latest; labels `name@N` in CLI/Action/MCP; `list_profiles rationale=true`; docs/BUDGETS.md + glbforge.dev/budgets (model behind the numbers, score computation, SSIM calibration, changelog)
- [ ] Scene-level budgets: analyze a set of GLBs against a shared budget
- [ ] UV unwrap / retopo / normal baking as optional pluggable backends (keep pure-Node default)
- [x] Studio: fidelity metrics + change heatmap shipped 2026-09-08 (see Status). Still open: recipe presets mirroring MCP prompts

## v1.0 — Product bets (choose after usage data)

- [ ] Hosted drag-and-drop: GLB in → report + optimized asset out (free tier = lead gen)
- [ ] Team budgets: asset perf dashboards, budget history, Slack alerts ("asset over budget")
- [ ] Vertical templates: product-configurator starter, marketing-hero starter (paid)
- [ ] Seedance bridge (original vision, deferred deliberately): optimized 3D → turntable/hero video; 3D pose/camera scaffolds driving video generation

## Phased plan (strategy brief, 2026-08-20) — generator → GLBForge beats generator alone

- **Phase 0 (shipped)**: Meshy-aware analysis (generator fingerprinting incl. Meshy 7's
  documented weak spots — hair clumping, repeated-pattern drift), self-feeding fixture
  corpus (we generate Hunyuan/TRELLIS/TripoSR in-house), JSON parity, llms.txt, rich MCP
  descriptions.
- **Phase 1 (core shipped)**: `glbforge ship` + MCP `ship_asset` — one-call hybrid route
  (flat art → forge; photos → generative) → optimize → budget gate, with a fidelity bound
  reported on simplification. Open: progress streaming; pluggable retopo/UV backends.
- **Phase 2 (in progress)**: [x] measured geometry-deviation metrics SHIPPED — the training/
  eval harness: `glbforge align` (point-to-surface chamfer + F-scores + part-level IoU after
  octahedral rigid alignment; validated: identity ≈ perfect, our optimizer's 232k→150k
  simplification measures 0.81% chamfer, inside its reported 1% fidelityBound) and
  `glbforge dataset` (deterministic software renderer: 10 known-camera views + mesh +
  cameras.json per asset — fine-tuning pairs, ~1s/asset, zero GPU; now smooth-shaded from
  vertex normals) + perceptual SSIM verification wired into every optimize; previews,
  comparison sheets, skinning preservation, and USDZ export shipped in v0.5.0. Open: MCP
  resources; collision meshes; part separation; usdc/UsdSkel; Studio metric overlays.
- **Phase 3**: team dashboards + regression alerts; vertical starters; hosted free-tier
  lead-gen (local-first stays primary); rule corpus as compounding moat; video bridge only
  if usage justifies.

## Standing principles

- Deterministic core; generation is the only stochastic step
- Budgets are contracts (exit codes), not advice
- Every new generator artifact teaches a named rule
- Human approval points stay; outputs stay editable
