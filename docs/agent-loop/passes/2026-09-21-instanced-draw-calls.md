# Pass — 2026-09-21 — 97ee78c
**Role:** auditor

Scheduled run, branched from `agent-loop/2026-09-21-bootstrap` (the skill was
not yet on `main`). Build clean, suite green, probe matched the committed
baseline before touching anything (27 tools, 0.667, 33/128, only L2 and L4
open). Sandbox has no live network beyond npmjs.org, confirmed by the known
facts in the schedule; ran with `--no-live` throughout, and did not
re-file L7 (closed, watched hourly on the maintainer's machine). Verified
`git push --dry-run` up front — write access still works, no repeat of L6.

Spent the pass closing L2, the highest-value open item.

### L2 · `fixed` · `optimize_glb` dedups instanced meshes into an arrangement it then cannot join

Root cause, found by tracing the exact `over-drawcalls.glb` shape (10
identical 128-triangle grids, 10 same-content materials) through `optimize()`:
after `dedup()+prune()` collapses them to one `Mesh` placed by 10 `Node`s, the
gate that decides whether to run `palette()+flatten()+join()` counts
primitives *in the mesh list* (`doc.getRoot().listMeshes()...length`), which
is 1 — so the join step that could fix this never even runs. It is not that
`join()` can't merge repeat placements of a shared mesh (per gltf-transform's
own docs it can, by cloning the shared mesh and transforming each copy into
the destination's local space); the pipeline just never asked it to, because
nothing here counts a node placement as a primitive.

Took approach 1 from the three the ledger listed: bake the instanced
placements into one primitive when the resulting scene still clears the
profile's triangle budget. The other two candidates were shelved on purpose —
`EXT_mesh_gpu_instancing` (approach 2) is a real "best of both worlds" fix but
needs runtime/loader-support research this pass didn't have room for; approach
3 (leave it and just be honest in the response) is what L1 already shipped and
is now the fallback for the one case baking can't help.

The key fact that makes the fix simple: baking is **triangle-count-neutral**.
The scene already draws `uniqueTriangles × placements` triangles whether they
are stored once and instanced or stored once each and baked — `perf/
triangle-budget` already counts it that way (that's the whole reason
`sceneTriangles` exists). Baking only changes vertex/index *storage*
(duplicated instead of shared), which shows up as file size, not triangle
count. So the gate for "should we bake" is just: is `scene triangles ≤
profile.maxTriangles` already true? If yes, spend the memory dedup saved to
collapse the draw calls (`flatten()+join()` now runs unconditionally on
instanced scenes that still exceed `maxDrawCalls`, right after the fidelity
back-off and normals fill, so it sees final triangle counts). If no — the
asset is over its triangle budget for reasons baking can't touch — leave it
instanced; `perf/draw-calls`' suggestion still names `EXT_mesh_gpu_instancing`
as the manual path, and now says explicitly that there is no headroom rather
than flatly claiming nothing can be done.

Also updated the finding's `data` (now carries `triangles`/`maxTriangles`
alongside `instancedNodes`) and `compact.ts`'s `optimizerResolves` so the
`nextActions.resolves` promise on `perf/draw-calls` matches reality: true
when there's headroom to bake, dropped only when there genuinely isn't.

Verified on the exact repro from L1/L2: `over-drawcalls.glb`-shaped input (10
instances, mobile-hero profile, 150k triangle cap, 1,280 triangles drawn) now
comes back from `optimize_glb` with **1 draw call**, unchanged triangle count,
SSIM 1.0 (bit-identical geometry, just baked), and `analyze_glb` on the output
reports `passed: true` — no more dead end. Added a synthetic profile with
`maxTriangles: 15` (below the ~20-triangle floor 10 simplified instances hit)
to prove the honest-limitation path still holds when there truly is no
headroom: no bake step runs, draw calls stay at 10, and the suggestion still
points at `EXT_mesh_gpu_instancing`. New tests: `packages/core/test/
analyze.test.ts` ("instanced draw calls (L2)", two cases), and rewrote the
now-obsolete "drops the draw-call promise" MCP test (`packages/mcp/test/
agent.test.ts`) into "resolves the draw-call promise by baking instanced
placements when the triangle budget allows" — its own fixture *was* L2's
counterexample, so the old expectations flipped as an intended consequence of
the fix, not a stale test.

**Baseline moved on purpose**: `advice.resolutionRate` 0.667 → **1.0**
(3/3 — the L2 fixture is now the third example of a promise that holds, not
the one that doesn't), exactly what closing L2 predicted. Re-froze with
`pnpm probe -- --baseline-out docs/agent-loop/baseline.json --no-live`.
That also rewrote `host` (`darwin-arm64-node22` → `linux-x64-node22`) and
every `latency` number, purely as a side effect of `--baseline-out` writing
the whole report — this pass ran in the scheduled cloud sandbox, not the
maintainer's laptop. Nothing here claims those latency numbers as a real
regression or improvement; `surface.tools` (27) and `vocab` (33/128)
round-tripped unchanged. If a future pass runs on the laptop again and
`--gate-latency` starts firing on host drift, that is this re-freeze, not a
new regression.

### L4 · `open`, carried forward · `site/llms.txt` claims main is "the 0.9.0 line"; every package is 0.8.0

Unchanged since Pass 1. Still a release decision (bump five packages and tag,
or walk the claim back to 0.8.0), not a docs edit a pass should make
unilaterally. Re-checked this pass: `packages/*/package.json` are still all
`0.8.0`; `site/llms.txt` line 15 is unchanged. Left for the maintainer.

### Not done this pass

The whole budget went to L2 — tracing the root cause, fixing it, and proving
both the fixed and the still-honest-limitation path with new tests. Did not
get to the probe's rotation items (rereading a tool description cold, a fresh
end-to-end task walk, an ecosystem-convention comparison, `schemas/`+
`docs/error-codes.md` as an integrator's reference) or research the
`EXT_mesh_gpu_instancing` approach L2 shelved as approach 2 — worth a future
pass now that approach 1 has closed the honest-dead-end part of the problem.
