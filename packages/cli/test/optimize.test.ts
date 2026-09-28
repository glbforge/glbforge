/**
 * `glbforge optimize` on the built CLI: compress defaults on
 * (EXT_meshopt_compression), and <model-viewer> / plain three.js don't
 * decode that without extra wiring — the report must say so, and must not
 * when --no-compress opts out.
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
const ring = join(root, 'assets', 'sample-ring.glb');
const ready = existsSync(cli) && existsSync(ring);

describe.skipIf(!ready)('glbforge optimize (built CLI)', () => {
  it('flags the meshopt decoder requirement when compression is on, and only then', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'glbforge-optimize-'));
    const input = join(dir, 'sample-ring.glb');
    copyFileSync(ring, input);

    const compressed = JSON.parse((await run('node', [cli, 'optimize', input, '--json'])).stdout);
    expect(compressed.hint).toMatch(/meshopt/i);
    expect(compressed.hint).toMatch(/model-viewer/i);

    const uncompressed = JSON.parse((await run('node', [cli, 'optimize', input, '--no-compress', '--json'])).stdout);
    expect(uncompressed.hint).toBeUndefined();
  }, 60_000);
});
