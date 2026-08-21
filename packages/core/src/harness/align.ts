/**
 * Geometry-alignment scoring: compare a candidate mesh against a reference
 * after rigid alignment (translation, rotation from the 24 octahedral
 * hypotheses, uniform scale). Deterministic throughout — seeded sampling,
 * no Math.random.
 *
 * Metrics (coarse → fine, mirroring the axes of Meshy's public benchmark):
 * - proportion: occupancy IoU on a coarse voxel grid
 * - chamfer:    symmetric mean nearest-surface distance (fraction of extent)
 * - fscore@τ:   harmonic mean of precision/recall at τ = 1% and 2% of extent
 */
import { Document, Node, Primitive } from '@gltf-transform/core';

export interface AlignmentScore {
  /** Coarse occupancy IoU, 0..1. */
  proportion: number;
  /** Symmetric chamfer distance as a fraction of the reference extent. */
  chamfer: number;
  fscore1: number;
  fscore2: number;
  /** Index of the octahedral rotation applied to the candidate (0 = none). */
  rotation: number;
  samples: number;
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** World-space triangle soup of a document's default scene. */
export function triangleSoup(doc: Document): Float32Array {
  const out: number[] = [];
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  if (!scene) return new Float32Array(0);
  const visit = (node: Node): void => {
    const mesh = node.getMesh();
    if (mesh) {
      const m = [...node.getWorldMatrix()];
      for (const prim of mesh.listPrimitives()) {
        if (prim.getMode() !== Primitive.Mode.TRIANGLES) continue;
        const pos = prim.getAttribute('POSITION');
        if (!pos) continue;
        const p = pos.getArray()!;
        const idx = prim.getIndices()?.getArray() ?? null;
        const count = idx ? idx.length : pos.getCount();
        for (let i = 0; i < count; i++) {
          const v = idx ? idx[i] : i;
          const x = p[v * 3], y = p[v * 3 + 1], z = p[v * 3 + 2];
          out.push(
            m[0] * x + m[4] * y + m[8] * z + m[12],
            m[1] * x + m[5] * y + m[9] * z + m[13],
            m[2] * x + m[6] * y + m[10] * z + m[14],
          );
        }
      }
    }
    node.listChildren().forEach(visit);
  };
  scene.listChildren().forEach(visit);
  return new Float32Array(out);
}

/** Area-weighted uniform surface sampling (deterministic). */
export function sampleSurface(tris: Float32Array, n: number, seed = 7): Float32Array {
  const triCount = Math.floor(tris.length / 9);
  if (triCount === 0) return new Float32Array(0);
  const cumulative = new Float64Array(triCount);
  let total = 0;
  for (let t = 0; t < triCount; t++) {
    const i = t * 9;
    const ux = tris[i + 3] - tris[i], uy = tris[i + 4] - tris[i + 1], uz = tris[i + 5] - tris[i + 2];
    const vx = tris[i + 6] - tris[i], vy = tris[i + 7] - tris[i + 1], vz = tris[i + 8] - tris[i + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    total += Math.hypot(cx, cy, cz) / 2;
    cumulative[t] = total;
  }
  const rand = rng(seed);
  const out = new Float32Array(n * 3);
  for (let s = 0; s < n; s++) {
    const target = rand() * total;
    let lo = 0, hi = triCount - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] < target) lo = mid + 1; else hi = mid;
    }
    const i = lo * 9;
    let a = rand(), b = rand();
    if (a + b > 1) { a = 1 - a; b = 1 - b; }
    const c = 1 - a - b;
    out[s * 3] = tris[i] * c + tris[i + 3] * a + tris[i + 6] * b;
    out[s * 3 + 1] = tris[i + 1] * c + tris[i + 4] * a + tris[i + 7] * b;
    out[s * 3 + 2] = tris[i + 2] * c + tris[i + 5] * a + tris[i + 8] * b;
  }
  return out;
}

/** Normalization parameters from a vertex soup: centroid + max half-extent. */
function normParams(soup: Float32Array): { cx: number; cy: number; cz: number; extent: number } {
  const n = soup.length / 3;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += soup[i * 3]; cy += soup[i * 3 + 1]; cz += soup[i * 3 + 2]; }
  cx /= n || 1; cy /= n || 1; cz /= n || 1;
  let extent = 0;
  for (let i = 0; i < n; i++) {
    extent = Math.max(
      extent,
      Math.abs(soup[i * 3] - cx), Math.abs(soup[i * 3 + 1] - cy), Math.abs(soup[i * 3 + 2] - cz),
    );
  }
  return { cx, cy, cz, extent: extent || 1 };
}

function applyNorm(arr: Float32Array, p: { cx: number; cy: number; cz: number; extent: number }): void {
  for (let i = 0; i < arr.length; i += 3) {
    arr[i] = (arr[i] - p.cx) / p.extent;
    arr[i + 1] = (arr[i + 1] - p.cy) / p.extent;
    arr[i + 2] = (arr[i + 2] - p.cz) / p.extent;
  }
}

/** Closest-point distance from a point to a triangle (Ericson). */
function pointTriDist(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx2: number, cy2: number, cz2: number,
): number {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx2 - ax, acy = cy2 - ay, acz = cz2 - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return Math.hypot(apx, apy, apz);
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return Math.hypot(bpx, bpy, bpz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return Math.hypot(apx - v * abx, apy - v * aby, apz - v * abz);
  }
  const cpx = px - cx2, cpy = py - cy2, cpz = pz - cz2;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return Math.hypot(cpx, cpy, cpz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return Math.hypot(apx - w * acx, apy - w * acy, apz - w * acz);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return Math.hypot(px - (bx + w * (cx2 - bx)), py - (by + w * (cy2 - by)), pz - (bz + w * (cz2 - bz)));
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  return Math.hypot(
    px - (ax + abx * v + acx * w),
    py - (ay + aby * v + acy * w),
    pz - (az + abz * v + acz * w),
  );
}

/** Point-to-SURFACE distances via a triangle grid hash. */
function pointToMeshDistances(points: Float32Array, tris: Float32Array, cell: number): Float64Array {
  const grid = new Map<string, number[]>();
  const put = (k: string, t: number) => {
    const bucket = grid.get(k);
    if (bucket) bucket.push(t); else grid.set(k, [t]);
  };
  const triCount = tris.length / 9;
  for (let t = 0; t < triCount; t++) {
    const i = t * 9;
    const minX = Math.floor(Math.min(tris[i], tris[i + 3], tris[i + 6]) / cell);
    const maxX = Math.floor(Math.max(tris[i], tris[i + 3], tris[i + 6]) / cell);
    const minY = Math.floor(Math.min(tris[i + 1], tris[i + 4], tris[i + 7]) / cell);
    const maxY = Math.floor(Math.max(tris[i + 1], tris[i + 4], tris[i + 7]) / cell);
    const minZ = Math.floor(Math.min(tris[i + 2], tris[i + 5], tris[i + 8]) / cell);
    const maxZ = Math.floor(Math.max(tris[i + 2], tris[i + 5], tris[i + 8]) / cell);
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) for (let z = minZ; z <= maxZ; z++) {
      put(`${x},${y},${z}`, t);
    }
  }
  const out = new Float64Array(points.length / 3);
  for (let p = 0; p < points.length; p += 3) {
    const px = points[p], py = points[p + 1], pz = points[p + 2];
    const gx = Math.floor(px / cell), gy = Math.floor(py / cell), gz = Math.floor(pz / cell);
    let best = Infinity;
    for (let ring = 0; ring < 8; ring++) {
      for (let dx = -ring; dx <= ring; dx++) for (let dy = -ring; dy <= ring; dy++) for (let dz = -ring; dz <= ring; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== ring) continue;
        const bucket = grid.get(`${gx + dx},${gy + dy},${gz + dz}`);
        if (!bucket) continue;
        for (const t of bucket) {
          const i = t * 9;
          const d = pointTriDist(
            px, py, pz,
            tris[i], tris[i + 1], tris[i + 2],
            tris[i + 3], tris[i + 4], tris[i + 5],
            tris[i + 6], tris[i + 7], tris[i + 8],
          );
          if (d < best) best = d;
        }
      }
      // Stop once the next ring cannot contain anything closer.
      if (best <= (ring) * cell) break;
    }
    out[p / 3] = best === Infinity ? 2 : best;
  }
  return out;
}

/** The 24 rotations of the cube (signed permutation matrices, det +1). */
function octahedralRotations(): number[][] {
  const rotations: number[][] = [];
  const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  for (const perm of perms) {
    for (let signs = 0; signs < 8; signs++) {
      const s = [signs & 1 ? -1 : 1, signs & 2 ? -1 : 1, signs & 4 ? -1 : 1];
      const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      for (let row = 0; row < 3; row++) m[row * 3 + perm[row]] = s[row];
      const det =
        m[0] * (m[4] * m[8] - m[5] * m[7]) -
        m[1] * (m[3] * m[8] - m[5] * m[6]) +
        m[2] * (m[3] * m[7] - m[4] * m[6]);
      if (det > 0) rotations.push(m);
    }
  }
  return rotations;
}

function applyRotation(points: Float32Array, m: number[]): Float32Array {
  const out = new Float32Array(points.length);
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i], y = points[i + 1], z = points[i + 2];
    out[i] = m[0] * x + m[1] * y + m[2] * z;
    out[i + 1] = m[3] * x + m[4] * y + m[5] * z;
    out[i + 2] = m[6] * x + m[7] * y + m[8] * z;
  }
  return out;
}

function voxelSet(points: Float32Array, res: number): Set<number> {
  const set = new Set<number>();
  for (let i = 0; i < points.length; i += 3) {
    const x = Math.min(res - 1, Math.max(0, Math.floor(((points[i] + 1) / 2) * res)));
    const y = Math.min(res - 1, Math.max(0, Math.floor(((points[i + 1] + 1) / 2) * res)));
    const z = Math.min(res - 1, Math.max(0, Math.floor(((points[i + 2] + 1) / 2) * res)));
    set.add((x * res + y) * res + z);
  }
  return set;
}

function iou(a: Set<number>, b: Set<number>): number {
  let inter = 0;
  for (const v of a) if (b.has(v)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Grid-hash nearest-neighbor distances from each point in A to set B. */
function nearestDistances(a: Float32Array, b: Float32Array, cell: number): Float64Array {
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number, z: number) =>
    `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let i = 0; i < b.length; i += 3) {
    const k = key(b[i], b[i + 1], b[i + 2]);
    const bucket = grid.get(k);
    if (bucket) bucket.push(i); else grid.set(k, [i]);
  }
  const out = new Float64Array(a.length / 3);
  for (let i = 0; i < a.length; i += 3) {
    const x = a[i], y = a[i + 1], z = a[i + 2];
    let best = Infinity;
    for (let ring = 0; ring < 6 && best === Infinity; ring++) {
      const gx = Math.floor(x / cell), gy = Math.floor(y / cell), gz = Math.floor(z / cell);
      for (let dx = -ring; dx <= ring; dx++) for (let dy = -ring; dy <= ring; dy++) for (let dz = -ring; dz <= ring; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== ring) continue;
        const bucket = grid.get(`${gx + dx},${gy + dy},${gz + dz}`);
        if (!bucket) continue;
        for (const j of bucket) {
          const d = Math.hypot(b[j] - x, b[j + 1] - y, b[j + 2] - z);
          if (d < best) best = d;
        }
      }
      // One extra ring after the first hit guarantees true nearest.
      if (best < Infinity && ring < 5) {
        const gxr = ring + 1;
        for (let dx = -gxr; dx <= gxr; dx++) for (let dy = -gxr; dy <= gxr; dy++) for (let dz = -gxr; dz <= gxr; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== gxr) continue;
          const bucket = grid.get(`${gx + dx},${gy + dy},${gz + dz}`);
          if (!bucket) continue;
          for (const j of bucket) {
            const d = Math.hypot(b[j] - x, b[j + 1] - y, b[j + 2] - z);
            if (d < best) best = d;
          }
        }
        break;
      }
    }
    out[i / 3] = best === Infinity ? 2 : best;
  }
  return out;
}

/** Score candidate geometry against a reference. */
export function alignmentScore(
  candidate: Document,
  reference: Document,
  opts: { samples?: number } = {},
): AlignmentScore {
  const samples = opts.samples ?? 15000;
  const refTris = triangleSoup(reference);
  let candTris = triangleSoup(candidate);
  const refPoints = sampleSurface(refTris, samples, 11);
  let candPoints = sampleSurface(candTris, samples, 23);
  // One normalization frame per mesh, applied to BOTH its surface and its
  // samples — mixed frames introduce a systematic offset that poisons the
  // fine metrics.
  const refNorm = normParams(refTris);
  applyNorm(refTris, refNorm);
  applyNorm(refPoints, refNorm);
  const candNorm = normParams(candTris);
  applyNorm(candTris, candNorm);
  applyNorm(candPoints, candNorm);

  // Rigid rotation search on a coarse grid.
  const refCoarse = voxelSet(refPoints, 16);
  let bestRotation = 0, bestIoU = -1, bestPoints = candPoints;
  const rotations = octahedralRotations();
  for (let r = 0; r < rotations.length; r++) {
    const rotated = r === 0 ? candPoints : applyRotation(candPoints, rotations[r]);
    const score = iou(voxelSet(rotated, 16), refCoarse);
    if (score > bestIoU) { bestIoU = score; bestRotation = r; bestPoints = rotated; }
  }
  candPoints = bestPoints;
  if (bestRotation !== 0) {
    candTris = applyRotation(candTris, rotations[bestRotation]) as Float32Array;
  }

  // Part-level occupancy: res 16 keeps the metric about major-part layout
  // and stays stable under independent surface samplings.
  const proportion = iou(voxelSet(candPoints, 16), voxelSet(refPoints, 16));

  // Point-to-surface distances (exact point-triangle) — no sampling-noise
  // floor: identical geometry scores ~0 deviation regardless of seeds.
  const cell = 0.06;
  const dCandToRef = pointToMeshDistances(candPoints, refTris, cell);
  const dRefToCand = pointToMeshDistances(refPoints, candTris, cell);
  let sum = 0;
  for (const d of dCandToRef) sum += d;
  for (const d of dRefToCand) sum += d;
  const chamfer = sum / (dCandToRef.length + dRefToCand.length) / 2; // extent = 2

  const fscore = (tau: number): number => {
    let precise = 0, recalled = 0;
    for (const d of dCandToRef) if (d / 2 <= tau) precise++;
    for (const d of dRefToCand) if (d / 2 <= tau) recalled++;
    const precision = precise / dCandToRef.length;
    const recall = recalled / dRefToCand.length;
    return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  };

  return {
    proportion,
    chamfer,
    fscore1: fscore(0.01),
    fscore2: fscore(0.02),
    rotation: bestRotation,
    samples,
  };
}
