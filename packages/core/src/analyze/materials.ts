import { Document, ImageUtils, Material, Texture } from '@gltf-transform/core';
import type { MaterialStats, TextureStats } from '../types.js';

const TEXTURE_SLOTS: Array<[string, (m: Material) => Texture | null]> = [
  ['baseColor', (m) => m.getBaseColorTexture()],
  ['metallicRoughness', (m) => m.getMetallicRoughnessTexture()],
  ['normal', (m) => m.getNormalTexture()],
  ['occlusion', (m) => m.getOcclusionTexture()],
  ['emissive', (m) => m.getEmissiveTexture()],
];

export function analyzeMaterials(doc: Document): {
  materials: MaterialStats[];
  duplicateMaterialGroups: string[][];
  textures: TextureStats[];
  textureBytesTotal: number;
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
  for (const tex of root.listTextures()) {
    const image = tex.getImage();
    const bytes = image?.byteLength ?? 0;
    textureBytesTotal += bytes;
    const size =
      image ? ImageUtils.getSize(image, tex.getMimeType()) : null;
    textures.push({
      name: tex.getName() || tex.getURI() || '(embedded)',
      mimeType: tex.getMimeType(),
      width: size?.[0] ?? null,
      height: size?.[1] ?? null,
      bytes,
      slots: textureRefs.get(tex) ?? [],
    });
  }

  return { materials: materialStats, duplicateMaterialGroups, textures, textureBytesTotal };
}
