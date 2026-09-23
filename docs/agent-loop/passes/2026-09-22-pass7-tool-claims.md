# Pass — 2026-09-22 — 56a5e59 (agent-loop/2026-09-21-bootstrap)
**Role:** auditor

## Step 0 — claim check

Seven open `agent-loop/*` branches existed before this one, plus one
unrelated feature PR:

- `#11` closes ledger item **L2** (instanced draw calls) — claimed, left
  alone.
- `#13` walked `docs/error-codes.md` thresholds, `schemas/index.json`'s tool
  count, README/ROADMAP consistency, and the MCP SDK version against npm.
- `#14` closed **L8** (`CLAUDE.md` overstated the print rule profile as
  shipped).
- `#15` walked `site/llms.txt`'s Commands section against the CLI, and ran
  `init --local`/`scaffold` end to end.
- `#16` reviewed MCP ecosystem conventions (tool annotations,
  `outputSchema`/`structuredContent`, prompts), traced `export_stl`'s
  watertightness claim to the code that backs it, and walked `align`/
  `dataset` end to end.
- `#18` ran a synthetic forge → ship → usdz → diff walkthrough and cold-read
  eleven MCP tool descriptions (`validate`, `inspect_geometry`,
  `inspect_animation`, `inspect_materials`, `analyze_performance`, `render`,
  `render_animation_strip`, `inspect_all`, `capabilities`, `list_profiles`,
  `ship_asset`).
- `#17` (`feat/animate-companion`) is a maintainer feature branch, not part
  of this ledger — not walked or touched.

`#9` is this loop's own bootstrap PR, still unmerged; this pass branches
from it, same as the six agent-loop siblings above.

## What was measured

Before touching anything: `pnpm install && pnpm -r build` clean; `pnpm -r
test` green (163 core + 3 skipped, 44 mcp, 5 cli + 5 skipped — same counts as
every other pass today); `pnpm probe -- --no-live` matched
`docs/agent-loop/baseline.json` exactly (27 tools, 0.667 advice-resolution
rate, 33/128 codes, 0 schema violations, "No regressions vs baseline"). Only
L2 and L4 surfaced, both already claimed/watched. `optimize_glb` p50 read
2395ms against the committed 1524ms — this sandbox's host, the documented
exception in rule 5. Baseline left untouched.

## What was checked

**Read every MCP tool description `#18` had not read fresh**, closing out
the rotation item for the full 27-tool surface: `inspect`, `diff`,
`validate`, `compare_glb`, `analyze_glb`, `inspect_report`, `render_preview`,
`audit_directory`, `optimize_glb`, `extrude_image`, `export_stl`,
`export_usdz`, `generate_image_to_3d`, `generation_status`,
`meshy_create_task`, `meshy_task_status`, `meshy_download`. Every one says
when to call it, what it returns, and what to call next. Cross-checked two
concrete claims against the code that backs them:

- `inspect_report`'s six named sections (`findings`, `textures`,
  `materials`, `topology`, `geometry`, `scene`, plus `all`) match the actual
  `z.enum` in `packages/mcp/src/server.ts:473` exactly.
- `export_usdz`'s "WebP is transcoded; KTX2 is rejected" is backed by
  `packages/core/src/usdz.ts:56`'s explicit `throw` with actionable
  guidance ("export from the WebP/PNG variant"), and
  `packages/core/test/usdz.test.ts:103` exercises exactly that rejection
  path. Not filed — already correct and tested.

**Chased `optimize_glb`'s "Typically 90%+ smaller" claim** (unchanged since
the tool's original description, predating the honest-measurements fixes in
`#10`) against real, non-LFS `.glb` files already in the repo — the LFS
fixtures aren't pulled here, and generation is off-limits, so these were the
only non-synthetic assets available:

| asset | before | after (`--profile mobile-hero`) | change |
|---|---|---|---|
| `site/models/cat.glb` | 3,316,860 B | 2,160,136 B | −34.9% |
| `site/models/plush.glb` | 1,134,956 B | 1,134,348 B | −0.1% |
| `site/models/neon.glb` | 174,668 B | 174,776 B | +0.1% |
| `assets/sample-ring.glb` | 75,524 B | 16,620 B | −78.0% |

None reached 90%. **Not filed as a finding.** Each `optimize_glb` JSON
response showed why: `before.score` was 95 or 100 for three of the four —
these are the landing site's own already-optimized display assets (shipped
`.web.glb`-equivalent files, already welded/meshopt-compressed with small
textures), not the raw, unoptimized AI-generation output the claim is
actually about. Running an already-optimized asset back through the
optimizer and finding little left to squeeze is the pipeline working
correctly, not evidence the claim is wrong. `#10`'s own Khronos chess-set
measurement (41.0MB → 10.8MB, 73.6%) is closer to a real test case but is a
CAD showcase model, not representative AI output either, and still doesn't
settle it either way. Filing "the 90%+ claim is false" on four
non-representative samples would be exactly the kind of unmeasured claim
this loop's own rules forbid making — no live network, no LFS fixtures, and
no generation credits in this sandbox to produce a genuinely representative
before/after pair. Left as an open question for a pass (or the maintainer)
that has one of those.

## What changed

Nothing in code or docs. All ground walked came back either correct and
tested, or too weakly evidenced to file responsibly. Per the loop's own
rule, a pass that finds nothing worth changing is a success.

## Probe numbers

Unchanged — no code touched: 27 tools, 0.667 resolution rate, 33/128 codes,
0 schema violations, no regressions vs baseline.

## Left open

- **L2** (`open`, claimed) — `#11` closes it; not this pass's to resolve.
- **L4** (`open`, watching) — `site/llms.txt` still claims the 0.9.0 line
  against five 0.8.0 packages; release decision for the maintainer.
- The `optimize_glb` "Typically 90%+ smaller" claim — plausible for its
  actual target (raw AI-generation output) but unverified in this sandbox.
  A pass with LFS fixtures or a real Meshy/fal generation could settle it
  with one representative before/after pair.
