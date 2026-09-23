/**
 * `glbforge scaffold` end to end: the emitted Vite + R3F project must
 * actually build with its own declared `build` script, not just read
 * cleanly. `vite build` alone does not type-check; `tsc -b` (which the
 * scaffolded package.json runs first) does, and a loader class imported
 * from the wrong package can type-check under one and fail the other.
 */
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cli = join(root, 'packages', 'cli', 'dist', 'index.js');
const glb = join(root, 'assets', 'sample-ring.glb');
const ready = existsSync(cli) && existsSync(glb);

// See the note on --ignore-scripts below: this test's own process is a pnpm
// child, which makes a nested `pnpm install` hard-error on an unapproved
// build script (esbuild's) rather than warn like a top-level install does.
// Irrelevant to what these tests check, so always skipped.
const install = (dir: string) => run('pnpm', ['install', '--ignore-scripts'], { cwd: dir });

describe.skipIf(!ready)('glbforge scaffold (built CLI)', () => {
  it('the emitted viewer installs and builds with its own `build` script', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'glbforge-scaffold-'));
    const { stdout } = await run('node', [cli, 'scaffold', glb, '-o', dir]);
    expect(stdout).toContain('--ignore-workspace');

    expect(existsSync(join(dir, 'package.json'))).toBe(true);
    expect(existsSync(join(dir, 'public', 'model.glb'))).toBe(true);

    await install(dir);
    // Runs `tsc -b && vite build`, exactly as a user following the CLI's
    // own printed instructions would; a non-zero exit throws here.
    await run('pnpm', ['run', 'build'], { cwd: dir });
    expect(existsSync(join(dir, 'dist', 'index.html'))).toBe(true);
  }, 180_000);

  it('installs its own dependencies when scaffolded inside a host pnpm workspace', async () => {
    // Reproduces scaffolding into a subdirectory of an *existing* pnpm
    // workspace (e.g. this repo's own examples/): a plain `pnpm install`
    // there resolves to the outer workspace root and silently does
    // nothing for the viewer's own package.json — exit 0, no error, no
    // node_modules. `--ignore-workspace` is what makes it install for
    // real, which is why the CLI must print it.
    const outer = mkdtempSync(join(tmpdir(), 'glbforge-host-workspace-'));
    writeFileSync(join(outer, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    writeFileSync(join(outer, 'package.json'), JSON.stringify({ name: 'host', private: true }));
    const nestedDir = join(outer, 'nested', 'viewer');
    mkdirSync(join(outer, 'nested'), { recursive: true });
    await run('node', [cli, 'scaffold', glb, '-o', nestedDir]);

    // Without --ignore-workspace, `pnpm install` silently resolves to the
    // outer workspace root: exit 0, "Done", and none of the viewer's own
    // dependencies land in its node_modules. This is the defect the CLI's
    // instructions (asserted above) exist to route around; it's what the
    // other test's real build would hit first if scaffolded here instead
    // of a bare tmp dir.
    await install(nestedDir);
    expect(existsSync(join(nestedDir, 'node_modules', 'react'))).toBe(false);
  }, 180_000);
});
