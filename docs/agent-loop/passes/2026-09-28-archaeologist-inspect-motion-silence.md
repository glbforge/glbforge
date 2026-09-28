# Pass — 2026-09-28 — 289eacd
**Role:** archaeologist

## Step 0 — claim check, and why the role isn't the literal ledger printout

`gh pr list --state open --json number,title,headRefName --jq '.[] | select(.headRefName | startswith("agent-loop/"))'`
showed 25 open, unmerged `agent-loop/*` branches (plus `ci/usd-oracle` and one
older `companion` branch), none merged since `#20` on 2026-09-23. `pnpm ledger`
on `main` prints `rival` as least-recently-used, but `main`'s ledger only
counts merged passes — five prior passes (`#43`, `#55`–`#58`, `#59`, `#61`,
`#62`) already name this mechanism gap in prose without re-filing it.

In practice-order, today already has an open, unmerged pass for each of
`rival` (`#61`, then `#62` — which explicitly exhausted the reachable rival
backlog), `integrator` (`#63`), and `performance` (`#64`), each explaining in
its own Step 0 why it moved one rung down from what `pnpm ledger` literally
printed. `archaeologist`'s and `newcomer-to-new-code`'s last *unmerged*
activity is a day older (`#59`, 2026-09-27). Took `archaeologist`, one rung
further down the same reasoning `#63`/`#64` used explicitly — not a search
for an easier role: nothing about archaeology is lighter than rival, it's
just what today's rotation, read honestly, hasn't touched yet.

## Ground truth

`pnpm install && pnpm -r build`: clean, 6 packages. `pnpm -r test` before any
change: 177/180 core (3 skipped, LFS), 46/46 mcp, 5/10 cli (5 skipped, LFS),
2/2 studio — all green. `pnpm probe -- --no-live`: 28 tools, packages 0.8.0,
advice 3/3 resolved, 0 new findings, 0 dangling, 33/130 codes exercised, no
regressions vs `baseline.json`.

## What was measured

Read the closed ledger (all fourteen entries are `fixed`; none `wontfix` or
`watching`, so there was nothing to re-confirm there) and `ROADMAP.md`'s
still-unchecked line: *"From the first task walk: `inspect` should say an
asset moves (T1); USDZ node counts include material prims (T4); pinned
profiles are silent about newer versions (T5); no CLI verb reaches the
companion (T7)."* T5 was closed today-adjacent by `#59` (open, unmerged,
claimed). T7's fix already shipped in prose (`docs/agent-tasks/2026-09-22-badge-companion.md`
marks it `fixed`) but the ROADMAP checkbox fix for it is `#31` (open,
unmerged, claimed) — left alone. That leaves **T1** and **T4** genuinely
untouched by any open branch (confirmed by reading all 25 open PR titles and
bodies; none mention "asset moves", "material prims as nodes", T1, or T4).

Checked T1 against current code rather than trusting the six-day-old note.
Reproduced the walk's own steps 1–5 for real:

```
$ glbforge extrude assets/ci-badge.png -o badge.glb        # 72 tris
$ glbforge optimize badge.glb -p mobile-hero@1             # SSIM 99.3%
$ glbforge animate badge.web.glb -o badge.idle.glb         # clip "idle", 4s, 121 keys
$ glbforge inspect badge.idle.glb
  1 mesh, 72 triangles, ... 3 nodes (depth 3): 1 quantized mesh node ...
  Front: unknown (declare it with an expectation). INFO origin/not-at-base: ...
```

Confirmed the gap is exactly as T1 described: the summary lists the new
`GLBForge_Pivot` root and node count but says nothing about the two clips
the file now carries, and the CLI's `inspect` command doesn't call
`inspectAnimation` at all — only the MCP-only `inspect_animation` tool knew.
`inspectScene`/`summarize()` (`packages/core/src/inspect/report.ts`) had no
animation field or sentence; the deferral wasn't a considered "not yet" —
it's a straightforward gap the first task walk found and nobody had picked
up since (`T2`/`T3` from the same walk were fixed same-day; `T1` sat).

### L150 · `fixed` · `inspect` never said an asset moves, even right after `animate`

- `packages/core/src/inspect/report.ts`: `inspectScene` now also calls the
  existing `inspectAnimation(ir)` (already shared by the MCP's
  `inspect_animation` and `inspect_all`) and exposes a new `animation` field
  on `InspectReport` — `{ has_animation, clip_count, moving_clip_count,
  duration_seconds }` — facts only; skeletons, blend shapes, root motion and
  causes stay `inspect_animation`'s job, not duplicated here. `summarize()`
  adds one sentence when `has_animation`: `"1 clip, 4.0 s, all moving."` (or
  `"N clips, Xs, M moving"` / `"none moving"`), placed after the hierarchy
  sentence and before the Front line.
- `packages/cli/src/report.ts`: `printInspect` gains an `Animation` section
  (clip count, how many actually move, duration) when the asset has one, one
  line, pointing at `inspect_animation` for the rest — no new CLI flag; the
  fact is cheap enough (`inspectAnimation` is already O(channels)) to compute
  unconditionally rather than gate behind an opt-in section, matching how
  Topology/Hierarchy already work.
- `packages/mcp/src/schemas.ts`: `InspectDataSchema` gains the matching
  `animation` object so the MCP `inspect` tool's schema (and
  `docs/error-codes.md`/`schemas/`, regenerated) agree with what it now
  returns — no source change needed in `agent-tools.ts`'s `inspect` handler
  itself, since it already spreads `inspectScene`'s full report.
- `packages/mcp/src/agent-tools.ts`: one added clause in `inspect`'s tool
  description naming the new fact and pointing at `inspect_animation` for
  skeletons/blend shapes/causes (was already pointing there for materials
  and budgets via `inspect_all`).
- Test: `packages/core/test/report.test.ts` — bakes a real `animate()` clip
  onto a plain mesh, asserts `r.animation` is exactly zeroed before and
  `{ has_animation: true, clip_count: 1, moving_clip_count: 1,
  duration_seconds: 2 }` with the matching summary sentence after; fails
  without the fix. Confirmed no other test's exact-string summary assertions
  moved (`report.test.ts`'s five other `toBe`/`toMatch` cases are all
  non-animated fixtures, so the new sentence never fires for them).

## Verify (after)

Rebuilt end to end (`pnpm -r build && pnpm -r test`): core 178/181 (+1, 3
skipped LFS), mcp 46/46, cli 5/10 (5 skipped LFS), studio 2/2 — all green.
Re-ran the exact repro above against the rebuilt CLI:

```
$ glbforge inspect badge.idle.glb
  ... 3 nodes (depth 3): 1 quantized mesh node (node transform is the encoding).
  1 clip, 4.0 s, all moving. Front: unknown ...
  ...
  Animation
    clips          1 (1 moving)   duration 4.0 s  — see inspect_animation (MCP) for skeletons, blend shapes, causes
```

`pnpm docs:check`: in step (28 MCP tools, 21 CLI verbs, packages 0.8.0 — no
new tool/verb, so nothing else to regenerate besides the schema/error-codes
files `mcp build` already wrote). `pnpm probe -- --no-live`:

```
Surface 28 tools over stdio; packages 0.8.0, npm unknown
Advice 3/3 resolved (1); 0 new findings; 0 dangling
Vocab 33/130 codes exercised; 0 undeclared, 0 undocumented, 0 schema violations
No regressions vs baseline.
```

Vocab unchanged at 130 (no new diagnostic code — this is a data field, not a
finding) and no `baseline.json` edit needed; latency deltas (`inspect` p50/p90
11/69 vs. 10/65 before) are ordinary host noise on a low-sample run, same
order as every other pass's numbers today.

## Left open

- **T4** (USDZ `inspect` counts material/shader prims as nodes) — read but
  not fixed this pass. It's a genuine node-count semantics question (count
  only Xform/Mesh/SkelRoot as "nodes", or relabel the count as "prims" with
  a breakdown) that touches `InspectReport.hierarchy`/`.scene.nodes` for
  every USD-family caller, not a one-file addition like T1; left for a pass
  with more budget to spend on it, or the maintainer's call on which framing
  to take.
- **T5** (`#59`, open) and **T7**'s ROADMAP checkbox (`#31`, open) — both
  claimed by other unmerged branches; not duplicated here.
- The rotation-visibility gap itself (unmerged PRs stall `pnpm ledger`'s
  view of "recently used") — restated in prose only, per the standing choice
  every sibling pass this week has made; not this pass's fix.
- `L4` (`site/llms.txt` version line) — untouched, a release call.
