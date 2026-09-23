# Pass — 2026-09-23 — 56a5e59 (agent-loop/2026-09-21-bootstrap)
**Role:** newcomer-to-new-code

## Step 0 — claim check

`gh pr list --state open --json number,title,headRefName --jq '.[] | select(.headRefName | startswith("agent-loop/"))'`
showed eight open `agent-loop/*` branches before this one:

- `#11` closes ledger item **L2** (instanced draw calls) — claimed, left alone.
- `#13` walked `docs/error-codes.md` thresholds, `schemas/index.json`'s tool
  count, README/ROADMAP consistency, and the MCP SDK version against npm.
- `#14` closed **L8** (`CLAUDE.md` overstated the print rule profile as
  shipped).
- `#15` walked `site/llms.txt`'s Commands section against the CLI, ran
  `init --local`/`scaffold` end to end.
- `#16` reviewed MCP ecosystem conventions, traced `export_stl`'s
  watertightness claim, walked `align`/`dataset` end to end.
- `#18` ran a forge→ship→usdz→diff walkthrough and cold-read eleven MCP tool
  descriptions.
- `#19` cold-read the remaining sixteen MCP tool descriptions (closing out
  the full 27-tool rotation) and chased `optimize_glb`'s "90%+ smaller"
  claim as far as this sandbox's fixtures allow.

None of that ground is re-walked here. `#9` is this loop's own bootstrap PR,
still unmerged; this pass branches from it, same as the seven agent-loop
siblings above.

## What was measured

`pnpm install && pnpm -r build` clean. `pnpm -r test` green (163 core + 3
skipped, 44 mcp, 5 cli + 5 skipped — same counts as every prior pass today
and yesterday). `pnpm probe -- --no-live` matched
`docs/agent-loop/baseline.json` exactly (27 tools, 0.667 advice-resolution
rate, 33/128 codes, 0 schema violations, "No regressions vs baseline"). Only
L2 and L4 surfaced, both already claimed (`#11`) or watched (release
decision). Baseline left untouched.

## What was checked, and what changed

Every prior pass's rotation item — every MCP tool description, `llms.txt`
against the CLI, `init`/`scaffold`/`align`/`dataset`, `error-codes.md`
thresholds, ecosystem conventions, `export_stl`'s and `export_usdz`'s
claims — is now covered at least once (see the seven passes above). Rather
than re-walk any of that, this pass looked at ground none of the eight prior
passes could reach at all: **`@glbforge/companion`** (merged to `main` via
`feat/animate-companion`, #17), a standalone Electron desktop character with
its own lockfile, an HTTP control surface, and an MCP bridge (`companion_*`
tools). It does not exist on `agent-loop/2026-09-21-bootstrap` — bootstrap
forked before the merge — so none of `#11`/`#13`–`#16`/`#18`/`#19` could see
it from their base, and it has had zero agent-loop review.

Read `companion/README.md`, `main.mjs`, `mcp.mjs`, and `brain.mjs` end to
end, cross-checking each documented claim against the code: the six body
tools (`say`/`emote`/`play`/`look`/`status`) plus the lazily-reached
`inspect_self` match the brain's actual `allowedTools: ['mcp__body__*']`
surface; the gesture enum (`hop`/`spin`/`nod`/`shake`/`wave`) matches across
`mcp.mjs`, `brain.mjs`, and the emote handler; the envelope shape
(`{ok, summary, data, state}`) is real; `export_stl`-style KTX2-not-decoded
note matches the renderer's loader. One claim didn't hold:

**Found and fixed** (in a separate PR, see below): `POST /reply` /
`companion_reply` let an external-brain agent answer a specific queued
message by id. When that id was no longer pending — already answered and
removed from the inbox, or never existed — the handler silently substituted
the oldest unanswered item instead and reported success against the
substituted id, not the one asked for. An agent replying to a specific
question could have its answer attached to an unrelated message with no
error and no signal of the mismatch. Fixed by extracting the selection into
`companion/reply-target.mjs` (pure, no Electron import, so it's unit-testable
without a display) and returning a 404 naming the id instead of silently
swapping targets. Added `companion/test/reply-target.test.mjs` — companion's
first test — run via `node --test` (a new `test` script, no new dependency:
Electron can't be fetched in this sandbox's network allowlist, and `node
--test` needs none). Verified the test actually catches the old bug by
reproducing the old inline logic standalone and confirming it returned a
wrong, non-null item for a stale id before the fix existed.

### Why this isn't a ledger entry with a merged fix

The fix lives in **glbforge/glbforge#20**, based on `main` directly, not on
this branch. `companion/` only exists on `main`; this branch (`bootstrap`)
predates the merge and has no `companion/` directory to patch. Bringing
`companion/`'s current `main` content onto a `bootstrap`-based branch just to
apply a few-line fix would produce a PR diff that looks like "add the entire
companion package," indistinguishable from unrelated content already
reviewed and merged via `#17` — worse for a reviewer than a small, clean
diff against the base that already has it. So the fix went straight to
`main` and this pass file exists only to record that it happened and why no
ledger id covers it yet.

Once `#9` (this loop's own ledger/skill infrastructure) merges into `main`,
a future pass can retroactively log `#20`'s fix as a ledger id — at that
point `docs/agent-loop/` and `companion/` will finally coexist on the same
tree, which they don't anywhere today.

## What changed here

Nothing in this repository state — no code or ledger-tracked doc in this
tree touches `companion/` (it isn't in this tree). No new heading below,
per the "only write a heading for a finding you raise, or whose state you
are changing" rule: this isn't an `L<n>` in the existing sequence, since
logging one now — on a branch that can't see the file it's about — would
itself be an entry no future pass could verify against the code it
describes.

## Left open, and why

- **L2** (`open`, claimed) — `#11` closes it; not this pass's to resolve.
- **L4** (`open`, watching) — release decision for the maintainer.
- **glbforge/glbforge#20** — the companion `/reply` fix, open against `main`,
  outside this ledger until `#9` merges.
- **The bootstrap/main divergence itself** — every pass so far has forked
  from `agent-loop/2026-09-21-bootstrap` because that's where the ledger
  and skill files live, but `main` has moved since (companion, `animate`)
  and keeps moving. Every scheduled pass is structurally blind to whatever
  lands on `main` after that fork point until `#9` merges. Worth the
  maintainer prioritizing `#9`'s merge for this reason alone, independent of
  the ledger mechanics it introduces.
