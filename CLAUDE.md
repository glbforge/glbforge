# GLBForge — notes for agents working on this repo

pnpm monorepo: `@glbforge/core` (pure pipeline), `glbforge` (CLI, `packages/cli`),
`@glbforge/mcp` (MCP server), `@glbforge/meshy` (Meshy + fal.ai clients),
`@glbforge/studio` (browser Studio), `@glbforge/companion` (`companion/`,
standalone Electron desktop character with its own lockfile — `pnpm install`
there, not `--ignore-workspace`, or Electron's postinstall is skipped). Landing site in `site/` (static, Cloudflare),
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
- **Rule packs are versioned contracts too** (`core/src/packs/`). Slash rule
  ids (`topo/open-edges`) are the public API; SCREAMING codes in
  `inspect/diagnostics.ts` are aliases (`rule:` field, rendered into
  `docs/error-codes.md`). Rules are versioned by their pack
  (`core-geometry@1`): never edit a published pack in `PACK_VERSIONS`, append
  a version. Certainty invariant: a finding's `message` states only what was
  measured (a `heuristic` rule carries `confidence`); every `likely_cause`
  carries its own confidence because a cause is always an inference. A pack
  declares DEFAULT severities; the PROFILE decides (`Profile.rules` on
  budget profiles, `RULE_PROFILE_VERSIONS` for `authoring@1`): web profiles
  report topology as info, authoring warns. A print profile (topology as
  errors) is planned but not yet published — `RULE_PROFILE_VERSIONS` only
  has `authoring`; see `docs/BUDGETS.md`'s "future print profiles" note. The
  linter runs over the pipeline's own outputs: `test/packs.test.ts` freezes the
  finding set of every `examples/*.glb` under `authoring@1`; a rule or
  pipeline change that alters it must update the table on purpose. Welded-
  space topology for packs and `inspectGeometry` is `inspect/topology.ts`
  (radix-sorted edge pairs; ~70 ms per 150k triangles, ~360 ms per 2M).
- **Usage counter is local and opt-in, non-negotiably** (`core/src/usage.ts`).
  It never makes a network call; do not add one. Records only exist after
  `GLBFORGE_USAGE=1` / `glbforge usage --enable`; `recordUsage` never throws
  into a tool. The metric is invocations per asset *lineage* (hashes joined
  by session+path, path+time window, diff edges, explicit id) — a content
  hash alone would read 1.0 forever in an edit loop.
- **The forge's projected texture is an opaque plate**, not the source image
  (`extrude/bleed.ts`). Transparent-background artwork has no colour outside
  its silhouette, and the wall/bevel UVs sample exactly that boundary; a
  lossy re-encode rings across the art/void edge and throws away the RGB of
  fully transparent texels, so the rim lost ~6 SSIM points. `extrudeImage`
  and the Studio both run `flattenProjection` before embedding: pad the
  colour outward from the nearest *fully opaque* texel, then set alpha to
  255 everywhere. Don't reintroduce alpha — the silhouette lives in the
  mesh, the trace has its own decode of the source, and seeding the padding
  from antialiased texels (rather than opaque ones) paints a fine Voronoi
  that costs more to encode than the artwork.
- **Skinned / morphing prims** go through `core/src/skinning.ts`, not the plain
  simplifier; `join()` already skips them.
- **"No visible loss" is measured**: `optimize()` renders 4 fixed cameras before
  and after and gates SSIM on `profile.minSsim`. Changing the rig, render size,
  supersampling, or shading changes every reported number — treat
  `verifyRig()` as frozen. Breaking that freeze is a deliberate pass of its
  own: re-measure the calibration points on the LFS fixtures, republish the
  profiles (see the versioned-budgets rule) and record the before/after table
  in `docs/BUDGETS.md`. Done once so far, for the 0.9.0 colour-space fix.
- **The renderer shades in linear light and writes sRGB** (`harness/render.ts`).
  glTF stores base color in two encodings — `baseColorFactor` is linear, a
  base-color texture is sRGB bytes — and base color is `factor * texture`, not
  whichever is present. Getting this wrong is invisible in a single render and
  catastrophic in a *comparison*: `prune()` folds a solid base-color texture
  into the factor, so a correct optimization scored as visible loss. Transfer
  functions live in `core/src/color.ts`; normal/ORM maps are linear data and
  must never be decoded through them.
- **Isomorphic core.** `sharp` and `node:*` are imported lazily inside Node-only
  paths; the Studio stubs `sharp` out. Browser paths get decoders/encoders
  injected (`textureEncoder`, `textureDecoder`).
- **Fixtures are git-LFS** (34–93MB). CI does not pull LFS; specs skip on pointer
  files. Don't add fixtures without LFS tracking.
- **Release**: tag `v*` → `release.yml` publishes all packages via npm OIDC
  (`pnpm pack` + `npm publish --provenance`; never `pnpm publish` in CI). Bump
  all six package versions together (`packages/*` and `companion/`); update `server.json` and the MCP registry
  (`dev.glbforge/glbforge`, domain key in `~/.config/glbforge/`) afterwards.
- **USDZ crate writer** (`core/src/usdc.ts`) targets crate 0.8.0; Pixar flags anything
  older as deprecated. Validate changes with `test/usd-oracle.py`: `pip install
  usd-core` in a venv and run core tests with `GLBFORGE_PXR_PYTHON=<venv>/bin/python`.
  `USD_WRITE_NEW_USDC_FILES_AS_VERSION=0.8.0` + `Sdf.Layer.Export` gives byte references.
- **The Studio is built twice, differently.** `packages/studio/dist` (served by
  `glbforge ui`, shipped in the npm package) comes from `pnpm build`; the
  committed `site/studio/` that glbforge.dev serves comes from `pnpm build:site`,
  which is the same build plus `--base=/studio/`. Copying `dist` into
  `site/studio` emits `/assets/*` under a path that serves `/studio/assets/*`,
  so every visit 404s the bundle and renders a blank page — shipped once, live
  for two days. `packages/studio/test/site-build.test.ts` freezes this.
  Rebuild core first (`pnpm -r build`): the Studio bundles `@glbforge/core`
  from `dist`, not `src`, so a stale `dist` silently ships an old pipeline —
  an `analyze()` predating `AnalysisResult.skipped` crashed the Inspector,
  which reads it unconditionally. Note the Studio's build runs no `tsc`
  (`tsc --noEmit` catches exactly this class, but the package has pre-existing
  unrelated type errors), and `persist.ts` replays stored reports into the
  Inspector without re-analysis — a report shape change needs a `SCHEMA` bump
  there or stale IndexedDB rows crash the app on load with no UI left to clear
  them.
- **The information surface is generated or gated, never remembered.**
  `pnpm docs:sync` writes what is derivable and `pnpm docs:check` (CI, after
  the build) fails on the rest. **Generated — never edit by hand:** the
  `## Profiles (current versions)` tables in `docs/BUDGETS.md` (from
  `PROFILE_VERSIONS`, so the published rationale and
  `list_profiles rationale=true` cannot disagree) and all of
  `site/budgets/index.html` (rendered from `docs/BUDGETS.md` through
  `scripts/markdown.mjs` into `scripts/templates/budgets.html`). **Checked,
  written by hand:** `README.md`, `site/llms.txt` (AI-facing scope statement;
  its `## Commands` list must have a line per CLI verb — add internal-only
  verbs to `UNLISTED_VERBS` with a reason), `site/index.html`,
  `packages/mcp/README.md`, `ROADMAP.md`. The checker counts facts (tool
  count, verbs, the six package versions, profile/pack versions); it cannot
  tell whether a new capability is *described*. That is the scheduled info
  pass (`.claude/skills/glbforge-info-pass/`), which also deploys the site.
  `scripts/markdown.mjs` throws on any construct it does not render, so a new
  one in a generated doc is a deliberate addition there.
