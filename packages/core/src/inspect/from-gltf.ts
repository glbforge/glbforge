/**
 * gltf-transform Document → SceneIR. Pure (no I/O); the Node loader in
 * load.ts handles files and tells this adapter which images failed to
 * resolve so textures can be reported as unresolved instead of the loader
 * throwing.
 */
import { Document, ImageUtils, Material, Node, Primitive, Texture, TextureInfo } from '@gltf-transform/core';
import { readFloat } from '../accessors.js';
import { imageHasAlpha } from '../analyze/materials.js';
import { diag, type Diagnostic } from './diagnostics.js';
import {
  ident, mat4Compose, mat4Mul, IDENTITY,
  type IRAnimation, type IRChannel, type IRMaterial, type IRMesh, type IRNode, type IRSkin, type IRTexture, type IRTextureUse, type SceneIR,
} from './ir.js';

export interface FromGltfOptions {
  format?: 'glb' | 'gltf';
  sourcePath?: string | null;
  fileBytes?: number;
  /** Image URIs (or texture indices) the loader could not resolve. */
  unresolvedTextures?: Set<string | number>;
  /** Diagnostics raised while loading (buffer/texture resolution). */
  diagnostics?: Diagnostic[];
}

const TEXTURE_SLOTS: Array<[string, string, 'sRGB' | 'raw', (m: Material) => Texture | null, (m: Material) => TextureInfo | null]> = [
  ['baseColor', 'rgba', 'sRGB', (m) => m.getBaseColorTexture(), (m) => m.getBaseColorTextureInfo()],
  ['metallicRoughness', 'gb', 'raw', (m) => m.getMetallicRoughnessTexture(), (m) => m.getMetallicRoughnessTextureInfo()],
  ['normal', 'rgb', 'raw', (m) => m.getNormalTexture(), (m) => m.getNormalTextureInfo()],
  ['occlusion', 'r', 'raw', (m) => m.getOcclusionTexture(), (m) => m.getOcclusionTextureInfo()],
  ['emissive', 'rgb', 'sRGB', (m) => m.getEmissiveTexture(), (m) => m.getEmissiveTextureInfo()],
];

const nodeLabel = (n: Node, i: number) => `${ident(n.getName() || 'Node')}_${i}`;

function toTriangleList(prim: Primitive): { indices: Uint32Array | null; mode: IRMesh['mode'] } {
  const mode = prim.getMode();
  const count = prim.getAttribute('POSITION')?.getCount() ?? 0;
  const raw = prim.getIndices()?.getArray() ?? null;
  const src = raw ?? Uint32Array.from({ length: count }, (_, i) => i);
  if (mode === Primitive.Mode.TRIANGLES) {
    const n = Math.floor(src.length / 3) * 3;
    return { indices: Uint32Array.from(src.subarray(0, n)), mode: 'triangles' };
  }
  if (mode === Primitive.Mode.TRIANGLE_STRIP) {
    const out: number[] = [];
    for (let i = 0; i + 2 < src.length; i++) {
      if (i % 2 === 0) out.push(src[i], src[i + 1], src[i + 2]); else out.push(src[i + 1], src[i], src[i + 2]);
    }
    return { indices: Uint32Array.from(out), mode: 'triangles' };
  }
  if (mode === Primitive.Mode.TRIANGLE_FAN) {
    const out: number[] = [];
    for (let i = 1; i + 1 < src.length; i++) out.push(src[0], src[i], src[i + 1]);
    return { indices: Uint32Array.from(out), mode: 'triangles' };
  }
  if (mode === Primitive.Mode.POINTS) return { indices: null, mode: 'points' };
  if (mode === Primitive.Mode.LINES || mode === Primitive.Mode.LINE_STRIP || mode === Primitive.Mode.LINE_LOOP) return { indices: null, mode: 'lines' };
  return { indices: null, mode: 'other' };
}

export function fromGltf(doc: Document, opts: FromGltfOptions = {}): SceneIR {
  const root = doc.getRoot();
  const diagnostics: Diagnostic[] = [...(opts.diagnostics ?? [])];
  const gltfNodes = root.listNodes();
  const nodeIndex = new Map<Node, number>(gltfNodes.map((n, i) => [n, i]));
  const gltfMeshes = root.listMeshes();
  const gltfMaterials = root.listMaterials();
  const gltfTextures = root.listTextures();
  const gltfSkins = root.listSkins();
  const gltfAnimations = root.listAnimations();

  // --- textures ---
  const textures: IRTexture[] = gltfTextures.map((tex, i) => {
    const image = tex.getImage();
    const uri = tex.getURI() || null;
    const unresolved = !!opts.unresolvedTextures && (opts.unresolvedTextures.has(i) || (uri !== null && opts.unresolvedTextures.has(uri)));
    const size = image && !unresolved ? ImageUtils.getSize(image, tex.getMimeType()) : null;
    return {
      index: i,
      path: `/Asset/Textures/${ident(tex.getName() || (uri ? uri.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') : 'Texture'))}_${i}`,
      name: tex.getName() || uri || `texture_${i}`,
      uri,
      resolved: !unresolved && !!image && image.byteLength > 0,
      mimeType: tex.getMimeType() || null,
      width: size?.[0] ?? null,
      height: size?.[1] ?? null,
      bytes: unresolved ? 0 : image?.byteLength ?? 0,
      hasAlpha: image && !unresolved ? imageHasAlpha(image, tex.getMimeType()) : null,
      data: unresolved ? null : image,
    };
  });
  const textureIndex = new Map<Texture, number>(gltfTextures.map((t, i) => [t, i]));

  // --- materials ---
  const materials: IRMaterial[] = gltfMaterials.map((mat, i) => {
    const uses: IRTextureUse[] = [];
    for (const [input, channel, colorSpace, get, getInfo] of TEXTURE_SLOTS) {
      const tex = get(mat);
      if (!tex) continue;
      uses.push({ texture: textureIndex.get(tex)!, input, channel, colorSpace, texCoord: getInfo(mat)?.getTexCoord() ?? 0 });
    }
    const extNames = mat.listExtensions().map((e) => e.extensionName);
    const unsupported = extNames.filter((e) => !/KHR_texture_transform|KHR_materials_emissive_strength|KHR_materials_unlit/.test(e)).map((e) => e.replace(/^KHR_materials_/, ''));
    return {
      index: i,
      path: `/Asset/Materials/${ident(mat.getName() || 'Material')}_${i}`,
      name: mat.getName() || `material_${i}`,
      shaderType: extNames.includes('KHR_materials_unlit') ? 'unlit' : 'pbrMetallicRoughness',
      textures: uses,
      alphaMode: mat.getAlphaMode() as IRMaterial['alphaMode'],
      alphaCutoff: mat.getAlphaCutoff(),
      doubleSided: mat.getDoubleSided(),
      baseColorFactor: [...mat.getBaseColorFactor()],
      metallicFactor: mat.getMetallicFactor(),
      roughnessFactor: mat.getRoughnessFactor(),
      emissiveFactor: [...mat.getEmissiveFactor()],
      unsupportedFeatures: unsupported,
      sourceIndex: i,
    };
  });
  const materialIndex = new Map<Material, number>(gltfMaterials.map((m, i) => [m, i]));

  // --- nodes ---
  const nodes: IRNode[] = gltfNodes.map((n, i) => {
    const parent = n.listParents().find((p): p is Node => p instanceof Node) ?? null;
    return {
      index: i,
      path: `/Asset/${nodeLabel(n, i)}`,
      name: n.getName() || `node_${i}`,
      parent: parent ? nodeIndex.get(parent)! : null,
      children: n.listChildren().map((c) => nodeIndex.get(c)!),
      local: [...n.getMatrix()],
      translation: [...n.getTranslation()],
      rotation: [...n.getRotation()],
      scale: [...n.getScale()],
      world: [...n.getWorldMatrix()],
      meshes: [],
      isJoint: false,
      sourceIndex: i,
    };
  });
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  const roots = scene ? scene.listChildren().map((c) => nodeIndex.get(c)!) : [];
  // Nodes outside the scene graph still get a world matrix from their own chain.
  for (const n of nodes) if (n.parent === null && !roots.includes(n.index)) n.world = n.local;

  // --- skins ---
  const skins: IRSkin[] = gltfSkins.map((skin, i) => {
    const ibm = skin.getInverseBindMatrices();
    const joints = skin.listJoints().map((j) => nodeIndex.get(j)!);
    for (const j of joints) nodes[j].isJoint = true;
    let inverseBind: IRSkin['inverseBind'] = null;
    if (ibm) {
      const arr = readFloat(ibm);
      inverseBind = joints.map((_, k) => Array.from(arr.subarray(k * 16, k * 16 + 16)));
    }
    const skel = skin.getSkeleton();
    return { index: i, path: `/Asset/Skel_${i}`, name: skin.getName() || `skin_${i}`, joints, inverseBind, root: null, sourceIndex: i, ...(skel ? { skeletonNode: nodeIndex.get(skel) } : {}) };
  });
  const skinIndex = new Map(gltfSkins.map((s, i) => [s, i]));
  const meshIndex = new Map(gltfMeshes.map((m, i) => [m, i]));

  // --- mesh primitives, one IR mesh per (node, primitive) ---
  const meshes: IRMesh[] = [];
  const visitOrder: number[] = [];
  const visit = (i: number) => { visitOrder.push(i); for (const c of nodes[i].children) visit(c); };
  for (const r of roots) visit(r);
  for (const n of nodes) if (!visitOrder.includes(n.index)) visitOrder.push(n.index);
  for (const ni of visitOrder) {
    const gn = gltfNodes[ni];
    const mesh = gn.getMesh();
    if (!mesh) continue;
    const skin = gn.getSkin();
    const nodePath = nodes[ni].path;
    const meshWeights = mesh.getWeights();
    mesh.listPrimitives().forEach((prim, pi) => {
      const posAcc = prim.getAttribute('POSITION');
      if (!posAcc) return;
      const positions = readFloat(posAcc);
      const vertexCount = posAcc.getCount();
      const { indices, mode } = toTriangleList(prim);
      const triangleCount = indices ? indices.length / 3 : 0;
      const nrmAcc = prim.getAttribute('NORMAL');
      const uvs = prim.listSemantics().filter((s) => s.startsWith('TEXCOORD_')).sort()
        .map((s) => ({ name: s === 'TEXCOORD_0' ? 'st' : `st${s.slice(9)}`, data: readFloat(prim.getAttribute(s)!) }));
      const j0 = prim.getAttribute('JOINTS_0'), w0 = prim.getAttribute('WEIGHTS_0');
      const j1 = prim.getAttribute('JOINTS_1'), w1 = prim.getAttribute('WEIGHTS_1');
      let joints: Uint16Array | null = null, weights: Float32Array | null = null, influences = 0;
      if (j0 && w0) {
        influences = j1 && w1 ? 8 : 4;
        joints = new Uint16Array(vertexCount * influences); weights = new Float32Array(vertexCount * influences);
        const ja = j0.getArray()!, wa = readFloat(w0);
        for (let v = 0; v < vertexCount; v++) for (let k = 0; k < 4; k++) { joints[v * influences + k] = ja[v * 4 + k]; weights[v * influences + k] = wa[v * 4 + k]; }
        if (j1 && w1) {
          const jb = j1.getArray()!, wb = readFloat(w1);
          for (let v = 0; v < vertexCount; v++) for (let k = 0; k < 4; k++) { joints[v * 8 + 4 + k] = jb[v * 4 + k]; weights[v * 8 + 4 + k] = wb[v * 4 + k]; }
        }
      }
      const path = `${nodePath}/Prim_${pi}`;
      const targets = prim.listTargets().map((t, ti) => {
        const p = t.getAttribute('POSITION'), n = t.getAttribute('NORMAL');
        const name = t.getName() || `target_${ti}`;
        return { index: ti, name, path: `${path}/BlendShape_${ti}_${ident(name)}`, positions: p ? readFloat(p) : null, normals: n ? readFloat(n) : null, defaultWeight: meshWeights[ti] ?? 0 };
      });
      let geometryBytes = 0;
      for (const sem of prim.listSemantics()) geometryBytes += prim.getAttribute(sem)!.getByteLength();
      geometryBytes += prim.getIndices()?.getByteLength() ?? 0;
      const mat = prim.getMaterial();
      const irIndex = meshes.length;
      meshes.push({
        index: irIndex, path, name: mesh.getName() || `mesh_${meshIndex.get(mesh)}`,
        node: ni, sourceMesh: meshIndex.get(mesh)!, primitiveIndex: pi, mode,
        positions, positionsQuantized: !(posAcc.getArray() instanceof Float32Array), vertexCount, indices, faceCount: triangleCount, triangleCount,
        normals: nrmAcc ? readFloat(nrmAcc) : null, normalsSource: nrmAcc ? 'authored' : 'missing',
        uvs, joints, weights, influences,
        skin: skin ? skinIndex.get(skin)! : null,
        material: mat ? materialIndex.get(mat)! : null,
        targets, doubleSided: mat?.getDoubleSided() ?? false, geometryBytes,
      });
      nodes[ni].meshes.push(irIndex);
    });
  }

  // --- animations ---
  const animations: IRAnimation[] = gltfAnimations.map((anim, ai) => {
    const channels: IRChannel[] = [];
    let start = Infinity, end = -Infinity;
    for (const ch of anim.listChannels()) {
      const node = ch.getTargetNode(), sampler = ch.getSampler(), pathName = ch.getTargetPath();
      if (!node || !sampler || !pathName) continue;
      const input = sampler.getInput(), output = sampler.getOutput();
      if (!input || !output) continue;
      const times = readFloat(input), values = readFloat(output);
      const interpolation = sampler.getInterpolation() as IRChannel['interpolation'];
      const ni = nodeIndex.get(node)!;
      let width = pathName === 'rotation' ? 4 : 3;
      if (pathName === 'weights') {
        const mesh = node.getMesh();
        width = mesh ? (mesh.listPrimitives()[0]?.listTargets().length ?? 0) : 0;
        if (!width && times.length) width = Math.max(1, Math.round(values.length / times.length / (interpolation === 'CUBICSPLINE' ? 3 : 1)));
      }
      if (times.length) { start = Math.min(start, times[0]); end = Math.max(end, times[times.length - 1]); }
      channels.push({ node: ni, property: pathName as IRChannel['property'], times, values, width, interpolation });
    }
    if (!Number.isFinite(start)) { start = 0; end = 0; }
    return { index: ai, path: `/Asset/Animations/${ident(anim.getName() || 'Animation')}_${ai}`, name: anim.getName() || `animation_${ai}`, channels, start, end };
  });

  const generator = root.getAsset().generator ?? null;
  const version = root.getAsset().version;
  if (version && !/^2\./.test(version)) diagnostics.push(diag('GLTF_VERSION_UNSUPPORTED', '', `asset.version is "${version}"; only glTF 2.x is supported.`));

  return {
    format: opts.format ?? 'glb',
    sourcePath: opts.sourcePath ?? null,
    fileBytes: opts.fileBytes ?? 0,
    upAxis: 'Y',
    metersPerUnit: 1,
    defaultPrim: '/Asset',
    layerStack: [],
    nodes, roots, meshes, materials, textures, skins, animations,
    fps: null,
    primCount: nodes.length + meshes.length + materials.length + textures.length + skins.length + animations.length,
    extensions: { used: root.listExtensionsUsed().map((e) => e.extensionName), required: root.listExtensionsRequired().map((e) => e.extensionName) },
    generator,
    prims: [],
    timeSampledProps: [],
    diagnostics,
  };
}

/** Identity-safe world matrix for a node index (nodes outside the IR resolve to identity). */
export function nodeWorld(ir: SceneIR, index: number | null): number[] {
  return index === null ? IDENTITY : ir.nodes[index]?.world ?? IDENTITY;
}

/** Recompute world matrices from locals (after posing). */
export function recomputeWorlds(ir: SceneIR, locals: Map<number, number[]>): number[][] {
  const worlds = new Array<number[]>(ir.nodes.length);
  const visit = (i: number, parentWorld: number[] | null) => {
    const local = locals.get(i) ?? ir.nodes[i].local;
    worlds[i] = parentWorld ? mat4Mul(parentWorld, local) : local;
    for (const c of ir.nodes[i].children) visit(c, worlds[i]);
  };
  for (const r of ir.roots) visit(r, null);
  for (const n of ir.nodes) if (!worlds[n.index]) visit(n.index, n.parent !== null && worlds[n.parent] ? worlds[n.parent] : null);
  return worlds;
}

export { mat4Compose };
