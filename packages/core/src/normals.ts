import type { Primitive } from '@gltf-transform/core';
import { readFloat } from './accessors.js';

/**
 * Area-weighted smooth vertex normals, accumulated per *position* so seam-
 * split vertices shade continuously (welded and unwelded inputs behave the
 * same). This is what web viewers produce for normal-less meshes, and what
 * the optimizer writes back — gltf-transform's normals() is flat per-face.
 */
export function computeSmoothNormals(prim: Primitive): Float32Array | null {
  const position = prim.getAttribute('POSITION');
  if (!position || prim.getMode() !== 4) return null;
  const pos = readFloat(position);
  const vertexCount = position.getCount();
  const idx = prim.getIndices()?.getArray() ?? null;
  const triCount = Math.floor((idx ? idx.length : vertexCount) / 3);

  const canonical = canonicalByPosition(pos, vertexCount);

  const acc = new Float32Array(vertexCount * 3);
  for (let t = 0; t < triCount; t++) {
    const a = idx ? idx[t * 3] : t * 3;
    const b = idx ? idx[t * 3 + 1] : t * 3 + 1;
    const c = idx ? idx[t * 3 + 2] : t * 3 + 2;
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    const ux = pos[b * 3] - ax, uy = pos[b * 3 + 1] - ay, uz = pos[b * 3 + 2] - az;
    const vx = pos[c * 3] - ax, vy = pos[c * 3 + 1] - ay, vz = pos[c * 3 + 2] - az;
    // Cross product magnitude = 2x area: free area weighting.
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const ca = canonical[a], cb = canonical[b], cc = canonical[c];
    acc[ca * 3] += nx; acc[ca * 3 + 1] += ny; acc[ca * 3 + 2] += nz;
    acc[cb * 3] += nx; acc[cb * 3 + 1] += ny; acc[cb * 3 + 2] += nz;
    acc[cc * 3] += nx; acc[cc * 3 + 1] += ny; acc[cc * 3 + 2] += nz;
  }
  const out = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    const ci = canonical[i];
    const nx = acc[ci * 3], ny = acc[ci * 3 + 1], nz = acc[ci * 3 + 2];
    const len = Math.hypot(nx, ny, nz) || 1;
    out[i * 3] = nx / len; out[i * 3 + 1] = ny / len; out[i * 3 + 2] = nz / len;
  }
  return out;
}

/**
 * Canonical vertex index per exact position (first occurrence wins), via an
 * open-addressing hash on the float bit patterns. Deterministic; ~10x faster
 * than string keys on million-vertex meshes. -0 and 0 compare equal.
 */
export function canonicalByPosition(pos: Float32Array, vertexCount: number): Uint32Array {
  const canonical = new Uint32Array(vertexCount);
  let tableSize = 1;
  while (tableSize < vertexCount * 2) tableSize <<= 1;
  const table = new Int32Array(tableSize).fill(-1);
  const mask = tableSize - 1;
  const bits = new Uint32Array(pos.buffer, pos.byteOffset, pos.length);
  for (let i = 0; i < vertexCount; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const bx = x === 0 ? 0 : bits[i * 3], by = y === 0 ? 0 : bits[i * 3 + 1], bz = z === 0 ? 0 : bits[i * 3 + 2];
    let h = (Math.imul(bx, 73856093) ^ Math.imul(by, 19349663) ^ Math.imul(bz, 83492791)) >>> 0;
    h &= mask;
    for (;;) {
      const j = table[h];
      if (j === -1) { table[h] = i; canonical[i] = i; break; }
      if (pos[j * 3] === x && pos[j * 3 + 1] === y && pos[j * 3 + 2] === z) { canonical[i] = j; break; }
      h = (h + 1) & mask;
    }
  }
  return canonical;
}
