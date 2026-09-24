# Pass — 2026-09-23 — b59f0d2

**Role:** integrator

Skipped **rival**, the least-recently-used role per `pnpm ledger`: PR #28
(`agent-loop/2026-09-23-rival-optimizer-comparison`) is already open under
that role today, so it's claimed — see the skill's rule not to duplicate
claimed work. Took **integrator** next, per the rotation order in
`scripts/ledger.mjs`.

Ground truth first: `pnpm install && pnpm -r build` and `pnpm -r test` were
clean before touching anything (21 core files, 174/3 skipped; mcp 44; studio
2; cli 5/5 skipped — `ready` gates on committed fixtures, all present).
`pnpm probe -- --no-live` showed no regressions against baseline; the only
flagged item is the known L4 (`site/llms.txt` 0.9.0 vs packages 0.8.0),
already `wontfix`'d as the maintainer's release call — left alone.

For the integrator pass itself I wired `glbforge scaffold` into something
real: ran it on `assets/sample-ring.glb`, then followed the CLI's own
printed next step (`cd viewer && pnpm install && pnpm dev`) to completion —
not just reading the emitted source, which is as far as three earlier
auditor passes (pass4, pass5, pass6) went on this exact command.

### L12 · `fixed` · `glbforge scaffold`'s emitted viewer fails its own `build` script on a type error

`pnpm install && pnpm run build` in the scaffolded project (`tsc -b && vite
build`, exactly what `package.json` declares and what `pnpm dev`'s sibling
script implies works) failed:

```
src/App.tsx(23,26): error TS2345: Argument of type 'import(".../@types/three/examples/jsm/loaders/KTX2Loader").KTX2Loader' is not assignable to parameter of type 'import(".../three-stdlib/loaders/KTX2Loader").KTX2Loader'.
  The types returned by 'load(...)' are incompatible between these types.
    Type 'void' is not assignable to type 'CompressedTexture'.
```

Cause: the scaffold (`packages/cli/src/scaffold.ts`) imports `KTX2Loader`
from `three/examples/jsm/loaders/KTX2Loader.js` (typed by `@types/three`),
but drei's `useGLTF` loads through **three-stdlib**'s `GLTFLoader`, whose
`setKTX2Loader()` takes *three-stdlib's own* `KTX2Loader` class. The two are
runtime-identical (three-stdlib's is a thin wrapper) but nominally
different types, so `vite build` alone (no type-checking) hid it — this is
exactly why `pnpm dev`/reading the source looked clean to prior passes, and
why an agent that only skims the emitted file, the way the tool's own
scaffold flow encourages, would ship a project that fails its own committed
`build` script the first time CI (or the agent itself) runs it.

Fixed by importing `KTX2Loader` from `three-stdlib` instead, and adding it
to the scaffolded `package.json`'s `dependencies` (it was already a
transitive dependency of drei/fiber, but not hoisted under pnpm's default
node_modules layout — importing it unlisted would have been a phantom
dependency, worked here only by accident of hoisting). Verified past the
type-check: `pnpm run build` now succeeds, and `pnpm exec vite preview` +
a headless Chromium load renders the ring model correctly with no console
errors (screenshot taken, not committed — the fixture speaks for itself).

Added `packages/cli/test/scaffold.test.ts`: builds the CLI's own scaffold
output for `assets/sample-ring.glb`, runs `pnpm install --ignore-scripts`
and `pnpm run build` on it, and asserts the build succeeds. Confirmed it
fails on `main` (pre-fix) and passes after. `--ignore-scripts` is there
because this test's own process is itself a pnpm child (`pnpm test` →
`vitest` → this test's `pnpm install`), and pnpm treats an unapproved build
script (esbuild's, unrelated to the fix) as a hard error only when nested
like that — a plain top-level `pnpm install` just warns. Skipping install
scripts doesn't affect whether `tsc -b`/`vite build` succeed, which is what
this test checks; it does mean the KTX2 transcoder's `public/basis` copy
step doesn't run, but that's the postinstall script's job at asset-serving
time, not the build's.

### L13 · `fixed` · `glbforge scaffold`'s printed next step silently loses the viewer's dependencies inside a host pnpm workspace

Chasing L12 down turned up a second, worse defect in the same command. The
scaffolded viewer is deliberately not a workspace member (comment at the
top of `scaffold.ts`), and `README.md`'s own usage example already knows
this — it runs `pnpm install --ignore-workspace` after `scaffold`. But the
CLI's own runtime-printed instructions (`packages/cli/src/index.ts`, the
`scaffold` command's `console.log`) said just `pnpm install && pnpm dev`,
dropping the flag the README carries.

That matters because `examples/` already exists in this repo, and
scaffolding into any directory that sits inside an *existing* pnpm
workspace — this repo's own tree very much included — makes a flagless
`pnpm install` silently resolve to the **outer** workspace root instead of
the viewer's own `package.json`. Reproduced directly: scaffolded into
`examples/viewer-probe/` (this repo), ran `pnpm install` exactly as printed:

```
Scope: all 6 workspace projects
✓ Lockfile at ../../pnpm-lock.yaml passes supply-chain policies (verified 13m ago)
Done in 90ms using pnpm v12.4.1
```

Exit 0, no error, and no `node_modules` at all for the viewer — none of
react/three/vite installed. The next step an agent would take,
`pnpm dev`/`pnpm run build`, then fails with a wall of `Cannot find module
'react'` (and 'three-stdlib', '@react-three/fiber', …) that has nothing to
do with the actual cause: the *previous* command silently did nothing, and
nothing said so. This is worse than L12's build-time type error — it's a
success message on the step that failed.

This also means the three prior auditor passes that logged walking
`scaffold` "end to end" (pass4, pass5, pass6) did not do it from inside
this checkout, or they'd have hit this; pass4's own note ("built a minimal
synthetic GLB... ran scaffold on it") doesn't say where, but a location
outside any pnpm workspace would explain why it read clean.

Fixed by adding `--ignore-workspace` to the printed instructions, matching
what `README.md` already does. Verified by reverting just this line and
re-running the new regression test below (fails on `stdout` not containing
the flag), then restoring it (passes). Also manually reproduced the silent
no-op in `examples/viewer-probe/` (not committed — deleted after) both
before and after, confirming the flag is what makes the difference for a
real top-level invocation.

`packages/cli/test/scaffold.test.ts` now has two cases: the L12 regression
(builds the scaffolded viewer for real, `pnpm install --ignore-scripts` +
`pnpm run build`, and asserts the printed instructions contain
`--ignore-workspace`), and a second case that builds a synthetic host
workspace (`pnpm-workspace.yaml` + root `package.json` in a tmp dir),
scaffolds into a subdirectory of it, and asserts a flagless install leaves
`node_modules/react` missing — the failure mode itself, kept as a permanent
regression guard independent of whether `--ignore-workspace` remains the
right flag in some future pnpm version.

I deliberately did *not* extend that second case to also assert
`--ignore-workspace` successfully installs: doing so through this
sandbox's own nested `pnpm test` → `vitest` → `pnpm install` chain hit a
third-order artifact — the nested call resolved a different pnpm binary
(corepack-pinned 12.4.1) than a fresh top-level shell command does
(a locally installed 10.33.0), and only the former left `--ignore-workspace`
not actually installing anything even though it printed success. Manually,
outside that nested chain, `--ignore-workspace` installed correctly every
time I tried it. That discrepancy is about which `pnpm` binary this
sandbox's test-runner chain resolves, not about GLBForge's own code, so I
left it out of the committed test rather than assert something that would
be sandbox-version-dependent rather than product-dependent. Noting it here
in case a future pass's `pnpm install` or `pnpm approve-builds` behaves
unexpectedly inside a `pnpm test` run and wonders whether it's new.
