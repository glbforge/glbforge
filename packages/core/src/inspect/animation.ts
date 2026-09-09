/**
 * inspect_animation: "does anything actually move?" — clips, animated prims,
 * skeletons and their bindings, blend shapes and their drivers, root motion.
 */
import { diag, type Diagnostic } from './diagnostics.js';
import type { IRChannel, SceneIR } from './ir.js';

export interface SkeletonReport {
  prim_path: string;
  name: string;
  joint_count: number;
  root_joint_path: string | null;
  bound_meshes: string[];
  max_influences_per_vertex: number;
  unbound_vertex_count: number;
  animated: boolean;
}

export interface BlendShapeReport {
  name: string;
  prim_path: string;
  target_mesh: string;
  is_driven: boolean;
  default_weight: number;
}

export interface ClipReport {
  prim_path: string;
  name: string;
  start: number;
  end: number;
  duration_seconds: number;
  channel_count: number;
  has_motion: boolean;
  animated_prims: string[];
}

export interface AnimationReport {
  has_animation: boolean;
  /** [start, end] in `time_unit`. */
  time_code_range: [number, number] | null;
  time_unit: 'seconds' | 'timecodes';
  frames_per_second: number | null;
  duration_seconds: number;
  clips: ClipReport[];
  animated_prims: Array<{ prim_path: string; properties: string[]; clips: string[] }>;
  skeletons: SkeletonReport[];
  blend_shapes: BlendShapeReport[];
  root_motion_detected: boolean;
  diagnostics: Diagnostic[];
}

const EPS = 1e-5;

/** Does a channel's value change across its keys (beyond float noise)? */
export function channelMoves(ch: IRChannel, component?: number): boolean {
  const w = ch.width, stride = ch.interpolation === 'CUBICSPLINE' ? w * 3 : w;
  const off = ch.interpolation === 'CUBICSPLINE' ? w : 0;
  const keys = Math.floor(ch.values.length / (stride || 1));
  if (keys < 2) return false;
  const comps = component === undefined ? Array.from({ length: w }, (_, i) => i) : [component];
  for (const c of comps) {
    const first = ch.values[off + c];
    for (let k = 1; k < keys; k++) if (Math.abs(ch.values[k * stride + off + c] - first) > EPS) return true;
  }
  return false;
}

export function inspectAnimation(ir: SceneIR): AnimationReport {
  const diagnostics: Diagnostic[] = [];
  const timeUnit: AnimationReport['time_unit'] = ir.format.startsWith('usd') ? 'timecodes' : 'seconds';
  const tcps = timeUnit === 'timecodes' ? ir.fps ?? 24 : 1;
  const toSeconds = (t: number) => t; // IR channel times are always seconds
  const toUnit = (t: number) => Math.round(t * tcps * 1e6) / 1e6;

  // --- clips ---
  const clips: ClipReport[] = [];
  const animatedPrims = new Map<string, { properties: Set<string>; clips: Set<string> }>();
  const movingJointNodes = new Set<number>();
  const drivenWeights = new Map<number, Set<number>>(); // node → target indices with a moving weight
  let rootMotion = false;
  let rangeStart = Infinity, rangeEnd = -Infinity;
  for (const anim of ir.animations) {
    let moving = false;
    const prims = new Set<string>();
    for (const ch of anim.channels) {
      const node = ir.nodes[ch.node];
      if (!node) continue;
      const moves = channelMoves(ch);
      if (!moves) continue;
      moving = true;
      prims.add(node.path);
      const entry = animatedPrims.get(node.path) ?? { properties: new Set(), clips: new Set() };
      entry.properties.add(ch.property === 'weights' ? 'blendShapeWeights' : `xformOp:${ch.property}`);
      entry.clips.add(anim.name);
      animatedPrims.set(node.path, entry);
      if (node.isJoint) movingJointNodes.add(ch.node);
      if (ch.property === 'weights') {
        const set = drivenWeights.get(ch.node) ?? new Set<number>();
        for (let c = 0; c < ch.width; c++) if (channelMoves(ch, c)) set.add(c);
        drivenWeights.set(ch.node, set);
      }
      if (ch.property === 'translation') {
        const isRoot = node.parent === null || (node.isJoint && (node.parent === null || !ir.nodes[node.parent].isJoint));
        if (isRoot) rootMotion = true;
      }
    }
    const duration = toSeconds(anim.end - anim.start);
    if (anim.channels.length) { rangeStart = Math.min(rangeStart, anim.start); rangeEnd = Math.max(rangeEnd, anim.end); }
    clips.push({ prim_path: anim.path, name: anim.name, start: toUnit(anim.start), end: toUnit(anim.end), duration_seconds: duration, channel_count: anim.channels.length, has_motion: moving, animated_prims: [...prims] });
    if (anim.channels.length && duration <= 0) {
      diagnostics.push(diag('ANIMATION_ZERO_LENGTH', anim.path, `Clip "${anim.name}" has zero duration (${anim.channels.length} channel(s), one key).`));
    } else if (anim.channels.length && !moving) {
      diagnostics.push(diag('ANIMATION_NO_MOTION', anim.path, `Clip "${anim.name}" has ${anim.channels.length} channel(s) but every value is constant.`));
    }
  }

  // --- skeletons ---
  const skeletons: SkeletonReport[] = [];
  for (const skin of ir.skins) {
    const bound = ir.meshes.filter((m) => m.skin === skin.index);
    let maxInf = 0, unbound = 0;
    for (const m of bound) {
      if (!m.weights) continue;
      for (let v = 0; v < m.vertexCount; v++) {
        let sum = 0, used = 0;
        for (let k = 0; k < m.influences; k++) { const w = m.weights[v * m.influences + k]; if (w > 0) { sum += w; used++; } }
        if (used > maxInf) maxInf = used;
        if (sum <= EPS) unbound++;
      }
    }
    const animated = skin.joints.some((j) => movingJointNodes.has(j));
    const rootJoint = skin.joints.find((j) => { const p = ir.nodes[j].parent; return p === null || !skin.joints.includes(p); });
    skeletons.push({
      prim_path: skin.path, name: skin.name, joint_count: skin.joints.length,
      root_joint_path: rootJoint !== undefined ? ir.nodes[rootJoint].path : null,
      bound_meshes: bound.map((m) => m.path), max_influences_per_vertex: maxInf, unbound_vertex_count: unbound, animated,
    });
    if (bound.length === 0) {
      diagnostics.push(diag('SKELETON_UNBOUND', skin.path, `Skeleton "${skin.name}" (${skin.joints.length} joints) is not bound to any mesh.`, { property: 'skel:skeleton' }));
    }
    const rigid = bound.filter((m) => !m.weights || m.influences === 0);
    if (animated && (bound.length === 0 || rigid.length === bound.length)) {
      diagnostics.push(diag('MESH_NOT_DEFORMING', bound.length ? bound[0].path : skin.path,
        bound.length ? `Skeleton "${skin.name}" animates but ${bound.map((m) => m.path).join(', ')} carries no joint weights — it stays rigid.`
          : `Skeleton "${skin.name}" animates but no mesh is bound to it — nothing deforms.`,
        { property: 'primvars:skel:jointWeights', data: { skeleton: skin.path } }));
    } else {
      for (const m of rigid) diagnostics.push(diag('MESH_NOT_DEFORMING', m.path, `${m.path} is bound to "${skin.name}" but has no joint weights.`, { property: 'primvars:skel:jointWeights', severity: 'info' }));
    }
    if (unbound > 0) diagnostics.push(diag('SKIN_UNBOUND_VERTICES', bound[0]?.path ?? skin.path, `${unbound} vertex(es) have zero total joint weight.`, { property: 'primvars:skel:jointWeights', data: { vertices: unbound } }));
    if (maxInf > 4) diagnostics.push(diag('SKIN_TOO_MANY_INFLUENCES', bound[0]?.path ?? skin.path, `Up to ${maxInf} joint influences per vertex; USDZ keeps 4.`, { data: { max_influences: maxInf } }));
    if (bound.length && !animated && !rigid.length && ir.animations.length === 0) {
      diagnostics.push(diag('SKELETON_NO_ANIMATION', skin.path, `Skeleton "${skin.name}" is bound and skinned but no clip animates it.`));
    }
  }

  // --- blend shapes ---
  const blendShapes: BlendShapeReport[] = [];
  for (const m of ir.meshes) {
    const driven = drivenWeights.get(m.node) ?? new Set<number>();
    for (const t of m.targets) {
      const isDriven = driven.has(t.index);
      blendShapes.push({ name: t.name, prim_path: t.path, target_mesh: m.path, is_driven: isDriven, default_weight: t.defaultWeight });
      if (!isDriven && Math.abs(t.defaultWeight) <= EPS) {
        diagnostics.push(diag('BLENDSHAPE_UNDRIVEN', t.path, `Blend shape "${t.name}" on ${m.path} has no animated weight and a zero default — it never shows.`, { property: 'blendShapeWeights' }));
      }
    }
  }

  for (const p of ir.timeSampledProps) {
    const entry = animatedPrims.get(p.prim_path) ?? { properties: new Set(), clips: new Set() };
    entry.properties.add(p.property); entry.clips.add('timeSamples');
    animatedPrims.set(p.prim_path, entry);
  }
  if (rootMotion) diagnostics.push(diag('ROOT_MOTION', clips.find((c) => c.has_motion)?.prim_path ?? '', 'A root node/joint translates over the clip (root motion).'));

  const hasRange = Number.isFinite(rangeStart);
  const duration = hasRange ? toSeconds(rangeEnd - rangeStart) : 0;
  return {
    has_animation: clips.some((c) => c.has_motion) || ir.timeSampledProps.length > 0,
    time_code_range: hasRange ? [toUnit(rangeStart), toUnit(rangeEnd)] : null,
    time_unit: timeUnit,
    frames_per_second: ir.fps,
    duration_seconds: duration,
    clips,
    animated_prims: [...animatedPrims.entries()].map(([prim_path, e]) => ({ prim_path, properties: [...e.properties], clips: [...e.clips] })),
    skeletons,
    blend_shapes: blendShapes,
    root_motion_detected: rootMotion,
    diagnostics,
  };
}
