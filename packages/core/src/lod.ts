/**
 * Geometry-only LOD generation. Edge-collapse simplification (meshopt) is
 * tried first because it preserves shape best, but it locks every vertex on
 * non-manifold or complex topology — stacked forge layers, doubled shells,
 * self-touching generator output — and then stalls far above the target.
 * When that happens we fall back to grid vertex clustering: quantize
 * positions to a uniform grid, merge each cell into one vertex (position
 * averaged, other attributes from the cell's first vertex), drop the
 * collapsed triangles. Clustering reaches any target on any topology and is
 * the standard far-LOD reducer; the grid resolution is found by binary
 * search so the result lands just under the target. Deterministic.
 */
import { Document, type Primitive } from '@gltf-transform/core';
import { compactPrimitive } from '@gltf-transform/functions';
import { readFloat } from './accessors.js';
import { optimize, prepareLod, type OptimizeOptions } from './optimize.js';
import type { Profile } from './types.js';

function countTris(doc: Document): number {
  let tris = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      tris += Math.floor((idx ? idx.getCount() : prim.getAttribute('POSITION')?.getCount() ?? 0) / 3);
    }
  }
  return tris;
}

/** Cluster a primitive's vertices on a grid with `res` cells along the longest axis; returns the triangle count. */
function clusterAt(prim: Primitive, res: number, apply: boolean): number {
  const position = prim.getAttribute('POSITION')!;
  const pos = readFloat(position);
  const count = position.getCount();
  const idxAcc = prim.getIndices();
  const idx = idxAcc ? idxAcc.getArray()! : Uint32Array.from({ length: count }, (_, i) => i);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) for (let a = 0; a < 3; a++) {
    const v = pos[i * 3 + a];
    if (v < min[a]) min[a] = v;
    if (v > max[a]) max[a] = v;
  }
  const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
  const cell = extent / res;
  const keyOf = new Map<string, number>();
  const cluster = new Uint32Array(count);
  const sums: number[] = [];
  const counts: number[] = [];
  for (let i = 0; i < count; i++) {
    const kx = Math.min(res, Math.floor((pos[i * 3] - min[0]) / cell));
    const ky = Math.min(res, Math.floor((pos[i * 3 + 1] - min[1]) / cell));
    const kz = Math.min(res, Math.floor((pos[i * 3 + 2] - min[2]) / cell));
    const key = `${kx},${ky},${kz}`;
    let c = keyOf.get(key);
    if (c === undefined) { c = sums.length / 3; keyOf.set(key, c); sums.push(0, 0, 0); counts.push(0); }
    cluster[i] = c;
    sums[c * 3] += pos[i * 3]; sums[c * 3 + 1] += pos[i * 3 + 1]; sums[c * 3 + 2] += pos[i * 3 + 2];
    counts[c]++;
  }
  const kept: number[] = [];
  const seenTri = new Set<string>();
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = cluster[idx[t]], b = cluster[idx[t + 1]], c = cluster[idx[t + 2]];
    if (a === b || b === c || c === a) continue;
    const key = a < b ? (a < c ? `${a},${b},${c}` : `${c},${a},${b}`) : (b < c ? `${b},${c},${a}` : `${c},${a},${b}`);
    if (seenTri.has(key)) continue;
    seenTri.add(key);
    kept.push(idx[t], idx[t + 1], idx[t + 2]);
  }
  const tris = kept.length / 3;
  if (!apply) return tris;

  // Apply: new indices over the original vertex stream, then compact by cluster.
  const doc = Document.fromGraph(prim.getGraph())!;
  const buffer = position.getBuffer() ?? doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
  const newIdx = doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(kept)).setBuffer(buffer);
  prim.setIndices(newIdx);
  if (idxAcc && idxAcc.listParents().length === 1) idxAcc.dispose();
  // Remap every vertex to its cluster's representative (first member), then
  // overwrite positions with the cluster centroids.
  const rep = new Int32Array(sums.length / 3).fill(-1);
  const remap = new Uint32Array(count);
  let next = 0;
  const order: number[] = [];
  for (let i = 0; i < count; i++) {
    const c = cluster[i];
    if (rep[c] === -1) { rep[c] = next++; order.push(c); }
    remap[i] = rep[c];
  }
  compactPrimitive(prim, remap, next);
  const compacted = prim.getAttribute('POSITION')!;
  const arr = new Float32Array(next * 3);
  for (let j = 0; j < next; j++) {
    const c = order[j];
    arr[j * 3] = sums[c * 3] / counts[c]; arr[j * 3 + 1] = sums[c * 3 + 1] / counts[c]; arr[j * 3 + 2] = sums[c * 3 + 2] / counts[c];
  }
  compacted.setArray(arr).setNormalized(false);
  const finalIdx = prim.getIndices()!;
  if (next <= 65534) finalIdx.setArray(new Uint16Array(finalIdx.getArray()!));
  return tris;
}

/**
 * Uniform Laplacian smoothing (in place). Grid clustering leaves cell-sized
 * crumpling on thin stacked surfaces; one or two relaxation passes remove it
 * while the coarse silhouette, which clustering preserved, barely moves.
 */
export function smoothPositions(prim: Primitive, iterations = 1, lambda = 0.5): void {
  const position = prim.getAttribute('POSITION')!;
  const idx = prim.getIndices()?.getArray();
  if (!idx) return;
  let pos = Float32Array.from(readFloat(position));
  const n = position.getCount();
  const neighbors: number[][] = Array.from({ length: n }, () => []);
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    neighbors[a].push(b, c); neighbors[b].push(a, c); neighbors[c].push(a, b);
  }
  for (let it = 0; it < iterations; it++) {
    const next = new Float32Array(pos.length);
    for (let i = 0; i < n; i++) {
      const nb = neighbors[i];
      if (!nb.length) { next[i * 3] = pos[i * 3]; next[i * 3 + 1] = pos[i * 3 + 1]; next[i * 3 + 2] = pos[i * 3 + 2]; continue; }
      let sx = 0, sy = 0, sz = 0;
      for (const j of nb) { sx += pos[j * 3]; sy += pos[j * 3 + 1]; sz += pos[j * 3 + 2]; }
      const k = nb.length;
      next[i * 3] = pos[i * 3] + lambda * (sx / k - pos[i * 3]);
      next[i * 3 + 1] = pos[i * 3 + 1] + lambda * (sy / k - pos[i * 3 + 1]);
      next[i * 3 + 2] = pos[i * 3 + 2] + lambda * (sz / k - pos[i * 3 + 2]);
    }
    pos = next;
  }
  position.setArray(pos).setNormalized(false);
}

/** Reduce a primitive to at most `target` triangles by grid clustering, then relax the crumpling. */
export function clusterDecimate(prim: Primitive, target: number): { triangles: number; resolution: number } {
  let lo = 2, hi = 4096;
  // Largest resolution whose triangle count fits the target.
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (clusterAt(prim, mid, false) <= target) lo = mid; else hi = mid - 1;
  }
  const triangles = clusterAt(prim, lo, true);
  smoothPositions(prim, 1, 0.5);
  return { triangles, resolution: lo };
}

export interface LodResult {
  triangles: number;
  target: number;
  /** 'simplify' = meshopt reached the target; 'cluster' = grid clustering finished the job. */
  method: 'simplify' | 'cluster';
  steps: string[];
}

/**
 * Turn an already-optimized document into a geometry-only LOD at `target`
 * triangles: strip materials, weld by position, meshopt-simplify, and if
 * the topology stalled the simplifier, grid-cluster the remainder.
 */
export async function buildLod(
  doc: Document,
  target: number,
  opts: { profile: Profile; compress?: boolean; log?: OptimizeOptions['log'] } ,
): Promise<LodResult> {
  const { mergedVertices } = prepareLod(doc);
  const steps = mergedVertices ? [`weld-positions -${mergedVertices.toLocaleString()} verts`] : [];
  const first = await optimize(doc, { profile: opts.profile, targetTriangles: target, textures: false, compress: opts.compress, verify: false, log: opts.log });
  steps.push(...first.steps);
  let triangles = countTris(doc);
  let method: LodResult['method'] = 'simplify';
  if (triangles > target * 1.1) {
    // Split the target across primitives in proportion to their size.
    const prims = doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives()).filter((p) => p.getMode() === 4 && p.getAttribute('POSITION'));
    const total = triangles;
    for (const prim of prims) {
      const share = Math.max(3, Math.floor(target * ((prim.getIndices()?.getCount() ?? 0) / 3) / total));
      const nrm = prim.getAttribute('NORMAL');
      if (nrm) { prim.setAttribute('NORMAL', null); if (nrm.listParents().length === 1) nrm.dispose(); }
      clusterDecimate(prim, share);
    }
    // Second pass: fresh smooth normals on the clustered surface + compression.
    const second = await optimize(doc, { profile: opts.profile, targetTriangles: target, textures: false, compress: opts.compress, verify: false, log: opts.log });
    triangles = countTris(doc);
    method = 'cluster';
    steps.push(`cluster-decimate -> ${triangles.toLocaleString()}`, ...second.steps.filter((s) => s === 'smooth-normals' || s === 'meshopt'));
    opts.log?.(`cluster-decimate (topology stalled the simplifier at ${first.trianglesAfter.toLocaleString()}): -> ${triangles.toLocaleString()} tris`);
  }
  return { triangles, target, method, steps };
}
