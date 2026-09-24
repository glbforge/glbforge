import { Document } from '@gltf-transform/core';
import type { TopologyStats } from './types.js';

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
 *
 * `topology`, when passed, is the same edge-multiplicity check `inspect`/
 * `export_stl` report as "watertight" — pass it (`analyze()` already
 * computes it) so the forge note doesn't repeat a blanket "watertight by
 * construction" for an asset this build's own numbers say isn't. That check
 * is still necessary, not sufficient: `extrude/build.ts`'s bevel path can
 * self-intersect at a concave silhouette corner at a small bevel radius
 * (its own `insetDirections` doc comment names the risk — a miter limit,
 * not a guarantee), which an edge count cannot see either way. So the note
 * never promises unconditional watertightness for a bevelled rim, even when
 * `topology` reports it closed.
 */
export function detectGenerator(doc: Document, topology?: TopologyStats | null): GeneratorProfile {
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
    const closed = topology ? topology.boundaryEdges === 0 && topology.nonManifoldEdges === 0 : null;
    const note = closed === false
      ? `Forged by glbforge extrude — deterministic, but this asset's own topology is not closed (${topology!.boundaryEdges} boundary, ${topology!.nonManifoldEdges} non-manifold edge(s)); do not assume the STL export is watertight.`
      : 'Forged by glbforge extrude — deterministic. A flat (bevel=0) forge is edge-closed by construction; a beveled rim can still self-intersect at a deeply concave silhouette corner, which an edge-count "watertight" check cannot catch — confirm a beveled STL slices cleanly before printing.';
    return { guess: 'glbforge-forge', confidence: 'high', notes: [note] };
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
