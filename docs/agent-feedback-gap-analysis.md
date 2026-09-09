# Agent-feedback upgrade — Phase 0 discovery and gap analysis

Written 2026-09-08 against commit `0366db9` (v0.5.0 + UsdSkel + blend shapes),
before any implementation. Scope: the "MCP Connector Upgrade: Agent-Oriented
Feedback" spec. Sections 1–4 are the discovery findings; section 5 is the
per-item gap table; section 6 lists what the current stack cannot do and why;
section 7 is the implementation plan the rest of the work follows.

## 1. Where things live

| Concern | Location | Notes |
|---|---|---|
| MCP server entry point | `packages/mcp/src/index.ts` → `createServer()` in `packages/mcp/src/server.ts` | stdio transport, `@modelcontextprotocol/sdk` 1.30 (`registerTool` supports `outputSchema` + `structuredContent`) |
| Tool registry | `packages/mcp/src/server.ts` (17 `server.registerTool` calls, 3 prompts) | one file; result shaping in `packages/mcp/src/compact.ts` (`compact`, `section`, `reply`) |
| Preview rendering for agents | `packages/mcp/src/preview.ts` | thumbnail (1 view) / turntable (2x2) / comparison sheet |
| GLB pipeline | `packages/core/src/analyze/*` (stats + 14 lint rules in `rules.ts`), `optimize.ts`, `lod.ts`, `skinning.ts`, `extrude/*`, `stl.ts` | pure gltf-transform + meshoptimizer + sharp |
| USD pipeline | `packages/core/src/usdz.ts` (glTF → USD layer IR), `usd-ir.ts` (IR + usda writer), `usdc.ts` (crate 0.8.0 writer), `usd-skel.ts` (UsdSkel + BlendShape), `zip.ts` (store-only 64-byte-aligned zip writer + `listZip`) | **write-only**: there is no USD reader anywhere in the repo |
| Renderer | `packages/core/src/harness/render.ts` | deterministic CPU rasterizer, fixed rigs (`verifyRig` frozen, `thumbnailRig`, `defaultRig`), `renderRaw` / `renderViews`; static pose only |
| Perceptual / geometric verification | `harness/perceptual.ts` (SSIM), `harness/align.ts` (chamfer / F-score), `harness/sheet.ts` | |
| Budget profiles | `packages/core/src/profiles.ts` (`mobile-hero`, `desktop-hero`, `product-configurator`, versioned; tests freeze v1 caps and the exact profile-name list) | web-delivery oriented; no AR / visionOS profile |
| Existing validation | `analyze()` → findings with `ruleId` (`perf/*`, `tex/*`, `geo/*`, `topo/*`, `mat/*`, `scene/*`, `gen/*`, `fidelity/perceptual`) | free-text `message` + `suggestion`; no prim path; severities `error|warn|info` |
| Tests | `packages/core/test/*.test.ts` (32), `packages/mcp/test/server.test.ts` (12, in-memory MCP client) | fixtures are LFS (34–93 MB) and self-skip in CI; small fixtures are generated in code (`test/fixtures.ts`) |
| Docs | `README.md`, `docs/BUDGETS.md`, `packages/mcp/README.md`, `site/llms.txt`, `ROADMAP.md` | no `schemas/`, no `docs/error-codes.md`, no `CHANGELOG.md` |

## 2. Tools exposed today

Every tool returns `content: [{type:'text', text: JSON}, {type:'image'}?]` and
the same JSON as `structuredContent`. None has an `outputSchema`. No response
carries `ok`, `summary`, `duration_ms`, or a typed `errors[]`.

| Tool | Annotations | Input | Returns today |
|---|---|---|---|
| `capabilities` | read-only | – | versions, provider keys present, KTX2 encoder, profiles, cwd |
| `analyze_glb` | read-only | `path`, `profile`, `topology`, `preview` | compact card: score, passed, verdict, counts, `findings{errors,warnings,info}`, `topFindings[{ruleId,severity,message}]`, `nextActions`, `drillDown`, sha256 + PNG |
| `inspect_report` | read-only | `path`, `profile`, `section`, `ruleId`, `severity` | one `AnalysisResult` section: findings / textures / materials / topology / geometry / scene / all |
| `render_preview` | writes files | `path`, `view` (thumbnail\|turntable), `size`, `out` | camera names, size, PNG (2x2 fixed rig); no camera position/target |
| `compare_glb` | read-only | `reference`, `candidate`, `profile`, `minSsim`, `textures`, `geometry`, `size` | SSIM per view + threshold/pass, optional chamfer/F-score, 3-panel sheet PNG |
| `list_profiles` | read-only | `rationale` | caps per profile (+ rationale text) |
| `audit_directory` | read-only | `dir`, `profile`, `recursive` | per-file score rows, `failing[]`, `nextActions` |
| `optimize_glb` | writes files | `path`, `out`, `profile`, `targetTriangles`, `lods`, `textures`, `compress`, `textureFormat`, `verify`, `preview` | `outPath`, sha256, savedPct, `steps[]` (free text), before/after numbers, fidelity (bound + SSIM), compact after-card, LOD files, PNG |
| `ship_asset` | writes files | `input`, `out`, `profile`, `textureFormat`, `verify`, `targetTriangles`, `lods`, `preview` | same as optimize, or a routing instruction for photographic images |
| `extrude_image` | writes files | image + ~18 forge params, `preview` | out path, bytes, sha256, mesh stats, `nextActions`, PNG |
| `export_stl` | writes files | `path`, `out`, `sizeMm`, `preview` | out, bytes, sha256, triangles, mm size, watertight + edge counts, PNG |
| `export_usdz` | writes files | `path`, `out`, `jpeg`, `format`, `preview` | out, bytes, sha256, packed files, counts, skeletons/frames, `warnings[]` (free text), PNG |
| `generate_image_to_3d` / `generation_status` | network | image, model / requestId, download, out | request id / status / downloaded file + PNG |
| `meshy_create_task` / `meshy_task_status` / `meshy_download` | network | task params / ids | task id / status / downloaded file + PNG |

Silent mutations that exist today and are reported only as free-text `steps`
or not at all: `optimize` joins primitives, palettes materials, flattens the
node hierarchy, welds, generates smooth normals, re-encodes textures;
`export_usdz` generates normals for normal-less prims, flips V, binds a
default material to material-less prims (as of `0366db9`), transcodes
WebP → PNG/JPEG, keeps only 4 joint influences, exports only the first clip;
`export_stl` rescales to millimetres and rotates Z-up; the renderer computes
smooth normals for normal-less meshes.

## 3. Libraries and their introspection

- **GLB: `@gltf-transform/core` 4.x** (+ `extensions`, `functions`),
  `meshoptimizer` 0.22, `sharp` 0.35. Full document model: nodes, meshes,
  primitives, accessors, materials + texture infos, textures/images, skins
  (joints + inverse bind matrices), animations (channels/samplers with
  interpolation), morph targets + weights, extensions. Quantized accessors
  must be read through `readFloat()`. Reads GLB and glTF+external files
  (throws on a missing external image/buffer — no partial load).
  `ImageUtils.getSize` gives PNG/JPEG/WebP/KTX2 dimensions from headers.
- **USD: none.** No `pxr`, `usd-core`, or `tinyusdz` in the JS stack. The
  crate format is understood well enough to write it (`usdc.ts`, validated
  byte-for-byte against Pixar's writer) and the layer IR covers everything
  GLBForge emits, but nothing reads `.usda`, `.usdc`, or `.usdz`. The only
  reader is the *test oracle* `packages/core/test/usd-oracle.py` (Pixar
  `usd-core` in a venv, opt-in via `GLBFORGE_PXR_PYTHON`) — not something the
  MCP server can depend on ("pure Node, no Blender" applies to Python too).
- **Zip:** `listZip()` in `zip.ts` already parses local headers (name,
  offset, size, method) — enough for the 64-byte alignment / store-only
  checks.

## 4. Renderer

A deterministic software rasterizer exists (`harness/render.ts`): fixed rigs,
Lambert shading, base-color textures, supersampling, no GPU. Constraints and
gaps relative to the spec:

- Renders a gltf-transform `Document` only; no USD input.
- Static pose only: world matrices from the node tree, no animation
  evaluation, no CPU skinning, no morph-target application. `usd-skel.ts`
  already has the pieces (`sampleChannel`, `compose`/`mul`/`invert`,
  per-frame joint globals) — they are used for export, not rendering.
- Cameras are unit-sphere directions framed automatically; no explicit
  `{position, target, fov}` input, and `render_preview` does not return the
  camera it used.
- Turntable is the 4-camera verify rig tiled 2x2; no N-angle contact sheet.
- No video/GIF output. `sharp` 0.35 can write animated GIF (cgif); there is
  no ffmpeg, so `.mp4` is out of reach without a new native dependency.

Lightest option that fits the stack: keep this rasterizer (it is the thing
that makes previews deterministic) and add an optional posed path
(animation → node TRS → world matrices → CPU skinning + morph deltas) that
feeds the same `rasterize()`, plus a fragment source built from the USD reader
so USD files render through the same code. The default static path must stay
byte-identical because `verifyRig` SSIM numbers are frozen contracts.

## 5. Gap table

Legend: **exists** / **partial** / **missing**. "GLB" and "USD" columns say
whether the underlying capability is there for each input family.

### Design principles

| Item | Status | Notes |
|---|---|---|
| Structured first, renders opt-in | partial | JSON + `structuredContent` everywhere, but renders are opt-**out** (`preview` defaults to `thumbnail`); no `outputSchema` |
| `prim_path` on everything | missing | findings carry names in `data` at best; nothing carries a path or node index |
| Stable error codes | missing | `ruleId` strings exist (`perf/triangle-budget`…) but are not the spec's enumerable codes; USDZ warnings are free text |
| Explicit severity | partial | `error|warn|info` on analysis findings; `warn` vs spec's `warning`; export warnings have no severity |
| One-line `summary` | missing | `verdict: 'within budget'` on cards only |
| `duration_ms` | missing | |
| Never silently fix | missing | see the list in §2; nothing is emitted with a code/severity |
| `dry_run` + diff | missing | no mutating tool has it |

### Common envelope

| Item | Status |
|---|---|
| `{ok, summary, duration_ms, errors[], data}` | missing — every tool returns its payload at top level |
| `errors[].{code, severity, prim_path, property, message, suggested_fix}` | missing — closest is `Finding{ruleId, severity, message, suggestion, data}` |

### Tool 1 — `validate`

| Field | GLB | USD | Notes |
|---|---|---|---|
| `opens` | partial (read throws) | missing | |
| `format` detection | missing | missing | by extension/magic |
| `usdz_spec_compliant` + violations | n/a | partial | `listZip` + test assertions check alignment/method; no allowed-type check, no public function |
| `schema_errors[]` | missing | missing | |
| `default_prim`, `up_axis`, `meters_per_unit` | n/a (glTF fixes Y-up / metres) | missing (writer sets them; no reader) | |
| `layer_stack[]` | n/a | missing | needs USD reader; composition arcs (references/payloads/sublayers) cannot be *resolved* without pxr — reported as declared, not composed |
| `arkit_compatible` + issues | partial (export warnings list transmission/clearcoat, KTX2, >4 influences) | missing | |
| quick < 1 s, no renders | partial | – | `analyze(topology:false)` on 50k tris is ~50–100 ms; needs measuring in the test |
| `mode="full"` with perf + render | partial | missing | |

### Tool 2 — `inspect_geometry`

| Field | GLB | USD | Notes |
|---|---|---|---|
| per-mesh counts | exists (`PrimitiveStats` per primitive) | missing | no path/index |
| `is_manifold`, `degenerate_face_count` | partial | missing | topology is scene-wide totals only (`TopologyStats`), not per mesh |
| `normals: authored|generated|missing` | partial (`primsMissingNormals` count) | missing | |
| `inverted_normal_face_count` | missing | missing | |
| `uv_sets[]` + `out_of_range` | partial (attribute names) | missing | no range check |
| per-mesh `bounding_box` (world) | missing (scene bounds only) | missing | |
| `world_bounding_box`, `pivot_position`, `pivot_at_base` | partial (bounds), missing, missing | missing | |
| `scale_warnings[]` | partial | missing | `scene/scale-sanity` fires at <0.01 / >100; spec wants <0.01 / >20, configurable |

### Tool 3 — `inspect_animation`

| Field | GLB | USD | Notes |
|---|---|---|---|
| `has_animation`, time range, fps, duration | partial (`scene.animations` count only) | missing | |
| `animated_prims[]` with properties | missing | missing | |
| `skeletons[]` (joint_count, bound_meshes, max influences, unbound vertices) | missing | missing | `usd-skel.ts` computes joint order/paths for export |
| `blend_shapes[]` + `is_driven` | missing | missing | |
| `root_motion_detected` | missing | missing | |
| `SKELETON_UNBOUND`, `MESH_NOT_DEFORMING`, `BLENDSHAPE_UNDRIVEN`, `ANIMATION_ZERO_LENGTH` | missing | missing | |

### Tool 4 — `inspect_materials`

| Field | GLB | USD | Notes |
|---|---|---|---|
| `materials[]` with shader_type, bound_meshes | partial (name, alphaMode, doubleSided, slots) | missing | |
| `unbound_meshes[]` | partial (`mat/no-material` count) | missing | |
| `textures[]` with resolution/format/size/channel/color_space/used_by | partial (name, mime, w/h, bytes, alpha, VRAM, slots) | missing | no channel / color space / resolved flag |
| `missing_textures[]` | missing | missing | GLB loader throws on a missing external image instead of reporting |
| `texture_memory_estimate_mb` | exists (`textureVramTotal`) | missing | |
| `non_power_of_two[]`, `oversized[]` | missing, partial (`tex/oversized` vs profile cap) | missing | |
| codes `TEXTURE_UNRESOLVED`, `MATERIAL_UNBOUND`, `MESH_NO_MATERIAL`, `TEXTURE_OVERSIZED`, `TEXTURE_NPOT` | missing | missing | |

### Tool 5 — `analyze_performance`

| Field | GLB | USD | Notes |
|---|---|---|---|
| totals, draw-call estimate, file size, GPU memory | exists | missing | |
| `prim_count`, `scene_graph_depth` | partial (node count) | missing | |
| `instancing_candidates[]` | missing | missing | |
| `budget_check` with per-overage `worst_offender_prim_path` | partial (`perf/*` findings, no paths) | missing | |
| profiles `ios_ar` / `visionos` / `web` / custom, in a documented config | missing | missing | existing profiles are web-delivery contracts; `profiles.test.ts` pins the exact name list, so AR profiles go in a separate documented config rather than into `PROFILES` |

### Tool 6 — `render`

| Field | Status | Notes |
|---|---|---|
| `view=front` | missing | rigs are 3/4 views |
| `view=turntable` N-angle contact sheet (default 8) | partial | 4 angles, 2x2 |
| `view=custom` with `camera` | missing | |
| `frame` (animation time) | missing | static renderer |
| returns `camera{position,target,fov}` | missing (computed internally, not returned) | |
| USD input | missing | |

### Tool 7 — `render_animation_strip`

| Field | Status |
|---|---|
| contact sheet of requested frames | missing (needs posed rendering) |
| `include_clip` `.gif` | missing (feasible with sharp) |
| `include_clip` `.mp4` | **cannot** — no encoder in the stack (§6) |

### Tool 8 — mutating tools

| Field | Status |
|---|---|
| `dry_run` | missing on all of `optimize_glb`, `ship_asset`, `extrude_image`, `export_stl`, `export_usdz`, `meshy_download`, `generation_status(download)` |
| `render: bool` checkpoint | partial (`preview` enum exists; same idea, keep and add `render` alias) |
| `diff{added_prims, removed_prims, changed_properties}` | missing |
| `post_validation` | missing |

### Tool 9 — `inspect_all`

| Status |
|---|
| missing (closest is `inspect_report section=all`, GLB only, no envelope) |

### Acceptance criteria

| Item | Status |
|---|---|
| JSON schemas in `schemas/` | missing |
| `docs/error-codes.md` | missing |
| failure-mode fixtures (8 listed) | missing — one rigged cylinder generator and two LFS Meshy fixtures exist |
| `validate(quick)` < 1 s on 50k triangles | unmeasured |
| integration test: fixture → expected code + prim_path | missing |
| no unreported mutation | missing |

## 6. What the current stack cannot do (logged, not skipped silently)

1. **Composed USD stage.** Without pxr there is no composition engine.
   The upgrade adds a pure-TS reader for a *single root layer* (`.usda`,
   `.usdc` crate 0.8.0 as written by Pixar and by GLBForge, `.usdz` with the
   layer + textures). References, payloads, sublayers, variant sets,
   inherits/specializes and value clips are **reported in `layer_stack[]`
   as declared but not resolved**; prims behind them are invisible to the
   inspectors. Every metric is computed from that one layer. An
   `UNRESOLVED_COMPOSITION_ARC` info diagnostic is emitted whenever an arc
   is seen. This covers the AR Quick Look case (single-layer usdz packages,
   which is what `export_usdz` writes and what Apple's pipeline expects) and
   flags the rest honestly.
2. **`.mp4` clips.** No video encoder (no ffmpeg, no WebCodecs in Node).
   `include_clip: true` produces an animated `.gif` via sharp; `.mp4` is
   reported as `clip: null` with a `CLIP_FORMAT_UNSUPPORTED` info.
3. **USD schema validation against the real schema registry** (property
   types per prim type, required attributes). The reader checks the
   structural subset the exporters and AR Quick Look care about
   (Mesh/Xform/Scope/Material/Shader/Skeleton/SkelAnimation/BlendShape/
   SkelRoot, UsdPreviewSurface inputs, primvar shapes, binding rels). Type
   errors outside that subset are not detected.
4. **Z-up detection for GLB.** glTF is Y-up by definition; a "Z-up asset" can
   only be detected for USD (`upAxis`). For GLB, `inspect_geometry` reports
   the bounding-box aspect and a `ZUP_SUSPECTED` info when a character-like
   asset is taller along Z than Y — a heuristic, documented as such.
5. **`is_manifold` on non-triangle prims.** Points/lines/strips/fans and USD
   n-gons: n-gons are triangulated (fan) for counting; is_manifold is
   computed on the triangulated mesh.
6. **GPU memory / draw calls are estimates.** Same model as the budgets
   (RGBA8 + mips, KTX2 ~4 bpp, one draw call per primitive/material binding);
   not a measurement on a device.

## 7. Implementation plan (follows the spec's priority order)

1. **Core `inspect/` module (isomorphic, pure).** A format-agnostic
   `SceneIR` (nodes with local/world transforms, mesh primitives with
   positions/indices/normals/uv sets/joints/weights/morph targets + a stable
   `prim_path`, materials + texture bindings with channel/color space,
   textures with resolved flag + header-sniffed size, skins/skeletons,
   animations as sampled channels) produced by two adapters: gltf-transform
   `Document` → IR, and USD layer → IR. All inspectors, the validator, the
   performance check, the differ and the posed renderer consume the IR, so
   GLB and USD get the same fields and the same codes.
   - `prim_path` for GLB: `/Asset/<Node>_<nodeIndex>/Prim_<i>`,
     `/Asset/Materials/<Name>_<i>`, `/Asset/Textures/<Name>_<i>`,
     `/Asset/Skel_<i>`, `/Asset/Animations/<Name>_<i>`,
     `/Asset/<Node>_<n>/Prim_<i>/BlendShape_<t>` — the shape `export_usdz`
     writes, plus explicit `node_index` / `mesh_index` / `primitive_index` /
     `material_index` / `texture_index` fields so agents can key on indices.
     For USD input, real prim paths.
   - Diagnostics: `{code, severity: error|warning|info, prim_path, property,
     message, suggested_fix}`; a single `ERROR_CODES` registry (code →
     severity, meaning, typical fix) that generates `docs/error-codes.md`
     and is tested against it.
2. **USD reader** (`usd-read/`): tolerant `.usda` parser, `.usdc` crate
   reader (TOC, TfFastCompression with a real LZ4 block decoder, integer
   compression, compressed int/float arrays, TimeSamples, ListOps), `.usdz`
   container reader + spec check. Validated against files written by Pixar's
   `usd-core` (already installed in the session's oracle venv) and by our own
   writer.
3. **Inspectors** in priority order: animation → geometry → materials →
   performance (`ios_ar`, `visionos`, `web`, custom; documented in
   `docs/performance-profiles.md`).
4. **Renderer**: fragments from IR (static path unchanged, byte-identical);
   posed fragments at time `t` (node animation, CPU skinning, morph deltas);
   `render` (front / N-angle turntable / custom camera, returns camera) and
   `render_animation_strip` (stills sheet + optional GIF).
5. **MCP**: envelope + `outputSchema` on every tool (existing payloads move
   under `data` unchanged; input schemas untouched, fields only added);
   findings mapped to codes + paths; silent mutations become diagnostics;
   `dry_run` / `render` / `diff` / `post_validation` on mutating tools;
   `inspect_all`. Schemas exported to `schemas/*.json` from the zod output
   schemas by a build script and checked in tests with ajv.
6. **Fixtures + integration test**: deterministic generators for each
   failure mode (small, built at test time — LFS is not pulled in CI) plus
   committed `.usda` text fixtures for the USD-only cases; one test per
   fixture asserting code + `prim_path`; a 50k-triangle timing test for
   `validate(quick)`.
7. **Docs**: `docs/error-codes.md`, `docs/performance-profiles.md`,
   `CHANGELOG.md`, and the sync targets from `CLAUDE.md` (`README.md`,
   `site/llms.txt`, `packages/mcp/README.md`, `ROADMAP.md`).
