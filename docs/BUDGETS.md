# Budget profiles: methodology and versions

GLBForge budgets are **contracts, not advice**: `glbforge analyze` exits
non-zero when an asset breaks its profile, the GitHub Action gates on it, and
`optimize` targets it. A contract you cannot pin is not a contract, so every
profile is **versioned**. A cap never changes in place: any change is a new
version appended here with the reason, and `--profile mobile-hero@1` (CLI,
Action, MCP) keeps meaning exactly what it meant when you wrote it.
`--profile mobile-hero` resolves to the latest version. Reports carry the
label (`mobile-hero@1`), and `list_profiles rationale=true` returns this text
from the MCP server.

Live copy: https://glbforge.dev/budgets/ · Source of truth:
`packages/core/src/profiles.ts` (every published version is frozen there and
tested).

## The model behind the numbers

The caps come from a small explicit model rather than from any one device:

- **Payload before raster.** Modern GPUs, including mid-range phones, rasterize
  far more triangles per frame than a web page can afford to *download and
  parse*. Triangle caps are therefore set where the compressed geometry
  (welded, quantized, meshopt-compressed: roughly 8–12 bytes per triangle
  with normals and UVs) plus textures fits the file cap, and where our
  fixtures stop losing visible detail.
- **GPU memory is decoded, not compressed.** A texture costs its RGBA8 size
  plus a third for mipmaps once uploaded — a 2K map is ~21MB, a 4K map ~85MB —
  regardless of how small the WebP was. Mobile browsers share that memory
  with the OS and drop WebGL contexts that get greedy. `tex/vram-estimate`
  reports this number; KTX2/BasisU stays compressed on the GPU (4–8x less),
  which is why the KTX2 path exists.
- **Time to first useful frame.** File caps are sized to the network a
  visitor of that page type plausibly has: 4G (10–15Mbps effective) for a
  mobile hero, 50Mbps for a desktop hero, and "loaded on demand behind a
  click" for a configurator part.
- **Draw calls and materials scale CPU cost**, not GPU cost: state changes,
  shader variants, and scene-graph traversal per frame in JavaScript.
- **Visible loss is measured.** The `minSsim` floor is the weakest of four
  fixed-camera renders (256px, 2x supersampled, smooth shading, textured)
  before vs after optimization, scored with SSIM (Wang et al. 2004, 11x11
  Gaussian window). Shading runs in linear light and the rendered pixels are
  sRGB-encoded, the way a viewer does it. Floors were calibrated on the Meshy
  7 fixture (1.99M triangles): the mobile-hero budget pass to 150k measures
  0.964 with the 4K-texture variant and 0.979 with 2K; a 40k version 0.913
  with visibly merged hair; 10k measures 0.751. (Pre-0.9.0 numbers on the
  same fixture were 0.958 / 0.896 / 0.709 — see the v2 changelog entry.)

These are working assumptions, stated so they can be argued with. When usage
data disagrees, the cap moves in a new version — never silently.

## How the score is computed

`perf/*` findings are budget violations (errors, −15 each; any error fails
the asset). `geo/*`, `topo/*`, `mat/*`, `tex/*`, `scene/*` findings are
warnings (−5) or info (0) describing defects typical of AI-generated assets,
each with a concrete fix. `fidelity/perceptual` is an error when the measured
SSIM is under the floor and an info finding carrying the number otherwise.
Score = 100 − penalties, floored at 0.

## Profiles (current versions)

### mobile-hero@2 — single hero asset on a mobile landing page (4G, mid-range GPU)

| cap | value | why |
|---|---|---|
| maxTriangles | 150,000 | A mid-range phone GPU (2019+ Adreno 6xx / Mali-G7x / Apple A12 class) rasterizes 150k triangles in well under a millisecond; the binding constraint is payload. 150k welded, quantized, meshopt-compressed triangles land around 1–2MB, which leaves room for textures inside the file cap. It is also where our fixtures stop losing visible detail (the Meshy 7 hero measures SSIM 0.964 at 150k). |
| maxDrawCalls | 4 | Every primitive is a draw call with its own state changes plus scene-graph cost on the JS side, and a hero shares the frame with the page itself. One to four is a hero; more is a scene. |
| maxTextureSize | 2048 px | A 2K RGBA8 texture with mipmaps is ~21MB of GPU memory; a color/normal/ORM set of three fits the VRAM cap. 4K quadruples that and rarely reads sharper on a phone-sized viewport. |
| maxTextureBytes | 4 MB | Compressed image payload inside the GLB. WebP at quality 82 (near-lossless for normal maps) keeps three 2K maps around 1–3MB. |
| maxTextureVramBytes | 128 MB | Decoded, mipmapped GPU memory; leaves headroom for framebuffers, the DOM, and a second asset. KTX2 counts at its GPU-compressed size. |
| maxFileBytes | 6 MB | About 3–5 seconds on a typical 4G link — the most a hero can hide behind a poster image before it reads as broken; under a second on Wi-Fi or 5G. |
| maxMaterials | 2 | Materials multiply shader variants and texture sets. A hero is one material, two when a glass or emissive part is unavoidable. |
| minSsim | 0.94 | Calibrated on the Meshy 7 fixture: budget pass 0.964 (4K textures; 0.979 at 2K), 40k-triangle version 0.913 with visibly merged hair. The floor sits between them. |

### desktop-hero@2 — hero asset on a desktop-first marketing page

| cap | value | why |
|---|---|---|
| maxTriangles | 500,000 | Integrated desktop GPUs handle 500k triangles per frame comfortably; beyond that, payload and parse time on first load dominate. |
| maxDrawCalls | 8 | Desktop browsers absorb more state changes per frame, and a desktop hero is often a small assembly (product + stand + shadow catcher). |
| maxTextureSize | 4096 px | Justifiable on a large viewport where the hero fills half the screen; a 4K RGBA8 with mips is ~85MB decoded, so only the color map should be 4K. |
| maxTextureBytes | 12 MB | One 4K color map plus 2K normal/ORM maps in WebP. |
| maxTextureVramBytes | 256 MB | Plentiful but shared with tabs and the compositor; keeps a two-asset page under half a gigabyte. |
| maxFileBytes | 20 MB | About 3 seconds on a 50Mbps connection; desktop visitors tolerate a progressive reveal behind a placeholder up to that. |
| maxMaterials | 4 | Body, glass, metal trim, screen — a typical product hero without a material zoo. |
| minSsim | 0.96 | Viewed larger, so stricter than mobile; the budget pass to 500k measures 0.986–0.993 on our fixtures. |

### product-configurator@2 — interactive product viewer; many assets coexist

| cap | value | why |
|---|---|---|
| maxTriangles | 250,000 | Several variants stay resident and the camera gets close; balances close-up fidelity against three or four assets loaded at once. |
| maxDrawCalls | 12 | Swappable parts are separate meshes by design (a draw call each) — a dozen, not a hundred. |
| maxTextureSize | 2048 px | Keeps a multi-variant texture set inside the shared VRAM cap; the camera moves and materials swap, so 4K rarely pays. |
| maxTextureBytes | 8 MB | A full PBR set at 2K in WebP plus one variant map. |
| maxTextureVramBytes | 128 MB | Same ceiling as mobile because a configurator page often is on mobile, and several assets share it. |
| maxFileBytes | 12 MB | Loaded on demand behind an explicit user action, so larger than a hero that must appear on first paint. |
| maxMaterials | 8 | Colorways and finishes are the point; eight covers realistic part counts while keeping shader compilation bounded. |
| minSsim | 0.95 | Close-up viewing argues strict, coexistence argues lenient; the midpoint, and the budget pass to 250k measures 0.977–0.987 on our fixtures. |

## Changing a cap

1. Append a new `Profile` object (version N+1) in `profiles.ts`; never edit a
   published one (the test suite freezes v1's numbers).
2. Update the rationale for every cap that moved and add a changelog entry
   below with the evidence.
3. `getProfile('name')` now returns N+1; anyone pinned to `name@N` is
   unaffected until they opt in.

## Changelog

- **v2 — 2026-09-11. No cap moved; the measurement was corrected.** The
  verification renderer sampled base-color *textures* as if their bytes were
  already linear, while `baseColorFactor` is stored and used as linear. Any
  surface that moved between those two slots was therefore scored across two
  different transfer curves — and the pipeline moves colour between them by
  itself: `prune()` folds a base-color texture that is one solid colour into
  the factor and drops the image. The delivered asset was correct and
  smaller; `verify` reported it as visibly lossy and failed the budget.

  The renderer now decodes texels through sRGB, composes `factor * texture`
  as glTF defines it, shades in linear light, resolves supersamples in linear
  light, and sRGB-encodes the output. Isolated, the fold that used to score
  **0.9045** now scores **1.0000** (`base color transfer curves` in
  `packages/core/test/perceptual.test.ts`).

  This moves every SSIM the tool reports, so the floors were re-derived
  rather than assumed. Weakest of four views, textured, on the Meshy 7
  fixture:

  | case | @1 | @2 |
  |---|---|---|
  | mobile-hero budget pass, 2K textures | 0.9761 | 0.9794 |
  | mobile-hero budget pass, 4K textures | 0.9594 | 0.9637 |
  | 40k triangles (visibly merged hair) | 0.8999 | 0.9132 |
  | 10k triangles | 0.7094 | 0.7511 |
  | desktop-hero budget pass (500k) | 0.9918–0.9873 | 0.9929–0.9864 |
  | product-configurator budget pass (250k) | 0.9850–0.9765 | 0.9871–0.9774 |

  Every floor still sits between its budget pass and its counter-example, so
  **all three caps are unchanged** and every profile's budget pass still
  clears with margin. The version moves anyway: the rationale text quotes
  numbers that a reader will compare against their own runs, and `@1` has to
  keep meaning what CI recorded before 0.9.0. Note that pinning `@1` does not
  restore the old renderer — there is one renderer and it is now correct;
  the pin preserves the caps and the record of how they were derived.
- **v1 (additive) — 2026-09-11.** All three v1 profiles gained a `rules`
  field: they pin the `core-geometry@1` rule pack and report its topology
  findings (`topo/open-edges`, `topo/non-manifold`,
  `topo/floating-fragments`) as **info** — a renderer does not care whether
  a mesh is a closed solid. The same rules are warnings under the
  `authoring@1` rule profile and will be errors under future print profiles.
  No cap moved and no exit code changed, so the version stays at 1.
- **v1 — 2026-09-07.** First versioned release. Caps unchanged from the
  unversioned 0.4.x profiles, plus the new `minSsim` perceptual floor
  (calibrated as described above) and a published rationale per cap.
