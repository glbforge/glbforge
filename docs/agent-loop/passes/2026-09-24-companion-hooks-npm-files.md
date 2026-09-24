# Pass — 2026-09-24 — b59f0d2
**Role:** newcomer-to-new-code

## Step 0 — claim check

`gh pr list --state open --json number,title,headRefName` (via the GitHub MCP
tools, no `gh` CLI in this sandbox) showed six open `agent-loop/*` branches —
`#28` rival, `#29` integrator, `#30` performance, `#31` archaeologist, `#32`
newcomer — plus `#20`, an older, still-open `agent-loop/2026-09-23-companion-reply-id`
PR. That accounts for **every** role ahead of `newcomer-to-new-code` in
`pnpm ledger`'s rotation (rival → integrator → performance → archaeologist →
newcomer, in that order, all "never used" or least-recently-used and all
claimed by an open PR). `newcomer-to-new-code` is the least-recently-used
role with no open PR against it, so that's the one this pass took. `#33`
(`fix/skinned-rest-pose-bounds-and-render`, not an `agent-loop/*` branch) is
also open and left untouched.

None of the six open PRs' ground is re-walked here.

## What was measured

`pnpm install && pnpm -r build` clean (6 workspace packages). `pnpm -r test`
green: 174 core + 3 skipped, 44 mcp, 2 studio, 5 cli + 5 skipped — same
shape as the last recorded pass. `pnpm probe -- --no-live` matched
`docs/agent-loop/baseline.json` (28 tools, 3/3 advice actions resolved, 0
dangling, 33/130 codes, 0 schema violations, "No regressions vs baseline").
Only `L4` surfaced (open, a release decision — left alone). Baseline
untouched; the fix below doesn't touch the pipeline the probe measures.

## What shipped since the last newcomer-to-new-code pass

The last pass with this role (`2026-09-23-companion-reply-id`) reviewed
`companion/`'s original merge (`main.mjs`, `mcp.mjs`, `brain.mjs`). Since
then `main` gained **Claude Code hooks** (`7395497`, "Claude Code hooks give
every session on the machine a face", `#22`): `companion/hooks.mjs`,
`companion/hook.mjs`, and a `hooks install|remove|status` subcommand in
`bin.mjs` / `glbforge companion --hooks`. Nobody with this role had read it.

Read `companion/README.md`'s hooks section, `hooks.mjs`, `hook.mjs`,
`bin.mjs`'s hooks branch, and `packages/cli/src/companion-cmd.ts`'s
`--hooks` wiring end to end, cross-checking each claim against the code and
against real Claude Code hook behaviour (dispatched a `claude-code-guide`
fact-check on the five event names, the `notification_type` enum, the
`timeout` field's units, `SessionStart.source` / `SessionEnd.reason` values,
and whether the `args` exec form is honoured). All confirmed correct —
`StopFailure` is a real event, `timeout` is seconds not ms, the
`notification_type` values match, and `docs/agent-tasks/2026-09-22-badge-companion.md`
(T13) already verified live against Claude Code 2.1.126 that the shell
`command` form works and an `args` exec form is silently ignored on that
version, which is exactly why the installer writes the shell form. No
finding there.

### L12 · `fixed` · `@glbforge/companion`'s npm package never shipped `hook.mjs` / `hooks.mjs`

`companion/package.json`'s `"files"` array listed `bin.mjs`, `main.mjs`,
`brain.mjs`, `preload.cjs`, `mcp.mjs`, `renderer/`, `README.md` — everything
that existed *before* the hooks feature landed. The commit that added
`hook.mjs` and `hooks.mjs` (`1cf90b6`) never touched `package.json`.

Reproduced by packing the real tarball and running it exactly the way the
README's primary install path does:

```
cd companion && npm pack --pack-destination /tmp/x
cd /tmp/x && tar xzf *.tgz && cd package
node bin.mjs hooks install --project --cwd /tmp/x
# Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/x/package/hooks.mjs'
#   imported from /tmp/x/package/bin.mjs
```

`npx -y @glbforge/companion hooks install` — the command the README leads
with — throws for anyone not running from this monorepo checkout, i.e.
everyone except the one machine where it was built. Once installed (if it
worked), the installed hook entry runs `node <dir>/hook.mjs`, which is the
same missing file — so even a hand-copied `hooks.mjs` wouldn't have anything
to invoke. This is the exact "a wrong or missing promise to an agent" class
the loop prioritizes: the feature's own README instructions don't work
through its own documented install path.

**Fixed**: added `hook.mjs` and `hooks.mjs` to `companion/package.json`'s
`"files"`. Re-ran the same pack → extract → `hooks install` sequence:
`settings.json` gets the five hooks, `hook.mjs` resolves. Added
`companion/test/package-files.test.mjs` (`node --test`, companion's first
test — `node:test` needs no dependency, and Electron can't be fetched in
this sandbox's network allowlist anyway) that reads every `await
import('./*.mjs')` in `bin.mjs` and asserts each target is both present on
disk and listed in `package.json`'s `files`, so a future subcommand that
adds a new local module and forgets to list it fails this test instead of
shipping silently broken. Confirmed it actually catches the bug: stashed
just the `package.json` fix and reran — `AssertionError: hook.mjs: bin.mjs
imports it but package.json "files" does not list it` — then restored the
fix and it passes. Added a `"test": "node --test"` script to
`companion/package.json` to run it (`cd companion && pnpm test` — `node
--test` with no args auto-discovers `test/**/*.test.mjs`; `node --test
test/` with an explicit trailing-slash path did not work on this sandbox's
Node 22.22.2, worth knowing if a future pass adds another test runner
invocation here). `companion/` is a standalone package outside the root
pnpm workspace (`companion/pnpm-workspace.yaml`: `packages: ['.']`, kept
separate to keep Electron out of the monorepo lockfile per `CLAUDE.md`), so
this test does not run under root `pnpm -r test` and needs to be run from
`companion/` directly — noting this so it isn't mistaken for CI coverage it
doesn't have.

## Left open, and why

- **`L4`** (`open`, watching) — release decision for the maintainer, not
  re-touched.
- **`companion/`'s other open findings** (`T9`, `T10` in
  `docs/agent-tasks/2026-09-22-badge-companion.md`: envelope-shape
  convergence, an SDK `canUseTool` shadowing warning) — read, still stand,
  not this pass's to fix; neither is new ground.
- **`companion/` has no CI** — `pnpm test` at the root never touches it by
  design (own lockfile, own workspace). The new test only guards against
  this *specific* class of "forgot to ship a file" bug for `bin.mjs`'s
  direct imports; it wouldn't catch, say, a transitive import inside
  `hooks.mjs` reaching a file outside `files`. Worth a maintainer decision
  on whether `companion/`'s tests should run somewhere on a schedule, but
  that's a CI/infra call outside this pass's mandate.
