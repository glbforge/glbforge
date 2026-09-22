import { Document, Mesh, Node, Primitive, getBounds } from '@gltf-transform/core';
import type { GeometryStats, PrimitiveStats, TopologyStats } from '../types.js';

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
    const canonical = new Uint32Array(vertexCount);
    const seen = new Map<string, number>();
    const seenFull = new Set<string>();
    for (let i = 0; i < vertexCount; i++) {
      const key = pos[i * 3] + '|' + pos[i * 3 + 1] + '|' + pos[i * 3 + 2];
      const existing = seen.get(key);
      if (existing === undefined) {
        seen.set(key, i);
        canonical[i] = i;
      } else {
        canonical[i] = existing;
        duplicateVertexPositions++;
      }
      let fullKey = '';
      for (const a of attrs) {
        const o = i * a.size;
        for (let c = 0; c < a.size; c++) fullKey += a.array[o + c] + ',';
        fullKey += '|';
      }
      if (seenFull.has(fullKey)) redundantVertices++;
      else seenFull.add(fullKey);
    }
    uniquePositions += seen.size;

    const indices = prim.getIndices();
    const triCount = indices ? indices.getCount() / 3 : vertexCount / 3;
    const idx = indices?.getArray() ?? null;

    // Edge incidence in canonical index space. Key packs (min,max) into one
    // number; safe because maxIndex^2 stays far below 2^53 for real meshes.
    const edgeCount = new Map<number, number>();
    for (let t = 0; t < triCount; t++) {
      const a = canonical[idx ? idx[t * 3] : t * 3];
      const b = canonical[idx ? idx[t * 3 + 1] : t * 3 + 1];
      const c = canonical[idx ? idx[t * 3 + 2] : t * 3 + 2];
      if (a === b || b === c || a === c) {
        degenerateTriangles++;
        continue;
      }
      for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
        const key = u < v ? u * vertexCount + v : v * vertexCount + u;
        edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
      }
    }
    for (const count of edgeCount.values()) {
      if (count === 1) boundaryEdges++;
      else if (count > 2) nonManifoldEdges++;
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
