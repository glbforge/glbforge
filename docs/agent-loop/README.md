# The agent loop

A scheduled pass that treats GLBForge the way an agent does — launch the MCP
over stdio, read the tool descriptions, follow the advice — and files what it
finds. It runs every four hours and opens a pull request; it never merges and
never publishes.

The loop exists because the test suite cannot ask the only question that
decides whether an agent succeeds with this product: **if it follows the
advice, does the asset get better?** Unit tests assert that `analyze_glb`
reports `perf/draw-calls`. Nothing asserted that the `optimize_glb` call it
hands back in `nextActions` actually clears it. The first pass found that it
did not, and that re-analyzing produced the identical suggestion — an agent
following the loop had no exit from it.

## Parts

| Path | What it is |
|---|---|
| `packages/mcp/scripts/agent-probe.ts` | The harness. `pnpm probe` |
| `docs/agent-loop/baseline.json` | Frozen numbers. A pass that moves them moves them on purpose |
| `docs/agent-loop/passes/` | One file per pass, append-only. The source of truth |
| `docs/agent-loop/ledger.md` | Generated index of every finding and where it stands. Read first |
| `scripts/ledger.mjs` | Folds the passes into the index. `pnpm ledger` |
| `.claude/skills/glbforge-pass/SKILL.md` | What a pass does, start to finish |
| `scripts/live-check.mjs` | glbforge.dev from outside, on a machine that can reach it |

## Running it

```bash
pnpm -r build && pnpm probe                 # human summary
pnpm probe -- --json /tmp/probe.json        # machine report
pnpm probe -- --gate --no-live              # CI: exit 1 on regression, no network
pnpm probe -- --baseline-out docs/agent-loop/baseline.json   # re-freeze
```

Flags: `--gate` (exit 1 on regression vs the baseline), `--gate-latency` (also
gate timings — only meaningful against a baseline recorded on the same `host`),
`--no-live` (skip glbforge.dev), `--baseline <path>`, `--markdown <path>`.

## What it measures

**surface** — the places an agent learns what exists, checked against each
other: the stdio server's `listTools`, `schemas/index.json`, the schema files,
`packages/mcp/README.md`, `site/llms.txt`, `server.json`, the five package
versions, and npm's `latest`. Drift here is an agent acting on a fact that is
no longer true.

**advice** — the headline. Every `nextActions` entry from every tool is
executed against the fixture that produced it, and the tool is re-asked about
the file the advice made. An action that carries `resolves` is graded against
exactly that claim; an action that claims nothing is only checked for running
cleanly and for what it broke. Grading an unclaimed action against every
finding would invent a promise the tool never made — the same certainty
invariant the rule packs hold to.

**latency** — p50/p90 per tool. The inner-loop reframe is a latency bet: an
`inspect` that creeps from 40 ms to 400 ms stops being the call you make after
every edit, and no test fails. Recorded every pass, gated only on request,
because a cloud runner is not a laptop.

**vocab** — every code observed must be in the envelope enum *and* in
`docs/error-codes.md`, and every `suggested_fix` that names a tool must name
one the server exposes. Coverage is reported too: a code no fixture can
produce is a row in a table an agent will never be able to act on.

**live** — glbforge.dev, and whether the deployed `llms.txt` is the one in
this checkout. **This section does not run on a schedule**: the cloud
sandbox's proxy allowlists npmjs.org and fails CONNECT on everything else, so
a scheduled pass would report a false outage. It runs locally instead — see
below.

## The live check runs locally, on a timer

```bash
node scripts/live-check.mjs            # check, print, append history
node scripts/live-check.mjs --notify   # + macOS notification ON CHANGE only
node scripts/live-check.mjs --json
```

Plain Node — no build, no pnpm, no workspace resolution — so it still answers
"is the site up" against a checkout that is mid-rebuild or broken. Installed
as a launchd agent (`~/Library/LaunchAgents/dev.glbforge.live-check.plist`),
hourly plus once at load, writing `.agent-loop/live-history.jsonl`.

It checks the six static routes; the two free unauthenticated Worker routes
(the same Worker serves the site, so the assets can be fine while `/api/*`
throws); **every script and style the deployed Studio page references**,
because a hashed bundle has raced the build into a deploy whose `index.html`
pointed at files that were not there — invisible to a 200 on the page itself;
deployed `llms.txt` against **`origin/main`**, not the working tree, since a
feature branch is ahead of the deploy by definition and comparing the tree
would hold it red for the life of every PR; and npm `latest` against the
packages here.

Quiet by design: it notifies only when the state *changes*. A site down for
six hours earns one notification, and so does the recovery. Nothing paid is
ever touched — `/api/gen/*` and `/api/billing/checkout` are excluded.

Manage it:

```bash
launchctl print gui/$UID/dev.glbforge.live-check | grep -E 'state|last exit'
launchctl bootout gui/$UID/dev.glbforge.live-check      # stop
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/dev.glbforge.live-check.plist
```

## Fixtures

`packages/core/test/agent-fixtures.ts` supplies the failure modes, one code
each. Every one of them passes `mobile-hero`, so none produces a `nextActions`
to grade — the probe adds three of its own, built to fail one budget class
apiece (`over-triangles`, `over-drawcalls`, `over-texture`). Advice can only
be measured on an asset that needs some.

## The baseline is a contract

`baseline.json` is the same kind of artifact as a budget profile or a rule
pack: a number in it changes only as a deliberate act, with the reason written
down in the ledger. `--gate` fails on a drop in the advice resolution rate, a
new collateral regression, dangling advice, a shrinking tool count, an
undeclared or undocumented code, or a schema violation.

`resolutionRate` is below 1.0 today. That is not noise to be tuned away: it is
ledger entry L2, and the number goes up when the entry is closed.

## The ledger is generated

It used to be one hand-edited file that every pass prepended to, which made it
the one place concurrent passes were guaranteed to collide — three open PRs,
three new sections at line 13, three conflicts. It also answered the wrong
question: a reverse-chronological log makes you reconstruct "what is open
right now" by reading the whole thing, and a finding's state changes over
time.

So `passes/` is append-only — one new file per pass, and a new file never
conflicts — and `pnpm ledger` folds them into `ledger.md`. A later pass
changes a finding's state by writing a heading for the same id in its own
file; the newest mention wins. The format is what the loop already wrote, so
there is nothing extra to remember:

```
# Pass — YYYY-MM-DD — <commit or run id>
### L<n> · `state` · <title>
```

CI runs `node scripts/ledger.mjs --check` and fails if the index is stale.
On a merge conflict in `ledger.md`, take either side and re-run `pnpm ledger`
rather than resolving it by hand.
