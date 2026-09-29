# Pass — 2026-09-29 — 289eacd
**Role:** saboteur

## Step 0 — claim check, and why the role isn't what `pnpm ledger` printed

`list_pull_requests` showed 29 open PRs, 27 of them `agent-loop/`-prefixed.
None covers CLI error-message handling; nothing claimed here.

`pnpm ledger` on `main` printed **rival** as least-recently-used — main's
`ledger.md` has never merged a rival pass, so by that count it shows 0. But
17 of the 27 open `agent-loop/` PRs are already rival passes (`#38`–`#69`,
including one, `#62`, titled "no new finding rises to the bar under a
saturated backlog"). The ledger's rotation is built only from *merged*
pass files, so it is structurally blind to a backlog this deep: every
role except `rival` has landed 1–2 open passes since `2026-09-27`, `rival`
has landed 17 since `2026-09-24`, and `auditor` (`main`'s actual oldest,
`2026-09-23`) has zero open passes competing with it. Counting the true
picture (merged + open, by recency), the least-recently-touched role is
**saboteur** — one merged pass (`2026-09-23`, path traversal) and one open,
still-unmerged pass (`#37`, `2026-09-24`, the NaN-vertex envelope crash).
Took that instead of adding an 18th open rival PR to a queue whose own
newest member already said the well ran dry. This is exactly the situation
`#37`'s own pass file (`2026-09-24-nan-vertex-envelope-crash.md`) hit and
resolved the same way — worth the maintainer's attention: the rotation is
sound only as fast as PRs get merged, and at this backlog depth it isn't.

**One more thing for the maintainer, not a ledger finding**: `#37` claims
finding id `L12` for the NaN-vertex crash; `main`'s `ledger.md` already has
`L12` assigned (merged, unrelated — the Forge section copy fix). When `#37`
merges as-is, `scripts/ledger.mjs`'s last-writer-wins fold will silently
retitle `L12` to whichever pass sorts later by date, discarding the other's
identity with no error and no merge conflict to force a look. `#37` needs
its finding renumbered to the next free id before or at merge, not after.

## Ground truth

`pnpm install && pnpm -r build`: clean, six packages. `pnpm -r test`:
177/180 core (3 skipped, LFS), 46/46 mcp, 5/10 cli (5 skipped, LFS), 2/2
studio — all green before any change. `pnpm probe -- --no-live`: 28 tools,
no baseline regressions, latency in the normal range for this host.

## Saboteur work

Attacked the GLB/USD parsers with malformed and degenerate inputs: a
truncated `.usdc` (magic + version bytes only, nothing else — `readUsdc`'s
`u64(16)` reads 8 bytes past a file that's 11 bytes long), garbage 4-byte
and random-4-byte files claiming a `.glb` extension, and a zero-vertex
mesh (`POSITION` accessor with a 0-length array, `TRIANGLES` mode, no
indices) — gltf-transform's own `NodeIO.writeBinary` accepts it (0-byte
binary chunk) but its own `NodeIO.readBinary` throws reading it back:
`Cannot read properties of undefined (reading 'buffer')`, a raw,
unattributed TypeError with no filename and no hint it's a parse failure.

The truncated `.usdc` and both garbage-GLB cases were **not findings**:
`loadScene` (`core/src/inspect/load.ts`) already wraps every USD/glTF read
in a try/catch that reframes the error as `"<file> could not be parsed as
<format>: <reason>"`, and the MCP layer's `withContext` (`mcp/src/
envelope.ts`) catches everything a handler throws and always emits a
schema-conformant `{ok:false, ..., data:{}}` envelope — confirmed directly
against `inspect` and `analyze_glb` over MCP: both returned parseable JSON
with `FILE_UNREADABLE` and a `suggested_fix`, not an SDK-level crash. This
is the same envelope contract `#37`'s pass hardened; it held here.

**The CLI itself was a different story.** `glbforge analyze`, `optimize`,
`stl`, `usdz`, `animate`, `verify`, `align`, and `dataset` all called
`io.readBinary()` directly with no try/catch, relying entirely on the
top-level `program.parseAsync().catch((err) => console.error(err.message))`
in `packages/cli/src/index.ts` — which prints exactly `err.message` and
nothing else. On the zero-vertex GLB, every one of those eight commands
printed the bare `Cannot read properties of undefined (reading 'buffer')`
— no filename, no "this was a parse failure," indistinguishable from a
dozen other things that could go wrong. `inspect` and `diff`, which go
through `loadScene`, already had the better message
(`zero-vertex.glb could not be parsed as glb: Cannot read properties of
undefined (reading 'buffer')`) for the exact same failure; the other eight
commands just never got it. For an agent scripting this CLI and branching
on stderr, or a human reading a CI log, the difference is "which file, and
why" versus nothing to go on.

**Fixed**: added `readGlb(io, bytes, path)` in `packages/cli/src/index.ts`
— wraps `io.readBinary` and reframes any thrown error with the same
`"<file> could not be parsed as glb: <reason>"` format `loadScene` uses —
and routed all 12 direct `io.readBinary` call sites in that file through
it (`analyze`, `optimize`'s `optimizeFile` incl. its own re-analyze and LOD
reads, `verify`, `align`, `dataset`'s per-file loop, `stl`, `usdz`,
`animate`). `packages/cli/src/ui-server.ts` (the `glbforge ui` local HTTP
server) has five more direct calls with a different, HTTP-response error
path — left untouched, out of scope for this pass, not re-diagnosed.
`core/src/audit.ts`'s `auditDirectory` (shared by `glbforge watch` and the
MCP `audit_directory` tool) already wraps its per-file read in try/catch
and records `{path, error}` per row — the filename is already alongside
the error there, so not a finding.

Regression test: `packages/cli/test/read-errors.test.ts`, six cases (the
five single-file commands above plus `verify`'s two-file read) against a
built zero-vertex-mesh fixture, asserting stderr contains `"<file> could
not be parsed as glb:"`. Confirmed all six fail against the unfixed code
(`git stash` on just `index.ts`, reran: all six show the bare
`Cannot read properties of undefined (reading 'buffer')` instead) and pass
restored.

## Verify

`pnpm -r build && pnpm -r test`: 177/180 core, 46/46 mcp, 11/16 cli (+6,
5 still skipped LFS), 2/2 studio — all green. `pnpm probe -- --no-live`:
same 28 tools, no regressions, no schema violations, latency within this
host's normal noise. `pnpm docs:check`: in sync (28 MCP tools, 21 CLI
verbs, packages 0.8.0) — no CLI verb count changed, only error-path
wording inside existing commands, so nothing to sync. No `baseline.json`
change.

### L15 · `fixed` · eight CLI commands leaked a raw, fileless `TypeError` on a malformed `.glb` instead of naming the file and the stage

Measured: `packages/cli/src/index.ts`'s `analyze`, `optimize`, `verify`,
`align`, `dataset`, `stl`, `usdz`, and `animate` commands all called
`io.readBinary()` on user-supplied bytes with no try/catch, so any parse
failure propagated to the single top-level
`program.parseAsync().catch((err) => console.error(err.message))`, which
prints only `err.message` — on a zero-vertex-mesh GLB (a `POSITION`
accessor of length 0, `TRIANGLES` mode, no indices — a valid write by
gltf-transform's own `NodeIO.writeBinary`, since it's a legal if
degenerate document, but one its own `NodeIO.readBinary` can't read back),
every one of those eight commands printed the bare
`Cannot read properties of undefined (reading 'buffer')`: no filename, no
indication it was a parse failure, indistinguishable from any other
crash. `inspect`/`diff`, which read through `loadScene`
(`core/src/inspect/load.ts`), already reframed the identical failure as
`"<file> could not be parsed as glb: <reason>"`; the other eight commands
never got that framing, and the MCP surface was unaffected (`withContext`
in `mcp/src/envelope.ts` catches every thrown error and always emits a
schema-conformant `{ok:false}` envelope, confirmed directly against
`inspect` and `analyze_glb`). Fixed by adding a shared `readGlb(io, bytes,
path)` helper in `packages/cli/src/index.ts` that wraps `io.readBinary`
with the same `loadScene` framing, and routing all 12 direct
`io.readBinary` call sites in that file through it. Left open, not
touched: `packages/cli/src/ui-server.ts`'s five reads (the local `glbforge
ui` HTTP server, a different response path) and `core/src/audit.ts`'s
`auditDirectory` (already carries the filename in its per-row `error`
field, so lower priority). Regression test:
`packages/cli/test/read-errors.test.ts`, six cases against a built
zero-vertex fixture — confirmed all six fail against the unfixed code and
pass restored.
