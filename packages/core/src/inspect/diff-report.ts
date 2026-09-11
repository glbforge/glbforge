/**
 * `diffAssets` — what changed between two versions of an asset, including
 * what the edit broke by accident: triangle / bounds / shell deltas,
 * topology regressions (was watertight, now is not), origin drift, node
 * transform changes, meshes added or removed, and an opt-in visual delta
 * from four canonical cameras fixed to the BEFORE framing.
 *
 * Findings use the same shape as the inspect packs (rule id, severity,
 * measured certainty, cause with confidence, fix) under the `diff@1` pack,
 * and the profile's severity overrides apply. The summary reads like a
 * change note: "'legs' is 30% narrower along X. Origin moved 0.12 m.
 * Watertightness lost on 'seat': 3 open loops appeared."
 */
import type { DiagnosticCode, DiagnosticSeverity } from './diagnostics.js';
import { diffScenes, type SceneDiff } from './diff.js';
import { classifyOrigin, sceneExtent, type OriginPlacement, type SceneExtent } from './extent.js';
import { IDENTITY, transformPoint, type IRMesh, type SceneIR } from './ir.js';
import { renderScene } from './render-ir.js';
import { compareViews } from '../harness/perceptual.js';
import type { RenderCamera } from '../harness/render.js';
import { meshTopology, type MeshTopology } from './topology.js';
import { resolveRuleProfile } from '../packs/registry.js';
import type { Certainty, LikelyCause, RuleFinding, RuleProfile } from '../packs/types.js';
import type { Profile } from '../types.js';

export interface DiffOptions {
  /** Severity source (same as inspect). Default authoring. */
  profile?: string | RuleProfile | Profile;
  /** Welded topology pass on both assets. Default true. */
  topology?: boolean;
  /** Render four canonical views of both (cameras fixed to the BEFORE framing) and score SSIM. Default false. */
  visual?: boolean;
  /** Pixels per view for the visual delta. Default 128. */
  visualSize?: number;
  /** Fraction of the before-bounds beyond which an origin shift counts as moved. Default 0.05. */
  originTolerance?: number;
  /** Fractional size change per axis that counts as a change. Default 0.02. */
  sizeTolerance?: number;
}

export interface Delta { before: number; after: number; delta: number; pct: number | null }
export interface MeshDelta {
  prim_path: string;
  name: string;
  status: 'added' | 'removed' | 'changed' | 'unchanged';
  triangles: Delta | null;
  shells: Delta | null;
  watertight: { before: boolean | null; after: boolean | null };
  boundary_loops: Delta | null;
  non_manifold_edges: Delta | null;
  /** World-space size per axis, metres. */
  size_m: { before: number[] | null; after: number[] | null; pct: number[] | null };
}
export interface TransformChange { prim_path: string; name: string; before: { translation: number[]; rotation: number[]; scale: number[] }; after: { translation: number[]; rotation: number[]; scale: number[] } }
export interface VisualDelta {
  size: number;
  views: Array<{ name: string; ssim: number; coverage: number; camera: { position: number[]; target: number[]; fov: number } }>;
  ssim_min: number;
  ssim_mean: number;
  worst_view: string;
  /** Cameras were fixed to the before asset's framing so a size change reads as a change, not a re-frame. */
  framing: 'before';
}

export interface DiffReport {
  before: { path: string | null; format: SceneIR['format'] };
  after: { path: string | null; format: SceneIR['format'] };
  profile: string;
  pack: 'diff@1';
  changed: boolean;
  summary: string;
  scene: { triangles: Delta; vertices: Delta; meshes: Delta; nodes: Delta; materials: Delta; file_bytes: Delta };
  bounds: { size_before_m: number[] | null; size_after_m: number[] | null; size_pct: number[] | null; center_shift_m: number[] | null; largest: Delta | null };
  topology: {
    shells: Delta | null;
    watertight: { before: boolean | null; after: boolean | null };
    boundary_loops: Delta | null;
    non_manifold_edges: Delta | null;
    degenerate_triangles: Delta | null;
  };
  origin: { before: OriginPlacement | null; after: OriginPlacement | null; shift_m: number | null; moved: boolean };
  transforms: { changed: TransformChange[] };
  meshes: MeshDelta[];
  structural: SceneDiff;
  visual: VisualDelta | null;
  findings: RuleFinding[];
}

// ---------------------------------------------------------------- snapshot

interface MeshSnap { mesh: IRMesh; topo: MeshTopology | null; size: number[] | null }
interface Snap {
  ir: SceneIR;
  extent: SceneExtent | null;
  placement: OriginPlacement | null;
  meshes: Map<string, MeshSnap>;
  totals: { triangles: number; vertices: number; shells: number | null; watertight: boolean | null; loops: number | null; nonManifold: number | null; degenerate: number | null };
  nodes: Map<string, { name: string; translation: number[]; rotation: number[]; scale: number[]; dequantization: boolean }>;
}

const z0 = (v: number) => (v === 0 ? 0 : v);
const r3 = (v: number) => z0(Math.round(v * 1000) / 1000);
const r4 = (v: number) => z0(Math.round(v * 10000) / 10000);
const fmt = (n: number) => n.toLocaleString('en-US');
const pctOf = (b: number, a: number) => (b === 0 ? null : r3((a - b) / b));
const delta = (b: number, a: number): Delta => ({ before: b, after: a, delta: a - b, pct: pctOf(b, a) });
const meshSize = (ir: SceneIR, m: IRMesh): number[] | null => {
  const w = ir.nodes[m.node]?.world ?? IDENTITY;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const p = m.positions;
  for (let i = 0; i < m.vertexCount; i++) {
    const v = transformPoint(w, p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
    for (let a = 0; a < 3; a++) { if (v[a] < min[a]) min[a] = v[a]; if (v[a] > max[a]) max[a] = v[a]; }
  }
  if (!Number.isFinite(min[0])) return null;
  const mpu = ir.metersPerUnit || 1;
  return max.map((v, i) => (v - min[i]) * mpu);
};
const isDequant = (ir: SceneIR, n: SceneIR['nodes'][number]) => n.meshes.length > 0 && n.meshes.every((i) => ir.meshes[i]?.positionsQuantized);

function snapshot(ir: SceneIR, topology: boolean, tol: number): Snap {
  const extent = sceneExtent(ir);
  const meshes = new Map<string, MeshSnap>();
  let triangles = 0, vertices = 0, shells = 0, loops = 0, nonManifold = 0, degenerate = 0, watertight = true, any = false;
  for (const m of ir.meshes) {
    triangles += m.triangleCount; vertices += m.vertexCount;
    const topo = topology && m.mode === 'triangles' && m.triangleCount > 0 ? meshTopology(m) : null;
    if (topo) { any = true; shells += topo.shells; loops += topo.boundaryLoops; nonManifold += topo.nonManifoldEdges; degenerate += topo.degenerateTriangles; if (!topo.watertight) watertight = false; }
    meshes.set(m.path, { mesh: m, topo, size: meshSize(ir, m) });
  }
  const nodes = new Map<string, Snap['nodes'] extends Map<string, infer V> ? V : never>();
  for (const n of ir.nodes) if (!n.isJoint && n.meshes.length) nodes.set(n.path, { name: n.name, translation: n.translation.map(r4), rotation: n.rotation.map(r4), scale: n.scale.map(r4), dequantization: isDequant(ir, n) });
  return {
    ir, extent, placement: extent ? classifyOrigin(extent, tol) : null, meshes,
    totals: { triangles, vertices, shells: any ? shells : null, watertight: any ? watertight : null, loops: any ? loops : null, nonManifold: any ? nonManifold : null, degenerate: any ? degenerate : null },
    nodes,
  };
}

/** Pair meshes by prim path, then by unique name (a re-export can renumber nodes), the rest are added/removed. */
function pairMeshes(b: Snap, a: Snap): Array<{ path: string; before: MeshSnap | null; after: MeshSnap | null }> {
  const out: Array<{ path: string; before: MeshSnap | null; after: MeshSnap | null }> = [];
  const usedAfter = new Set<string>();
  for (const [path, bm] of b.meshes) {
    const am = a.meshes.get(path);
    if (am) { out.push({ path, before: bm, after: am }); usedAfter.add(path); }
  }
  const byNameAfter = new Map<string, string[]>();
  for (const [path, am] of a.meshes) if (!usedAfter.has(path)) byNameAfter.set(am.mesh.name, [...(byNameAfter.get(am.mesh.name) ?? []), path]);
  for (const [path, bm] of b.meshes) {
    if (out.some((o) => o.path === path)) continue;
    const cands = (byNameAfter.get(bm.mesh.name) ?? []).filter((p) => !usedAfter.has(p));
    if (cands.length === 1) { out.push({ path, before: bm, after: a.meshes.get(cands[0])! }); usedAfter.add(cands[0]); }
    else out.push({ path, before: bm, after: null });
  }
  for (const [path, am] of a.meshes) if (!usedAfter.has(path)) out.push({ path, before: null, after: am });
  return out;
}

// ---------------------------------------------------------------- rules

export interface DiffContext {
  before: Snap; after: Snap;
  pairs: ReturnType<typeof pairMeshes>;
  meshDeltas: MeshDelta[];
  transforms: TransformChange[];
  visual: VisualDelta | null;
  opts: Required<Pick<DiffOptions, 'originTolerance' | 'sizeTolerance'>>;
}
type Body = Omit<RuleFinding, 'rule' | 'pack' | 'code' | 'severity' | 'default_severity' | 'certainty'> & { severity?: DiagnosticSeverity };
export interface DiffRule { id: string; summary: string; severity: DiagnosticSeverity; certainty: Certainty; code: DiagnosticCode; check(ctx: DiffContext): Body[] | Body | null }

const PACK = 'diff@1';
const cause = (text: string, confidence: number): LikelyCause => ({ text, confidence });
const metres = (m: number) => (m < 0.01 ? `${(m * 1000).toFixed(2)} mm` : m < 1 ? `${(m * 100).toFixed(1)} cm` : `${m.toFixed(2)} m`);
const signedPct = (p: number) => `${p > 0 ? '+' : '−'}${Math.abs(Math.round(p * 100))}%`;
const AXIS = 'XYZ';
/** "narrower along X", "taller", "shallower along Z": what a change on one axis is called. */
function axisWord(i: number, up: number, pct: number): string {
  if (i === up) return pct > 0 ? 'taller' : 'shorter';
  const horiz = [0, 1, 2].filter((k) => k !== up);
  const first = i === horiz[0];
  return `${pct > 0 ? (first ? 'wider' : 'deeper') : first ? 'narrower' : 'shallower'} along ${AXIS[i]}`;
}
const rule = (spec: Omit<DiffRule, 'check'>, check: DiffRule['check']): DiffRule => ({ ...spec, check });

const sizeChanged = rule(
  { id: 'diff/size-changed', summary: 'The world bounding box changed by more than sizeTolerance on some axis; per-mesh changes name which part.', severity: 'info', certainty: 'measured', code: 'DIFF_SIZE_CHANGED' },
  (ctx) => {
    const b = ctx.before.extent, a = ctx.after.extent;
    if (!b || !a) return null;
    const tol = ctx.opts.sizeTolerance;
    const pct = b.size.map((s, i) => (s > 0 ? (a.size[i] - s) / s : 0));
    const axes = pct.map((p, i) => [p, i] as const).filter(([p]) => Math.abs(p) >= tol);
    const parts = ctx.meshDeltas.filter((m) => m.status === 'changed' && m.size_m.pct?.some((p) => Math.abs(p) >= Math.max(tol, 0.05)))
      .map((m) => { const i = m.size_m.pct!.map((p, k) => [Math.abs(p), k] as const).sort((x, y) => y[0] - x[0])[0][1]; return { m, i, p: m.size_m.pct![i] }; })
      .sort((x, y) => Math.abs(y.p) - Math.abs(x.p)).slice(0, 3);
    if (!axes.length && !parts.length) return null;
    const whole = axes.map(([p, i]) => `${Math.abs(Math.round(p * 100))}% ${axisWord(i, b.up, p)} (${metres(b.size[i])} → ${metres(a.size[i])})`).join(', ');
    const partText = parts.map(({ m, i, p }) => `'${m.name}' is ${Math.abs(Math.round(p * 100))}% ${axisWord(i, b.up, p)}`).join('; ');
    return {
      prim_path: ctx.after.ir.format.startsWith('usd') ? ctx.after.ir.defaultPrim ?? '/' : '/Asset',
      message: `${whole ? `The asset is ${whole}.` : 'The overall bounds are unchanged.'}${partText ? ` ${partText}.` : ''}`,
      likely_cause: parts.length && !axes.length ? cause('A part was reshaped without changing the silhouette of the whole.', 0.6) : cause('Geometry was reshaped, scaled, or replaced by the last edit.', 0.6),
      fix: 'Nothing to do if intended. If not, undo the last edit; the bounding box before is in data.size_before_m.',
      data: { size_before_m: b.size, size_after_m: a.size, pct, parts: parts.map(({ m, i, p }) => ({ prim_path: m.prim_path, axis: AXIS[i], pct: r3(p) })) },
    };
  },
);

const trianglesChanged = rule(
  { id: 'diff/triangles-changed', summary: 'Triangle count changed by at least 1%.', severity: 'info', certainty: 'measured', code: 'DIFF_TRIANGLES_CHANGED' },
  (ctx) => {
    const d = delta(ctx.before.totals.triangles, ctx.after.totals.triangles);
    if (d.delta === 0 || (d.pct !== null && Math.abs(d.pct) < 0.01)) return null;
    return {
      prim_path: '/Asset',
      message: `Triangles ${fmt(d.before)} → ${fmt(d.after)} (${d.pct === null ? `${d.delta > 0 ? '+' : ''}${fmt(d.delta)}` : signedPct(d.pct)}).`,
      likely_cause: d.delta > 0 ? cause('Subdivision, a boolean, or added geometry.', 0.5) : cause('Decimation, deleted geometry, or a merge.', 0.5),
      fix: 'Nothing to do if intended.',
      data: d as unknown as Record<string, unknown>,
    };
  },
);

const perMeshRegressions = (ctx: DiffContext, pick: (b: MeshTopology, a: MeshTopology) => boolean) =>
  ctx.pairs.filter((p) => p.before?.topo && p.after?.topo && pick(p.before.topo, p.after.topo));

const watertightLost = rule(
  { id: 'diff/watertight-lost', summary: 'A mesh that was a closed solid is not any more.', severity: 'warning', certainty: 'measured', code: 'DIFF_WATERTIGHT_LOST' },
  (ctx) => perMeshRegressions(ctx, (b, a) => b.watertight && !a.watertight).map((p) => {
    const a = p.after!.topo!;
    const what = [a.boundaryLoops ? `${fmt(a.boundaryLoops)} open loop${a.boundaryLoops === 1 ? '' : 's'} (${fmt(a.boundaryEdges)} edges)` : '', a.nonManifoldEdges ? `${fmt(a.nonManifoldEdges)} non-manifold edge${a.nonManifoldEdges === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
    return {
      prim_path: p.after!.mesh.path,
      message: `Watertightness lost on '${p.after!.mesh.name}': ${what} appeared.`,
      likely_cause: a.boundaryLoops
        ? cause('The last edit deleted or moved faces without closing the surface, or a boolean left an opening.', 0.7)
        : cause('The last edit overlapped or duplicated faces — a boolean or join whose seam was not cleaned.', 0.7),
      fix: 'Run inspect on the after file: its topo/open-edges and topo/non-manifold findings name the loops and edges. Fill holes / delete interior faces, or undo the edit.',
      data: { boundary_loops: a.boundaryLoops, boundary_edges: a.boundaryEdges, non_manifold_edges: a.nonManifoldEdges },
    };
  }),
);

const openEdgesIntroduced = rule(
  { id: 'diff/open-edges-introduced', summary: 'More boundary loops than before on a mesh that was already open.', severity: 'warning', certainty: 'measured', code: 'DIFF_OPEN_EDGES_INTRODUCED' },
  (ctx) => perMeshRegressions(ctx, (b, a) => !b.watertight && a.boundaryLoops > b.boundaryLoops).map((p) => ({
    prim_path: p.after!.mesh.path,
    message: `'${p.after!.mesh.name}': open loops ${fmt(p.before!.topo!.boundaryLoops)} → ${fmt(p.after!.topo!.boundaryLoops)}.`,
    likely_cause: cause('Faces were deleted or cut without closing the surface.', 0.7),
    fix: 'Fill the new holes, or undo the edit.',
    data: { before: p.before!.topo!.boundaryLoops, after: p.after!.topo!.boundaryLoops },
  })),
);

const nonManifoldIntroduced = rule(
  { id: 'diff/non-manifold-introduced', summary: 'More non-manifold edges than before on a mesh that was already not watertight.', severity: 'warning', certainty: 'measured', code: 'DIFF_NON_MANIFOLD_INTRODUCED' },
  (ctx) => perMeshRegressions(ctx, (b, a) => !b.watertight && a.nonManifoldEdges > b.nonManifoldEdges).map((p) => ({
    prim_path: p.after!.mesh.path,
    message: `'${p.after!.mesh.name}': non-manifold edges ${fmt(p.before!.topo!.nonManifoldEdges)} → ${fmt(p.after!.topo!.nonManifoldEdges)}.`,
    likely_cause: cause('Overlapping or internal faces from a boolean or a join.', 0.7),
    fix: 'Merge by distance and delete interior faces, or undo the edit.',
    data: { before: p.before!.topo!.nonManifoldEdges, after: p.after!.topo!.nonManifoldEdges },
  })),
);

const topologyImproved = rule(
  { id: 'diff/topology-improved', summary: 'A mesh became watertight, or lost open loops / non-manifold edges.', severity: 'info', certainty: 'measured', code: 'DIFF_TOPOLOGY_IMPROVED' },
  (ctx) => perMeshRegressions(ctx, (b, a) => (!b.watertight && a.watertight) || a.boundaryLoops < b.boundaryLoops || a.nonManifoldEdges < b.nonManifoldEdges).map((p) => {
    const b = p.before!.topo!, a = p.after!.topo!;
    return {
      prim_path: p.after!.mesh.path,
      message: !b.watertight && a.watertight
        ? `'${p.after!.mesh.name}' is now watertight (was ${fmt(b.boundaryLoops)} open loop${b.boundaryLoops === 1 ? '' : 's'}, ${fmt(b.nonManifoldEdges)} non-manifold).`
        : `'${p.after!.mesh.name}': open loops ${fmt(b.boundaryLoops)} → ${fmt(a.boundaryLoops)}, non-manifold ${fmt(b.nonManifoldEdges)} → ${fmt(a.nonManifoldEdges)}.`,
      likely_cause: cause('The edit closed holes or cleaned overlapping faces.', 0.7),
      fix: 'Nothing to do.',
      data: { before: { loops: b.boundaryLoops, non_manifold: b.nonManifoldEdges }, after: { loops: a.boundaryLoops, non_manifold: a.nonManifoldEdges } },
    };
  }),
);

const shellsChanged = rule(
  { id: 'diff/shells-changed', summary: 'The connected-shell count changed: pieces detached (warning) or joined (info).', severity: 'warning', certainty: 'measured', code: 'DIFF_SHELLS_CHANGED' },
  (ctx) => {
    const b = ctx.before.totals.shells, a = ctx.after.totals.shells;
    if (b === null || a === null || a === b) return null;
    const more = a > b;
    const pairs = ctx.pairs.filter((p) => p.before?.topo && p.after?.topo && p.after.topo.shells !== p.before.topo.shells);
    const where = pairs.map((p) => `'${p.after!.mesh.name}' ${p.before!.topo!.shells} → ${p.after!.topo!.shells}`).join(', ');
    return {
      prim_path: pairs[0]?.after?.mesh.path ?? '/Asset',
      severity: more ? 'warning' : 'info',
      message: `Shells ${fmt(b)} → ${fmt(a)}: ${more ? `${fmt(a - b)} new separate piece${a - b === 1 ? '' : 's'}` : `${fmt(b - a)} piece${b - a === 1 ? '' : 's'} joined`}${where ? ` (${where})` : ''}.`,
      likely_cause: more
        ? cause('A cut or boolean split geometry off, new parts were added without joining, or debris was left behind.', 0.6)
        : cause('Parts were joined or merged by distance.', 0.7),
      fix: more ? 'If the pieces should be one solid, boolean-union them; inspect the after file for topo/floating-fragments to find debris.' : 'Nothing to do if intended.',
      data: { before: b, after: a },
    };
  },
);

const originMoved = rule(
  { id: 'diff/origin-moved', summary: 'The geometry moved relative to the origin (landmark changed, or the bounds centre shifted beyond originTolerance).', severity: 'warning', certainty: 'measured', code: 'DIFF_ORIGIN_MOVED' },
  (ctx) => {
    const b = ctx.before, a = ctx.after;
    if (!b.extent || !a.extent || !b.placement || !a.placement) return null;
    const shift = [0, 1, 2].map((i) => (a.extent!.min[i] + a.extent!.max[i]) / 2 - (b.extent!.min[i] + b.extent!.max[i]) / 2);
    const dist = Math.hypot(...shift);
    const moved = b.placement.at !== a.placement.at || dist > ctx.opts.originTolerance * b.extent.largest;
    if (!moved) return null;
    const name = (l: OriginPlacement['at']) => (l === 'base-center' ? 'the base centre' : l === 'center' ? 'the bounding-box centre' : l === 'centroid' ? 'the vertex centroid' : 'no landmark');
    return {
      prim_path: '/Asset',
      message: `The geometry moved ${metres(dist)} relative to the origin (bounds centre shifted by (${shift.map((v) => +v.toFixed(3)).join(', ')}) m); the origin was at ${name(b.placement.at)}, now at ${name(a.placement.at)}.`,
      likely_cause: cause('The object was translated in the scene, its origin was reset, or a transform was applied that included a translation.', 0.6),
      fix: `If unintended, translate the geometry back by (${shift.map((v) => +(-v).toFixed(3)).join(', ')}) m. To put the origin at the base centre now, translate by (${a.placement.offset_to_base_center_m.map((v) => +v.toFixed(3)).join(', ')}) m.`,
      data: { shift_m: shift, distance_m: dist, before: b.placement.at, after: a.placement.at },
    };
  },
);

const transformChanged = rule(
  { id: 'diff/transform-changed', summary: 'A mesh-bearing node\'s local transform changed (dequantization transforms excluded).', severity: 'warning', certainty: 'measured', code: 'DIFF_TRANSFORM_CHANGED' },
  (ctx) => ctx.transforms.map((t) => {
    const parts: string[] = [];
    const same = (x: number[], y: number[]) => x.every((v, i) => Math.abs(v - y[i]) < 1e-6);
    if (!same(t.before.translation, t.after.translation)) parts.push(`translation (${t.before.translation.join(', ')}) → (${t.after.translation.join(', ')})`);
    if (!same(t.before.rotation, t.after.rotation)) parts.push('rotation changed');
    if (!same(t.before.scale, t.after.scale)) parts.push(`scale (${t.before.scale.join(', ')}) → (${t.after.scale.join(', ')})`);
    return {
      prim_path: t.prim_path,
      message: `Node '${t.name}': ${parts.join(', ')}.`,
      likely_cause: cause('The object transform was edited (moved, rotated or scaled at object level) rather than the mesh.', 0.7),
      fix: 'Apply the transform if the change is intended geometry; otherwise reset it.',
      data: { before: t.before, after: t.after },
    };
  }),
);

const meshesRemoved = rule(
  { id: 'diff/meshes-removed', summary: 'Mesh primitives present before are gone.', severity: 'info', certainty: 'measured', code: 'DIFF_MESHES_REMOVED' },
  (ctx) => {
    const gone = ctx.meshDeltas.filter((m) => m.status === 'removed');
    if (!gone.length) return null;
    return {
      prim_path: gone[0].prim_path,
      message: `${fmt(gone.length)} mesh${gone.length === 1 ? '' : 'es'} removed: ${gone.map((m) => `'${m.name}' (${fmt(m.triangles!.before)} tris)`).join(', ')}.`,
      likely_cause: cause('Deleted, joined into another mesh, or renamed and renumbered on export.', 0.5),
      fix: 'Nothing to do if intended; if a join, the triangles show up in the surviving mesh.',
      data: { removed: gone.map((m) => m.prim_path) },
    };
  },
);

const meshesAdded = rule(
  { id: 'diff/meshes-added', summary: 'New mesh primitives appeared.', severity: 'info', certainty: 'measured', code: 'DIFF_MESHES_ADDED' },
  (ctx) => {
    const added = ctx.meshDeltas.filter((m) => m.status === 'added');
    if (!added.length) return null;
    return {
      prim_path: added[0].prim_path,
      message: `${fmt(added.length)} mesh${added.length === 1 ? '' : 'es'} added: ${added.map((m) => `'${m.name}' (${fmt(m.triangles!.after)} tris)`).join(', ')}.`,
      likely_cause: cause('New objects were created or separated from an existing mesh.', 0.5),
      fix: 'Nothing to do if intended.',
      data: { added: added.map((m) => m.prim_path) },
    };
  },
);

const visualChanged = rule(
  { id: 'diff/visual-changed', summary: 'Canonical-view SSIM below 0.995 on some view (only when visual=true).', severity: 'info', certainty: 'measured', code: 'DIFF_VISUAL_CHANGED' },
  (ctx) => {
    const v = ctx.visual;
    if (!v || v.ssim_min >= 0.995) return null;
    const ranked = [...v.views].sort((x, y) => x.ssim - y.ssim);
    const unchanged = ranked.filter((x) => x.ssim >= 0.995).map((x) => x.name);
    return {
      prim_path: '/Asset',
      message: `${ranked[0].name} view changed most (SSIM ${ranked[0].ssim.toFixed(3)})${ranked.length > 1 ? `, then ${ranked.slice(1).filter((x) => x.ssim < 0.995).map((x) => `${x.name} ${x.ssim.toFixed(3)}`).join(', ') || 'nothing else'}` : ''}${unchanged.length ? `; ${unchanged.join(', ')} unchanged` : ''}.`,
      likely_cause: cause('The edit is visible from those angles; cameras were fixed to the before framing so a size change reads as a change, not a re-frame.', 0.8),
      fix: 'Nothing to do if intended. Render both files from the worst view to see it.',
      data: { ssim_min: v.ssim_min, ssim_mean: v.ssim_mean, worst_view: v.worst_view, views: v.views.map((x) => ({ name: x.name, ssim: x.ssim })) },
    };
  },
);

export const diffV1 = {
  name: 'diff' as const,
  version: 1 as const,
  description: 'What changed between two versions: size / triangle / shell deltas, topology regressions and improvements, origin drift, node transforms, meshes added or removed, visual delta.',
  rules: [watertightLost, openEdgesIntroduced, nonManifoldIntroduced, shellsChanged, originMoved, transformChanged, sizeChanged, trianglesChanged, meshesRemoved, meshesAdded, topologyImproved, visualChanged] as DiffRule[],
};

export function listDiffRules() {
  return diffV1.rules.map((r) => ({ id: r.id, pack: PACK, severity: r.severity, certainty: r.certainty, code: r.code, summary: r.summary }));
}

// ---------------------------------------------------------------- visual

/** Four canonical cameras: front, side (+X), top, and a 3/4 iso; unit-sphere positions like the other rigs. */
export function canonicalRig(): RenderCamera[] {
  const unit = (v: [number, number, number]): [number, number, number] => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; };
  return [
    { name: 'front', position: [0, 0.08, 0.997], fovDeg: 35 },
    { name: 'side', position: [0.997, 0.08, 0], fovDeg: 35 },
    { name: 'top', position: unit([0.05, 0.99, 0.15]), fovDeg: 35 },
    { name: 'iso', position: unit([0.6, 0.5, 0.62]), fovDeg: 35 },
  ];
}

async function visualDelta(before: SceneIR, after: SceneIR, size: number): Promise<VisualDelta> {
  const cameras = canonicalRig();
  const b = await renderScene(before, { cameras, size, supersample: 1 });
  const a = await renderScene(after, { cameras, size, supersample: 1, frame: b.frame });
  const cmp = compareViews(b.views, a.views);
  return {
    size,
    views: cmp.views.map((v, i) => ({ name: v.name, ssim: v.ssim, coverage: v.coverage, camera: { position: b.views[i].camera.position, target: b.views[i].camera.target, fov: b.views[i].camera.fovDeg } })),
    ssim_min: cmp.ssimMin, ssim_mean: cmp.ssimMean, worst_view: cmp.worstView, framing: 'before',
  };
}

// ---------------------------------------------------------------- report

const RANK: Record<DiagnosticSeverity, number> = { error: 0, warning: 1, info: 2 };

export async function diffAssets(before: SceneIR, after: SceneIR, opts: DiffOptions = {}): Promise<DiffReport> {
  const topology = opts.topology !== false;
  const o = { originTolerance: opts.originTolerance ?? 0.05, sizeTolerance: opts.sizeTolerance ?? 0.02 };
  const b = snapshot(before, topology, o.originTolerance);
  const a = snapshot(after, topology, o.originTolerance);
  const pairs = pairMeshes(b, a);

  const meshDeltas: MeshDelta[] = pairs.map(({ path, before: bm, after: am }) => {
    const d = (x: number | null | undefined, y: number | null | undefined): Delta | null => (x == null || y == null ? null : delta(x, y));
    const status: MeshDelta['status'] = !bm ? 'added' : !am ? 'removed'
      : bm.mesh.triangleCount !== am.mesh.triangleCount || bm.topo?.shells !== am.topo?.shells || bm.topo?.watertight !== am.topo?.watertight
        || bm.topo?.boundaryLoops !== am.topo?.boundaryLoops || bm.topo?.nonManifoldEdges !== am.topo?.nonManifoldEdges
        || JSON.stringify(bm.size?.map(r4)) !== JSON.stringify(am.size?.map(r4)) ? 'changed' : 'unchanged';
    return {
      prim_path: am?.mesh.path ?? path,
      name: (am ?? bm)!.mesh.name,
      status,
      triangles: d(bm?.mesh.triangleCount, am?.mesh.triangleCount) ?? (bm ? { before: bm.mesh.triangleCount, after: 0, delta: -bm.mesh.triangleCount, pct: -1 } : am ? { before: 0, after: am.mesh.triangleCount, delta: am.mesh.triangleCount, pct: null } : null),
      shells: d(bm?.topo?.shells, am?.topo?.shells),
      watertight: { before: bm?.topo?.watertight ?? null, after: am?.topo?.watertight ?? null },
      boundary_loops: d(bm?.topo?.boundaryLoops, am?.topo?.boundaryLoops),
      non_manifold_edges: d(bm?.topo?.nonManifoldEdges, am?.topo?.nonManifoldEdges),
      size_m: { before: bm?.size ?? null, after: am?.size ?? null, pct: bm?.size && am?.size ? bm.size.map((s, i) => (s > 0 ? r3((am.size![i] - s) / s) : 0)) : null },
    };
  });

  const transforms: TransformChange[] = [];
  for (const [path, bn] of b.nodes) {
    const an = a.nodes.get(path);
    if (!an || bn.dequantization || an.dequantization) continue;
    const same = (x: number[], y: number[]) => x.every((v, i) => Math.abs(v - y[i]) < 1e-6);
    if (!same(bn.translation, an.translation) || !same(bn.rotation, an.rotation) || !same(bn.scale, an.scale)) {
      transforms.push({ prim_path: path, name: an.name, before: { translation: bn.translation, rotation: bn.rotation, scale: bn.scale }, after: { translation: an.translation, rotation: an.rotation, scale: an.scale } });
    }
  }

  const visual = opts.visual ? await visualDelta(before, after, opts.visualSize ?? 128) : null;
  const ctx: DiffContext = { before: b, after: a, pairs, meshDeltas, transforms, visual, opts: o };

  const profile = resolveRuleProfile(opts.profile ?? 'authoring');
  const findings: RuleFinding[] = [];
  for (const r of diffV1.rules) {
    const out = r.check(ctx);
    if (!out) continue;
    for (const f of Array.isArray(out) ? out : [out]) {
      const { severity: bodySeverity, ...rest } = f;
      const base = bodySeverity ?? r.severity;
      findings.push({ rule: r.id, pack: PACK, code: r.code, severity: profile.severity[r.id] ?? base, default_severity: base, certainty: r.certainty, ...rest });
    }
  }
  const ordered = findings.map((f, i) => [f, i] as const).sort((x, y) => RANK[x[0].severity] - RANK[y[0].severity] || x[1] - y[1]).map(([f]) => f);

  const shift = b.extent && a.extent ? [0, 1, 2].map((i) => r4((a.extent!.min[i] + a.extent!.max[i]) / 2 - (b.extent!.min[i] + b.extent!.max[i]) / 2)) : null;
  const structural = diffScenes(before, after);
  const report: DiffReport = {
    before: { path: before.sourcePath, format: before.format },
    after: { path: after.sourcePath, format: after.format },
    profile: `${profile.name}@${profile.version}`,
    pack: 'diff@1',
    changed: false,
    summary: '',
    scene: {
      triangles: delta(b.totals.triangles, a.totals.triangles), vertices: delta(b.totals.vertices, a.totals.vertices),
      meshes: delta(before.meshes.length, after.meshes.length), nodes: delta(before.nodes.filter((n) => !n.isJoint).length, after.nodes.filter((n) => !n.isJoint).length),
      materials: delta(before.materials.length, after.materials.length), file_bytes: delta(before.fileBytes, after.fileBytes),
    },
    bounds: {
      size_before_m: b.extent?.size.map(r4) ?? null, size_after_m: a.extent?.size.map(r4) ?? null,
      size_pct: b.extent && a.extent ? b.extent.size.map((s, i) => (s > 0 ? r3((a.extent!.size[i] - s) / s) : 0)) : null,
      center_shift_m: shift, largest: b.extent && a.extent ? delta(r4(b.extent.largest), r4(a.extent.largest)) : null,
    },
    topology: {
      shells: b.totals.shells !== null && a.totals.shells !== null ? delta(b.totals.shells, a.totals.shells) : null,
      watertight: { before: b.totals.watertight, after: a.totals.watertight },
      boundary_loops: b.totals.loops !== null && a.totals.loops !== null ? delta(b.totals.loops, a.totals.loops) : null,
      non_manifold_edges: b.totals.nonManifold !== null && a.totals.nonManifold !== null ? delta(b.totals.nonManifold, a.totals.nonManifold) : null,
      degenerate_triangles: b.totals.degenerate !== null && a.totals.degenerate !== null ? delta(b.totals.degenerate, a.totals.degenerate) : null,
    },
    origin: { before: b.placement, after: a.placement, shift_m: shift ? r4(Math.hypot(...shift)) : null, moved: ordered.some((f) => f.rule === 'diff/origin-moved') },
    transforms: { changed: transforms },
    meshes: meshDeltas,
    structural,
    visual,
    findings: ordered,
  };
  report.changed = ordered.length > 0 || structural.added_prims.length > 0 || structural.removed_prims.length > 0 || structural.changed_properties.length > 0 || report.scene.file_bytes.delta !== 0;
  report.summary = summarizeDiff(report);
  return report;
}

/** The change note an agent reads first. Regressions before neutral changes; deterministic. */
export function summarizeDiff(r: DiffReport): string {
  if (!r.changed) return 'No change.';
  if (r.findings.length === 0) return `No geometric change (${r.structural.summary}${r.scene.file_bytes.delta ? `; file ${fmt(r.scene.file_bytes.before)} → ${fmt(r.scene.file_bytes.after)} bytes` : ''}).`;
  const order = ['diff/size-changed', 'diff/triangles-changed', 'diff/shells-changed', 'diff/watertight-lost', 'diff/open-edges-introduced', 'diff/non-manifold-introduced', 'diff/origin-moved', 'diff/transform-changed', 'diff/meshes-added', 'diff/meshes-removed', 'diff/topology-improved', 'diff/visual-changed'];
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const id of order) {
    const fs = r.findings.filter((f) => f.rule === id);
    if (!fs.length) continue;
    seen.add(id);
    const shown = fs.slice(0, 2).map((f) => f.message.replace(/\.$/, ''));
    parts.push(shown.join('. ') + (fs.length > 2 ? ` (+${fs.length - 2} more)` : '') + '.');
  }
  for (const f of r.findings) if (!seen.has(f.rule)) parts.push(f.message);
  const regressions = r.findings.filter((f) => f.severity !== 'info').length;
  return `${parts.join(' ')}${regressions ? ` ${regressions} regression${regressions === 1 ? '' : 's'} at warning or above.` : ''}`;
}
