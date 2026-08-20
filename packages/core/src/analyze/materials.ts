import { Document, ImageUtils, Material, Texture } from '@gltf-transform/core';
import type { MaterialStats, TextureStats } from '../types.js';

const TEXTURE_SLOTS: Array<[string, (m: Material) => Texture | null]> = [
  ['baseColor', (m) => m.getBaseColorTexture()],
  ['metallicRoughness', (m) => m.getMetallicRoughnessTexture()],
  ['normal', (m) => m.getNormalTexture()],
  ['occlusion', (m) => m.getOcclusionTexture()],
  ['emissive', (m) => m.getEmissiveTexture()],
];

/**
 * Sniff for an alpha channel from encoded bytes alone — no decode.
 * PNG: IHDR color type 4/6. JPEG: never. WebP: VP8X flag / VP8L header bit.
 * Returns null for formats we don't inspect (e.g. KTX2).
 */
export function imageHasAlpha(bytes: Uint8Array | null, mimeType: string): boolean | null {
  if (!bytes || bytes.length < 32) return null;
  if (mimeType === 'image/jpeg') return false;
  if (mimeType === 'image/png') {
    const colorType = bytes[25]; // IHDR: width(4) height(4) depth(1) at offset 16
    return colorType === 4 || colorType === 6;
  }
  if (mimeType === 'image/webp') {
    const fourCC = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (fourCC === 'VP8X') return (bytes[20] & 0x10) !== 0;
    if (fourCC === 'VP8L') {
      const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
      return ((bits >>> 28) & 1) === 1; // 1-byte sig, then 14w+14h+alpha
    }
    return false; // plain 'VP8 ' lossy has no alpha
  }
  return null;
}

/** Estimated GPU bytes once uploaded: RGBA8 + mips; KTX2 stays ~4bpp. */
function estimateVram(width: number | null, height: number | null, mimeType: string): number {
  if (!width || !height) return 0;
  const base = mimeType === 'image/ktx2' ? width * height : width * height * 4;
  return Math.round(base * 1.33);
}

export function analyzeMaterials(doc: Document): {
  materials: MaterialStats[];
  duplicateMaterialGroups: string[][];
  textures: TextureStats[];
  textureBytesTotal: number;
  textureVramTotal: number;
} {
  const root = doc.getRoot();
  const materials = root.listMaterials();

  const materialStats: MaterialStats[] = [];
  // Texture -> "material/slot" references, for the report.
  const textureRefs = new Map<Texture, string[]>();
  // Render-state fingerprint -> material names, for duplicate detection.
  const fingerprints = new Map<string, string[]>();

  for (const mat of materials) {
    const name = mat.getName() || '(unnamed)';
    const slots: string[] = [];
    for (const [slot, get] of TEXTURE_SLOTS) {
      const tex = get(mat);
      if (!tex) continue;
      slots.push(slot);
      const refs = textureRefs.get(tex) ?? [];
      refs.push(`${name}/${slot}`);
      textureRefs.set(tex, refs);
    }
    materialStats.push({
      name,
      alphaMode: mat.getAlphaMode(),
      doubleSided: mat.getDoubleSided(),
      textureSlots: slots,
    });

    // Two materials are duplicates when every render-affecting property and
    // every texture reference matches; only their names differ.
    const fp = JSON.stringify({
      alphaMode: mat.getAlphaMode(),
      alphaCutoff: mat.getAlphaCutoff(),
      doubleSided: mat.getDoubleSided(),
      baseColorFactor: mat.getBaseColorFactor(),
      metallic: mat.getMetallicFactor(),
      roughness: mat.getRoughnessFactor(),
      emissive: mat.getEmissiveFactor(),
      textures: TEXTURE_SLOTS.map(([, get]) => {
        const tex = get(mat);
        return tex ? root.listTextures().indexOf(tex) : -1;
      }),
    });
    fingerprints.set(fp, [...(fingerprints.get(fp) ?? []), name]);
  }

  const duplicateMaterialGroups = [...fingerprints.values()].filter(
    (group) => group.length > 1,
  );

  const textures: TextureStats[] = [];
  let textureBytesTotal = 0;
  let textureVramTotal = 0;
  for (const tex of root.listTextures()) {
    const image = tex.getImage();
    const bytes = image?.byteLength ?? 0;
    textureBytesTotal += bytes;
    const size =
      image ? ImageUtils.getSize(image, tex.getMimeType()) : null;
    const vramBytes = estimateVram(size?.[0] ?? null, size?.[1] ?? null, tex.getMimeType());
    textureVramTotal += vramBytes;
    textures.push({
      name: tex.getName() || tex.getURI() || '(embedded)',
      mimeType: tex.getMimeType(),
      width: size?.[0] ?? null,
      height: size?.[1] ?? null,
      bytes,
      hasAlpha: imageHasAlpha(image, tex.getMimeType()),
      vramBytes,
      slots: textureRefs.get(tex) ?? [],
    });
  }

  return { materials: materialStats, duplicateMaterialGroups, textures, textureBytesTotal, textureVramTotal };
}
