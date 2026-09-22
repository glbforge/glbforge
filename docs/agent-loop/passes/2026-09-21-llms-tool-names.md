# Pass — 2026-09-21 — cse_01NFyKU3

First scheduled pass. Build clean, suite green, probe matched the committed
baseline exactly (27 tools, 0.667, 33/128) with only L2 and L4 showing. Walked
extrude → ship → usdz → diff end to end and reread every tool description
cold; both clean.

First scheduled pass. Build clean, suite green, probe matched the committed
baseline exactly (27 tools, 0.667, 33/128) with only L2 and L4 showing. Walked
extrude → ship → usdz → diff end to end and reread every tool description
cold; both clean.

### L5 · `fixed` · `site/llms.txt` listed a tool that does not exist

The tool list collapsed a shared prefix: `meshy_create_task/status/download`.
Expanded, that names `meshy_status`. There is no such tool — the real one is
`meshy_task_status` — so an agent taking the list at face value calls a name
the server will reject. `packages/mcp/README.md` had it right; only llms.txt
had drifted.

Spelled the three names out, and added `undocumentedInLlms` to the probe's
surface section: every tool the server exposes must appear *literally* in
llms.txt, the same bar the README is held to. Verified by reintroducing the
shorthand and watching the check fire.

### L6 · `fixed` · the scheduled sandbox cannot push, so a pass cannot open its PR

**Resolved 2026-09-21**: the Claude GitHub App was never installed on the
`glbforge` org — `gh api /orgs/glbforge/installations` listed only
`cloudflare-workers-and-pages`. It is now installed with `contents: write`
and `pull_requests: write`. The confusing part was that the pass's *reads*
succeeded: the repo is public, so `list_branches` works with any token or
none, and `create_branch` was the first call that actually needed an
installation. Original finding below.

**The original finding:**

The pass did the work and then could not deliver it. `git push` returns 403
("Claude doesn't have GitHub access to glbforge/glbforge for your
organization"), and the GitHub MCP write tools return
`Resource not accessible by integration`. Read access works; write does not.

Until an admin grants the Claude GitHub App write access on the repo
(https://github.com/apps/claude/installations/select_target), every scheduled
pass strands its work in a sandbox that is torn down afterwards. L5 above was
recovered by hand from the run log; that does not scale, and it is the one
thing that makes the loop a treadmill rather than a ratchet.

### L7 · `fixed` · the scheduled sandbox cannot reach glbforge.dev

**Addressed 2026-09-21** by moving the check rather than the sandbox:
`scripts/live-check.mjs` runs hourly under launchd on a machine that can
reach the site. It covers more than the probe's `live` section did — the two
free Worker routes, and every asset the deployed Studio page references,
which is the shape of a failure this project has actually shipped. Drift is
measured against `origin/main` rather than the working tree, so an open PR
does not hold it red. Original finding below.

**The original finding:**

The proxy allowlist permits npmjs.org and little else; `glbforge.dev` and even
`example.com` fail CONNECT with 403. The pass correctly ran `--no-live` rather
than reporting a false outage, which is the right call — but it means the
`live` section never runs on a schedule, and the site is one of the surfaces
this loop exists to watch. Run the live check from a machine that can reach
it, or accept that site drift is caught only by the checks that read the
committed copy.

---
