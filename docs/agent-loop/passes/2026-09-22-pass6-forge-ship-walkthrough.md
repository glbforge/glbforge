# Pass — 2026-09-22 — 56a5e59

Sixth scheduled pass today. `.claude/skills/glbforge-pass/SKILL.md` is still not
on `main` — the ledger infrastructure lives only on the unmerged
`agent-loop/2026-09-21-bootstrap` (#9) — so this branches from there, same as
`#11`/`#13`/`#14`/`#15`/`#16`.

**Step 0 (claim check):** five open `agent-loop/*` branches existed before
this one. `#11` closes L2 (instanced draw calls) — claimed, left alone. `#13`
walked `error-codes.md` thresholds, `schemas/index.json`'s tool count,
README/ROADMAP consistency and the MCP SDK version against npm. `#14` closed
L8 (`CLAUDE.md`'s print-profile overstatement). `#15` walked `llms.txt`'s
Commands section against the CLI and ran `init --local`/`scaffold` end to
end. `#16` reviewed MCP ecosystem conventions (tool annotations,
`outputSchema`/`structuredContent`, prompts), traced `export_stl`'s
watertightness claim to the code that backs it, and walked `align`/`dataset`
end to end. None of that ground is re-walked here. `#9` is this loop's own
bootstrap PR, still unmerged.

**Ground truth:** `pnpm install && pnpm -r build` clean. `pnpm -r test` green
(163 core + 3 skipped, 44 mcp, 5 cli + 5 skipped — same counts as today's
other passes). `pnpm probe -- --no-live` matched `docs/agent-loop/baseline.json`
exactly (27 tools, 0.667 advice-resolution rate, 33/128 codes, no schema
violations, "No regressions vs baseline"); only L2 and L4 surfaced, both
already claimed/watched. `optimize_glb` p50 read 2405ms against the committed
1524ms — this sandbox's host, the documented exception in rule 5, and the
probe's own gate agreed there was no regression. Baseline left untouched.

## What was checked

Two areas neither of today's four earlier passes walked:

**A synthetic forge → ship → usdz → diff walkthrough**, using only what the
tools return, no source reading unless something didn't make sense. Built a
two-colour SVG logo (opaque rounded square + circle, transparent background —
no AI, no fixture needed) and ran it through the CLI a naive agent would use:

- `ship logo.svg --json` auto-routed to `forge` (no photographic heuristic
  false-positive on flat vector art), auto-layered into 2 colour layers,
  optimized to `mobile-hero`, and self-verified with SSIM (0.9964 worst view,
  passed) — all in one call, with every number an agent needs to decide
  whether to trust the output.
- `usdz logo.web.glb --json` produced a valid store-only zip with the
  expected `model.usdc` + PNG texture, no warnings.
- Ran `extrude` directly (not through `ship`) on the same SVG with `--bevel`
  to get a second version, then `diff`'d the two forge outputs. The report's
  `summary` correctly explained a shell-count change, an origin-landmark
  change (centroid → bounding-box centre) with "the geometry did not move",
  and named the meshes added/removed — nothing needed cross-referencing
  against source to understand. One discrepancy traced and dismissed: the
  diff showed layers appearing/disappearing between the two files, which
  turned out to be because raw `extrude`'s `--layers` defaults to off while
  `ship`'s forge step hardcodes `layers: 'auto'`
  (`packages/cli/src/index.ts:437`) — a deliberate difference between the
  "smart one-command" path and the "you control every knob" path, not a bug;
  `extrude --help` documents `--layers` and `ship`'s JSON output reports the
  layer count it chose, so nothing is hidden from an agent choosing either
  path. Not filed.

**Read every MCP tool description this pass had not yet looked at with fresh
eyes**: `validate`, `inspect_geometry`, `inspect_animation`,
`inspect_materials`, `analyze_performance`, `render`,
`render_animation_strip`, `inspect_all`, `capabilities`, `list_profiles`,
`ship_asset` (`packages/mcp/src/agent-tools.ts`, `packages/mcp/src/server.ts`).
Checked each against the same bar `inspect`'s description already clears: does
it say when to call it, what it returns, and what to call next. All eleven
do — `inspect_animation` names `render_animation_strip` and `export_usdz` as
its next calls, `analyze_performance` names `optimize_glb`'s `targetTriangles`,
`capabilities` tells you to call it before planning a generation or KTX2 route
so you don't hit a missing-key error mid-plan, `inspect_all` explains when to
prefer it over `inspect`. One thing chased and confirmed as intentional
rather than a bug: `render_animation_strip` with `include_clip: true` always
attaches a `CLIP_FORMAT_UNSUPPORTED` info-level note, even when the GIF
writes successfully (`packages/mcp/src/agent-tools.ts:341`, outside the
try/catch that handles the actual failure case). Looked like a copy-paste
bug on first read — a "we failed" code firing on success. It is not: the
test at `packages/mcp/test/agent.test.ts:254` asserts exactly this
("no mp4 with this stack, GIF written"), `docs/error-codes.md:134` documents
it at `info` severity with the same wording, and the note's job is to tell
every caller of `include_clip` that GIF is the only format this stack can
produce, not to report an error. Severity is `info`, not one `severityTail`
would report as a failure. Not filed.

## What changed

Nothing in code or docs. No finding rose to the bar this pass — both areas
walked cleanly, and the one discrepancy each turned up traced to intentional,
documented, tested behaviour rather than a defect. Per the loop's own rule, a
pass that finds nothing worth changing is a success.

## Left open, and why

- **L2** (`optimize_glb` can't join instanced draw calls after dedup) —
  claimed by `#11`, not touched.
- **L4** (`site/llms.txt` claims the 0.9.0 line; packages are 0.8.0) — a
  release decision for the maintainer, per the loop's hard limits.
