# Pass — 2026-09-24 — 09397cd
**Role:** rival

## Step 0 — claim check

`gh pr list --state open --json number,title,headRefName` (via the GitHub
MCP tools; no `gh` CLI in this sandbox) showed nine open PRs. Seven carry
`agent-loop/`-prefixed branches: `#37` saboteur (a `NaN` vertex breaking the
envelope contract), `#34` newcomer-to-new-code (companion npm `files`),
`#32` newcomer (`extrude --json` alpha leak), `#31` archaeologist (ROADMAP
T7), `#30` performance (`analyze()`'s topology pass), `#29` integrator
(`scaffold`'s build/install path), `#28` **rival**. Two more, `#36` and
`#35`, are `fix/`-prefixed (USDZ skeleton export, draw-call promises) —
outside this loop's convention, left untouched.

`pnpm ledger` prints `rival` as least-recently-used — `main`'s ledger only
goes to `L11`, and it has no way to see the unmerged `#28` that already
claims the role. Read `#28`'s pass file in full before deciding anything:
it took gltf-transform-CLI and gltfpack through the same three
`site/models/*.glb` assets `optimize()` uses, measured bytes / SSIM /
wall-clock, found `optimize()` leaves 12–39% on the table
(`meshopt({level:'medium'})` vs the library's own `'high'` default, left
open pending LFS access to re-calibrate), and fixed a real bug it tripped
over (`KHR_texture_transform` ignored by the render harness).

That is thorough, real rival work — repeating "GLBForge vs. another
optimizer, on file size" would be exactly the duplicate-work waste the
skill warns about, not a second honest measurement. ROLES.md's rival
section doesn't require the alternative be an *optimizer*, only "a real
asset through GLBForge and through an alternative... compare on numbers."
So this pass stays `rival` — the role itself isn't claimed, only one axis
of it is — and picks a different alternative and a different axis: the
Khronos reference `gltf-validator` (npm, the compiled-to-JS build of the
same validator the glTF working group ships), on spec conformance rather
than optimization, against `inspect`/`analyze` rather than `optimize()`.
Zero overlap with `#28`'s files, fixtures, or findings.

## Ground truth

`pnpm install && pnpm -r build`: clean, six packages. `pnpm -r test`: 175/178
core (3 skipped, LFS), 44/44 mcp, 5/10 cli (5 skipped, LFS), 2/2 studio — all
green before any change. `pnpm probe -- --no-live`: 28 tools, 3/3 advice
actions resolved, 33/130 codes, 0 schema violations, no regressions vs
`baseline.json`. Only surfaced item: the known `L4` (`site/llms.txt`'s
0.9.0 line vs 0.8.0 packages) — a release call, left alone.

This pass makes no source changes, so "before" and "after" are the same
run; noted once here rather than repeated in a Verify section.

## The rival

`gltf-validator@2.0.0-dev.3.10` (npm, Dart-compiled JS, the same engine
behind `gltf.report` and Blender's own glTF exporter self-check) installed
clean, no other network needed. Node API (`validateBytes`), called directly
— no CLI wrapper exists for this package.

Three real, non-LFS assets first (`site/models/{cat,plush,neon}.glb` — the
same fixtures `#28` used, themselves prior GLBForge output): the validator
reports **0 errors, 0 warnings** on all three — one `UNSUPPORTED_EXTENSION`
info per file (it doesn't know `EXT_meshopt_compression`) and one
`UNUSED_OBJECT` info on two of them (the raw buffer looks unreferenced to a
validator that can't see through the meshopt extension to the accessors it
backs — not a GLBForge defect). Confirms `optimize()`'s own output is
clean by the spec's own reference implementation, which is worth knowing
even though it isn't the interesting result.

The interesting result needed assets with real defects, so I built six
synthetic GLBs from one valid one-triangle mesh (`@gltf-transform/core` to
build it, then direct GLB byte-patching — JSON chunk edited, `BIN` chunk
resliced where a component-level corruption needed it — for each variant),
and ran each through both the reference validator and GLBForge's own
`inspect` / `analyze` (CLI and, for the two most interesting rows, the MCP
surface directly via an in-process client against `packages/mcp/dist`, the
same harness `packages/mcp/test/inspect.test.ts` uses).

| corruption | `gltf-validator` | GLBForge |
|---|---|---|
| missing `asset.version` | 1 error: `UNDEFINED_PROPERTY` | **wins.** `inspect`/`analyze_glb` both fail loud and readable: `ok:false`, `FILE_UNREADABLE`, `"...could not be parsed as glb: Unsupported glTF version, \"undefined\"."` — envelope intact, no crash. |
| accessor `min`/`max` declares `[-5,-5,-5]`/`[5,5,5]`; real data is `[0,0,0]`/`[1,1,0]` | 6 errors: `ACCESSOR_MIN_MISMATCH` × 3, `ACCESSOR_MAX_MISMATCH` × 3 | **loses, quietly.** `inspect`'s own bounding box is correct (`1.00 × 1.00 × 0.00 m` — it recomputes from real vertex data, per `extent.ts`'s `forEachWorldVertex`, never trusting the declared accessor bounds). But nothing says the *file's own metadata* is spec-invalid. A renderer that takes the documented shortcut of trusting `accessor.min`/`max` for frustum culling — legal per spec, common in practice — gets a wrong bound from an asset GLBForge reported as clean. |
| `NORMAL` accessor scaled to length 4 (not unit) | 3 errors: `ACCESSOR_VECTOR3_NON_UNIT` | **loses, quietly.** No finding, no mention, in either tool. |
| primitive's `POSITION` renamed to lowercase `position` (invalid glTF semantic — case-sensitive by spec) | 1 error (`MESH_PRIMITIVE_INVALID_ATTRIBUTE`) + 1 warning (`MESH_PRIMITIVE_NO_POSITION`), pinpointing exactly what's wrong | **loses badly, and disagrees with itself.** See below. |
| one index in the triangle's index buffer set to `999` (only 3 vertices exist) | 1 error: `ACCESSOR_INDEX_OOB`, naming the exact out-of-range value | **loses, quietly.** `inspect` treats it as an ordinary 1-triangle mesh (`forEachWorldVertex` walks the `POSITION` accessor directly, never the index buffer, so the corrupt index never reaches bounds/centroid — no crash, confirmed safe) but reports topology (`"1 boundary loop totalling 1 open edge"`) computed from whatever `topology.ts`'s triangle-adjacency pass makes of a vertex reference past the end of the buffer — a specific-sounding number built on invalid input, with no signal that the input was invalid. |

### L30 · `open` · `analyze_glb` and `inspect` disagree about whether a spec-invalid primitive has any geometry at all — and `analyze` scores it 95/100 "passed"

The lowercase-attribute file is the standout, because GLBForge's own two
main surfaces contradict each other on the same input:

- `inspect --json`: `"summary": "0 meshes, 0 triangles, no geometry..."`,
  `scene.meshes: 0`, `findings: []`. Confirmed on the MCP surface too
  (`inspect`, in-process client against `packages/mcp/dist/server.js`):
  `ok:true`, no errors, same "no geometry" read.
- `analyze --json` (same file): `geometry.meshCount: 1`,
  `geometry.primitiveCount: 1`, `geometry.triangles: 1`,
  **`geometry.vertices: 0`**, `geometry.primitives[0].attributes:
  ["NORMAL", "position"]` — it reads the raw attribute key off the JSON
  directly (hence seeing the literal string `"position"`), so it knows the
  primitive exists and what its attribute list actually says, but never
  checks that `"position"` isn't a real glTF semantic. `findings` carries
  only `geo/missing-uvs` (warn) and `mat/no-material` (info) — nothing
  about the missing `POSITION` or the internally contradictory
  `triangles: 1, vertices: 0`. Overall: **`"score": 95, "passed": true`.**
  Confirmed on MCP (`analyze_glb`): same `ok:true`, same silence.

An agent asking "is this asset good to ship" gets a 95/100 pass from one
GLBForge tool and "there is no geometry in this file" from the other, on
the identical input, and neither one says the actual, findable, one-word
problem: an attribute name (`position`) that only differs from a valid one
(`POSITION`) by case. `gltf-validator` names it exactly, in one call, in
23ms.

Root cause sketch for whoever picks this up: `analyze/geometry.ts` reads
attribute names off the raw JSON (a `primitives[].attributes` object walk)
but computes `vertices`/`bounds`/topology through `@gltf-transform/core`'s
`Document` API, which only recognizes the canonical uppercase semantics —
so a mis-cased attribute is visible to the first path and invisible to the
second, and nothing reconciles `triangles > 0` with `vertices === 0` as a
contradiction worth a finding. `inspect` goes through the same `Document`
API exclusively (`from-gltf.ts`'s `prim.getAttribute('POSITION')`), so it
never sees the raw key at all — by the time its code runs, gltf-transform's
own reader has already decided the primitive has no `POSITION`, i.e. no
vertices, i.e. (per `inspect`'s counting) no mesh. A one-line "if triangles
> 0 and vertices === 0, that's an error, not a passing score" guard in
`rules.ts` would close the `analyze` half; the `inspect` half needs reading
the raw attribute object before or alongside the `Document` load to catch
a case a wrapped library will never surface, which is a bigger, separate
change to `from-gltf.ts`'s read path. Not attempted in this pass:
`analyze/geometry.ts` is the exact file `#30` (performance, open, unmerged)
already rewrote substantially (`canonicalByAttributes`, `sortPairs`) —
touching it here risks a real merge conflict with in-flight work on the
same file, not a design question. Left for whoever lands after `#30`
merges.

### L31 · `open` · GLBForge gives no diagnostic for genuine glTF spec violations the reference validator rejects outright (bad accessor bounds, non-unit normals, out-of-range indices)

The three "loses, quietly" rows above, together: an asset with a lying
bounding box, or non-unit normals, or an out-of-range index, passes
`inspect`/`analyze` with zero findings, on both the CLI and the MCP
surface (spot-checked the bbox-mismatch and non-unit-normal files against
`inspect`/`analyze_glb` over MCP directly — both `ok:true`, zero errors,
matching the CLI). None of this is `inspect`'s own arithmetic going wrong —
`extent.ts` correctly recomputes real bounds from vertex data rather than
trusting the declared `min`/`max`, which is the right call for GLBForge's
*own* rendering/SSIM pipeline. The gap is that nothing tells the *agent*
the input file itself carries spec-invalid metadata that a different
consumer (another engine's fast-path bounding check, a strict loader on
the out-of-range index) would handle differently or reject outright.
GLBForge doesn't claim to be a spec validator anywhere in `README.md`,
`packages/mcp/README.md`, or `site/llms.txt` — so this isn't a broken
promise, just a real, unadvertised blind spot for an agent that assumes
"no findings" means "no problems," which the `04` row above shows can also
mean "not a real mesh." Left open rather than fixed for the same
file-risk reason as `L30`: a real fix is a new class of diagnostic (spec
conformance, distinct from the domain rules `core-geometry@1`/
`core-scene@1` check today), not a one-line addition, and the natural home
for at least some of it overlaps `L30`'s.

### L32 · `open` · the ledger's "next free id" is unreliable across concurrent unmerged passes — seven of seven open PRs collided on `L12`

Not a rival finding — surfaced by reading all seven open `agent-loop/`
PRs' pass files while doing Step 0's claim check, and worth recording
because the evidence is now unambiguous. `pnpm ledger`'s "next free id" is
computed from `main`'s merged pass files only (`docs/agent-loop/ledger.md`
tops out at `L11`); a concurrent pass on an unmerged branch has no way to
see another concurrent pass's chosen id, since neither is on `main` yet.
Result, checked directly against every currently-open PR's actual pass
file: **`#28`, `#29`, `#30`, `#31`, `#32`, `#34`, and `#37` every one
picked `L12`** for seven unrelated findings (gltf-transform level, the
scaffold KTX2 type mismatch, the topology hash rewrite, the ROADMAP T7
staleness, the extrude alpha leak, the companion npm `files` gap, the
`NaN`-vertex envelope crash) — and `#29` and `#30` both also picked `L13`.
`scripts/ledger.mjs`'s fold step (`current.set(f.id, ...)`, last pass by
date-then-filename wins) has no collision detection: whichever of these
seven merges last will silently overwrite the other six's `L12` row with
its own title, and `pnpm ledger --check` (the CI gate) would still pass,
because regenerating from whatever's on disk at that point is exactly
what it checks. Nothing in the current workflow would surface that six
real, distinct, already-fixed findings quietly lost their ledger row.
Picked `L30`–`L32` for this pass's own findings specifically to dodge
adding an eighth collision to `L12`/`L13` — not a defense against the next
concurrent pass, since I have exactly the blind spot described above with
respect to *it*, just an attempt not to make today's pile-up worse. Not
fixed here: a real fix (id allocation that survives concurrent unmerged
branches — a reserved range per branch, a collision check in
`ledger.mjs --check`, or a PR-number-based namespace) is a design
decision about the loop's own machinery, and this pass's mandate is
comparing GLBForge to a rival, not re-engineering the ledger mid-pile-up.
Worth an `archaeologist` or a dedicated pass once the current backlog of
seven merges down.

## Verify

No source changed, so `pnpm -r build && pnpm -r test` and
`pnpm probe -- --no-live` were only run once (Ground truth, above) — same
numbers apply as "after." No `baseline.json` change.

## Left open

- `L30`, `L31`, `L32` above — none fixed, for the reasons stated in each
  (file-conflict risk with `#30`'s unmerged rewrite of the exact file the
  first two would need to touch; the third is the loop's own tooling, out
  of scope for a rival pass).
- Did not try `gltfpack`/`gltf-transform` CLI myself — `#28` already did
  that comparison thoroughly; repeating it was the duplicate work Step 0
  exists to prevent.
- Did not try Blender's exporter or `usdzconvert` — no display/Blender in
  this sandbox; USDZ already has its own oracle (`test/usd-oracle.py`).
- Did not chase whether other synthetic corruptions (cyclic scene graphs,
  more exotic accessor types) turn up more gaps — `#37` (saboteur, open)
  already covers adversarial-input territory; six corruption vectors
  through one real reference tool was enough for an honest table without
  wandering into that pass's ground.
- `L4` (`site/llms.txt` version line) untouched, per the standing
  instruction.
