# Pass — 2026-09-25 — 8b223a6
**Role:** rival

## Step 0 — claim check

`gh` is not available in this sandbox; used the GitHub MCP tools instead
(`list_pull_requests`, `state: open`). 13 open PRs with `agent-loop/`-prefixed
branches, all claimed and left untouched: `#43` (integrator, MCP relative
path), `#42` (rival, LOD fidelity vs gltfpack), `#40` (rival, SSIM oracle),
`#39` (rival, Manifold watertight oracle), `#38` (rival, gltf-validator
conformance), `#37` (saboteur, NaN vertex), `#34` (newcomer-to-new-code,
companion npm files), `#32` (newcomer, extrude alpha leak), `#31`
(archaeologist, ROADMAP), `#30` (performance, topology), `#29` (integrator,
scaffold), `#28` (rival, gltfpack size + KHR_texture_transform fix), `#20`
(companion reply id). None compare geometry *codecs* — every open rival PR
compares against a whole competing tool (gltfpack, ssim.js, Manifold,
gltf-validator) on a whole-pipeline basis. Draco vs. `EXT_meshopt_compression`
specifically is untouched territory.

## Role

`pnpm ledger` (after `pnpm install && pnpm -r build`) printed **rival** as
least-recently-used. Five rival PRs are already open and unmerged against
`main` (listed above), which means `main`'s ledger still shows rival at 0
uses — the rotation can't see work sitting in open PRs. Taking rival again
risks piling on; I read all five titles first and picked an angle none of
them cover (codec-level, not tool-level) rather than re-running a variant of
one already open.

## Ground truth

`pnpm install && pnpm -r build`: clean. `pnpm -r test`: 177/180 core (3
skipped, LFS pointers), 46/46 mcp, 5/10 cli (5 skipped) — all green before
any change. `pnpm probe -- --json /tmp/probe.json --markdown /tmp/probe.md
--no-live`: 28 tools, 3/3 advice resolved, 33/130 vocab codes exercised, no
regressions vs `docs/agent-loop/baseline.json`. Only surface drift: `L4`
(`site/llms.txt` "0.9.0 line" vs 0.8.0 packages), already open and a release
call per the ledger — left alone.

## Rival work: Draco vs. `optimize()`'s meshopt compression

`optimize()` (`packages/core/src/optimize.ts:492`) has exactly one geometry
codec: `meshopt()` from `@gltf-transform/functions`, gated on `compress !==
false`, quantizing positions/normals/tangents/UVs to ~16-bit and wrapping
them in `EXT_meshopt_compression`. No open finding or ROADMAP item asks
whether that's the best codec for GLBForge's own assets, so I built the
comparison: same source geometry, GLBForge's own pipeline vs. Google's Draco
(`KHR_draco_mesh_compression`, via `gltf-pipeline@4.3.1` on npm — no local
build, network-installed from the allowlisted registry).

**Asset:** `assets/sample-ring.glb`, GLBForge's own `extrude` output (a real
product artifact, not synthetic) — 2,048 triangles, 1,536 vertices, one
material, no texture. It's the only non-LFS raw (unquantized,
uncompressed) fixture in the repo; `site/models/*.glb` and the two LFS
fixtures were checked and rejected — all three `site/models/*.glb` already
carry `EXT_meshopt_compression` + `KHR_mesh_quantization` (their
`asset.generator` is `glTF-Transform v4.4.2`, i.e. they're already GLBForge
output baked for the live site), so running them through `optimize
--no-compress` again would measure "re-encode an already-compressed file,"
not "compress a raw one" — confirmed this by inspecting `cat.glb`'s own
JSON chunk before touching it, not by assumption. The two `fixtures/*.glb`
are git-LFS pointers, unavailable in this sandbox.

Verified `optimize --no-compress` is honest first (it isn't the finding —
checking it cost ten minutes and produced nothing to report, which is worth
recording so the next rival doesn't re-walk it): on the ring, `--no-compress`
writes plain float32/uint16 accessors with no `EXT_meshopt_compression`
(50,164 bytes), and the default run writes the compressed 16,620-byte file —
the flag works. My first pass at this used `cat.glb` and briefly looked like
`--no-compress` was a no-op (byte-identical output either way); that was the
already-compressed source carrying its own quantization through
`weld()`/`prune()` untouched, not a bug in the flag. Worth stating plainly so
it isn't rediscovered: **not a finding.**

**Table** (bytes measured with `stat`, gzip with `gzip -9`, matching how a
CDN would actually serve either file):

| encoding | raw bytes | gzip bytes |
|---|---:|---:|
| source (float32, no compression) | 50,164 | 19,338 |
| **glbforge optimize** (meshopt, ~16-bit quantization) | 16,620 | 6,594 |
| gltf-pipeline Draco, default (11-bit pos / 8-bit normal / 10-bit uv) | **4,544** | **4,006** |
| gltf-pipeline Draco, precision-matched (16-bit pos / 12-bit normal / 12-bit uv) | **7,904** | 6,860 |

Encode wall-clock: `gltf-pipeline`'s own reported total was ~49ms for either
Draco run on this asset. I did not get a clean apples-to-apples number for
GLBForge's own encode step alone — `optimize_glb`'s probe latency (p50
2,370ms) includes render-based SSIM verification and texture work the ring
doesn't even exercise, so quoting it against gltf-pipeline's 49ms would
overstate the gap. Left as: **not measured cleanly, don't claim it.**

**Reading it honestly, both directions:**
- At Draco's *default* precision, it beats meshopt by 3.7x raw / 1.6x
  gzipped. That's not a fair fight (11-bit position quantization is
  visibly coarser than GLBForge's ~16-bit), but it's also gltf-pipeline's
  actual out-of-the-box default, i.e. what a rival tool an agent reached for
  instead would produce unless it went looking for extra flags.
- At *matched* precision (16-bit position, closer visual parity), Draco
  still wins on raw bytes (2.1x smaller) but **loses on gzip** — 6,860 vs.
  6,594, a rare case where GLBForge's own number is ahead once you account
  for what a browser actually downloads. That's the real story: meshopt's
  format is deliberately built to leave headroom for a generic compressor
  to exploit (its raw output is far from gzip's floor — 16,620 → 6,594 is a
  60% cut from gzip alone), while Draco's entropy coding is already close
  to its own floor (7,904 → 6,860 is only 13%). A raw-byte comparison alone
  — which is what `optimize()`'s reported `savedPct` and this repo's size
  budgets measure — makes Draco look strictly better than it is once you
  account for the transfer layer GLBForge actually targets (`profiles.ts`'s
  own budget commentary talks about "meshopt-compressed triangles," i.e. the
  file on disk, not the gzipped wire size).

**Not fixed, deliberately.** Swapping or adding a geometry codec is a
pipeline change this repo treats as a versioned contract: it would move
`verifyRig()`'s calibration, `baseline.json`'s latency numbers, and every
published budget profile's `maxTriangles` commentary (`profiles.ts`, which
already cites "150k welded, quantized, meshopt-compressed triangles land
around 1-2MB" as a hard number). It also needs a decode-side story
GLBForge doesn't currently have any opinion on (Draco decode is
CPU-heavier and needs the Draco WASM decoder wired into every consumer;
`EXT_meshopt_compression`'s decoder is already assumed by `packages/cli`,
Studio and the R3F scaffold). That's a maintainer call, not a one-pass
change — recording the numbers is the rival's job here, not making the
call.

## Verify

`pnpm -r build && pnpm -r test`: unchanged, all green (no source touched).
`pnpm probe -- --json /tmp/probe-after.json --no-live`: identical to the
before run. No `baseline.json` edit — nothing moved.

### L12 · `open` · `optimize()`'s only geometry codec (meshopt) loses to Draco on raw bytes, and the gap flips once gzip is accounted for

Measured on `assets/sample-ring.glb` (2,048 triangles, GLBForge's own
`extrude` output — the only non-LFS raw fixture in the repo) against
`gltf-pipeline@4.3.1`'s Draco encoder: raw bytes, GLBForge 16,620 vs. Draco
4,544 (default precision, 3.7x) / 7,904 (16-bit-position precision matched
to GLBForge's own quantization, 2.1x); gzip bytes (`gzip -9`), GLBForge
6,594 vs. Draco 4,006 (default, still 1.6x) / **6,860 (matched precision —
Draco loses here, by 4%)**. The flip at matched precision is because
meshopt's format leaves far more headroom for generic compression (60%
further cut from gzip) than Draco's already-entropy-coded output does
(13%), and GLBForge's own size numbers (`savedPct`, budget `maxTriangles`
commentary) are raw-byte, not wire-byte. Not fixed: changing the default
codec is a versioned-contract-sized decision (recalibrates `verifyRig()`,
`baseline.json`, every budget profile's size commentary, and needs a
decode-side story for `KHR_draco_mesh_compression` in every consumer this
repo ships). Closing this would mean either: (a) a deliberate decision to
add Draco as an opt-in `--draco` geometry codec alongside meshopt (mirroring
how `--ktx2` already sits alongside WebP for textures), scoped and verified
like any other budget-profile change, or (b) a documented decision that
meshopt's gzip-friendliness is the actual design goal and raw-byte
comparisons against Draco are apples-to-oranges — either is fine, but right
now neither is written down anywhere.
