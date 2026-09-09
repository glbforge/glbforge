/**
 * Pose a SceneIR at a time: evaluate animation channels (node TRS + morph
 * weights), recompute world matrices, CPU-skin skinned meshes, apply morph
 * deltas. Output is world-space triangle data for the renderer. Pure and
 * deterministic.
 */
import { mat4Compose, mat4Mul, IDENTITY, type IRChannel, type IRMesh, type Mat4, type SceneIR } from './ir.js';

export interface PosedMesh {
  mesh: IRMesh;
  /** World-space positions, xyz per vertex. */
  positions: Float32Array;
  /** World-space unit normals (authored ones transformed), or null. */
  normals: Float32Array | null;
}

export interface PoseOptions {
  /** IR animation index (default 0). */
  animation?: number;
  /** Seconds into the clip. Omit for the rest pose (no animation applied). */
  time?: number;
}

function slerp(a: number[], b: number[], t: number): number[] {
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  let ka: number, kb: number;
  if (1 - cos > 1e-6) { const omega = Math.acos(Math.min(1, cos)), sin = Math.sin(omega); ka = Math.sin((1 - t) * omega) / sin; kb = Math.sin(t * omega) / sin; }
  else { ka = 1 - t; kb = t; }
  const q = [ka * a[0] + kb * bx, ka * a[1] + kb * by, ka * a[2] + kb * bz, ka * a[3] + kb * bw];
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return q.map((c) => c / l);
}

/** Evaluate a channel at time t (seconds), clamped to its key range. */
export function sampleChannel(ch: IRChannel, t: number): number[] {
  const { times, values, width } = ch;
  const n = times.length;
  const stride = ch.interpolation === 'CUBICSPLINE' ? width * 3 : width;
  const at = (k: number) => { const base = k * stride + (ch.interpolation === 'CUBICSPLINE' ? width : 0); return Array.from(values.subarray(base, base + width)); };
  if (n === 0) return new Array(width).fill(0);
  if (t <= times[0]) return at(0);
  if (t >= times[n - 1]) return at(n - 1);
  let k = 0;
  while (k + 1 < n && times[k + 1] <= t) k++;
  const t0 = times[k], t1 = times[k + 1], dt = t1 - t0 || 1, u = (t - t0) / dt;
  if (ch.interpolation === 'STEP') return at(k);
  if (ch.interpolation === 'CUBICSPLINE') {
    const p0 = at(k), p1 = at(k + 1);
    const m0 = Array.from(values.subarray((k * 3 + 2) * width, (k * 3 + 3) * width)).map((v) => v * dt);
    const m1 = Array.from(values.subarray((k + 1) * 3 * width, ((k + 1) * 3 + 1) * width)).map((v) => v * dt);
    const u2 = u * u, u3 = u2 * u;
    const out = p0.map((_, i) => (2 * u3 - 3 * u2 + 1) * p0[i] + (u3 - 2 * u2 + u) * m0[i] + (-2 * u3 + 3 * u2) * p1[i] + (u3 - u2) * m1[i]);
    if (width === 4 && ch.property === 'rotation') { const l = Math.hypot(...out) || 1; return out.map((c) => c / l); }
    return out;
  }
  const a = at(k), b = at(k + 1);
  if (width === 4 && ch.property === 'rotation') return slerp(a, b, u);
  return a.map((v, i) => v + (b[i] - v) * u);
}

const transformDir = (m: Mat4, x: number, y: number, z: number): [number, number, number] => {
  const wx = m[0] * x + m[4] * y + m[8] * z, wy = m[1] * x + m[5] * y + m[9] * z, wz = m[2] * x + m[6] * y + m[10] * z;
  const l = Math.hypot(wx, wy, wz) || 1;
  return [wx / l, wy / l, wz / l];
};

export function poseScene(ir: SceneIR, opts: PoseOptions = {}): { worlds: Mat4[]; meshes: PosedMesh[]; weights: Map<number, number[]> } {
  const anim = opts.time !== undefined ? ir.animations[opts.animation ?? 0] : undefined;
  const overrides = new Map<number, { t?: number[]; r?: number[]; s?: number[] }>();
  const weights = new Map<number, number[]>();
  if (anim) {
    for (const ch of anim.channels) {
      const v = sampleChannel(ch, opts.time!);
      if (ch.property === 'weights') { weights.set(ch.node, v); continue; }
      const o = overrides.get(ch.node) ?? {};
      if (ch.property === 'translation') o.t = v; else if (ch.property === 'rotation') o.r = v; else o.s = v;
      overrides.set(ch.node, o);
    }
  }
  const worlds = new Array<Mat4>(ir.nodes.length);
  const visit = (i: number, parentWorld: Mat4 | null) => {
    const n = ir.nodes[i];
    const o = overrides.get(i);
    const local = o ? mat4Compose(o.t ?? n.translation, o.r ?? n.rotation, o.s ?? n.scale) : n.local;
    worlds[i] = parentWorld ? mat4Mul(parentWorld, local) : local;
    for (const c of n.children) visit(c, worlds[i]);
  };
  for (const r of ir.roots) visit(r, null);
  for (const n of ir.nodes) if (!worlds[n.index]) visit(n.index, n.parent !== null && worlds[n.parent] ? worlds[n.parent] : null);

  const meshes: PosedMesh[] = [];
  for (const m of ir.meshes) {
    const count = m.vertexCount;
    // Morph deltas.
    let base = m.positions, baseN = m.normals;
    const w = weights.get(m.node) ?? m.targets.map((t) => t.defaultWeight);
    if (m.targets.some((t, i) => (w[i] ?? 0) !== 0 && (t.positions || t.normals))) {
      base = Float32Array.from(m.positions);
      baseN = m.normals ? Float32Array.from(m.normals) : null;
      m.targets.forEach((t, i) => {
        const wi = w[i] ?? 0;
        if (!wi) return;
        if (t.positions) for (let k = 0; k < count * 3; k++) base[k] += t.positions[k] * wi;
        if (t.normals && baseN) for (let k = 0; k < count * 3; k++) baseN[k] += t.normals[k] * wi;
      });
    }
    const positions = new Float32Array(count * 3);
    const normals = baseN ? new Float32Array(count * 3) : null;
    const skin = m.skin !== null ? ir.skins[m.skin] : null;
    if (skin && m.joints && m.weights && m.influences > 0) {
      const jointMats = skin.joints.map((j, k) => mat4Mul(worlds[j] ?? IDENTITY, skin.inverseBind?.[k] ?? IDENTITY));
      const inf = m.influences;
      for (let v = 0; v < count; v++) {
        const x = base[v * 3], y = base[v * 3 + 1], z = base[v * 3 + 2];
        let px = 0, py = 0, pz = 0, total = 0;
        let nx = 0, ny = 0, nz = 0;
        for (let k = 0; k < inf; k++) {
          const wk = m.weights[v * inf + k];
          if (wk <= 0) continue;
          const jm = jointMats[m.joints[v * inf + k]] ?? IDENTITY;
          total += wk;
          px += wk * (jm[0] * x + jm[4] * y + jm[8] * z + jm[12]);
          py += wk * (jm[1] * x + jm[5] * y + jm[9] * z + jm[13]);
          pz += wk * (jm[2] * x + jm[6] * y + jm[10] * z + jm[14]);
          if (baseN) { const d = transformDir(jm, baseN[v * 3], baseN[v * 3 + 1], baseN[v * 3 + 2]); nx += wk * d[0]; ny += wk * d[1]; nz += wk * d[2]; }
        }
        if (total <= 0) { const wm = worlds[m.node] ?? IDENTITY; px = wm[0] * x + wm[4] * y + wm[8] * z + wm[12]; py = wm[1] * x + wm[5] * y + wm[9] * z + wm[13]; pz = wm[2] * x + wm[6] * y + wm[10] * z + wm[14]; if (baseN) [nx, ny, nz] = transformDir(wm, baseN[v * 3], baseN[v * 3 + 1], baseN[v * 3 + 2]); }
        else if (Math.abs(total - 1) > 1e-4) { px /= total; py /= total; pz /= total; }
        positions[v * 3] = px; positions[v * 3 + 1] = py; positions[v * 3 + 2] = pz;
        if (normals) { const l = Math.hypot(nx, ny, nz) || 1; normals[v * 3] = nx / l; normals[v * 3 + 1] = ny / l; normals[v * 3 + 2] = nz / l; }
      }
    } else {
      const wm = worlds[m.node] ?? IDENTITY;
      for (let v = 0; v < count; v++) {
        const x = base[v * 3], y = base[v * 3 + 1], z = base[v * 3 + 2];
        positions[v * 3] = wm[0] * x + wm[4] * y + wm[8] * z + wm[12];
        positions[v * 3 + 1] = wm[1] * x + wm[5] * y + wm[9] * z + wm[13];
        positions[v * 3 + 2] = wm[2] * x + wm[6] * y + wm[10] * z + wm[14];
        if (normals && baseN) { const d = transformDir(wm, baseN[v * 3], baseN[v * 3 + 1], baseN[v * 3 + 2]); normals[v * 3] = d[0]; normals[v * 3 + 1] = d[1]; normals[v * 3 + 2] = d[2]; }
      }
    }
    meshes.push({ mesh: m, positions, normals });
  }
  return { worlds, meshes, weights };
}
