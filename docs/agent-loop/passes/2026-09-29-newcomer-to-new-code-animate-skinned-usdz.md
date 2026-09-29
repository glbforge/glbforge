# Pass — 2026-09-29 — 289eacd
**Role:** newcomer-to-new-code

## Step 0 — claim check, and why the literal rotation wasn't taken

`mcp__github__list_pull_requests` (no `gh` CLI in this sandbox): 25 open
`agent-loop/*` branches (plus `ci/usd-oracle`, unrelated), none merged since
`#20`. `pnpm ledger` on `main` prints `rival` next (0 merged passes), but
that role — and `integrator`, `performance`, `archaeologist`, `newcomer` right
behind it — each already has an open, unmerged PR from the last rotation
cycle (`#61`/`#62` rival, `#63` integrator, `#64` performance, `#65`
archaeologist, `#66` newcomer, all dated 2026-09-28), several of which
(`#62`, `#63`, `#65`, `#66`) already document the same cascade reasoning in
their own Step 0: `main`'s ledger only counts merged passes, so it keeps
reprinting the same "never used" tier while the real rotation has moved on
inside the unmerged backlog. Restating it in prose only, per that standing
choice — not filing a ninth mention of it as a ledger entry.

Rather than mechanically cascade one role further (`saboteur` or
`newcomer-to-new-code`, both last claimed 2026-09-24, five days stale, per
`#38`'s and `#66`'s reasoning applied one more step), I checked what
`newcomer-to-new-code` is actually for: "whatever shipped most recently and
has not been read by anyone but its author." `main` itself has moved since
this role's last run (`2026-09-23`, `56a5e59`, `companion-reply-id`) — not
from the stuck agent-loop backlog, but from a *different*, faster-merging
lane (`glbforge-info-pass`, most recently PR `#60`). Bundled into that lane's
merges is real pipeline code nobody in this rotation has reviewed yet:
`af4673c` (skinned assets read the pose, not the quantization cube),
`c5aa9f4` (`animate()` — new, ~260 lines, plus its USDZ node-clip export
path), `61d92d3` (draw-call accounting), `4df16a6` (USDZ skeleton sharing).
That is a better-justified pick than an arbitrary role-ladder rung: real new
ground, genuinely unread, no open PR claims it.

## Ground truth

`pnpm install && pnpm -r build`: clean, 6 packages. `pnpm -r test` before any
change: core 177/180 (3 skipped, LFS pointers), mcp 46/46, cli 5/10 (5
skipped, LFS), studio 2/2 — all green. `pnpm probe -- --no-live`: 28 tools,
packages 0.8.0, advice 3/3 resolved, 0 new findings, no regressions vs
`baseline.json`.

## What was reviewed, and what I found by running it, not just reading it

Read `56a5e59..8b223a6`'s diff to `packages/core/src` in full:
`animate.ts` (new file), `skinning.ts`'s `restPoseSkin`, `usdz.ts`'s
`shareSkeletons` and its new node-TRS-animation export, `harness/render.ts`'s
skinned rest-pose rendering. Checked each against `CLAUDE.md`'s invariants
(no `Math.random`, `readFloat()` vs. raw `getArray()`, `computeSmoothNormals`
never `gltf-transform`'s `normals()`, the frozen `verifyRig`). `restPoseSkin`
and `shareSkeletons` check out: the LBS math (`mats[k] = jointWorld * IBM`)
matches `usd-skel.ts`'s `mul`'s convention, the weight-normalization for
normals is scale-invariant so skipping it before the final `Math.hypot`
renormalization isn't a bug, and both have real, specific tests
(`skinning.test.ts`, `usdz.test.ts`) that fail on the old code and pass on
the new. `restPoseSkin`'s use in `harness/render.ts` is a no-op for every
unskinned primitive (`sp = skinned?.positions ?? null`), so it can't have
moved `baseline.json` for the fixtures this sandbox can reach (all LFS-gated
skinned fixtures self-skip); confirmed no `baseline.json` diff after.

The one combination no test file exercises: `animate()` called on an asset
that is *already* rigged, then exported to USDZ. Every `animate.ts` test
uses a plain mesh; every `usdz.test.ts` skin test calls `toUsdz` directly,
never through `animate()`. Built it by hand
(`animate(makeRiggedCylinder(), { preset: 'bob', duration: 1, fps: 10 })`
→ `toUsdz(doc, { format: 'usda' })`) and read the actual USD text rather than
assuming the design holds. It doesn't:

1. `animate()` reports `channels: 1` (the pivot's rise) — the clip exists.
2. `toUsdz` prints `'2 animation clips drive this skeleton; exported "bend"'`
   — wrong. `usd-skel.ts`'s `buildSkeleton` walks every joint's ancestors
   with no upper bound (`while (n) { chainNodes.add(n); n = n.listParents()... }`)
   to decide which clips "drive" the skeleton. `animate()` inserts its pivot
   *above the entire scene*, so it's now an ancestor of every joint too —
   the walk keeps climbing straight through the skin's own root joint into
   the pivot, and a clip that only ever targets that pivot gets counted as a
   second skeleton-driving clip it structurally cannot be.
3. Separately, `buildUsdLayer`'s `nodeClips` filter (`usdz.ts`) picks
   "the first clip with a non-weights node channel" with no check for
   *which* node — a joint qualifies exactly as well as a plain scene node.
   With two clips in `root.listAnimations()` order (`["bend", "bob"]`),
   `nodeClips[0]` is `"bend"`, so the node-xform bake targets the *wrong*
   clip too.
4. Net effect, confirmed by grepping the actual exported `.usda`: the string
   `"bob"` appears nowhere, `xformOp:transform.timeSamples` appears zero
   times, and the SkelAnimation carries only `"bend"`. The motion `animate()`
   was asked for is completely absent from the file, and the two warnings
   printed both blame the wrong clip for the wrong reason.

### L200 · `open` · `animate()`'s new clip vanished from a rigged asset's USDZ export, misdiagnosed by two wrong warnings, then correctly diagnosed but still unrepresentable

Fixed the misdiagnosis, left the underlying capability gap open — see below.

**Fixed** (`packages/core/src/usd-skel.ts`, `packages/core/src/usdz.ts`):
- `buildSkeleton`'s ancestor walk now stops at each joint's own *topmost
  joint* ancestor (already computed as `parentJoint`, reused here as a
  `topmostJoints` set) instead of climbing into whatever the caller nested
  the whole skin under. A clip that only touches nodes outside the skin no
  longer counts as driving it.
- `buildUsdLayer`'s `nodeClips` filter and its `nodeSamplers` mapping now
  exclude any channel whose target is one of the document's own joint nodes
  (`jointNodes`, built from every skin's `listJoints()`) — a joint's motion
  is the Skeleton's business, not the node-clip path's.
- With both fixed, `nodeClips` correctly resolves to `["bob"]` alone and the
  skeleton-driving-clip count drops back to 1 (`"bend"`) — no more spurious
  warnings on this fixture. Confirmed by rerunning the repro: `toUsdz`'s
  `warnings` came back empty at this point, which is *still wrong* — see next.
- The warning meant for exactly this situation existed already
  (`'Clip "..." moves no mesh-bearing node (skinned meshes follow their
  skeleton); the pose is static.'`) but its condition was
  `nodeClip && !bakedNodes && !skeletons.size` — it required *no* skeleton to
  fire a message about skinned meshes, so on any actually-skinned asset it
  was unreachable. That's why the empty-warnings result above was still
  wrong instead of merely quiet: flipped the condition to `skeletons.size`
  (skeleton present), split the formerly-shared branch so the genuinely
  skeleton-less case (`!skeletons.size`) keeps its own, un-mismatched
  message, and named the actual clip in the fired text instead of a generic
  sentence.

**Verified with two new tests** (`packages/core/test/usdz.test.ts`, describe
block `'animate() on an already-rigged asset, through toUsdz'`): one asserts
no `"drive this skeleton"` warning and exactly one `SkelAnimation`; one
asserts the specific, accurate warning names the pivot clip and says its
motion is "not reflected". Confirmed both fail on the pre-fix code
(`git stash` of the two source files, rebuild, rerun — both fail with
exactly the wrong-warning/no-warning text quoted above) and pass on the
fixed code.

**Left open — the actual motion still never reaches the file.** The warning
is now honest, but honesty isn't the fix: a skinned mesh's export branch
(`buildUsdLayer`'s `visit`, the `mesh && skin && skeletons.has(skin)` case)
places the `Mesh` prim directly under the `SkelRoot` with *no* wrapping
`Xform` at all — by design, since glTF ignores a skinned node's own
transform and `points` already live in skeleton space. That means there is
currently no attachment point in the USD output for *any* ancestor motion
above a skin, animated or not-yet-static-but-now-moving. The static case
already works by a different, non-obvious route: a topmost joint's
`restTransforms` entry is that joint's own `getWorldMatrix()`, which
naturally bakes in every static ancestor above it (confirmed: a
non-identity static parent above a rig's root joint is already captured
there, not lost). There is no equivalent for an *animated* ancestor — the
SkelAnimation only samples channels that target joints directly, and
`animate()`'s pivot deliberately isn't one. Giving the skinned branch the
same `chainAnimated`/`worldAt` Xform-wrapping the unskinned branch already
has would need to carry only the *animated delta* above whatever
`restTransforms` already captures statically, or the rest-pose contribution
would be double-counted. That's a real, scoped fix — but it's a second
architectural piece, not a hot-fix riding on a misdiagnosis correction, and
I'd rather hand it to a pass with the budget to get the double-counting
question right than rush it here. Reproduction is exact and cheap for
whoever picks it up: `animate(makeRiggedCylinder(), {...})` then `toUsdz`,
grep the `.usda` for the clip's own values.

## Verify

`pnpm -r build && pnpm -r test`: core 179/182 (+2, 3 skipped LFS — unchanged
skip count), mcp 46/46, cli 5/10 (5 skipped LFS), studio 2/2 — all green.
`pnpm probe -- --no-live`: 28 tools; packages 0.8.0; advice 3/3 resolved (1),
0 new findings; 33/130 vocab, 0 undeclared/undocumented/schema violations;
no regressions vs `baseline.json` (unchanged, no re-freeze needed — nothing
here touches a fixture the probe or CI can reach). `pnpm docs:check`: in
step, 28 MCP tools, 21 CLI verbs, packages 0.8.0 (unchanged — no new
tool/verb, no CLAUDE.md claim affected).

## Left open, besides L200's remaining half

- The rotation-visibility gap (unmerged PRs stall `pnpm ledger`'s view of
  "recently used") — restated in prose only, per the standing choice this
  week's sibling passes made; not this pass's fix.
- Finding-id collision risk: `main`'s ledger tops out at `L14`, but sampled
  open PRs already use `L15` (`#63`) and `L150` (`#65`) for unrelated
  findings — `L200` here is a guess clear of both, not a guarantee; the
  eventual merge will need the renumbering pass `#43`'s `L39` already
  flagged.
- `L4` (`site/llms.txt` version line) — untouched, a release call.
