/**
 * `glbforge extrude --json` on the built CLI: the machine contract must stay
 * a summary. `stats.matte` carries `Matte.alpha` internally (matte.ts) — the
 * synthesized per-pixel alpha channel used to composite the source image —
 * and that is not reporting data. Leaving it in turns one JSON document into
 * one entry per pixel (262,144 for a 512x512 image, megabytes on stdout).
 */
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cli = join(root, 'packages', 'cli', 'dist', 'index.js');
const ready = existsSync(cli);

/** An opaque disc on a plain ground: no alpha of its own, so `--matte auto` engages. */
async function opaqueSubjectPng(path: string, size = 96): Promise<void> {
  const bg: [number, number, number] = [236, 238, 240];
  const fg: [number, number, number] = [40, 70, 190];
  const px = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = Math.hypot(x - size / 2, y - size / 2) < size * 0.3;
      const [r, g, b] = inside ? fg : bg;
      const i = (y * size + x) * 3;
      px[i] = r; px[i + 1] = g; px[i + 2] = b;
    }
  }
  await sharp(px, { raw: { width: size, height: size, channels: 3 } }).png().toFile(path);
}

describe.skipIf(!ready)('glbforge extrude (built CLI)', () => {
  it('--json --matte auto reports the mask, not the per-pixel alpha channel behind it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'glbforge-extrude-'));
    const input = join(dir, 'subject.png');
    await opaqueSubjectPng(input);

    const { stdout } = await run('node', [cli, 'extrude', input, '--matte', 'auto', '--json']);
    // A pixel-per-key dump would put this well past 100KB for a 96x96 source.
    expect(stdout.length).toBeLessThan(2000);

    const r = JSON.parse(stdout);
    expect(r.mode).toBe('matte');
    expect(r.matte.confidence).toBeGreaterThan(0.9);
    expect(r.matte.alpha).toBeUndefined();
    expect(existsSync(r.outPath)).toBe(true);
  }, 30_000);
});
