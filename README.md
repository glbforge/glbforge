# XUI — AI 3D Web Optimizer + Starter

Makes AI-generated 3D assets (Meshy, etc.) actually shippable on the web:
**analyze → optimize → scaffold a viewer**, with performance budgets as a
CI-able contract.

## Status

- ✅ `xui analyze` — budget report card + named lint rules
- ✅ `xui optimize` — weld/simplify/LOD/compress to hit the budget
- ✅ `xui scaffold` — emit a React Three Fiber viewer for the optimized asset
- ✅ `xui meshy` — generate/download via Meshy REST API (image/text → 3D, `--optimize` glue)
- ✅ MCP server wrapping all of the above (`@xui/mcp`, 6 tools)
- ✅ `xui extrude` — deterministic logo/graphic → 3D (no AI, no credits): traces
  the silhouette (marching squares → Douglas-Peucker → earcut), extrudes it
  watertight, and projects the source image back on as the texture. For 2D
  artwork (logos, wordmarks) this beats image-to-3D generation outright:
  ~1.5k tris vs ~2M, exact silhouette, original colors. `--bevel` adds a
  signage-style rounded rim (miter-limited, clamp-probed insets + a crack
  stitching pass keep it watertight even on thin graffiti strokes; verified
  0 boundary / 0 non-manifold edges on real logo fixtures). Photographic
  inputs are detected and routed to Meshy instead. Also exposed as the
  `extrude_image` MCP tool.

## Usage

```bash
pnpm install && pnpm build
node packages/cli/dist/index.js analyze fixtures/veiled-guardian.glb --profile mobile-hero
node packages/cli/dist/index.js optimize fixtures/veiled-guardian-tex4k.glb -o out.web.glb --lods 40000,10000
node packages/cli/dist/index.js scaffold out.web.glb -o viewer && cd viewer && pnpm install --ignore-workspace && pnpm dev
```

`analyze` flags: `--profile mobile-hero|desktop-hero|product-configurator`,
`--json`, `--no-topology`. Exits non-zero when the asset is over budget — wire
it into CI like a linter. `optimize` flags: `--target <tris>`, `--lods a,b`,
`--no-textures`, `--no-compress`.

Measured on the included Meshy 7 fixture (4K textures, 1.99M tris):
**89.4MB → 5.5MB (93.8% smaller), score 25 → 100, ~7s.** Pipeline:
dedup → weld → meshopt-simplify to budget (error ladder) → fill missing
normals → texture resize + WebP (normal maps near-lossless) → prune →
EXT_meshopt_compression.

## Packages

| package     | purpose                                              |
|-------------|------------------------------------------------------|
| `@xui/core`  | pure analysis library: stats, topology, rules, budgets |
| `@xui/cli`   | `xui` command-line interface                          |
| `@xui/meshy` | typed Meshy REST client: tasks, polling w/ backoff, downloads |
| `@xui/mcp`   | MCP server: analyze_glb, optimize_glb, meshy_create_task/status/download, list_profiles |

## MCP server

`.mcp.json` registers the server for Claude Code automatically (build first:
`pnpm build`). For other clients:

```bash
claude mcp add xui -- node /path/to/XUI/packages/mcp/dist/index.js
```

Generation tools are deliberately split into create/status/download — Meshy
tasks take minutes, and agents poll at their own pace instead of holding a
tool call open.

## Meshy API key

Copy `.env.example` to `.env` and set `MESHY_API_KEY` (gitignored, loaded
automatically, never overrides real env vars). Or keep it out of files
entirely via macOS Keychain:

```bash
security add-generic-password -a "$USER" -s meshy-api-key -w
# ~/.zshrc: export MESHY_API_KEY=$(security find-generic-password -s meshy-api-key -w)
```

Full loop, one command:

```bash
node packages/cli/dist/index.js meshy image art.png --pbr --optimize -p mobile-hero -o hero.glb
```

## Rules

`perf/*` budget violations fail the build; `geo/*`, `topo/*`, `mat/*`,
`tex/*`, `scene/*` describe defects typical of AI-generated assets, each with
a concrete fix. See `packages/core/src/rules.ts`.

## Design decisions

- **Pure Node/TS, no Blender dependency.** Analysis and (upcoming)
  optimization run on `@gltf-transform` + `meshoptimizer` — native to glTF, no
  lossy DCC round-trip, installable via `npx`, CI-friendly. Ops are designed
  as pluggable backends so Blender-only capabilities (retopo, UV unwrap,
  baking) can be added later without changing the CLI surface.
- **Topology in welded space.** Boundary/non-manifold counts are computed
  after unifying position-duplicate vertices, so unwelded exports don't
  produce garbage numbers.
- **Budgets are profiles, not advice.** An asset passes or fails a named
  target (`mobile-hero` etc.). Determinism makes it automatable.

## Fixtures

- `fixtures/veiled-guardian.glb` — Meshy 7 High-Detail geometry-stage export
  (1.99M tris, POSITION-only, 34MB). Welded + manifold; tests assert we don't
  cry wolf.
- `fixtures/veiled-guardian-tex4k.glb` — same asset after the 4K texture stage
  (89MB). Its 77k position-duplicate vertices are UV-seam splits, not waste;
  the `topo/unwelded` rule distinguishes these (regression-tested).
