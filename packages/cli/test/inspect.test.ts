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

  it('--expect turns the run into a contract: violations exit 1, a met expectation exits 0', async () => {
    const bad = await inspect(hero, '--json', '--expect', 'chair, watertight, 0.4-1.2m tall');
    expect(bad.code).toBe(1);
    const r = JSON.parse(bad.stdout);
    expect(r.packs).toContain('intent@1');
    expect(r.findings.filter((f: { rule: string }) => f.rule.startsWith('intent/')).map((f: { rule: string }) => f.rule)).toEqual(['intent/watertight', 'intent/size']);
    const ok = await inspect(hero, '--json', '--expect', 'character, 1.5-2.5m tall, front -Z');
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout).orientation).toMatchObject({ front: '-Z', front_source: 'declared' });
  }, 30_000);

  it('diff: raw Hunyuan vs optimized, JSON shape and exit code', async () => {
    const raw = join(root, 'examples', 'plush-hunyuan.glb'), web = join(root, 'examples', 'plush-hunyuan.web.glb');
    if (!existsSync(raw) || !existsSync(web)) return;
    const run1 = await run('node', [cli, 'diff', raw, web, '--json']).catch((e: { stdout: string; code: number }) => e);
    const r = JSON.parse(run1.stdout);
    expect(r.pack).toBe('diff@1');
    expect(r.changed).toBe(true);
    expect(r.scene.triangles.before).toBe(232616);
    expect(r.findings.map((f: { rule: string }) => f.rule)).toContain('diff/triangles-changed');
    expect(r.summary).toMatch(/^Triangles 232,616 → /);
    expect(r.duration_ms).toBeLessThan(1500);
    const same = await run('node', [cli, 'diff', raw, raw]);
    expect(same.stdout).toMatch(/No change\./);
  }, 30_000);

  it('prints the summary first in human mode and lists skipped rules with --no-topology', async () => {
    const { stdout } = await inspect(hero, '--no-topology');
    expect(stdout).toMatch(/1 mesh, 150,000 triangles/);
    expect(stdout).toMatch(/Topology not checked/);
    expect(stdout).toMatch(/Skipped: topo\/open-edges/);
    expect(stdout).toMatch(/Front: unknown/);
  }, 20_000);
});
