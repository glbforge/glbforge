# Pass — 2026-09-30 — 289eacd

**Role:** rival

## Step 0 — claim check

`mcp__github__list_pull_requests` (no `gh` CLI in this sandbox) lists 26
open PRs with `agent-loop/`-prefixed branches, `#42` through `#76`. None
are merged, so `main`'s ledger only knows about the 14 findings from before
2026-09-26 — everything since is invisible to it.

18 of those 26 are themselves rival passes (`#42,44,45,46,51,52,53,54,56,
57,58,61,62,69,71,72,74,75`). The closest to this pass's territory is `#52`
("`computeSmoothNormals()` vs gltf-transform's `normals()` on hard-edged
geometry") — read its PR body before starting. It measures *shape fidelity*
(flat vs. smooth shading, SSIM on a cube vs. a sphere) and leaves open
`L15`: "`computeSmoothNormals()` has no crease-angle threshold." This pass
measures something disjoint: the **byte cost** of synthesizing normals at
all, on a mesh whose source never had any — not touched by `#52` or any
other open title. No overlap; proceeding.

## Role

`pnpm ledger` on `main` prints `rival` as least-recently-used — 0 recorded
uses there, same as `#52` and every other rival PR found it, because none
of those 18 rival passes have merged. This is the same rotation-visibility
gap `#52`'s pass file already flagged (which itself cited a 2026-09-25
Draco pass flagging the same thing). Two passes have now written this down
and nothing has changed: the mechanism still can't see its own history
until the maintainer merges. I'm taking `rival` anyway — it can run in this
sandbox, "the ledger is stale" isn't the kind of "genuinely cannot run"
`ROLES.md` means, and picking something else because the printed
recommendation is probably wrong would be the same "skip toward an easier
role" the rules warn against. Flagging the backlog itself in the pass
summary instead (see bottom).

## Ground truth

`pnpm install && pnpm -r build`: clean, all 6 packages. `pnpm -r test`:
177/180 core (3 skipped, LFS pointers), 46/46 mcp, 2/2 studio, 5/10 cli (5
pre-existing self-skips) — all green before any change. `pnpm probe --
--no-live`: 28 tools, 3/3 advice actions resolved, 33/130 vocab codes
exercised, 0 undeclared/undocumented/schema violations, no regressions vs
`docs/agent-loop/baseline.json`.

## Rival work

No fixture GLBs are available (`fixtures/*.glb` are LFS pointers, not
pulled in this sandbox), so I built a small synthetic rigged asset with
`packages/core/test/fixtures.ts`'s own `makeRiggedCylinder()` — a two-joint
skinned cylinder, one morph target, one rotation clip; 1,472 triangles, 768
vertices, `POSITION`/`JOINTS_0`/`WEIGHTS_0` only, **no `NORMAL`** (the
fixture never sets one — this is the same shape GLBForge's own skinning
tests use). Rival: `@gltf-transform/cli@4.5.1`'s `optimize` command,
installed via `npx` from npmjs.org (no new dependency, matches `#52`'s
approach and this sandbox's allowlist).

**Method.** Ran GLBForge's `optimize()` (`mobile-hero` profile,
`targetTriangles: 100_000` so nothing gets simplified — this fixture is
already under any real budget, and I want a compression-only comparison,
not a "who simplifies more" one) against `gltf-transform optimize
--simplify false` (same reason: disable its default aggressive
`simplify-ratio 0`, which on its own dropped this fixture 1,472 → 226
triangles with no fidelity gate at all — not comparable, so excluded from
the headline table). Both then run `weld` + `meshopt` compression on
identical geometry.

| | GLBForge `optimize()` | `gltf-transform optimize --simplify false` |
|---|---:|---:|
| triangles | 1,472 | 1,472 (unchanged) |
| vertices | 768 | 768 (unchanged) |
| output bytes | **12,920** | **9,400** |
| `NORMAL` attribute | present (computed) | **absent** |
| skin weight sums | min 1.0, max 1.0000000298 | min 1.0, max 1.0000000298 |
| bad joint indices | 0 | 0 |
| morph targets survived | 1/1 | 1/1 |
| SSIM vs. source (GLBForge's own `perceptualDiff`, 4 views) | 0.9995–0.9997 | 0.9996–0.9998 |

**GLBForge loses by 27.2% on bytes** (12,920 vs. 9,400) for byte-identical
geometry and identical, valid skin/morph data. The entire delta is the
`NORMAL` accessor: `optimize()`'s `smooth-normals` step
(`packages/core/src/optimize.ts:336-337`) unconditionally calls
`computeSmoothNormals()` whenever a primitive arrives without `NORMAL` —
this fixture always triggers it — while `gltf-transform`'s default
pipeline has no such step and simply ships the mesh without one.

That SSIM row is *not* independent evidence the two look the same to a
real viewer — it can't be, because `harness/render.ts:187` falls back to
the *same* `computeSmoothNormals()` for whichever side is missing
`NORMAL` when it builds the render ("vertex normals as a viewer would
see them"). Both sides get smoothed by the same function before either is
rasterized, so the harness is structurally unable to see a difference
between "ships smooth normals" and "ships no normals, relies on the
client" — it isn't testing the claim in its own comment, it's assuming it.
Checking that assumption against a real renderer (three.js/model-viewer
vs. the strict glTF-spec fallback, which mandates *flat* normals when
`NORMAL` is absent) is out of scope for this pass — it would mean auditing
`verifyRig()` itself, which `CLAUDE.md` reserves for a dedicated
recalibration, not something to do speculatively from a rival comparison.
Recorded as part of the finding below rather than acted on.

**Is this actionable?** `OptimizeOptions` (`packages/core/src/optimize.ts:
34-56`) has `textures`, `compress`, `textureFormat` — no way to skip
normal synthesis, and the step log (`summary.steps`) records that
`smooth-normals` ran but never its byte cost. An agent optimizing hard for
file size on a source that never had `NORMAL` (a real, tracked case —
`analyze()` already reports `primsMissingNormals`) has no lever and no
visibility into this specific trade. Whether the right fix is an opt-out,
a reported byte delta, or leaving it as-is (baked normals may well be the
correct call precisely *because* the render-harness fallback and a
strict-spec viewer disagree, which is a stability argument for baking) is
a design call, not a bug I can safely make from here — same reasoning
`#52` gave for not touching `computeSmoothNormals()` itself.

### L15 · `open` · `optimize()` bakes `NORMAL` unconditionally when absent, at a measured byte cost, with no opt-out and no reporting of the cost

Measured on a synthetic rigged fixture (1,472 tri, 768 vert, no source
`NORMAL`): GLBForge's compressed output is 12,920 bytes vs. 9,400 bytes
for `gltf-transform optimize --simplify false` on byte-identical geometry
and valid skin/morph data — a 27.2% size difference entirely attributable
to the synthesized `NORMAL` accessor. `analyze()` already tracks
`primsMissingNormals`, so normal-less sources are a recognized, real case,
not a synthetic-only one; the relative overhead will be smaller on
texture-heavy real assets (`CLAUDE.md`: "150k triangles... leaves room for
textures"), so this percentage shouldn't be read as representative of
typical Meshy output — re-measure on a real fixture once LFS is available
before sizing a fix.

Closing this needs one of: (a) an opt-out on `OptimizeOptions` for
byte-conscious callers who accept client-computed normals, (b) reporting
the byte delta in `summary.steps` so the cost is visible even without an
opt-out, or (c) confirming the unconditional bake is correct policy by
checking `harness/render.ts:187`'s "vertex normals as a viewer would see
them" fallback against a real renderer (three.js/model-viewer) rather than
against itself — the render harness cannot currently detect a fidelity gap
between "baked smooth normals" and "no normals" because it applies its own
smoothing to both. Maintainer's call on which.

**Also not re-filed, left as-is per the hard limits:** `L4`
(`site/llms.txt` version line) — release decision, untouched.

## Probe / verification

No source changed. `pnpm -r build && pnpm -r test` after: same 177/180
core, 46/46 mcp, 2/2 studio, 5/10 cli as before. `pnpm probe -- --no-live`
after: identical to the before run — 28 tools, no regressions,
`docs/agent-loop/baseline.json` untouched (nothing moved). Scratch scripts
used to build the fixture and run both pipelines lived under
`packages/cli/scratch-rival-*.mjs` during the pass and were deleted before
committing; none are part of this diff.

## Left open

- `L15` above — a design call on whether/how to close the byte gap.
- The rotation-visibility gap (this pass's "Role" section): two prior
  passes (2026-09-25 Draco, 2026-09-26 `#52`) already flagged it and
  nothing has changed. Worth the maintainer's attention directly, since no
  pass-file heading fixes a merge backlog — only merging does.
