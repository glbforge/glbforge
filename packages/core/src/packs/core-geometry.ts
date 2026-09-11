/**
 * core-geometry@1 — welded-space topology facts every authoring loop needs:
 * is it one piece, is it closed, is anything overlapping, is there debris.
 *
 * Every rule here is MEASURED: the message states counts. The reading of
 * those counts ("an open sheet", "a boolean leftover", "a simplification
 * artifact") is in `likely_cause` with an authored confidence.
 */
import type { IRMesh } from '../inspect/ir.js';
import type { LikelyCause, Rule, RuleContext, RuleFinding, RulePack } from './types.js';

const PACK = 'core-geometry@1';
const fmt = (n: number) => n.toLocaleString('en-US');
const pct = (part: number, whole: number) => `${((100 * part) / Math.max(1, whole)).toFixed(part / Math.max(1, whole) < 0.01 ? 2 : 0)}%`;
const plural = (n: number, word: string) => `${fmt(n)} ${word}${n === 1 ? '' : 's'}`;
const cause = (text: string, confidence: number): LikelyCause => ({ text, confidence });

/** Rule over every triangle mesh with topology available. */
const perMesh = (
  spec: Omit<Rule, 'check' | 'needs'>,
  body: (m: IRMesh, ctx: RuleContext) => Omit<RuleFinding, 'rule' | 'pack' | 'code' | 'severity' | 'default_severity' | 'certainty'> | null,
): Rule => ({
  ...spec,
  needs: 'topology',
  check(ctx) {
    const out: RuleFinding[] = [];
    for (const m of ctx.ir.meshes) {
      if (m.mode !== 'triangles' || m.triangleCount === 0) continue;
      const f = body(m, ctx);
      if (f) out.push({ rule: spec.id, pack: PACK, code: spec.code, severity: spec.severity, default_severity: spec.severity, certainty: spec.certainty, ...f });
    }
    return out;
  },
});

/** "Passed through glbforge optimize" as a hedged sentence, or null. */
const optimizedNote = (ctx: RuleContext): string | null =>
  ctx.provenance.optimized
    ? `The file carries ${ctx.provenance.evidence.join(' + ')}, the signature of glbforge optimize — a proxy, not proof, since compression and simplification are separate steps.`
    : null;

const openEdges = perMesh(
  {
    id: 'topo/open-edges',
    summary: 'The mesh is not closed: edges with only one face exist after welding by position (real holes or an open surface, not UV seams).',
    severity: 'warning', certainty: 'measured', code: 'TOPO_OPEN_EDGES',
  },
  (m, ctx) => {
    const t = ctx.topology(m)!;
    if (t.boundaryEdges === 0) return null;
    // A grid of t triangles has ~2.8·√t boundary edges; one loop that long runs around the whole mesh.
    const sheetLike = t.boundaryLoops === 1 && t.boundaryEdges > Math.sqrt(m.triangleCount) * 2;
    return {
      prim_path: m.path,
      message: `${m.name} is not a closed surface: ${plural(t.boundaryLoops, 'boundary loop')} totalling ${plural(t.boundaryEdges, 'open edge')} after welding by position.`,
      likely_cause: sheetLike
        ? cause('An open sheet rather than a hole in a body: the single boundary is long enough to run around the whole mesh (a plane, an extruded profile without caps, or a shell whose back was never modelled).', 0.8)
        : t.boundaryLoops <= 3
          ? cause('Holes in a body: faces deleted or never capped (an unclosed extrusion, a missing bottom), or an opening left by a boolean.', 0.7)
          : cause('Many small openings: faces dropped by a modifier or a decimation, or geometry that was never joined.', 0.5),
      fix: sheetLike
        ? 'If a solid was intended, give it thickness (Solidify) or model the back and cap the ends. If a sheet is intended, this is fine for display; it cannot be printed.'
        : 'Fill the holes (Blender: select non-manifold → Mesh › Clean Up › Fill Holes, or F on the boundary loop). Welding is already exact-position, so only true gaps remain.',
      data: { boundary_edges: t.boundaryEdges, boundary_loops: t.boundaryLoops, triangles: m.triangleCount },
    };
  },
);

const nonManifold = perMesh(
  {
    id: 'topo/non-manifold',
    summary: 'Edges shared by three or more faces after welding: overlapping, duplicated or internal geometry.',
    severity: 'warning', certainty: 'measured', code: 'MESH_NON_MANIFOLD',
  },
  (m, ctx) => {
    const t = ctx.topology(m)!;
    if (t.nonManifoldEdges === 0) return null;
    const share = t.nonManifoldEdges / Math.max(1, m.triangleCount);
    const optimized = optimizedNote(ctx);
    let likely_cause: LikelyCause;
    if (optimized && share < 0.01) {
      likely_cause = cause(`A simplification artifact rather than an authoring error: a small number of edges pinched during decimation. ${optimized}`, 0.7);
    } else if (share > 0.2) {
      likely_cause = cause('Whole surfaces are doubled: the mesh was duplicated in place, or two copies were joined without removing one.', 0.6);
    } else {
      likely_cause = cause('Internal faces or overlapping geometry left by a boolean or a join — typically where two parts meet.', 0.5);
    }
    return {
      prim_path: m.path,
      message: `${m.name} has ${plural(t.nonManifoldEdges, 'non-manifold edge')} (${pct(t.nonManifoldEdges, m.triangleCount)} of its triangle count): faces meet three or more to an edge.`,
      likely_cause,
      fix: optimized && share < 0.01
        ? 'Harmless for display. For printing or booleans, repair the source mesh rather than this optimized file, then re-optimize.'
        : 'Merge by distance, then delete interior faces (Blender: Select › Select All by Trait › Interior Faces). Booleans: apply with the Exact solver and check the seam where the parts join.',
      data: { non_manifold_edges: t.nonManifoldEdges, triangles: m.triangleCount, optimized: ctx.provenance.optimized },
    };
  },
);

const degenerate = perMesh(
  {
    id: 'topo/degenerate',
    summary: 'Zero-area triangles (repeated or position-coincident corners).',
    severity: 'info', certainty: 'measured', code: 'MESH_DEGENERATE_FACES',
  },
  (m, ctx) => {
    const t = ctx.topology(m)!;
    if (t.degenerateTriangles === 0) return null;
    const optimized = optimizedNote(ctx);
    return {
      prim_path: m.path,
      message: `${m.name} has ${plural(t.degenerateTriangles, 'zero-area triangle')}.`,
      likely_cause: optimized
        ? cause(`Edges collapsed by decimation. ${optimized}`, 0.7)
        : cause('Collapsed edges from decimation, or a merge-by-distance with too large a threshold.', 0.5),
      fix: 'Harmless for display; glbforge optimize prunes them. For printing or booleans, Mesh › Clean Up › Degenerate Dissolve.',
      data: { degenerate_triangles: t.degenerateTriangles, optimized: ctx.provenance.optimized },
    };
  },
);

const shells = perMesh(
  {
    id: 'topo/shells',
    summary: 'The mesh is more than one connected piece of surface (welded space).',
    severity: 'info', certainty: 'measured', code: 'TOPO_SHELLS',
  },
  (m, ctx) => {
    const t = ctx.topology(m)!;
    if (t.shells <= 1) return null;
    const largest = t.shellTriangles[0];
    return {
      prim_path: m.path,
      message: `${m.name} is ${plural(t.shells, 'separate piece')}, not one connected surface; the largest carries ${pct(largest, m.triangleCount)} of the triangles.`,
      likely_cause: largest / m.triangleCount > 0.9
        ? cause('One main body plus small separate parts: details, debris, or parts placed but never joined.', 0.6)
        : cause('Several parts modelled or generated separately and kept in one mesh without being joined.', 0.5),
      fix: 'Fine if the parts are meant to be separate. If they should be one solid, join them with a boolean union (or bridge the faces); merge by distance only closes gaps that are already touching.',
      data: { shells: t.shells, shell_triangles: t.shellTriangles.slice(0, 16), triangles: m.triangleCount },
    };
  },
);

const floatingFragments = perMesh(
  {
    id: 'topo/floating-fragments',
    summary: 'Tiny disconnected pieces (below fragmentFraction of the mesh) — debris rather than parts.',
    severity: 'warning', certainty: 'measured', code: 'TOPO_FLOATING_FRAGMENTS',
  },
  (m, ctx) => {
    const t = ctx.topology(m)!;
    if (t.shells <= 1) return null;
    const fraction = Number(ctx.params.fragmentFraction);
    const limit = Math.max(1, Math.floor(m.triangleCount * fraction));
    const fragments = t.shellTriangles.filter((n) => n <= limit);
    if (fragments.length === 0 || fragments.length === t.shells) return null;
    const biggest = fragments[0];
    return {
      prim_path: m.path,
      message: `${m.name} carries ${plural(fragments.length, 'floating fragment')} of at most ${fmt(biggest)} triangles each (under ${(fraction * 100).toFixed(fraction < 0.01 ? 1 : 0)}% of the mesh) beside its ${plural(t.shells - fragments.length, 'real piece')}.`,
      likely_cause: cause('Leftovers from a boolean or a knife cut, duplicated faces, or stray geometry that was never deleted.', 0.7),
      fix: 'Delete loose geometry (Blender: Select › Select All by Trait › Loose Geometry, or Mesh › Clean Up › Delete Loose). If a fragment is a real detail, join it to the body instead.',
      data: { fragments: fragments.length, largest_fragment_triangles: biggest, threshold_triangles: limit, shells: t.shells },
    };
  },
);

export const coreGeometryV1: RulePack = {
  name: 'core-geometry',
  version: 1,
  description: 'Welded-space topology: open edges, non-manifold edges, degenerate faces, connected shells, floating fragments.',
  params: {
    fragmentFraction: { default: 0.01, description: 'A shell with at most this fraction of the mesh\'s triangles counts as a floating fragment.' },
  },
  rules: [openEdges, nonManifold, floatingFragments, shells, degenerate],
};
