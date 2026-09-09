/**
 * Single USD layer (from usd-read) → SceneIR. Handles Xform ops, Mesh
 * (n-gons, faceVarying / indexed primvars, GeomSubsets), UsdPreviewSurface
 * material networks with UsdUVTexture inputs, UsdSkel (Skeleton /
 * SkelAnimation / SkelBindingAPI / BlendShape) and time samples. Nothing is
 * composed: arcs are recorded on `layerStack` and reported.
 */
import { ImageUtils } from '@gltf-transform/core';
import { imageHasAlpha } from '../analyze/materials.js';
import { diag, type Diagnostic } from './diagnostics.js';
import {
  IDENTITY, mat4Compose, mat4Decompose, mat4Invert, mat4Mul, transformPoint, triangulate,
  type IRAnimation, type IRChannel, type IRMaterial, type IRMesh, type IRMorphTarget, type IRNode, type IRSkin, type IRTexture, type IRTextureUse, type IRUvSet, type Mat4, type SceneIR,
} from './ir.js';
import { asNum, asNumArray, asStr, asStrArray, findProp, listOpItems, walkPrims, type UsdLayerData, type UsdPrimNode, type UsdProp, type UsdVal } from '../usd-read/types.js';

export interface FromUsdOptions {
  format: 'usdz' | 'usda' | 'usdc';
  sourcePath?: string | null;
  fileBytes?: number;
  /** Resolve an asset path (texture) referenced by the layer to bytes, or null when missing. */
  resolveAsset?: (assetPath: string) => Uint8Array | null;
  /** Name of the root layer (usdz entry / file name), listed first in layerStack. */
  layerName?: string;
  diagnostics?: Diagnostic[];
}

const val = (prop: UsdProp | undefined): UsdVal => (prop ? (prop.value !== undefined ? prop.value : prop.timeSamples?.values[0]) : undefined);
const attr = (prim: UsdPrimNode, name: string): UsdVal => val(findProp(prim, name));
const interp = (prop: UsdProp | undefined, fallback: string) => (prop && typeof prop.meta.interpolation === 'string' ? prop.meta.interpolation : fallback);

function sniffMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp';
  if (bytes[0] === 0xab && bytes[1] === 0x4b && bytes[2] === 0x54) return 'image/ktx2';
  if (bytes[0] === 0x76 && bytes[1] === 0x2f && bytes[2] === 0x31 && bytes[3] === 0x01) return 'image/x-exr';
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return 'image/avif';
  return null;
}

const deg = Math.PI / 180;
function axisRot(axis: 0 | 1 | 2, degrees: number): Mat4 {
  const c = Math.cos(degrees * deg), s = Math.sin(degrees * deg);
  if (axis === 0) return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
  if (axis === 1) return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
/** rotateXYZ-style ops: the first axis is applied first to points, so the matrix is R_last · … · R_first. */
function eulerMatrix(order: string, v: ArrayLike<number>): Mat4 {
  let m: Mat4 = [...IDENTITY];
  const axes = order.split('') as Array<'X' | 'Y' | 'Z'>;
  for (let i = axes.length - 1; i >= 0; i--) {
    const a = axes[i];
    const ai = a === 'X' ? 0 : a === 'Y' ? 1 : 2;
    m = mat4Mul(m, axisRot(ai as 0 | 1 | 2, v[ai] ?? v[i] ?? 0));
  }
  return m;
}

interface XformResult { local: Mat4; channels: Array<{ property: IRChannel['property']; times: number[]; values: number[]; width: number }> }

function xformOf(prim: UsdPrimNode, tcps: number, warn: (m: string) => void): XformResult {
  const order = asStrArray(attr(prim, 'xformOpOrder'));
  let local: Mat4 = [...IDENTITY];
  const channels: XformResult['channels'] = [];
  for (const token of order) {
    if (token === '!resetXformStack!') { local = [...IDENTITY]; continue; }
    const inv = token.startsWith('!invert!');
    const name = inv ? token.slice(8) : token;
    const prop = findProp(prim, name);
    if (!prop) continue;
    const kind = name.split(':')[1] ?? '';
    const v = asNumArray(val(prop)) ?? [];
    let m: Mat4 = [...IDENTITY];
    if (kind === 'transform' && v.length >= 16) m = Array.from(v).slice(0, 16);
    else if (kind === 'translate') m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, 1];
    else if (kind === 'scale') m = [v[0] ?? 1, 0, 0, 0, 0, v[1] ?? 1, 0, 0, 0, 0, v[2] ?? 1, 0, 0, 0, 0, 1];
    else if (kind === 'orient' && v.length >= 4) m = mat4Compose([0, 0, 0], v, [1, 1, 1]);
    else if (/^rotate[XYZ]$/.test(kind)) m = axisRot(kind === 'rotateX' ? 0 : kind === 'rotateY' ? 1 : 2, v[0] ?? 0);
    else if (/^rotate[XYZ]{3}$/.test(kind)) m = eulerMatrix(kind.slice(6), v);
    else { warn(`xformOp "${name}" on ${prim.path} not understood; treated as identity.`); continue; }
    if (inv) m = mat4Invert(m);
    local = mat4Mul(local, m);
    if (prop.timeSamples && prop.timeSamples.times.length > 1 && !inv) {
      const times = prop.timeSamples.times.map((t) => t / tcps);
      const samples = prop.timeSamples.values.map((s) => Array.from(asNumArray(s) ?? []));
      if (kind === 'translate') channels.push({ property: 'translation', times, values: samples.flatMap((s) => [s[0] ?? 0, s[1] ?? 0, s[2] ?? 0]), width: 3 });
      else if (kind === 'scale') channels.push({ property: 'scale', times, values: samples.flatMap((s) => [s[0] ?? 1, s[1] ?? 1, s[2] ?? 1]), width: 3 });
      else if (kind === 'orient') channels.push({ property: 'rotation', times, values: samples.flatMap((s) => [s[0] ?? 0, s[1] ?? 0, s[2] ?? 0, s[3] ?? 1]), width: 4 });
      else if (/^rotate[XYZ]{3}$/.test(kind)) channels.push({ property: 'rotation', times, values: samples.flatMap((s) => mat4Decompose(eulerMatrix(kind.slice(6), s)).q), width: 4 });
      else if (/^rotate[XYZ]$/.test(kind)) channels.push({ property: 'rotation', times, values: samples.flatMap((s) => mat4Decompose(axisRot(kind === 'rotateX' ? 0 : kind === 'rotateY' ? 1 : 2, s[0] ?? 0)).q), width: 4 });
      else if (kind === 'transform') {
        const d = samples.map((s) => mat4Decompose(s.length >= 16 ? s.slice(0, 16) : [...IDENTITY]));
        channels.push({ property: 'translation', times, values: d.flatMap((x) => x.t), width: 3 });
        channels.push({ property: 'rotation', times, values: d.flatMap((x) => x.q), width: 4 });
        channels.push({ property: 'scale', times, values: d.flatMap((x) => x.s), width: 3 });
      }
    }
  }
  return { local, channels };
}

const XFORM_CHANNEL_RE = /^xformOp:/;
const SKEL_ANIM_ATTRS = new Set(['translations', 'rotations', 'scales', 'blendShapeWeights']);

export function fromUsd(layer: UsdLayerData, opts: FromUsdOptions): SceneIR {
  const diagnostics: Diagnostic[] = [...(opts.diagnostics ?? [])];
  const warn = (m: string) => { if (!diagnostics.some((d) => d.message === m)) diagnostics.push(diag('USD_SCHEMA_ERROR', '', m, { severity: 'info' })); };
  const meta = layer.meta;
  const defaultPrimName = asStr(meta.defaultPrim);
  const upAxis: 'Y' | 'Z' = asStr(meta.upAxis) === 'Z' ? 'Z' : 'Y';
  const metersPerUnit = typeof meta.metersPerUnit === 'number' ? meta.metersPerUnit : 1;
  const tcps = typeof meta.timeCodesPerSecond === 'number' ? meta.timeCodesPerSecond : typeof meta.framesPerSecond === 'number' ? meta.framesPerSecond : 24;
  const layerStack: string[] = [];
  if (opts.layerName) layerStack.push(opts.layerName);
  const subLayers = listOpItems(meta.subLayers).map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' && 'assetPath' in (x as object) ? (x as { assetPath: string }).assetPath : String(x)));
  for (const s of subLayers) { layerStack.push(`subLayer: ${s}`); diagnostics.push(diag('UNRESOLVED_COMPOSITION_ARC', '/', `Layer sublayers ${s}; sublayers are not composed.`, { property: 'subLayers' })); }
  const defaultPrim = defaultPrimName ? `/${defaultPrimName}` : null;
  if (!defaultPrimName) diagnostics.push(diag('MISSING_DEFAULT_PRIM', '/', 'The layer declares no defaultPrim.', { property: 'defaultPrim' }));
  else if (!layer.prims.some((p) => p.name === defaultPrimName)) diagnostics.push(diag('DEFAULT_PRIM_NOT_FOUND', '/', `defaultPrim "${defaultPrimName}" is not a root prim of the layer (roots: ${layer.prims.map((p) => p.name).join(', ') || 'none'}).`, { property: 'defaultPrim' }));
  if (meta.upAxis === undefined) diagnostics.push(diag('MISSING_UP_AXIS', '/', 'No upAxis metadata (Y assumed).', { property: 'upAxis' }));
  else if (upAxis === 'Z') diagnostics.push(diag('UP_AXIS_Z', '/', 'upAxis = "Z".', { property: 'upAxis' }));
  if (meta.metersPerUnit === undefined) diagnostics.push(diag('MISSING_METERS_PER_UNIT', '/', 'No metersPerUnit metadata (1 assumed).', { property: 'metersPerUnit' }));
  else if (metersPerUnit !== 1) diagnostics.push(diag('METERS_PER_UNIT_NONSTANDARD', '/', `metersPerUnit = ${metersPerUnit}${metersPerUnit === 0.01 ? ' (centimetres)' : ''}.`, { property: 'metersPerUnit', data: { metersPerUnit } }));

  // --- prims → nodes ---
  const nodes: IRNode[] = [];
  const nodeOfPrim = new Map<string, number>();
  const primNode = new Map<number, UsdPrimNode>();
  const roots: number[] = [];
  const prims: SceneIR['prims'] = [];
  const timeSampledProps: SceneIR['timeSampledProps'] = [];
  const xformChannels: Array<{ node: number } & XformResult['channels'][number]> = [];
  const addNode = (path: string, name: string, parent: number | null, local: Mat4, isJoint: boolean, sourceIndex: number): number => {
    const index = nodes.length;
    const d = mat4Decompose(local);
    nodes.push({ index, path, name, parent, children: [], local, translation: d.t, rotation: d.q, scale: d.s, world: parent === null ? local : mat4Mul(nodes[parent].world, local), meshes: [], isJoint, sourceIndex });
    if (parent === null) roots.push(index); else nodes[parent].children.push(index);
    return index;
  };
  let ordinal = 0;
  const visit = (prim: UsdPrimNode, parent: number | null) => {
    prims.push({ path: prim.path, type: prim.typeName });
    for (const arc of prim.arcs) { layerStack.push(`${prim.path} ${arc}`); diagnostics.push(diag('UNRESOLVED_COMPOSITION_ARC', prim.path, `${prim.path} declares ${arc}; not composed.`)); }
    const x = xformOf(prim, tcps, warn);
    const ni = addNode(prim.path, prim.name, parent, x.local, false, ordinal++);
    nodeOfPrim.set(prim.path, ni); primNode.set(ni, prim);
    for (const ch of x.channels) xformChannels.push({ node: ni, ...ch });
    for (const p of prim.properties) {
      if (p.timeSamples && p.timeSamples.times.length > 1 && !XFORM_CHANNEL_RE.test(p.name) && !SKEL_ANIM_ATTRS.has(p.name)) timeSampledProps.push({ prim_path: prim.path, property: p.name });
    }
    if (prim.typeName === 'Mesh') {
      const subd = asStr(attr(prim, 'subdivisionScheme'));
      if (subd && subd !== 'none') diagnostics.push(diag('SUBDIVISION_UNSUPPORTED', prim.path, `subdivisionScheme = "${subd}".`, { property: 'subdivisionScheme' }));
    }
    for (const c of prim.children) visit(c, ni);
  };
  for (const p of layer.prims) visit(p, null);

  // --- textures / materials ---
  const textures: IRTexture[] = [];
  const textureByPath = new Map<string, number>();
  const textureFor = (assetPath: string): number => {
    const hit = textureByPath.get(assetPath);
    if (hit !== undefined) return hit;
    const data = opts.resolveAsset ? opts.resolveAsset(assetPath) : null;
    const mime = data ? sniffMime(data) : null;
    let size: number[] | null = null;
    if (data && mime && /png|jpeg|webp|ktx2/.test(mime)) { try { size = ImageUtils.getSize(data, mime); } catch { size = null; } }
    const index = textures.length;
    const base = assetPath.slice(assetPath.lastIndexOf('/') + 1);
    textures.push({
      index, path: `${defaultPrim ?? ''}/Textures/${base.replace(/[^A-Za-z0-9_]/g, '_')}`, name: base, uri: assetPath,
      resolved: !!data, mimeType: mime, width: size?.[0] ?? null, height: size?.[1] ?? null, bytes: data?.byteLength ?? 0,
      hasAlpha: data && mime ? imageHasAlpha(data, mime) : null, data: data ?? null,
    });
    textureByPath.set(assetPath, index);
    return index;
  };
  const materials: IRMaterial[] = [];
  const materialByPath = new Map<string, number>();
  const primByPath = new Map<string, UsdPrimNode>();
  for (const p of walkPrims(layer.prims)) primByPath.set(p.path, p);
  const PREVIEW_INPUTS = ['diffuseColor', 'emissiveColor', 'normal', 'roughness', 'metallic', 'occlusion', 'opacity', 'clearcoat', 'clearcoatRoughness', 'specularColor', 'displacement', 'ior'];
  const INPUT_NAME: Record<string, string> = { diffuseColor: 'baseColor', emissiveColor: 'emissive' };
  for (const prim of walkPrims(layer.prims)) {
    if (prim.typeName !== 'Material') continue;
    const index = materials.length;
    const m: IRMaterial = {
      index, path: prim.path, name: prim.name, shaderType: 'none', textures: [], alphaMode: 'OPAQUE', alphaCutoff: 0.5, doubleSided: false,
      baseColorFactor: [0.18, 0.18, 0.18, 1], metallicFactor: 0, roughnessFactor: 0.5, emissiveFactor: [0, 0, 0], unsupportedFeatures: [], sourceIndex: index,
    };
    const surf = findProp(prim, 'outputs:surface') ?? findProp(prim, 'outputs:mtlx:surface');
    const target = surf?.connections?.[0];
    const shader = target ? primByPath.get(target.split('.')[0]) : undefined;
    if (shader) {
      const id = asStr(attr(shader, 'info:id')) ?? shader.typeName ?? 'unknown';
      m.shaderType = id;
      if (id !== 'UsdPreviewSurface') m.unsupportedFeatures.push(id);
      let opacityConnected = false, opacity = 1, threshold = 0;
      for (const input of PREVIEW_INPUTS) {
        const prop = findProp(shader, `inputs:${input}`);
        if (!prop) continue;
        const conn = prop.connections?.[0];
        if (conn) {
          const [srcPath, out] = conn.split('.');
          const src = primByPath.get(srcPath);
          const srcId = src ? asStr(attr(src, 'info:id')) : null;
          if (src && srcId === 'UsdUVTexture') {
            const file = asStr(attr(src, 'inputs:file'));
            const cs = asStr(attr(src, 'inputs:sourceColorSpace'));
            const stConn = findProp(src, 'inputs:st')?.connections?.[0];
            let texCoord = 0;
            if (stConn) {
              const reader = primByPath.get(stConn.split('.')[0]);
              const varname = reader ? asStr(attr(reader, 'inputs:varname')) : null;
              const mm = varname ? /(\d+)$/.exec(varname) : null;
              texCoord = mm && varname !== 'st' ? parseInt(mm[1], 10) : 0;
            }
            if (file) {
              m.textures.push({
                texture: textureFor(file), input: INPUT_NAME[input] ?? input,
                channel: (out ?? 'outputs:rgb').replace(/^outputs:/, ''),
                colorSpace: cs === 'sRGB' ? 'sRGB' : cs === 'raw' ? 'raw' : input === 'diffuseColor' || input === 'emissiveColor' ? 'sRGB' : 'raw',
                texCoord,
              } satisfies IRTextureUse);
            } else m.unsupportedFeatures.push(`${input}: UsdUVTexture without inputs:file`);
            if (input === 'opacity') opacityConnected = true;
          } else if (src && srcId && srcId !== 'UsdPrimvarReader_float2' && srcId !== 'UsdTransform2d') {
            m.unsupportedFeatures.push(`${input} ← ${srcId}`);
          }
          continue;
        }
        const v = val(prop);
        const arr = asNumArray(v);
        if (input === 'diffuseColor' && arr && arr.length >= 3) m.baseColorFactor = [arr[0], arr[1], arr[2], m.baseColorFactor[3]];
        else if (input === 'emissiveColor' && arr && arr.length >= 3) m.emissiveFactor = [arr[0], arr[1], arr[2]];
        else if (input === 'metallic') m.metallicFactor = asNum(v, 0);
        else if (input === 'roughness') m.roughnessFactor = asNum(v, 0.5);
        else if (input === 'opacity') opacity = asNum(v, 1);
        else if (input === 'clearcoat' && asNum(v, 0) > 0) m.unsupportedFeatures.push('clearcoat');
      }
      threshold = asNum(attr(shader, 'inputs:opacityThreshold'), 0);
      m.baseColorFactor[3] = opacity;
      m.alphaCutoff = threshold || 0.5;
      m.alphaMode = threshold > 0 ? 'MASK' : opacityConnected || opacity < 1 ? 'BLEND' : 'OPAQUE';
    }
    materials.push(m);
    materialByPath.set(prim.path, index);
  }

  // --- skeletons ---
  const skins: IRSkin[] = [];
  const skinByPath = new Map<string, number>();
  const jointNodesOf = new Map<number, Map<string, number>>(); // skin → joint token → node
  const skelAnimChannels: Array<{ node: number } & XformResult['channels'][number]> = [];
  const blendWeightSamples = new Map<number, { tokens: string[]; times: number[]; values: number[][] }>(); // skin → anim blend weights
  const inheritedRel = (prim: UsdPrimNode, rel: string): string | null => {
    let path: string | null = prim.path;
    while (path) {
      const p = primByPath.get(path);
      const r = p ? findProp(p, rel) : undefined;
      if (r?.targets?.length) return r.targets[0];
      const i = path.lastIndexOf('/');
      path = i > 0 ? path.slice(0, i) : null;
    }
    return null;
  };
  for (const prim of walkPrims(layer.prims)) {
    if (prim.typeName !== 'Skeleton') continue;
    const jointTokens = asStrArray(attr(prim, 'joints'));
    const bind = asNumArray(attr(prim, 'bindTransforms'));
    const rest = asNumArray(attr(prim, 'restTransforms'));
    const skelNode = nodeOfPrim.get(prim.path)!;
    const index = skins.length;
    const jointNodes = new Map<string, number>();
    const joints: number[] = [];
    const inverseBind: Mat4[] = [];
    jointTokens.forEach((tok, i) => {
      const parentTok = tok.includes('/') ? tok.slice(0, tok.lastIndexOf('/')) : null;
      const parent = parentTok !== null && jointNodes.has(parentTok) ? jointNodes.get(parentTok)! : skelNode;
      const local: Mat4 = rest && rest.length >= (i + 1) * 16 ? Array.from(rest).slice(i * 16, i * 16 + 16) : [...IDENTITY];
      const ni = addNode(`${prim.path}/${tok}`, tok.slice(tok.lastIndexOf('/') + 1), parent, local, true, -1);
      jointNodes.set(tok, ni);
      joints.push(ni);
      inverseBind.push(bind && bind.length >= (i + 1) * 16 ? mat4Invert(Array.from(bind).slice(i * 16, i * 16 + 16)) : [...IDENTITY]);
    });
    skins.push({ index, path: prim.path, name: prim.name, joints, inverseBind, root: skelNode, sourceIndex: index });
    skinByPath.set(prim.path, index);
    jointNodesOf.set(index, jointNodes);
    // Animation source
    const animPath = inheritedRel(prim, 'skel:animationSource');
    const anim = animPath ? primByPath.get(animPath) : undefined;
    if (anim) {
      const animJoints = asStrArray(attr(anim, 'joints'));
      const sample = (name: string, width: number, property: IRChannel['property']) => {
        const p = findProp(anim, name);
        if (!p?.timeSamples || p.timeSamples.times.length < 2) return;
        const times = p.timeSamples.times.map((t) => t / tcps);
        const samples = p.timeSamples.values.map((s) => asNumArray(s) ?? []);
        animJoints.forEach((tok, j) => {
          const node = jointNodes.get(tok);
          if (node === undefined) return;
          const values: number[] = [];
          for (const s of samples) for (let k = 0; k < width; k++) values.push(s[j * width + k] ?? (property === 'scale' ? 1 : k === 3 ? 1 : 0));
          skelAnimChannels.push({ node, property, times, values, width });
        });
      };
      sample('translations', 3, 'translation');
      sample('rotations', 4, 'rotation');
      sample('scales', 3, 'scale');
      const bw = findProp(anim, 'blendShapeWeights');
      const tokens = asStrArray(attr(anim, 'blendShapes'));
      if (bw?.timeSamples && bw.timeSamples.times.length > 1 && tokens.length) {
        blendWeightSamples.set(index, { tokens, times: bw.timeSamples.times.map((t) => t / tcps), values: bw.timeSamples.values.map((s) => Array.from(asNumArray(s) ?? [])) });
      }
    }
  }

  // --- meshes ---
  const meshes: IRMesh[] = [];
  const weightChannels: Array<{ node: number; times: number[]; values: number[]; width: number }> = [];
  let meshOrdinal = 0;
  const cubeGeometry = (size: number) => {
    const h = size / 2;
    const p = [-h, -h, -h, h, -h, -h, h, h, -h, -h, h, -h, -h, -h, h, h, -h, h, h, h, h, -h, h, h];
    const f = [0, 3, 2, 1, 4, 5, 6, 7, 0, 1, 5, 4, 2, 3, 7, 6, 0, 4, 7, 3, 1, 2, 6, 5];
    return { points: Float32Array.from(p), counts: Int32Array.from([4, 4, 4, 4, 4, 4]), indices: Int32Array.from(f) };
  };
  for (const prim of walkPrims(layer.prims)) {
    const isMesh = prim.typeName === 'Mesh', isCube = prim.typeName === 'Cube';
    if (!isMesh && !isCube) continue;
    const ni = nodeOfPrim.get(prim.path)!;
    let points = asNumArray(attr(prim, 'points'));
    let counts = asNumArray(attr(prim, 'faceVertexCounts'));
    let fvi = asNumArray(attr(prim, 'faceVertexIndices'));
    if (isCube) { const g = cubeGeometry(asNum(attr(prim, 'size'), 2)); points = g.points; counts = g.counts; fvi = g.indices; }
    if (!points || points.length < 3) { diagnostics.push(diag('USD_SCHEMA_ERROR', prim.path, `${prim.path} is a Mesh without points.`, { property: 'points' })); continue; }
    if (!counts || !fvi) { diagnostics.push(diag('USD_SCHEMA_ERROR', prim.path, `${prim.path} lacks faceVertexCounts / faceVertexIndices.`, { property: 'faceVertexIndices' })); continue; }
    const nPoints = Math.floor(points.length / 3);
    let sum = 0; for (let i = 0; i < counts.length; i++) sum += counts[i];
    if (sum !== fvi.length) { diagnostics.push(diag('USD_SCHEMA_ERROR', prim.path, `faceVertexCounts sum to ${sum} but faceVertexIndices has ${fvi.length} entries.`, { property: 'faceVertexIndices' })); continue; }
    if (asStr(attr(prim, 'orientation')) === 'leftHanded') {
      // Reverse each face so winding matches the right-handed convention the inspectors and renderer assume.
      const rev = Array.from(fvi); let at = 0;
      for (let f = 0; f < counts.length; f++) { rev.splice(at, counts[f], ...rev.slice(at, at + counts[f]).reverse()); at += counts[f]; }
      fvi = rev;
    }
    let bad = 0; for (let i = 0; i < fvi.length; i++) if (fvi[i] < 0 || fvi[i] >= nPoints) bad++;
    if (bad) { diagnostics.push(diag('MESH_INDEX_OUT_OF_RANGE', prim.path, `${bad} faceVertexIndices entries are outside 0..${nPoints - 1}.`, { property: 'faceVertexIndices', data: { count: bad, vertices: nPoints } })); continue; }

    // Primvars & normals: decide whether to unweld to per-corner vertices.
    const normalsProp = findProp(prim, 'normals') ?? findProp(prim, 'primvars:normals');
    const normalsInterp = interp(normalsProp, 'vertex');
    const uvProps = prim.properties.filter((p) => p.kind === 'attribute' && p.name.startsWith('primvars:') && !p.name.endsWith(':indices') && /^(texCoord2f|float2)\[\]$/.test(p.typeName ?? ''));
    const primvarData = (p: UsdProp): { data: Float32Array; interp: string } | null => {
      const raw = asNumArray(val(p));
      if (!raw) return null;
      const idx = asNumArray(attr(prim, `${p.name}:indices`));
      const w = 2;
      let data = Float32Array.from(raw);
      if (idx) { const out = new Float32Array(idx.length * w); for (let i = 0; i < idx.length; i++) for (let k = 0; k < w; k++) out[i * w + k] = raw[idx[i] * w + k]; data = out; }
      return { data, interp: interp(p, 'vertex') };
    };
    const uvSets = uvProps.map((p) => ({ name: p.name.replace(/^primvars:/, ''), pv: primvarData(p) })).filter((u): u is { name: string; pv: { data: Float32Array; interp: string } } => !!u.pv);
    const rawNormals = normalsProp ? asNumArray(val(normalsProp)) : null;
    const normalsIdx = normalsProp ? asNumArray(attr(prim, `${normalsProp.name}:indices`)) : null;
    let normalsArr = rawNormals ? Float32Array.from(rawNormals) : null;
    if (normalsArr && normalsIdx) { const out = new Float32Array(normalsIdx.length * 3); for (let i = 0; i < normalsIdx.length; i++) for (let k = 0; k < 3; k++) out[i * 3 + k] = rawNormals![normalsIdx[i] * 3 + k]; normalsArr = out; }
    const needUnweld = (normalsArr && (normalsInterp === 'faceVarying' || normalsInterp === 'uniform')) || uvSets.some((u) => u.pv.interp === 'faceVarying' || u.pv.interp === 'uniform');

    // Skinning inputs (vertex-interpolated).
    const skelPath = inheritedRel(prim, 'skel:skeleton');
    const skinIndex = skelPath !== null && skinByPath.has(skelPath) ? skinByPath.get(skelPath)! : null;
    const jiProp = findProp(prim, 'primvars:skel:jointIndices'), jwProp = findProp(prim, 'primvars:skel:jointWeights');
    let joints: Uint16Array | null = null, weights: Float32Array | null = null, influences = 0;
    if (skinIndex !== null && jiProp && jwProp) {
      const ji = asNumArray(val(jiProp)) ?? [], jw = asNumArray(val(jwProp)) ?? [];
      influences = Math.max(1, asNum(jiProp.meta.elementSize, 1));
      const constant = interp(jiProp, 'vertex') === 'constant';
      joints = new Uint16Array(nPoints * influences); weights = new Float32Array(nPoints * influences);
      const skelJoints = asStrArray(attr(prim, 'skel:joints'));
      const remap = skelJoints.length ? skelJoints.map((tok) => skins[skinIndex].joints.findIndex((n) => nodes[n].path === `${skelPath}/${tok}`)) : null;
      for (let v = 0; v < nPoints; v++) for (let k = 0; k < influences; k++) {
        const src = constant ? k : v * influences + k;
        const j = ji[src] ?? 0;
        joints[v * influences + k] = remap ? Math.max(0, remap[j] ?? 0) : j;
        weights[v * influences + k] = jw[src] ?? 0;
      }
    }
    let positions = Float32Array.from(points);
    const gbt = asNumArray(attr(prim, 'primvars:skel:geomBindTransform'));
    if (skinIndex !== null && gbt && gbt.length >= 16) {
      const m = Array.from(gbt).slice(0, 16);
      for (let i = 0; i < nPoints; i++) { const p = transformPoint(m, positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]); positions[i * 3] = p[0]; positions[i * 3 + 1] = p[1]; positions[i * 3 + 2] = p[2]; }
    }

    // Blend shapes.
    const bsTokens = asStrArray(attr(prim, 'skel:blendShapes'));
    const bsTargets = findProp(prim, 'skel:blendShapeTargets')?.targets ?? [];
    const targets: IRMorphTarget[] = [];
    bsTokens.forEach((tok, ti) => {
      const bsPrim = bsTargets[ti] ? primByPath.get(bsTargets[ti]) : undefined;
      if (!bsPrim) { diagnostics.push(diag('USD_SCHEMA_ERROR', prim.path, `skel:blendShapeTargets has no prim for blend shape "${tok}".`, { property: 'skel:blendShapeTargets', severity: 'warning' })); return; }
      const offsets = asNumArray(attr(bsPrim, 'offsets')), nOff = asNumArray(attr(bsPrim, 'normalOffsets')), pi = asNumArray(attr(bsPrim, 'pointIndices'));
      const expand = (src: ArrayLike<number> | null): Float32Array | null => {
        if (!src) return null;
        const out = new Float32Array(nPoints * 3);
        if (pi) { for (let i = 0; i < pi.length; i++) for (let k = 0; k < 3; k++) out[pi[i] * 3 + k] = src[i * 3 + k] ?? 0; }
        else out.set(Array.from(src).slice(0, nPoints * 3));
        return out;
      };
      targets.push({ index: ti, name: tok, path: bsPrim.path, positions: expand(offsets), normals: expand(nOff), defaultWeight: 0 });
    });

    // Build vertex streams (welded or per-corner).
    let vPositions = positions, vNormals: Float32Array | null = null, vUvs: IRUvSet[] = [], vJoints = joints, vWeights = weights, vTargets = targets;
    let tris: Uint32Array, triOfFace: Uint32Array, vertexCount: number;
    if (needUnweld) {
      const corners = fvi.length;
      vertexCount = corners;
      vPositions = new Float32Array(corners * 3);
      for (let c = 0; c < corners; c++) for (let k = 0; k < 3; k++) vPositions[c * 3 + k] = positions[fvi[c] * 3 + k];
      const faceOfCorner = new Uint32Array(corners);
      { let c = 0; for (let f = 0; f < counts.length; f++) for (let k = 0; k < counts[f]; k++) faceOfCorner[c++] = f; }
      const perCorner = (src: Float32Array, w: number, mode: string): Float32Array => {
        const out = new Float32Array(corners * w);
        for (let c = 0; c < corners; c++) {
          const s = mode === 'faceVarying' ? c : mode === 'uniform' ? faceOfCorner[c] : mode === 'constant' ? 0 : fvi[c];
          for (let k = 0; k < w; k++) out[c * w + k] = src[s * w + k] ?? 0;
        }
        return out;
      };
      if (normalsArr) vNormals = perCorner(normalsArr, 3, normalsInterp);
      vUvs = uvSets.map((u) => ({ name: u.name, data: perCorner(u.pv.data, 2, u.pv.interp) }));
      if (joints && weights) { vJoints = new Uint16Array(corners * influences); vWeights = new Float32Array(corners * influences); for (let c = 0; c < corners; c++) for (let k = 0; k < influences; k++) { vJoints[c * influences + k] = joints[fvi[c] * influences + k]; vWeights[c * influences + k] = weights[fvi[c] * influences + k]; } }
      vTargets = targets.map((t) => ({ ...t, positions: t.positions ? perCorner(t.positions, 3, 'vertex') : null, normals: t.normals ? perCorner(t.normals, 3, 'vertex') : null }));
      const seq = new Uint32Array(corners); for (let i = 0; i < corners; i++) seq[i] = i;
      ({ tris, triOfFace } = triangulate(counts, seq));
    } else {
      vertexCount = nPoints;
      vNormals = normalsArr && normalsArr.length >= nPoints * 3 ? normalsArr : null;
      vUvs = uvSets.filter((u) => u.pv.data.length >= nPoints * 2).map((u) => ({ name: u.name, data: u.pv.data }));
      ({ tris, triOfFace } = triangulate(counts, fvi));
    }

    // GeomSubsets with material bindings split the faces into separate draw calls.
    const subsets = prim.children.filter((c) => c.typeName === 'GeomSubset' && (asStr(attr(c, 'familyName')) ?? 'materialBind') === 'materialBind' && findProp(c, 'material:binding'));
    const materialOf = (p: UsdPrimNode): number | null => { const t = inheritedRel(p, 'material:binding'); return t !== null && materialByPath.has(t) ? materialByPath.get(t)! : null; };
    const geometryBytes = vertexCount * (12 + (vNormals ? 12 : 0) + vUvs.length * 8 + influences * 6) + tris.length * 4;
    const pushMesh = (path: string, name: string, primitiveIndex: number, faceFilter: Set<number> | null, material: number | null) => {
      let indices = tris, faceCount = counts.length;
      if (faceFilter) {
        const keep: number[] = [];
        for (let t = 0; t < triOfFace.length; t++) if (faceFilter.has(triOfFace[t])) keep.push(tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]);
        indices = Uint32Array.from(keep); faceCount = faceFilter.size;
      }
      const index = meshes.length;
      meshes.push({
        index, path, name, node: ni, sourceMesh: meshOrdinal, primitiveIndex, mode: 'triangles',
        positions: vPositions, vertexCount, indices, faceCount, triangleCount: indices.length / 3,
        normals: vNormals, normalsSource: vNormals ? 'authored' : 'missing', uvs: vUvs,
        joints: vJoints, weights: vWeights, influences, skin: skinIndex, material,
        targets: vTargets.map((t) => ({ ...t, path: t.path })), doubleSided: attr(prim, 'doubleSided') === true, geometryBytes: faceFilter ? Math.round(geometryBytes * (faceCount / Math.max(1, counts.length))) : geometryBytes,
      });
      nodes[ni].meshes.push(index);
    };
    if (subsets.length) {
      const covered = new Set<number>();
      subsets.forEach((s, si) => {
        const faces = new Set(Array.from(asNumArray(attr(s, 'indices')) ?? []));
        for (const f of faces) covered.add(f);
        pushMesh(s.path, s.name, si, faces, materialOf(s));
      });
      const rest = new Set<number>();
      for (let f = 0; f < counts.length; f++) if (!covered.has(f)) rest.add(f);
      if (rest.size) pushMesh(prim.path, prim.name, subsets.length, rest, materialOf(prim));
    } else {
      pushMesh(prim.path, prim.name, 0, null, materialOf(prim));
    }
    // Blend shape weight channel from the skeleton's animation.
    if (skinIndex !== null && targets.length) {
      const bw = blendWeightSamples.get(skinIndex);
      if (bw) {
        const values: number[] = [];
        for (const s of bw.values) for (const t of targets) { const j = bw.tokens.indexOf(t.name); values.push(j >= 0 ? s[j] ?? 0 : 0); }
        weightChannels.push({ node: ni, times: bw.times, values, width: targets.length });
      }
    }
    meshOrdinal++;
  }

  // --- animation (one timeline per layer) ---
  const animations: IRAnimation[] = [];
  const allChannels: IRChannel[] = [
    ...xformChannels.map((c) => ({ node: c.node, property: c.property, times: Float32Array.from(c.times), values: Float32Array.from(c.values), width: c.width, interpolation: 'LINEAR' as const })),
    ...skelAnimChannels.map((c) => ({ node: c.node, property: c.property, times: Float32Array.from(c.times), values: Float32Array.from(c.values), width: c.width, interpolation: 'LINEAR' as const })),
    ...weightChannels.map((c) => ({ node: c.node, property: 'weights' as const, times: Float32Array.from(c.times), values: Float32Array.from(c.values), width: c.width, interpolation: 'LINEAR' as const })),
  ];
  if (allChannels.length || timeSampledProps.length) {
    let start = typeof meta.startTimeCode === 'number' ? meta.startTimeCode / tcps : Infinity;
    let end = typeof meta.endTimeCode === 'number' ? meta.endTimeCode / tcps : -Infinity;
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      for (const c of allChannels) { if (c.times.length) { start = Math.min(start, c.times[0]); end = Math.max(end, c.times[c.times.length - 1]); } }
      if (!Number.isFinite(start)) { start = 0; end = 0; }
    }
    const animPrim = [...walkPrims(layer.prims)].find((p) => p.typeName === 'SkelAnimation');
    animations.push({ index: 0, path: animPrim?.path ?? defaultPrim ?? '/', name: animPrim?.name ?? 'timeSamples', channels: allChannels, start, end });
  }

  return {
    format: opts.format, sourcePath: opts.sourcePath ?? null, fileBytes: opts.fileBytes ?? 0,
    upAxis, metersPerUnit, defaultPrim, layerStack,
    nodes, roots, meshes, materials, textures, skins, animations,
    fps: tcps, primCount: layer.primCount,
    extensions: { used: [], required: [] }, generator: asStr(meta.documentation) ?? null,
    prims, timeSampledProps, diagnostics,
  };
}
