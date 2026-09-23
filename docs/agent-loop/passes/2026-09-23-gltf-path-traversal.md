# Pass — 2026-09-23 — 8495329
**Role:** saboteur

## Step 0 — claim check

`gh` is not available in this sandbox; used the GitHub MCP tools instead.
Two open PRs have `agent-loop/`-prefixed branches: `#24`
(`agent-loop/roles`) and `#20` (`agent-loop/2026-09-23-companion-reply-id`)
— both claimed, left untouched. `#22` (`feat/companion-hooks`) is open but
not `agent-loop/`-prefixed, so not a loop claim; left alone anyway, out of
scope for this pass.

## Role

`docs/agent-loop/ROLES.md` and the `pnpm ledger` rotation printer both live
only on `#24`, still open, so `pnpm ledger` on `main` prints no rotation
line. Rather than re-implement that (claimed territory — `#24` is exactly
this infra), I read its diff and hand-computed the same result its
`scripts/ledger.mjs` change would print: of the 11 backfilled passes,
`auditor` has 9, `newcomer` and `newcomer-to-new-code` have 1 each, and
`saboteur`/`rival`/`integrator`/`performance`/`archaeologist` have never
run — first among those in `ROLES.md` declaration order is `saboteur`. I
took that role. `#24`'s own PR description independently says the same
thing ("the next pass draws `saboteur`"), so this isn't a guess.

## Ground truth

`pnpm install && pnpm -r build`: clean. `pnpm -r test`: 171/171 core (3
skipped, LFS), 44/44 mcp, 5/5 cli (5 skipped) — all green before any
change. `pnpm probe -- --no-live`: 28 tools, no baseline regressions, one
pre-existing drift (`site/llms.txt` line 12 said "27-tool" while line 122
of the same file already said "28-tool" — the server has grown a tool,
probably `animate`, since line 12 was last touched). Fixed that one line;
trivial, evidence-backed, not the saboteur's job but free to take.

## Saboteur work

Attacked the tool's own inputs: crafted `.gltf` files with a `buffers[].uri`
(and separately `images[].uri`) pointing outside the asset's own directory,
via both `../` relative traversal and a bare absolute path, then fed them to
`loadScene` (`packages/core/src/inspect/load.ts`) — the function nearly every
MCP tool and the CLI use to read a file from disk (`inspect`, `analyze`,
`diff`, `validate`, `optimize`, ...).

**Confirmed: full arbitrary-file read, byte-exact.** Neither `../` nor an
absolute URI was checked against the `.gltf`'s own directory before
`readFile`. A `POSITION` accessor whose `bufferView` pointed at the escaped
buffer read back the target file's exact bytes — verified by writing a
known string to a file outside the fixture directory and recovering it
byte-for-byte through the loaded `Document`'s accessor array. It also
surfaced live in ordinary tool output: `glbforge inspect --json` on the
crafted file reported a bounding box (`781.05 × 209670422528.00 ×
951492089478973.75 m`) computed directly from the victim file's bytes
reinterpreted as float32 — a real information leak through a normal `inspect`
call, not just at the API level. `resolveAsset` in the same file had the
identical shape for USD (`.usda`/`.usdc`) external asset references, both
absolute and relative.

This is squarely in scope for an agent using GLBForge on anything it did
not author itself: a downloaded asset, another agent's output, a Meshy/fal
result cached to disk, a file attached by a user. Nothing about the attack
needed the network or the host beyond the one file the tool was pointed at
— a single crafted `.gltf` did it.

**Fixed.** `load.ts` now resolves every external buffer/image/USD-asset URI
against the asset's own directory and refuses anything that resolves
outside it — treated exactly like a missing file already was (the existing
`BUFFER_UNRESOLVED` diagnostic / unresolved-texture path), not a new error
shape for an agent to learn. `usdz` container assets were never at risk
(they're read from the in-memory zip by name, not the filesystem).

New test: `packages/core/test/path-traversal.test.ts` (3 cases — `../`
escape, absolute-path escape, and a legitimate same-directory buffer still
resolves). Verified it fails without the fix (`git stash` on just `load.ts`
reproduced the leak: accessor length 9, i.e. the secret bytes came back) and
passes with it.

**Left open, not a new finding:** path containment is by resolved path, not
canonical path — a symlink planted inside the asset directory before the
`.gltf`/`.usda` is packaged and pointing outside would still escape. Exploiting
that needs write access to the asset's own directory tree first, which is a
narrower threat than "read one crafted file an agent was handed" and out of
scope for this pass; worth an `archaeologist` or `saboteur` look if the asset
pipeline ever accepts directories/zips from an untrusted source rather than
single files.

## Verify

`pnpm -r build && pnpm -r test`: 174/177 core (3 skipped), 44/44 mcp, 5/10
cli (5 skipped) — all green, +3 tests from this pass. `pnpm probe --
--no-live`: identical to before except the tool-count drift line is gone;
latency numbers moved within normal noise for this host (not gated, not a
baseline change). No `baseline.json` edit needed.

### L10 · `fixed` · `.gltf`/`.usda` external resource URIs could escape the asset directory and read arbitrary host files, byte-exact

Measured: `loadScene` resolved `buffers[].uri` / `images[].uri` (glTF) and
USD external asset paths against the file's own directory with no
containment check; `../` and absolute paths both escaped it, and the target
file's bytes were read into the document and recoverable through the
accessor array — demonstrated live through `glbforge inspect --json`'s
bounding-box numbers on a crafted `.gltf`. Fixed in
`packages/core/src/inspect/load.ts`: resolved paths outside the asset's own
directory are now treated the same as a missing file (existing
`BUFFER_UNRESOLVED` / unresolved-texture path), for both the glTF and USD
loaders. Regression test: `packages/core/test/path-traversal.test.ts`,
confirmed red without the fix.

### L11 · `fixed` · `site/llms.txt` said "27-tool MCP server" in its own summary line while its own tool table said 28

Measured: line 12 of `site/llms.txt` had not been updated when a 28th tool
(likely `animate`) landed, even though line 122 of the same file already
said 28 — an internal inconsistency, not just drift against the server.
Fixed: line 12 now says 28.
