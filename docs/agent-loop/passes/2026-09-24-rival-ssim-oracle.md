# Pass — 2026-09-24 — 09397cd
**Role:** rival

## Step 0 — claim check

`gh pr list --state open --json number,title,headRefName --jq '.[] | select(.headRefName | startswith("agent-loop/"))'` (via the GitHub MCP tools; `gh` itself isn't available here) returned six open `agent-loop/`-prefixed PRs. Three already claim **rival**: `#28` (`gltf-transform`/`gltfpack` vs. `optimize()` on file size and wall-clock), `#38` (Khronos `gltf-validator` vs. `inspect`/`analyze` on spec conformance), `#39` (`manifold-3d` vs. `export_stl`'s watertight claim). Read all three in full. None touches the perceptual-fidelity metric itself — the SSIM computation that gates every `optimize()` "no visible loss" claim (`harness/perceptual.ts`) has never been checked against an outside implementation. This pass keeps the role, picks a fourth alternative (`ssim.js`, the standard JS port of the Wang et al. 2004 reference SSIM) and a fourth axis (does GLBForge's own fidelity *measurement* agree with a published one, not the optimizer's output). Zero file overlap with any of the three PRs' diffs (they touch `optimize.ts`/`detect.ts`/tests only; this pass touches `harness/perceptual.ts`'s test coverage and adds one new test file).

`#38`'s pass also surfaced `L32`: seven open branches (now counting this one, eight) picked `L12` independently, because `pnpm ledger`'s "next free id" only sees `main`, not sibling unmerged PRs. Confirmed this myself before writing anything down: fetched all six open `agent-loop/*` branches and grepped their pass files — six collided on `L12`/`L13`, `#38` used `L30`–`32`, `#39` used `L33`–`35`. `L32` is `#38`'s finding and already `open`; not re-filing it or fixing `scripts/ledger.mjs` myself (that's `#38`'s claim, and the fix is a judgement call about the loop's own tooling, not this pass's product-facing axis). This pass's new findings start at `L36` to avoid a ninth collision.

## Ground truth

`pnpm install && pnpm -r build`: clean, 6 packages. `pnpm -r test` before any change: 175/178 core (3 skipped, LFS), 44/44 mcp, 5/10 cli (5 skipped, LFS), 2/2 studio, 13/13 meshy — all green. `pnpm probe -- --no-live`: 28 tools, no regressions vs. `baseline.json`. Only known item: `L4` (`site/llms.txt`'s 0.9.0 line, a release call), left alone.

## What was measured

Installed `ssim.js@4.0.1` (pure JS, zero dependencies, the standard npm port of the Wang et al. 2004 MATLAB reference implementation — the same paper GLBForge's own `harness/perceptual.ts` docstring cites) as a `packages/core` devDependency. Ran both implementations, with matched parameters (11×11 window, σ=1.5, K1=0.01, K2=0.03 — GLBForge's own constants), on identical rendered pixel buffers from `renderRaw`.

**Full-coverage synthetic images** (no background, isolates the math from GLBForge's union-mask/coverage design):

| test | GLBForge | ssim.js (reference) | delta |
|---|---|---|---|
| flat luminance shift, +5..+120/255 | 0.999673 – 0.953819 | 0.999540 – 0.935131 | 0.0001 – 0.019 |
| checkerboard, small phase shift | 0.008083 | 0.008063 | 0.00002 |
| checkerboard, full structural inversion | **0.000000** (floored) | **−0.983868** | clamp discards the sign |

Root cause of the small, growing luminance-shift delta: the reference port uses MATLAB-style `filter2(..., "valid")` (crops a `windowSize/2`-pixel border, computes nothing there); `harness/perceptual.ts`'s `blur()` clamps at the edge instead, so every pixel gets a score. Confirmed by elimination: a full-frame *constant* shift (zero local variance everywhere, so boundary handling can't matter) matches the reference to 6 decimal places at every shift tested — the luminance/covariance math itself is exact. The divergence only appears once local variance and window-boundary effects are both present, and tops out at 0.019 in a synthetic case (a uniform 47%-of-range brightness shift across the entire covered region) more extreme than anything the real-asset test below produced.

The clamp (`Math.min(1, Math.max(0, sum / count))` in `perceptual.ts`) discards the sign on structural inversion. This is a real, measured divergence, but it doesn't reach any GLBForge asset in this pass's testing: two renders of related geometry are never a coherent phase-inverted checkerboard, and — more to the point — it can't flip a verdict, since both "very dissimilar" and "adversarially inverted" already fail every profile's `minSsim` floor (0.94–0.96) either way.

**Real decimation, rendered through `verifyRig()`** (a ring mesh, `mobile-hero` profile, `--target 300`, the same fixture `test/perceptual.test.ts` uses):

| view | GLBForge (masked) | ssim.js (naive full-frame) | GLBForge is lower by |
|---|---|---|---|
| verify_45 | 0.857 | 0.972 | 0.114 |
| verify_135 | 0.842 | 0.969 | 0.127 |
| verify_225 | 0.745 | 0.949 | 0.205 |
| verify_315 | 0.754 | 0.950 | 0.196 |

(Also ran `cat.glb`/`plush.glb`/`neon.glb` at forced low triangle targets from `site/models/` with the same pattern — GLBForge's masked score was 0.06–0.20 lower than the naive reference on every decimated view; identical at `ssim=1.0` when nothing changed.)

This is the opposite direction from the synthetic-case delta, much larger, and it's the one that matters operationally: `perceptual.ts`'s docstring claims the union-mask design exists "so a small object on a large identical background can't coast to a high score." Measured directly against a reference oracle that doesn't mask, that claim holds — a naive full-frame SSIM would report real, visible decimation as 0.95–0.97 (comfortably above every profile's floor) on assets GLBForge's own gate correctly scores at 0.74–0.86 (a hard fail). GLBForge is the stricter, safer implementation on the axis that actually governs the `optimize()` verdict; a reference library used naively on the same renders would pass simplification an agent should not ship.

## What was fixed

Nothing in `packages/core/src`. No wrong promise was found — the masking docstring's claim is validated, not contradicted, and the boundary-handling/clamping deltas are real but too small (and too synthetic) to move any pass/fail verdict measured in this pass. Re-deriving `blur()`'s edge handling to match MATLAB's `"valid"` convolution exactly would change every reported SSIM number by a small amount, which is exactly the class of change `CLAUDE.md`'s frozen-`verifyRig()` rule gates behind re-measuring the LFS calibration fixtures and republishing a profile — not something to do unilaterally from a 0.019-on-a-synthetic-extreme finding.

**Added:** `packages/core/test/ssim-oracle.test.ts` — four tests, `ssim.js` as the oracle: (1) full-coverage luminance-only shift matches the reference to 5 decimal places; (2) full-coverage structural shift stays within 0.02; (3) pins the clamp-vs-negative-SSIM behavior explicitly, so it's a documented, tested design choice instead of an implicit one; (4) pins that real decimation scores at least 0.02 lower under GLBForge's masking than the naive reference — the regression guard for the claim this pass actually validated. If a future change to `blur()`, the union mask, or the coverage dilation quietly erodes that gap, this test catches it. `ssim.js` added as a `packages/core` devDependency (test-only, matches the pattern `#39` set with `manifold-3d`).

## Verify

`pnpm -r build && pnpm -r test`: 179/182 core (+4 tests, 3 skipped LFS unchanged), 44/44 mcp, 5/10 cli (unchanged), 2/2 studio, 13/13 meshy — all green. `pnpm probe -- --no-live`: no regressions vs. baseline; latency deltas are normal host noise (p50/p90 shifts of a few ms across every tool, no systematic direction), not re-frozen.

## Left open

- `#38`'s `L32` (ledger ID collision across concurrent unmerged branches) — reconfirmed independently (six-way collision on `L12`, this pass's IDs pushed to `L36` to avoid a ninth), left to `#38` as the PR that raised it.
- Didn't try a GPU/WebGL-rendered oracle (comparing GLBForge's software rasterizer's pixels, not just its SSIM math, against a real renderer) — no display in this sandbox; a different rival axis for another pass.

### L36 · `watching` · GLBForge's SSIM diverges from the Wang et al. reference implementation by up to 0.019, on synthetic full-coverage extremes only

Measured: `harness/perceptual.ts`'s `ssim()` and `ssim.js` (the standard reference port) agree to 5 decimal places on a full-coverage constant-luminance shift (isolates the covariance-free luminance term) at every magnitude tested. They diverge by up to 0.019 once local variance is introduced (a full-coverage checkerboard at a 47%-of-range shift) — root-caused to GLBForge's edge-clamped ("same"-size) Gaussian convolution vs. the reference's cropped ("valid") convolution, which excludes a `windowSize/2`-pixel border instead of scoring it. On real decimated assets (the actual use case — a small rendered object on background, not a synthetic full-coverage extreme), the dominant effect is the opposite and far larger: GLBForge's union-mask design scores 0.06–0.20 *lower* than a naive full-frame reference, which the new `ssim-oracle.test.ts` pins as a regression guard. Closing the 0.019 boundary-handling gap means matching MATLAB's `"valid"` window exactly, which is a `verifyRig()`-adjacent change under `CLAUDE.md`'s versioned-profile rule (needs the LFS-fixture re-measurement, unavailable in this sandbox) for a delta no real asset in this pass came near a `minSsim` floor with. Watching: re-open if a future pass finds a real (non-synthetic) asset where this delta is large enough to matter near a 0.94–0.96 floor.
