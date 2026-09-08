import { Document } from '@gltf-transform/core';
import {
  dedup,
  flatten,
  join,
  palette,
  prune,
  simplifyPrimitive,
  textureCompress,
  meshopt,
  weld,
} from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import type { Profile } from './types.js';
import { perceptualSnapshot, perceptualCompare, type PerceptualVerdict } from './harness/perceptual.js';
import { sharpTextureDecoder, type TextureDecoder } from './harness/render.js';
import { computeSmoothNormals } from './normals.js';
import { isDeforming, simplifyDeformingPrimitive } from './skinning.js';

/**
 * Environment-specific texture recompressor. Given the encoded source image
 * and its material slots, return re-encoded bytes (resized to maxSize) or
 * null to leave the texture untouched. Node's default uses sharp; browsers
 * supply a canvas-based encoder.
 */
export type TextureEncoder = (
  input: { bytes: Uint8Array; mimeType: string; slots: string[] },
  target: { maxSize: number },
) => Promise<{ bytes: Uint8Array; mimeType: string } | null>;

export interface OptimizeOptions {
  profile: Profile;
  /** Override the triangle target (defaults to profile.maxTriangles). */
  targetTriangles?: number;
  /** Skip texture resize/re-encode (geometry-only pass). */
  textures?: boolean;
  /** 'webp' (default, smallest file) or 'ktx2' (GPU-resident, ~8x less VRAM). */
  textureFormat?: 'webp' | 'ktx2';
  /** Custom texture recompressor (browser environments). Overrides the
   *  sharp-based default; ignored when textureFormat is 'ktx2'. */
  textureEncoder?: TextureEncoder;
  /** Skip meshopt compression (emit plain quantized GLB). */
  compress?: boolean;
  /** Perceptual verification: render fixed cameras before and after and
   *  score SSIM against profile.minSsim. Default: on in Node, off in
   *  browsers (pass a textureDecoder and verify: true to enable there). */
  verify?: boolean;
  /** Base-color decoder for the verification renders (browsers: canvas).
   *  Node defaults to sharp. Without one, textures are left out of the diff. */
  textureDecoder?: TextureDecoder;
  /** Keep the rendered before/after views on `perceptual.rendered` (for
   *  comparison sheets). Off by default — it is a few MB of pixels. */
  keepViews?: boolean;
  log?: (msg: string) => void;
}

export interface OptimizeSummary {
  steps: string[];
  trianglesBefore: number;
  trianglesAfter: number;
  /** Upper bound on geometric deviation from simplification, as a fraction
   *  of the mesh extent (from the meshopt error tolerance actually used).
   *  0 when no simplification ran — the geometry is untouched. */
  fidelityBound: number;
  /** Measured visual fidelity (SSIM before vs after on a fixed 4-camera
   *  rig), or null when verification was skipped. */
  perceptual: PerceptualVerdict | null;
}

const isNode = typeof process !== 'undefined' && !!(process as { versions?: { node?: string } }).versions?.node;

function countTriangles(doc: Document): number {
  let tris = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const indices = prim.getIndices();
      const count = indices
        ? indices.getCount()
        : prim.getAttribute('POSITION')?.getCount() ?? 0;
      tris += Math.floor(count / 3);
    }
  }
  return tris;
}

/**
 * Deterministic web-readiness pass for a glTF Document, in place:
 * dedup -> weld -> simplify-to-budget -> fill missing normals ->
 * texture resize+WebP -> prune -> meshopt compression.
 *
 * Simplification ratchets through an error-tolerance ladder because
 * AI-generated meshes routinely need 10x+ reduction, which a single
 * conservative pass won't reach.
 */
export async function optimize(
  doc: Document,
  opts: OptimizeOptions,
): Promise<OptimizeSummary> {
  const log = opts.log ?? (() => {});
  const steps: string[] = [];

  // Reference renders BEFORE any mutation; the frame is fixed here so the
  // cameras cannot drift when simplification shifts the bounds.
  const verify = opts.verify ?? isNode;
  let snapshot: Awaited<ReturnType<typeof perceptualSnapshot>> | null = null;
  if (verify) {
    // KTX2 output can't be decoded by sharp, so texture the diff only when
    // both sides can be decoded; otherwise compare geometry + shading.
    const decoder = opts.textureFormat === 'ktx2'
      ? undefined
      : opts.textureDecoder ?? (isNode ? sharpTextureDecoder() : undefined);
    snapshot = await perceptualSnapshot(doc, { textureDecoder: decoder });
  }
  const target = opts.targetTriangles ?? opts.profile.maxTriangles;

  await MeshoptSimplifier.ready;
  await MeshoptEncoder.ready;

  const trianglesBefore = countTriangles(doc);

  await doc.transform(dedup(), prune());
  steps.push('dedup+prune');

  // Multi-primitive assets (one material per submesh is a common AI-export
  // pattern) cost one draw call per primitive. Palette solid-color materials,
  // flatten the node hierarchy, then join primitives that share a material.
  const primCount = () =>
    doc.getRoot().listMeshes().reduce((n, m) => n + m.listPrimitives().length, 0);
  const primsBefore = primCount();
  if (primsBefore > 1) {
    await doc.transform(palette({ min: 5 }), flatten(), join());
    const primsAfter = primCount();
    if (primsAfter < primsBefore) {
      steps.push(`join ${primsBefore}->${primsAfter} prims`);
      log(`joined: ${primsBefore} -> ${primsAfter} draw calls`);
    }
  }

  await doc.transform(weld());
  steps.push('weld');
  log(`welded: ${countTriangles(doc).toLocaleString()} triangles`);

  // Error ladder: retry with looser geometric error until we reach the
  // budget (within 10%) or run out of tolerance. The last rung used is the
  // upper bound on how far the surface moved (fidelityBound).
  let fidelityBound = 0;
  let deformingPrims = 0;
  await MeshoptSimplifier.ready;
  for (const error of [0.001, 0.01, 0.05, 0.1]) {
    const current = countTriangles(doc);
    if (current <= target * 1.1) break;
    const ratio = target / current;
    deformingPrims = 0;
    for (const mesh of doc.getRoot().listMeshes()) {
      for (const prim of mesh.listPrimitives()) {
        const mode = prim.getMode();
        if (mode !== 4 && mode !== 5 && mode !== 6) continue;
        if (!prim.getAttribute('POSITION')) continue;
        if (isDeforming(prim)) {
          // Skinned / morphing: attribute-aware simplification that keeps
          // joint boundaries and remaps every target with the same plan.
          await simplifyDeformingPrimitive(prim, { ratio, error });
          deformingPrims++;
        } else {
          simplifyPrimitive(prim, { simplifier: MeshoptSimplifier, ratio, error });
        }
        if ((prim.getIndices()?.getCount() ?? prim.getAttribute('POSITION')!.getCount()) === 0) prim.dispose();
      }
      if (mesh.listPrimitives().length === 0) mesh.dispose();
    }
    fidelityBound = error;
    const after = countTriangles(doc);
    steps.push(`simplify(error=${error}) -> ${after.toLocaleString()}${deformingPrims ? ` (${deformingPrims} skinned/morphing prim${deformingPrims > 1 ? 's' : ''} bone-aware)` : ''}`);
    log(`simplify @ error=${error}: ${current.toLocaleString()} -> ${after.toLocaleString()}${deformingPrims ? ` (${deformingPrims} deforming prims bone-aware)` : ''}`);
  }

  // Fill missing normals with SMOOTH normals. gltf-transform's normals()
  // computes flat (per-face) normals, which unwelds the mesh to 3 verts per
  // triangle and renders faceted — wrong default for organic AI-generated
  // surfaces. We accumulate area-weighted face normals per *position* (so
  // welded and unwelded inputs behave identically), then re-weld.
  let addedNormals = false;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (prim.getAttribute('NORMAL')) continue;
      const out = computeSmoothNormals(prim);
      if (!out) continue;
      const normalAcc = doc
        .createAccessor()
        .setType('VEC3')
        .setArray(out)
        .setBuffer(doc.getRoot().listBuffers()[0]);
      prim.setAttribute('NORMAL', normalAcc);
      addedNormals = true;
    }
  }
  if (addedNormals) {
    await doc.transform(weld());
    steps.push('smooth-normals');
  }

  if (opts.textures !== false && doc.getRoot().listTextures().length > 0 && opts.textureFormat === 'ktx2') {
    const { ktx2Compress } = await import('./ktx2.js');
    const count = await ktx2Compress(doc, { maxSize: opts.profile.maxTextureSize, log });
    steps.push(`textures -> ktx2 x${count} @ ${opts.profile.maxTextureSize}px`);
  } else if (opts.textures !== false && doc.getRoot().listTextures().length > 0 && opts.textureEncoder) {
    // Environment-supplied encoder (e.g. canvas in the browser).
    const cap = opts.profile.maxTextureSize;
    const { listTextureSlots } = await import('@gltf-transform/functions');
    let encoded = 0;
    for (const texture of doc.getRoot().listTextures()) {
      const image = texture.getImage();
      if (!image || texture.getMimeType() === 'image/ktx2') continue;
      const result = await opts.textureEncoder(
        { bytes: image, mimeType: texture.getMimeType(), slots: listTextureSlots(texture) },
        { maxSize: cap },
      );
      if (result) {
        texture.setImage(result.bytes).setMimeType(result.mimeType);
        encoded++;
      }
    }
    if (encoded > 0) steps.push(`textures -> re-encoded x${encoded} @ ${cap}px`);
  } else if (opts.textures !== false && doc.getRoot().listTextures().length > 0) {
    const cap = opts.profile.maxTextureSize;
    const sharp = (await import('sharp')).default;
    // Normal maps get near-lossless encoding: lossy artifacts in a normal
    // map show up as shading noise, not subtle color shifts.
    await doc.transform(
      textureCompress({
        encoder: sharp,
        targetFormat: 'webp',
        resize: [cap, cap],
        quality: 82,
        slots: /^(?!normalTexture)/,
      }),
      textureCompress({
        encoder: sharp,
        targetFormat: 'webp',
        resize: [cap, cap],
        nearLossless: true,
        slots: /^normalTexture$/,
      }),
    );
    steps.push(`textures -> webp @ ${cap}px`);
  }

  await doc.transform(prune());

  if (opts.compress !== false) {
    await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
    steps.push('meshopt');
  }

  let perceptual: PerceptualVerdict | null = null;
  if (snapshot) {
    const result = await perceptualCompare(snapshot, doc, opts.keepViews);
    const threshold = opts.profile.minSsim;
    perceptual = { ...result, threshold, passed: result.ssimMin >= threshold };
    steps.push(`verify ssim=${result.ssimMin}${perceptual.passed ? '' : ' FAIL'}`);
    log(`visual fidelity: SSIM ${(result.ssimMean * 100).toFixed(1)}% mean, ${(result.ssimMin * 100).toFixed(1)}% min @ ${result.worstView} (floor ${(threshold * 100).toFixed(0)}%)`);
  }

  return { steps, trianglesBefore, trianglesAfter: countTriangles(doc), fidelityBound, perceptual };
}

/**
 * Strip all materials from a document's primitives. Used for LOD chain
 * files: they reuse the primary GLB's materials at runtime, so shipping
 * textures in every LOD would multiply the payload. Follow with prune()
 * (optimize() does) to drop the orphaned materials and textures.
 */
export function stripMaterials(doc: Document): void {
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) prim.setMaterial(null);
  }
}
