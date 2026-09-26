---
name: glbforge-info-pass
description: Keep what GLBForge SAYS in step with what it does — the landing page, /llms.txt, the READMEs, the roadmap. Run the docs checker, judge what it cannot (is a shipped capability actually described?), fix it, open a PR. Use when asked to update the site or the docs, or when the scheduled info pass fires.
---

# One GLBForge info pass

GLBForge is read before it is run. A person reads glbforge.dev; an agent reads
`/llms.txt` and acts on it without checking. So the information surface is part
of the product, and a stale claim there is a defect with a blast radius — an
agent that believes a command exists writes a plan around it.

One pass, then stop. The question behind every decision: **would someone who
only read this end up with the right expectation?**

## Rules for the whole pass

- **Open a PR. Never merge, never deploy, never tag.** Publishing the site is
  `wrangler deploy` from the maintainer's machine; `scripts/live-check.mjs`
  already notices when the deploy is behind `origin/main`, so a merged PR
  cannot be quietly forgotten. Tagging `v*` triggers the npm release.
- **No paid path**, same as the agent loop. Read-only HTTP to glbforge.dev is
  fine.
- **Say only what you checked.** This repo's own rule is that a message states
  what was measured. A PR that claims a page is accurate because it looks
  accurate is the drift it was supposed to fix.
- **A pass that finds nothing opens no PR.** Say so and stop.

## 0. Nothing else is already on it

```bash
gh pr list --state open --json number,title,headRefName \
  --jq '.[] | select(.headRefName | startswith("info-pass/") or startswith("agent-loop/"))'
```

Anything open is claimed — including an agent-loop PR that already touches the
docs for the feature it shipped. Do not open a rival.

## 1. The mechanical floor

```bash
pnpm install && pnpm -r build     # the checker reads the registries from core's dist
pnpm docs:check
```

`pnpm docs:sync` fixes everything the checker calls mechanical: it regenerates
the profile tables in `docs/BUDGETS.md` from `PROFILE_VERSIONS` and
`site/budgets/index.html` from that Markdown, and rewrites a stale tool count.
Everything it *reports* instead — a CLI verb missing from the `## Commands`
list, a version line that does not match, a pack version that was never
published — is for you to fix by hand, because the right wording is a
judgment.

If the checker is silent, the counted facts are right. That is the floor, not
the work.

## 2. What the checker cannot see

It knows `animate` appears somewhere in `llms.txt`. It cannot know whether the
landing page still describes a product from two releases ago. Read, in this
order, and diff them against the surfaces:

- `CHANGELOG.md` — the `## Unreleased` section is the list of things that
  shipped and may never have been described anywhere a reader looks.
- `ROADMAP.md` — every `- [x]` since the last info pass. A checked box with no
  sentence on the site is a capability nobody can discover.
- `docs/agent-loop/ledger.md` — `fixed` entries often changed a promise.

Then ask, of `site/index.html` and `site/llms.txt` specifically:

- Is there a **capability card** for each thing a new visitor would care
  about, and does the "Shipping now" list name it?
- Does `llms.txt` describe it in the **key facts** prose *and* carry a line in
  `## Commands`? Those are two different readers' needs: one is deciding
  whether to use the tool, the other is about to type the command.
- Are the **known gaps** still the real gaps? A gap that was closed and left
  on the page is a worse lie than a missing feature.
- Does anything promise a flag, a tool name or a default that changed? Check
  the flag against the CLI source, not against memory.

`README.md` and `packages/mcp/README.md` get the same read. The agent probe
(`pnpm probe`) already checks the MCP README against the live tool list, so
run it if you touched anything MCP-shaped.

## 3. Change it

Match the voice of what is there: measured, concrete, no adjectives doing work
a number could do. New capability copy belongs in all of the places that
reader type looks, or it is drift again next week.

Never hand-edit a generated file — `docs/BUDGETS.md`'s
`## Profiles (current versions)` tables and all of `site/budgets/index.html`
come from `pnpm docs:sync`; the rationale text itself lives in
`packages/core/src/profiles.ts`, and changing a published one there is a
versioned-contract change, not a copy edit. `site/studio/` is built by
`pnpm build:site` and is not this pass's business.

Then prove the page still works. It is static HTML with no build step, so
open it and look:

```bash
node scripts/docs-sync.mjs --check
```

and open `site/index.html` and `site/budgets/index.html` in the browser pane —
count the cards, read the changed section, confirm no raw Markdown leaked
through the renderer.

**Do not run `scripts/live-check.mjs` from the scheduled cloud run.** That
sandbox allowlists npmjs.org and fails CONNECT on everything else, so it
reports a confident outage of a site that is up (ledger L7). It belongs on a
machine that can reach glbforge.dev — it runs hourly under launchd, and it is
what tells the maintainer the deploy is behind a merge.

## 4. Write it down, then open the PR

This pass shares the agent loop's ledger. Add one new file,
`docs/agent-loop/passes/<YYYY-MM-DD>-info.md`, and follow the heading rules in
[`.claude/skills/glbforge-pass/SKILL.md`](../glbforge-pass/SKILL.md) — a
finding id is global and permanent, only write a heading for a finding you
raise or whose state you change, then `pnpm ledger` to regenerate the index.

**Write no `**Role:**` line.** The roster in `ROLES.md` rotates ways of
looking at the *product*, and `pnpm ledger` picks the least recently used one
for the next agent pass. An info pass that claimed a role would consume a
turn of that rotation without ever having looked where the role looks. The
ledger allows a pass with no role for exactly this case.

Branch `info-pass/<yyyy-mm-dd>-<slug>`. The description carries what was
stale, what it now says, and how you checked — including the `pnpm docs:check`
output before and after. Then stop.
