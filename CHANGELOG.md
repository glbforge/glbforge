# Changelog

## 0.8.0 — 2026-09-11 — inspect: the after-every-edit read for agents

For agents editing assets in a loop. Rule ids and packs: `docs/error-codes.md`
(the `rule` column). Schemas: `schemas/inspect.*.json`, `schemas/diff.*.json`.

### Added

- **`inspect`** (CLI `glbforge inspect <file>`, MCP `inspect`, read-only):
  one pass over a GLB / glTF / USDZ / USDA / USDC that returns measured facts
  and findings, with a one-paragraph summary an agent reads first. Facts:
  shells and watertightness per mesh and scene, bounds in metres, up axis
  with its source, front always `unknown`, origin landmark
  (base-center | center | centroid | elsewhere) with the translation that
  puts it at the base centre, and hierarchy (unapplied transforms with
  rotation angle, non-uniform scale, mirrored nodes). Flags:
  `--profile authoring|<budget>[@N]`, `--packs`, `--no-topology` (rules
  reported as skipped, never silently absent), `--strict` (exit 1 on
  warnings), `--json` (report + `duration_ms`). ~100 ms of inspection on
  the 150k-triangle hero. `inspect_geometry` and `inspect_all` now point
  the edit loop at `inspect`.
- **Rule packs**: findings carry versioned slash ids (`topo/open-edges`,
  pack `core-geometry@1`) as the public API; the SCREAMING codes stay as
  aliases (`rule` column in `docs/error-codes.md`). Messages state measured
  counts only; every `likely_cause` carries its own confidence. Severity is
  the profile's call: pack defaults, overridden by the web budgets (topology
  is informational there) or the new `authoring@1` rule profile; findings
  keep `default_severity` visible.
  - `core-geometry@1`: `topo/open-edges` (with boundary-loop count),
    `non-manifold`, `floating-fragments`, `shells`, `degenerate`. Causes
    attribute optimizer provenance (meshopt + quantization signature, stated
    as a proxy) when present.
  - `core-scene@1`: `origin/outside-bounds`, `origin/not-at-base` (with the
    exact fixing translation), `xform/unapplied` (quantized meshes exempt —
    their node transform is the `KHR_mesh_quantization` encoding),
    `xform/mirrored`, `xform/non-uniform-scale`, `scale/too-small`,
    `scale/too-large`. Params: `originTolerance`, `smallScale`, `largeScale`.
- **`intent@1` / `--expect`**: a free-text or structured expectation
  ("chair, Z-up, meters, single-shell, 0.4-1.2m tall, front -Y, watertight,
  origin base") turns inspect into a contract. Measured checks fail as
  errors (`intent/shells`, `watertight`, `size`, `origin`, `units`);
  `intent/category-scale` is a heuristic warning from a size table with a
  stated confidence; `intent/up-axis` is informational on glTF (Y-up by
  definition) and a warning on USD; `front` is recorded as declared, never
  verified; unparsed tokens are reported. CLI `-e/--expect` (violations
  exit 1); MCP `inspect` takes `expect` as a string or object.
- **`diff@1`** (CLI `glbforge diff <before> <after>`, MCP `diff`, read-only):
  what changed since the last edit and what it broke. Regressions at
  warning, neutral changes at info: `diff/watertight-lost`,
  `open-edges-introduced`, `non-manifold-introduced`, `shells-changed`,
  `origin-moved`, `transform-changed` (dequantization excluded),
  `size-changed` with per-part axis wording, `triangles-changed`,
  `meshes-removed` / `added`, `topology-improved`, and opt-in
  `visual-changed` (`--visual`: front / side / top / iso SSIM with cameras
  fixed to the BEFORE framing). Meshes pair by prim path, then by unique
  name across renumbered nodes. MCP `diff` returns both sha256s as
  `lineage`. Flags: `--visual`, `--size`, `--no-topology`, `--strict`,
  `--json`.
- **Usage counter** (`glbforge usage`): local, opt-in, never networked.
  Off until `GLBFORGE_USAGE=1` or `{ "usage": true }` in
  `$GLBFORGE_CONFIG_DIR` / `~/.config/glbforge/config.json`; JSONL log; a
  failed write never reaches the tool. Every MCP tool call and the CLI
  `inspect` / `diff` / `analyze` commands record; invocations are keyed
  by lineage (same session + path, same path within 2 h, diff edges,
  explicit `--lineage` / `lineage` on inspect and diff), not by file hash,
  so a report says how many reads an asset took to finish. `capabilities`
  reports usage state and file. `--enable` / `--disable` / `--clear` /
  `--since` / `--threshold` / `--json`.

### Changed

- MCP tool count is 27 (`inspect`, `diff` added; every read-only tool is
  annotated). `schemas/` gains `inspect.*`, `diff.*`, `RuleFindingSchema`
  and `ExpectationSchema`; all `$id`s move to 0.8.0.
- `PIVOT_NOT_AT_BASE`, `SCALE_TOO_SMALL` / `SCALE_TOO_LARGE` now name their
  rule ids; new alias codes `ORIGIN_OUTSIDE_BOUNDS`, `XFORM_UNAPPLIED`,
  `XFORM_MIRRORED`, `XFORM_NON_UNIFORM_SCALE`.
- Layered forge output (`--layers N`) bakes each layer's z offset into its
  vertices; every layer node is now identity (previously a node translation,
  which `xform/unapplied` flags). Single-layer output is byte-identical.
- Welded topology (`inspect/topology.ts`) uses radix-sorted edge pairs and
  union-find shells: identical numbers, 2M-triangle fixture 1.4 s → 0.36 s.
- Dogfood policy (`test/packs.test.ts`): the finding set of every
  `examples/*.glb` under `authoring@1` is frozen; the pipeline is not exempt
  from the linter and a rule never softens to accommodate it. With the forge
  winding fix below, no known case remains where the linter and the
  pipeline's own shipping output disagree on geometry.

### Fixed

- **Forge extruder: triangle winding now agrees with the authored normals on
  every face.** Walls and bevel strips were wound toward the interior (the
  image-y flip in `pushVert` was applied to positions but not to the ring
  order), so single-sided viewers culled the near walls and showed the far
  walls' inner faces instead; `inspect` flagged every forge asset with
  `NORMALS_INVERTED`. Displaced (pillow / emboss) caps were also re-tessellated:
  earcut's tangential slivers are flipped toward Delaunay before and after each
  subdivision round, so the height field is sampled by well-shaped triangles.
  Forge output is still watertight and byte-deterministic; pillow/emboss
  vertex positions and triangle counts change (better-shaped caps), so
  re-render any pixel baselines built on them.
- Regenerated with the fixed extruder: `assets/sample-ring.glb` (the Action
  self-test asset; `--bevel 0.01` at current defaults), the landing-page
  showcase models `site/models/plush.glb` and `neon.glb`, and the Studio
  bundle under `site/studio`. The local forge examples were rebuilt the same
  way; the dogfood table's three bevel rows now read `open-edges non-manifold`,
  which the pre-fix extruder produces identically at those settings (bevel
  inset clamping on dense contours), so that is a tracked bevel limitation,
  not a winding regression.

## 0.7.0 — 2026-09-11 — agent-oriented feedback for MCP consumers

For agents driving the `@glbforge/mcp` server. Full spec background:
`docs/agent-feedback-gap-analysis.md`. Codes: `docs/error-codes.md`.
Schemas: `schemas/`.

### Changed (response shape — read this if you parse tool output)

- **Every tool now answers with one envelope**:
  `{ ok, summary, duration_ms, errors[], data }`. What a tool returned
  before is under `data`, field for field unchanged. `ok` is false only when
  the tool could not run (bad path, unreadable file, provider failure); an
  asset with problems is `ok: true` with the problems in `errors`.
- **`errors[]` is the diagnostic list, all severities**:
  `{ code, severity: error|warning|info, prim_path, property?, message, suggested_fix?, data? }`.
  Codes are enumerable and stable (see `docs/error-codes.md`); branch on
  them, not on messages. `prim_path` is the USD prim path, or for glTF
  `/Asset/<Node>_<i>/Prim_<j>`, `/Asset/Materials/<Name>_<i>`,
  `/Asset/Textures/<Name>_<i>`, `/Asset/Skel_<i>`, `/Asset/Animations/<Name>_<i>`
  (indices are also given as fields).
- `analyze_glb` / `inspect_report` / `optimize_glb` / `ship_asset` findings are
  mapped onto codes (`perf/triangle-budget` → `TRIANGLE_BUDGET_EXCEEDED`, …)
  with the worst offender's path.
- Every tool advertises an MCP `outputSchema`; the same schemas are published
  as `schemas/<tool>.output.json` (+ `<tool>.input.json`, `envelope.json`,
  `diagnostic.json`, `index.json`), regenerated by the MCP build.
- Tool names and input schemas are unchanged; inputs were only added.

### Added

- `validate(path, profile?, mode=quick|full)` — GLB, glTF, USDZ, USDA, USDC:
  opens, format, `usdz_spec_compliant` + violations (stored entries, 64-byte
  alignment, allowed types, layer first), `default_prim`, `up_axis`,
  `meters_per_unit`, `layer_stack` (declared arcs — not composed),
  `schema_errors`, `arkit_compatible` + `arkit_issues`. Quick mode is well
  under a second on a 50k-triangle asset (measured in the test suite); full
  mode adds `analyze_performance` and a front render.
- `inspect_geometry` — per mesh: counts, `is_manifold`, degenerate faces,
  `normals: authored|missing`, `inverted_normal_face_count`, UV sets with
  `out_of_range`, world bounds in metres; scene bounds, pivot, `pivot_at_base`,
  `scale_warnings` (thresholds configurable).
- `inspect_animation` — clips, `animated_prims`, skeletons (joints, bound
  meshes, max influences, unbound vertices), blend shapes with `is_driven`,
  root motion. Codes `SKELETON_UNBOUND`, `MESH_NOT_DEFORMING`,
  `BLENDSHAPE_UNDRIVEN`, `ANIMATION_ZERO_LENGTH`, `ANIMATION_NO_MOTION`.
- `inspect_materials` — materials + bindings, `unbound_meshes`, textures
  (resolved, resolution, format, bytes, channel, color space, users, memory),
  `missing_textures`, NPOT / oversized. Codes `TEXTURE_UNRESOLVED`,
  `MATERIAL_UNBOUND`, `MESH_NO_MATERIAL`, `TEXTURE_OVERSIZED`, `TEXTURE_NPOT`.
- `analyze_performance(path, profile=ios_ar|visionos|web|<budget>, custom_limits?)`
  — totals, GPU memory estimate, prim count, scene depth,
  `instancing_candidates`, `budget_check` with `worst_offender_prim_path`
  per overage. Profiles documented in `docs/performance-profiles.md`.
- `render(path, view=front|turntable|custom|thumbnail, time|frame, camera, size, angles)`
  — any supported format, optionally posed at an animation time; returns the
  camera(s) used. Turntable is one contact sheet of N angles (default 8).
- `render_animation_strip(path, frames|times, view, include_clip)` — contact
  sheet of stills; `include_clip` writes an animated GIF (no mp4 encoder in
  this stack — reported as `CLIP_FORMAT_UNSUPPORTED`).
- `inspect_all(path, profile?)` — all of the above merged, errors deduplicated.
- Mutating tools (`optimize_glb`, `ship_asset`, `extrude_image`, `export_stl`,
  `export_usdz`, `generation_status` download, `meshy_download`) accept
  `dry_run` and `render`, and return `diff { added_prims, removed_prims,
  changed_properties }` and `post_validation` (validate quick of the output;
  for `export_usdz` that is the packaging + AR Quick Look check of the
  written usdz).
- Nothing is fixed silently: generated normals, joined primitives, flattened
  hierarchy, welds, re-encoded / transcoded textures, default materials,
  flipped UVs, dropped clips / influences / node animation, axis and scale
  conversions are each an `errors[]` entry with a code.
- Core: `@glbforge/core` exports the inspect layer (`loadScene`, `fromGltf`,
  `fromUsd`, `inspectGeometry`, `inspectAnimation`, `inspectMaterials`,
  `analyzePerformance`, `validateScene`, `poseScene`, `renderScene`,
  `diffScenes`, `ERROR_CODES`) and pure-TypeScript USD readers
  (`readUsda`, `readUsdc` for crate 0.4–0.10, `readUsdz`) validated against
  Pixar-written files.
- Fixtures for every failure mode (`packages/core/test/agent-fixtures.ts`)
  and an integration test that asserts the expected code and `prim_path`
  for each, validates every response against `schemas/`, and times
  `validate(quick)`.
- New MCP prompt `ar-ready-usdz`.

### Known limits (see the gap analysis §6)

- USD composition arcs (references, payloads, sublayers, variants, clips) are
  reported, not resolved; metrics come from the single root layer.
- `.mp4` clips are not produced; GIF is.
- USD schema validation covers the structural subset AR Quick Look and the
  exporters use, not the full schema registry.
