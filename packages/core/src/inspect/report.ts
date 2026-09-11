/**
 * `inspectScene` — the inner-loop read of an asset: the semantic questions
 * an agent gets wrong (is it one piece, is it closed, how big is it in real
 * units, which way is up, where is the origin, are transforms applied),
 * answered as measured facts, plus the rule-pack findings for a profile,
 * plus a deterministic one-paragraph summary.
 *
 * Facts and findings are separate on purpose: findings describe problems
 * (with cause and fix), facts describe the asset whether or not anything
 * is wrong. Anything this report cannot measure says so — `front` is
 * always `unknown` here because no heuristic is honest on the symmetric
 * objects that make up most assets; declare it with an expectation.
 */
import { CATEGORY_SIZES, parseExpectation, type Expectation, type ParsedExpectation } from '../packs/intent.js';
import { runPacks, type RunPacksOptions } from '../packs/registry.js';
import type { PackRunResult, RuleFinding } from '../packs/types.js';
import { classifyOrigin, sceneExtent, type OriginLandmark } from './extent.js';
import type { SceneIR } from './ir.js';
import { meshTopology, type MeshTopology } from './topology.js';

export type { OriginLandmark } from './extent.js';

export interface InspectOptions extends Omit<RunPacksOptions, 'topologyCache' | 'extent' | 'expect'> {
  /** Fraction of the bounding-box size within which the origin counts as "at" a landmark. Default 0.05 (also the core-scene originTolerance param). */
  originTolerance?: number;
  /** What the caller meant to make: free text ("chair, Z-up, single-shell, 0.4-1.2m tall, front -Y") or structured. Runs intent@1. */
  expect?: string | Expectation | null;
}

export type Plausibility = 'unknown' | 'plausible' | 'implausible';

export interface InspectMeshFacts {
  prim_path: string;
  name: string;
  triangles: number;
  vertices: number;
  /** null when the topology pass was disabled or the mesh is not triangles. */
  shells: number | null;
  watertight: boolean | null;
  boundary_loops: number | null;
  boundary_edges: number | null;
  non_manifold_edges: number | null;
  degenerate_triangles: number | null;
}

export interface UnappliedTransform {
  prim_path: string;
  name: string;
  translation: number[];
  /** Rotation angle in degrees (0 = none). */
  rotation_deg: number;
  scale: number[];
  /** True when the node's meshes store quantized positions: this transform is the encoding, not an unapplied edit, and raises no finding. */
  dequantization: boolean;
}

export interface InspectReport {
  format: SceneIR['format'];
  source_path: string | null;
  profile: string;
  packs: string[];
  provenance: PackRunResult['provenance'];
  /** Deterministic one-paragraph reading of the facts and the top findings. */
  summary: string;
  scene: { meshes: number; triangles: number; vertices: number; materials: number; nodes: number; depth: number };
  topology: {
    /** Sum over meshes; null when the pass was disabled. */
    shells: number | null;
    /** Every triangle mesh closed and manifold. */
    watertight: boolean | null;
    meshes: InspectMeshFacts[];
  };
  scale: {
    units: 'm';
    meters_per_unit: number;
    bounding_box: { min: number[]; max: number[]; size: number[] } | null;
    largest_dimension_m: number | null;
    /** Needs a declared category (or explicit range); without one this is honestly unknown. With one, a table prior — see plausibility_basis. */
    plausibility: Plausibility;
    plausibility_basis: { category: string; typical_m: [number, number]; measure: string; confidence: number } | null;
  };
  orientation: {
    up_axis: 'Y' | 'Z';
    /** glTF is Y-up by definition; USD declares it. */
    up_axis_source: 'format' | 'metadata';
    /** Never inferred: symmetric objects defeat every heuristic. `declared` only when the caller said so. */
    front: 'unknown' | string;
    front_source: 'none' | 'declared';
  };
  /** The caller's expectation as parsed, with tokens that could not be placed; null when none was given. */
  expectation: ParsedExpectation | null;
  origin: {
    at: OriginLandmark;
    /** Where the world origin sits inside the bounds, 0 = min … 1 = max per axis; null without geometry. */
    position_in_bounds: number[] | null;
    /** Signed height of the origin above the bottom of the bounds along the up axis (negative = below). */
    height_above_base_m: number | null;
    /** Distance from the origin to the mean vertex position. */
    distance_to_centroid_m: number | null;
    /** Translation that would put the origin at the base centre. */
    offset_to_base_center_m: number[] | null;
  };
  hierarchy: {
    nodes: number;
    mesh_nodes: number;
    depth: number;
    /** Mesh-bearing nodes whose local transform is not identity. */
    unapplied_transforms: UnappliedTransform[];
    non_uniform_scale: string[];
    /** Negative determinant: mirrored, which flips winding. */
    mirrored: string[];
    /** Top-level node names, first eight. */
    root_names: string[];
  };
  findings: RuleFinding[];
  skipped: PackRunResult['skipped'];
}

const fmt = (n: number) => n.toLocaleString('en-US');
const m3 = (v: number[]) => v.map((x) => x.toFixed(2)).join(' × ');
const plural = (n: number, word: string) => `${fmt(n)} ${word}${n === 1 ? '' : /(sh|ch|s|x)$/.test(word) ? 'es' : 's'}`;
const isId = (n: SceneIR['nodes'][number]) =>
  n.translation.every((v) => Math.abs(v) < 1e-9) && n.scale.every((v) => Math.abs(v - 1) < 1e-9) && Math.abs(n.rotation[3]) > 1 - 1e-9;
const det3 = (m: number[]) => m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);

export function inspectScene(ir: SceneIR, opts: InspectOptions = {}): InspectReport {
  const tol = opts.originTolerance ?? 0.05;
  const mpu = ir.metersPerUnit || 1;
  const topologyEnabled = opts.topology !== false;
  const topologyCache = new Map<number, MeshTopology | null>();
  const extent = sceneExtent(ir);

  // --- packs (share the topology memo and the extent) ---
  const { originTolerance: _t, expect: _e, ...packOpts } = opts;
  const expectation = opts.expect ? parseExpectation(opts.expect) : null;
  const params = {
    ...(opts.params ?? {}),
    'core-scene': { originTolerance: tol, ...(opts.params?.['core-scene'] ?? {}) },
    intent: { originTolerance: tol, ...(opts.params?.intent ?? {}) },
  };
  const run = runPacks(ir, { ...packOpts, params, profile: opts.profile ?? 'authoring', topologyCache, extent, expect: expectation?.expectation ?? null });

  // --- per-mesh facts ---
  const meshes: InspectMeshFacts[] = [];
  let tris = 0, verts = 0, shells = 0, watertight = true, anyTopo = false;
  for (const m of ir.meshes) {
    tris += m.triangleCount; verts += m.vertexCount;
    let t: MeshTopology | null = null;
    if (topologyEnabled && m.mode === 'triangles' && m.triangleCount > 0) {
      t = topologyCache.get(m.index) ?? null;
      if (t === null && !topologyCache.has(m.index)) { t = meshTopology(m); topologyCache.set(m.index, t); }
      if (t) { anyTopo = true; shells += t.shells; if (!t.watertight) watertight = false; }
    }
    meshes.push({
      prim_path: m.path, name: m.name, triangles: m.triangleCount, vertices: m.vertexCount,
      shells: t?.shells ?? null, watertight: t?.watertight ?? null, boundary_loops: t?.boundaryLoops ?? null,
      boundary_edges: t?.boundaryEdges ?? null, non_manifold_edges: t?.nonManifoldEdges ?? null, degenerate_triangles: t?.degenerateTriangles ?? null,
    });
  }

  // --- bounds / origin (metres) ---
  const bbox = extent ? { min: extent.min, max: extent.max, size: extent.size } : null;
  const largest = extent?.largest ?? null;
  const placement = extent ? classifyOrigin(extent, tol) : null;
  const at: OriginLandmark = placement?.at ?? 'elsewhere';

  // --- hierarchy ---
  const realNodes = ir.nodes.filter((n) => !n.isJoint);
  const unapplied: UnappliedTransform[] = [];
  const nonUniform: string[] = [], mirrored: string[] = [];
  for (const n of realNodes) {
    if (n.meshes.length === 0) continue;
    if (!isId(n)) {
      const angle = 2 * Math.acos(Math.min(1, Math.abs(n.rotation[3]))) * (180 / Math.PI);
      const dequantization = n.meshes.every((i) => ir.meshes[i]?.positionsQuantized);
      unapplied.push({ prim_path: n.path, name: n.name, translation: n.translation.map((v) => +v.toFixed(6)), rotation_deg: +angle.toFixed(3), scale: n.scale.map((v) => +v.toFixed(6)), dequantization });
    }
    const [sx, sy, sz] = n.scale.map(Math.abs); // sign is mirroring, reported separately
    if (Math.abs(sx - sy) > 1e-6 || Math.abs(sy - sz) > 1e-6) nonUniform.push(n.path);
    if (det3(n.world) < 0) mirrored.push(n.path);
  }
  let depth = 0;
  const visit = (i: number, d: number) => { if (d > depth) depth = d; for (const c of ir.nodes[i].children) visit(c, d + 1); };
  for (const r of ir.roots) visit(r, 1);
  const root_names = ir.roots.slice(0, 8).map((i) => ir.nodes[i].name);

  // --- plausibility: only with a declared category (table prior) or explicit range ---
  let plausibility: Plausibility = 'unknown';
  let plausibility_basis: InspectReport['scale']['plausibility_basis'] = null;
  const cat = expectation?.expectation.category;
  const prior = cat ? CATEGORY_SIZES[cat] ?? CATEGORY_SIZES[cat.replace(/s$/, '')] : undefined;
  if (expectation?.expectation.size) {
    plausibility = run.findings.some((f) => f.rule === 'intent/size') ? 'implausible' : 'plausible';
    plausibility_basis = { category: cat ?? 'explicit range', typical_m: [expectation.expectation.size.min, expectation.expectation.size.max], measure: expectation.expectation.size.measure, confidence: 1 };
  } else if (cat && prior) {
    const f = run.findings.find((x) => x.rule === 'intent/category-scale');
    plausibility = f ? 'implausible' : 'plausible';
    plausibility_basis = { category: cat, typical_m: [prior.min, prior.max], measure: prior.measure, confidence: f?.confidence ?? 0.6 };
  }

  const report: InspectReport = {
    format: ir.format,
    source_path: ir.sourcePath,
    profile: run.profile ?? 'authoring@1',
    packs: run.packs,
    provenance: run.provenance,
    summary: '',
    scene: { meshes: ir.meshes.length, triangles: tris, vertices: verts, materials: ir.materials.length, nodes: realNodes.length, depth },
    topology: { shells: anyTopo ? shells : null, watertight: anyTopo ? watertight : null, meshes },
    scale: { units: 'm', meters_per_unit: mpu, bounding_box: bbox, largest_dimension_m: largest, plausibility, plausibility_basis },
    orientation: {
      up_axis: ir.upAxis, up_axis_source: ir.format.startsWith('usd') ? 'metadata' : 'format',
      front: expectation?.expectation.front ?? 'unknown', front_source: expectation?.expectation.front ? 'declared' : 'none',
    },
    expectation,
    origin: {
      at,
      position_in_bounds: placement?.position_in_bounds ?? null,
      height_above_base_m: placement?.height_above_base_m ?? null,
      distance_to_centroid_m: placement?.distance_to_centroid_m ?? null,
      offset_to_base_center_m: placement?.offset_to_base_center_m ?? null,
    },
    hierarchy: { nodes: realNodes.length, mesh_nodes: realNodes.filter((n) => n.meshes.length).length, depth, unapplied_transforms: unapplied, non_uniform_scale: nonUniform, mirrored, root_names },
    findings: run.findings,
    skipped: run.skipped,
  };
  report.summary = summarize(report);
  return report;
}

/** The paragraph an agent reads first. Facts, then the top three findings. Deterministic. */
export function summarize(r: InspectReport): string {
  const parts: string[] = [];
  const size = r.scale.bounding_box ? `${m3(r.scale.bounding_box.size)} m` : 'no geometry';
  parts.push(`${plural(r.scene.meshes, 'mesh')}, ${fmt(r.scene.triangles)} triangles, ${size}, ${r.orientation.up_axis}-up.`);

  if (r.topology.shells === null) parts.push('Topology not checked.');
  else if (r.topology.shells === 1 && r.topology.watertight) parts.push('One watertight shell.');
  else if (r.topology.shells === 1) parts.push('One shell, not watertight.');
  else parts.push(`${plural(r.topology.shells, 'shell')}, ${r.topology.watertight ? 'all watertight' : 'not watertight'}.`);

  if (r.origin.position_in_bounds) {
    const h = r.origin.height_above_base_m!;
    const where = r.origin.at === 'base-center' ? 'at the base centre'
      : r.origin.at === 'center' ? 'at the bounding-box centre'
        : r.origin.at === 'centroid' ? 'at the vertex centroid'
          : `not on a landmark (${r.origin.position_in_bounds.map((v) => v.toFixed(2)).join(', ')} inside the bounds)`;
    const base = r.origin.at === 'base-center' ? '' : Math.abs(h) < 1e-6 ? ', on the base plane' : h > 0 ? `, ${h.toFixed(2)} m above the base` : `, ${(-h).toFixed(2)} m below the base`;
    parts.push(`Origin ${where}${base}.`);
  }

  const hx = r.hierarchy;
  const bits: string[] = [];
  const realUnapplied = hx.unapplied_transforms.filter((t) => !t.dequantization).length;
  const dequant = hx.unapplied_transforms.length - realUnapplied;
  if (realUnapplied) bits.push(`${plural(realUnapplied, 'mesh node')} with unapplied transforms`);
  if (dequant) bits.push(`${plural(dequant, 'quantized mesh node')} (node transform is the encoding)`);
  if (hx.mirrored.length) bits.push(`${plural(hx.mirrored.length, 'mirrored node')}`);
  if (hx.non_uniform_scale.length) bits.push(`${plural(hx.non_uniform_scale.length, 'node')} with non-uniform scale`);
  parts.push(`${plural(hx.nodes, 'node')}${hx.depth > 1 ? ` (depth ${hx.depth})` : ''}${bits.length ? ': ' + bits.join(', ') : ', transforms applied'}.`);

  parts.push(r.orientation.front_source === 'declared' ? `Front: ${r.orientation.front} (declared, not measured).` : 'Front: unknown (declare it with an expectation).');

  if (r.expectation) {
    const violations = r.findings.filter((f) => f.pack.startsWith('intent@') && f.severity === 'error').length;
    const warned = r.findings.filter((f) => f.pack.startsWith('intent@') && f.severity === 'warning').length;
    const basis = r.scale.plausibility_basis;
    const plaus = r.scale.plausibility === 'unknown' ? '' : ` Size ${r.scale.plausibility} for a ${basis!.category} (${basis!.typical_m.map((v) => v.toFixed(2)).join('–')} m ${basis!.measure}${basis!.confidence < 1 ? `, ${Math.round(basis!.confidence * 100)}% prior` : ''}).`;
    parts.push(`Expectation${r.expectation.raw ? ` "${r.expectation.raw}"` : ''}: ${violations ? `${plural(violations, 'violation')}` : 'met'}${warned ? `, ${plural(warned, 'warning')}` : ''}${r.expectation.unparsed.length ? `; could not parse: ${r.expectation.unparsed.map((u) => `"${u}"`).join(', ')}` : ''}.${plaus}`);
  }

  const top = r.findings.slice(0, 3);
  if (top.length) parts.push(top.map((f) => `${f.severity.toUpperCase()} ${f.rule}: ${f.message}`).join(' '));
  if (r.findings.length > 3) parts.push(`${fmt(r.findings.length - 3)} more finding${r.findings.length - 3 === 1 ? '' : 's'}.`);
  return parts.join(' ');
}
