# @glbforge/mcp

MCP server exposing the [glbforge](https://www.npmjs.com/package/glbforge)
pipeline to AI agents (Claude Code, Cursor, ...).

```bash
claude mcp add glbforge -- npx -y @glbforge/mcp
```

Built for agents, not terminals:

- **`inspect`: the after-every-edit read.** Sub-second, semantic, named:
  one connected shell or floating pieces; watertight or holes / overlapping
  faces (welded space — UV seams are not holes); size in metres; up axis;
  origin at the base centre, the centre, or floating off the object;
  unapplied / mirrored node transforms. Every finding is a versioned rule id
  (`topo/open-edges` from `core-geometry@1`, `origin/not-at-base` from
  `core-scene@1`) with `certainty: measured | heuristic`, a `likely_cause`
  carrying its own confidence, and a concrete fix; `front` is always
  `unknown` because no honest heuristic exists. Severity is the profile's
  call: `authoring` (default) warns on topology, `mobile-hero` reports it.
- **One envelope, stable codes, prim paths.** Every tool answers
  `{ ok, summary, duration_ms, errors[], data }`. `errors[]` lists every
  diagnostic as `{ code, severity, prim_path, property, message, suggested_fix }`
  with enumerable codes (`docs/error-codes.md`) and the USD prim path (or
  `/Asset/<Node>_<i>/Prim_<j>` for glTF) it refers to, so an agent branches on
  codes and chains inspect → fix → re-validate on paths. Every response
  validates against `schemas/<tool>.output.json` and is advertised as an MCP
  `outputSchema`.
- **Inspect anything, GLB or USD.** `validate` (opens? usdz packaging,
  metadata, schema errors, AR Quick Look compatibility; quick mode under a
  second), `inspect_geometry` (manifold, normals, UVs, bounds, pivot, scale),
  `inspect_animation` (does anything move? skeletons, bindings, blend shapes),
  `inspect_materials` (bindings, textures, unresolved paths, memory),
  `analyze_performance` (ios_ar / visionos / web / custom budgets with the
  worst offender per overage), and `inspect_all` — for `.glb`, `.gltf`,
  `.usdz`, `.usda`, `.usdc`.
- **See it, posed.** `render` (front, N-angle turntable sheet, custom camera,
  at any animation time; returns the camera) and `render_animation_strip`
  (stills of the requested frames, optional GIF).
- **Nothing changes silently.** Mutating tools accept `dry_run` and `render`,
  return `diff` + `post_validation`, and report every unrequested change
  (generated normals, joined primitives, transcoded textures, default
  materials, dropped clips…) as a coded entry in `errors[]`.
- **Compact results.** `analyze_glb`, `optimize_glb`, and `ship_asset` return
  the verdict, the numbers that drive decisions, the top three findings,
  `nextActions` (the tool calls that would fix the failures) and a `drillDown`
  pointer — as JSON text and as `structuredContent`.
- **Drill-down on demand.** `inspect_report` returns any full section —
  `findings` (with fix suggestions, filterable by rule prefix / severity),
  `textures`, `materials`, `topology`, `geometry`, `scene`, or `all`.
  Analysis is deterministic and fast, so nothing is cached server-side.
- **See what you made.** Every tool that reads or writes a GLB also returns a
  rendered PNG (`preview: thumbnail | turntable | none`) from the deterministic
  software rasterizer — no GPU, same file = same pixels. `render_preview`
  does it standalone (2x2 turntable, optional save).
- **Measured fidelity.** Optimizations report a geometric deviation bound and
  the visual-fidelity SSIM of four fixed-camera renders before vs after,
  gated on the profile's `minSsim` floor. A failing SSIM fails the report —
  and returns a **reference | result | change-heatmap sheet** of the weakest
  view so the agent can see *where* the loss is. `compare_glb` does the same
  for any two files, plus geometric alignment scores.
- **Know before you plan.** `capabilities` reports which generation providers
  have keys, whether a KTX2 encoder is installed, versions, and profiles.
- **Checkable determinism.** Every written file comes back with its `sha256`.
- **Read-only tools are annotated** (`readOnlyHint`) so clients can
  auto-approve analyze / inspect / render / audit / compare / list.

Tools: `inspect`, `validate`, `inspect_all`, `inspect_geometry`, `inspect_animation`,
`inspect_materials`, `analyze_performance`, `render`, `render_animation_strip`,
`capabilities`, `analyze_glb`, `inspect_report`, `render_preview`,
`compare_glb`, `optimize_glb`, `ship_asset`, `audit_directory`,
`extrude_image`, `export_stl`, `export_usdz`, `list_profiles`,
`generate_image_to_3d`, `generation_status`, `meshy_create_task`,
`meshy_task_status`, `meshy_download`.
Prompts: `web-ready-mobile-hero`, `logo-keychain`, `audit-and-fix-folder`, `ar-ready-usdz`.

Schemas: `schemas/` (input + output per tool, `envelope.json`, `diagnostic.json`).
Codes: `docs/error-codes.md`. Performance profiles: `docs/performance-profiles.md`.

Tool descriptions teach the routing that matters: flat artwork → deterministic
extrusion (free, instant, exact); photographic/dimensional subjects →
generation (fal.ai open models or Meshy); everything → budget-checked,
perceptually verified optimization.

Docs: **https://github.com/glbforge/glbforge**
