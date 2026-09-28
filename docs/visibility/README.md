# Visibility

Whether GLBForge is **found** — not whether it is described correctly.

Two different failures, two different apparatus:

- **Is the claim accurate?** `pnpm docs:check` (mechanical) plus the info pass
  (judgment) keep `llms.txt`, the READMEs and the landing page in step with the
  code. That surface is in good shape: when an AI engine is *told the name*, it
  retrieves glbforge.dev and describes the pipeline well.
- **Does anyone arrive at the name?** This directory. When an agent or a person
  asks an undirected question in the words they actually use — "what optimizes
  GLB files", "glb to usdz", "gltf linter for CI" — does GLBForge enter the
  answer at all? At the 2026-09-28 baseline: no, on every one.

## The contract

- **`queries.json` is a frozen battery**, like a probe baseline. A run asks
  every query verbatim so the numbers compare across runs and engines. Changing
  the battery changes what the trend means — do it deliberately and say why in
  the run file that first uses the new set.
- **`runs/` is append-only.** One file per run; a new file never conflicts with
  a run happening beside it. Never edit another run's file.
- **`ledger.md` is generated** by `node scripts/visibility.mjs` (`pnpm
  visibility`) from the run files, and `--check` gates it in CI. On a merge
  conflict there, take either side and regenerate.
- **A run records what was observed, not what we wish.** Paste the engine's own
  words in the results table. If an engine could not be reached (login wall,
  captcha, consent gate), that is a recorded outcome, not a skipped one.

## The metrics

A run's `## Scores` table drives the trend. Each is `k/n` — of the `n` queries
in that class the engine was asked, `k` cleared the bar:

| metric | bar |
|---|---|
| `undirected_surfaced` | GLBForge appeared in the answer *at all* |
| `undirected_recommended` | GLBForge was named among the tools the engine *recommended*, not just mentioned in passing |
| `named_correct` | for a `named` query, the feature account was substantially accurate and complete against the query's `expect` list |

`undirected_recommended` is the one that matters for adoption; `surfaced` is the
leading indicator that off-page work is landing. Keep both — a tool can get
mentioned long before it gets recommended.

## Running one

Invoke the **`glbforge-visibility`** skill (`.claude/skills/glbforge-visibility/`).
It asks the battery across the automatable engines, scores each answer, writes
one `runs/<date>-<slug>.md`, regenerates this ledger, and — because the point is
to make the number move — opens a PR only if a *fix to the product surface* fell
out of what it saw. The probe itself never merges, tags or deploys.
