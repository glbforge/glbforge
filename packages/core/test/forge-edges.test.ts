import { describe, it, expect } from 'vitest';
import { extrudeFromRgba } from '../src/index.js';

/**
 * Inputs the forge has to survive rather than inputs it is shown off with.
 * Found by running the forge over a spread of synthetic artwork and reading
 * the numbers it came back with, not by reasoning about the code.
 */

/** Transparent canvas with an opaque vertical stroke `w` pixels wide. */
function stroke(w: number, size = 512): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  for (let y = 50; y < size - 50; y++) {
    for (let x = size / 2; x < size / 2 + w; x++) {
      const i = (y * size + x) * 4;
      px[i] = px[i + 1] = px[i + 2] = 20; px[i + 3] = 255;
    }
  }
  return px;
}

const triangles = async (px: Uint8Array, opts = {}) =>
  (await extrudeFromRgba(px, 512, 512, { texture: false, ...opts })).stats.triangles;

describe('the forge on artwork that fights back', () => {
  it('simplifies a stroke thinner than the tolerance instead of giving up on it', async () => {
    // A 1px stroke collapses under the default 1.2px tolerance: both halves of
    // the split loop reduce to their own endpoints, leaving fewer than three
    // points. The old code answered that by keeping the raw per-pixel contour,
    // so the thinnest mark in the artwork became by far the densest thing in
    // the mesh — 13,108 triangles here, against 12 for the same stroke 2px wide.
    const thin = await triangles(stroke(1));
    const thick = await triangles(stroke(2));
    expect(thick).toBe(12);
    expect(thin).toBe(thick);
  }, 30_000);

  it('holds that shape across tolerances, including ones wider than the stroke', async () => {
    for (const simplify of [0.5, 1.2, 3, 10]) {
      expect(await triangles(stroke(1), { simplify })).toBe(12);
    }
    // simplify: 0 is a request for the raw contour, and still honoured.
    expect(await triangles(stroke(1), { simplify: 0 })).toBeGreaterThan(1000);
  }, 30_000);
});
