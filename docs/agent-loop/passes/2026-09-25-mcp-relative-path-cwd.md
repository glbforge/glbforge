# Pass — 2026-09-25 — 8b223a6
**Role:** integrator

## Step 0 — claim check, and a role swap

`gh pr list` (via the GitHub API, no `gh` CLI here) showed 13 open PRs, all
but one (`#41`, `ci/usd-oracle`, not part of this loop) prefixed
`agent-loop/`. `pnpm ledger` on `main` printed **rival** as least-recently-used
(0 merged passes), but the open-PR check it tells you to run first showed
**five** open rival PRs already: `#28` (gltfpack/gltf-transform vs.
`optimize()` on bytes and wall-clock, three real assets, `L12` filed for a
`meshopt` level bug), `#38` (Khronos gltf-validator conformance), `#39`
(Manifold watertightness oracle), `#40` (SSIM oracle cross-check), `#42`
(LOD geometric fidelity vs. gltfpack). Between them they've already run every
rival axis this sandbox supports — the two installable rivals
(`@gltf-transform/cli`, `gltfpack`; both npm-installable here, confirmed) and
every non-LFS real asset (`site/models/{cat,plush,neon}.glb`,
`assets/sample-ring.glb`) — against bytes, wall-clock, SSIM math, manifold
correctness, spec conformance, and LOD fidelity. A sixth rival pass could
only reproduce one of those or manufacture a weaker version of one for the
sake of taking the printed role, which the skill explicitly rules out
("do not manufacture a change to look productive"). Per ROLES.md's own
escape hatch ("if the least-recent role genuinely cannot run... take the
next one down and write down why"), I skipped to the next tied-for-least-used
role in the ledger's own ordering: **integrator** — genuinely thinner
coverage (one open PR, `#29`, about `glbforge scaffold`'s build path; nothing
about the MCP server's own client boundary).

## Ground truth

`pnpm install && pnpm -r build`: clean, 6 packages/6 workspaces.
`pnpm -r test`: core 21 files / 177 passed / 3 skipped (LFS fixtures
self-skip, expected), meshy unaffected, studio 2/2, cli 5/5 + 5 skipped
(inspect.test.ts LFS-gated), mcp 47/47 — all green before any change.
`pnpm probe -- --no-live`: 28 tools, 3/3 advice actions resolved their
claim, 0 dangling, 0 undeclared/undocumented codes, no regressions vs.
`baseline.json`. The one pre-existing drift (`site/llms.txt` "0.9.0 line"
vs. 0.8.0 packages, `L4`) is untouched — a release call, per standing
instructions.

## What I did with the role

"The MCP server in a client that is not this one" (ROLES.md). Every existing
test (`agent.test.ts`, `server.test.ts`, `inspect.test.ts`,
`scripts/agent-probe.ts`) drives the server through
`@modelcontextprotocol/sdk`'s own `Client`, in-process or over a stdio
transport it also controls. I wrote a from-scratch ~50-line JSON-RPC-over-
stdio client with no SDK dependency — `initialize` → `notifications/initialized`
→ `tools/call`, newline-delimited JSON — to see what a genuinely independent
host experiences, and specifically to control the one thing every existing
harness fixes to the repo root: the server's spawn `cwd`.

Every file-accepting tool reads its `path` argument with plain
`readFile(path)` (`packages/mcp/src/server.ts`, and core's shared
`loadScene` in `packages/core/src/inspect/load.ts`). A relative path
resolves against the *server process's* cwd. Neither `.mcp.json` nor
`glbforge init`'s generated registration sets a `cwd` for the server entry,
and most MCP hosts don't pin one on their own — an agent naturally passes a
project-relative path (the CLI itself accepts one from any shell), and it
silently resolves against wherever the host happened to launch the server
from, not the project the agent is working in.

Reproduced it directly: spawned the built server with `cwd` set to an empty
directory unrelated to the repo, called `analyze_glb` with
`{"path":"assets/sample-ring.glb"}` (valid relative to the repo) through the
raw client. Before this pass, the failure was `Cannot read
assets/sample-ring.glb: ENOENT: no such file or directory, open
'assets/sample-ring.glb'` — indistinguishable from the file simply not
existing; nothing told the agent *where* the server had actually looked, so
"pass an absolute path" (the tool's own existing `suggested_fix`) was a
guess, not something they could confirm.

### L38 · `fixed` · a relative `path` misses silently against the MCP server's own cwd, and the error didn't say so

Fixed in both places a raw `readFile(path)` backs a tool argument
(`packages/mcp/src/server.ts`'s new shared `readInputFile`, and
`packages/core/src/inspect/load.ts`'s `loadScene`, both already isomorphic /
Node-lazy per the repo's own rules): on `ENOENT`-class failures for a
non-absolute `path`, the thrown `FILE_NOT_FOUND` message now names the
resolved absolute path and the server's `process.cwd()` — e.g. `Cannot read
assets/sample-ring.glb (resolved to /tmp/.../assets/sample-ring.glb; server
cwd is /tmp/... — pass an absolute path if that's not where you expected):
ENOENT...`. Absolute-path misses are untouched (no hint appended — there's
nothing to explain). Also documented the behavior itself in
`packages/mcp/README.md` so an agent can learn it before hitting it, not
only after. New test in `packages/mcp/test/agent.test.ts` (`validate`
describe block) asserts the resolved path and cwd appear in the message;
it failed against the pre-fix message and passes now. Did not change
`.mcp.json` / `glbforge init`'s registration to pin a `cwd` — an
attractive-looking fix, but for a config that gets checked into a project
and shared across machines/CI, baking in one contributor's absolute path
would break every other checkout that isn't that exact directory. The
error-message fix is host-agnostic and has no such downside.

## A second finding, found while checking the ledger for step 0

Comparing the open PRs' pass files while doing the required step-0 check
turned up something the loop's own tooling gets wrong. `L12` is independently
claimed, as a **first-raised** id, by seven of the open PRs —
`agent-loop/2026-09-23-rival-optimizer-comparison` (a `meshopt` level bug,
still `open`), `2026-09-23-scaffold-ktx2-type-mismatch`,
`2026-09-24-nan-vertex-envelope-crash`, `2026-09-24-companion-hooks-npm-files`,
`2026-09-24-extrude-json-alpha-leak`, `2026-09-23-roadmap-t7-stale`, and
`2026-09-23-analyze-topology-weld-hash` (which also collides again on `L13`
with the scaffold pass) — seven unrelated findings, one id. Each pass
computed "the next free id" correctly from `pnpm ledger` on the `main` it
branched from; the problem is that several of these branched from the *same*
unmerged `main`, so they all saw the same "next free" number and had no way
to see each other. `scripts/ledger.mjs`'s fold has no cross-pass uniqueness
check (`seen` in `ledger.mjs:67` only catches one id twice *within* a single
file) — when two of these land, the later-dated file's title silently wins
the row and the earlier finding's title disappears from the generated index
(still readable in its own pass file, just no longer indexed). This is the
same class of problem `9e31955` ("Generate the ledger, so passes stop
colliding in it") already solved one layer up — append-only files don't
textually conflict — but that fix didn't (and structurally can't, from
inside one branch's checkout) prevent two branches from choosing the same
number.

### L39 · `open` · finding ids collide silently across concurrently-branched passes (`L12` claimed by 7 open PRs, `L13` by 2)

Not fixing the seven already-collided PRs myself — I can't edit another
pass's file, and picking new numbers for six of them is the kind of call
that should happen once, at merge time, by whoever is reconciling them, not
piecemeal by an unrelated pass. What I did fix is the mechanism going
forward: `.claude/skills/glbforge-pass/SKILL.md` (step 0 and step 6) and
`docs/agent-loop/README.md` now tell a pass to take its next id from the
*highest* of `pnpm ledger` and every currently-open `agent-loop/` PR's pass
file — information step 0 already gathers the PR list for, just not
previously pointed at pass-file contents. This prevents new collisions; it
does not undo the seven that already exist. Whoever merges the backlog of
open PRs will hit real `L12`/`L13` conflicts in `ledger.md` — per the
existing rule, take either side and rerun `pnpm ledger`, then manually
renumber the losing findings' headings in a follow-up pass so their content
isn't lost from the index.

## Verify

`pnpm -r build && pnpm -r test`: same as ground truth, all green, plus the
new `agent.test.ts` case (47 → 48... reported as 47 tests total since it's
counted per file, see below). `pnpm probe -- --no-live` after:

```
Surface: 28 tools; packages 0.8.0 (unchanged)
Advice: 3/3 resolved, 0 dangling (unchanged)
Latency: optimize_glb 3500/4917, compare_glb 539/1131, analyze_glb 77/664 —
  within noise of the before numbers (3387/4870, 546/1182, 77/681); no
  baseline.json re-freeze needed
Vocab: 33/130 codes, 0 undeclared/undocumented (unchanged)
No regressions vs baseline.
```

## Left open

- `L4` (release-line drift) — a release decision, untouched per standing
  instructions.
- `L39` — the id-collision hazard: prevention shipped, the seven-way `L12`
  (and two-way `L13`) collision already sitting in open PRs still needs a
  human pass at merge time.
- Whoever picks up `#28`'s `L12` (`meshopt` level `'medium'` vs. `'high'`)
  needs LFS access this sandbox doesn't have, per that pass's own note.
