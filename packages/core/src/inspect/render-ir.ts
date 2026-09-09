/**
 * Rendering from SceneIR: fragments for the shared rasterizer from a posed
 * scene (any format, any animation time), plus the agent-facing camera rigs
 * (front view, N-angle turntable, explicit camera).
 */
import { renderRawFragments, frameOfFragments, type Fragment, type RawView, type RenderCamera, type RenderFrame, type TextureDecoder, type DecodedTexture } from '../harness/render.js';
import { computeSmoothNormals } from '../normals.js';
import type { IRMesh, SceneIR } from './ir.js';
import { poseScene, type PoseOptions } from './pose.js';

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** Smooth normals for a posed mesh with no authored normals (what a viewer computes on load). */
function smoothNormals(positions: Float32Array, indices: Uint32Array | null, count: number): Float32Array {
  // Reuse core's per-position accumulation through a minimal primitive-like shim.
  const shim = {
    getAttribute: (name: string) => (name === 'POSITION' ? { getArray: () => positions, getCount: () => count, getNormalized: () => false } : null),
    getMode: () => 4,
    getIndices: () => (indices ? { getArray: () => indices } : null),
  };
  return computeSmoothNormals(shim as never) ?? new Float32Array(count * 3);
}

export interface SceneFragmentsOptions extends PoseOptions {
  textureDecoder?: TextureDecoder;
  /** Up-axis conversion for Z-up scenes (rotates -90° about X so the renderer's Y-up rigs frame it correctly). Default true. */
  convertUpAxis?: boolean;
}

export async function fragmentsFromScene(ir: SceneIR, opts: SceneFragmentsOptions = {}): Promise<Fragment[]> {
  const posed = poseScene(ir, opts);
  const decoded = new Map<number, DecodedTexture | null>();
  const decode = async (texIndex: number | null): Promise<DecodedTexture | null> => {
    if (texIndex === null || !opts.textureDecoder) return null;
    if (decoded.has(texIndex)) return decoded.get(texIndex)!;
    const t = ir.textures[texIndex];
    const out = t?.data && t.mimeType ? await opts.textureDecoder(t.data, t.mimeType) : null;
    decoded.set(texIndex, out);
    return out;
  };
  const zUp = opts.convertUpAxis !== false && ir.upAxis === 'Z';
  const scale = ir.metersPerUnit || 1;
  const fragments: Fragment[] = [];
  for (const pm of posed.meshes) {
    const m: IRMesh = pm.mesh;
    if (m.mode !== 'triangles' || !m.indices || m.triangleCount === 0) continue;
    const idx = m.indices;
    const count = idx.length;
    const normalsSrc = pm.normals ?? smoothNormals(pm.positions, idx, m.vertexCount);
    const uv = m.uvs[0]?.data ?? null;
    const tris = new Float32Array(count * 3), normals = new Float32Array(count * 3), uvs = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const v = idx[i];
      let x = pm.positions[v * 3] * scale, y = pm.positions[v * 3 + 1] * scale, z = pm.positions[v * 3 + 2] * scale;
      let nx = normalsSrc[v * 3], ny = normalsSrc[v * 3 + 1], nz = normalsSrc[v * 3 + 2];
      if (zUp) { const ty = y; y = z; z = -ty; const tn = ny; ny = nz; nz = -tn; }
      tris[i * 3] = x; tris[i * 3 + 1] = y; tris[i * 3 + 2] = z;
      normals[i * 3] = nx; normals[i * 3 + 1] = ny; normals[i * 3 + 2] = nz;
      if (uv) { uvs[i * 2] = uv[v * 2]; uvs[i * 2 + 1] = ir.format.startsWith('usd') ? 1 - uv[v * 2 + 1] : uv[v * 2 + 1]; }
    }
    const mat = m.material !== null ? ir.materials[m.material] : null;
    const baseUse = mat?.textures.find((u) => u.input === 'baseColor') ?? null;
    const factor = mat?.baseColorFactor ?? [0.8, 0.8, 0.8, 1];
    // USD authors constant colors in linear; glTF factors are linear too — the renderer expects linear.
    fragments.push({ tris, normals, uvs, texture: await decode(baseUse ? baseUse.texture : null), color: [factor[0], factor[1], factor[2]] });
  }
  return fragments;
}

/** One straight-on front view (camera on +Z, slightly above). */
export function frontRig(): RenderCamera[] {
  return [{ name: 'front', position: [0, 0.08, 0.997], fovDeg: 35 }];
}

/** N azimuths at a fixed elevation, starting from the front, counter-clockwise. */
export function turntableRig(n = 8, elevationRad = 0.3): RenderCamera[] {
  const out: RenderCamera[] = [];
  for (let i = 0; i < n; i++) {
    const az = Math.PI / 2 + (i / n) * Math.PI * 2; // start at +Z (front)
    out.push({ name: `turntable_${Math.round((i / n) * 360)}`, position: [Math.cos(az) * Math.cos(elevationRad), Math.sin(elevationRad), Math.sin(az) * Math.cos(elevationRad)], fovDeg: 40 });
  }
  return out;
}

export function customCamera(position: [number, number, number], target: [number, number, number], fovDeg = 40): RenderCamera[] {
  return [{ name: 'custom', position, target, fovDeg, absolute: true }];
}

export interface RenderSceneOptions extends SceneFragmentsOptions {
  size?: number;
  cameras?: RenderCamera[];
  frame?: RenderFrame;
  supersample?: number;
}

/** Render a SceneIR (posed at `time` when given) with the shared deterministic rasterizer. */
export async function renderScene(ir: SceneIR, opts: RenderSceneOptions = {}): Promise<{ views: RawView[]; frame: RenderFrame; triangles: number }> {
  const fragments = await fragmentsFromScene(ir, opts);
  const frame = opts.frame ?? frameOfFragments(fragments);
  const views = renderRawFragments(fragments, { size: opts.size, cameras: opts.cameras, frame, supersample: opts.supersample });
  return { views, frame, triangles: fragments.reduce((s, f) => s + f.tris.length / 9, 0) };
}

export { srgbToLinear };
