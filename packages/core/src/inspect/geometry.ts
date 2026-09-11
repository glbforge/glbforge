/**
 * inspect_geometry: per-mesh counts, manifoldness, degenerate faces, normals
 * status and inversion, UV range, world bounds; scene-level bounds, pivot,
 * scale warnings. Everything keyed by prim_path.
 */
import { diag, type Diagnostic } from './diagnostics.js';
import { transformPoint, worldBounds, type IRMesh, type SceneIR } from './ir.js';
import { meshTopology } from './topology.js';

export interface GeometryInspectOptions {
  /** Largest dimension (metres) below which SCALE_TOO_SMALL fires. Default 0.01. */
  smallScale?: number;
  /** Largest dimension (metres) above which SCALE_TOO_LARGE fires. Default 20. */
  largeScale?: number;
  /** Skip the O(n) edge pass (manifold / degenerate). Default false. */
  skipTopology?: boolean;
}

export interface BoundingBox { min: number[]; max: number[]; size: number[] }

export interface MeshGeometryReport {
  prim_path: string;
  name: string;
  node_index: number;
  mesh_index: number;
  primitive_index: number;
  mode: IRMesh['mode'];
  vertex_count: number;
  face_count: number;
  triangle_count: number;
  is_manifold: boolean | null;
  is_closed: boolean | null;
  non_manifold_edge_count: number | null;
  boundary_edge_count: number | null;
  degenerate_face_count: number | null;
  normals: 'authored' | 'generated' | 'missing';
  inverted_normal_face_count: number;
  uv_sets: Array<{ name: string; out_of_range: boolean; min: number[]; max: number[] }>;
  /** World-space bounds in metres. */
  bounding_box: BoundingBox | null;
  material_path: string | null;
  skin_path: string | null;
  morph_target_count: number;
}

export interface GeometryReport {
  meshes: MeshGeometryReport[];
  mesh_count: number;
  total_triangles: number;
  total_vertices: number;
  /** Metres. */
  world_bounding_box: BoundingBox | null;
  largest_dimension_m: number | null;
  /** World position of the asset origin (always the origin) and where it sits inside the bounds, 0 = min … 1 = max per axis. */
  pivot_position: number[];
  pivot_in_bounds: number[] | null;
  pivot_at_base: boolean | null;
  up_axis: 'Y' | 'Z';
  meters_per_unit: number;
  scale_warnings: string[];
  diagnostics: Diagnostic[];
}

/** Welded-space edge counts (shared engine with the rule packs); an empty triangle mesh counts as closed. */
function topology(m: IRMesh): { boundary: number; nonManifold: number; degenerate: number } {
  const t = meshTopology(m);
  return t ? { boundary: t.boundaryEdges, nonManifold: t.nonManifoldEdges, degenerate: t.degenerateTriangles } : { boundary: 0, nonManifold: 0, degenerate: 0 };
}

function invertedNormals(m: IRMesh, flip: boolean): number {
  if (!m.normals || !m.indices) return 0;
  const p = m.positions, nr = m.normals, idx = m.indices;
  let inverted = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
    let fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    if (flip) { fx = -fx; fy = -fy; fz = -fz; }
    const nx = nr[a * 3] + nr[b * 3] + nr[c * 3], ny = nr[a * 3 + 1] + nr[b * 3 + 1] + nr[c * 3 + 1], nz = nr[a * 3 + 2] + nr[b * 3 + 2] + nr[c * 3 + 2];
    if (fx * nx + fy * ny + fz * nz < 0) inverted++;
  }
  return inverted;
}

const det3 = (m: number[]) => m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);

export function inspectGeometry(ir: SceneIR, opts: GeometryInspectOptions = {}): GeometryReport {
  const small = opts.smallScale ?? 0.01, large = opts.largeScale ?? 20;
  const mpu = ir.metersPerUnit || 1;
  const diagnostics: Diagnostic[] = [];
  const meshes: MeshGeometryReport[] = [];
  let totalTris = 0, totalVerts = 0;

  for (const m of ir.meshes) {
    const world = ir.nodes[m.node]?.world;
    const bb = worldBounds(ir, [m]);
    const bounding_box = bb ? { min: bb.min.map((v) => v * mpu), max: bb.max.map((v) => v * mpu), size: bb.size.map((v) => v * mpu) } : null;
    const topo = m.indices && !opts.skipTopology ? topology(m) : null;
    const inverted = m.indices ? invertedNormals(m, !!world && det3(world) < 0) : 0;
    const uv_sets = m.uvs.map((set) => {
      let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
      for (let i = 0; i < set.data.length; i += 2) {
        const u = set.data[i], v = set.data[i + 1];
        if (u < minU) minU = u; if (u > maxU) maxU = u; if (v < minV) minV = v; if (v > maxV) maxV = v;
      }
      if (!Number.isFinite(minU)) { minU = maxU = minV = maxV = 0; }
      const out = minU < -1e-4 || minV < -1e-4 || maxU > 1 + 1e-4 || maxV > 1 + 1e-4;
      return { name: set.name, out_of_range: out, min: [minU, minV], max: [maxU, maxV] };
    });
    totalTris += m.triangleCount; totalVerts += m.vertexCount;
    const report: MeshGeometryReport = {
      prim_path: m.path, name: m.name, node_index: m.node, mesh_index: m.sourceMesh, primitive_index: m.primitiveIndex, mode: m.mode,
      vertex_count: m.vertexCount, face_count: m.faceCount, triangle_count: m.triangleCount,
      is_manifold: topo ? topo.nonManifold === 0 : null,
      is_closed: topo ? topo.nonManifold === 0 && topo.boundary === 0 : null,
      non_manifold_edge_count: topo?.nonManifold ?? null,
      boundary_edge_count: topo?.boundary ?? null,
      degenerate_face_count: topo?.degenerate ?? null,
      normals: m.normalsSource,
      inverted_normal_face_count: inverted,
      uv_sets,
      bounding_box,
      material_path: m.material !== null ? ir.materials[m.material]?.path ?? null : null,
      skin_path: m.skin !== null ? ir.skins[m.skin]?.path ?? null : null,
      morph_target_count: m.targets.length,
    };
    meshes.push(report);

    if (m.mode === 'triangles' && m.triangleCount === 0) diagnostics.push(diag('MESH_EMPTY', m.path, `${m.path} has no triangles.`));
    if (m.mode === 'triangles' && m.normalsSource === 'missing') {
      diagnostics.push(diag('NORMALS_MISSING', m.path, `${m.path} has no normals; viewers will compute their own.`, { property: 'normals' }));
    }
    if (m.triangleCount > 0 && inverted / m.triangleCount > 0.3) {
      diagnostics.push(diag('NORMALS_INVERTED', m.path, `${inverted} of ${m.triangleCount} faces (${Math.round((inverted / m.triangleCount) * 100)}%) have normals pointing against the winding.`, { property: 'normals', data: { inverted, triangles: m.triangleCount } }));
    }
    if (m.mode === 'triangles' && m.uvs.length === 0) diagnostics.push(diag('UV_MISSING', m.path, `${m.path} has no texture coordinates.`, { property: 'primvars:st' }));
    for (const set of uv_sets) {
      if (set.out_of_range) diagnostics.push(diag('UV_OUT_OF_RANGE', m.path, `${set.name} spans [${set.min.map((v) => v.toFixed(2))}]..[${set.max.map((v) => v.toFixed(2))}].`, { property: `primvars:${set.name}`, data: { min: set.min, max: set.max } }));
    }
    if (topo && topo.nonManifold > 0) diagnostics.push(diag('MESH_NON_MANIFOLD', m.path, `${topo.nonManifold} non-manifold edge(s) (shared by 3+ faces).`, { data: { edges: topo.nonManifold } }));
    if (topo && topo.degenerate > 0) diagnostics.push(diag('MESH_DEGENERATE_FACES', m.path, `${topo.degenerate} degenerate face(s).`, { data: { faces: topo.degenerate } }));
  }

  const bb = worldBounds(ir);
  const world_bounding_box = bb ? { min: bb.min.map((v) => v * mpu), max: bb.max.map((v) => v * mpu), size: bb.size.map((v) => v * mpu) } : null;
  const largest = world_bounding_box ? Math.max(...world_bounding_box.size) : null;
  const upIdx = ir.upAxis === 'Z' ? 2 : 1;
  const pivot_in_bounds = world_bounding_box ? world_bounding_box.size.map((s, i) => (s > 0 ? (0 - world_bounding_box.min[i]) / s : 0.5)) : null;
  const pivot_at_base = world_bounding_box ? Math.abs(world_bounding_box.min[upIdx]) <= Math.max(1e-6, 0.02 * (world_bounding_box.size[upIdx] || 1)) : null;
  const scale_warnings: string[] = [];
  const rootPath = ir.format.startsWith('usd') ? ir.defaultPrim ?? '/' : '/Asset';
  if (largest !== null && largest > 0) {
    if (largest < small) {
      const msg = `Largest dimension is ${largest.toPrecision(3)} m (< ${small} m) — coin-sized, or exported in the wrong unit${ir.metersPerUnit !== 1 ? ` (metersPerUnit = ${ir.metersPerUnit})` : ''}.`;
      scale_warnings.push(msg);
      diagnostics.push(diag('SCALE_TOO_SMALL', rootPath, msg, { data: { largest_dimension_m: largest, threshold: small } }));
    } else if (largest > large) {
      const msg = `Largest dimension is ${largest.toPrecision(3)} m (> ${large} m) — too big for AR placement.`;
      scale_warnings.push(msg);
      diagnostics.push(diag('SCALE_TOO_LARGE', rootPath, msg, { data: { largest_dimension_m: largest, threshold: large } }));
    }
  }
  if (world_bounding_box && pivot_at_base === false) {
    diagnostics.push(diag('PIVOT_NOT_AT_BASE', rootPath, `Origin sits ${(-world_bounding_box.min[upIdx]).toFixed(3)} m above the bottom of the bounds (pivot_in_bounds ${pivot_in_bounds!.map((v) => v.toFixed(2)).join(', ')}).`, { data: { min: world_bounding_box.min } }));
  }
  if (ir.format === 'glb' || ir.format === 'gltf') {
    if (world_bounding_box && world_bounding_box.size[2] > 2 * world_bounding_box.size[1] && world_bounding_box.size[2] >= world_bounding_box.size[0]) {
      diagnostics.push(diag('ZUP_SUSPECTED', rootPath, `Bounds are ${world_bounding_box.size[2].toFixed(2)} m along Z but only ${world_bounding_box.size[1].toFixed(2)} m along Y — the asset may be lying on its side.`, { data: { size: world_bounding_box.size } }));
    }
  }

  return {
    meshes, mesh_count: meshes.length, total_triangles: totalTris, total_vertices: totalVerts,
    world_bounding_box, largest_dimension_m: largest,
    pivot_position: [0, 0, 0], pivot_in_bounds, pivot_at_base,
    up_axis: ir.upAxis, meters_per_unit: ir.metersPerUnit, scale_warnings, diagnostics,
  };
}

export { transformPoint };
