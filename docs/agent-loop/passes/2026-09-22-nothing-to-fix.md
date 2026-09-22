# Pass — 2026-09-22 — 80da0f1

Step 0: two open PRs both cover L2 (`#11` bakes instanced draw calls when
the triangle budget allows, `#12` the budget-gated variant) — claimed,
left alone per the standing rule. `#10` (`fix/honest-measurements`) is
infra `#9` stacks on, not an agent-loop finding; not this pass's to touch.

Build clean, suite green (231 core + 44 mcp + 5 cli tests), probe matched
the committed baseline exactly (27 tools, 0.667 resolution rate, 33/128
codes exercised) with only L2 and L4 showing — no regressions.

Spent the rest of the pass on `schemas/` and `docs/error-codes.md` as an
integrator's only reference (not yet rotated to by pass 1 or 2), plus a
check of `README.md`/`ROADMAP.md` against the sync rule in `CLAUDE.md` and
of the MCP SDK version against npm:

- Traced every `error-codes.md` row that names a threshold (`SCALE_TOO_SMALL`/
  `SCALE_TOO_LARGE` at 0.01 m/20 m, `TEXTURE_OVERSIZED` at 2048px) against
  `packages/core/src/packs/core-scene.ts` and `inspect/materials.ts` — the
  doc matches the code. One near-miss: `RULE_TO_CODE['scene/scale-sanity']`
  in `diagnostics.ts` defaults that legacy rule id to `SCALE_TOO_LARGE`
  unconditionally, which would mislabel a too-small asset if that default
  were ever used — but `packages/mcp/src/findings.ts:30` overrides it with
  the measured size before the default is read, so no agent ever sees the
  wrong code. Not a defect; left alone precisely because the call site
  already guards it — noted here so a future pass does not re-trace the
  same path and file it as one.
- `schemas/index.json` reports 27 tools, matching the probe and `README.md`
  line 35 exactly.
- `README.md` and `ROADMAP.md` carry no version-line claim to check against
  packages (unlike `site/llms.txt`, which is L4, unchanged, still 0.9.0
  against 0.8.0 packages — maintainer's call).
- `@modelcontextprotocol/sdk` is pinned `^1.11.0`, resolves to `1.30.0`,
  which is also npm's current `latest` — no ecosystem drift to report.

No new finding rose to the bar for a code change. Ledger-only pass, per
the "finds nothing worth changing is a success" rule; opened as a small PR
carrying only this entry so pass 4 does not redo these checks.
