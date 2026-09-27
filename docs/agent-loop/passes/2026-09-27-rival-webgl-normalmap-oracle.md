# Pass — 2026-09-27 — bcab2a4

**Role:** rival

## Step 0 — claim check

`pnpm ledger` on `main` prints `rival` as least-recently-used — but the real
rotation is badly lopsided, and getting worse: `mcp__github__list_pull_requests`
shows 20 open `agent-loop/*` branches, and **13 of them already claim
`rival`** (`#28`, `#38`, `#39`, `#40`, `#42`, `#44`, `#45`, `#46`, `#51`,
`#52`, `#53`, `#54`, `#56`). Not one of the 13 is merged, so `main`'s ledger
(1 open, 13 closed, rival at 0) doesn't see any of them — this is the same
role-rotation blind spot `#38`'s `L32` and `#40` already flagged. I'm not
re-filing that; it's tracked, and `#56` already restated it for whoever
merges next. I read all 13 in full before starting, specifically to avoid a
14th restatement of ground already covered.

The nearest neighbours are `#53` (found `harness/render.ts` never samples
the normal *texture* — it shades every material from the vertex `NORMAL`
attribute only, so two GLBs whose normal maps are one pure noise, one flat,
render byte-identical: `ssimMin: 1.0` either way) and `#40` (checked the SSIM
*math* itself against `ssim.js`, the Wang et al. reference implementation,
and explicitly left one axis unexplored: *"Didn't try a GPU/WebGL-rendered
oracle (the rasterizer's pixels against a real renderer, not just its SSIM
math) — no display in this sandbox; a different rival axis for another
pass."*

That's exactly the axis this pass takes, and the premise has changed: this
sandbox ships a headless Chromium at `/opt/pw-browsers/chromium-1194`
(confirmed working, WebGL via SwiftShader). `#53` itself named the same gap
from a different angle and left it explicitly open: *"Didn't try to
establish whether quality 95 is actually worth it in a real PBR viewer
(Studio, model-viewer) — only that GLBForge's own verification can't confirm
or deny it either way."* This pass answers that question with real evidence
instead of leaving it open a second time. Zero file overlap with any of the
13: this pass ships no `src` change at all (see below).

## Ground truth

`pnpm install && pnpm -r build`: clean, 6 packages. `pnpm -r test` before any
change: 177/180 core (3 skipped, LFS), 46/46 mcp, 5/10 cli (5 skipped, LFS),
2/2 studio — all green. `pnpm probe -- --no-live --json /tmp/probe-before.json`:
28 tools, packages 0.8.0, advice 3/3 resolved, 0 new findings, 0 dangling, no
regressions vs `docs/agent-loop/baseline.json`.

## What was measured

`harness/render.ts` (GLBForge's own verification renderer) shades from the
vertex `NORMAL` attribute and a single hardcoded Lambert term; it never
decodes or samples `material.getNormalTexture()` at all (`#53` established
this precisely). That means `optimize()`'s SSIM gate is structurally
incapable of judging whether `textureCompress({ quality: 95, slots:
/^normalTexture$/ })` (`optimize.ts:466-472`) is buying anything — the
code comment defends the 95 as protecting against "shading noise," but
nothing in this codebase can see shading noise from a normal map to check
that claim. This pass builds an independent check that *can*: a real WebGL
PBR renderer, not GLBForge's own instrumented rasterizer.

**Setup.** Extracted the real normal-map texture from `site/models/cat.glb`
(2048×2048, WebP, 1.31 MB as shipped — the same texture `#53` measured on
this same fixture). Re-encoded it with `sharp` at `quality: 82` (what every
other texture slot gets) and `quality: 95` (what `normalTexture` actually
gets), same isolation method `#53` used: source texture only, one parameter
varied. Sizes matched `#53`'s reported numbers proportionally: 59.7 KB
(q82) vs. 167.7 KB (q95) — a 2.8× byte cost for the higher setting.

Built a minimal three.js (`0.169.0`, already a `packages/studio` dependency)
scene — a lit plane, `MeshStandardMaterial`, real tangent-space normal
mapping via `computeTangents()` — rendered through headless Chromium
(`playwright-core` + the pre-installed browser, `--use-gl=swiftshader`).
Three normal-map variants (uncompressed source, q95, q82) rendered under
**two** lighting rigs with everything else held identical:

- **matte** (roughness 0.55, metalness 0.0, one directional key light) —
  the "can you see the bump detail at all" case.
- **shiny** (roughness 0.15, metalness 0.85, key light + a second
  directional light placed near the camera to catch a specular highlight)
  — deliberately the worst case for normal-map compression: per-texel error
  gets *amplified* into visible sparkle wherever a specular highlight sits,
  which is exactly the "shading noise" the code comment worries about, and
  a case a purely diffuse renderer (GLBForge's own) could never surface even
  if it did sample the texture.

Confirmed both renders show real, non-degenerate bump/specular detail
(screenshots inspected directly, not just diffed blind) — the matte render
shows the organic cracked-skin pattern from the source photo; the shiny
render shows a real specular hot-spot with visible bump-driven distortion
in it, not a flat highlight.

SSIM computed with `ssim.js` (the same Wang et al. reference `#40`
validated against) — both the whole-frame mean and the minimum 11×11
window (mirroring GLBForge's own "worst view, not average" philosophy in
`compare_glb`'s `ssimMin`, since a localized sparkle patch is exactly what
a frame-wide mean would dilute away):

| lighting | pair | mean SSIM | min-window SSIM |
|---|---|---|---|
| matte | source vs. q95 | 0.999524 | 0.995687 |
| matte | source vs. q82 | 0.999241 | 0.991444 |
| matte | **q95 vs. q82** | 0.999276 | 0.993163 |
| shiny (specular stress) | source vs. q95 | 0.999568 | 0.979854 |
| shiny (specular stress) | source vs. q82 | 0.999225 | 0.981721 |
| shiny (specular stress) | **q95 vs. q82** | 0.999370 | 0.986049 |

The number that matters is the bolded row: what a real PBR renderer shows
between the setting GLBForge ships (q95) and the setting every other
texture slot uses (q82). Even under the specular stress rig built
specifically to catch normal-map compression artifacts, q95-vs-q82 scores
**0.986** at the worst local window — and, critically, that's the *same
order of magnitude* as source-vs-q95 (0.980) and source-vs-q82 (0.982).
Quality 95 is not measurably closer to the uncompressed truth than quality
82 is; there is no cliff between them that the extra 2.8× of bytes is
buying, at least on this real, photographic normal map.

For calibration: the profiles this repo already ships gate simplification
at SSIM floors in the 0.73–0.96 range (`ROADMAP.md`'s calibration table:
"budget pass 0.958, 40k 0.896, 10k 0.73"). Every number in the table above
is well above the *loosest* of those floors — this isn't a borderline call.

## What changed

**Nothing in `src`.** This is a measurement pass, not a fix: one real
normal map, two lighting rigs, is real evidence but not enough to
unilaterally flip a texture-quality default that ships on every `optimize()`
call — especially since the code comment's own history (`nearLossless`
blowing a chess set's textures from 18.1 MB to 24.2 MB) shows this setting
was already once tuned by a bad surprise on an asset unlike this pass's
single sample. A harder-edged, more geometric normal map (mechanical parts,
not organic skin) is the case most likely to prove quality 82 insufficient,
and this pass didn't have one to test. Recommending, not shipping.

Also deliberately **not** touching `CLAUDE.md`: `#53` already added a
bullet in the same paragraph this finding would extend, and I can't see its
exact wording from an unmerged sibling branch — editing blind risks a
content collision on top of the already-known ID collision. Whoever merges
first should extend that bullet with this pass's finding.

No new devDependency either: `playwright-core` + `ssim.js` were installed
in a scratch directory outside the repo to run this measurement, not added
to `packages/core/package.json`. A headless-browser dependency is a poor
fit for this repo's "pure Node, no Blender"-style philosophy of keeping the
default test suite light and CI-portable (this sandbox happens to ship a
pre-installed Chromium; a stock GitHub Actions runner would need to fetch
one, which is a real cost for a one-off oracle check). The methodology
above is written out in full specifically so it's reproducible by anyone
who wants to re-run or extend it, without committing the tooling.

## Verify

No code changed, so `pnpm -r build && pnpm -r test` is unchanged from ground
truth: 177/180 core, 46/46 mcp, 5/10 cli, 2/2 studio. `pnpm probe --
--no-live`: identical to `/tmp/probe-before.json` (28 tools, 3/3 advice
resolved, no regressions). No `baseline.json` edit — nothing measured by the
probe moved.

## Left open

### L90 · `open` · An independent WebGL PBR render finds no visible benefit to normal maps' quality-95 override over the quality-82 every other texture slot gets

`optimize.ts`'s `textureCompress` call gives `normalTexture` `quality: 95`
against `quality: 82` for every other slot, defended by a comment about
avoiding "shading noise." `harness/render.ts` cannot check that claim at all
(`#53`'s finding: it never samples the normal texture). This pass built an
independent check that can — a real three.js/WebGL PBR render, under a
lighting rig deliberately chosen to stress-test normal-map compression
(a specular highlight, where per-texel error amplifies into visible
sparkle) — and found q95-vs-q82 scores 0.986 at the worst local window on
`cat.glb`'s real normal map, no closer to the uncompressed source than q82
is. High-confidence on this one asset; not broad enough to change the
default. **Closing this would take:** running the same rig (described in
full above, reproducible with `playwright-core` + `ssim.js` + a copy of
`three.module.js`) across a few more normal maps, especially something
hard-edged/mechanical rather than organic, then either lowering
`normalTexture`'s quality to match the other slots (cutting normal-map
bytes ~2.8× with a byte-size regression test, no `verifyRig()` involvement
since this doesn't touch geometry SSIM) or documenting a concrete
counter-example that justifies keeping 95.

Chose `L90` deliberately high (`main`'s ledger tops out at `L14`; `#38`
already claimed `L30`-`L32`, `#39` `L33`-`L35`, and both `#53` and `#56`
separately picked `L15` — the same collision `#40` first flagged) to avoid
being the *n*th finding to restate that exact collision on a busy id.
