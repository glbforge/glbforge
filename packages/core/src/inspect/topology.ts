/**
 * Welded-space mesh topology for the inner loop: boundary / non-manifold /
 * degenerate counts and connected shells, per IR mesh.
 *
 * Everything is computed after unifying vertices by exact position
 * (`canonicalByPosition`), so UV-seam and normal splits — which every GLB
 * exporter produces and which a naive edge count reports as thousands of
 * holes — do not count. What remains is real: an edge with one face is a
 * hole or an open surface, an edge with three or more faces is overlapping
 * or internal geometry, and a shell is a piece of surface you could pick up
 * on its own.
 *
 * Edge incidence sorts integer (min, max) vertex pairs with an LSD radix
 * sort and scans runs — no Map, no hashing, no float keys. On a 2M-triangle
 * mesh the Map version took ~1.4 s; this takes a few hundred ms with
 * identical numbers. Deterministic by construction.
 */
import { canonicalByPosition } from '../normals.js';
import type { IRMesh } from './ir.js';

export interface MeshTopology {
  /** Edges belonging to exactly one triangle (holes / open surfaces), welded space. */
  boundaryEdges: number;
  /** Connected chains of boundary edges — roughly "how many holes" (an open sheet counts as one). */
  boundaryLoops: number;
  /** Edges shared by three or more triangles, welded space. */
  nonManifoldEdges: number;
  /** Triangles with repeated or position-coincident corners. */
  degenerateTriangles: number;
  /** Distinct vertex positions. */
  uniquePositions: number;
  /** Connected pieces of surface (edge-connected, welded space). */
  shells: number;
  /** Triangles per shell, largest first. */
  shellTriangles: number[];
  /** Every edge has exactly two faces: closed and manifold — a solid. */
  watertight: boolean;
}

/** Stable LSD radix sort of (lo, hi) pairs by hi then lo; returns the permutation. Passes over zero halves are skipped. */
function sortPairs(lo: Uint32Array, hi: Uint32Array, count: number, maxValue: number): Uint32Array {
  let perm = new Uint32Array(count);
  for (let i = 0; i < count; i++) perm[i] = i;
  let tmp = new Uint32Array(count);
  const buckets = new Uint32Array(65537);
  const passes: Array<[Uint32Array, number]> = maxValue < 65536
    ? [[lo, 0], [hi, 0]]
    : [[lo, 0], [lo, 16], [hi, 0], [hi, 16]];
  for (const [arr, shift] of passes) {
    buckets.fill(0);
    for (let i = 0; i < count; i++) buckets[((arr[perm[i]] >>> shift) & 0xffff) + 1]++;
    for (let i = 0; i < 65536; i++) buckets[i + 1] += buckets[i];
    for (let i = 0; i < count; i++) { const p = perm[i]; tmp[buckets[(arr[p] >>> shift) & 0xffff]++] = p; }
    const s = perm; perm = tmp; tmp = s;
  }
  return perm;
}

/**
 * Topology of a triangle-list IR mesh, or null for points / lines / empty
 * meshes. O(t) in the triangle count; about 40 bytes per triangle of
 * scratch memory plus the weld table.
 */
export function meshTopology(m: IRMesh): MeshTopology | null {
  if (m.mode !== 'triangles' || !m.indices || m.triangleCount === 0) return null;
  const idx = m.indices;
  const n = m.vertexCount;
  const canonical = canonicalByPosition(m.positions, n);

  let uniquePositions = 0;
  for (let i = 0; i < n; i++) if (canonical[i] === i) uniquePositions++;

  // --- union-find over welded vertices (shell membership) ---
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const union = (a: number, b: number): void => {
    a = find(a); b = find(b);
    if (a !== b) parent[a] = b;
  };

  // --- directed edges as (min, max) pairs ---
  const triCount = idx.length / 3;
  const lo = new Uint32Array(triCount * 3), hi = new Uint32Array(triCount * 3);
  let degenerate = 0, k = 0;
  const push = (u: number, v: number) => { if (u < v) { lo[k] = u; hi[k] = v; } else { lo[k] = v; hi[k] = u; } k++; };
  for (let t = 0; t < triCount; t++) {
    const a = canonical[idx[t * 3]], b = canonical[idx[t * 3 + 1]], c = canonical[idx[t * 3 + 2]];
    if (a === b || b === c || a === c) { degenerate++; continue; }
    push(a, b); push(b, c); push(c, a);
    union(a, b); union(b, c);
  }
  const perm = sortPairs(lo, hi, k, n);

  // --- runs of equal edges; boundary edges chained into loops with a second union-find ---
  let boundary = 0, nonManifold = 0;
  const loopParent = new Map<number, number>(); // absent = own root
  const loopFind = (i: number): number => {
    let r = i;
    for (;;) { const p = loopParent.get(r); if (p === undefined || p === r) break; r = p; }
    while (i !== r) { const p = loopParent.get(i)!; loopParent.set(i, r); i = p; }
    return r;
  };
  const boundaryVertices = new Set<number>();
  for (let i = 0; i < k;) {
    const p = perm[i], u = lo[p], v = hi[p];
    let j = i + 1;
    while (j < k && lo[perm[j]] === u && hi[perm[j]] === v) j++;
    const count = j - i;
    if (count === 1) {
      boundary++;
      boundaryVertices.add(u); boundaryVertices.add(v);
      const ru = loopFind(u), rv = loopFind(v);
      if (ru !== rv) loopParent.set(ru, rv);
    } else if (count > 2) nonManifold++;
    i = j;
  }
  let boundaryLoops = 0;
  for (const v of boundaryVertices) if (loopFind(v) === v) boundaryLoops++;

  // --- shells: triangles per root ---
  const perRoot = new Uint32Array(n);
  for (let t = 0; t < triCount; t++) {
    const a = canonical[idx[t * 3]], b = canonical[idx[t * 3 + 1]], c = canonical[idx[t * 3 + 2]];
    if (a === b || b === c || a === c) continue;
    perRoot[find(a)]++;
  }
  const shellTriangles: number[] = [];
  for (let i = 0; i < n; i++) if (perRoot[i]) shellTriangles.push(perRoot[i]);
  shellTriangles.sort((x, y) => y - x);

  return {
    boundaryEdges: boundary,
    boundaryLoops,
    nonManifoldEdges: nonManifold,
    degenerateTriangles: degenerate,
    uniquePositions,
    shells: shellTriangles.length,
    shellTriangles,
    watertight: boundary === 0 && nonManifold === 0 && shellTriangles.length > 0,
  };
}
