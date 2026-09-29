# Pass — 2026-09-29 — 289eacd
**Role:** rival

## Step 0 — claim check

`gh pr list --state open --json number,title,headRefName --jq '...startswith("agent-loop/")'`
shows 25+ open `agent-loop/*` PRs, a dozen of them already `rival` passes
(`#38`–`#61`) covering gltf-validator, Manifold, ssim.js, Draco/meshopt,
gltfpack LOD, three.js `ExtrudeGeometry`, gltfjsx, Pixar's USD reader,
`computeSmoothNormals`, skinned triangle targets, KHR_materials_transmission
draw calls, and — closest neighbour — `#53`/`#56`/`#57`/`#58` on the SSIM
gate's various texture-format blind spots. `#62` already concluded "no new
finding rises to the bar" for a rival pass on this same backlog. `pnpm ledger`
on `main` still prints `rival` as least-recently-used because none of the
above are merged yet; the real rotation is as lopsided as `#56` already noted.
Read every title above before picking an angle; filed no review comments on
any of them — none touch what this pass found, and `#56` explicitly names the
gap this pass closes as something it could not chase (see below).

## Ground truth

`pnpm install && pnpm -r build`: clean, 6 packages. `pnpm -r test` before any
change: 177/180 core (3 skipped, LFS), 46/46 mcp, 5/10 cli (5 skipped, LFS),
2/2 studio — all green. `pnpm probe -- --no-live`: 28 tools, 3/3 advice
resolved, 33/130 vocab codes exercised, no regressions vs. `baseline.json`.

## What was measured

`#56` (2026-09-27) already flagged that **no sandbox this loop has run in has
`basisu` or `toktx` installed**, so the KTX2 encode path — the "preferred"
one, per `detectKtx2Encoder`'s own search order — has never actually run.
Its own `analyze.test.ts` test (`describe('ktx2', …)`) self-skips for exactly
this reason and always has.

`brew install basis_universal` isn't reachable from here, but `basisu` is
also published straight to npm (`basisu@1.16.3`, prebuilt Linux/macOS
binaries) and npmjs.org is this sandbox's one allowed host. Installed it,
put it on `PATH`, and ran the encoder for real for what appears to be the
first time in this loop's history.

Two of the three things that surfaced were failures the existing (skipped)
test would have caught immediately, had it ever run:

1. **`basisu`'s default output is not KTX2.** GLBForge's own args
   (`ktx2.ts`) never pass `-ktx2`:
   `[pngPath, '-output_file', ktxPath, '-mipmap', ...]`. Without that flag,
   `basisu` writes its native `.basis` container to `ktxPath` regardless of
   the `.ktx2` extension — confirmed by hex-dumping the actual output: the
   file did not start with the KTX2 identifier (`AB 4B 54 58 20 32 30 BB 0D
   0A 1A 0A`) at all. `mimeType('image/ktx2')` and
   `KHR_texture_basisu.setRequired(true)` are both set anyway, so the asset
   *declares* KTX2 and *is not KTX2* — every real loader that checks the
   identifier before transcoding (three.js `KTX2Loader`, Babylon, model-viewer)
   would reject it. `gltf-transform`'s own `ImageUtils` (which GLBForge's
   analyzer calls) is exactly such a checker, and it agreed: `getSize`
   returned `null` on the file.
2. **Even after fixing (1), `analyze()` still read `width: null`.**
   `ImageUtils`'s `image/ktx2` handler is registered by
   `KHRTextureBasisu.register()` — a `@hidden` static method — which only
   runs as a side effect of `PlatformIO.registerExtensions()`, i.e. when a
   `NodeIO`/`WebIO` actually reads or writes a file declaring the extension.
   `ktx2Compress` calls `doc.createExtension(KHRTextureBasisu)`, which
   constructs the extension but never calls its static `register()` — so a
   `Document` built in memory and handed straight to `analyze()` afterward
   (exactly what the shipped test does, and what `ktx2Compress` then
   `analyze()` always looks like from a library caller's side) never
   registers the format, and `ImageUtils.getSize`/`getVRAMByteLength` for
   `image/ktx2` silently return `null`/throw *(caught and turned into
   `null`/`undecodableTexture` by `analyze/materials.ts`'s own
   `imageSize`)* — a texture indistinguishable, in the report, from a
   genuinely corrupt one.

Real CLI/MCP/Studio runs likely dodge (2) in practice — the input GLB is
always loaded through `createNodeIO()`/an equivalent `WebIO` first, which
registers `ALL_EXTENSIONS` globally for the process before `optimize()` or
`analyze()` ever runs — but the shipped unit test, and any library consumer
building a `Document` programmatically before compressing it, hit it
directly. (1) has no such escape hatch: it is wrong regardless of what
registered what.

The third thing was a comment-vs-code contradiction, found while reading
`estimateVram` to understand what "correct" should even mean here:
`ktx2.ts`'s own comment says color maps get ETC1S ("~8x less video memory
than … raw RGBA," i.e. ~4bpp) and normal maps get UASTC ("higher quality") —
matching `profiles.ts`'s published rationale, which already says
`"~4–8x less"`. But `analyze/materials.ts`'s `estimateVram` priced every
KTX2 texture at a flat `width*height*1` (8bpp) — the UASTC number, applied to
the ETC1S-encoded majority too. `tex/vram-estimate` is a live budget-gate
rule (`rules.ts`), so this made every color-map-only KTX2 asset look ~2x
heavier on GPU memory than it actually is — a false-positive-shaped
overestimate, not a dangerous under-count, but still advice built on a
number the code's own comments say is wrong for that case.

## What changed

- **`packages/core/src/ktx2.ts`** — added `-ktx2` to the `basisu` arg list
  (`toktx` already emits real KTX2 by default; unaffected). Added a call to
  `KHRTextureBasisu.register()` at the top of `ktx2Compress`, so `analyze()`
  reads KTX2 dimensions/VRAM correctly right after compression regardless of
  whether the `Document` was ever round-tripped through `NodeIO`/`WebIO`.
  Comment fixed from "~8x less" to "~4-8x less" to match `profiles.ts`'s
  existing (correct) rationale text.
- **`packages/core/src/analyze/materials.ts`** — `estimateVram` now takes
  whether the texture is used as a normal map (derived from the same
  material-slot pass that already builds `textureRefs`) and prices ETC1S
  color maps at ~4bpp vs. UASTC normal maps at ~8bpp, instead of one flat
  rate for both.
- **`packages/core/src/optimize.ts`, `packages/core/src/rules.ts`** — same
  "~8x" → "~4-8x" wording fix in the two other places it was repeated
  (`optimize()`'s `textureFormat` doc comment, `tex/vram-estimate`'s
  suggestion string), so the three no longer disagree with `profiles.ts`.
- **`packages/core/test/analyze.test.ts`** — one new test: same 64×64 image
  KTX2-compressed once as a color map (ETC1S) and once as a normal map
  (UASTC) through the real `ktx2Compress`/`basisu`, asserting the normal
  map's `vramBytes` comes back ~2x the color map's. Fails without the fix
  (both were priced identically); also depends on both other fixes above to
  even produce non-null dimensions to compare. Self-skips (returns early)
  when no encoder is installed, matching the existing test's convention.
- **`CLAUDE.md`** — one new bullet recording all three: the `-ktx2` flag
  requirement, the `register()` side-effect dependency, and the ETC1S/UASTC
  bit-rate split — so the next pass that finally has a real encoder available
  doesn't have to re-derive this from a hex dump again.

No change to any budget profile, rule pack, or `PACK_VERSIONS`/`PROFILE_VERSIONS`
entry — `tex/vram-estimate`'s cap is untouched, only the measurement feeding it
got more accurate. `docs/BUDGETS.md`'s generated profile tables are unaffected
(checked with `pnpm docs:check`).

## Verify

`pnpm -r build && pnpm -r test` (with `basisu` on `PATH`, installed from npm
into a scratch dir, not committed anywhere): 178/181 core (+1 test, 3 skipped
LFS unchanged), 46/46 mcp, 5/10 cli (unchanged), 2/2 studio — all green,
including both KTX2 tests running against the *real* encoder for the first
time rather than self-skipping. Without `basisu` on `PATH` (this sandbox's
normal state): same totals minus the two KTX2 tests, which self-skip as
before — no regression either way.

Before the fix, with `basisu` on `PATH`: the pre-existing "encodes textures
as KTX2 and requires KHR_texture_basisu" test failed
(`expected null to be 64`) — confirming it had been silently skipping over a
real, reproducible failure the whole time, not a hypothetical one.

`pnpm probe -- --no-live`: 28 tools, 3/3 advice resolved, 33/130 vocab codes,
no regressions vs. `baseline.json`; latency deltas are single-digit-percent
noise on this host, not re-frozen. `pnpm docs:check`: in step (28 MCP tools,
21 CLI verbs, packages 0.8.0).

## Left open

- Whether the CLI/MCP/Studio paths ever construct a `Document` for
  `ktx2Compress` *without* first loading it through `createNodeIO`/`WebIO`
  (which would hit the registration gap even post-fix, if such a path
  exists) — not found in this pass, but not exhaustively ruled out either;
  the `register()` call added here makes it moot regardless.
  Now definitely fixed either way, since `ktx2Compress` calls
  `KHRTextureBasisu.register()` itself unconditionally.
- `#56`'s `L15` (the SSIM gate's zero texture-fidelity verification in `ktx2`
  mode) is unrelated and untouched — this pass fixes the KTX2 *file itself*
  being wrong and its *VRAM estimate* being imprecise; `#56` is about the
  perceptual gate never looking at KTX2-bound textures at all. Both can be
  true at once and don't overlap in files changed.
- The rotation backlog `#56` already flagged (rival now the most-used role,
  13+ passes, nearly all unmerged) — unchanged by this pass, still the
  maintainer's to triage.
- `L4` — untouched, a release call.
- `toktx` (KTX-Software) was not available to test here (not on npm); its
  branch of `ktx2Compress` was read but not run. It has no `-ktx2`-equivalent
  gap since KTX2 is its native, only output format.

### L15 · `fixed` · `basisu`'s KTX2 output was actually its native `.basis` format, mislabeled — missing `-ktx2` flag

Measured above: hex-dumped the real encoder's output and it did not carry
the KTX2 identifier at all, despite `image/ktx2` mimeType and
`KHR_texture_basisu` required being set on the glTF side. Fixed by adding
`-ktx2` to the `basisu` args in `ktx2.ts`; confirmed post-fix output starts
with the correct 12-byte identifier and `gltf-transform`'s own KTX2 reader
parses its dimensions. This is `basisu`-specific; `toktx` was unaffected.

### L16 · `fixed` · `analyze()` silently read KTX2 textures as undecodable when the Document never passed through NodeIO/WebIO

Measured above: `KHRTextureBasisu.register()` — the call that teaches
`ImageUtils` to parse `image/ktx2` — only runs as an I/O side effect,
never as a consequence of `doc.createExtension(KHRTextureBasisu)`, which
`ktx2Compress` does call. A `Document` built and compressed without ever
reading/writing through `NodeIO`/`WebIO` therefore had every KTX2 texture
report `width: null`, `vramBytes: 0`, indistinguishable from actual
corruption. Fixed by having `ktx2Compress` call
`KHRTextureBasisu.register()` itself.

### L17 · `fixed` · `estimateVram` priced every KTX2 texture at UASTC's bit rate, overstating ETC1S color maps by ~2x

Measured above: `ktx2.ts`'s own comment and `profiles.ts`'s published
budget rationale both already say KTX2 is "~4-8x less" than raw RGBA
(ETC1S ~4bpp for color maps, UASTC ~8bpp for normal maps), but
`estimateVram` used a single `width*height*1` (8bpp) rate for every KTX2
texture regardless of which format actually encoded it. Fixed by pricing
normal-map textures (UASTC) at 8bpp and everything else (ETC1S) at 4bpp,
using the same slot information the duplicate-material fingerprinting
already collects. `tex/vram-estimate`'s budget cap is unchanged — only the
number it compares against got more accurate.
