# Pass — 2026-09-27 — bcab2a4
**Role:** rival

## Step 0 — claim check

`gh pr list --state open` (filtered to `agent-loop/*`) shows 20 open branches;
13 already claim `rival` (`#28`, `#38`, `#39`, `#40`, `#42`, `#44`, `#45`,
`#46`, `#51`, `#52`, `#53`, `#56`, `#57`). Read all 13 in full before picking
a target. Four of them (`#52`, `#53`, `#56`, `#57`) already mine the same
seam — the SSIM verification gate's blindness to normal-map and KTX2-texture
damage — and two of those (`#56`, `#57`) flag, without fixing, that `rival`
is now badly over-represented in the unmerged backlog because `pnpm ledger`
only counts merged passes. That's real and worth restating in plain prose
here so a fourth pass doesn't have to rediscover it, but re-filing it as a
finding would just be a fifth voice saying the same thing; it isn't this
pass's fix, and role selection isn't the thing this pass is measuring.

Given that, the responsible move was not to add a fifth entry to the
normal-map/KTX2 cluster (`#52`/`#53`/`#56`/`#57` already cover: crease angles,
normal-texture quality unverifiable, KTX2 decoder disabled entirely, and an
independent WebGL oracle on the quality-95 override). Instead this pass reads
`harness/render.ts` itself, past the normal-map slot, to ask what *other*
material inputs the "no visible loss" yardstick can and can't see. Zero file
overlap with any of the 13.

## What was measured

`gatherFragments` in `packages/core/src/harness/render.ts` builds exactly one
`Fragment.texture` per primitive — `material?.getBaseColorTexture()` — and
`rasterize()`'s whole shading model is
`lambert = 0.35 + 0.65 * |N·L|`, multiplied by `factor * baseColorTexture`.
There is no metallic/roughness/specular term, no emissive term, no occlusion
term, and no code path that ever calls `getMetallicRoughnessTexture()`,
`getEmissiveTexture()`, or `getOcclusionTexture()`. This is a stronger claim
than `#53`'s (that the normal texture is sampled at a quality the harness
can't verify): these two slots are never sampled in **any** quality, format,
or configuration.

`optimize.ts`'s own lossy texture pass (the same `slots: /^(?!normalTexture)/`
regex `#53` already identified) recompresses `metallicRoughnessTexture` and
`emissiveTexture` to WebP quality 82 — the identical treatment base color
gets. So whatever that pass does to those two slots, `optimize()`'s SSIM gate
cannot see it, in the default WebP path (not just the KTX2 path `#56`
covers).

**Internal proof** (`packages/core/test/perceptual.test.ts`, new
`describe('the SSIM gate has no shading term for metallicRoughness or
emissive')`):
- A UV sphere with a flat black `metallicRoughnessTexture` vs. the same
  sphere with a full-RGB-noise one (`metallicFactor`/`roughnessFactor` both
  1, decoder wired in via `textureDecoder: sharpTextureDecoder()`) —
  `ssimMin: 1` (pixel-identical).
- The same sphere with no emissive glow vs. a solid bright-red
  full-brightness emissive glow — `ssimMin: 1`.
- A real `optimize()` run (default WebP path, `compress: false` to isolate
  the texture step) on an asset whose only content is a noise
  `metallicRoughnessTexture` — `verdict.perceptual.passed: true`,
  `ssimMin: 1`.

**Non-vacuous, checked directly**: temporarily changed `gatherFragments` to
decode `getMetallicRoughnessTexture() ?? getBaseColorTexture()` instead of
base color alone, reran the first synthetic test — it fails,
`ssimMin: 0.0626` (`expected 0.0626 to be 1`) — then reverted before
committing (`git diff` on `render.ts` is empty in this pass).

**External oracle** (the `rival` half — not committed, matches `#57`'s
approach of running a browser-based oracle from a scratch directory rather
than adding a headless-browser dependency to this repo's test suite): the
same two material pairs, rendered through three.js's real
`MeshStandardMaterial` (metalness/roughness maps, an emissive map, a
directional + ambient light) in the sandbox's pre-installed headless
Chromium (`/opt/pw-browsers/chromium-1194`, confirmed WebGL2 via
SwiftShader — the premise `#40` and `#57` established), scored against the
Wang et al. reference (`ssim.js`, the same oracle `#40`/`#53`/`#56`/`#57`
all used):

| pair | GLBForge's own gate (`ssimMin`) | independent WebGL PBR renderer (`ssim.js` `mssim`) |
|---|---:|---:|
| metallicRoughness: solid vs. full RGB noise | **1.0000** — "no visible loss" | **0.2967** — a mottled, specular-flecked sphere vs. a smooth matte one |
| emissive: none vs. solid bright red glow | **1.0000** — "no visible loss" | **0.9588** — a grey sphere vs. a glowing red one |

Screenshots from the oracle run (not committed, generated fresh from the
methodology above): the metallicRoughness pair is a stark visual difference
— GLBForge's own gate calls it pixel-identical. Reproducible from a scratch
directory: `npm install playwright-core three ssim.js sharp`, serve a page
importing `three/build/three.module.js`, build two `MeshStandardMaterial`
spheres differing only in `metalnessMap`/`roughnessMap` or `emissiveMap`,
render via `chromium.launch({ executablePath:
'<PLAYWRIGHT_BROWSERS_PATH>/chromium-<rev>/chrome-linux/chrome', args:
['--use-gl=swiftshader'] })`, screenshot, score with `ssim.js`.

## What changed

- `packages/core/test/perceptual.test.ts` — three new tests (above), pinning
  today's blind spot as a permanent regression guard so a future PBR-shading
  addition to the renderer has to consciously update them.
- `CLAUDE.md` — one new bullet next to the existing linear/sRGB base-color
  rule, stating the renderer's actual shading scope so the next pass doesn't
  have to re-derive it from `render.ts`.
- No change to `render.ts`, `optimize.ts`, `profiles.ts`, or any budget/rule
  contract. Giving the harness a real metallic/roughness/emissive term is a
  `verifyRig()`-calibration change — `CLAUDE.md` reserves that for a
  dedicated pass that re-measures the LFS fixtures and republishes the
  profile commentary, not something to do speculatively here on synthetic
  geometry alone.

### L91 · `open` · `harness/render.ts`'s SSIM gate has no shading term for metallicRoughness or emissive

`harness/render.ts`'s SSIM verification gate has no shading term for
metallicRoughness or emissive input, and never decodes either texture in any
configuration; `optimize()`'s own lossy WebP pass at quality 82 touches both
slots, so damage there is unmeasurable regardless of format. Distinct from
`#52`'s crease-angle finding, `#53`'s normal-texture-quality finding, and
`#56`'s KTX2-decoder finding — same neighbourhood, different mechanism, no
file overlap. Picked a high id deliberately (following `#57`'s precedent)
given at least three sibling branches already collide on `L15`; take either
side on merge and re-run `pnpm ledger` per the standing instruction.

Closing it means one of: (a) add a real metallic-roughness + emissive
shading term to the rasterizer (the correct fix, but a `verifyRig()`
calibration change — re-measure the LFS fixtures, republish `profiles.ts`
commentary, record the before/after table in `docs/BUDGETS.md`, exactly the
process the 0.9.0 colour-space fix went through); or (b) document the gap as
a permanent, accepted limitation of the software-rasterizer approach. Either
is a maintainer call, not a one-pass fix.

## Ground truth

Before: `pnpm install && pnpm -r build` clean. `pnpm -r test`: core 177/180
(3 skipped, LFS), meshy clean, mcp 46/46, studio 2/2, cli 5/10 (5 skipped,
LFS). `pnpm probe -- --no-live`: 28 tools, 3/3 advice resolved, 33/130 vocab
codes, 0 undeclared/undocumented/schema violations, no regressions vs.
baseline.

After: `pnpm -r build` clean. `pnpm -r test`: core 180/183 (+3 tests, same 3
skips), everything else unchanged and green. `pnpm docs:check`: in step (28
MCP tools, 21 CLI verbs, packages 0.8.0 — no new tool, verb, or public
claim). `pnpm probe -- --no-live` (after):

```
Surface 28 tools over stdio; packages 0.8.0, npm unknown
Advice 3/3 resolved (1); 0 new findings; 0 dangling
Vocab 33/130 codes exercised; 0 undeclared/undocumented/schema violations
No regressions vs baseline.
```

Latency deltas (`optimize_glb` p50 2003→1918ms, p90 3331→3579ms, and similar
few-ms noise on every other tool) are normal host variance on a 6-sample run,
not a regression — `docs/agent-loop/baseline.json` untouched, nothing moved
on purpose or by accident.

## Left open

- `L91` — see above; a maintainer call on whether/how to extend the shading
  model.
- Didn't chase occlusion texture separately — same code path
  (`slots: /^(?!normalTexture)/` catches it too, and the renderer has no AO
  term either), but didn't build a separate synthetic case; the
  metallicRoughness/emissive pair already demonstrates the mechanism.
- Didn't touch the KTX2 path (`#56`'s territory) or the normal-texture
  quality setting (`#53`'s territory) — this pass is additive to both, not a
  substitute.
- The rotation-visibility gap `#56`/`#57` already raised (rival heavily
  over-represented among unmerged branches because `pnpm ledger` only counts
  merged passes) still holds; restated here in prose, not re-filed as a new
  ledger entry, per the standing instruction not to re-litigate what's
  already been said. Worth a maintainer's attention regardless of role: merge
  some of the 13 open `rival` PRs (or close the ones judged wrong, with a
  review comment) before the next scheduled pass runs, so the rotation can
  see reality again.
- `L4` (`site/llms.txt` "0.9.0 line" vs. 0.8.0 packages) — untouched, a
  release call, per standing instruction.
