import { describe, it, expect } from 'vitest';
import { canonicalByPosition } from '../src/normals.js';

/**
 * A grid whose positions repeat in a narrow magnitude range — quantized
 * integer multiples, the shape a KHR_mesh_quantization-decoded or
 * hand-authored asset produces. `canonicalByPosition`'s hash masked its
 * low bits straight into a bucket index with no finalizer: fine for
 * scattered organic float32 data, but this structured case clustered
 * ~150-300 lookups per bucket (measured directly) instead of the ~1-2
 * expected at this table's 0.5 load factor. Reproduces the shape
 * synthetically so the regression doesn't depend on a fixture.
 */
function makeQuantizedGrid(gridSize: number): Float32Array {
  const n = gridSize * gridSize;
  const pos = new Float32Array(n * 3);
  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      const i = y * gridSize + x;
      pos[i * 3] = (x - gridSize / 2) * 137;
      pos[i * 3 + 1] = (y - gridSize / 2) * 211;
      pos[i * 3 + 2] = (x % 4) * 53; // a handful of repeated Z bands
    }
  }
  return pos;
}

describe('canonicalByPosition stays exact under heavy hash-bucket collisions', () => {
  it('welds nothing on a quantized grid where every (x, y) position is unique', () => {
    // posX depends only on x, posY only on y, both strictly monotonic, so
    // every vertex has a distinct position by construction. A hash that
    // reports a false match under collision would collapse some of these;
    // an infinite/runaway probe loop would time out the test runner.
    const gridSize = 220; // 48,400 vertices — well above the size that showed the regression
    const pos = makeQuantizedGrid(gridSize);
    const vertexCount = gridSize * gridSize;
    const canonical = canonicalByPosition(pos, vertexCount);
    const uniqueCount = new Set(canonical).size;
    expect(uniqueCount).toBe(vertexCount);
    for (let i = 0; i < vertexCount; i++) expect(canonical[i]).toBe(i);
  });

  it('still finds real duplicates on the same quantized grid, doubled', () => {
    const gridSize = 110;
    const base = makeQuantizedGrid(gridSize);
    const vertexCount = gridSize * gridSize;
    // Two exact copies back-to-back: the second half must weld onto the first.
    const doubled = new Float32Array(vertexCount * 2 * 3);
    doubled.set(base, 0);
    doubled.set(base, base.length);
    const canonical = canonicalByPosition(doubled, vertexCount * 2);
    for (let i = 0; i < vertexCount; i++) {
      expect(canonical[i]).toBe(i);
      expect(canonical[vertexCount + i]).toBe(i);
    }
  });
});
