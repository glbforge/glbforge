# Pass — 2026-09-30 — 289eacd
**Role:** rival

Ground truth on `main` (289eacd) was clean: `pnpm install && pnpm -r build` built all
six packages with no errors, `pnpm -r test` was 177/177 (3 skipped, LFS
fixtures), and `pnpm probe -- --no-live` showed no regressions against
`docs/agent-loop/baseline.json`. `pnpm ledger` gave `rival` as the least
recently used role (0 passes, never used, despite a long backlog of open
`agent-loop/*` PRs already titled "rival pass" — those are unmerged work on
`main`'s ledger, not evidence this role has run; per the skill I took the
role the ledger printed and read every open PR's title first so as not to
re-tread the same comparisons).

Rival tool: **manifold-3d** (`npm i -D manifold-3d`, 3.5.4 — the WASM
geometry kernel behind OpenSCAD and Blender's mesh-boolean node; robust CSG
requires a genuinely manifold input, so its `Manifold` constructor is a real
independent oracle for "is this mesh watertight," not a rephrasing of
GLBForge's own check). Asset: a real two-color PNG run through
`extrude_image`, matched exactly to the parameters in the existing
`layered extrusion` test in `core/test/analyze.test.ts` and to the
`logo-keychain` MCP prompt's own recommendation (`layers`, `pillow`).

### L15 · `fixed` · `export_stl`'s watertight verdict missed non-manifold seams between a layered/pillowed forge extrusion's separate layer meshes

**Measured, isolating the trigger (glbforge's own topology vs. manifold-3d, same STL bytes):**

| layers | pillow | glbforge `analyze()` boundary/non-manifold edges | manifold-3d status |
|---|---|---|---|
| 1 | 0 | 0 / 0 | `NoError` |
| 1 | 0.03 | 0 / 0 | `NoError` |
| 2 | 0 | 0 / 0 | `NoError` |
| 2 | 0.03 | 0 / 0 | **`NotManifold`** (constructor throws) |

Only the combination of `layers >= 2` and `pillow > 0` triggers it — a
combination the MCP server's own `logo-keychain` prompt explicitly
recommends (`extrude_image with layers 4, pillow ~0.03`). GLBForge's own
`analyze()`/`export_stl` reported `watertight: true` for every row,
including the failing one.

**Why the miss:** each color layer of a layered forge extrusion is its own
glTF mesh (confirmed: two nodes `layer-0`/`layer-1`, one mesh each).
`computeTopology()` in `core/src/analyze/geometry.ts` — the function behind
`analyze()`'s `geometry.topology`, and until this pass the thing
`export_stl` and the CLI's `stl` command checked — declares its weld map
and edge-incidence counter *inside* the per-primitive loop, so it welds and
counts edges one primitive at a time and can never see an edge that's a
boundary of mesh A and a boundary of mesh B at once. Welding **all** of
`toStl()`'s actual exported triangle soup by exact position (what a slicer
does, and what I did independently to hand manifold-3d an indexed mesh)
finds 64 edges shared by 3+ triangles — real overlapping/coincident
geometry between the pillowed layers' shared boundary, invisible to a
per-mesh count.

`inspect`/`inspectGeometry` (`core/src/inspect/topology.ts`, the newer
welded-space implementation CLAUDE.md points to) has the same blind spot for
this case: it computes `meshTopology()` **per IR mesh**, so it doesn't merge
across meshes either — confirmed directly, `inspect_report` on the same
asset reports `shells: 2, watertight: true`. I did not touch that path or
the `core-geometry@1`/`core-scene@1` rule packs it feeds: fixing the general
cross-mesh topology gap for `analyze`/`inspect` is a materially bigger,
versioned-contract-adjacent change (budget rules and `test/packs.test.ts`'s
frozen finding table both read `analyze()`'s topology), and belongs to a
pass that scopes it deliberately rather than as a side effect of an STL fix.
**Left open for a future pass or the maintainer:** should `computeTopology`/
`meshTopology` weld across the whole scene rather than per mesh/primitive?

**Fix, scoped to the concrete promise this pass could verify end-to-end:**
`toStl()` (`core/src/stl.ts`) now computes topology on the *exact* merged,
world-transformed, unindexed triangle soup it writes into the STL buffer —
reusing `inspect/topology.ts`'s `meshTopology()` (no new algorithm) — and
returns it as `StlResult.topology`. The CLI's `stl` command and the MCP
`export_stl` tool both now report *that* watertight/boundary/non-manifold
triple instead of the old per-mesh `analyze()` call, which is removed from
both call sites entirely (a redundant `analyze()` pass, and the wrong one).
Also fixed two overclaiming, unconditional promises to an agent that assumed
the old (silently wrong) signal: `detectGenerator()`'s note
("watertight by construction", confidence `high`, with no case where it
wasn't) and `export_stl`'s own MCP tool description ("glbforge-extruded
assets are watertight by construction") — both now name the layered/pillowed
exception instead of asserting a universal guarantee the evidence above
disproves.

**Verification:** new test in `core/test/analyze.test.ts`
(`toStl > catches a seam between layer meshes that a per-mesh check cannot
see`) reproduces the exact failing row above, asserts the *old* per-mesh
`analyze()` check still reads 0/0 (documenting the blind spot rather than
hiding it), and asserts the new `toStl().topology` correctly reports
`nonManifoldEdges > 0` and `watertight: false`. `pnpm -r build && pnpm -r
test`: 178/178 core (was 177; +1), 46/46 mcp, 5/5 cli, all green, no other
test touched. `pnpm docs:check` passes (28 MCP tools · 21 CLI verbs ·
packages 0.8.0 — tool count and description text are schema-derived,
regenerated by the build). `pnpm probe -- --no-live`: no regressions against
`baseline.json` (before: optimize_glb p50 2283ms/p90 2973ms; after:
2122/2732 — within normal host jitter, not re-frozen).

`manifold-3d` was used only to gather the table above (`npm i -D` in the
sandbox, reverted before this pass's diff — `git status` is clean of it).
The regression test needs no external kernel: it cross-checks GLBForge's
old and new topology measurements against each other on the same bytes,
which is sufficient once the discrepancy is established against a real
independent oracle, as done here.
