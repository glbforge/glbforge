# Performance profiles (`analyze_performance`, `validate mode=full`, `inspect_all`)

`analyze_performance(path, profile)` checks an asset against a set of
per-asset limits and reports every overage with the metric, the value, the
limit and the `worst_offender_prim_path` an agent should fix first. Source
of truth: `packages/core/src/inspect/perf-profiles.ts`.

Three targets ship with sensible defaults. They are advisory targets for
agents, not gated CI contracts — the versioned web-delivery budgets
(`mobile-hero`, `desktop-hero`, `product-configurator`, see `BUDGETS.md`)
remain the contracts and are also accepted by name (`profile: "mobile-hero@1"`),
mapped onto the same limit keys.

| Limit | `ios_ar` | `visionos` | `web` | What it measures |
|---|---|---|---|---|
| `max_triangles` | 100,000 | 200,000 | 200,000 | Triangles across every mesh (n-gons triangulated) |
| `max_vertices` | 200,000 | 400,000 | 300,000 | Vertices as stored (seam splits count) |
| `max_draw_calls` | 16 | 32 | 16 | One per mesh primitive / material-bound GeomSubset |
| `max_materials` | 8 | 16 | 8 | Material prims / glTF materials |
| `max_textures` | 12 | 24 | 12 | Distinct texture images |
| `max_file_bytes` | 25 MB | 50 MB | 10 MB | Size on disk |
| `max_gpu_memory_mb` | 128 | 256 | 128 | Decoded RGBA8 textures with mipmaps (KTX2 at ~4 bpp) + geometry buffers |
| `max_texture_size` | 2048 | 2048 | 2048 | Largest texture dimension in pixels |
| `max_texture_bytes` | 12 MB | 24 MB | 6 MB | Encoded texture payload |
| `max_prim_count` | 500 | 1000 | 500 | Prims in the layer (glTF: nodes + meshes + materials + textures + skins + clips) |
| `max_scene_depth` | 16 | 16 | 16 | Deepest node chain |
| `max_animation_seconds` | 30 | 60 | 60 | Total clip length (advisory: an overage is `info`) |

Rationale in one line each:

- **ios_ar** — Apple's AR Quick Look guidance: around 100k triangles,
  2048 px textures, and a package that arrives in a few seconds over
  cellular; RealityKit decodes textures to RGBA8 on the device's shared memory.
- **visionos** — RealityKit on Apple Vision Pro renders several entities in a
  shared space at a high refresh rate; per-asset budgets stay moderate even
  though the hardware is stronger.
- **web** — a general three.js / model-viewer page on a mid-range device.
  For a gated contract use the budgets in `BUDGETS.md`; `web` is the
  neutral middle ground when the page type is unknown.

## Custom limits

Pass `custom_limits` with any subset of the keys above; they override the
named profile's values (the profile is reported as `<name>+custom`):

```json
{ "path": "/abs/asset.usdz", "profile": "ios_ar", "custom_limits": { "max_triangles": 50000, "max_file_bytes": 8000000 } }
```

## Codes raised

`TRIANGLE_BUDGET_EXCEEDED`, `VERTEX_BUDGET_EXCEEDED`, `DRAW_CALL_BUDGET_EXCEEDED`,
`MATERIAL_BUDGET_EXCEEDED`, `TEXTURE_BYTES_BUDGET_EXCEEDED`, `FILE_SIZE_BUDGET_EXCEEDED`,
`GPU_MEMORY_BUDGET_EXCEEDED`, `TEXTURE_SIZE_BUDGET_EXCEEDED`, `PRIM_COUNT_BUDGET_EXCEEDED`,
`SCENE_DEPTH_BUDGET_EXCEEDED` (all `error`), `INSTANCING_CANDIDATE` (`info`: identical
geometry stored as separate copies). See `error-codes.md`.
