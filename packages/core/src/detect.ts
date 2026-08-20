import { Document } from '@gltf-transform/core';

export type GeneratorGuess =
  | 'meshy-geometry' | 'meshy-textured'
  | 'hunyuan3d' | 'trellis' | 'triposr'
  | 'glbforge-forge' | 'unknown';

export interface GeneratorProfile {
  guess: GeneratorGuess;
  confidence: 'high' | 'medium' | 'low';
  notes: string[];
}

/**
 * Fingerprint which generator produced an asset from its structural
 * signature. Powers generator-aware suggestions (each model family has
 * characteristic defects and characteristic fixes).
 */
export function detectGenerator(doc: Document): GeneratorProfile {
  const root = doc.getRoot();
  const generator = (root.getAsset().generator ?? '').toLowerCase();
  const textures = root.listTextures();
  const textureNames = textures.map((t) => (t.getName() || '').toLowerCase());
  const meshes = root.listMeshes();
  const prims = meshes.flatMap((m) => m.listPrimitives());
  const totalVerts = prims.reduce((n, p) => n + (p.getAttribute('POSITION')?.getCount() ?? 0), 0);
  const hasNormals = prims.some((p) => !!p.getAttribute('NORMAL'));
  const hasUVs = prims.some((p) => !!p.getAttribute('TEXCOORD_0'));

  if (generator.includes('glbforge')) {
    return { guess: 'glbforge-forge', confidence: 'high', notes: ['Forged by glbforge extrude — deterministic, watertight by construction.'] };
  }

  // Meshy exports ship through glTF-Transform with canonical texture names.
  const meshyTexNames = ['base_color', 'metallic_roughness', 'normal'];
  const meshyTextured = meshyTexNames.every((n) => textureNames.includes(n));
  if (generator.includes('gltf-transform') && meshyTextured) {
    return {
      guess: 'meshy-textured', confidence: 'high',
      notes: [
        'Meshy texture-stage signature (canonical PBR set via glTF-Transform).',
        'Position-duplicate vertices here are usually legitimate UV-seam splits, not waste.',
        'Known model-family weak spots: fine hair strands fuse into clumps; exact repeated patterns drift.',
      ],
    };
  }
  if (generator.includes('gltf-transform') && prims.length === 1 && !hasNormals && !hasUVs && totalVerts > 200_000) {
    return {
      guess: 'meshy-geometry', confidence: 'medium',
      notes: [
        'Looks like a Meshy geometry-stage export (single dense primitive, POSITION-only).',
        'Run the texture stage before shipping, or expect a clay render; normals are generated during optimize.',
      ],
    };
  }
  if (textureNames.some((n) => n.includes('hunyuan')) || generator.includes('hunyuan')) {
    return { guess: 'hunyuan3d', confidence: 'high', notes: ['Hunyuan3D export.'] };
  }
  if (generator.includes('trellis')) return { guess: 'trellis', confidence: 'high', notes: ['TRELLIS export.'] };
  if (generator.includes('tripo')) return { guess: 'triposr', confidence: 'medium', notes: ['Tripo-family export.'] };
  return { guess: 'unknown', confidence: 'low', notes: [] };
}
