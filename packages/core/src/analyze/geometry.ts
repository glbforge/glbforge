import { Document, Primitive, getBounds } from '@gltf-transform/core';
import type { GeometryStats, PrimitiveStats, TopologyStats } from '../types.js';

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
    const uv = prim.getAttribute('TEXCOORD_0')?.getArray() ?? null;
    const nrm = prim.getAttribute('NORMAL')?.getArray() ?? null;

    // Weld map: exact-position key -> canonical index. Position-only
    // duplicates are often *legitimate* (UV-seam splits), so truly
    // redundant vertices — identical across ALL attributes — are counted
    // separately via a second key.
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
      let fullKey = key;
      if (uv) fullKey += '|' + uv[i * 2] + '|' + uv[i * 2 + 1];
      if (nrm) fullKey += '|' + nrm[i * 3] + '|' + nrm[i * 3 + 1] + '|' + nrm[i * 3 + 2];
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
    drawCallEstimate: allPrims.length,
    triangles,
    vertices,
    primitives,
    primsMissingNormals,
    primsMissingUVs,
    primsUnindexed,
    bounds,
    topology: opts.topology ? computeTopology(allPrims) : null,
  };
}
