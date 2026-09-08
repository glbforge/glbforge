# GLBForge — the web-readiness layer for AI-generated 3D

**glbforge.dev** · raw AI mesh in, shipped asset out

Makes AI-generated 3D assets (Meshy, etc.) actually shippable on the web:
**analyze → optimize → scaffold a viewer**, with performance budgets as a
CI-able contract.

## Status

- ✅ `glbforge analyze` — budget report card + named lint rules
- ✅ `glbforge optimize` — weld/simplify/LOD/compress to hit the budget
- ✅ `glbforge scaffold` — emit a React Three Fiber viewer for the optimized asset
- ✅ `glbforge meshy` — generate/download via Meshy REST API (image/text → 3D, `--optimize` glue)
- ✅ MCP server wrapping all of the above (`@glbforge/mcp`, 8 tools)
- ✅ **GLBForge Studio** (`glbforge ui`) — local web UI: drag-drop analyze,
  one-click optimize with a before/after compare slider in the viewport,
  logo forging, Meshy generation with live progress, STL export. Zero
  hosting; runs entirely on your machine.
- ✅ `glbforge extrude` — deterministic logo/graphic → 3D (no AI, no credits): traces
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
node packages/cli/dist/index.js ui model.glb   # GLBForge Studio on localhost:5177
```

`analyze` flags: `--profile mobile-hero|desktop-hero|product-configurator`,
`--json`, `--no-topology`. Exits non-zero when the asset is over budget — wire
it into CI like a linter. `optimize` flags: `--target <tris>`, `--lods a,b`,
`--no-textures`, `--no-compress`, `--no-verify`. LOD files (`--lods 40000,10000`)
are geometry-only: materials stripped, positions welded, meshopt-simplified,
and when non-manifold topology stalls the simplifier (stacked forge layers,
doubled shells) they fall back to grid vertex clustering so the target is
always reached — the CLI and the Action report say `grid-clustered` when that
happened.

Measured on the included Meshy 7 fixture (4K textures, 1.99M tris):
**89.4MB → 5.5MB (93.8% smaller), score 25 → 100, ~7s.** Pipeline:
dedup → weld → meshopt-simplify to budget (error ladder) → fill missing
normals → texture resize + WebP (normal maps near-lossless) → prune →
EXT_meshopt_compression → **perceptual verification**.

### "No visible loss" is measured, not claimed

Every `optimize`/`ship` renders the asset from four fixed cameras before and
after (deterministic software rasterizer, 2x supersampled, smooth shading,
base-color textures) and scores the pairs with SSIM. The weakest view must
clear the profile's `minSsim` floor (mobile-hero 0.94, product-configurator
0.95, desktop-hero 0.96) or the report card gets an error-severity
`fidelity/perceptual` finding and the command exits non-zero, exactly like a
budget violation. A passing run records the number as an info finding, so
the score ships with the report everywhere (CLI, `--json`, MCP, Studio).

```
  visual fidelity ✓ SSIM 96.7%  weakest view 95.8% @ verify_135 · floor 94.0% · geometric deviation ≤ 0.1%
```

On the fixture: the budget pass (1.99M → 150k tris) measures 0.958; forcing
40k tris drops to 0.896 (fails, and it should — hair strands merge); 10k
measures 0.73. `glbforge verify <candidate> <reference>` scores any two
files the same way. The cameras are fixed to the reference's bounds so a
shifted or shrunken result cannot re-frame itself into a good score.

## Packages

| package     | purpose                                              |
|-------------|------------------------------------------------------|
| `@glbforge/core`  | pure analysis library: stats, topology, rules, budgets |
| `glbforge` (CLI)   | `glbforge` command-line interface                          |
| `@glbforge/meshy` | typed Meshy REST client: tasks, polling w/ backoff, downloads |
| `@glbforge/mcp`   | MCP server: compact report cards + `inspect_report` drill-down, rendered previews from every tool, optimize/ship/forge/STL, generation |

## MCP server

`.mcp.json` registers the server for Claude Code automatically (build first:
`pnpm build`). For other clients:

```bash
claude mcp add glbforge -- node /path/to/XUI/packages/mcp/dist/index.js
```

Built for agents: results are compact cards (verdict, key numbers, every
error plus top findings, `nextActions`, a `drillDown` pointer) with
`inspect_report` for the full findings/textures/topology on demand; every
tool that touches a GLB returns a rendered thumbnail or 2x2 turntable, and a
failing optimization returns a reference | result | change-heatmap sheet so
the agent sees where the loss is (`compare_glb` for any two files).
`capabilities` says which providers have keys and whether KTX2 is available
before a plan is made; every written file reports its `sha256`; read-only
tools carry `readOnlyHint` so clients can auto-approve them. Generation tools are deliberately split into
create/status/download — tasks take minutes, and agents poll at their own
pace instead of holding a tool call open.

## Animated assets

Skinned meshes and morph targets go through a bone-aware path: meshoptimizer's
attribute-aware simplifier sees the skin weights (and per-target morph
deltas) as vertex attributes, vertices on dominant-joint boundaries are
locked, and every attribute — `JOINTS_n`, `WEIGHTS_n`, each target — is
compacted with the same remap. Skins, inverse bind matrices, and animation
clips survive untouched; `analyze` reports `scene/animated-asset`. Tested on
a rigged cylinder with a rotation clip and a morph target (blend band
preserved, weights normalized, deterministic).

## USDZ for iOS AR

```bash
npx glbforge usdz model.web.glb          # → model.usdz (PNG textures; --jpeg for smaller)
```

Writes a **binary USD (usdc, crate 0.8.0) layer** with `UsdPreviewSurface`
materials (base color, metallic/roughness via channel outputs, normal,
occlusion, emissive, alpha mask/blend), transcodes WebP textures to
PNG/JPEG, and packs a store-only zip with 64-byte-aligned payloads as the
spec requires. The crate writer is GLBForge's own, pure TypeScript — its byte
layout was verified section-by-section against files from Pixar's writer,
and `test/usd-oracle.py` opens the usdc and its usda twin with Pixar's USD
and checks every prim, value, connection, and relationship for equality
(set `GLBFORGE_PXR_PYTHON` to a python with `usd-core` to run it). On the
Meshy fixture the layer is 5.4MB binary vs 13.4MB ASCII. `--usda` writes
the text layer instead. Static export: skins and clips are baked to the bind
pose; KTX2 inputs are rejected with guidance. Also `export_usdz` on the MCP
server and an **Export USDZ** button in the Studio (in-browser too — textures
transcode through a canvas). Reference it from `<model-viewer ios-src="model.usdz">` for the AR
button on iOS. Verified on an iPhone in AR Quick Look: flat-material and
fully textured (JPEG color, PNG normal and metallic/roughness) exports both
open and render correctly.

## `glbforge init` — make a project agent-ready

```bash
npx glbforge init            # in your project; idempotent
```

Writes a marker-delimited section into `CLAUDE.md` (what the budget is,
which scripts and MCP tools to use, the forge-vs-generate routing rule, and
that "no visible loss" is measured), adds `glb:check` / `glb:analyze` /
`glb:optimize` / `glb:ship` / `glb:verify` / `glb:studio` npm scripts (plus
`glbforge` as a devDependency), and registers the MCP server in `.mcp.json`
(`--client cursor|both` for `.cursor/mcp.json`). Existing content, other MCP
servers, and your own scripts are preserved; a second run reports everything
unchanged. Flags: `--profile`, `--assets <dir>`, `--local`, `--dry-run`,
`--force`, `--no-claude-md`, `--no-scripts`, `--no-mcp`. From then on any
agent session in that project picks GLBForge up automatically.

`glb:check` runs `glbforge audit <dir>`: every GLB in the folder against the
budget, non-zero exit if any fails — the pre-commit / CI gate.

## GitHub Action

```yaml
# .github/workflows/assets.yml
on: pull_request
permissions: { contents: write, pull-requests: write }
jobs:
  assets:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0, lfs: true }
      - uses: glbforge/glbforge@main
        with:
          profile: mobile-hero
          optimize: true      # open a PR with the web-ready files
```

Runs only on GLB/glTF files changed in the pull request. Every run posts a
sticky report-card comment and gates the check on the budget. With
`optimize: true` it also optimizes each failing asset (`<name>.web.glb`
beside the original, or in place with `replace: true`), verifies it
perceptually, and opens or updates a pull request against the PR branch with
the results — before/after table, visual SSIM, and the pipeline steps. Same
input, profile, and CLI version always produce identical bytes, so outputs
are cached by content hash (`cache: true`) and re-runs are no-ops. Fork PRs
cannot receive a bot branch; their outputs are uploaded as a workflow
artifact instead. Opening the PR needs the repository (and, for
organizations, the org) setting **Allow GitHub Actions to create and approve
pull requests**; when it is off, the run still posts the report card and
uploads the optimized files as the `glbforge-optimized` artifact. In optimize mode the gate passes when the optimized output
passes, so the fix is always one merge away. `target-triangles` overrides the
profile's triangle target and `lods: 40000,10000` adds geometry-only LOD files
(`<name>.web.lodN.glb`) to the PR; both are part of the cache key. Inputs:
`profile`, `fail-on-budget`, `optimize`, `optimize-all`, `replace`, `verify`,
`target-triangles`, `lods`, `cache`,
`open-pr`, `pr-branch`, `version`, `token`.

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

## Open-model generation (fal.ai)

True image→3D via open weights on GPU inference — often 5-25x cheaper
than commercial generation. Set `FAL_KEY` (https://fal.ai/dashboard/keys):

```bash
node packages/cli/dist/index.js gen photo.png --model hunyuan --optimize   # Hunyuan3D-2
node packages/cli/dist/index.js gen photo.png --model trellis             # TRELLIS
node packages/cli/dist/index.js gen photo.png --model triposr             # fastest
```

The studio's generate panel picks up every configured provider
automatically (Meshy + the open trio side by side, with per-model
credit costs in hosted mode).

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
- **Budgets are profiles, not advice.** An asset passes or fails a named,
  versioned target (`mobile-hero@1` pins; bare `mobile-hero` = latest; a cap
  never changes in place). The methodology behind every cap and the version
  changelog are in [docs/BUDGETS.md](docs/BUDGETS.md) / glbforge.dev/budgets.
  Determinism makes it automatable.

## Fixtures

- `fixtures/veiled-guardian.glb` — Meshy 7 High-Detail geometry-stage export
  (1.99M tris, POSITION-only, 34MB). Welded + manifold; tests assert we don't
  cry wolf.
- `fixtures/veiled-guardian-tex4k.glb` — same asset after the 4K texture stage
  (89MB). Its 77k position-duplicate vertices are UV-seam splits, not waste;
  the `topo/unwelded` rule distinguishes these (regression-tested).
