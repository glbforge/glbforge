# Pass — 2026-10-01 — 289eacd
**Role:** rival

## Step 0 — claim check

`list_pull_requests` (`state: open`) on `glbforge/glbforge`: 25 open PRs with
`agent-loop/`-prefixed branches. 18 of them already claim `rival` — `#77`
(NORMAL synthesis cost), `#75` (STL watertight seams), `#74` (gltf-validator
oracle), `#72` (companion KTX2 loader), `#71` (meshopt vs gltfpack), `#69`
(basisu KTX2 format), `#62` (backlog-saturated, nothing new), `#61`
(transmission draw-call cost), `#58` (PBR-slot SSIM blind spot), `#57`
(WebGL normal-map oracle), `#56` (KTX2 SSIM blind spot), `#54` (skinned
triangle target), `#53` (normal-map SSIM blind spot), `#52`
(`computeSmoothNormals` vs `normals()`), `#51` (USD reference reader),
`#46` (`gltfjsx` node names), `#45` (three.js `ExtrudeGeometry`), `#44`
(Draco vs meshopt). `#62` itself is a rival pass that already documented
this exact saturation three days ago (2026-09-28) and said the rotation
can't see work sitting in open PRs because `main`'s ledger only counts
merged passes. It is worse now, not better: 18 open rival PRs vs. 16 then.

Read all 18 titles before touching anything. None of them compare a
**texture image codec** against GLBForge's own: the KTX2/basisu pairs are
about the GPU-resident compressed-texture path, not the WebP path every
non-KTX2 asset actually ships. That's the angle I took.

## Role

`pnpm install && pnpm -r build && pnpm ledger` prints **rival** as
least-recently-used (main's ledger: 0 open, 14 closed, 14 passes, rival
still shows 0 uses — same staleness `#62` already flagged). Taking it
anyway, per the skill: the rotation is mechanical, and skipping to an
easier role is the one move that breaks it. Picked an angle untouched by
the 18 open PRs rather than add a 19th variant of one of them.

## Ground truth

`pnpm install && pnpm -r build`: clean. `pnpm -r test`: core 177/180 (3
skipped, LFS pointers), meshy 13/13, studio 2/2, mcp 46/46, cli 5/10 (5
skipped, LFS) — all green before any change. `pnpm probe -- --json
/tmp/probe.json --markdown /tmp/probe.md --no-live`:

```
Surface 28 tools over stdio; packages 0.8.0, npm unknown
Advice 3/3 resolved (1); 0 new findings; 0 dangling
Latency (p50/p90): optimize_glb 2862/5236, compare_glb 571/1479, analyze_glb 80/663, ...
Vocab 33/130 codes exercised; 0 undeclared/undocumented/schema violations
No regressions vs baseline.
```

No code touched in this pass, so the after-numbers are identical (checked,
not assumed — see Verify below).

## Rival work: WebP vs. AVIF on `optimize()`'s actual texture output

`optimize()`'s only lossy raster format is WebP (`packages/core/src/optimize.ts:459-472`,
via `@gltf-transform/functions`'s `textureCompress`): quality 82 for every
slot except `normalTexture`, which gets quality 95 (a comment there explains
why: `nearLossless` used to bloat a detailed normal map 18.1MB -> 24.2MB,
so it was replaced with a plain high-quality lossy encode). No code path,
flag, or MCP tool parameter offers AVIF — `textureFormat` is `'webp' |
'ktx2'` only. `sharp` (the project's own encoder dependency, already
imported by `optimize.ts`) supports AVIF (`image/heif`, `.avif()`) with no
new install. That makes it a fair, in-sandbox rival: same encoder library,
different codec inside it.

**Asset:** `site/models/cat.glb` — a real, shipped, non-LFS asset (the only
multi-texture non-LFS GLB in the repo): three 2048x2048 WebP textures
(`base_color`, `metallic_roughness`, `normal`). I ran GLBForge's *actual*
`textureCompress` calls (imported verbatim from `optimize.ts`, not
reimplemented) against this asset's own source textures to get real
output, then decoded the same source pixels through `sharp().avif()` and
scored both against the untouched original with the project's own `ssim()`
(`harness/perceptual.ts`) — the same function `optimize()`'s fidelity gate
uses, just applied to one texture instead of a rendered view, so this
reuses the repo's own instrument rather than inventing a second one.

| texture | glbforge webp (real output) | best-matched avif (effort=9) | avif bytes vs. webp | encode time, webp vs. avif |
|---|---:|---:|---:|---:|
| `base_color` | 131,110 B, ssim 0.99760 | 192,262 B @ q82, ssim 0.99767 | **+47%** | 1.2s vs. 128.8s |
| `metallic_roughness` | 54,532 B, ssim 0.99843 | 142,550 B @ q90, ssim 0.99866 | **+161%** | 1.1s vs. 120.7s |
| `normal` | 167,674 B, ssim 0.99630 | **116,478 B @ q85, ssim 0.99650** | **-31%** | 1.4s vs. 121.3s |

Bytes are post-decode, pre-GLB-packing (the texture payload alone); SSIM is
each candidate decoded and compared against the original shipped texture,
not against the other candidate. "Best-matched" means: the AVIF quality
level, among those I tried, whose SSIM is closest to or above GLBForge's
own — I did not cherry-pick the smallest AVIF point, I picked the one that
actually clears GLBForge's own quality bar, then reported its bytes.

**Reading it honestly, both directions:**
- On `base_color` and `metallic_roughness` — ordinary colour/scalar
  channel-packed textures — **GLBForge wins outright**: AVIF needs 47-161%
  *more* bytes than WebP to reach the same fidelity on this content, at
  every quality point I tried (20 through 90, `effort` 4 and 9 both). This
  isn't a close call or an artifact of one bad setting; raising AVIF's
  `effort` to 9 (from the default 4) only closed part of the gap and never
  crossed it. Two of three rows are a clean, repeated loss for AVIF.
- On `normal` — high-frequency, directional gradient content, which is
  exactly the slot `optimize()` already treats specially — **GLBForge
  loses**: AVIF at quality 85 / effort 9 is simultaneously *smaller* (31%
  fewer bytes) and *higher-fidelity* (ssim 0.99650 vs. 0.99630) than
  GLBForge's current quality-95 WebP encode of the same source pixels. That
  is a real, reproducible instance of "GLBForge sometimes loses" on exactly
  the rival role's terms, and it lands on the one slot this repo already
  singled out for special handling (`optimize.ts`'s own nearLossless-bloat
  comment).
- **The catch that keeps this from being a one-line fix:** every AVIF
  number here used `effort: 9` (sharp/libvips' maximum), because at the
  default `effort: 4` AVIF didn't beat WebP on *any* of the three textures,
  normal map included (effort-4 encodes were smaller than effort-9 but also
  far less compressed per byte, never closing the gap to WebP). And effort-9
  is **not free**: 97-213 seconds per 2048x2048 texture, vs. 1.1-1.4 seconds
  for WebP — a 70-170x slowdown. `optimize_glb`'s own measured p50 latency
  is 2,862ms end-to-end (probe above); swapping even the one normal-map slot
  to AVIF at the quality level that wins would roughly 40-70x that single
  tool call's latency, just for one texture. A drop-in default-settings
  swap would not have found this win at all — it takes deliberately paying
  for the slowest setting the encoder has.

**Not fixed, deliberately.** `textureFormat` is a published option
(`OptimizeOptions.textureFormat: 'webp' | 'ktx2'`) and the MCP tool schema
documents it; adding a third value is new public surface, not a bug fix,
and the latency cost above means it can't default-on even if added — it
would need to be opt-in, scoped to the normal-map slot specifically (the
only slot where it wins), and the encode-time regression would need to be
visible to whoever turns it on. That's a maintainer-scoped feature
decision, not a one-pass change; recording where the real crossover sits is
the rival's job here.

## Secondary observation (not this pass's role, recorded for the next one)

While sourcing texture pixels for the comparison above, I ran `cat.glb`'s
own shipped textures through `optimize()`'s *current* `textureCompress`
calls and compared the result to what's actually embedded in the file:

| texture | shipped in `site/models/cat.glb` | current `optimize()` output from the same pixels |
|---|---:|---:|
| `base_color` | 137,732 B | 131,110 B |
| `metallic_roughness` | 60,288 B | 54,532 B |
| `normal` | **1,311,368 B** | **167,674 B** |

The shipped normal map is ~7.8x larger than what today's pipeline produces
from the identical source pixels — consistent with the exact `nearLossless`
bloat `optimize.ts`'s own comment describes as fixed. `git log --follow`
on this file is inconclusive (this repo's history is squash-merged per PR,
so file-add timestamps don't reliably date when content was last
*produced*), so I'm not asserting cause — only the measured fact: the live
site is shipping a demo asset ~1.14MB heavier than its own current
optimizer would produce from the same pixels, a 34% cut on the whole file.
Not a rival finding (no competing tool involved) and not mine to fix this
pass — flagged as `L16` below for an archaeologist, auditor, or the info
pass to pick up (likely: rebuild `site/models/cat.glb` through current
`optimize()`, or confirm deliberately).

## Verify

No source changed. `pnpm -r build && pnpm -r test`: unchanged, all green.
`pnpm probe -- --json /tmp/probe-after.json --no-live`: byte-identical
summary to the before run (same surface, same advice/vocab/latency
buckets within noise, no regressions vs. `docs/agent-loop/baseline.json`).
No baseline edit — nothing moved.

### L15 · `open` · `optimize()`'s WebP-only texture path loses to AVIF on normal maps specifically, at a steep encode-time cost

Measured on `site/models/cat.glb`'s real textures, run through `optimize()`'s
actual `textureCompress` calls (not reimplemented) and scored with the
project's own `ssim()`: on `base_color` and `metallic_roughness`, GLBForge's
WebP beats AVIF outright (AVIF needs 47-161% more bytes for equal fidelity,
at every quality/effort setting tried). On `normal` — the one slot
`optimize.ts` already treats specially because of a past `nearLossless`
regression — AVIF at quality 85 / `effort: 9` is both 31% smaller and
higher-fidelity (ssim 0.99650 vs. GLBForge's 0.99630) than the current
quality-95 WebP encode of the same source pixels. The catch: that result
only appears at `effort: 9` (sharp/libvips' max), which costs 97-213s per
2048x2048 texture vs. 1.1-1.4s for WebP — 70-170x slower, dwarfing
`optimize_glb`'s own measured ~2.9s p50. Closing this would mean a scoped,
opt-in `--avif` (or a normal-map-only AVIF override) with the latency cost
stated up front, not a default-path swap — a feature decision for the
maintainer, not a pass-sized fix.

### L16 · `open` · `site/models/cat.glb`'s shipped normal map is ~7.8x larger than what `optimize()`'s current pipeline produces from the same pixels

Measured, not inferred: feeding `cat.glb`'s own embedded textures through
`optimize()`'s actual `textureCompress` calls today yields `normal`:
167,674 B vs. the 1,311,368 B shipped in the file (also smaller on the
other two textures: `base_color` 131,110 vs. 137,732, `metallic_roughness`
54,532 vs. 60,288) — an 87% cut on the normal map alone, ~1.14MB off the
3.3MB file (34%). Consistent with the exact `nearLossless`-bloat bug
`optimize.ts`'s own comment says was fixed, but `git log --follow` on this
squash-merged history can't confirm *when* the shipped file was produced
relative to that fix, so this is reported as a present-tense measurement,
not a dated regression claim. Closing this is: rebuild
`site/models/cat.glb` (and spot-check `neon.glb`/`plush.glb`, both
texture-free per `listTextures()` so not exposed to this specific bug)
through current `optimize()` and recommit, or a maintainer confirming the
larger file is deliberate (e.g. hand-picked for showcase quality) and this
is `wontfix`.
