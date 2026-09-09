/**
 * SceneIR — a format-agnostic scene model that every agent-facing inspector,
 * validator, differ and the posed renderer consume. Produced by
 * `fromGltf()` (gltf-transform Document) and `fromUsd()` (single USD layer),
 * so GLB and USD assets get the same fields, the same codes, and comparable
 * prim paths.
 *
 * Prim paths for glTF mirror what export_usdz writes, plus explicit indices:
 *   node            /Asset/<Name>_<nodeIndex>
 *   mesh primitive  /Asset/<Name>_<nodeIndex>/Prim_<primitiveIndex>
 *   morph target    /Asset/<Name>_<nodeIndex>/Prim_<i>/BlendShape_<t>_<name>
 *   material        /Asset/Materials/<Name>_<materialIndex>
 *   texture         /Asset/Textures/<Name>_<textureIndex>
 *   skin            /Asset/Skel_<skinIndex>
 *   animation       /Asset/Animations/<Name>_<animationIndex>
 * For USD input, paths are the real prim paths of the layer.
 */
import type { Diagnostic } from './diagnostics.js';

export type Mat4 = number[]; // column-major, 16 numbers (glTF storage order)

export interface IRNode {
  index: number;
  path: string;
  name: string;
  parent: number | null;
  children: number[];
  /** Local transform, column-major. */
  local: Mat4;
  translation: number[];
  rotation: number[]; // quaternion x,y,z,w
  scale: number[];
  /** World transform (composition of the parent chain), column-major. */
  world: Mat4;
  /** IR mesh entries instantiated at this node. */
  meshes: number[];
  /** True for skeleton joints (USD joints are synthetic nodes under the Skeleton prim). */
  isJoint: boolean;
  /** Source object index (glTF node index / USD prim ordinal). */
  sourceIndex: number;
}

export interface IRUvSet {
  name: string;
  /** u,v per vertex. */
  data: Float32Array;
}

export interface IRMorphTarget {
  index: number;
  name: string;
  path: string;
  /** Position deltas (xyz per vertex) or null when the target only carries normals. */
  positions: Float32Array | null;
  normals: Float32Array | null;
  /** Default weight (glTF mesh.weights / USD default). */
  defaultWeight: number;
}

export interface IRMesh {
  index: number;
  path: string;
  name: string;
  /** Owning node (IR index). */
  node: number;
  /** Source mesh index (glTF mesh index; USD: prim ordinal) — shared geometry has the same value. */
  sourceMesh: number;
  primitiveIndex: number;
  mode: 'triangles' | 'points' | 'lines' | 'other';
  /** Vertex positions in the mesh's own space (bind space for skinned meshes). */
  positions: Float32Array;
  vertexCount: number;
  /** Triangle list indices (n-gons already fan-triangulated), or null when the mesh is not triangles. */
  indices: Uint32Array | null;
  /** Faces as authored (n-gons count once); equals triangleCount for glTF. */
  faceCount: number;
  triangleCount: number;
  normals: Float32Array | null;
  normalsSource: 'authored' | 'generated' | 'missing';
  uvs: IRUvSet[];
  /** Joint indices per vertex, `influences` per vertex, into the skin's joint list. */
  joints: Uint16Array | null;
  weights: Float32Array | null;
  influences: number;
  /** IR skin index, or null. */
  skin: number | null;
  /** IR material index, or null. */
  material: number | null;
  targets: IRMorphTarget[];
  doubleSided: boolean;
  /** Bytes of vertex + index data as stored (estimate for GPU memory). */
  geometryBytes: number;
}

export interface IRTextureUse {
  texture: number;
  /** Material input the texture feeds: baseColor | metallicRoughness | normal | occlusion | emissive, or the USD shader input name. */
  input: string;
  /** Channels read: rgb | rgba | r | g | b | a. */
  channel: string;
  colorSpace: 'sRGB' | 'raw' | 'auto';
  texCoord: number;
}

export interface IRMaterial {
  index: number;
  path: string;
  name: string;
  /** glTF: "pbrMetallicRoughness" (+ extension names); USD: the surface shader's info:id. */
  shaderType: string;
  textures: IRTextureUse[];
  alphaMode: 'OPAQUE' | 'MASK' | 'BLEND';
  alphaCutoff: number;
  doubleSided: boolean;
  baseColorFactor: number[];
  metallicFactor: number;
  roughnessFactor: number;
  emissiveFactor: number[];
  /** Features the base PBR model cannot express (transmission, clearcoat, MaterialX…). */
  unsupportedFeatures: string[];
  /** Source object index. */
  sourceIndex: number;
}

export interface IRTexture {
  index: number;
  path: string;
  name: string;
  /** External path / usdz entry name, or null when embedded. */
  uri: string | null;
  resolved: boolean;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  bytes: number;
  hasAlpha: boolean | null;
  /** Encoded bytes when available (rendering / transcoding). */
  data: Uint8Array | null;
}

export interface IRSkin {
  index: number;
  path: string;
  name: string;
  /** IR node indices, in influence order. */
  joints: number[];
  /** Inverse bind matrix per joint (column-major), or null (identity). */
  inverseBind: Mat4[] | null;
  /** Node whose world transform the skinned mesh follows (USD: the Skeleton's parent xform); null = identity. */
  root: number | null;
  sourceIndex: number;
}

export type IRChannelProperty = 'translation' | 'rotation' | 'scale' | 'weights';

export interface IRChannel {
  /** IR node (or, for `weights`, the node owning the morphing mesh). */
  node: number;
  property: IRChannelProperty;
  times: Float32Array;
  /** `width` values per key (CUBICSPLINE: in-tangent, value, out-tangent per key). */
  values: Float32Array;
  width: number;
  interpolation: 'LINEAR' | 'STEP' | 'CUBICSPLINE';
}

export interface IRAnimation {
  index: number;
  path: string;
  name: string;
  channels: IRChannel[];
  start: number;
  end: number;
}

export interface SceneIR {
  format: 'glb' | 'gltf' | 'usdz' | 'usda' | 'usdc';
  sourcePath: string | null;
  fileBytes: number;
  upAxis: 'Y' | 'Z';
  metersPerUnit: number;
  defaultPrim: string | null;
  /** Declared composition arcs / sublayers (not resolved). */
  layerStack: string[];
  nodes: IRNode[];
  roots: number[];
  meshes: IRMesh[];
  materials: IRMaterial[];
  textures: IRTexture[];
  skins: IRSkin[];
  animations: IRAnimation[];
  /** Frames per second declared by the layer (USD) or the sampling rate used (glTF: null). */
  fps: number | null;
  /** Total prims in the source (glTF: nodes + meshes + materials + textures + skins + animations; USD: prim count). */
  primCount: number;
  extensions: { used: string[]; required: string[] };
  generator: string | null;
  /** Every prim in a USD layer (path + type); empty for glTF. */
  prims: Array<{ path: string; type: string | null }>;
  /** Time-sampled attributes that are not xform / skeleton / blend-shape channels (USD: deforming points, visibility…). */
  timeSampledProps: Array<{ prim_path: string; property: string }>;
  /** Issues found while loading (unresolved textures, unsupported arcs, schema errors). */
  diagnostics: Diagnostic[];
}

/** USD-safe identifier (shared with the USDZ exporter's naming). */
export const ident = (s: string): string => s.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'x';

export const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function mat4Mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Array<number>(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}

export function mat4Invert(m: Mat4): Mat4 {
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

export function mat4Compose(t: ArrayLike<number>, q: ArrayLike<number>, s: ArrayLike<number>): Mat4 {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

export function mat4Decompose(m: Mat4): { t: number[]; q: number[]; s: number[] } {
  const t = [m[12], m[13], m[14]];
  let sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]), sz = Math.hypot(m[8], m[9], m[10]);
  const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
  if (det < 0) sx = -sx;
  const r = [m[0] / (sx || 1), m[1] / (sx || 1), m[2] / (sx || 1), m[4] / (sy || 1), m[5] / (sy || 1), m[6] / (sy || 1), m[8] / (sz || 1), m[9] / (sz || 1), m[10] / (sz || 1)];
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

export function transformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number] {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/** Fan-triangulate polygon faces: faceVertexCounts + faceVertexIndices → triangle list. */
export function triangulate(counts: ArrayLike<number>, indices: ArrayLike<number>): { tris: Uint32Array; triOfFace: Uint32Array } {
  let triCount = 0;
  for (let i = 0; i < counts.length; i++) triCount += Math.max(0, counts[i] - 2);
  const tris = new Uint32Array(triCount * 3);
  const triOfFace = new Uint32Array(triCount);
  let o = 0, t = 0, base = 0;
  for (let f = 0; f < counts.length; f++) {
    const n = counts[f];
    for (let k = 1; k + 1 < n; k++) {
      tris[o++] = indices[base]; tris[o++] = indices[base + k]; tris[o++] = indices[base + k + 1];
      triOfFace[t++] = f;
    }
    base += n;
  }
  return { tris, triOfFace };
}

/** World-space bounding box of a set of IR meshes (positions × node world), or null when empty. */
export function worldBounds(ir: SceneIR, meshes: IRMesh[] = ir.meshes): { min: number[]; max: number[]; size: number[] } | null {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) {
    const w = ir.nodes[m.node]?.world ?? IDENTITY;
    const p = m.positions;
    for (let i = 0; i < m.vertexCount; i++) {
      const v = transformPoint(w, p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
      for (let a = 0; a < 3; a++) { if (v[a] < min[a]) min[a] = v[a]; if (v[a] > max[a]) max[a] = v[a]; }
    }
  }
  if (!Number.isFinite(min[0])) return null;
  return { min, max, size: max.map((v, i) => v - min[i]) };
}

/** Cheap structural fingerprint of a mesh's geometry (counts + sampled positions) for instancing detection. */
export function geometryFingerprint(m: IRMesh): string {
  const p = m.positions;
  const n = m.vertexCount;
  const parts = [n, m.triangleCount];
  const step = Math.max(1, Math.floor(n / 16));
  for (let i = 0; i < n; i += step) parts.push(Math.round(p[i * 3] * 1e4), Math.round(p[i * 3 + 1] * 1e4), Math.round(p[i * 3 + 2] * 1e4));
  return parts.join(',');
}

/** Depth of the deepest node (root = 1). */
export function sceneGraphDepth(ir: SceneIR): number {
  let deepest = 0;
  const visit = (i: number, d: number) => { if (d > deepest) deepest = d; for (const c of ir.nodes[i].children) visit(c, d + 1); };
  for (const r of ir.roots) visit(r, 1);
  return deepest;
}
