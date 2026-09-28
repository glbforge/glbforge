# Pass — 2026-09-26 — bcab2a4
**Role:** rival

## Step 0 — claim check

`gh pr list` isn't available in this sandbox; used the GitHub MCP tools
instead. Eleven open PRs carry `agent-loop/`-prefixed branches: `#52`
(rival, `computeSmoothNormals` vs `gltf-transform`'s `normals()` on
hard-edged geometry), `#51` (rival, USD reference oracle vs `toUsdz()`'s own
summary), `#46` (rival, `gltfjsx` node naming vs scaffold), `#45` (rival,
three.js `ExtrudeGeometry` vs `extrude_image` curve fidelity), `#44` (rival,
Draco vs meshopt geometry compression), `#43` (integrator, MCP relative
path), `#42` (rival, LOD/decimation fidelity vs `gltfpack -si`), `#40`
(rival, SSIM metric vs `ssim.js`), `#39` (rival, watertightness vs
Manifold), `#38` (rival, spec conformance vs the Khronos validator), `#34`,
`#32`, `#31`, `#30`, `#29`, `#28`, `#20` — older passes, other roles. `#41`
and `#50` aren't `agent-loop/`-prefixed (a CI workflow change and an
info-pass), outside this loop's claim convention.

Read every open rival pass file in full before picking anything, since
`rival` is what `pnpm ledger` prints as least-recently-used and eight other
passes already hold that role today. None of the eight touches texture
*encoding* — `#28` is the closest (it compared GLBForge's `optimize()`
against `gltf-transform optimize` for overall file size and attributed the
whole gap to `meshopt({ level: 'medium' })`, filing that as open `L12`). Its
own numbers show the texture payload differing too (its words: "Texture
bytes are close (353 KB GLBForge vs. 231 KB gltf-transform on cat.glb)") but
it calls that "close" and moves on without explaining a 35% gap. That
unexplained residual, on the same asset `#28` already used, is what this
pass measured. Zero file overlap with any open PR: this one touches
`optimize.ts`'s comment/behavior not at all (no code change to it),
`CLAUDE.md`, and adds one test to `perceptual.test.ts`.

## Ground truth

`pnpm install && pnpm -r build`: clean, six packages. `pnpm -r test` before
any change: 177/180 core (3 skipped, LFS), 46/46 mcp, 5/10 cli (5 skipped,
LFS), 2/2 studio, all green. `pnpm probe -- --no-live`: 28 tools, 3/3 advice
resolved, 33/130 codes exercised, 0 undeclared/undocumented/schema
violations, no regressions vs `baseline.json`. Only known item: `L4`
(`site/llms.txt`'s 0.9.0 line vs 0.8.0 packages) — a release call, left
alone as instructed.

## What was measured

Installed `@gltf-transform/cli@4.5.0` (npm, no other network needed) in a
scratch directory — the same rival `#28` used. Reproduced its exact
comparison on `site/models/cat.glb` (real, non-LFS, 150k triangles, PBR
texture set) to confirm the starting point before digging further:

- `glbforge optimize cat.glb -p mobile-hero`: **2,160,136 bytes**, steps
  report `textures -> webp @ 2048px (1.4MB -> 0.3MB)`, ssim 0.9997 — matches
  `#28`'s reported 2.16 MB / 0.9997 exactly.
- `gltf-transform optimize cat.glb --simplify false --texture-compress webp
  --texture-size 2048 --meshopt-level high`: **1,319,432 bytes** — matches
  `#28`'s reported 1.32 MB exactly.

Then, instead of stopping at "close," read every texture out of both GLBs
(`@gltf-transform/core`, `NodeIO` with meshopt registered) and compared
per-slot, not just total:

| slot | source (cat.glb) | GLBForge output | gltf-transform output | gap |
|---|---|---|---|---|
| base_color | 134.5 KB | 128.0 KB | 121.6 KB | 5% |
| metallic_roughness | 58.9 KB | 53.3 KB | 50.6 KB | 5% |
| **normal** | 1280.6 KB | **163.7 KB** | **53.3 KB** | **3.1x** |

Base color and metallic-roughness track within 5% — consistent with
GLBForge's quality 82 vs. `gltf-transform`'s unset (sharp default 80). The
*entire* gap `#28` dismissed as "close" lives in one slot: the normal map.
`optimize.ts:463-471` compresses everything at quality 82 except
`normalTexture`, which gets quality 95 — a deliberate choice, per its own
comment, because "lossy artifacts [in a normal map] show up as shading
noise rather than a subtle colour shift."

To isolate quality as the sole variable (no other tool, no other pipeline
difference), re-encoded cat.glb's own source normal map with `sharp`
directly, same resize (2048px), varying only quality:

| quality | bytes |
|---|---|
| 70 | 39.4 KB |
| 80 | 53.3 KB |
| **82** (GLBForge's colour-slot default) | 58.3 KB |
| 90 | 100.4 KB |
| **95** (GLBForge's normal-slot setting) | **163.7 KB** |
| 100 | 261.6 KB |

Quality 80 reproduces the rival's 53.3 KB exactly; quality 95 reproduces
GLBForge's 163.7 KB exactly. The 3.1x gap is not a different tool, a
different resize, or a different codec path — it is this one parameter, in
isolation, on this one asset.

### Does the SSIM gate that's supposed to justify quality 95 actually see it?

`optimize()`'s own doctrine (`CLAUDE.md`): "'No visible loss' is measured":
four fixed cameras, before/after, gated on SSIM. If quality 95 buys real,
measured protection against "shading noise," the harness should be able to
show a lower quality *does* introduce visible shading noise.

Read `harness/render.ts` in full: it shades every triangle from the
interpolated vertex `NORMAL` attribute (or `computeSmoothNormals` when
absent) — nowhere does it call `material.getNormalTexture()` or
`getNormalTextureInfo()`. Confirmed with a direct search
(`grep -n normalTexture packages/core/src/harness/render.ts` → no matches),
then empirically: built two otherwise-identical documents (one quad, one
material, one base-color texture) whose *only* difference is the normal
map's pixels — one flat (128,128,255), one pure per-pixel RGB noise — and
rendered both through `renderRaw` with the same frame and the same
`verifyRig()` cameras.

**Every pixel of every one of the four views is byte-for-byte identical.**
`perceptualDiff` between them scores `ssimMin: 1` — the same number
identity gets. The gate cannot distinguish a flat normal map from noise, let
alone quality 95 from quality 80. `optimize()`'s "no visible loss is
measured" claim, true for base color (verified by this same harness,
`prune()`'s factor/texture fold is exactly the case CLAUDE.md cites), does
not hold for normal maps — there is no visible-loss measurement to fail,
because the harness never looks.

### L15 · `open` · `optimize()`'s SSIM gate cannot see normal-map quality at all, yet a normal-map-specific quality setting is justified by an appeal to what it would show

Measured above, with a passing regression test
(`packages/core/test/perceptual.test.ts`, "normal map sampling") that pins
the current behavior: `renderRaw` shades from vertex `NORMAL` only, so any
two documents differing only in `normalTexture` bytes render identically
and score `ssimMin: 1`. `optimize.ts:452-457`'s comment defends quality 95
in shading-artifact terms — real for a PBR renderer, unverifiable by this
one. Concretely: raising the normal-map quality from 82 (what every other
texture slot gets) to 95 costs ~2.8x that slot's bytes (58.3 KB → 163.7 KB
on this asset) against a claim the pipeline's own verification step cannot
check either way.

**Not fixed here.** Two honest paths forward, both out of this pass's
scope: (a) make the renderer sample `normalTexture` for real specular/diffuse
response — a shading change, which CLAUDE.md is explicit falls under the
frozen-`verifyRig()` rule ("a deliberate pass of its own": re-measure the
LFS calibration points, republish profiles, record the before/after in
`docs/BUDGETS.md` — not doable without LFS access, which this sandbox
doesn't have); or (b) drop the normal-map quality to match the other slots
(82, or the rival's 80) and accept the byte savings, since nothing today
measures a cost to doing so — but that's a real behavior change to a
shipped path with no fixture to validate against here either. Left as an
explicit choice for the maintainer, with the regression test as a tripwire:
whichever path is taken, this test either needs updating (renderer now
samples the texture, so the two documents legitimately render differently)
or stays green (quality changed, sampling still doesn't happen).

Added a clarifying line to `CLAUDE.md` next to the existing base-color
transfer-function rule, so the next pass doesn't have to re-derive this from
`render.ts`'s source.

### L16 · `open` · `mobile-hero`'s published rationale says "near-lossless for normal maps"; the shipped code hasn't done that since before this repo's earliest reachable history here

`profiles.ts`'s `mobileHeroV1.rationale.maxTextureBytes`: *"WebP at quality
82 (near-lossless for normal maps) keeps three 2K maps around 1–3MB."*
`optimize.ts:452-457`, unchanged in this sandbox's view of history, uses
quality 95 — not `nearLossless` — specifically *because* `nearLossless`
regressed a real asset ("the whole texture payload of a chess set grew
18.1MB -> 24.2MB"). The published rationale for a versioned budget profile
describes a compression mode the code doesn't use.

**Not fixed here**: `profiles.ts` says its own rule plainly — "Never edit a
published profile in `core/src/profiles.ts`; append a new version and a
`docs/BUDGETS.md` changelog entry" — and this string is part of
`mobileHeroV1`, not a separate, safely-editable surface. Whether a rationale
*correction* (no cap changes, just a truer sentence) needs a full version
bump, or is exempt because `RULE_PROFILE_VERSIONS`/tests only freeze the
numeric caps, is a call `docs/BUDGETS.md`'s own conventions should make —
flagging rather than guessing.

## Verify

`pnpm -r build && pnpm -r test`: 178/181 core (+1 test, 3 skips unchanged),
46/46 mcp, 5/10 cli (unchanged), 2/2 studio — all green. New test confirmed
red without the finding being true (temporarily added
`material.getNormalTexture()` sampling as a one-line experiment, saw the
test fail as expected, then reverted the experiment — the committed state
has no renderer change, only the test). `pnpm probe -- --no-live`: no
regressions vs `baseline.json`; latency deltas are host noise, not
re-frozen.

## Left open

- `L15`, `L16` above — both need a maintainer call (a shading-model change
  needs LFS access this sandbox doesn't have; a rationale correction needs
  a versioning-policy call this pass isn't positioned to make).
- Did not chase whether ORM (occlusion/roughness/metalness) textures have
  the same gap — they're compressed at the *same* quality (82) as color, per
  `optimize.ts`'s `slots: /^(?!normalTexture)/` pattern, and this pass's own
  per-slot table above shows `metallic_roughness` tracking the rival within
  5%, so there's no equivalent finding there.
- Didn't try to quantify whether quality 95 buys anything even in a real PBR
  viewer (Studio, `model-viewer`) — plausible that it does, for a base map
  this detailed, at close range; this pass only established that GLBForge's
  own verification step can't confirm or deny it, not that the setting is
  wrong.
- `L4` (`site/llms.txt` version line) untouched, per the standing
  instruction.
