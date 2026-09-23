# Pass — 2026-09-22 — 56a5e59

Step 0: `gh pr list` showed four open `agent-loop/*` branches. `#11`
(`close-l2-draw-calls`) closes L2 — claimed, left alone. `#13`
(`pass3-ledger`) and `#14` (`claude-md-print-profile`) are today's two
earlier passes; `#14` closed L8 (`CLAUDE.md`'s print-profile claim) and
`#13` recorded a nothing-to-fix pass whose rotation (`error-codes.md`
thresholds, `schemas/index.json` count, README/ROADMAP sync, MCP SDK
version) is not re-walked here. `#9` is this loop's own bootstrap PR,
still unmerged — the skill and ledger infrastructure live only on that
branch, so this pass branches from it per the scheduler's fallback
instructions.

Ground truth: `pnpm install && pnpm -r build` clean. `pnpm -r test` green
(163 core + 3 skipped, 13 meshy, 44 mcp, 5 cli + 5 skipped). `pnpm probe --
--no-live` matched `docs/agent-loop/baseline.json` (27 tools, 0.667
resolution, 33/128 codes, no schema violations) and reported "No
regressions vs baseline" on its own gate; `optimize_glb` p50 read 3304 ms
against the committed 1524 ms, but that is this sandbox's host, not a code
change (rule 5's stated exception), and the probe's own comparison did not
flag it. Only L2 and L4 surfaced, both already known: L2 claimed by `#11`,
L4 a release decision left to the maintainer per the loop's hard limits.

Spent the rest of the pass on two rotations neither prior pass this cycle
had covered:

- **`site/llms.txt`'s Commands section against the CLI's actual command
  list.** `glbforge --help` lists three commands the Commands section
  omits: `watch`, `align`, `dataset`. Checked whether this is the
  "anything not listed here is not shipped" promise in the Key Facts
  preamble breaking — it is not: `README.md`'s own command reference
  omits the same three, so the omission is consistent curation (a
  research/dev-loop tool that never exits under a non-interactive agent,
  and two maintainer-facing tools: rig fidelity scoring and fine-tuning
  dataset export) rather than drift specific to llms.txt. No change.
- **Walked `glbforge init --local` and `glbforge scaffold` end to end**,
  neither exercised by prior passes' extrude→ship→usdz→diff walk. Built a
  minimal synthetic GLB (`@gltf-transform/core`, no fixtures needed) and
  ran `scaffold` on it: the emitted Vite + R3F project's `App.tsx` reads
  cleanly cold (KTX2 loader wiring, `Bounds`/`Center` auto-framing, a
  documented reason for skipping `useGLTF.preload`) and `package.json`
  pins sensible versions. No defect.

  `init --local` cost a false start worth recording so it is not repeated:
  `--local` is a boolean flag (`commander`, no value), so
  `glbforge init --local <path>` treats `<path>` as the `[dir]` positional
  — the *target* project, not "which checkout to reference". Running it
  from outside the target with the monorepo's own root as `<path>` (my
  first attempt) wrote `glbforge init`'s CLAUDE.md/package.json changes
  into this checkout itself rather than a scratch directory. Caught via
  `git status` immediately after, reverted before anything else touched
  those files, confirmed no other files changed. This is not a product
  defect — `--help` and the CLI's own `--local` description state the
  semantics correctly, and a corrected run against an actual scratch
  directory produced the documented result (`.mcp.json` pointing at this
  checkout's built server, `CLAUDE.md` section written, `package.json`
  correctly skipped where none existed). Recorded only so a future pass
  reads `[dir]` as the target before running it against a live checkout.

No new finding rose to the bar for a code or doc change this pass.
