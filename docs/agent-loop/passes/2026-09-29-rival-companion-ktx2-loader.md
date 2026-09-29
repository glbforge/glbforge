# Pass — 2026-09-29 — 289eacd
**Role:** rival

## Step 0 — claim check

`mcp__github__list_pull_requests` (open, `agent-loop/` prefix) at the start of this pass: 30+ open PRs, 17 already claiming rival. Read the rival ones' titles and, for the two closest to "an alternative product loading GLBForge output," their full bodies: `#39` (Manifold oracle) turned out to already cover STL-export watertightness directly — it built 8 real STL exports (including `cat.stl`/`plush.stl` from these same `site/models/*.glb` fixtures) and checked them with `manifold-3d`, so the "is `export_stl`'s own file valid" angle this pass's brief suggested is claimed; verified by reading `#39`'s body in full rather than assuming from its title. `#63` (integrator, not rival) drove `model-viewer`/three.js against `optimize()`'s meshopt output and fixed the missing `setMeshoptDecoder` wiring across the docs/hints, but never touched KTX2 or the `companion/` package at all — confirmed by reading its full body and diff description. No open PR touches `companion/` in any role.

## What was measured

`companion/renderer/app.js` is GLBForge's own shipped product: an Electron character that loads a GLB through a real `THREE.GLTFLoader`, not `harness/render.ts` (GLBForge grading its own homework). `companion/README.md` already stated the gap plainly: *"KTX2 textures are **not** decoded here — use the `.web.glb`, not the `.ktx2.glb`."* That is an honest, documented loss against `optimize()`'s own second texture path (`ktx2Compress`, core/src/ktx2.ts — "~8x less VRAM than WebP/PNG"). Rival's job is the honest comparison table; a documented-but-unverified limitation is exactly the kind of claim worth actually checking, so this pass checked whether the gap was real, how big it was, and whether it was closeable.

Built a real, minimal repro rather than trusting the README: a single textured quad, compressed with the same `ktx2Compress()` the CLI/MCP call (via `basisu` 1.16.3 from npm, the same binary `#69`'s research already confirmed is reachable in this sandbox — `npm install basisu` gives the `basisu` CLI `detectKtx2Encoder` shells out to). Also ran the full `optimize()` pipeline with `textureFormat: 'ktx2'` on `site/models/cat.glb` (a real, non-LFS, checked-in fixture with actual base-color/metallic-roughness/normal textures — `site/models/{neon,plush}.glb` and `assets/sample-ring.glb` all had their only texture folded into a factor by `prune()` before reaching the texture-encode step, so `cat.glb` was the only real fixture that actually exercises this path).

Fed both outputs to `companion/renderer/app.js`'s exact loader wiring — `new GLTFLoader()` + `setMeshoptDecoder(MeshoptDecoder)`, the two lines the file shipped with — using the identical `three@0.169.0` version companion depends on, confirmed reproducible in two independent Node harnesses (a bare Node process, and one with `jsdom` supplying `document`/`Image`, since the specific failure turned out to happen before any image decode, so both gave the identical error):

| input | companion's pre-fix wiring | after registering `KTX2Loader` the way `app.js` now does |
|---|---|---|
| `site/models/cat.glb` → `optimize({ profile: 'mobile-hero', textureFormat: 'ktx2' })` (7.9MB — KTX2 is GPU-VRAM-optimized, not disk-size-optimized, so it is *larger* on disk than the 2.16MB WebP output at 99.96% SSIM; that tradeoff is correctly documented in `optimize.ts`'s own comments and is not the bug) | `THREE.GLTFLoader: setKTX2Loader must be called before loading KTX2 textures` (thrown synchronously in `loader.parse()`, before any frame renders) | past that check (fails later only on `self is not defined` — a Worker global plain Node lacks and a real Electron renderer has) |
| minimal quad fixture, `ktx2Compress()` only (1.5KB) | same error | same result — past the check |

Two real disagreements resolved the same direction: GLBForge's own promised KTX2 path is unusable in GLBForge's own shipped desktop consumer, confirmed, not merely suspected.

### L15 · `fixed` · companion's own README conceded a KTX2 loss to a bare three.js consumer — verified real, closed

`companion/renderer/app.js` shipped a `GLTFLoader` with no `KTX2Loader` registered, so any GLB produced by `optimize()`'s own documented `textureFormat: 'ktx2'` path threw `THREE.GLTFLoader: setKTX2Loader must be called before loading KTX2 textures` synchronously in `loader.parse()` — confirmed on both a minimal repro and a real KTX2-textured fixture (`site/models/cat.glb` run through `optimize()`), in two independent harnesses using companion's exact `three@0.169.0` wiring. `companion/README.md` had documented this as a permanent limitation ("KTX2 textures are **not** decoded here") since the package's introduction; it was real, and it was three lines to close (register `KTX2Loader`, pointed at the transcoder WASM `three` already ships — `main.mjs`'s static server already proxies `node_modules/three/*`, so nothing new needs to be served).

## What was fixed

- `companion/renderer/app.js`: imports `KTX2Loader` from `three/addons/loaders/KTX2Loader.js`, constructs it with `.setTranscoderPath('/node_modules/three/examples/jsm/libs/basis/')` and `.detectSupport(renderer)`, and calls `loader.setKTX2Loader(ktx2Loader)` — three lines, mirroring the existing `setMeshoptDecoder` wiring right above it. No new files need to ship: `main.mjs`'s static server already proxies `/node_modules/three/*` to the installed `three` package (that is how the `MeshoptDecoder` import above it resolves at runtime too), and the Basis transcoder WASM lives inside `three`'s own `examples/jsm/libs/basis/` — unlike `packages/studio`, which has to `cpSync` that directory into its own `public/basis/` (`packages/studio/copy-basis.mjs`) because Vite's build only bundles what it can statically see, companion serves `node_modules` directly and needed no such step.
- `companion/README.md`: replaced the "not decoded here" limitation with what is now true.
- `companion/package.json`: added a `"test"` script (`node --test test/*.test.mjs`) — companion had zero test infrastructure before this pass; adding a whole framework was out of scope, but Node's built-in test runner needed nothing extra since `three` is already a companion dependency.
- `companion/test/ktx2-loader.test.mjs` (new) + `companion/test/fixtures/ktx2-quad.glb` (new, 1.5KB, built with `@gltf-transform/core` + `ktx2Compress()`): a static check that `app.js` still imports and wires `KTX2Loader` (fails if the fix is reverted — confirmed by `git stash`-ing the `app.js` change and re-running: 1 of 3 tests fails, the exact static one), plus the functional pair proving *why* that wiring is the fix (asserts the specific "setKTX2Loader must be called" error is gone once wired, not just that some string changed).

**Left open:** this test does not run under `pnpm -r test` — `companion/` is deliberately outside the pnpm workspace (its own lockfile, so Electron's postinstall isn't skipped for the rest of the monorepo; see `CLAUDE.md`) and no CI workflow installs or tests it today. Verified by running `pnpm install` inside `companion/` directly (Electron 33.4.11's postinstall completed — this sandbox's proxy reaches whatever `pnpm install` needs there) and `pnpm test`, not by inference. Wiring a `companion` test job into `.github/workflows/ci.yml` is a real gap but a separate, larger change (a second Electron download on every CI run) than this pass's finding — left to a future integrator/CI pass. Also left open: while installing companion's own dependencies to run this verification, `pnpm install`/`pnpm test` inside `companion/` repeatedly rewrote `companion/pnpm-lock.yaml` (`electron` is listed under `dependencies` in `package.json` but under `devDependencies` in the committed lockfile — pre-existing drift, unrelated to this fix, reverted both times rather than folded in here since nothing currently runs `pnpm install --frozen-lockfile` against it to have caught it).

## Verify

`pnpm -r build && pnpm -r test`: unaffected (companion is outside the workspace) — 177/3 skipped core, 46/46 mcp, 5/10 (5 skipped, LFS) cli, 2/2 studio, all matching the pre-pass baseline exactly. `companion`'s own new suite: `pnpm test` inside `companion/` — 3/3 passing after the fix; re-verified it fails (1/3) against the pre-fix `app.js` by stashing the change and re-running.

`pnpm probe -- --no-live`:
```
Before: Surface 28 tools; Advice 3/3 (1); 0 new findings; 0 dangling; Vocab 33/130; No regressions.
After:  Surface 28 tools; Advice 3/3 (1); 0 new findings; 0 dangling; Vocab 33/130; No regressions.
```
Identical shape both sides (expected — this pass never touched an MCP-surfaced package). Latency moved within the same host-noise band other same-day passes reported (`optimize_glb` 2254/3476 → 2598/2932 p50/p90); not re-frozen, no baseline edit.

`pnpm docs:check`: passes unchanged — `companion/` is outside its scope (tool/verb counts come from `packages/mcp`/`packages/cli`, neither touched here).
