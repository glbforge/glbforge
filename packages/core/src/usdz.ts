/**
 * USDZ export for iOS AR Quick Look (and any USD consumer). Writes an ASCII
 * USD layer with UsdPreviewSurface materials, packs it with PNG/JPEG
 * textures into a store-only, 64-byte-aligned zip. World transforms are
 * baked per mesh node (bind pose for skinned meshes — the export is static).
 * WebP/KTX2 textures are re-encoded because USDZ only allows PNG and JPEG.
 * Deterministic: fixed prim naming, fixed zip timestamps, fixed encoders.
 */
import { Document, Material, Node, Primitive, Texture, TextureInfo } from '@gltf-transform/core';
import { readFloat } from './accessors.js';
import { computeSmoothNormals } from './normals.js';
import { storeZip, type ZipEntry } from './zip.js';

/** Re-encode a texture for USDZ (PNG or JPEG only). Node's default uses sharp. */
export type UsdzTextureEncoder = (
  input: { bytes: Uint8Array; mimeType: string; slot: string },
  target: { format: 'png' | 'jpeg' },
) => Promise<{ bytes: Uint8Array; mimeType: 'image/png' | 'image/jpeg' }>;

export interface UsdzOptions {
  /** Encoding for color textures without alpha: png (lossless, default) or jpeg (smaller). Normal/ORM maps stay PNG. */
  colorFormat?: 'png' | 'jpeg';
  /** Environment texture transcoder (browsers: canvas). Node defaults to sharp. */
  textureEncoder?: UsdzTextureEncoder;
  /** Name of the root prim. Default "Asset". */
  name?: string;
}

export interface UsdzResult {
  usdz: Uint8Array;
  /** Files packed, in order (the USD layer first). */
  files: Array<{ name: string; bytes: number }>;
  meshes: number;
  triangles: number;
  materials: number;
  textures: number;
  warnings: string[];
}

const f = (n: number) => (Object.is(n, -0) ? 0 : n).toPrecision(7).replace(/\.?0+$/, '').replace(/^-0$/, '0');
const vec = (xs: ArrayLike<number>) => `(${Array.from(xs).map(f).join(', ')})`;
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

interface TexRef { file: string; index: number }

export async function toUsdz(doc: Document, opts: UsdzOptions = {}): Promise<UsdzResult> {
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  if (!scene) throw new Error('Document has no scene to export.');
  const encoder = opts.textureEncoder ?? (await sharpEncoder());
  const rootName = ident(opts.name ?? 'Asset');
  const warnings: string[] = [];
  const files: ZipEntry[] = [];

  // --- Textures: encode each once, name by index (deterministic).
  const texFiles = new Map<Texture, TexRef>();
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
    texFiles.set(tex, { file: name, index: i });
  }

  // --- Materials.
  const materials = root.listMaterials();
  const matPath = (m: Material) => `/${rootName}/Materials/${ident('Mat_' + materials.indexOf(m))}`;
  const materialBlocks: string[] = [];
  for (const mat of materials) {
    const path = matPath(mat);
    const name = ident('Mat_' + materials.indexOf(mat));
    const base = mat.getBaseColorFactor();
    const alphaMode = mat.getAlphaMode();
    const lines: string[] = [];
    const texShader = (label: string, tex: Texture, info: TextureInfo | null, opts2: { srgb: boolean; scale?: number[]; normal?: boolean }) => {
      const ref = texFiles.get(tex);
      if (!ref) return null;
      if (info && info.getTexCoord() !== 0) warnings.push(`${name}: ${label} uses TEXCOORD_${info.getTexCoord()}; USDZ export binds st (TEXCOORD_0).`);
      const wrap = (w: number) => (w === TextureInfo.WrapMode.CLAMP_TO_EDGE ? 'clamp' : w === TextureInfo.WrapMode.MIRRORED_REPEAT ? 'mirror' : 'repeat');
      const s = opts2.normal ? '(2, 2, 2, 1)' : opts2.scale ? vec(opts2.scale) : '(1, 1, 1, 1)';
      const b = opts2.normal ? '(-1, -1, -1, 0)' : '(0, 0, 0, 0)';
      lines.push(
        `        def Shader "${label}"`,
        `        {`,
        `            uniform token info:id = "UsdUVTexture"`,
        `            asset inputs:file = @${ref.file}@`,
        `            float2 inputs:st.connect = <${path}/stReader.outputs:result>`,
        `            token inputs:sourceColorSpace = "${opts2.srgb ? 'sRGB' : 'raw'}"`,
        `            token inputs:wrapS = "${wrap(info?.getWrapS() ?? TextureInfo.WrapMode.REPEAT)}"`,
        `            token inputs:wrapT = "${wrap(info?.getWrapT() ?? TextureInfo.WrapMode.REPEAT)}"`,
        `            float4 inputs:scale = ${s}`,
        `            float4 inputs:bias = ${b}`,
        `            float3 outputs:rgb`,
        `            float outputs:r`,
        `            float outputs:g`,
        `            float outputs:b`,
        `            float outputs:a`,
        `        }`,
      );
      return `${path}/${label}`;
    };

    const surface: string[] = [];
    const baseTex = mat.getBaseColorTexture();
    const baseShader = baseTex ? texShader('baseColorTex', baseTex, mat.getBaseColorTextureInfo(), { srgb: true, scale: [base[0], base[1], base[2], base[3]] }) : null;
    surface.push(baseShader
      ? `            color3f inputs:diffuseColor.connect = <${baseShader}.outputs:rgb>`
      : `            color3f inputs:diffuseColor = ${vec([base[0], base[1], base[2]])}`);
    if (alphaMode !== 'OPAQUE') {
      surface.push(baseShader
        ? `            float inputs:opacity.connect = <${baseShader}.outputs:a>`
        : `            float inputs:opacity = ${f(base[3])}`);
      if (alphaMode === 'MASK') surface.push(`            float inputs:opacityThreshold = ${f(mat.getAlphaCutoff())}`);
    }
    const mrTex = mat.getMetallicRoughnessTexture();
    const mrShader = mrTex ? texShader('metallicRoughnessTex', mrTex, mat.getMetallicRoughnessTextureInfo(), { srgb: false, scale: [1, mat.getRoughnessFactor(), mat.getMetallicFactor(), 1] }) : null;
    surface.push(mrShader
      ? `            float inputs:roughness.connect = <${mrShader}.outputs:g>`
      : `            float inputs:roughness = ${f(mat.getRoughnessFactor())}`);
    surface.push(mrShader
      ? `            float inputs:metallic.connect = <${mrShader}.outputs:b>`
      : `            float inputs:metallic = ${f(mat.getMetallicFactor())}`);
    const nTex = mat.getNormalTexture();
    const nShader = nTex ? texShader('normalTex', nTex, mat.getNormalTextureInfo(), { srgb: false, normal: true }) : null;
    if (nShader) surface.push(`            normal3f inputs:normal.connect = <${nShader}.outputs:rgb>`);
    const oTex = mat.getOcclusionTexture();
    const oShader = oTex ? (oTex === mrTex ? mrShader : texShader('occlusionTex', oTex, mat.getOcclusionTextureInfo(), { srgb: false })) : null;
    if (oShader) surface.push(`            float inputs:occlusion.connect = <${oShader}.outputs:r>`);
    const eTex = mat.getEmissiveTexture();
    const em = mat.getEmissiveFactor();
    const eShader = eTex ? texShader('emissiveTex', eTex, mat.getEmissiveTextureInfo(), { srgb: true, scale: [em[0], em[1], em[2], 1] }) : null;
    if (eShader) surface.push(`            color3f inputs:emissiveColor.connect = <${eShader}.outputs:rgb>`);
    else if (em.some((c) => c > 0)) surface.push(`            color3f inputs:emissiveColor = ${vec(em)}`);
    surface.push(`            int inputs:useSpecularWorkflow = 0`);
    if (mat.getExtension('KHR_materials_transmission') || mat.getExtension('KHR_materials_clearcoat')) {
      warnings.push(`${name}: transmission/clearcoat extensions are not representable in UsdPreviewSurface.`);
    }

    materialBlocks.push([
      `    def Material "${name}"`,
      `    {`,
      `        token outputs:surface.connect = <${path}/PBRShader.outputs:surface>`,
      ``,
      `        def Shader "PBRShader"`,
      `        {`,
      `            uniform token info:id = "UsdPreviewSurface"`,
      ...surface,
      `            token outputs:surface`,
      `        }`,
      ``,
      `        def Shader "stReader"`,
      `        {`,
      `            uniform token info:id = "UsdPrimvarReader_float2"`,
      `            token inputs:varname = "st"`,
      `            float2 outputs:result`,
      `        }`,
      ...(lines.length ? ['', ...lines] : []),
      `    }`,
    ].join('\n'));
  }

  // --- Meshes: one Xform per mesh-bearing node, world transform baked.
  const meshBlocks: string[] = [];
  let meshCount = 0, triangles = 0, nodeIndex = 0;
  const visit = (node: Node): void => {
    const mesh = node.getMesh();
    if (mesh) {
      const m = node.getWorldMatrix();
      const xformName = ident(node.getName() || `Node_${nodeIndex}`) + `_${nodeIndex}`;
      nodeIndex++;
      const prims: string[] = [];
      mesh.listPrimitives().forEach((prim, pi) => {
        const block = primBlock(prim, pi, xformName);
        if (!block) return;
        prims.push(block.text);
        triangles += block.triangles;
        meshCount++;
      });
      if (prims.length) {
        meshBlocks.push([
          `    def Xform "${xformName}"`,
          `    {`,
          `        matrix4d xformOp:transform = ( ${vec(m.slice(0, 4))}, ${vec(m.slice(4, 8))}, ${vec(m.slice(8, 12))}, ${vec(m.slice(12, 16))} )`,
          `        uniform token[] xformOpOrder = ["xformOp:transform"]`,
          ``,
          prims.join('\n\n'),
          `    }`,
        ].join('\n'));
      }
    }
    for (const child of node.listChildren()) visit(child);
  };
  const primBlock = (prim: Primitive, pi: number, xformName: string): { text: string; triangles: number } | null => {
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
    const points: string[] = new Array(count);
    const normals: string[] = nrm ? new Array(count) : [];
    const st: string[] = uv ? new Array(count) : [];
    for (let i = 0; i < count; i++) {
      points[i] = `(${f(pos[i * 3])}, ${f(pos[i * 3 + 1])}, ${f(pos[i * 3 + 2])})`;
      if (nrm) normals[i] = `(${f(nrm[i * 3])}, ${f(nrm[i * 3 + 1])}, ${f(nrm[i * 3 + 2])})`;
      if (uv) st[i] = `(${f(uv[i * 2])}, ${f(1 - uv[i * 2 + 1])})`; // glTF v is top-down; USD st is bottom-up
    }
    const counts = new Array(triCount).fill('3').join(', ');
    const indices = Array.from(idx.subarray(0, triCount * 3)).join(', ');
    const lines = [
      `        def Mesh "${ident('Prim_' + pi)}"${mat ? ' (\n            prepend apiSchemas = ["MaterialBindingAPI"]\n        )' : ''}`,
      `        {`,
      `            uniform token subdivisionScheme = "none"`,
      `            bool doubleSided = ${mat?.getDoubleSided() ? 'true' : 'false'}`,
      `            int[] faceVertexCounts = [${counts}]`,
      `            int[] faceVertexIndices = [${indices}]`,
      `            point3f[] points = [${points.join(', ')}]`,
    ];
    if (nrm) lines.push(`            normal3f[] normals = [${normals.join(', ')}] (\n                interpolation = "vertex"\n            )`);
    if (uv) lines.push(`            texCoord2f[] primvars:st = [${st.join(', ')}] (\n                interpolation = "vertex"\n            )`);
    if (mat) lines.push(`            rel material:binding = <${matPath(mat)}>`);
    lines.push(`        }`);
    return { text: lines.join('\n'), triangles: triCount };
  };
  for (const child of scene.listChildren()) visit(child);
  if (root.listSkins().length || root.listAnimations().length) {
    warnings.push('Skins and animation clips are not exported: USDZ output is the static bind pose.');
  }

  const usda = [
    `#usda 1.0`,
    `(`,
    `    defaultPrim = "${rootName}"`,
    `    metersPerUnit = 1`,
    `    upAxis = "Y"`,
    `    doc = "Exported by GLBForge (glbforge.dev)"`,
    `)`,
    ``,
    `def Xform "${rootName}"`,
    `{`,
    ...(materialBlocks.length ? [`    def Scope "Materials"`, `    {`, materialBlocks.join('\n\n'), `    }`, ``] : []),
    meshBlocks.join('\n\n'),
    `}`,
    ``,
  ].join('\n');

  const entries: ZipEntry[] = [{ name: 'model.usda', data: new TextEncoder().encode(usda) }, ...files];
  const usdz = storeZip(entries);
  return {
    usdz,
    files: entries.map((e) => ({ name: e.name, bytes: e.data.length })),
    meshes: meshCount,
    triangles,
    materials: materials.length,
    textures: files.length,
    warnings,
  };
}
