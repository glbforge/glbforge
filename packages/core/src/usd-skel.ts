/**
 * UsdSkel export: turns glTF skins + animation clips into a Skeleton (joint
 * paths, bind and rest transforms), SkelBindingAPI primvars on the skinned
 * meshes, and a SkelAnimation sampled at a fixed rate. Sampling every joint
 * at every frame (rather than copying keyframes) is what UsdSkel expects —
 * one time array shared by translations/rotations/scales — and it makes the
 * output independent of glTF's per-channel keyframe layouts and
 * interpolation modes. Deterministic.
 */
import { Animation, Node, Skin } from '@gltf-transform/core';
import type { Mesh } from '@gltf-transform/core';
import { readFloat } from './accessors.js';
import type { UsdPrim, UsdProperty } from './usd-ir.js';

type Mat = number[]; // column-major 4x4 (glTF storage; USD reads the same 16 numbers as rows)
const IDENTITY: Mat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function mul(a: Mat, b: Mat): Mat {
  const o = new Array<number>(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}

export function invert(m: Mat): Mat {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return [...IDENTITY];
  det = 1 / det;
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * det, (a02 * b10 - a01 * b11 - a03 * b09) * det, (a31 * b05 - a32 * b04 + a33 * b03) * det, (a22 * b04 - a21 * b05 - a23 * b03) * det,
    (a12 * b08 - a10 * b11 - a13 * b07) * det, (a00 * b11 - a02 * b08 + a03 * b07) * det, (a32 * b02 - a30 * b05 - a33 * b01) * det, (a20 * b05 - a22 * b02 + a23 * b01) * det,
    (a10 * b10 - a11 * b08 + a13 * b06) * det, (a01 * b08 - a00 * b10 - a03 * b06) * det, (a30 * b04 - a31 * b02 + a33 * b00) * det, (a21 * b02 - a20 * b04 - a23 * b00) * det,
    (a11 * b07 - a10 * b09 - a12 * b06) * det, (a00 * b09 - a01 * b07 + a02 * b06) * det, (a31 * b01 - a30 * b03 - a32 * b00) * det, (a20 * b03 - a21 * b01 + a22 * b00) * det,
  ];
}

export function compose(t: ArrayLike<number>, q: ArrayLike<number>, s: ArrayLike<number>): Mat {
  const [x, y, z, w] = [q[0], q[1], q[2], q[3]];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

export function decompose(m: Mat): { t: number[]; q: number[]; s: number[] } {
  const t = [m[12], m[13], m[14]];
  let sx = Math.hypot(m[0], m[1], m[2]), sy = Math.hypot(m[4], m[5], m[6]), sz = Math.hypot(m[8], m[9], m[10]);
  const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
  if (det < 0) sx = -sx;
  const r = [m[0] / sx, m[1] / sx, m[2] / sx, m[4] / sy, m[5] / sy, m[6] / sy, m[8] / sz, m[9] / sz, m[10] / sz];
  // Rotation matrix (column-major 3x3) -> quaternion.
  const m00 = r[0], m10 = r[1], m20 = r[2], m01 = r[3], m11 = r[4], m21 = r[5], m02 = r[6], m12 = r[7], m22 = r[8];
  const trace = m00 + m11 + m22;
  let q: number[];
  if (trace > 0) {
    const S = Math.sqrt(trace + 1) * 2;
    q = [(m21 - m12) / S, (m02 - m20) / S, (m10 - m01) / S, 0.25 * S];
  } else if (m00 > m11 && m00 > m22) {
    const S = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [0.25 * S, (m01 + m10) / S, (m02 + m20) / S, (m21 - m12) / S];
  } else if (m11 > m22) {
    const S = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / S, 0.25 * S, (m12 + m21) / S, (m02 - m20) / S];
  } else {
    const S = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / S, (m12 + m21) / S, 0.25 * S, (m10 - m01) / S];
  }
  const ql = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return { t, q: q.map((c) => c / ql), s: [sx, sy, sz] };
}

function slerp(a: ArrayLike<number>, b: ArrayLike<number>, t: number): number[] {
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  let ka: number, kb: number;
  if (1 - cos > 1e-6) {
    const omega = Math.acos(cos), sin = Math.sin(omega);
    ka = Math.sin((1 - t) * omega) / sin; kb = Math.sin(t * omega) / sin;
  } else { ka = 1 - t; kb = t; }
  const q = [ka * a[0] + kb * bx, ka * a[1] + kb * by, ka * a[2] + kb * bz, ka * a[3] + kb * bw];
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return q.map((c) => c / l);
}

/** Evaluate a glTF animation sampler at time `t` (seconds). */
function sampleChannel(
  times: Float32Array, values: Float32Array, width: number, interpolation: string, t: number,
): number[] {
  const n = times.length;
  const stride = interpolation === 'CUBICSPLINE' ? width * 3 : width;
  const at = (k: number) => {
    const base = k * stride + (interpolation === 'CUBICSPLINE' ? width : 0);
    return Array.from(values.subarray(base, base + width));
  };
  if (n === 0) return new Array(width).fill(0);
  if (t <= times[0]) return at(0);
  if (t >= times[n - 1]) return at(n - 1);
  let k = 0;
  while (k + 1 < n && times[k + 1] <= t) k++;
  const t0 = times[k], t1 = times[k + 1], dt = t1 - t0 || 1, u = (t - t0) / dt;
  if (interpolation === 'STEP') return at(k);
  if (interpolation === 'CUBICSPLINE') {
    const p0 = at(k), p1 = at(k + 1);
    const m0 = Array.from(values.subarray((k * 3 + 2) * width, (k * 3 + 3) * width)).map((v) => v * dt);
    const m1 = Array.from(values.subarray(((k + 1) * 3) * width, ((k + 1) * 3 + 1) * width)).map((v) => v * dt);
    const u2 = u * u, u3 = u2 * u;
    const out = p0.map((_, i) => (2 * u3 - 3 * u2 + 1) * p0[i] + (u3 - 2 * u2 + u) * m0[i] + (-2 * u3 + 3 * u2) * p1[i] + (u3 - u2) * m1[i]);
    if (width === 4) { const l = Math.hypot(...out) || 1; return out.map((c) => c / l); }
    return out;
  }
  const a = at(k), b = at(k + 1);
  if (width === 4) return slerp(a, b, u);
  return a.map((v, i) => v + (b[i] - v) * u);
}

const ident = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'joint';

export interface SkeletonExport {
  /** Prims to place under the SkelRoot: the Skeleton (with its SkelAnimation child). */
  skeletonPrim: UsdPrim;
  skeletonPath: string;
  /** Maps a glTF joint index (skin order) to the exported joint order. */
  jointRemap: Uint32Array;
  /** Time range when a clip was exported. */
  frames: number;
  warnings: string[];
}

/** A mesh with morph targets bound to this skeleton: its blend shape names (in target order) and the node driving weights. */
export interface BlendShapeSource { names: string[]; node: Node; mesh: Mesh }

export const SKEL_FPS = 30;

/**
 * Build the Skeleton (+ SkelAnimation) prims for a glTF skin. Joints are
 * ordered parents-first as UsdSkel requires; rest transforms are joint
 * local-to-parent-joint (composing any intermediate non-joint nodes); bind
 * transforms are the inverse of glTF's inverse bind matrices.
 */
export function buildSkeleton(
  skin: Skin | null, animations: Animation[], rootPath: string, name: string, blendSources: BlendShapeSource[] = [],
): SkeletonExport {
  const warnings: string[] = [];
  // Morph-only assets still need a skeleton for UsdSkel to apply blend
  // shapes: a single identity joint every vertex binds to with weight 1.
  const joints = skin ? skin.listJoints() : [];
  const jointSet = new Set(joints);
  const parentOf = (node: Node): Node | null => {
    let p = node.listParents().find((x): x is Node => x instanceof Node) ?? null;
    while (p && !jointSet.has(p)) p = p.listParents().find((x): x is Node => x instanceof Node) ?? null;
    return p;
  };
  const parentJoint = joints.map(parentOf);
  // Parents-first order, original order among siblings.
  const order: number[] = [];
  const visit = (parent: Node | null) => {
    joints.forEach((j, i) => { if (parentJoint[i] === parent) { order.push(i); visit(j); } });
  };
  visit(null);
  if (order.length !== joints.length) throw new Error('skin joints form a cycle');
  const remap = new Uint32Array(joints.length);
  order.forEach((orig, k) => { remap[orig] = k; });

  // Joint path tokens (unique per sibling level).
  const paths = new Array<string>(joints.length);
  const used = new Map<string, Set<string>>();
  for (const orig of order) {
    const j = joints[orig];
    const pi = parentJoint[orig] ? joints.indexOf(parentJoint[orig]!) : -1;
    const parentPath = pi >= 0 ? paths[pi] : '';
    let nm = ident(j.getName() || `joint_${orig}`);
    const siblings = used.get(parentPath) ?? new Set<string>();
    let candidate = nm, n = 1;
    while (siblings.has(candidate)) candidate = `${nm}_${n++}`;
    siblings.add(candidate); used.set(parentPath, siblings);
    paths[orig] = parentPath ? `${parentPath}/${candidate}` : candidate;
  }
  const jointTokens = order.map((orig) => paths[orig]);

  const world = (n: Node): Mat => [...n.getWorldMatrix()];
  const restTransforms = new Float64Array(joints.length * 16);
  order.forEach((orig, k) => {
    const pj = parentJoint[orig];
    const local = pj ? mul(invert(world(pj)), world(joints[orig])) : world(joints[orig]);
    restTransforms.set(local, k * 16);
  });
  const ibmAcc = skin?.getInverseBindMatrices();
  const ibm = ibmAcc ? readFloat(ibmAcc) : null;
  const bindTransforms = new Float64Array(joints.length * 16);
  order.forEach((orig, k) => {
    const m = ibm ? Array.from(ibm.subarray(orig * 16, orig * 16 + 16)) : IDENTITY;
    bindTransforms.set(invert(m), k * 16);
  });
  if (!joints.length) { jointTokens.push('root'); }
  const jointCount = Math.max(1, joints.length);
  const bindOut = joints.length ? bindTransforms : new Float64Array(IDENTITY);
  const restOut = joints.length ? restTransforms : new Float64Array(IDENTITY);

  const skeletonPath = `${rootPath}/${name}`;
  const props: UsdProperty[] = [
    { kind: 'attribute', name: 'bindTransforms', typeName: 'matrix4d[]', uniform: true, value: bindOut },
    { kind: 'attribute', name: 'joints', typeName: 'token[]', uniform: true, value: jointTokens },
    { kind: 'attribute', name: 'restTransforms', typeName: 'matrix4d[]', uniform: true, value: restOut },
  ];
  const children: UsdPrim[] = [];
  let frames = 0;

  // --- Clip: the first animation that drives a joint, one of its ancestors, or a morph weight.
  const chainNodes = new Set<Node>();
  for (const j of joints) { let n: Node | null = j; while (n) { chainNodes.add(n); n = n.listParents().find((x): x is Node => x instanceof Node) ?? null; } }
  const morphNodes = new Set(blendSources.map((b) => b.node));
  const drives = (a: Animation) => a.listChannels().some((c) => {
    const n = c.getTargetNode();
    return !!n && ((c.getTargetPath() === 'weights' && morphNodes.has(n)) || (c.getTargetPath() !== 'weights' && chainNodes.has(n)));
  });
  const clips = animations.filter(drives);
  if (clips.length > 1) warnings.push(`${clips.length} animation clips drive this skeleton; exported "${clips[0].getName() || 'clip 0'}" (UsdSkel carries one SkelAnimation per skeleton).`);
  const clip = clips[0];
  const blendNames = blendSources.flatMap((b) => b.names);
  const staticWeights = () => new Float32Array(blendSources.flatMap((b) => {
    const w = b.mesh.getWeights();
    return b.names.map((_, i) => w[i] ?? 0);
  }));
  const animProps: UsdProperty[] = [];
  if (clip) {
    const channels = clip.listChannels().filter((c) => c.getTargetNode() && chainNodes.has(c.getTargetNode()!) && c.getTargetPath() !== 'weights');
    const weightChannels = clip.listChannels().filter((c) => c.getTargetNode() && c.getTargetPath() === 'weights' && morphNodes.has(c.getTargetNode()!));
    let duration = 0;
    const samplers = channels.map((c) => {
      const s = c.getSampler()!;
      const times = readFloat(s.getInput()!);
      duration = Math.max(duration, times[times.length - 1] ?? 0);
      return { node: c.getTargetNode()!, path: c.getTargetPath(), times, values: readFloat(s.getOutput()!), interpolation: s.getInterpolation() };
    });
    const weightSamplers = weightChannels.map((c) => {
      const s = c.getSampler()!;
      const times = readFloat(s.getInput()!);
      duration = Math.max(duration, times[times.length - 1] ?? 0);
      return { node: c.getTargetNode()!, times, values: readFloat(s.getOutput()!), interpolation: s.getInterpolation() };
    });
    frames = Math.max(1, Math.round(duration * SKEL_FPS) + 1);
    const times = Array.from({ length: frames }, (_, i) => i);
    const translations: Float32Array[] = [], rotations: Float32Array[] = [], scales: Float32Array[] = [], blendWeights: Float32Array[] = [];
    for (let fIdx = 0; fIdx < frames; fIdx++) {
      const t = fIdx / SKEL_FPS;
      const localAt = new Map<Node, Mat>();
      const globalAt = new Map<Node, Mat>();
      const local = (n: Node): Mat => {
        let m = localAt.get(n);
        if (m) return m;
        let tr = [...n.getTranslation()], rot = [...n.getRotation()], sc = [...n.getScale()];
        for (const s of samplers) {
          if (s.node !== n) continue;
          const v = sampleChannel(s.times, s.values, s.path === 'rotation' ? 4 : 3, s.interpolation, t);
          if (s.path === 'translation') tr = v; else if (s.path === 'rotation') rot = v; else if (s.path === 'scale') sc = v;
        }
        m = compose(tr, rot, sc);
        localAt.set(n, m);
        return m;
      };
      const global = (n: Node): Mat => {
        let m = globalAt.get(n);
        if (m) return m;
        const p = n.listParents().find((x): x is Node => x instanceof Node) ?? null;
        m = p ? mul(global(p), local(n)) : local(n);
        globalAt.set(n, m);
        return m;
      };
      const tArr = new Float32Array(jointCount * 3), rArr = new Float32Array(jointCount * 4), sArr = new Float32Array(jointCount * 3);
      if (!joints.length) { rArr[3] = 1; sArr.fill(1); }
      order.forEach((orig, k) => {
        const pj = parentJoint[orig];
        const m = pj ? mul(invert(global(pj)), global(joints[orig])) : global(joints[orig]);
        const d = decompose(m);
        tArr.set(d.t, k * 3); rArr.set(d.q, k * 4); sArr.set(d.s, k * 3);
      });
      translations.push(tArr); rotations.push(rArr); scales.push(sArr);
      if (blendNames.length) {
        const w = staticWeights();
        let offset = 0;
        for (const b of blendSources) {
          const ws = weightSamplers.find((s) => s.node === b.node);
          if (ws) {
            const v = sampleChannel(ws.times, ws.values, b.names.length, ws.interpolation, t);
            for (let i = 0; i < b.names.length; i++) w[offset + i] = v[i];
          }
          offset += b.names.length;
        }
        blendWeights.push(w);
      }
    }
    animProps.push(
      { kind: 'attribute', name: 'joints', typeName: 'token[]', uniform: true, value: jointTokens },
      { kind: 'attribute', name: 'rotations', typeName: 'quatf[]', samples: { times, values: rotations } },
      { kind: 'attribute', name: 'scales', typeName: 'half3[]', samples: { times, values: scales } },
      { kind: 'attribute', name: 'translations', typeName: 'float3[]', samples: { times, values: translations } },
    );
    if (blendNames.length) {
      animProps.push(
        { kind: 'attribute', name: 'blendShapes', typeName: 'token[]', uniform: true, value: blendNames },
        { kind: 'attribute', name: 'blendShapeWeights', typeName: 'float[]', samples: { times, values: blendWeights } },
      );
    }
  } else if (blendNames.length) {
    // No clip: still author the static morph weights so the rest pose shows them.
    animProps.push(
      { kind: 'attribute', name: 'blendShapes', typeName: 'token[]', uniform: true, value: blendNames },
      { kind: 'attribute', name: 'blendShapeWeights', typeName: 'float[]', value: staticWeights() },
    );
  }
  if (animProps.length) {
    const animPath = `${skeletonPath}/Anim`;
    children.push({ name: 'Anim', path: animPath, typeName: 'SkelAnimation', children: [], properties: animProps });
    props.push({ kind: 'relationship', name: 'skel:animationSource', targets: [animPath] });
  }

  return {
    skeletonPrim: { name, path: skeletonPath, typeName: 'Skeleton', apiSchemas: animProps.length ? ['SkelBindingAPI'] : undefined, properties: props, children },
    skeletonPath, jointRemap: remap, frames, warnings,
  };
}
