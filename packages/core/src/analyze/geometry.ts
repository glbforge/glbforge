import { Document, Mesh, Node, Primitive, getBounds } from '@gltf-transform/core';
import type { GeometryStats, PrimitiveStats, TopologyStats } from '../types.js';
import { sortPairs } from '../inspect/topology.js';

/**
 * Triangles the scene draws, counting a mesh once per node that places it.
 * The budget rule measures this, so anything aiming AT the budget — the
 * simplify ladder above all — has to measure the same thing, or it optimizes
 * to a number nothing checks.
 */
export function sceneTriangles(doc: Document): number {
  return analyzeGeometry(doc, { topology: false }).triangles;
}

/**
 * Draw calls the scene actually issues: one per primitive, per node that
 * places it. The mesh list misses what dedup() creates on purpose — one
 * shared mesh placed by several nodes — so anything deciding whether there
 * are draw calls left to remove has to measure this, not the mesh list.
 */
export function sceneDrawCalls(doc: Document): number {
  return analyzeGeometry(doc, { topology: false }).drawCallEstimate;
}

/**
 * How many copies of its mesh a node draws. EXT_mesh_gpu_instancing puts the
 * per-instance transforms in an attribute; without the extension a node draws
 * its mesh once. Unreadable or unregistered extension data counts as one
 * rather than guessing.
 */
function gpuInstanceCount(node: Node): number {
  const ext = node.getExtension('EXT_mesh_gpu_instancing') as
    { listAttributes?: () => Array<{ getCount: () => number }> } | null;
  const attrs = ext?.listAttributes?.();
  const n = attrs && attrs.length > 0 ? attrs[0].getCount() : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

interface NumericArray { readonly length: number; [index: number]: number }

// Scratch buffer for turning a raw component value into a well-distributed
// 32-bit hash, reused across calls rather than allocated per vertex.
const hashF32 = new Float32Array(1);
const hashU32 = new Uint32Array(hashF32.buffer);
function componentHash(v: number): number {
  if (v === 0) return 0; // unify +0/-0, matching the `!==` equality check below
  hashF32[0] = v;
  return hashU32[0];
}

// One large odd multiplier per component *slot* (cycled for meshes with more
// components than primes), XORed together rather than folded sequentially —
// the same spatial-hash shape `canonicalByPosition` (normals.ts) uses for
// x/y/z. A repeated real asset (e.g. a tube's cross-section repeating
// symmetric normals down its length) showed why the sequential
// `h = imul(h ^ v, ONE_CONST)` chain this replaced doesn't generalize past 3
// fixed axes: on a 12k-vertex prop it averaged >100 probes per lookup
// (should be ~1-2 at this table's 0.5 load factor) because runs of
// vertices sharing a prefix of components collapsed onto the same partial
// hash before the differing components were folded in. Independent primes
// per slot don't have that failure mode: two vertices differing in any one
// component get different contributions from that slot's multiplier
// regardless of what the earlier slots hashed to.
const HASH_PRIMES = [
  0x9e3779b1, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f,
  0x165667b1, 0xd3a2646c, 0xfd7046c5, 0xb55a4f09,
] as const;

/**
 * Canonical vertex index (first occurrence wins) across one or more
 * interleaved attribute arrays, via open addressing on a combined hash of
 * each component's value. A hash collision falls through to a full
 * component-by-component equality check on the *raw* array values (the same
 * comparison a string key would make, no decoding) — so this never reports a
 * false match, only a slower one. Used for both the position-only weld and
 * the all-attribute weld below; the string-key version this replaced was
 * ~15-20x slower on a real 150k-triangle asset (concatenating and hashing a
 * string per vertex, per attribute component).
 */
function canonicalByAttributes(attrs: { array: NumericArray; size: number }[], vertexCount: number): Uint32Array {
  const canonical = new Uint32Array(vertexCount);
  let tableSize = 1;
  while (tableSize < vertexCount * 2) tableSize <<= 1;
  const table = new Int32Array(tableSize).fill(-1);
  const mask = tableSize - 1;

  const equalVertex = (i: number, j: number): boolean => {
    for (const { array, size } of attrs) {
      const oi = i * size, oj = j * size;
      for (let c = 0; c < size; c++) if (array[oi + c] !== array[oj + c]) return false;
    }
    return true;
  };

  for (let i = 0; i < vertexCount; i++) {
    let h = 0;
    let slot = 0;
    for (const { array, size } of attrs) {
      const o = i * size;
      for (let c = 0; c < size; c++) {
        h ^= Math.imul(componentHash(array[o + c]), HASH_PRIMES[slot % HASH_PRIMES.length]);
        slot++;
      }
    }
    // Multiplication mod 2^32 only mixes each output bit from input bits at
    // or below it, so the *low* bits of an XOR-of-products carry only the
    // low-bit entropy of the inputs. Masking those low bits straight into a
    // bucket index (`h & mask`) is fine when the inputs are already
    // high-entropy in their low bits, and silently isn't when they're not:
    // quantized attributes (int16 positions, the common case for an
    // optimized or Meshy-exported GLB) convert to float32 bit patterns whose
    // low mantissa bits are structured, not random, and every vertex in a
    // 12k-vertex prop landed in one of a few thousand buckets — 100+ probes
    // per lookup average, worse than the string keys this replaced. A
    // MurmurHash3 finalizer (fmix32) spreads entropy from every input bit
    // across the whole 32 bits before it's masked, independent of where that
    // entropy started; verified this drops the same asset to ~1 probe/lookup.
    h >>>= 0;
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35) >>> 0;
    h ^= h >>> 16;
    h &= mask;
    for (;;) {
      const j = table[h];
      if (j === -1) { table[h] = i; canonical[i] = i; break; }
      if (equalVertex(i, j)) { canonical[i] = j; break; }
      h = (h + 1) & mask;
    }
  }
  return canonical;
}

/**
 * Topology is computed in *welded* index space: vertices are first unified by
 * exact position, then edge incidence is counted on the remapped triangles.
 * This keeps boundary/non-manifold counts honest even when the source mesh
 * ships duplicated (unwelded) vertices — the usual case for AI-generated GLBs.
 */
function computeTopology(prims: Primitive[]): TopologyStats {
  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  let degenerateTriangles = 0;
  let duplicateVertexPositions = 0;
  let redundantVertices = 0;
  let uniquePositions = 0;

  for (const prim of prims) {
    if (prim.getMode() !== Primitive.Mode.TRIANGLES) continue;
    const position = prim.getAttribute('POSITION');
    if (!position) continue;

    const vertexCount = position.getCount();
    const pos = position.getArray()!;
    // EVERY attribute, not a chosen few. The redundancy count drives
    // `topo/unwelded`, whose fix is "weld during optimization" — so it has to
    // mean what weld means by a duplicate. Keying on position/UV/normal alone
    // counted vertices that differ in TANGENT (or any other semantic) as
    // "identical across ALL attributes": a tangent-bearing asset reported 60%
    // of its vertices as pure waste that welding could never remove.
    const attrs = prim.listSemantics().map((sem) => {
      const acc = prim.getAttribute(sem)!;
      return { array: acc.getArray()!, size: acc.getElementSize() };
    });

    // Weld map: exact-position key -> canonical index. Position-only
    // duplicates are often *legitimate* (UV-seam splits), so truly
    // redundant vertices are counted separately via the all-attribute key.
    const canonical = canonicalByAttributes([{ array: pos, size: 3 }], vertexCount);
    const canonicalFull = canonicalByAttributes(attrs, vertexCount);
    for (let i = 0; i < vertexCount; i++) {
      if (canonical[i] === i) uniquePositions++;
      else duplicateVertexPositions++;
      if (canonicalFull[i] !== i) redundantVertices++;
    }

    const indices = prim.getIndices();
    const triCount = indices ? indices.getCount() / 3 : vertexCount / 3;
    const idx = indices?.getArray() ?? null;

    // Edge incidence in canonical index space, via the same radix-sorted
    // (lo, hi) pass `inspect/topology.ts` uses — a `Map<number, number>`
    // keyed on the packed pair took ~1.4s on a 2M-triangle mesh there; this
    // takes a few hundred ms with identical numbers (see that file's doc
    // comment). No Map, no hashing, no float keys.
    const lo = new Uint32Array(Math.floor(triCount) * 3);
    const hi = new Uint32Array(Math.floor(triCount) * 3);
    let edgeN = 0;
    const pushEdge = (u: number, v: number) => {
      if (u < v) { lo[edgeN] = u; hi[edgeN] = v; } else { lo[edgeN] = v; hi[edgeN] = u; }
      edgeN++;
    };
    for (let t = 0; t < triCount; t++) {
      const a = canonical[idx ? idx[t * 3] : t * 3];
      const b = canonical[idx ? idx[t * 3 + 1] : t * 3 + 1];
      const c = canonical[idx ? idx[t * 3 + 2] : t * 3 + 2];
      if (a === b || b === c || a === c) {
        degenerateTriangles++;
        continue;
      }
      pushEdge(a, b); pushEdge(b, c); pushEdge(c, a);
    }
    const perm = sortPairs(lo, hi, edgeN, vertexCount);
    for (let i = 0; i < edgeN;) {
      const p = perm[i], u = lo[p], v = hi[p];
      let j = i + 1;
      while (j < edgeN && lo[perm[j]] === u && hi[perm[j]] === v) j++;
      const count = j - i;
      if (count === 1) boundaryEdges++;
      else if (count > 2) nonManifoldEdges++;
      i = j;
    }
  }

  return {
    boundaryEdges,
    nonManifoldEdges,
    degenerateTriangles,
    duplicateVertexPositions,
    redundantVertices,
    uniquePositions,
  };
}

export function analyzeGeometry(
  doc: Document,
  opts: { topology: boolean },
): GeometryStats {
  const root = doc.getRoot();
  const meshes = root.listMeshes();

  const primitives: PrimitiveStats[] = [];
  const allPrims: Primitive[] = [];
  let triangles = 0;
  let vertices = 0;
  let primsMissingNormals = 0;
  let primsMissingUVs = 0;
  let primsUnindexed = 0;

  for (const mesh of meshes) {
    for (const prim of mesh.listPrimitives()) {
      allPrims.push(prim);
      const position = prim.getAttribute('POSITION');
      const indices = prim.getIndices();
      const vertexCount = position?.getCount() ?? 0;
      const triCount = Math.floor(
        (indices ? indices.getCount() : vertexCount) / 3,
      );
      const attributes = prim.listSemantics();

      if (!attributes.includes('NORMAL')) primsMissingNormals++;
      if (!attributes.some((a) => a.startsWith('TEXCOORD'))) primsMissingUVs++;
      if (!indices) primsUnindexed++;

      triangles += triCount;
      vertices += vertexCount;
      primitives.push({
        meshName: mesh.getName() || '(unnamed)',
        triangles: triCount,
        vertices: vertexCount,
        indexed: !!indices,
        attributes,
        materialName: prim.getMaterial()?.getName() ?? null,
      });
    }
  }

  // What the SCENE draws. A mesh referenced by five nodes is drawn five
  // times; counting the mesh list once each under-reports an instanced asset
  // and lets it pass a budget it does not actually meet.
  const triOfMesh = new Map<Mesh, { triangles: number; vertices: number; prims: number }>();
  for (const mesh of meshes) {
    let t = 0, v = 0;
    for (const prim of mesh.listPrimitives()) {
      const p = prim.getAttribute('POSITION');
      const i = prim.getIndices();
      t += Math.floor(((i ? i.getCount() : p?.getCount() ?? 0)) / 3);
      v += p?.getCount() ?? 0;
    }
    triOfMesh.set(mesh, { triangles: t, vertices: v, prims: mesh.listPrimitives().length });
  }

  let drawnTriangles = 0, drawnVertices = 0, drawCalls = 0, instancedNodes = 0;
  const meshUseCount = new Map<Mesh, number>();
  const walk = (node: Node): void => {
    const mesh = node.getMesh();
    if (mesh) {
      const m = triOfMesh.get(mesh);
      if (m) {
        // EXT_mesh_gpu_instancing draws N copies in ONE call: the geometry
        // multiplies, the draw calls do not.
        const gpu = gpuInstanceCount(node);
        drawnTriangles += m.triangles * gpu;
        drawnVertices += m.vertices * gpu;
        drawCalls += m.prims;
        meshUseCount.set(mesh, (meshUseCount.get(mesh) ?? 0) + 1);
      }
    }
    for (const child of node.listChildren()) walk(child);
  };
  const scenes = root.listScenes();
  for (const sc of scenes) for (const child of sc.listChildren()) walk(child);
  for (const used of meshUseCount.values()) if (used > 1) instancedNodes += used - 1;
  // A document with meshes but no scene still deserves a number.
  const noSceneGeometry = drawCalls === 0 && allPrims.length > 0;
  if (noSceneGeometry) {
    drawnTriangles = triangles;
    drawnVertices = vertices;
    drawCalls = allPrims.length;
  }

  let bounds: GeometryStats['bounds'] = null;
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  if (scene) {
    const b = getBounds(scene);
    if (Number.isFinite(b.min[0])) {
      bounds = {
        min: [...b.min],
        max: [...b.max],
        size: b.max.map((v, i) => v - b.min[i]),
      };
    }
  }

  return {
    meshCount: meshes.length,
    primitiveCount: allPrims.length,
    drawCallEstimate: drawCalls,
    triangles: drawnTriangles,
    vertices: drawnVertices,
    uniqueTriangles: triangles,
    uniqueVertices: vertices,
    instancedNodes,
    primitives,
    primsMissingNormals,
    primsMissingUVs,
    primsUnindexed,
    bounds,
    topology: opts.topology ? computeTopology(allPrims) : null,
  };
}
