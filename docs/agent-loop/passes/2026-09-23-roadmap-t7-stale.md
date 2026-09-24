# Pass — 2026-09-23 — b59f0d2
**Role:** archaeologist

`pnpm ledger` named `rival` as least-recently-used, but PRs #28 (rival), #29
(integrator) and #30 (performance) are already open against the same three
top-of-rotation roles — their pass files just haven't merged yet, so the
generated ledger doesn't count them. Taking any of those would risk
re-running a comparison someone is already mid-way through. Skipped down to
`archaeologist`, the next role the open PRs don't cover, and left this note
so the next pass doesn't read "rival: never" as license to start a second
rival table.

Ground truth: `pnpm install && pnpm -r build` clean, `pnpm -r test` 174 core
+ 44 mcp + 5 cli + 2 studio passed (3 core / 5 cli skipped — no LFS
fixtures, expected), `pnpm probe -- --no-live` shows 28 tools, 3/3
`nextActions` resolved, 33/130 codes exercised, 0 schema violations, no
regressions vs `baseline.json`. Only surfaced item is the known L4
(`site/llms.txt`'s 0.9.0 line) — left alone per the standing ledger note.

Read every closed ledger entry (all `fixed`, none `wontfix`/`watching` yet —
nothing to reopen there) and every unchecked `ROADMAP.md` box, then checked
each "Deferred: …" reason against what's actually in the tree today:
normal-map Y-convention heuristic, Meshy auto-rigging passthrough, scaffold
env presets, and USD composition arcs are all still genuinely undone — no
new evidence, deferrals confirmed as still right. One item had gone stale:

### L12 · `fixed` · `ROADMAP.md` still listed T7 (companion CLI verb) as open after it was fixed the same day

`ROADMAP.md`'s "From the first task walk" line bundled four items — T1, T4,
T5, T7 — as one unchecked box. `docs/agent-tasks/2026-09-22-badge-companion.md`
itself already marks T7 `fixed`: `glbforge companion` shipped and was
verified same-day (packed tarball, installed fresh, launched, rendered on
port 4949). Confirmed T1/T4/T5 are still genuinely open — no inspect
animation summary, no USDZ node-count fix, no profile-staleness warning have
landed since (`git log --since` on `packages/core/src` and
`packages/cli/src` shows nothing touching those paths after the walk).
Confirmed T7 is genuinely done: `packages/cli/src/companion-cmd.ts` exists,
registers `glbforge companion`, and the walk file's own verification stands.
An agent reading `ROADMAP.md` for what's left (as `CLAUDE.md` directs it to)
would still see "no CLI verb reaches the companion" as outstanding work —
wrong, and it's an easy trap for a later pass to "fix" something already
fixed. Split the bundled line: T1/T4/T5 stay as the open box, T7 moved out
with a pointer to the walk file recording its fix.
