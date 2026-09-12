/**
 * `glbforge ship` end to end on the built CLI: the machine contract
 * (`--json` is one document carrying the decision ship made, not just the
 * optimization), and the pipe contract (a closed stdout must not crash, and
 * must not turn a failing exit code into a passing one).
 */
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cli = join(root, 'packages', 'cli', 'dist', 'index.js');
/** A gradient star: the artwork shape that must NOT be sliced into layers. */
const badge = join(root, 'assets', 'ci-badge.png');
/** Everything here is committed, so nothing in this file self-skips on CI. */
const ready = existsSync(cli) && existsSync(badge);

describe.skipIf(!ready)('glbforge ship (built CLI)', () => {
  it('--json is a single document: the route, the forge decision, and the optimization', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'glbforge-ship-'));
    const input = join(dir, 'ci-badge.png');
    copyFileSync(badge, input);

    const { stdout } = await run('node', [cli, 'ship', input, '--json']);
    const r = JSON.parse(stdout); // throws if anything else reached stdout

    expect(r.routed).toBe('forge');
    expect(r.input).toBe(input);
    expect(r.outPath).toBe(join(dir, 'ci-badge.web.glb'));
    expect(r.passed).toBe(true);

    // The half an agent cannot recover from the optimize report: what the
    // forge decided to make of the artwork, and why.
    expect(r.forge.path).toBe(join(dir, 'ci-badge.forge.glb'));
    expect(r.forge.layers).toBe(1);
    expect(r.forge.flatness.layers).toBe(0);
    expect(r.forge.flatness.coverage).toBeLessThan(0.85);
    expect(r.forge.triangles).toBeLessThan(20_000);

    expect(r.optimize.after.passed).toBe(true);
    expect(r.optimize.perceptual.ssimMin).toBeGreaterThan(0.94);
    expect(existsSync(r.forge.path)).toBe(true);
    expect(existsSync(r.outPath)).toBe(true);
    // `<input>.glb` is a name the user may have authored; ship never writes it.
    expect(existsSync(join(dir, 'ci-badge.glb'))).toBe(false);
  }, 60_000);

  it('a closed stdout neither crashes nor launders a failing exit code', async () => {
    // assets/, not examples/: examples/*.glb is gitignored, so a test anchored
    // there would quietly skip itself on CI — which is where this matters.
    const glb = join(root, 'assets', 'sample-ring.glb');
    // A pipeline's status is `head`'s, so ask bash for the CLI's own.
    const piped = async (args: string[]) => {
      try {
        const { stderr } = await run('bash', ['-c', `node ${cli} ${args.join(' ')} | head -1 > /dev/null; exit \${PIPESTATUS[0]}`]);
        return { code: 0, stderr };
      } catch (err) {
        const e = err as { code: number; stderr: string };
        return { code: e.code, stderr: e.stderr };
      }
    };

    // An expectation violation exits 1; `| head -1` must not make that a 0.
    const failing = await piped(['inspect', glb, '-e', '"chair, 2-3m tall, watertight"']);
    expect(failing.code).toBe(1);
    expect(failing.stderr).not.toMatch(/EPIPE|Unhandled/);

    const passing = await piped(['inspect', glb]);
    expect(passing.code).toBe(0);
    expect(passing.stderr).not.toMatch(/EPIPE|Unhandled/);
  }, 30_000);
});
