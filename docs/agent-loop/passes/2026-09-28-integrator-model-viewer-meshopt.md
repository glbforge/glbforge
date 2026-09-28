# Pass — 2026-09-28 — 289eacd

**Role:** integrator

Ground truth was clean: `pnpm install && pnpm -r build`, `pnpm -r test` (all
packages, 231 tests) and `pnpm probe -- --no-live` all passed before any
change, and the probe showed no regressions after. `pnpm ledger` printed
`rival` as the next role, but that role is claimed for today: PR #62
(`agent-loop/2026-09-28-rival-backlog-saturated`, opened earlier today)
already exhausted the reachable rival territory in this sandbox — 16 open
rival PRs cover the SSIM gate's blind spots, four independent oracles, and
five tooling comparisons, and #62 itself tried three more angles past those
and closed them off, concluding the role's well is dry here. It also flags
integrator/performance/archaeologist as under-explored by comparison. Taking
`rival` again would either duplicate #62's own conclusion or one of the 16
open findings, so per Step 0 ("do not work on what an open PR covers") I took
the next role down: integrator. (integrator itself has two open PRs — #29,
#43 — but each claims one specific seam, not the role's whole territory, so
there was room to look at a different one.)

Integrator: "wire GLBForge into something real and watch the seams." #29
already drove the scaffold's own build; #43 already drove the MCP server
from an independent client. The seam neither touched: what happens when
`optimize()`'s own output reaches a real, independent glTF renderer — not
`harness/render.ts`, which is GLBForge grading its own homework, but the
actual runtime most of GLBForge's own marketing points at.

Chromium is pre-installed in this sandbox and `@google/model-viewer` is on
npm (allowlisted registry), so I installed model-viewer 4.3.1 and drove it
in headless Chromium (playwright, swiftshader) against four real, committed
GLBs: `assets/sample-ring.glb`, that file run through `glbforge optimize`,
`site/models/plush.glb` (already a glbforge-produced asset, shipped on the
landing page), and that file re-run through `optimize()`. The uncompressed
original loaded and measured a sane bounding box. All three files carrying
`EXT_meshopt_compression` — including `plush.glb`, GLBForge's own showcase
model — threw `THREE.GLTFLoader: setMeshoptDecoder must be called before
loading compressed files` and never rendered, in a page that just does
`<model-viewer src="...">` the way any first integration would. Re-running
with `ModelViewerElement.meshoptDecoderLocation` wired in (the same line
`site/index.html` already uses for its own demo, quietly) fixed all four —
confirmed by identical measured bounding boxes before/after. So the gap
was real, and the fix was verified, not assumed.

### L15 · `fixed` · optimize()'s default EXT_meshopt_compression output silently fails to load in `<model-viewer>` / plain three.js, and nothing told an integrator that

Measured, reproduced and fixed as described above. `site/index.html` was the
only place in the repo that knew a consumer needs to wire a meshopt decoder
before `<model-viewer>` (or a plain three.js `GLTFLoader`) will load
GLBForge's default optimized output; README.md, `packages/mcp/README.md`,
`site/llms.txt` and the `optimize_glb`/`optimize` tool descriptions never
said so, so an agent following "optimize, then embed" would ship a file that
never renders and have no lead on why. Fixed by adding an exported
`MESHOPT_DECODER_HINT` (`packages/core/src/optimize.ts`), surfaced as a
`hint` field on `optimize_glb`'s MCP reply and printed by
`glbforge optimize`'s human and `--json` output — present exactly when
`compress`/`--no-compress` leaves compression on, absent when it's off, since
then there's nothing to decode. Added the same guidance to README.md and
`site/llms.txt` (the AI-facing scope statement), matching the exact snippet
and meshoptimizer version (`0.22.0`) `site/index.html` already uses. Did not
touch `docs/error-codes.md`: the thrown string is three.js's own error, not
one of GLBForge's diagnostic codes, so it has no natural entry there.
Tests: `packages/mcp/test/server.test.ts` asserts the hint is present by
default and absent with `compress:false`; `packages/cli/test/optimize.test.ts`
(new file) asserts the same on the built CLI with `--no-compress`. Both fail
without the fix and pass with it. `pnpm docs:check` stayed green (28 MCP
tools, 21 CLI verbs, packages 0.8.0 — unchanged).

Left open: I did not check whether Blender's importer or `usdzconvert`
handle the same extension gracefully (no Blender or usdzconvert in this
sandbox to try) — a future rival or integrator pass with those tools
available could extend this to "does *every* common consumer need the same
wiring, or is model-viewer/three.js the one that's silent about it."
