# Pass — 2026-09-27 — bcab2a4
**Role:** rival

## Step 0 — claim check

Listing open PRs (16 `agent-loop/*` branches) shows rival already
claimed twelve times over: `#28` (gltf-transform/gltfpack vs. `optimize()` on
size), `#38` (Khronos `gltf-validator` on conformance), `#39` (`manifold-3d`
on the watertight claim), `#40` (`ssim.js` vs. the masking design — the
closest prior art to this pass, see below), `#42` (gltfpack on LOD fidelity),
`#44` (Draco vs. meshopt), `#45` (three.js `ExtrudeGeometry` on curve
fidelity), `#46` (gltfjsx on scaffold node names), `#51` (Pixar's USD reader),
`#52` (`normals()` on hard edges), `#53` (the SSIM gate's blind spot on
normal-map *texture content* — read this one closely, see below), `#54`
(skinned triangle-target miss). `pnpm ledger` on `main` still prints `rival`
as least-recently-used because none of the above are merged; the real
rotation is badly lopsided and this pass does not pretend otherwise. Read
every title above in full before picking an angle. Filed no review comments —
none of the twelve touch what this pass found.

`#53` is the nearest neighbour and worth distinguishing precisely: it found
that `harness/render.ts` shades every normal map from the vertex `NORMAL`
attribute alone and never calls `getNormalTexture()` — a renderer limitation
that holds *regardless of texture format*, always, for normal maps only. This
pass's finding is a different mechanism with a much wider blast radius: when
`textureFormat: 'ktx2'` is requested, `optimize.ts`'s own ternary
(`opts.textureFormat === 'ktx2' ? undefined : …`) disables the texture
*decoder* entirely, for *every* slot — base color, ORM, normal — on *both*
renders. Zero file overlap in the fix; the two findings compose (ktx2 mode is
additionally blind in the way `#53` describes, on top of losing base color
and ORM verification `#53` never touched).

## Ground truth

`pnpm install && pnpm -r build`: clean, 6 packages. `pnpm -r test` before any
change: 177/180 core (3 skipped, LFS), 46/46 mcp, 5/10 cli (5 skipped, LFS),
2/2 studio — all green. `pnpm probe -- --no-live`: 28 tools, 3/3 advice
resolved, 33/130 vocab codes, no regressions vs. `baseline.json`. Neither
`basisu` nor `toktx` is installed in this sandbox — the existing KTX2 test
(`analyze.test.ts`'s `describe('ktx2', …)`) already skips silently for this
reason, so this pass could not exercise the real encoder either.

## What was measured

`optimize()` snapshots the reference render **before any mutation**, using a
decoder chosen once by `opts.textureFormat === 'ktx2'` alone
(`optimize.ts:220-229`) — not by whether the texture actually ends up
undecodable. Two things fall out of that:

1. **The SSIM gate cannot see texture loss at all in `ktx2` mode.** Not "sees
   it less precisely" — literally never decodes a texture on either side, so
   both renders fall back to the flat `baseColorFactor`. A KTX2 encode that
   introduced real ETC1S banding or UASTC ringing scores byte-identical to
   one that changed nothing.
2. **It triggers on the requested format alone, before the encoder ever
   runs.** Passing `textureFormat: 'ktx2', textures: false` — texture
   untouched, still the original, perfectly sharp-decodable PNG — still
   reports `textured: false`. Confirmed directly against the real, public
   `optimize()` (not a reimplementation): `packages/core/test/perceptual.test.ts`,
   `"optimize()'s decoder-skip triggers on the requested format alone, even
   when textures are left untouched"`.

Then brought in an outside oracle — `ssim.js@3.5.0`, the standard npm port of
the Wang et al. 2004 reference SSIM (same paper `#40` used to validate the
masking design, applied here to a different axis: raw texture content, not
GLBForge's rendered-frame comparison) — and ran it directly on two textures
GLBForge's own gate is blind to under the exact `textureDecoder: undefined`
codepath `optimize.ts` uses for `ktx2`:

| oracle | what it measured | score |
|---|---|---|
| GLBForge's own gate (`perceptualDiff`, no texture decoder — `optimize()`'s exact `ktx2` codepath) | rendered frames, same silhouette, base color swapped from a coarse stripe pattern to pseudo-random noise | `ssimMin: 1.0` — **"no visible loss"** |
| `ssim.js` (Wang et al. reference), same two texture bitmaps, decoded pixels | the texture content itself | `mssim: 0.0033` — as close to fully dissimilar as two 64×64 images get |

GLBForge's own report would say a texture that lost 99.7% of its structural
similarity changed not at all — not because the number is wrong, but because
nothing was measured. The gap is the finding.

Checked the report-card message this feeds: `applyPerceptualVerdict`'s
passing branch said `"…no visible loss by measurement"` unconditionally, even
though `PerceptualResult.textured` (`textured: false` for this exact case)
was already sitting right there in `data`. That is a direct instance of
`CLAUDE.md`'s own certainty invariant — *"a finding's message states only
what was measured"* — being violated by the pipeline's most-quoted finding.

## What changed

- **`packages/core/src/harness/perceptual.ts`** — `applyPerceptualVerdict`'s
  passing message now branches on `verdict.textured`: `true` keeps the
  existing "no visible loss by measurement" wording; `false` says textures
  were not decoded for the comparison and texture-encode quality was not
  measured. No change to severity, `passed`, `score`, or the `data` payload
  — only the prose was overclaiming.
- **`CLAUDE.md`** — one clarifying addition to the existing "'No visible
  loss' is measured" bullet: the gate skips textures entirely for
  `textureFormat: 'ktx2'`, triggers on the requested format alone (not on
  whether the encode succeeded), and `PerceptualResult.textured` is the
  field that says which case ran.
- **`packages/core/test/perceptual.test.ts`** — three new tests: the message
  branch above (both `textured: true` and `false`, pinned against the
  literal strings), the real-`optimize()` reproduction of point 2 above, and
  the `ssim.js`-vs-GLBForge table above as a permanent regression (asserts
  `blind.ssimMin === 1` and `mssim < 0.3` together, so a future change that
  actually starts comparing ktx2-bound textures — or accidentally restores
  today's blindness after someone fixes it differently — shows up as a
  failing assertion either way).
- **`packages/core/package.json`** — `ssim.js` added as a devDependency
  (test-only, same pattern `#40` set with its own `ssim.js` addition and `#39`
  set with `manifold-3d`; this pass's `package.json`/lockfile edit is
  independent of theirs — different dependency version resolved, no shared
  lines).

No change to `optimize.ts`, `profiles.ts`, `ktx2.ts`, or any budget/rule/pack
contract. The underlying design choice — disable both sides' decoder
together rather than compare a textured reference to an untextured candidate
— is sound and stays; only the sentence claiming more than that design
actually verifies was wrong.

## Verify

`pnpm -r build && pnpm -r test`: 180/183 core (+3 tests, 3 skipped LFS
unchanged), 46/46 mcp, 5/10 cli (unchanged), 2/2 studio — all green.
`pnpm probe -- --no-live`: 28 tools, 3/3 advice resolved, 33/130 vocab codes,
no regressions vs. `baseline.json`; latency deltas (optimize_glb p50 2867→3168ms,
p90 5154→4937ms) are host noise on a 6-sample run, not re-frozen.
`pnpm docs:check`: in step (28 MCP tools, 21 CLI verbs, packages 0.8.0).

## Left open

- The KTX2 path itself is untested end-to-end in any sandbox this loop has
  run in so far (no `basisu`/`toktx`) — not filed as a finding, since the
  existing test already documents and skips around exactly this gap.
- Whether the *design* (decode neither side rather than one) is the right
  call at all, versus decoding the reference and diffing structure some other
  way, is a real question this pass did not chase — it would touch
  `verifyRig()`'s frozen calibration and belongs to a pass with LFS access to
  re-measure against, per `CLAUDE.md`.
- `#53`'s own two findings (its `L15`, `L16`) are its author's to carry,
  untouched here.
- `L4` (`site/llms.txt` version line) — untouched, a release call.
- The rotation itself: `rival` is now the most-used role in the whole loop by
  a wide margin (13 passes, all but one unmerged) while `integrator`,
  `performance`, and `archaeologist` sit at one or two. Not something one
  pass fixes — noting it so the next `pnpm ledger` reader sees the real
  shape of the backlog, not just what `main` shows.

### L15 · `open` · `optimize({ textureFormat: 'ktx2' })` never verifies texture fidelity — not just normal maps (`#53`'s finding), every slot, and it triggers on the requested format alone

Measured above: `PerceptualResult.textured` is `false` for every `ktx2`
build regardless of whether textures are even touched, and an independent
SSIM oracle applied to the same texture pixels GLBForge's own gate ignored
scored `mssim: 0.0033` against GLBForge's `ssimMin: 1.0`. The report-card
message no longer overclaims (fixed this pass), but the gap itself —
`ktx2` builds ship with zero perceptual guarantee on texture quality — is a
design question, not a wording bug, and is left `open`: closing it means
deciding whether to decode the reference only and diff some other way,
require a real KTX2 decoder in the harness, or accept the gap and document
it as a permanent limitation of the `ktx2` texture path. Any of those
touches `verifyRig()`'s frozen calibration per `CLAUDE.md` and needs the
LFS-fixture re-measurement that gates it — a maintainer call, not a
one-pass fix.
