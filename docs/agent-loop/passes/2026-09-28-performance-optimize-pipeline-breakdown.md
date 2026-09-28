# Pass — 2026-09-28 — 289eacd
**Role:** performance

## Step 0 — claim check

`mcp__github__list_pull_requests` (no `gh` CLI in this sandbox), open PRs
whose head starts with `agent-loop/`: **26 open**, none merged since `#20`.
Read every one's pass file before picking ground, specifically the two that
already ran *today* on the top of the rotation: `#62`
(`agent-loop/2026-09-28-rival-backlog-saturated`) read all 16 open `rival`
PRs and closed off three more angles without finding a 17th worth publishing
— rival's reachable territory in this sandbox is exhausted. `#63`
(`agent-loop/2026-09-28-integrator-model-viewer-meshopt`) took `integrator`
next for exactly that reason and shipped a real fix (`optimize()`'s meshopt
output silently failing to load in `<model-viewer>`/three.js). `pnpm ledger`
on `main` still prints `rival` as least-recently-used because none of this
has merged — the same rotation blind spot six-plus prior passes already
documented in prose rather than re-filing as its own ledger entry; not
adding a seventh restatement here either.

Following the same "already claimed today, take the next rung" logic `#63`
used explicitly: `rival` claimed twice today (`#61` a real fix, `#62` a
confirmed dead end), `integrator` claimed once today (`#63`, a real fix). Both
are more recently attended-to *in practice* than `performance` or
`archaeologist`, whose most recent unmerged activity is `#55`/`#59`
(2026-09-27) — a day older. Took **performance**.

Read `performance`'s two open PRs before starting, to avoid re-deriving what
they already found: `#30` (`2026-09-23-analyze-topology-weld-hash`) replaced
`analyze/geometry.ts`'s string-keyed weld and `Map`-keyed edge count with
`inspect/topology.ts`'s radix sort and a generalized open-addressing hash
(`canonicalByAttributes`), 2.5–3.9x faster on real 150k-triangle assets —
and, diagnosing that fix, found the *same* low-bit-masking hash weakness
already shipped in `normals.ts`'s `canonicalByPosition`, left open as its own
finding rather than fixed in the same pass. `#55`
(`2026-09-27-canonical-position-hash-collision`) picked that exact thread up
and fixed it: a MurmurHash3 (fmix32) finalizer before the bucket mask,
5.96–11.3x faster on real assets, correctness preserved. Between them these
two PRs cover every spatial-hash-table implementation in `packages/core/src`
— confirmed by grepping for `Math.imul` across the package: only two hits,
`normals.ts` (claimed by `#55`) and `harness/align.ts` (a seeded seeded PRNG
for the perceptual harness's supersampling jitter, not a hash table bucket
index — a different failure mode, not exposed to low-bit clustering).
`#55`'s own "left open" note suggested exactly this audit ("didn't audit
every other `Math.imul`-based hash… a reasonable next performance… pass") —
it comes back empty: there is no third hash function to fix.

## Ground truth

```
pnpm install && pnpm -r build   # clean, 6 packages
pnpm -r test                    # 177/180 core (3 skipped, LFS), 46/46 mcp,
                                 # 5/10 cli (5 skipped, LFS), 2/2 studio — all green
pnpm probe -- --no-live --json /tmp/probe.json --markdown /tmp/probe.md
```

Probe before: 28 tools, 3/3 advice actions resolved, 33/130 vocab codes, 0
undeclared/undocumented/schema-violating, no regressions vs
`docs/agent-loop/baseline.json`.

## What was measured

With the two known hash functions already claimed, looked at the rest of
`optimize()` — the function every profile-bound tool call spends most of its
time in — for a stage the existing passes hadn't broken down. `CLAUDE.md`
freezes `verifyRig()` (the perceptual SSIM render) as a deliberate, versioned
calibration; `#30`'s pass file estimated it at "~55–70% of total, per a
rough breakdown during profiling" but never published the actual per-stage
numbers. Reproduced that breakdown precisely: temporarily added
`log('__mark:<stage>')` calls after every `await doc.transform(...)` /
await-boundary in `packages/core/src/optimize.ts` (12 marks: snapshot,
meshopt-ready, dedup+prune, weld, simplify-ladder, smooth-normals+geometry-
ssim-check, bake-instances, drop-degenerate+re-weld, textures, prune-2,
meshopt-encode, post-quantize-weld), rebuilt, ran `optimize()` directly
(via `createNodeIO()` + the built `optimize()`, not through the CLI/MCP) on
two real, non-LFS, forge-produced assets under the `mobile-hero` profile,
then reverted the instrumentation (`git checkout -- packages/core/src/optimize.ts`,
confirmed clean, rebuilt again) — nothing in this diff ships.

**`site/models/cat.glb`** (94,539 verts, 150k tri, 3 textures — already at
budget, so the simplify ladder does no work) — 3622ms total:

| stage | ms | share |
|---|---:|---:|
| snapshot (frozen `verifyRig`, before) | 760 | 21% |
| dedup+prune | 245 | 7% |
| weld | 186 | 5% |
| simplify-ladder (no-op, already ≤ target) | 86 | 2% |
| smooth-normals + geometry-SSIM check | 89 | 2% |
| bake-instances check | 82 | 2% |
| drop-degenerate + re-weld | 63 | 2% |
| **texture re-encode (sharp/libwebp)** | **875** | **24%** |
| prune (post-texture) | 118 | 3% |
| meshopt encode | 267 | 7% |
| post-quantize weld/degenerate | 84 | 2% |
| final compare (frozen `verifyRig`, after) | 679 | 19% |

Frozen `verifyRig` renders: 760 + 679 = **1439ms, 40%** — lower than `#30`'s
rough estimate, measured exactly rather than guessed, and explicitly not
touched (`CLAUDE.md`: changing the rig is "a deliberate pass of its own").
Every non-render, non-texture stage is 2–7% each and none show the
hash-table clustering signature `#30`/`#55` already fixed (confirmed: these
stages don't allocate a spatial hash at all — they're weld/simplify/prune
calls into gltf-transform and meshoptimizer, both native or already-profiled
paths). The one real outlier is **texture re-encode: 24%, the single
largest non-frozen cost** in this run.

**`site/models/plush.glb`** (no textures) confirms the shape: 2966ms total,
same per-stage costs for everything except the (near-zero, no textures to
touch) texture stage, and a larger final-verify cost (823ms — a different
mesh/camera combination, not a regression signal).

## The one real lever, measured and left open

Benchmarked `sharp(...).webp({quality, effort})` directly against `cat.glb`'s
three real embedded textures (2048px, the ones `optimize()` actually
re-encodes), 3 warm runs each, median:

| texture | effort=0 | effort=2 | effort=4 (current default) | effort=6 |
|---|---:|---:|---:|---:|
| base_color (135KB src) | 169ms → 162.5KB | 217ms → 134.2KB | 430ms → 128.0KB | 641ms → 123.5KB |
| metallic_roughness (59KB src) | 123ms → 65.4KB | 165ms → 58.5KB | 325ms → 53.3KB | 400ms → 53.0KB |
| normal (1281KB src, quality 95 in the real pipeline — bench used 82 for a like-for-like curve) | 152ms → 75.2KB | 213ms → 62.6KB | 395ms → 58.3KB | 537ms → 55.9KB |

`optimize.ts`'s two `textureCompress()` calls never set `effort`, so
`@gltf-transform/functions` passes `undefined` through
(`remap(value, ...)` returns `undefined` for a nullish input — confirmed by
reading the source directly, not assumed) and sharp uses its own default,
which is effort 4. Dropping to effort 2 measures **~48% faster encode**
(605ms vs 1150ms summed across the three textures) for **~5–10% larger
output** (134.2 vs 128.0KB, 58.5 vs 53.3KB, 62.6 vs 58.3KB). This doesn't
move the SSIM gate — `effort` only changes how hard libwebp searches for a
smaller encoding at the *same* quality setting, not the pixels it produces —
so `verifyRig()`'s frozen contract is untouched by construction, not just by
absence of a failing test.

**Not fixed here.** This is a genuine trade with no code-derivable correct
answer: faster optimize() calls (valuable — `ROLES.md` names `inspect`,
optimize's sibling, as "the call you make after every edit," and this is the
same latency budget) against larger shipped textures, which is not something
`CLAUDE.md`'s SSIM-based "no visible loss is measured" contract prices in —
a profile's real-world byte budget is a separate, unmeasured expectation
`optimize()` has never been held to per-texture. Picking a floor (2? 3?) or
exposing `effort` as an `OptimizeOptions` passthrough is a product call, the
same kind `#56`/`#58`/`#61` already deferred to the maintainer for their own
budget-adjacent findings, not a bug this pass can close by itself.

### L200 · `open` · `optimize()`'s texture re-encode never sets libwebp's `effort`, leaving ~48% of its own wall-clock on the table for ~5-10% smaller files, with no policy decision made either way

Measured as above: `packages/core/src/optimize.ts`'s two `textureCompress()`
calls omit `effort`, so `@gltf-transform/functions` forwards sharp's default
(4) unchanged. Texture re-encode is the single largest non-frozen-render
stage of `optimize()` — 24% of wall-clock on a real 3-texture, budget-sized
asset (`site/models/cat.glb`, mobile-hero profile), more than dedup, weld,
simplify, smooth-normals, bake-instances, and meshopt-encode combined.
Dropping to `effort: 2` measured ~48% faster encode for ~5–10% larger WebP
output on the same three real textures, at unchanged quality/SSIM (effort
is a search-budget knob, not a quality one). **Closing this would take:**
a maintainer call on an acceptable effort floor (or exposing `effort` as a
passthrough `OptimizeOptions` field so a caller picks the trade), then
confirming the SSIM gate and every profile's practical file-size envelope
still hold across the LFS-scale fixtures this sandbox cannot reach.

Picked `L200` rather than the next nominally-free id on `main` (`L15`):
`#53`/`#56`/`#57`/`#63` all independently picked `L15` on branches cut from
the same base commit, and `#61` already jumped to `L120` for the identical
reason (`#38` claimed `L30`–`L32`, `#39` claimed `L33`–`L35`, `#54` claimed
`L60`, `#55` claimed `L70`). Jumping past the whole range every open PR has
already reached for is the only defense against being the *n*th collision
on it before a merge sorts the real numbering out.

## Verify

No code change shipped: the instrumentation used to gather the stage
breakdown was reverted (`git checkout -- packages/core/src/optimize.ts`,
confirmed `git status --short` clean) before this pass ended, and
`pnpm -r build && pnpm -r test` after reverting matches ground truth
exactly (177/180 core, 46/46 mcp, 5/10 cli, 2/2 studio). `pnpm probe --
--no-live --json /tmp/probe-after.json`: 28 tools, advice 3/3 resolved, 0
new findings, 0 dangling, 33/130 vocab codes, no regressions vs
`baseline.json`. The only numbers that moved between the before/after probe
runs are latency figures within normal host noise (e.g. `analyze_glb` p50
53ms → 48ms, p90 451ms → 364ms) — no `baseline.json` re-freeze.

## Left open

- `L200` above — a maintainer call, not a code fix this pass can make on its
  own judgement.
- The rotation-visibility gap (26 open, unmerged `agent-loop/*` branches
  against `main`'s ledger still reading every top-rotation role as "never
  used") — restated in prose only, per the same standing choice `#38`
  through `#63` have each already made. Still true, still not this pass's
  fix.
- `L4` (`site/llms.txt` version line) — untouched, a release call.
- Did not profile the LFS-gated Meshy fixtures (34–93MB, 2M-triangle scale)
  — not fetched in this sandbox. The breakdown above is on real,
  non-LFS, forge-produced assets at a meaningful scale (150k triangles),
  matching the convention `#30`/`#55` already used for the same reason.
