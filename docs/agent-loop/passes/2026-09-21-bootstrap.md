# Pass — 2026-09-21 — 5adca00
**Role:** auditor

Built the probe, recorded the baseline, fixed two of four findings.

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

## Also recorded, no action

- 33 of 128 declared codes are exercised by the fixture set. Not a defect —
  most of the remainder are USD packaging and generation codes — but coverage
  is worth watching: a documented code that nothing can produce is a row an
  agent can never act on.
- `optimize_glb` p50 is 1.5 s against `inspect`'s 6 ms. Expected (it renders
  four cameras twice to measure SSIM) and not a regression; noted so a later
  pass does not file it as one.
