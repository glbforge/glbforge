/**
 * USDZ export for iOS AR Quick Look (and any USD consumer). Builds a small
 * USD layer (see usd-ir.ts) with UsdPreviewSurface materials, serializes it
 * as binary crate (usdc, default) or ASCII (usda), and packs it with
 * PNG/JPEG textures into a store-only, 64-byte-aligned zip. World transforms
 * are baked per mesh node (bind pose for skinned meshes — the export is
 * static). WebP/KTX2 textures are re-encoded because USDZ only allows PNG
 * and JPEG. Deterministic: fixed prim naming, fixed zip timestamps, fixed
 * encoders.
 */
import { Document, Material, Node, Primitive, Texture, TextureInfo } from '@gltf-transform/core';
import { readFloat } from './accessors.js';
import { computeSmoothNormals } from './normals.js';
import { writeUsda, type UsdAttribute, type UsdLayer, type UsdPrim, type UsdProperty } from './usd-ir.js';
import { writeUsdc } from './usdc.js';
import { storeZip, type ZipEntry } from './zip.js';

/** Re-encode a texture for USDZ (PNG or JPEG only). Node's default uses sharp. */
export type UsdzTextureEncoder = (
  input: { bytes: Uint8Array; mimeType: string; slot: string },
  target: { format: 'png' | 'jpeg' },
) => Promise<{ bytes: Uint8Array; mimeType: 'image/png' | 'image/jpeg' }>;

export interface UsdzOptions {
  /** Layer encoding: binary crate (default; ~10x smaller than ASCII) or usda text. */
  format?: 'usdc' | 'usda';
  /** Encoding for color textures without alpha: png (lossless, default) or jpeg (smaller). Normal/ORM maps stay PNG. */
  colorFormat?: 'png' | 'jpeg';
  /** Environment texture transcoder (browsers: canvas). Node defaults to sharp. */
  textureEncoder?: UsdzTextureEncoder;
  /** Name of the root prim. Default "Asset". */
  name?: string;
}

export interface UsdzResult {
  usdz: Uint8Array;
  format: 'usdc' | 'usda';
  /** Files packed, in order (the USD layer first). */
  files: Array<{ name: string; bytes: number }>;
  meshes: number;
  triangles: number;
  materials: number;
  textures: number;
  warnings: string[];
}

const ident = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'x';

async function sharpEncoder(): Promise<UsdzTextureEncoder> {
  const sharp = (await import('sharp')).default;
  return async ({ bytes, mimeType }, { format }) => {
    if (mimeType === 'image/ktx2') {
      throw new Error('USDZ cannot carry KTX2 textures — export from the WebP/PNG variant (optimize without --ktx2).');
    }
    if (format === 'jpeg') {
      return { bytes: new Uint8Array(await sharp(Buffer.from(bytes)).jpeg({ quality: 90, mozjpeg: false }).toBuffer()), mimeType: 'image/jpeg' };
    }
    return { bytes: new Uint8Array(await sharp(Buffer.from(bytes)).png({ compressionLevel: 9 }).toBuffer()), mimeType: 'image/png' };
  };
}

/** Build the USD layer for a document; textures must already be resolved to file names. */
export function buildUsdLayer(
  doc: Document,
  texFiles: Map<Texture, string>,
  opts: { name?: string; warnings: string[] },
): { layer: UsdLayer; meshes: number; triangles: number } {
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  if (!scene) throw new Error('Document has no scene to export.');
  const rootName = ident(opts.name ?? 'Asset');
  const warnings = opts.warnings;
  const attr = (name: string, typeName: string, extra: Partial<UsdAttribute> = {}): UsdAttribute => ({ kind: 'attribute', name, typeName, ...extra });

  // --- Materials ---
  const materials = root.listMaterials();
  const matName = (m: Material) => ident('Mat_' + materials.indexOf(m));
  const matPath = (m: Material) => `/${rootName}/Materials/${matName(m)}`;
  const materialPrims: UsdPrim[] = materials.map((mat) => {
    const path = matPath(mat);
    const name = matName(mat);
    const base = mat.getBaseColorFactor();
    const alphaMode = mat.getAlphaMode();
    const shaders: UsdPrim[] = [];
    const wrap = (w: number) => (w === TextureInfo.WrapMode.CLAMP_TO_EDGE ? 'clamp' : w === TextureInfo.WrapMode.MIRRORED_REPEAT ? 'mirror' : 'repeat');
    const texShader = (label: string, tex: Texture, info: TextureInfo | null, o: { srgb: boolean; scale?: number[]; normal?: boolean }) => {
      const file = texFiles.get(tex);
      if (!file) return null;
      if (info && info.getTexCoord() !== 0) warnings.push(`${name}: ${label} uses TEXCOORD_${info.getTexCoord()}; USDZ export binds st (TEXCOORD_0).`);
      shaders.push({
        name: label, path: `${path}/${label}`, typeName: 'Shader', children: [],
        properties: [
          attr('info:id', 'token', { uniform: true, value: 'UsdUVTexture' }),
          attr('inputs:file', 'asset', { value: file }),
          attr('inputs:st', 'float2', { connect: `${path}/stReader.outputs:result` }),
          attr('inputs:sourceColorSpace', 'token', { value: o.srgb ? 'sRGB' : 'raw' }),
          attr('inputs:wrapS', 'token', { value: wrap(info?.getWrapS() ?? TextureInfo.WrapMode.REPEAT) }),
          attr('inputs:wrapT', 'token', { value: wrap(info?.getWrapT() ?? TextureInfo.WrapMode.REPEAT) }),
          attr('inputs:scale', 'float4', { value: o.normal ? [2, 2, 2, 1] : o.scale ?? [1, 1, 1, 1] }),
          attr('inputs:bias', 'float4', { value: o.normal ? [-1, -1, -1, 0] : [0, 0, 0, 0] }),
          attr('outputs:rgb', 'float3'), attr('outputs:r', 'float'), attr('outputs:g', 'float'), attr('outputs:b', 'float'), attr('outputs:a', 'float'),
        ],
      });
      return `${path}/${label}`;
    };

    const surface: UsdProperty[] = [attr('info:id', 'token', { uniform: true, value: 'UsdPreviewSurface' })];
    const baseTex = mat.getBaseColorTexture();
    const baseShader = baseTex ? texShader('baseColorTex', baseTex, mat.getBaseColorTextureInfo(), { srgb: true, scale: [base[0], base[1], base[2], base[3]] }) : null;
    surface.push(baseShader
      ? attr('inputs:diffuseColor', 'color3f', { connect: `${baseShader}.outputs:rgb` })
      : attr('inputs:diffuseColor', 'color3f', { value: [base[0], base[1], base[2]] }));
    if (alphaMode !== 'OPAQUE') {
      surface.push(baseShader
        ? attr('inputs:opacity', 'float', { connect: `${baseShader}.outputs:a` })
        : attr('inputs:opacity', 'float', { value: base[3] }));
      if (alphaMode === 'MASK') surface.push(attr('inputs:opacityThreshold', 'float', { value: mat.getAlphaCutoff() }));
    }
    const mrTex = mat.getMetallicRoughnessTexture();
    const mrShader = mrTex ? texShader('metallicRoughnessTex', mrTex, mat.getMetallicRoughnessTextureInfo(), { srgb: false, scale: [1, mat.getRoughnessFactor(), mat.getMetallicFactor(), 1] }) : null;
    surface.push(mrShader
      ? attr('inputs:roughness', 'float', { connect: `${mrShader}.outputs:g` })
      : attr('inputs:roughness', 'float', { value: mat.getRoughnessFactor() }));
    surface.push(mrShader
      ? attr('inputs:metallic', 'float', { connect: `${mrShader}.outputs:b` })
      : attr('inputs:metallic', 'float', { value: mat.getMetallicFactor() }));
    const nTex = mat.getNormalTexture();
    const nShader = nTex ? texShader('normalTex', nTex, mat.getNormalTextureInfo(), { srgb: false, normal: true }) : null;
    if (nShader) surface.push(attr('inputs:normal', 'normal3f', { connect: `${nShader}.outputs:rgb` }));
    const oTex = mat.getOcclusionTexture();
    const oShader = oTex ? (oTex === mrTex ? mrShader : texShader('occlusionTex', oTex, mat.getOcclusionTextureInfo(), { srgb: false })) : null;
    if (oShader) surface.push(attr('inputs:occlusion', 'float', { connect: `${oShader}.outputs:r` }));
    const eTex = mat.getEmissiveTexture();
    const em = mat.getEmissiveFactor();
    const eShader = eTex ? texShader('emissiveTex', eTex, mat.getEmissiveTextureInfo(), { srgb: true, scale: [em[0], em[1], em[2], 1] }) : null;
    if (eShader) surface.push(attr('inputs:emissiveColor', 'color3f', { connect: `${eShader}.outputs:rgb` }));
    else if (em.some((c) => c > 0)) surface.push(attr('inputs:emissiveColor', 'color3f', { value: [em[0], em[1], em[2]] }));
    surface.push(attr('inputs:useSpecularWorkflow', 'int', { value: 0 }));
    surface.push(attr('outputs:surface', 'token'));
    if (mat.getExtension('KHR_materials_transmission') || mat.getExtension('KHR_materials_clearcoat')) {
      warnings.push(`${name}: transmission/clearcoat extensions are not representable in UsdPreviewSurface.`);
    }

    return {
      name, path, typeName: 'Material',
      properties: [attr('outputs:surface', 'token', { connect: `${path}/PBRShader.outputs:surface` })],
      children: [
        { name: 'PBRShader', path: `${path}/PBRShader`, typeName: 'Shader', properties: surface, children: [] },
        {
          name: 'stReader', path: `${path}/stReader`, typeName: 'Shader', children: [],
          properties: [
            attr('info:id', 'token', { uniform: true, value: 'UsdPrimvarReader_float2' }),
            attr('inputs:varname', 'token', { value: 'st' }),
            attr('outputs:result', 'float2'),
          ],
        },
        ...shaders,
      ],
    };
  });

  // --- Meshes: one Xform per mesh-bearing node, world transform baked ---
  const nodePrims: UsdPrim[] = [];
  let meshCount = 0, triangles = 0, nodeIndex = 0;
  const primBlock = (prim: Primitive, pi: number, parentPath: string, xformName: string): UsdPrim | null => {
    if (prim.getMode() !== Primitive.Mode.TRIANGLES) { warnings.push(`${xformName}: primitive ${pi} is not a triangle list; skipped.`); return null; }
    const posAcc = prim.getAttribute('POSITION');
    if (!posAcc) return null;
    const pos = readFloat(posAcc);
    const count = posAcc.getCount();
    const idxAcc = prim.getIndices();
    const idx = idxAcc ? idxAcc.getArray()! : Uint32Array.from({ length: count }, (_, i) => i);
    const triCount = Math.floor(idx.length / 3);
    const nrmAcc = prim.getAttribute('NORMAL');
    const nrm = nrmAcc ? readFloat(nrmAcc) : computeSmoothNormals(prim);
    const uvAcc = prim.getAttribute('TEXCOORD_0');
    const uv = uvAcc ? readFloat(uvAcc) : null;
    const mat = prim.getMaterial();
    const indices = new Int32Array(triCount * 3);
    for (let i = 0; i < triCount * 3; i++) indices[i] = idx[i];
    const st = uv ? new Float32Array(count * 2) : null;
    if (uv && st) for (let i = 0; i < count; i++) { st[i * 2] = uv[i * 2]; st[i * 2 + 1] = 1 - uv[i * 2 + 1]; } // glTF v is top-down; USD st is bottom-up
    const name = ident('Prim_' + pi);
    const props: UsdProperty[] = [
      attr('subdivisionScheme', 'token', { uniform: true, value: 'none' }),
      attr('doubleSided', 'bool', { value: !!mat?.getDoubleSided() }),
      attr('faceVertexCounts', 'int[]', { value: new Int32Array(triCount).fill(3) }),
      attr('faceVertexIndices', 'int[]', { value: indices }),
      attr('points', 'point3f[]', { value: pos.subarray(0, count * 3) }),
    ];
    if (nrm) props.push(attr('normals', 'normal3f[]', { value: nrm.subarray(0, count * 3), interpolation: 'vertex' }));
    if (st) props.push(attr('primvars:st', 'texCoord2f[]', { value: st, interpolation: 'vertex' }));
    if (mat) props.push({ kind: 'relationship', name: 'material:binding', targets: [matPath(mat)] });
    triangles += triCount;
    meshCount++;
    return { name, path: `${parentPath}/${name}`, typeName: 'Mesh', apiSchemas: mat ? ['MaterialBindingAPI'] : undefined, properties: props, children: [] };
  };
  const visit = (node: Node): void => {
    const mesh = node.getMesh();
    if (mesh) {
      const m = node.getWorldMatrix();
      const xformName = ident(node.getName() || `Node_${nodeIndex}`) + `_${nodeIndex}`;
      nodeIndex++;
      const xpath = `/${rootName}/${xformName}`;
      const children: UsdPrim[] = [];
      mesh.listPrimitives().forEach((prim, pi) => { const p = primBlock(prim, pi, xpath, xformName); if (p) children.push(p); });
      if (children.length) {
        nodePrims.push({
          name: xformName, path: xpath, typeName: 'Xform', children,
          properties: [
            attr('xformOp:transform', 'matrix4d', { value: Array.from(m) }),
            attr('xformOpOrder', 'token[]', { uniform: true, value: ['xformOp:transform'] }),
          ],
        });
      }
    }
    for (const child of node.listChildren()) visit(child);
  };
  for (const child of scene.listChildren()) visit(child);
  if (root.listSkins().length || root.listAnimations().length) {
    warnings.push('Skins and animation clips are not exported: USDZ output is the static bind pose.');
  }

  const rootPrim: UsdPrim = {
    name: rootName, path: `/${rootName}`, typeName: 'Xform', properties: [],
    children: [
      ...(materialPrims.length ? [{ name: 'Materials', path: `/${rootName}/Materials`, typeName: 'Scope', properties: [], children: materialPrims }] : []),
      ...nodePrims,
    ],
  };
  return {
    layer: { defaultPrim: rootName, metersPerUnit: 1, upAxis: 'Y', doc: 'Exported by GLBForge (glbforge.dev)', prims: [rootPrim] },
    meshes: meshCount, triangles,
  };
}

export async function toUsdz(doc: Document, opts: UsdzOptions = {}): Promise<UsdzResult> {
  const root = doc.getRoot();
  const encoder = opts.textureEncoder ?? (await sharpEncoder());
  const format = opts.format ?? 'usdc';
  const warnings: string[] = [];
  const files: ZipEntry[] = [];

  // --- Textures: encode each once, name by index (deterministic).
  const texFiles = new Map<Texture, string>();
  const textures = root.listTextures();
  const slotOf = (tex: Texture): string => {
    for (const mat of root.listMaterials()) {
      if (mat.getBaseColorTexture() === tex) return 'baseColor';
      if (mat.getNormalTexture() === tex) return 'normal';
      if (mat.getMetallicRoughnessTexture() === tex) return 'metallicRoughness';
      if (mat.getOcclusionTexture() === tex) return 'occlusion';
      if (mat.getEmissiveTexture() === tex) return 'emissive';
    }
    return 'other';
  };
  const hasAlpha = (tex: Texture) => root.listMaterials().some((m) => m.getBaseColorTexture() === tex && m.getAlphaMode() !== 'OPAQUE');
  for (let i = 0; i < textures.length; i++) {
    const tex = textures[i];
    const image = tex.getImage();
    if (!image) continue;
    const slot = slotOf(tex);
    const wantJpeg = opts.colorFormat === 'jpeg' && (slot === 'baseColor' || slot === 'emissive') && !hasAlpha(tex);
    const encoded = await encoder({ bytes: image, mimeType: tex.getMimeType(), slot }, { format: wantJpeg ? 'jpeg' : 'png' });
    const name = `textures/tex_${i}.${encoded.mimeType === 'image/jpeg' ? 'jpg' : 'png'}`;
    files.push({ name, data: encoded.bytes });
    texFiles.set(tex, name);
  }

  const { layer, meshes, triangles } = buildUsdLayer(doc, texFiles, { name: opts.name, warnings });
  const layerBytes = format === 'usda' ? new TextEncoder().encode(writeUsda(layer)) : writeUsdc(layer);
  const entries: ZipEntry[] = [{ name: `model.${format}`, data: layerBytes }, ...files];
  return {
    usdz: storeZip(entries),
    format,
    files: entries.map((e) => ({ name: e.name, bytes: e.data.length })),
    meshes, triangles,
    materials: root.listMaterials().length,
    textures: files.length,
    warnings,
  };
}
