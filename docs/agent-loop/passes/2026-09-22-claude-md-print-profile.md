# Pass — 2026-09-22 — agent-loop/2026-09-22-claude-md-print-profile
**Role:** auditor

Step 0: `gh pr list` showed four open `agent-loop/*` branches. `#11` and `#12`
both close L2 (instanced draw calls) — claimed, left alone; a review comment
was left on whichever merges second rather than opening a third. `#13` is a
docs-only "nothing to fix" pass already recording a Pass 3 ledger entry on its
own branch (not yet merged, so it doesn't appear here) — its rotation
(error-codes.md thresholds, schemas/index.json count, README/ROADMAP
consistency, MCP SDK drift) is not re-walked below.

Ground truth: `pnpm install && pnpm -r build` clean; `pnpm -r test` green (163
core + 3 skipped, 44 mcp, 5 cli + 5 skipped); `pnpm probe -- --no-live`
matched `docs/agent-loop/baseline.json` exactly (27 tools, 0.667, 33/128, no
regressions). Only L2 and L4 surfaced, both already known and both
untouchable this pass (claimed / maintainer's).

### L8 · `fixed` · `CLAUDE.md` stated a `print` rule profile as shipped; only `authoring@1` exists

`CLAUDE.md`'s rule-pack paragraph read "web profiles report topology as info,
authoring warns, print will error" — three tiers stated as current fact.
`RULE_PROFILE_VERSIONS` (`packages/core/src/packs/registry.ts`) publishes
exactly one rule profile, `authoring` (v1); there is no `print` entry, and the
CLI's `analyze --profile` only accepts budget profiles (`mobile-hero`,
`desktop-hero`, `product-configurator`) — none named `print`, and none whose
`Profile.rules.severity` turns topology into errors. `stl.ts` (the actual
print/export path) does not validate manifoldness at all: it throws only on
"no scene" or "no triangles". `docs/BUDGETS.md:180` already had this right —
"will be errors under **future** print profiles" — and the doc-comments in
`profiles.ts`/`packs/types.ts` phrase it as an illustrative example ("a print
profile"), not a claim that one ships. Only `CLAUDE.md`, the file this very
loop reads first every pass, stated it as done.

This is the project's own instructions to agents working on the repo,
so a wrong claim there is read by every future pass and every human
contributor before they touch anything else. Reworded to match
`docs/BUDGETS.md`: two tiers exist (web profiles' topology-as-info override,
`authoring@1`'s warn); print is named as planned, not shipped, with a pointer
to `RULE_PROFILE_VERSIONS` and the BUDGETS.md note. No code or test changed —
nothing in `test/packs.test.ts` asserted the false claim (its "print" case at
line 297 builds an ad hoc custom profile object rather than resolving a
published `print` name, so it was never exercising the missing profile).
