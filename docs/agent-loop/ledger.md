# Agent-loop ledger

Every finding the loop has made, and what happened to it. **A pass reads this
first.** The point of a ledger is that pass 40 does not spend its budget
rediscovering what pass 3 already wrote down, and does not re-file a finding
that was closed as "working as intended".

States: `open` · `fixed` (with the commit) · `wontfix` (with the reason) ·
`watching` (real, but waiting on something).

Newest first.

---

## Pass 2 — 2026-09-21 — scheduled run `cse_01NFyKU3`

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

### L6 · `open` · the scheduled sandbox cannot push, so a pass cannot open its PR

The pass did the work and then could not deliver it. `git push` returns 403
("Claude doesn't have GitHub access to glbforge/glbforge for your
organization"), and the GitHub MCP write tools return
`Resource not accessible by integration`. Read access works; write does not.

Until an admin grants the Claude GitHub App write access on the repo
(https://github.com/apps/claude/installations/select_target), every scheduled
pass strands its work in a sandbox that is torn down afterwards. L5 above was
recovered by hand from the run log; that does not scale, and it is the one
thing that makes the loop a treadmill rather than a ratchet.

### L7 · `watching` · the scheduled sandbox cannot reach glbforge.dev

The proxy allowlist permits npmjs.org and little else; `glbforge.dev` and even
`example.com` fail CONNECT with 403. The pass correctly ran `--no-live` rather
than reporting a false outage, which is the right call — but it means the
`live` section never runs on a schedule, and the site is one of the surfaces
this loop exists to watch. Run the live check from a machine that can reach
it, or accept that site drift is caught only by the checks that read the
committed copy.

---

## Pass 1 — 2026-09-21 — `5adca00`

First pass. Built the probe, recorded the baseline, fixed two of four findings.

### L1 · `fixed` · `nextActions.resolves` promised repairs the optimizer has no step for

`compact()` built `resolves` as `errors.map(f => f.ruleId)` — every error on
the card, regardless of whether `optimize_glb` had a step that could clear it.
`resolves` is machine-readable and agents branch on it, so the failure is not
cosmetic: on `over-drawcalls.glb` the card promised `perf/draw-calls`,
`optimize_glb` returned `ok:true` without moving the count, and re-analyzing
the output produced **the identical card with the identical promise**. An
agent following `nextActions` had no exit.

Fixed two ways, both matching what `perf/triangle-budget` already did:

- `perf/draw-calls` now distinguishes calls that come from many primitives in
  one mesh (join merges them) from calls that come from separate nodes placing
  a *shared* mesh (dedup already ran; join has nothing to merge). The
  suggestion names what would actually work — fewer copies, bake the copies
  into one mesh, or `EXT_mesh_gpu_instancing`, which draws every copy in one
  call. `instancedNodes` is carried in `data`.
- `compact()` promises only rule ids in `OPTIMIZER_RESOLVES`, minus
  `perf/draw-calls` when the calls are instanced placements. When nothing
  automated applies, `nextActions` is empty rather than false.

Verified: `analyze_glb` on the optimizer's own output returns
`nextActions: []`. Full suite green (231 tests).

### L2 · `open` · `optimize_glb` dedups identical meshes into an arrangement it then cannot join

The reason `advice.resolutionRate` is 0.667 and not 1.0, and the honest
remainder of L1. Ten identical meshes, ten materials, over `mobile-hero`'s
draw-call cap. `optimize_glb` dedups the meshes into **one** mesh placed by
ten nodes and palettes the materials to one — correct, and it cuts the file
92.6% — but the draw-call count does not move, because ten nodes drawing one
mesh is still ten draw calls. `join()` cannot merge them afterwards without
discarding the instancing that `dedup()` just created.

This is a real trade-off, not an oversight: instancing saves memory and bytes,
joining saves draw calls, and which one wins depends on the asset. What is not
defensible is that `optimize` picks the memory side silently while the profile
is failing on the draw-call side.

Options, roughly in order of preference:
1. Bake instanced placements into one mesh when the resulting triangle count
   still clears the profile — the profile says which side to take.
2. Emit `EXT_mesh_gpu_instancing`, which keeps the dedup *and* collapses the
   draw calls. Best outcome; needs loader support checked against the budget
   profiles' target class.
3. Leave the behaviour and make the trade-off explicit in the response.

Closing this raises `advice.resolutionRate` to 1.0; re-freeze the baseline in
the same commit.

### L3 · `fixed` · `site/llms.txt` advertised a profile version the server does not serve

llms.txt said "`@2` is current"; the server serves `mobile-hero@3`. An agent
that pins `@2` on that advice silently gets the caps that were wrong about
instanced assets — `@3` corrected the count, and the whole point of pinning is
that it is a contract. Corrected to `@3` with the reason from
`docs/BUDGETS.md`. The probe now reads that claim specifically rather than
scanning the file for the version string.

### L4 · `open` · `site/llms.txt` claims main is "the 0.9.0 line"; every package is 0.8.0

Line 15 tells an agent it is reading the 0.9.0 scope statement. All five
packages, and npm's `latest`, are 0.8.0. Either the version bump has not been
made or the statement is aspirational; both mislead a reader who is deciding
what to install.

Not fixed here because the resolution is a release decision, not a docs edit:
bump the five packages and tag, or walk the claim back to 0.8.0. Left for the
maintainer. The probe reports it every pass until it is resolved.

### Also recorded, no action

- 33 of 128 declared codes are exercised by the fixture set. Not a defect —
  most of the remainder are USD packaging and generation codes — but coverage
  is worth watching: a documented code that nothing can produce is a row an
  agent can never act on.
- `optimize_glb` p50 is 1.5 s against `inspect`'s 6 ms. Expected (it renders
  four cameras twice to measure SSIM) and not a regression; noted so a later
  pass does not file it as one.
