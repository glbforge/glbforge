import { Document } from '@gltf-transform/core';
import {
  dedup,
  flatten,
  join,
  palette,
  prune,
  simplify,
  textureCompress,
  meshopt,
  weld,
} from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import type { Profile } from './types.js';

export interface OptimizeOptions {
  profile: Profile;
  /** Override the triangle target (defaults to profile.maxTriangles). */
  targetTriangles?: number;
  /** Skip texture resize/re-encode (geometry-only pass). */
  textures?: boolean;
  /** 'webp' (default, smallest file) or 'ktx2' (GPU-resident, ~8x less VRAM). */
  textureFormat?: 'webp' | 'ktx2';
  /** Skip meshopt compression (emit plain quantized GLB). */
  compress?: boolean;
  log?: (msg: string) => void;
}

export interface OptimizeSummary {
  steps: string[];
  trianglesBefore: number;
  trianglesAfter: number;
}

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
  // budget (within 10%) or run out of tolerance.
  for (const error of [0.001, 0.01, 0.05, 0.1]) {
    const current = countTriangles(doc);
    if (current <= target * 1.1) break;
    await doc.transform(
      simplify({
        simplifier: MeshoptSimplifier,
        ratio: target / current,
        error,
      }),
    );
    const after = countTriangles(doc);
    steps.push(`simplify(error=${error}) -> ${after.toLocaleString()}`);
    log(`simplify @ error=${error}: ${current.toLocaleString()} -> ${after.toLocaleString()}`);
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
      const position = prim.getAttribute('POSITION');
      const indices = prim.getIndices();
      if (!position || prim.getMode() !== 4) continue;
      const pos = position.getArray()!;
      const vertexCount = position.getCount();
      const idx = indices?.getArray() ?? null;
      const triCount = (idx ? idx.length : vertexCount) / 3;

      // Canonical index per exact position, so seams don't split shading.
      const canonical = new Uint32Array(vertexCount);
      const seen = new Map<string, number>();
      for (let i = 0; i < vertexCount; i++) {
        const key = pos[i * 3] + '|' + pos[i * 3 + 1] + '|' + pos[i * 3 + 2];
        const hit = seen.get(key);
        canonical[i] = hit ?? i;
        if (hit === undefined) seen.set(key, i);
      }

      const acc = new Float32Array(vertexCount * 3);
      for (let t = 0; t < triCount; t++) {
        const a = idx ? idx[t * 3] : t * 3;
        const b = idx ? idx[t * 3 + 1] : t * 3 + 1;
        const c = idx ? idx[t * 3 + 2] : t * 3 + 2;
        const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
        const ux = pos[b * 3] - ax, uy = pos[b * 3 + 1] - ay, uz = pos[b * 3 + 2] - az;
        const vx = pos[c * 3] - ax, vy = pos[c * 3 + 1] - ay, vz = pos[c * 3 + 2] - az;
        // Cross product magnitude = 2x area: free area weighting.
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        for (const v of [a, b, c]) {
          const ci = canonical[v];
          acc[ci * 3] += nx; acc[ci * 3 + 1] += ny; acc[ci * 3 + 2] += nz;
        }
      }
      const out = new Float32Array(vertexCount * 3);
      for (let i = 0; i < vertexCount; i++) {
        const ci = canonical[i];
        const nx = acc[ci * 3], ny = acc[ci * 3 + 1], nz = acc[ci * 3 + 2];
        const len = Math.hypot(nx, ny, nz) || 1;
        out[i * 3] = nx / len; out[i * 3 + 1] = ny / len; out[i * 3 + 2] = nz / len;
      }
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
  } else if (opts.textures !== false && doc.getRoot().listTextures().length > 0) {
    const cap = opts.profile.maxTextureSize;
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

  return { steps, trianglesBefore, trianglesAfter: countTriangles(doc) };
}
