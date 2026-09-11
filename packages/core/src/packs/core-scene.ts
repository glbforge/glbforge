/**
 * core-scene@1 — where the asset sits and how it is assembled: origin
 * placement, unapplied node transforms, mirroring, non-uniform scale, and
 * real-unit scale sanity. All measured; causes carry their own confidence.
 */
import { classifyOrigin } from '../inspect/extent.js';
import type { LikelyCause, Rule, RuleContext, RuleFinding, RulePack } from './types.js';

const PACK = 'core-scene@1';
const cause = (text: string, confidence: number): LikelyCause => ({ text, confidence });
const v3 = (v: number[]) => `(${v.map((x) => +x.toFixed(3)).join(', ')})`;
const metres = (m: number) => (m < 0.01 ? `${(m * 1000).toFixed(2)} mm` : m < 1 ? `${(m * 100).toFixed(1)} cm` : `${m.toFixed(2)} m`);
const axisName = (i: number) => 'XYZ'[i];

type Body = Omit<RuleFinding, 'rule' | 'pack' | 'code' | 'severity' | 'default_severity' | 'certainty'>;
const rule = (spec: Omit<Rule, 'check'>, body: (ctx: RuleContext) => Body[] | Body | null): Rule => ({
  ...spec,
  check(ctx) {
    const out = body(ctx);
    if (!out) return null;
    return (Array.isArray(out) ? out : [out]).map((f) => ({ rule: spec.id, pack: PACK, code: spec.code, severity: spec.severity, default_severity: spec.severity, certainty: spec.certainty, ...f }));
  },
});

const originOutside = rule(
  {
    id: 'origin/outside-bounds',
    summary: 'The world origin lies outside the geometry\'s bounding box — the object floats away from its pivot.',
    severity: 'warning', certainty: 'measured', code: 'ORIGIN_OUTSIDE_BOUNDS',
  },
  (ctx) => {
    const e = ctx.extent();
    if (!e) return null;
    const o = classifyOrigin(e, Number(ctx.params.originTolerance));
    if (o.inside_bounds) return null;
    const gap = Math.hypot(...[0, 1, 2].map((i) => (0 < e.min[i] ? e.min[i] : 0 > e.max[i] ? e.max[i] : 0)));
    return {
      prim_path: ctx.rootPath,
      message: `The origin is outside the geometry: the nearest point of the bounds is ${metres(gap)} away (origin sits at ${v3(o.position_in_bounds)} in bounds units, where 0..1 is inside).`,
      likely_cause: cause('The object was moved in the scene without moving its origin, or it was exported at its world position from a scene where it sits away from the world origin.', 0.7),
      fix: `Set the origin to the geometry before export (Blender: Object › Set Origin › Origin to Geometry, or to the bottom for placement), or bake the node translation. Translating the geometry by ${v3(o.offset_to_base_center_m)} m puts the origin at the base centre.`,
      data: { position_in_bounds: o.position_in_bounds, gap_m: gap, offset_to_base_center_m: o.offset_to_base_center_m },
    };
  },
);

const originNotAtBase = rule(
  {
    id: 'origin/not-at-base',
    summary: 'The origin is inside the bounds but not at the base centre, so surface placement (AR, print bed, floor) floats or sinks the asset.',
    severity: 'info', certainty: 'measured', code: 'PIVOT_NOT_AT_BASE',
  },
  (ctx) => {
    const e = ctx.extent();
    if (!e) return null;
    const o = classifyOrigin(e, Number(ctx.params.originTolerance));
    if (!o.inside_bounds || o.at === 'base-center') return null;
    const where = o.at === 'center' ? 'at the bounding-box centre' : o.at === 'centroid' ? 'at the vertex centroid' : `at ${v3(o.position_in_bounds)} in bounds units`;
    const h = o.height_above_base_m;
    return {
      prim_path: ctx.rootPath,
      message: `The origin is ${where}, ${metres(Math.abs(h))} ${h >= 0 ? 'above' : 'below'} the bottom of the bounds along ${axisName(e.up)}.`,
      likely_cause: o.at === 'center' || o.at === 'centroid'
        ? cause('A generator default or "origin to geometry": pivots land at the centre unless placed deliberately.', 0.6)
        : cause('The mesh was modelled away from its object origin, or the pivot was never set.', 0.5),
      fix: `Fine for a free-floating hero. For placement on a surface, translate the geometry by ${v3(o.offset_to_base_center_m)} m so the bounds' minimum on ${axisName(e.up)} is 0 and the footprint is centred (Blender: Set Origin › Origin to 3D Cursor with the cursor at the bottom centre).`,
      data: { at: o.at, position_in_bounds: o.position_in_bounds, height_above_base_m: h, offset_to_base_center_m: o.offset_to_base_center_m },
    };
  },
);

const isIdentity = (n: RuleContext['ir']['nodes'][number]) =>
  n.translation.every((v) => Math.abs(v) < 1e-9) && n.scale.every((v) => Math.abs(v - 1) < 1e-9) && Math.abs(n.rotation[3]) > 1 - 1e-9;
const det3 = (m: number[]) => m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
const meshNodes = (ctx: RuleContext) => ctx.ir.nodes.filter((n) => !n.isJoint && n.meshes.length > 0);
/** A node whose meshes all store quantized positions carries the dequantization transform, which is encoding, not an unapplied edit. */
const dequantizing = (ctx: RuleContext, n: RuleContext['ir']['nodes'][number]) => n.meshes.every((i) => ctx.ir.meshes[i]?.positionsQuantized);

const unapplied = rule(
  {
    id: 'xform/unapplied',
    summary: 'A mesh-bearing node carries a non-identity transform, so the mesh\'s own coordinates differ from what is seen (quantized meshes are exempt: their node transform is the encoding).',
    severity: 'warning', certainty: 'measured', code: 'XFORM_UNAPPLIED',
  },
  (ctx) => meshNodes(ctx).filter((n) => !isIdentity(n) && !dequantizing(ctx, n)).map((n) => {
    const angle = 2 * Math.acos(Math.min(1, Math.abs(n.rotation[3]))) * (180 / Math.PI);
    const parts: string[] = [];
    if (n.translation.some((v) => Math.abs(v) >= 1e-9)) parts.push(`translation ${v3(n.translation)} m`);
    if (angle > 1e-6) parts.push(`rotation ${angle.toFixed(1)}°`);
    if (n.scale.some((v) => Math.abs(v - 1) >= 1e-9)) parts.push(`scale ${v3(n.scale)}`);
    return {
      prim_path: n.path,
      message: `${n.name} carries an unapplied transform: ${parts.join(', ')}. Its mesh coordinates are not the coordinates you see.`,
      likely_cause: cause('The transform was set on the object and exported as a node transform instead of being baked into the vertices (Blender exports object transforms unless they are applied).', 0.7),
      fix: 'Apply the transform before export (Blender: Ctrl+A › All Transforms) or bake the node matrix into the positions. Keep it only if the node is meant to be animated or instanced.',
      data: { translation: n.translation, rotation_deg: +angle.toFixed(3), scale: n.scale },
    };
  }),
);

const mirrored = rule(
  {
    id: 'xform/mirrored',
    summary: 'A mesh-bearing node has a negative-determinant world transform: its faces wind inside-out.',
    severity: 'warning', certainty: 'measured', code: 'XFORM_MIRRORED',
  },
  (ctx) => meshNodes(ctx).filter((n) => det3(n.world) < 0).map((n) => ({
    prim_path: n.path,
    message: `${n.name} is mirrored (scale ${v3(n.scale)}, negative determinant): its triangles wind inside-out, so single-sided rendering shows the inside.`,
    likely_cause: cause('A negative scale from a mirror operation, or a manual −1 scale, was never applied.', 0.7),
    fix: 'Apply the scale, then recalculate normals outside (Blender: Ctrl+A › Scale, then Shift+N in edit mode).',
    data: { scale: n.scale },
  })),
);

const nonUniform = rule(
  {
    id: 'xform/non-uniform-scale',
    summary: 'A mesh-bearing node has non-uniform scale: normals shear and physics/print exporters bake it.',
    severity: 'info', certainty: 'measured', code: 'XFORM_NON_UNIFORM_SCALE',
  },
  (ctx) => meshNodes(ctx).filter((n) => { const [x, y, z] = n.scale.map(Math.abs); return Math.abs(x - y) > 1e-6 || Math.abs(y - z) > 1e-6; }).map((n) => ({
    prim_path: n.path,
    message: `${n.name} has non-uniform scale ${v3(n.scale)}; normals shear under it and exporters to STL/USDZ bake it into the geometry.`,
    likely_cause: cause('The object was stretched at object level rather than in edit mode.', 0.6),
    fix: 'Apply the scale (Blender: Ctrl+A › Scale) so the geometry carries the shape and normals stay correct.',
    data: { scale: n.scale },
  })),
);

const tooSmall = rule(
  {
    id: 'scale/too-small',
    summary: 'Largest world-space dimension is below smallScale (default 0.01 m): coin-sized, or exported in the wrong unit.',
    severity: 'warning', certainty: 'measured', code: 'SCALE_TOO_SMALL',
  },
  (ctx) => {
    const e = ctx.extent();
    const small = Number(ctx.params.smallScale);
    if (!e || e.largest <= 0 || e.largest >= small) return null;
    return {
      prim_path: ctx.rootPath,
      message: `Largest dimension is ${metres(e.largest)} (${e.largest.toPrecision(3)} m); the asset is smaller than a coin.`,
      likely_cause: cause('Millimetres or centimetres were exported as metres (glTF units are metres): a 1.2 mm asset is most likely a 1.2 m one scaled by 0.001.', 0.6),
      fix: 'Scale by 1000 (mm → m) or 100 (cm → m), or set the exporter\'s unit scale to metres. Declare the intended size with an expectation to have this checked.',
      data: { largest_dimension_m: e.largest, threshold_m: small, size_m: e.size },
    };
  },
);

const tooLarge = rule(
  {
    id: 'scale/too-large',
    summary: 'Largest world-space dimension is above largeScale (default 20 m): building-sized.',
    severity: 'warning', certainty: 'measured', code: 'SCALE_TOO_LARGE',
  },
  (ctx) => {
    const e = ctx.extent();
    const large = Number(ctx.params.largeScale);
    if (!e || e.largest <= large) return null;
    return {
      prim_path: ctx.rootPath,
      message: `Largest dimension is ${metres(e.largest)}; the asset is building-sized.`,
      likely_cause: cause('Metres were exported from a millimetre or centimetre scene without unit conversion, or a scene-scale mistake.', 0.6),
      fix: 'Scale by 0.001 (mm scene) or 0.01 (cm scene), or set the exporter\'s unit scale to metres. Declare the intended size with an expectation to have this checked.',
      data: { largest_dimension_m: e.largest, threshold_m: large, size_m: e.size },
    };
  },
);

export const coreSceneV1: RulePack = {
  name: 'core-scene',
  version: 1,
  description: 'Origin placement, unapplied / mirrored / non-uniform node transforms, and real-unit scale sanity.',
  params: {
    originTolerance: { default: 0.05, description: 'Fraction of the bounds within which the origin counts as being at a landmark.' },
    smallScale: { default: 0.01, description: 'Metres; scale/too-small fires below this largest dimension.' },
    largeScale: { default: 20, description: 'Metres; scale/too-large fires above this largest dimension.' },
  },
  rules: [originOutside, originNotAtBase, unapplied, mirrored, nonUniform, tooSmall, tooLarge],
};
