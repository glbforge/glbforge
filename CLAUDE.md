# GLBForge — notes for agents working on this repo

pnpm monorepo: `@glbforge/core` (pure pipeline), `glbforge` (CLI, `packages/cli`),
`@glbforge/mcp` (MCP server), `@glbforge/meshy` (Meshy + fal.ai clients),
`@glbforge/studio` (browser Studio). Landing site in `site/` (static, Cloudflare),
hosted API in `worker/`. Roadmap and history: `ROADMAP.md`.

## Build / test

```bash
pnpm install && pnpm -r build     # core must build before cli/mcp/studio (workspace deps)
pnpm -r test                      # vitest per package; core's fixture specs self-skip on LFS pointers
node packages/cli/dist/index.js analyze fixtures/veiled-guardian.glb   # run the CLI from the build
```

`.mcp.json` registers the local MCP build (`packages/mcp/dist/index.js`) — rebuild
and restart the client to pick up server changes. `glbforge init --local` writes
the same registration into another checkout.

## Rules that are not obvious from the code

- **Deterministic core.** Same input + settings = identical bytes and pixels.
  No `Math.random` (seeded sampling in `harness/align.ts`), fixed camera rigs,
  fixed zip timestamps. Generation (Meshy / fal) is the only stochastic step.
- **Pure Node, no Blender.** gltf-transform + meshoptimizer + sharp only; ops
  are written so a heavier backend could be plugged in later.
- **Never use gltf-transform's `normals()`** — it produces flat per-face normals.
  Use `computeSmoothNormals` (`core/src/normals.ts`), shared by the optimizer
  and the renderer.
- **Read accessors with `readFloat()`** (`core/src/accessors.ts`). Optimized
  GLBs store positions/UVs as normalized int16/uint16; `getArray()` is raw ints.
- **Budgets are versioned contracts.** Never edit a published profile in
  `core/src/profiles.ts`; append a new version and a `docs/BUDGETS.md`
  changelog entry (tests freeze v1's caps).
- **Skinned / morphing prims** go through `core/src/skinning.ts`, not the plain
  simplifier; `join()` already skips them.
- **"No visible loss" is measured**: `optimize()` renders 4 fixed cameras before
  and after and gates SSIM on `profile.minSsim`. Changing the rig, render size,
  supersampling, or shading changes every reported number — treat
  `verifyRig()` as frozen.
- **Isomorphic core.** `sharp` and `node:*` are imported lazily inside Node-only
  paths; the Studio stubs `sharp` out. Browser paths get decoders/encoders
  injected (`textureEncoder`, `textureDecoder`).
- **Fixtures are git-LFS** (34–93MB). CI does not pull LFS; specs skip on pointer
  files. Don't add fixtures without LFS tracking.
- **Release**: tag `v*` → `release.yml` publishes all packages via npm OIDC
  (`pnpm pack` + `npm publish --provenance`; never `pnpm publish` in CI). Bump
  all five package versions together; update `server.json` and the MCP registry
  (`dev.glbforge/glbforge`, domain key in `~/.config/glbforge/`) afterwards.
- **USDZ crate writer** (`core/src/usdc.ts`) targets crate 0.8.0; Pixar flags anything
  older as deprecated. Validate changes with `test/usd-oracle.py`: `pip install
  usd-core` in a venv and run core tests with `GLBFORGE_PXR_PYTHON=<venv>/bin/python`.
  `USD_WRITE_NEW_USDC_FILES_AS_VERSION=0.8.0` + `Sdf.Layer.Export` gives byte references.
- **Docs to keep in sync when scope changes**: `README.md`, `site/llms.txt`
  (AI-facing scope statement), `packages/mcp/README.md`, `ROADMAP.md`.
