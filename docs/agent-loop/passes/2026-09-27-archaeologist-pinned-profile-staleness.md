# Pass — 2026-09-27 — bcab2a4
**Role:** archaeologist

## Step 0 — claim check, and why the role changed

`gh pr list --state open` (filtered to `agent-loop/*`, plus the three
non-`agent-loop/`-prefixed loop branches `ci/usd-oracle`, `info-pass/…`, and
one older `companion` branch): **26 open PRs**, none merged, oldest
(`#20`) from 2026-09-23T00:25Z, newest (`#58`) from 2026-09-27T16:34Z — four
days, roughly one every four hours, zero throughput. 15 of them say `rival`
in the title. `pnpm ledger` on `main` still prints `rival` as
least-recently-used, because `main`'s ledger only counts *merged* passes and
none of the 26 have merged — a mechanism problem several of those PRs already
name themselves (`#43`'s `L39`, `#55`, `#56`, `#57`, `#58` all restate it in
prose without re-filing it, per the standing instruction not to re-file
across branches).

Read all 15 `rival` PR bodies in full before deciding anything. Every one is
a distinct, real, non-overlapping finding (SSIM-gate blind spots on normal
maps / KTX2 / metallic-roughness+emissive are three separate mechanisms in
three different code paths, not the same bug found three times) — this is
not duplicate work, it's just unreviewed work. Taking `rival` again — the
literal least-recently-used role per `pnpm ledger` — would make it 16 of 27
open branches on one role, adding a finding to a pile that already has more
findings in it than the maintainer can plausibly review, while three roles
(`archaeologist`, and to a lesser extent `newcomer`/`newcomer-to-new-code`)
sit at zero or one *merged or open* passes total. `#55` made the same call
one rung down (skipped `rival` for `performance`, for the same reason,
noting `integrator` also over-subscribed at 2). Following that logic one
more rung: `archaeologist` has zero passes anywhere, merged or open, other
than `#31` (open, unmerged, itself an archaeologist pass on a different
ROADMAP line, `T7`). Genuinely the least-covered angle by any count. Took it.

This is not "skipping to get an easier role" — `archaeologist` (read every
closed finding and every unchecked ROADMAP box, judge whether the reason
still holds) is not lighter work than `rival`, it's just work the rotation
can't see it's starved of while nothing merges.

## Ground truth

`pnpm install && pnpm -r build`: clean, 6 packages. `pnpm -r test` before any
change: 177/180 core (3 skipped, LFS), 46/46 mcp, 5/10 cli (5 skipped, LFS),
2/2 studio, all green. `pnpm probe -- --no-live`: 28 tools, no regressions
vs. `baseline.json`.

## What was measured

Read `ROADMAP.md`'s "From the first task walk" bullet (2026-09-22, still
unchecked): *"pinned profiles are silent about newer versions (T5)"*. Checked
the claim against current code rather than trusting the six-day-old note:

- `getProfile('mobile-hero@1')` (`packages/core/src/profiles.ts`) resolves
  and returns the pinned `Profile` object with no signal anywhere on it, or
  in its return path, that `mobile-hero` is now on `v3`.
- Confirmed the silence is total, not just theoretical: `mobile-hero`,
  `desktop-hero`, and `product-configurator` are each three versions deep
  now (`PROFILE_VERSIONS`), up from one when T5 was written. `getProfile`,
  `profileLabel`, the CLI's `printReport`/`printDiff`, and the MCP's
  `compact()` card all print `name@version` — the version a caller *asked
  for*, never the version that exists now. An agent that pinned `@1` for CI
  stability (`CLAUDE.md`'s own recommended pattern) gets the identical
  report forever, with no path to discover that v2 corrected the SSIM
  measurement or v3 corrected triangle/draw-call counting scope (both real,
  already-shipped rationale changes — see `profiles.test.ts`'s "v2/v3
  changed only the rationale" tests) unless it separately thinks to call
  `list_profiles` and diff it by hand.
- The deferral was real when written (one version existed, there was nothing
  to be silent about) and has quietly become a live gap as the profiles
  actually versioned forward. **Reopening it, not confirming it as still
  correctly deferred.**

### L100 · `fixed` · pinned budget profiles never said a newer version existed

Picked a ledger id well clear of every id referenced in the 26 open branches
(highest seen in any PR body: `L91`) to avoid the known collision problem.

`getProfile('mobile-hero@1')` (and `@1`/`@2` pins on `desktop-hero` and
`product-configurator`) resolved and returned the pinned profile with no
signal anywhere in the return value, the CLI report, or the MCP compact card
that a newer version now exists — exactly ROADMAP's T5, confirmed still true
and now three versions deep instead of one. Fixed below.

## What changed

- `packages/core/src/profiles.ts` — new `latestProfileVersion(name): number |
  undefined`, reading the existing `PROFILE_VERSIONS` table. No published
  profile or cap touched; purely additive, read-only helper.
- `packages/core/src/index.ts` — exported it.
- `packages/mcp/src/compact.ts` — `analyze_glb`'s (and every tool that shares
  the compact card) card now includes `profileLatestVersion` when the
  resolved profile is not the newest for its name; omitted entirely when it
  already is (no field noise on the common path).
- `packages/cli/src/report.ts` — `printReport`'s `Profile mobile-hero@1` line
  now appends `(v3 available)` in the same case; unchanged otherwise.
- Tests: `packages/core/test/profiles.test.ts` (new case, fails without the
  export), `packages/mcp/test/server.test.ts` (new case: pins `@1`, asserts
  `profileLatestVersion` equals the real latest; separately asserts it's
  `undefined` when the profile requested is already latest — fails without
  the `compact()` change either direction).

Manually verified beyond the automated tests (measure-before-claim):

```
$ node packages/cli/dist/index.js analyze assets/sample-ring.glb --profile mobile-hero@1
  Score 100/100   Profile mobile-hero@1 (v3 available)   ✓ within budget

$ node packages/cli/dist/index.js analyze assets/sample-ring.glb --profile mobile-hero
  Score 100/100   Profile mobile-hero@3   ✓ within budget
```

Did not touch the CLI's `--json` output path (it already exposes
`profile.name`/`profile.version` directly from `AnalysisResult`, a different
serializer than the MCP compact card) or the `ship`/`optimize` diff verdict
line (`printDiff`'s one-line budget verdict) — both real, smaller-value
extensions of the same fix, left for whoever picks this back up rather than
widening this PR.

## Verify

`pnpm -r build && pnpm -r test`: 178/181 core (+1 test), 47/47 mcp (+1 test),
5/10 cli (unchanged), 2/2 studio — all green. `pnpm docs:check`: in step (28
MCP tools, 21 CLI verbs, packages 0.8.0 — no new tool, verb, or public claim;
`profileLatestVersion` is a card field, not a new tool surface). `pnpm probe
-- --no-live`: no regressions vs. baseline; latency (`optimize_glb` p50
2276→2212ms, p90 3231→3057ms, rest within a few ms) is normal host noise on a
low-sample run — `baseline.json` untouched, nothing moved on purpose.

## Left open

- The two smaller extensions named above (CLI `--json`, `printDiff`'s
  verdict line).
- `L4` (`site/llms.txt` version line) — untouched, a release call.
- **The 26-open-PR backlog itself.** Every `rival`/`performance` pass this
  week has flagged in prose that the rotation can't see unmerged work and
  therefore can't self-correct; none of them can fix it, because merging is
  explicitly out of scope for every scheduled pass (hard limit: never
  merge). This is now four days and 26 branches deep with zero throughput —
  worth a maintainer look at the backlog before the next scheduled pass
  adds a 27th. Flagged to the maintainer directly (out of band) rather than
  filed as a ledger entry, since it isn't a product finding an agent would
  hit — it's a fact about this loop's own operation.

`pnpm ledger` regenerated.
