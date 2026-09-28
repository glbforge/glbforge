# Pass — 2026-09-28 — 289eacd
**Role:** newcomer

**Step 0 (claim check):** `gh pr list --state open --json number,title,headRefName
--jq '.[] | select(.headRefName | startswith("agent-loop/"))'` returned 25 open
branches. Five are dated today: `#65` archaeologist, `#64` performance, `#63`
integrator, `#62` and `#61` rival. `pnpm ledger` on `main` (which knows nothing
about any of them — none have merged) still names `rival` next, since
`rival`/`integrator`/`performance`/`archaeologist` all read "never used" there.

Per `ROLES.md` ("if the least-recent role genuinely cannot run this pass...
take the next one and write down why") — the same call `#32` made on
2026-09-24 under an identical squeeze — I skipped all four: `#62` (this
morning, same base commit as this pass) already read all 16 other open
`rival` PRs and searched past them, and reports the remaining ground as
exhausted; `#63`/`#64`/`#65` each claim one narrow finding in `integrator`/
`performance`/`archaeologist` today, not the whole role, but re-running any
of the three within hours of its own open PR risks the same duplication step
0 exists to prevent. The next slot down un-claimed today is `newcomer`
(ledger: 1 pass, last 2026-09-22) — took that.

**Ground truth:** `pnpm install && pnpm -r build` clean. `pnpm -r test`
green: core 177/180 (3 skipped, LFS), mcp 46/46, cli 5/10 (5 skipped, LFS),
studio 2/2 — matches `#62`'s numbers exactly, same base commit. `pnpm probe --
--no-live`: 28 tools, packages 0.8.0; advice 3/3 resolved, 0 new findings;
33/130 vocab, 0 undeclared/undocumented/schema violations; no regressions vs
baseline.

## What was checked

**A real job, using only `--help` output and each command's own "next:"
pointer** — no reading `packages/core/src` or `packages/cli/src`: turn a
static asset into an animated AR Quick Look character.

No local skinned/rigged fixture exists (`fixtures/veiled-guardian*.glb` are
LFS pointers, 133 bytes, unreachable here), so I used the two real non-LFS
assets in the repo that have actual geometry: `site/models/plush.glb`
(1.1MB, 4 materials, no textures) and `site/models/cat.glb` (3.2MB, 1
material, 3 WebP textures).

1. `glbforge animate plush.glb --preset idle` — one line of output named the
   motion in plain terms ("rises 7mm, turns ±4.0°, tilts ±1.5° over 4s, 121
   keys") and ended with `next: glbforge inspect ... · glbforge usdz ...
   (AR Quick Look plays the clip)`. Followed it verbatim.
2. `glbforge usdz plush.idle.glb` — no complaint, no mention of the clip
   either way. `usdz --help` only promises clip export for *skinned* assets
   ("Skinned assets export a UsdSkel skeleton with the first animation clip
   sampled at 30 fps") — `animate`'s output here is an ordinary node
   transform on an inserted pivot, not a skin, so I could not tell from the
   CLI alone whether the clip actually made it into AR-playable form or was
   silently dropped for anything non-skinned. Had to look, not guess: reran
   with `--usda` (a supported debug flag, not source-reading) and inspected
   the text layer. It does carry the animation — `startTimeCode`/
   `endTimeCode` 0–120 at 30 fps matches the 4s/121-key clip exactly, and the
   four mesh prims' `xformOp:transform.timeSamples` genuinely vary frame to
   frame (checked the raw matrices, not just presence of the block). So the
   clip **does** export correctly for a plain node animation — good news,
   but the CLI/`--help` text under-promises what it does (only documents the
   skinned case) and gives an agent no way to confirm the non-skinned case
   without a debug flag most wouldn't reach for.
3. Repeated the same two steps on `cat.glb` (`--preset breathe`) to check a
   second shape (single mesh, textured, WebP → USDZ). `usdz` transcoded the
   3 WebP textures to `textures/tex_0..2.png` as `--help` says it will.
   Verified the zip independently with Python's `zipfile` (not GLBForge's
   own code): all four entries (`model.usdc` + 3 textures) are store-only
   (`compress_type == 0`), and — computing local-header-size + filename +
   extra-field length per entry, not just the header offset — every entry's
   *data* starts on a 64-byte boundary, matching `CLAUDE.md`'s "64-byte-
   aligned store-only zip" claim. (First pass at this check used the raw
   zip header offset instead of the data offset and looked misaligned for
   every entry after the first — a methodology bug on my side, not
   GLBForge's; the corrected check, which is what actually matters for an
   AR viewer mmap-ing the file, passes.)

## What changed

Nothing. The job completed with no wrong turn an agent would actually hit —
`animate`'s "next:" pointer led straight to a working AR asset for both
fixtures tried, textures transcode as documented, and the zip layout matches
the documented invariant under independent verification. The one place I had
to stop and check rather than trust the docs (does a non-skinned `animate`
clip actually reach AR Quick Look, since `usdz --help` only documents the
skinned case) resolved in GLBForge's favor, not against it — not a defect,
just a gap in what the help text promises. Not worth a finding on its own:
the behavior is correct, only the documentation is silent on it, and
`usdz --help` describing every animation path this precisely would grow the
already-long help text for a case that "just works" either way.

## Left open, and why

- The `--help` gap above (non-skinned animation export undocumented,
  behavior fine) — recorded here, not filed as a ledger entry. It's a
  documentation completeness call, not a defect an agent hits blind: the
  CLI never claims non-skinned clips are *dropped*, it just doesn't say
  they're kept either, and the "next:" pointer told me to try `usdz` anyway
  and it worked.
- The rotation-visibility gap `#62` already named in prose (role usage stays
  "never"/stale on `main` while unmerged PRs claim it repeatedly) — same
  observation from the newcomer side this time: `newcomer` itself has an
  unmerged, unread finding sitting at `#32` since 2026-09-24. Restating in
  prose only, per the same standing choice several sibling passes have made.
- No skinned fixture reachable in this sandbox to exercise the `UsdSkel`
  path `usdz --help` documents — LFS-gated, a sandbox limit, not a finding.
- `L4` (`site/llms.txt` version line) — untouched, a release call.
