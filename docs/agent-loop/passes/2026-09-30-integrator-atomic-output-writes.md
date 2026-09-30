# Pass — 2026-09-30 — 289eacd
**Role:** integrator

`pnpm ledger` on `main` (289eacd, 0 open / 14 closed / 14 passes) named **rival**
next. I did not take it, and want to write down why rather than silently
skip: `gh pr list --state open` currently shows **~25 open, unmerged
`agent-loop/*` PRs**, and **18 of them are already rival passes** (the newest,
#75, opened today) covering geometry (LOD, normals, Draco/meshopt, triangle
budgets on skinned meshes), textures (KTX2 SSIM, normal-map SSIM, basisu
format, PBR slots, transmission draw cost), export (USD reference reader, STL
watertightness, scaffold node names, extrude fidelity vs three.js) and
validation (the official glTF validator) — plus #62, a rival pass that
already found the backlog saturated for its own role. Every other role has at
most two open PRs. `pnpm ledger`'s rotation is computed from *merged* pass
files only (`scripts/ledger.mjs`, "least-recently-used ordering" over
`passes/`), so a role that has not been merged in reads as **never used**
even when it is, in wall-clock terms, the most recently and heavily used role
in the repository. Taking rival again would be an 19th unreviewed instance of
the most oversubscribed lens while integrator/performance/archaeologist sit
at two each and have had no *merged* attention at all. That is not "skipping
to an easier role" — rival is if anything the best-covered, hardest angle to
find fresh ground in — it is skipping a role the mechanical count cannot see
is already saturated. Per ROLES.md/SKILL.md's own escape hatch ("if the
least-recent role genuinely cannot run this pass... take the next one and
write down why"), I took the next role down in `scripts/ledger.mjs`'s fixed
tie-break order (`rival, integrator, performance, archaeologist`):
**integrator**. I did not review or comment on any of the open PRs' content —
that is a separate job from picking a role — only counted them by branch
prefix and title role tag.

Ground truth: `pnpm install && pnpm -r build` clean, `pnpm -r test` 177+46+2+5
passing (3+5 skipped, all LFS-gated as expected), `pnpm probe -- --no-live`
matched the committed baseline with no regressions.

**What I tested.** Integrator's brief is watching GLBForge break at a real
boundary: "the MCP server in a client that is not this one." The existing
suite only ever drives the server through the official
`@modelcontextprotocol/sdk` `Client`, either in-process (`InMemoryTransport`)
or over real stdio (`agent-probe.ts`), always one call at a time. A
multi-agent orchestrator — including the very tool this session itself uses
to fan work out to subagents — routinely fires several tool calls before
awaiting the first. I wrote a throwaway probe (`race-probe.local.mjs`, not
committed) that spawned the real built server over stdio and ran
`optimize_glb` on two different real assets (`site/models/plush.glb` 1.1MB
mobile-hero, `site/models/cat.glb` 3.2MB desktop-hero) concurrently against
the **same `out` path**, 12 iterations. Every `write*` call in
`packages/mcp/src` was a plain `fs.promises.writeFile(out, bytes)`: no lock,
no temp file, no rename — `outputs.ts`'s `prepareOut` only ever prepares the
*directory*.

Twelve iterations produced no visible corruption (the slower call always
finished and wrote last, so one call's complete output always won). But that
result was luck of timing, not a guarantee: `writeFile` on a multi-MB buffer
is not one atomic syscall, and a process killed between two of its internal
`write()`s — an orchestrator's per-call timeout, an OOM kill, a crashed
native dependency (`sharp`, `basisu`) — leaves whatever bytes had landed
sitting at the exact path a caller's `existsSync(out)` treats as "done."
That is a real boundary failure mode a black-box concurrency test cannot
force reliably from outside, so I fixed the actual weakness instead of just
recording the near-miss: `writeOutAtomic()` in `outputs.ts` now writes to a
sibling `.<random>.tmp` file and `rename()`s it over `out`; every production
`writeFile(out/outPath/lodPath/clip_file, ...)` call site in `server.ts` and
`agent-tools.ts` now goes through it. `rename(2)` on the same filesystem is
atomic — `out` is always either the previous complete file or the new one,
never a fragment of either, regardless of when the process dies.

`packages/mcp/test/outputs.test.ts` is the test that fails without the fix:
it mocks `rename` to reject once, mid-swap, over a file that already held a
complete "previous" output, and asserts `out` still holds exactly that
previous content with no `.tmp` file left behind. Reverted to a plain
`writeFile(out, bytes)`, the same assertion fails with "promise resolved
undefined instead of rejecting" — the write already happened, silently, and
the (in a real kill) truncated result would sit at `out` — confirmed by
temporarily reverting the fix and rerunning the test before restoring it.
The concurrency probe re-run against the fixed build shows no change in
outward behaviour (still 0/12 corrupted across 12 iterations) — the fix
targets the failure mode the timing-dependent test could not reliably force,
not the one it happened to already pass.

Left open: the CLI (`packages/cli/src/index.ts`) has the identical plain
`writeFile(out/outPath/generated/forged, ...)` pattern at every one of its
output sites and the same risk in principle, but it is a different call
shape (single foreground process, a human or script waiting on it, not an
orchestrator firing concurrent calls with a timeout) and widening this PR to
touch a second package on a supposition felt like scope creep for one pass —
flagging it here for whichever role picks it up next, most likely another
integrator or a saboteur going after process-kill timing directly.

**Probe, before vs. after** (`--no-live`, both against 289eacd):
surface 28 tools; advice 3/3 resolved, 0 dangling; vocab 33/130, 0
undeclared/undocumented/schema violations — identical both runs. Latency
within normal run-to-run noise on this host (optimize_glb p50 2462→2312ms,
p90 3967→3735ms); no baseline re-freeze needed.

### L15 · `watching` · MCP output writes were plain `writeFile`, so a process killed mid-write left a truncated file at the exact path a caller's existence check treats as complete

Fixed for `packages/mcp` in this pass: every mutating tool's final output
write now goes through `writeOutAtomic()` (write to a sibling temp file,
`rename()` over `out`), so an interrupted write can never leave partial
content at `out` — regression test in `packages/mcp/test/outputs.test.ts`.
Left as `watching`, not `fixed`, because the same pattern is still present
in `packages/cli/src/index.ts`'s dozen `writeFile(out, ...)` call sites and
I did not touch that package this pass — closing this fully means doing the
same swap there (or extracting the helper somewhere both packages can
import from) and would need its own before/after test.
