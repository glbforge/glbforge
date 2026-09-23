# Pass — 2026-09-22 — 56a5e59
**Role:** auditor

Step 0: `gh pr list` showed five open `agent-loop/*` branches plus `#10`
(`fix/honest-measurements`, infra `#9` stacks on, not a ledger finding).
`#11` bakes instanced draw calls and closes L2 — claimed, left alone. `#13`
(`pass3-ledger`) already walked `error-codes.md` thresholds,
`schemas/index.json`'s tool count, README/ROADMAP sync, and the MCP SDK
version against npm; `#14` (`claude-md-print-profile`) closed L8, the false
"print profile ships" claim in `CLAUDE.md`; `#15` (`pass4-nothing-to-fix`)
walked `llms.txt`'s Commands section against the CLI and ran `init --local`
and `scaffold` end to end. None of that is re-walked here. `#9` is this
loop's own bootstrap PR, still unmerged, so this pass branches from it per
the scheduler's fallback instructions, same as the three siblings above.

Ground truth: `pnpm install && pnpm -r build` clean. `pnpm -r test` green
(163 core + 3 skipped, 13 meshy, 44 mcp, 5 cli + 5 skipped — same counts as
today's other passes). `pnpm probe -- --no-live` matched
`docs/agent-loop/baseline.json` exactly (27 tools, 0.667 resolution rate,
33/128 codes, no schema violations, no regressions); only L2 and L4
surfaced, both already known and both untouchable this pass (claimed by
`#11` / a release decision for the maintainer).

Spent the rest of the pass on ground none of today's other three passes
walked:

- **MCP ecosystem conventions beyond the SDK version** (`#13` checked only
  that `@modelcontextprotocol/sdk` resolves to npm's current `latest`).
  Checked whether the server uses the spec surface that has moved since:
  tool annotations (`readOnlyHint`/`destructiveHint`/`idempotentHint`/
  `openWorldHint`) are set on every tool via `READ_ONLY`/`WRITES_FILES`/
  `NETWORK` constants in both `server.ts` and `agent-tools.ts`; every tool
  registered through `registerEnvelopeTool` carries a real `outputSchema`
  (`envelopeShape(ToolDataSchemas[name])`) and returns `structuredContent`,
  not just a JSON string — the SDK's native structured-output path, not a
  bespoke one. Prompts are registered (`registerPrompt`, four of them).
  Resources and elicitation are unused, but nothing in the tool surface
  reads as needing either (no interactive credential gathering, no
  static content an agent would list rather than call a tool for) — not
  filed as a finding on the strength of "unused feature."
- **`export_stl`'s claim** ("glbforge-extruded assets are watertight by
  construction") **against what backs it.** Traced to `extrude/build.ts`'s
  documented last-mile watertightness pass and the `topo/*` rules in
  `packs/intent.ts` / `inspect/topology.ts` that actually measure it, plus
  `diff-report.ts`'s `diff/watertight-lost` regression check. The claim is
  backed by real, tested machinery, not an assertion nothing checks.
- **Walked `align` and `dataset`** — the two of the three CLI commands
  `#15` found missing from `llms.txt`/`README.md` that it didn't itself
  execute (the third, `watch`, doesn't exit non-interactively and stays
  untested by design). Built a synthetic cube with `@gltf-transform/core`
  (no LFS fixture needed) and ran `glbforge align cube.glb cube.glb --json`:
  proportion 1, chamfer ~5.8e-18, both F-scores 1, byte-identical output
  across two runs. Ran `glbforge dataset` on a one-file directory: emitted
  `mesh.glb`, ten labelled camera views, and `cameras.json` with position/
  target/fov per view — exactly the (image, mesh, camera) triple the
  description promises. Both commands work as documented; no defect.

No new finding rose to the bar for a code or doc change. Ledger-only pass,
per the "finds nothing worth changing is a success" rule, so pass 6 does
not redo today's five rotations (draw-call/L4 status, error-codes/schemas/
SDK-version, llms.txt Commands/init/scaffold, CLAUDE.md claims, MCP
annotations/structuredContent/STL-watertightness/align/dataset).
