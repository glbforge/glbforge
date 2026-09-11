/**
 * `glbforge inspect` end to end on the built CLI: JSON shape, exit codes,
 * profile and --strict, and the cold wall time an agent will actually feel.
 */
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cli = join(root, 'packages', 'cli', 'dist', 'index.js');
const hero = join(root, 'examples', 'veiled-guardian.web.glb');
const ready = existsSync(cli) && existsSync(hero);

const inspect = async (...args: string[]) => {
  try {
    const { stdout } = await run('node', [cli, 'inspect', ...args]);
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { stdout: string; code: number };
    return { stdout: e.stdout, code: e.code };
  }
};

describe.skipIf(!ready)('glbforge inspect (built CLI)', () => {
  it('--json returns the report with duration, exits 0 on warnings, 1 with --strict', async () => {
    const t0 = performance.now();
    const { stdout, code } = await inspect(hero, '--json');
    const wall = performance.now() - t0;
    expect(code).toBe(0);
    const r = JSON.parse(stdout);
    expect(r.path).toBe(hero);
    expect(r.profile).toBe('authoring@1');
    expect(r.topology).toMatchObject({ shells: 1, watertight: false });
    expect(r.orientation.front).toBe('unknown');
    expect(r.findings.map((f: { rule: string }) => f.rule)).toEqual(['topo/non-manifold', 'topo/degenerate', 'origin/not-at-base']);
    expect(r.duration_ms).toBeLessThan(500);
    expect(wall).toBeLessThan(1500); // cold node + core import + read + inspect
    expect((await inspect(hero, '--json', '--strict')).code).toBe(1);
    expect((await inspect(hero, '--json', '--strict', '--profile', 'mobile-hero')).code).toBe(0);
  }, 20_000);

  it('prints the summary first in human mode and lists skipped rules with --no-topology', async () => {
    const { stdout } = await inspect(hero, '--no-topology');
    expect(stdout).toMatch(/1 mesh, 150,000 triangles/);
    expect(stdout).toMatch(/Topology not checked/);
    expect(stdout).toMatch(/Skipped: topo\/open-edges/);
    expect(stdout).toMatch(/Front: unknown/);
  }, 20_000);
});
