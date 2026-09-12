# Changelog

## Unreleased

### Added

- **`ship --json`**: one document, not two — the route taken (`forge` /
  `generation` / `glb`), what the forge decided (intermediate path, triangles,
  layers, and the measured flatness that chose them), the output path,
  `passed`, and the full optimization report nested under `optimize`. The
  decision half is not recoverable from the optimize report, and parsing it
  out of prose was the only way to read it before. Progress lines on the
  generative routes go quiet under `--json` so stdout stays parseable.

### Fixed

- **Forged assets no longer fail the perceptual gate on a texture artifact.**
  `extrude` projects the source artwork as an OPAQUE base-color texture, but
  artwork with a transparent background carries no colour outside its
  silhouette — those texels decode to `(0,0,0,0)`. The wall and bevel UVs
  sample exactly that 1-2 px antialiased boundary, and `optimize`'s WebP
  pass both rings across the hard art/void discontinuity and discards the
  RGB of fully transparent texels (libwebp cleans them to compress the alpha
  plane). A 1 px texture error became a stippled band along the whole rim:
  a 70 mm beveled enamel badge measured 92.3% min SSIM against the 94%
  floor, 86.6% flat and 86.7% with a pillow, while the same asset scored
  99.7% with `--no-textures`.
  The forge now pads the artwork's colour out past the silhouette (nearest
  fully opaque texel, exact EDT) and flattens the projection to opaque
  before embedding it — `flattenProjection` in `core/src/extrude/bleed.ts`,
  shared by the CLI/MCP path and the Studio. The same badge now measures
  99.8-99.9% min SSIM, and the optimized asset is *smaller*, because a
  padded exterior costs the encoder almost nothing where the discontinuity
  cost it a lot (18.3 KB → 9.3 KB beveled, 16.1 KB → 7.1 KB flat).
  Forge geometry is byte-identical — positions, normals, UVs and indices all
  hash the same before and after, so the frozen dogfood table does not move:
  28 forge builds (4 source images x plain / bevel / layered / neon-3 /
  plush-4 / pillow / emboss), each linted under `authoring@1` as forged and
  again after a `mobile-hero` pass, produce identical rule sets and identical
  geometry hashes on both sides. The six `guardian.*` / `veiled-guardian.*`
  rows — the only rows whose source is checked in — were rebuilt from
  `fixtures/veiled-guardian-tex4k.glb` and still read exactly as frozen
  (152 non-manifold edges, 32 degenerate, one shell; lod1 39,952 tris, lod2
  9,970).
  One second-order effect, on single-colour artwork only: the flattened
  projection is a solid texture, so `prune()` now folds it into
  `baseColorFactor` (sRGB-correct) and drops the texture and its UV set.
  `assets/sample-ring.glb` is regenerated (`extrude assets/ci-ring.png
  --bevel 0.01`); its geometry hash, 2,048 triangles and watertight topology
  are unchanged, the embedded PNG shrinks 694 B -> 524 B.
- **`ship` no longer overwrites `<input>.glb`.** The forge route wrote its
  intermediate to the input's name with a `.glb` extension, so
  `glbforge ship logo.png` silently replaced a `logo.glb` the user had
  authored. Intermediates now use GLBForge's own namespace — `*.forge.glb`
  for the forge route, `*.gen.glb` for the generative ones (both skipped by
  `audit` and `watch`, like `*.web.glb`) — and the final output is named for
  the input on every route.
- **`ship` stops slicing gradients into stacked slabs.** It forged every image
  with a hardcoded `layers: 4`, and k-means returns four clusters whether or
  not the artwork has four colours: a gradient logo became four layers with
  noisy contours (190k triangles from a five-point star, 5.3 MB, simplified
  back to the budget and then failing the SSIM gate at 82.5%). `layers: 'auto'`
  (new; also `glbforge extrude --layers auto`) measures the artwork first —
  coarse colour histogram of the solid pixels, layered only when a few flat
  colours cover ≥85% of it — and reports the decision. That star now forges
  as one shell at 2,760 triangles; a genuinely flat three-colour emblem still
  layers.
- **Relief subdivision has a ceiling** (`maxReliefTriangles`, asset-wide across
  layers and caps). Pillow/emboss caps subdivide uniformly 4:1, which cost a
  three-colour emblem 247,376 triangles through `ship`; it forges at 22,144 now
  with the same measured fidelity (SSIM 96.8%, weakest view 94.5% vs 94.6%).
  `extrude`'s own defaults are unchanged.
- **`optimize` no longer reports a fidelity failure as "still over budget".**
  The perceptual floor is not a budget row: when every cap passes and only
  `fidelity/perceptual` fails, the verdict now reads "within <profile> budget,
  but visibly lossy" (`analyze` on the same file said `100/100 ✓ ship it`).
- **A closed stdout no longer crashes the CLI.** `glbforge ship x.png | head -1`
  died with an unhandled `EPIPE` and a stack trace — a crash report for
  something the user asked for. Both output streams now swallow `EPIPE`, and
  deliberately do *not* call `process.exit(0)` the way the common idiom does:
  this CLI's exit code is its contract, so a budget or expectation failure
  piped into `head` still exits 1 rather than being laundered into success.
- **`diff/origin-moved` stopped calling a relabel a regression.** An origin
  landmark is a classification, and adding vertices can move the vertex
  centroid onto the origin with nothing moving at all — the rule then warned
  "The geometry moved 0.00 mm". A landmark change with no displacement is now
  reported at info, stating what was measured; a real shift beyond
  `originTolerance` still warns. `origin.moved` in the report is displacement,
  not "the rule fired".
- **Perceptual verification scored base color across two transfer curves.**
  The software renderer sampled base-color *textures* as if their bytes were
  already linear, while `baseColorFactor` is stored and used as linear. Any
  surface that moved between those two slots was compared against itself
  through two different curves — and the pipeline moves colour between them
  on its own: `prune()` folds a base-color texture that is one solid colour
  into the factor and drops the image. That asset is correct and smaller, but
  `optimize` reported visible loss and failed the budget. Isolated, the fold
  scored 0.9045; it now scores 1.0000.

  The renderer now decodes texels through sRGB, composes `factor * texture`
  the way glTF defines it (it previously let the texture replace a non-white
  factor entirely), shades in linear light, resolves supersamples in linear
  light, and sRGB-encodes the output — so rendered previews and dataset pairs
  are display-referred too, not just internally consistent.

  This moves every SSIM the tool reports, which is why `verifyRig()` is
  documented as frozen. The floors were re-derived rather than assumed: on
  the Meshy 7 fixture the mobile-hero budget pass goes 0.9594 → 0.9637 (4K
  textures) and the 40k counter-example 0.8999 → 0.9132, so 0.94 still sits
  between them. **No cap changed**, but all three profiles are republished as
  `@2` so the rationale text matches the measurement and `@1` keeps meaning
  what CI recorded before this release. Full table: `docs/BUDGETS.md`.
- Nearest-neighbour, mip-free texture sampling is now documented as a
  deliberate determinism trade-off (`sampleTexel` in
  `packages/core/src/harness/render.ts`) rather than an accident: the
  renderer is blind to minification aliasing a viewer would show, blunted by
  the decoder's 512px downscale and 2x supersampling.

### Changed

- `srgbToLinear` / `linearToSrgb` are published from `@glbforge/core`
  (`packages/core/src/color.ts`), replacing three private copies of the
  transfer function.
- **pnpm 12 and `pnpm/setup@v2`.** `pnpm/action-setup` is superseded by
  `pnpm/setup`, which installs pnpm and the runtime in one step, caches the
  store keyed on the lockfile, and runs the install itself: three workflow
  steps become one in `ci.yml` and `action-selftest.yml`. `release.yml` keeps
  `actions/setup-node` — npm OIDC trusted publishing needs the `.npmrc` its
  `registry-url` writes, which `pnpm/setup` does not produce.
  - `pnpm/setup@v2` installs pnpm 11+ only, so `packageManager` moves from
    `pnpm@10.15.1` to `pnpm@12.4.1`. `pnpm-lock.yaml` stays at
    `lockfileVersion: '9.0'` and the diff is purely additive (+158 lines of
    `configDependencies` / `packageManagerDependencies` metadata, 0 removed).
  - pnpm 12 turns ignored build scripts from a warning into an error, and
    keeps the decision in `pnpm-workspace.yaml` rather than `package.json`:
    `allowBuilds: { esbuild: false }` records what pnpm 10 already did
    silently. esbuild's binary comes from its `@esbuild/*` optional
    dependency, so nothing needs the script — the Studio's Vite build is
    unchanged.
  - **Upgrading locally takes one command.** pnpm 10's `packageManager`
    self-switch cannot bootstrap pnpm 11 or 12 on macOS arm64: it fetches
    `@pnpm/macos-arm64`, which stopped publishing at 11.26.0 and whose 11.x
    artifact is missing its binary (the failure mode `pnpm/setup@v2`'s release
    notes describe). pnpm 12 ships as `@pnpm/exe.darwin-arm64` instead. Install
    pnpm 11+ by any other route once — `npm install -g pnpm@12` — and the
    `packageManager` pin governs from there. CI is unaffected: `pnpm/setup`
    downloads the binary itself.
- **Every GitHub Action dependency moves to its Node 24 major.** The Node 20
  runtime is deprecated and the runner was already force-migrating these, so
  the versions now say what actually runs. Workflows: `actions/checkout@v7`,
  `actions/setup-node@v7`, `pnpm/action-setup@v6`. The **published action**
  (`action.yml`), which runs on consumers' runners: `actions/cache@v6`,
  `actions/upload-artifact@v7`, `actions/github-script@v9`,
  `peter-evans/create-pull-request@v8`.
  - **Self-hosted runners need Actions Runner 2.327.1 or later** to use the
    GLBForge action from this version on; GitHub-hosted runners already
    qualify. This is the only consumer-visible change — no input, output or
    behaviour moves.
  - Checked rather than assumed: `github-script@v9` breaks
    `require('@actions/github')` and scripts that redeclare `getOctokit`; our
    comment script uses neither (only `require('fs')`, `github.rest.*` and
    `context`). `setup-node@v5+` caches automatically when `packageManager`
    is set — ours already passes `cache: pnpm` explicitly and installs pnpm
    first. `checkout@v7` blocks fork checkout for `pull_request_target` /
    `workflow_run`, neither of which this repo uses.
  - `pnpm/action-setup` now points users at a successor action
    (`pnpm/setup`); staying on `action-setup` for now, that migration is its
    own change.

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
