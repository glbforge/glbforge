/**
 * animate(): bake a looping procedural motion into a glTF document as an
 * ordinary animation clip, so any player — three.js, <model-viewer>, AR Quick
 * Look via the USDZ writer, the desktop companion — makes the asset move
 * without a rig.
 *
 * The motion is applied to a pivot the step inserts above the scene roots
 * (`GLBForge_Pivot` at the base centre of the asset, `GLBForge_PivotOffset`
 * undoing that translation for the children), so the original nodes, skins and
 * any authored clips are untouched and a second call replaces the clip instead
 * of nesting pivots. Every preset is a closed curve over `duration` seconds:
 * the last key equals the first, so looping never pops.
 *
 * Deterministic: keys are sampled at a fixed rate from closed-form curves;
 * amplitudes are fractions of the measured height, so the same input and
 * settings produce identical bytes.
 */
import { Accessor, Animation, AnimationSampler, Document, Node, Scene } from '@gltf-transform/core';
import { readFloat } from './accessors.js';
import { restPoseSkin } from './skinning.js';

export type AnimatePreset = 'idle' | 'bob' | 'spin' | 'sway' | 'breathe' | 'hop';

export const ANIMATE_PRESETS: readonly AnimatePreset[] = ['idle', 'bob', 'spin', 'sway', 'breathe', 'hop'];

export interface AnimateOptions {
  /** Motion to bake (default `idle`: a slow rise and settle with a gentle turn). */
  preset?: AnimatePreset;
  /** Loop length in seconds (default per preset; always one closed cycle). */
  duration?: number;
  /** Scales every displacement and angle; 1 = the preset's default (a few % of the height, a few degrees). */
  amplitude?: number;
  /** Key rate in Hz (default 30). More keys = smoother slerp, larger file. */
  fps?: number;
  /** Clip name (default: the preset). A clip of this name is replaced. */
  name?: string;
}

export interface AnimateResult {
  clip: string;
  preset: AnimatePreset;
  duration_seconds: number;
  fps: number;
  keys: number;
  channels: number;
  /** Base-centre pivot the motion turns / rises about, in scene units. */
  pivot: [number, number, number];
  /** Measured scene height (Y extent) the amplitudes were derived from. */
  height: number;
  /** What was baked, measured: peak rise, peak yaw / tilt, peak scale change. */
  motion: { rise: number; yaw_degrees: number; tilt_degrees: number; scale_change: number };
  /** True when the pivot pair already existed and was reused. */
  reused_pivot: boolean;
  warnings: string[];
}

export const PIVOT_NAME = 'GLBForge_Pivot';
export const PIVOT_OFFSET_NAME = 'GLBForge_PivotOffset';

const DEFAULT_DURATION: Record<AnimatePreset, number> = { idle: 4, bob: 3, spin: 6, sway: 3, breathe: 4, hop: 1.2 };

/** Per-key pose of the pivot, as offsets from its rest pose. */
interface Pose { t: [number, number, number]; q: [number, number, number, number]; s: [number, number, number] }

const quatY = (rad: number): [number, number, number, number] => [0, Math.sin(rad / 2), 0, Math.cos(rad / 2)];
const quatZ = (rad: number): [number, number, number, number] => [0, 0, Math.sin(rad / 2), Math.cos(rad / 2)];
const mulQ = (a: number[], b: number[]): [number, number, number, number] => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const deg = (d: number) => (d * Math.PI) / 180;

/**
 * The curves. `u` is the loop phase in [0, 1]; `h` the scene height; `a` the
 * amplitude multiplier. Each returns a pose that equals the rest pose at u=0
 * and u=1 (closed loop), and the peak values it can reach for the report.
 */
function curve(preset: AnimatePreset, h: number, a: number): { at: (u: number) => Pose; peak: AnimateResult['motion'] } {
  const phi = (u: number) => 2 * Math.PI * u;
  const rest = (): Pose => ({ t: [0, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] });
  switch (preset) {
    case 'bob': {
      const rise = 0.04 * h * a;
      return { at: (u) => ({ ...rest(), t: [0, rise * 0.5 * (1 - Math.cos(phi(u))), 0] }), peak: { rise, yaw_degrees: 0, tilt_degrees: 0, scale_change: 0 } };
    }
    case 'spin':
      return { at: (u) => ({ ...rest(), q: quatY(phi(u)) }), peak: { rise: 0, yaw_degrees: 360, tilt_degrees: 0, scale_change: 0 } };
    case 'sway': {
      const tilt = deg(6 * a);
      return { at: (u) => ({ ...rest(), q: quatZ(tilt * Math.sin(phi(u))) }), peak: { rise: 0, yaw_degrees: 0, tilt_degrees: 6 * a, scale_change: 0 } };
    }
    case 'breathe': {
      const k = 0.03 * a;
      return {
        at: (u) => { const s = Math.sin(phi(u)); return { ...rest(), s: [1 - k * s * 0.5, 1 + k * s, 1 - k * s * 0.5] }; },
        peak: { rise: 0, yaw_degrees: 0, tilt_degrees: 0, scale_change: k },
      };
    }
    case 'hop': {
      const rise = 0.12 * h * a, squash = 0.08 * a;
      return {
        at: (u) => {
          const arc = Math.sin(Math.PI * u);                 // one arc over the loop: airborne mid-way, landed at u=0 and u=1
          const y = rise * arc;
          const contact = Math.pow(1 - arc, 6);              // sharp squash only around the landing
          return { t: [0, y, 0], q: [0, 0, 0, 1], s: [1 + squash * contact * 0.5, 1 - squash * contact, 1 + squash * contact * 0.5] };
        },
        peak: { rise, yaw_degrees: 0, tilt_degrees: 0, scale_change: squash },
      };
    }
    case 'idle':
    default: {
      const rise = 0.02 * h * a, yaw = deg(4 * a), tilt = deg(1.5 * a);
      return {
        at: (u) => {
          const p = phi(u);
          return { t: [0, rise * 0.5 * (1 - Math.cos(p)), 0], q: mulQ(quatY(yaw * Math.sin(p)), quatZ(tilt * Math.sin(2 * p))), s: [1, 1, 1] };
        },
        peak: { rise, yaw_degrees: 4 * a, tilt_degrees: 1.5 * a, scale_change: 0 },
      };
    }
  }
}

/** World-space AABB of every mesh under the scene, read through `readFloat` (quantized inputs are normalized ints). */
export function sceneBounds(scene: Scene): { min: [number, number, number]; max: [number, number, number] } | null {
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let any = false;
  const visit = (node: Node) => {
    const mesh = node.getMesh();
    if (mesh) {
      const m = node.getWorldMatrix();
      for (const prim of mesh.listPrimitives()) {
        const acc = prim.getAttribute('POSITION');
        if (!acc) continue;
        // Skinned prims are placed by their joints, so their positions come
        // back already in world space and the node matrix must not be applied.
        const skinned = restPoseSkin(node, prim);
        const p = skinned ? skinned.positions : readFloat(acc);
        for (let i = 0; i + 2 < p.length; i += 3) {
          const x = p[i], y = p[i + 1], z = p[i + 2];
          const wx = skinned ? x : m[0] * x + m[4] * y + m[8] * z + m[12];
          const wy = skinned ? y : m[1] * x + m[5] * y + m[9] * z + m[13];
          const wz = skinned ? z : m[2] * x + m[6] * y + m[10] * z + m[14];
          if (wx < min[0]) min[0] = wx; if (wx > max[0]) max[0] = wx;
          if (wy < min[1]) min[1] = wy; if (wy > max[1]) max[1] = wy;
          if (wz < min[2]) min[2] = wz; if (wz > max[2]) max[2] = wz;
          any = true;
        }
      }
    }
    node.listChildren().forEach(visit);
  };
  scene.listChildren().forEach(visit);
  return any ? { min, max } : null;
}

function disposeClip(anim: Animation): void {
  for (const ch of anim.listChannels()) ch.dispose();
  for (const s of anim.listSamplers()) {
    const i = s.getInput(), o = s.getOutput();
    s.dispose();
    if (i && !i.listParents().some((p) => p instanceof AnimationSampler)) i.dispose();
    if (o && !o.listParents().some((p) => p instanceof AnimationSampler)) o.dispose();
  }
  anim.dispose();
}

export function animate(doc: Document, opts: AnimateOptions = {}): AnimateResult {
  const preset = opts.preset ?? 'idle';
  if (!ANIMATE_PRESETS.includes(preset)) throw new Error(`Unknown preset "${preset}" (expected ${ANIMATE_PRESETS.join(' | ')})`);
  const duration = opts.duration ?? DEFAULT_DURATION[preset];
  if (!(duration > 0)) throw new Error('duration must be > 0 seconds');
  const amplitude = opts.amplitude ?? 1;
  if (!(amplitude >= 0)) throw new Error('amplitude must be >= 0');
  const fps = opts.fps ?? 30;
  if (!(fps >= 1 && fps <= 240)) throw new Error('fps must be between 1 and 240');
  const name = opts.name ?? preset;
  const warnings: string[] = [];

  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  if (!scene) throw new Error('The document has no scene to animate');

  // --- The pivot pair: reuse when a previous call left one, else insert it above every root.
  let pivot = root.listNodes().find((n) => n.getName() === PIVOT_NAME && scene.listChildren().includes(n)) ?? null;
  let offset = pivot?.listChildren().find((n) => n.getName() === PIVOT_OFFSET_NAME) ?? null;
  const reused = !!(pivot && offset);
  const bounds = sceneBounds(scene);
  if (!bounds) warnings.push('No mesh positions found; the pivot sits at the origin and the amplitudes assume a 1 m tall asset.');
  const height = bounds ? Math.max(bounds.max[1] - bounds.min[1], 1e-6) : 1;
  let base: [number, number, number];
  if (reused) {
    base = pivot!.getTranslation() as [number, number, number];
  } else {
    base = bounds ? [(bounds.min[0] + bounds.max[0]) / 2, bounds.min[1], (bounds.min[2] + bounds.max[2]) / 2] : [0, 0, 0];
    pivot = doc.createNode(PIVOT_NAME).setTranslation(base);
    offset = doc.createNode(PIVOT_OFFSET_NAME).setTranslation([-base[0], -base[1], -base[2]]);
    pivot.addChild(offset);
    for (const child of scene.listChildren()) {
      scene.removeChild(child);
      offset.addChild(child);
    }
    scene.addChild(pivot);
  }

  // --- Replace a clip of the same name (idempotent re-runs, no accumulated clips).
  for (const anim of root.listAnimations()) if (anim.getName() === name) disposeClip(anim);

  // --- Sample the closed curve.
  const keys = Math.max(2, Math.round(duration * fps) + 1);
  const times = new Float32Array(keys);
  const tr = new Float32Array(keys * 3), rot = new Float32Array(keys * 4), sc = new Float32Array(keys * 3);
  const { at, peak } = curve(preset, height, amplitude);
  let movesT = false, movesR = false, movesS = false;
  for (let k = 0; k < keys; k++) {
    const u = k === keys - 1 ? 1 : k / (keys - 1);
    times[k] = u * duration;
    const p = at(u);
    tr[k * 3] = base[0] + p.t[0]; tr[k * 3 + 1] = base[1] + p.t[1]; tr[k * 3 + 2] = base[2] + p.t[2];
    rot.set(p.q, k * 4);
    sc.set(p.s, k * 3);
    if (p.t.some((v) => Math.abs(v) > 1e-9)) movesT = true;
    if (Math.abs(p.q[3] - 1) > 1e-9 || p.q[0] !== 0 || p.q[1] !== 0 || p.q[2] !== 0) movesR = true;
    if (p.s.some((v) => Math.abs(v - 1) > 1e-9)) movesS = true;
  }
  // Exact closure: the last key repeats the first so a looping player never pops.
  tr.copyWithin((keys - 1) * 3, 0, 3); rot.copyWithin((keys - 1) * 4, 0, 4); sc.copyWithin((keys - 1) * 3, 0, 3);

  const buffer = root.listBuffers()[0] ?? doc.createBuffer();
  const input = doc.createAccessor(`${name}_times`).setType(Accessor.Type.SCALAR).setArray(times).setBuffer(buffer);
  const anim = doc.createAnimation(name);
  let channels = 0;
  const add = (path: 'translation' | 'rotation' | 'scale', values: Float32Array, type: 'VEC3' | 'VEC4') => {
    const output = doc.createAccessor(`${name}_${path}`).setType(type).setArray(values).setBuffer(buffer);
    const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation(AnimationSampler.Interpolation.LINEAR);
    const channel = doc.createAnimationChannel().setTargetNode(pivot!).setTargetPath(path).setSampler(sampler);
    anim.addSampler(sampler).addChannel(channel);
    channels++;
  };
  if (movesT) add('translation', tr, 'VEC3');
  if (movesR) add('rotation', rot, 'VEC4');
  if (movesS) add('scale', sc, 'VEC3');
  if (!channels) {
    // amplitude 0: a clip with no channels is worse than none.
    input.dispose(); anim.dispose();
    warnings.push('amplitude 0 bakes no motion; no clip was added.');
  }

  return {
    clip: name, preset, duration_seconds: duration, fps, keys, channels,
    pivot: base, height,
    motion: { rise: peak.rise, yaw_degrees: peak.yaw_degrees, tilt_degrees: peak.tilt_degrees, scale_change: peak.scale_change },
    reused_pivot: reused, warnings,
  };
}
