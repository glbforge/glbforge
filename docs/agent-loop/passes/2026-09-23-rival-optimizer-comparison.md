# Pass — 2026-09-23 — b59f0d2
**Role:** rival

## Step 0 — claim check

One open `agent-loop/`-prefixed PR: #20,
`agent-loop/2026-09-23-companion-reply-id`, fixing a stale-reply-id bug in
`companion/`. Confirmed the bug is still live on `main`
(`companion/main.mjs:345` still has the `inbox.find(...) ?? inbox.find(...)`
fallback the PR replaces) and left it untouched — no companion work in this
pass.

## Ground truth

`pnpm install && pnpm -r build`: clean, 6 packages. `pnpm -r test`: 21 files
/ 174 passed / 3 skipped (core), 13/13 (meshy), 2/2 (studio), 5/5 + 5 skipped
(cli), 44/44 (mcp) — all green before any change. `pnpm probe -- --no-live`:
28 tools, no baseline regressions, one pre-existing drift already on the
ledger (`site/llms.txt` "0.9.0 line" vs 0.8.0 packages, `L4`, a release
decision — left alone per the task's standing instructions).

## Role

`pnpm ledger` printed `rival` — never used, first in the rotation. Read its
section in `ROLES.md`: install a real alternative, run one real asset
through both, publish a table where GLBForge sometimes loses.

## The rivals

Both installed clean via npm (no other network needed):

- `@gltf-transform/cli` 4.5.0 — pure JS, already GLBForge's own dependency
  (`@gltf-transform/functions`), so this is "GLBForge vs. its own library's
  reference CLI," which turned out to be the more interesting comparison.
- `gltfpack` (npm package `gltfpack`, meshoptimizer's own tool) 1.2 — a
  native/WASM build. Its `-tc`/`-tw` texture-compression flags refuse to run
  in this sandbox ("node.js builds do not support WebP/BasisU... download a
  native build from https://github.com/zeux/meshoptimizer/releases" — that
  host isn't reachable here, a sandbox limit, not a finding). Geometry-only
  compression (`-cc`) works fully.

Three real, non-LFS assets from `site/models/` (the glbforge.dev showcase —
themselves prior GLBForge output, so every comparison below is "re-optimize
this with GLBForge again" vs. "re-optimize this with the rival," same
starting point for both, all at `mobile-hero`'s 150k-triangle cap):

| asset | before | GLBForge `optimize -p mobile-hero` | `gltf-transform optimize --texture-compress webp --simplify false` | `gltfpack -cc` |
|---|---|---|---|---|
| cat.glb (150k tri, PBR textures) | 3.32 MB | **2.16 MB**, ssim 0.9997, 4.64s | **1.32 MB** (−39%), ssim 0.9992, 1.61s | 2.47 MB, texture untouched (sandbox can't compress it — not a fair size comparison) |
| plush.glb (150k tri, no texture, 4 mat) | 1.13 MB | **1.13 MB** (−0.05%), ssim 1.0, 3.10s | **0.80 MB** (−30%), ssim 0.9999, 0.89s | **0.74 MB** (−34%), ssim 0.9992, 0.16s |
| neon.glb (20k tri, no texture, 3 mat) | 175 KB | **175 KB** (−0.1%), ssim 1.0, 1.52s | **154 KB** (−12%), ssim 0.9999, 0.68s | **138 KB** (−21%), ssim 0.9995, 0.08s |

SSIM measured with `glbforge verify` in every cell — GLBForge's own
harness, so the rival isn't graded on a curve. Every rival output clears
`mobile-hero`'s 0.94 floor by a wide margin. GLBForge loses on size on all
three assets, and loses on wall-clock by 2–20x on all three.

### Root cause: `level: 'medium'`

`gltf-transform inspect` on the cat.glb outputs shows the whole gap:

```
GLBForge:       NORMAL:i16_norm, POSITION:i16_norm, TANGENT:i16_norm, TEXCOORD_0:u16_norm
gltf-transform: NORMAL:i8_norm,  POSITION:i16_norm, TANGENT:i8_norm,  TEXCOORD_0:u16_norm
```

Same 150k triangles, same 94,539 vertices, same attribute set. `optimize.ts`
calls `meshopt({ encoder: MeshoptEncoder, level: 'medium' })`
(`packages/core/src/optimize.ts:493`, unchanged since it was first written —
no comment or commit message explains the choice). In `@gltf-transform/
functions`' own `meshopt.ts`, `level: 'medium'` quantizes every attribute,
including NORMAL/TANGENT, through the generic path at `quantizeNormal`'s
default of 10 bits — which needs a 16-bit accessor, since glTF has no 10-bit
component type. `level: 'high'` — the CLI's own default — routes NORMAL and
TANGENT through meshopt's octahedral filter instead (capped at 8 bits by the
filter itself: `quantizeNormal = Math.min(quantizeNormal, 8)`, per
meshopt's own `getMeshoptFilter`), which is what the file-size table above
is actually measuring. Texture bytes are close (353 KB GLBForge vs. 231 KB
gltf-transform on cat.glb) — normal/tangent precision is the whole story.

Not applying this myself. `profiles.ts`'s rationale strings cite specific
SSIM numbers ("0.958" mobile-hero v1, "0.964"/"0.979" v2 …) measured on the
LFS-gated Meshy 7 hero fixture, unreachable in this sandbox. Changing
NORMAL/TANGENT precision shifts `optimize()`'s reported SSIM on every
fixture, even if only in the fourth decimal — CLAUDE.md is explicit that
this class of change is "a deliberate pass of its own: re-measure the
calibration points on the LFS fixtures, republish the profiles… and record
the before/after table in docs/BUDGETS.md." I can't do that half of the
work here, so I'm not doing the code half either.

### L12 · `open` · `optimize()` leaves 12–39% on the table: `meshopt({ level: 'medium' })` where the library's own CLI defaults to `'high'`

Fix is a one-line change (`optimize.ts:493`, `'medium'` → `'high'`), gated
on SSIM staying clear of every profile's floor on the LFS fixtures — 0.999+
on all three non-LFS fixtures above, well clear of 0.94–0.96, so there's no
reason to expect it won't hold, but "won't" isn't "measured," and this repo
holds its own claims to that standard. Whoever picks this up needs LFS
access: run the current profiles.ts rationale's calibration renders before
and after on the Meshy 7 fixture, update the cited numbers, add a
`docs/BUDGETS.md` changelog line, then flip the flag.

## An unrelated bug the rival comparison tripped over

`gltfpack -cc` on cat.glb scored **ssim 0.3248** against the original — a
hard fail against `mobile-hero`'s 0.94 floor, on a rival that only repacked
already-quantized geometry and touched no pixel of the texture. That's not
"lossier," that's `verify` reporting a asset as ruined when nothing visible
changed — a "confident wrong answer," the kind of failure this loop's
`saboteur` role exists to hunt, found here by accident.

Cause: `gltfpack` added `KHR_texture_transform` (`offset [0,0]`, `scale
[16.0, 16.0]`) to the base-color/normal/metallicRoughness `TextureInfo`s —
legal, spec-conformant, and needed because it re-quantized TEXCOORD_0 at
lower precision and used the transform to recover the original UV range.
`packages/core/src/harness/render.ts`'s `gatherFragments` read TEXCOORD_0
raw and had no knowledge of the extension at all, so every fragment sampled
a texel from roughly 1/16th of the correct region — for `KHR_texture_
transform`'s access via `@gltf-transform/extensions`. This is not
gltfpack-specific: any GLB an agent hands to `verify`, `optimize_glb`,
`compare_glb`, `align`, or `dataset` — Blender-exported, Meshy-generated,
anything that atlases or tiles textures — hits the same wrong-texel
sampling. The renderer would either fail a fine asset (as here) or, in the
unlucky case where the wrong texel happens to look similar, silently pass a
genuinely broken one.

### L13 · `fixed` · the SSIM/render harness ignored `KHR_texture_transform` and could score a correct asset as ruined (or a wrong one as fine)

Fixed in `gatherFragments` (`packages/core/src/harness/render.ts`): read the
base-color `TextureInfo`'s `KHR_texture_transform` extension, if present,
and apply its offset/rotation/scale to the raw UV before the fragment is
built. `verify` on the same gltfpack output now measures **ssim 0.9988** —
matches the geometry-only repack it actually is. This does not touch
`verifyRig()` (still exactly the four fixed cameras) or the shading
pipeline — it only fixes which texel gets sampled, and only when the
extension is present, so an asset without it renders bit-identical to
before: full `pnpm -r test` after the change is 175/178 core (was 174/177 —
+1 new test, same 3 skips), 44/44 mcp, 5+5skip/10 cli, 2/2 studio, all
unchanged in every count that isn't the new test. `pnpm probe -- --no-live`
shows no baseline regressions either.

New test: `packages/core/test/texture-transform.test.ts` — builds a small
quad two ways (UVs pre-scaled by hand vs. full-range UVs plus a
`KHR_texture_transform` doing the same scale) and asserts the renders are
pixel-identical, and that both differ from the untransformed render (so the
test isn't vacuous). Confirmed it's red without the fix (`expected false to
be true` on the pixel-identity assertion) and green with it.

**Caveat, stated because this repo holds claims to it:** I derived the
offset/rotation/scale composition from the extension's own translate ∘
rotate ∘ scale definition, but couldn't cross-check the rotation *sign*
convention against the authoritative Khronos spec text — this sandbox's
network is allowlisted to npmjs.org only, and the spec lives on GitHub. The
concrete repro (gltfpack's real output) only exercises offset+scale
(rotation is always 0 there), so that path is verified end-to-end by the
test above. The rotation term is implemented and present, but unverified
against a rotated fixture; if it's wrong, it only misfires on the rarer
rotated case, not the offset/scale (atlas/tiling) case that's actually
common and actually measured here.

## Left open

- `L12` (meshopt level) — needs LFS access to close responsibly; see above.
- Did not chase whether GLBForge's own pipeline ever emits `KHR_texture_
  transform` on its own outputs (it doesn't appear to — `quantize()`/
  `meshopt()` don't need the trick gltfpack uses) — `L13` matters for
  agent-supplied *input* GLBs to `verify`/`compare_glb`/`align`/`dataset`,
  not for GLBForge's own output path.
- Didn't get `gltfpack -tc`/`-tw` running (needs a native binary this
  sandbox can't fetch), so the cat.glb row's gltfpack column isn't a fair
  size comparison — noted in the table rather than left implicit.
- Didn't try Blender's exporter or `usdzconvert` — no display/Blender in
  this sandbox, and USDZ has its own oracle (`test/usd-oracle.py`) already
  covering conformance; a rival there would be a separate pass.
