import { describe, it, expect } from 'vitest';
import { validateBytes } from 'gltf-validator';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeIO, extrudeFromRgba, getProfile, optimize } from '../src/index.js';
import { makeRiggedCylinder } from './fixtures.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The official Khronos glTF-validator (the reference implementation the
 * ecosystem checks itself against) as an oracle on real GLBForge output.
 * `analyze`/`inspect` grade a file against our own rule packs; this grades
 * it against the spec itself, on paths those packs never run — the exact
 * bytes an agent ships. No repo-checked-in fixture has ever exercised this.
 */
async function issues(bytes: Uint8Array) {
  const report = await validateBytes(bytes);
  return {
    errors: report.issues.messages.filter((m) => m.severity === 0),
    warnings: report.issues.messages.filter((m) => m.severity === 1),
  };
}

/** Transparent canvas with an opaque disc, mimicking real forge artwork. */
function disc(size = 256): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const r = size * 0.35;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - size / 2, y - size / 2);
      if (d < r) {
        const i = (y * size + x) * 4;
        px[i] = 200; px[i + 1] = 60; px[i + 2] = 60; px[i + 3] = 255;
      }
    }
  }
  return px;
}

describe('gltf-validator oracle', () => {
  it('optimize() on a real checked-in asset is spec-clean', async () => {
    const io = await createNodeIO();
    const bytes = await readFile(resolve(root, 'assets', 'sample-ring.glb'));
    const doc = await io.readBinary(new Uint8Array(bytes));
    const profile = getProfile('mobile-hero');
    await optimize(doc, { profile, verify: false });
    const { errors, warnings } = await issues(await io.writeBinary(doc));
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('extrude_image (flat, beveled, and auto-layered) is spec-clean', async () => {
    const io = await createNodeIO();
    for (const opts of [{ texture: false }, { texture: false, bevel: 0.08 }, { texture: false, layers: 'auto' as const }]) {
      const { doc } = await extrudeFromRgba(disc(), 256, 256, opts);
      const { errors, warnings } = await issues(await io.writeBinary(doc));
      expect(errors, JSON.stringify(opts)).toEqual([]);
      expect(warnings, JSON.stringify(opts)).toEqual([]);
    }
  });

  it('optimize() on a skinned + morph-target mesh stays spec-clean', async () => {
    const io = await createNodeIO();
    const doc = makeRiggedCylinder();
    const profile = getProfile('mobile-hero');
    await optimize(doc, { profile, targetTriangles: 600, textures: false, compress: false, verify: false });
    const { errors, warnings } = await issues(await io.writeBinary(doc));
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
