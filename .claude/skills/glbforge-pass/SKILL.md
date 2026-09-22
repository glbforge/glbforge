---
name: glbforge-pass
description: Run one improvement pass over GLBForge as an agent experiences it — probe the MCP over stdio, the CLI, and glbforge.dev; fix what the evidence supports; open a PR. Use when asked to run an agent pass, dogfood GLBForge, or when the scheduled agent loop fires.
---

# One GLBForge agent pass

You are the loop described in `docs/agent-loop/README.md`. One pass, then
stop. The product you are improving is used by agents, so the question behind
every decision is: **would an agent following this advice get a better asset?**

## Rules for the whole pass

- **Open a PR. Never merge, never tag, never publish.** Tagging `v*` triggers
  the npm release; that call is the maintainer's.
- **No paid path.** No Meshy, no fal, no Stripe, no `generate_image_to_3d`.
  Read-only HTTP to glbforge.dev is fine.
- **Measure before you claim.** This repo's rules say a message states only
  what was measured and an inference carries its confidence. Your PR
  description is held to the same standard: if you did not run it, do not say
  it works.
- **A pass that finds nothing worth changing closes with no PR** and a ledger
  line saying so. That is a success. Do not manufacture a change.

## 0. Check nothing else is already on it

Two passes once picked the same ledger entry and wrote the same fix twice —
one triggered manually, one scheduled 25 minutes later. Both were good; one
was waste. Nothing about the ledger prevents it, because an `open` entry
looks identical whether or not somebody is mid-way through closing it.

```bash
gh pr list --state open --json number,title,headRefName \
  --jq '.[] | select(.headRefName | startswith("agent-loop/"))'
```

Anything already open is **claimed**. Do not work on what it covers, even if
you would do it differently — if you think it is wrong, say so in a review
comment on that PR rather than opening a rival. Pick the next thing, or, if
everything open is already claimed and nothing else rises to the bar, close
the pass with a ledger line saying exactly that.

## 1. Read what is already known

Read `docs/agent-loop/ledger.md` first — it is the current state of every
finding. Open the pass files it links for anything you might touch. Then `ROADMAP.md`, and
`CLAUDE.md` for the invariants you must not break (deterministic core, frozen
`verifyRig`, versioned profiles and packs, no `normals()`, `readFloat()`, the
opaque forge plate, the local-only usage counter).

Do not re-file an `open` entry as if it were new. Do not reopen a `wontfix`
without new evidence, and say what the new evidence is.

## 2. Establish the ground truth

```bash
pnpm install && pnpm -r build
pnpm -r test
pnpm probe -- --json /tmp/probe.json --markdown /tmp/probe.md
```

A red suite before you have changed anything is itself the finding: stop,
record it, and open a PR that fixes it or an issue that reports it.

## 3. Look where the probe cannot

The probe covers contract drift, advice that does not work, latency, code
vocabulary and site reachability. It does not have judgement. Spend the rest
of the pass on one or two of these, rotating between passes so the same ground
is not re-walked:

- **Read a tool description as an agent with no other context.** Does it say
  when to call it, what it returns, and what to do next? `inspect` does.
  Check one that has not been reviewed recently.
- **Walk a real task end to end** — forge an image, ship it, export USDZ,
  diff two versions — using only what the tools return. Every place you had
  to guess, open a file, or already know something is a defect for an agent.
- **glbforge.dev as an agent arrives at it**: fetch `/llms.txt` and the docs
  pages and check each concrete claim against the code. Claims about versions,
  tool counts, caps and latencies rot silently.
- **Compare against how the MCP ecosystem has moved** since the last pass —
  new spec capabilities, conventions in well-regarded servers, client
  behaviour. Note the date of anything you learn; do not assume your training
  data is current.
- **`schemas/` and `docs/error-codes.md` as an integrator's only reference.**

## 4. Change only what the evidence supports

Prefer, in this order: a wrong or missing *promise* to an agent; advice that
does not resolve what it claims; a contract drift; a latency regression; a
description that leaves an agent guessing. Cosmetic refactors are not the
job.

Respect the versioned contracts absolutely. Never edit a published budget
profile or rule pack in place — append a version and a changelog entry. If the
right fix requires breaking one, do not do it: write the case in the ledger
and leave it to the maintainer.

Every behaviour change needs a test that fails without it.

## 5. Verify, then re-freeze

```bash
pnpm -r build && pnpm -r test
pnpm probe -- --json /tmp/probe-after.json
```

Compare against `/tmp/probe.json`. If a baseline number moved, move it on
purpose:

```bash
pnpm probe -- --baseline-out docs/agent-loop/baseline.json
```

and say in the ledger why it moved. A baseline edited without a reason in the
ledger is the one thing that makes this whole apparatus worthless.

## 6. Write your pass file

Create **one new file**, `docs/agent-loop/passes/<YYYY-MM-DD>-<slug>.md`.
Never edit another pass's file and never edit `ledger.md` by hand — a new file
cannot conflict with a pass running beside you, which is the whole reason the
layout is this way.

```markdown
# Pass — 2026-09-22 — <commit or run id>

One paragraph: what you measured and what the ground looked like.

### L8 · `open` · one-line statement of the finding

What was measured, and for anything left open, what closing it would take.
```

Rules the generator enforces:

- Heading form is exact: `### L<n> · \`state\` · title`. States are `open`,
  `fixed`, `wontfix`, `watching`.
- **A finding id is global and permanent.** To change something's state, write
  a heading for that same id in *your* file — the newest pass wins. Do not
  edit the file that first raised it.
- New findings take the next free id. `pnpm ledger` prints what exists.
- **Only write a heading for a finding you raise, or whose state you are
  changing.** Do not restate one you merely looked at and left alone: yours
  would be the newest mention, so a carried-forward `open` dated after
  another pass's `fixed` silently reopens it. Carrying findings forward is
  the index's job — that is why it is generated. Mention them in prose if
  they shaped your decisions.
- A pass that changed nothing writes no headings at all. That is a valid
  outcome and the file itself records that the ground was walked, and when.

Then regenerate the index and commit it with your file:

```bash
pnpm ledger
```

If `ledger.md` ever conflicts on a merge, do not resolve it by hand: take
either side and re-run `pnpm ledger`.

Keep `ROADMAP.md`, `README.md`, `site/llms.txt`, `packages/mcp/README.md` in
sync when scope changed; `CLAUDE.md` lists these as the docs that must move
together.

## 7. Open the PR

Branch `agent-loop/<yyyy-mm-dd>-<slug>`. The description carries, in this
order: what was measured, what changed, the probe numbers before and after,
and what was left open and why. Attach the probe markdown.

Then stop. Do not merge it, do not enable auto-merge, do not tag.
