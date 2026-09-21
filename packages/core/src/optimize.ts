import { Document, Primitive } from '@gltf-transform/core';
import {
  dedup,
  flatten,
  join,
  palette,
  prune,
  compactPrimitive,
  simplifyPrimitive,
  textureCompress,
  meshopt,
  weld,
} from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import type { Profile } from './types.js';
import { perceptualSnapshot, perceptualCompare, type PerceptualVerdict } from './harness/perceptual.js';
import { sharpTextureDecoder, type TextureDecoder } from './harness/render.js';
import { computeSmoothNormals, canonicalByPosition } from './normals.js';
import { readFloat } from './accessors.js';
import { sceneTriangles, sceneDrawCalls } from './analyze/geometry.js';
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
  /**
   * Which constraint decided where simplification stopped. 'budget' — the
   * triangle target was reached. 'fidelity' — going further would have
   * dropped below the profile's SSIM floor, so the asset stays over budget
   * on purpose. null — no simplification was needed, or it ran out of rungs.
   */
  boundBy: 'budget' | 'fidelity' | null;
  /**
   * Which stage spent the fidelity when the floor was missed: 'geometry'
   * (simplification), or 'textures' (the re-encode — geometry was still above
   * the floor when it was measured on its own). null when the floor held or
   * was never measured.
   */
  fidelityLostAt: 'geometry' | 'textures' | null;
  /** SSIM after simplification but before the texture re-encode, when measured. */
  geometrySsimMin: number | null;
}

const isNode = typeof process !== 'undefined' && !!(process as { versions?: { node?: string } }).versions?.node;

const LADDER = [0.001, 0.01, 0.05, 0.1] as const;

const mbLabel = (bytes: number): string => `${(bytes / 1048576).toFixed(1)}MB`;

/**
 * A copy of every triangle primitive's index and attribute arrays, so one
 * rung of the simplify ladder can be undone when the measured fidelity says
 * it went too far. Morph targets are copied too; a primitive that
 * simplification disposed makes the snapshot unusable, which the restore
 * reports rather than papering over.
 */
interface GeometrySnapshot {
  entries: Array<{
    prim: Primitive;
    indices: ArrayLike<number> | null;
    attrs: Array<[string, ArrayLike<number>]>;
    targets: Array<Array<[string, ArrayLike<number>]>>;
  }>;
}

function snapshotGeometry(doc: Document): GeometrySnapshot {
  const entries: GeometrySnapshot['entries'] = [];
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) continue;
      const idx = prim.getIndices()?.getArray() ?? null;
      entries.push({
        prim,
        indices: idx ? idx.slice() : null,
        attrs: prim.listSemantics().map((sem) => [sem, prim.getAttribute(sem)!.getArray()!.slice()] as [string, ArrayLike<number>]),
        targets: prim.listTargets().map((t) =>
          t.listSemantics().map((sem) => [sem, t.getAttribute(sem)!.getArray()!.slice()] as [string, ArrayLike<number>])),
      });
    }
  }
  return { entries };
}

/** Put a snapshot back. Returns false (changing nothing) if it no longer fits. */
function restoreGeometry(snap: GeometrySnapshot): boolean {
  for (const e of snap.entries) {
    if (e.prim.isDisposed()) return false;
    for (const [sem] of e.attrs) if (!e.prim.getAttribute(sem)) return false;
    if (e.indices && !e.prim.getIndices()) return false;
    if (e.prim.listTargets().length !== e.targets.length) return false;
  }
  for (const e of snap.entries) {
    for (const [sem, array] of e.attrs) e.prim.getAttribute(sem)!.setArray(array as never);
    if (e.indices) e.prim.getIndices()!.setArray(e.indices as never);
    e.prim.listTargets().forEach((t, i) => {
      for (const [sem, array] of e.targets[i]) t.getAttribute(sem)?.setArray(array as never);
    });
  }
  return true;
}

function countVertices(doc: Document): number {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) n += prim.getAttribute('POSITION')?.getCount() ?? 0;
  }
  return n;
}

/**
 * Remove triangles whose corners collapse to fewer than three distinct
 * positions. Measured in the same canonical-position space the report card
 * uses (`topo/degenerate`), so what we drop is exactly what it counts —
 * vertices split for a UV seam stay distinct, a collapsed edge does not.
 * Attributes and morph targets are untouched; only the index list shrinks.
 */
function dropDegenerateTriangles(doc: Document): number {
  let dropped = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) continue;
      const indices = prim.getIndices();
      const position = prim.getAttribute('POSITION');
      if (!indices || !position) continue;
      const idx = indices.getArray();
      if (!idx) continue;
      const canonical = canonicalByPosition(readFloat(position), position.getCount());
      const keep: number[] = [];
      for (let t = 0; t + 2 < idx.length; t += 3) {
        const a = canonical[idx[t]], b = canonical[idx[t + 1]], c = canonical[idx[t + 2]];
        if (a === b || b === c || a === c) { dropped++; continue; }
        keep.push(idx[t], idx[t + 1], idx[t + 2]);
      }
      if (keep.length === idx.length) continue;
      if (keep.length === 0) { prim.dispose(); continue; }
      const Ctor = idx.constructor as Uint8ArrayConstructor | Uint16ArrayConstructor | Uint32ArrayConstructor;
      const out = new Ctor(keep.length);
      out.set(keep);
      indices.setArray(out);
    }
    if (mesh.listPrimitives().length === 0) mesh.dispose();
  }
  return dropped;
}

/**
 * Counted over the scene, not the mesh list: the ladder targets
 * `profile.maxTriangles`, and that cap is checked against what the scene
 * draws. Counting the mesh list here let an instanced asset "reach" a budget
 * it still exceeded — the optimizer reported 149,170 while the report card
 * that ran a second later measured 166,978.
 */
function countTriangles(doc: Document): number {
  return sceneTriangles(doc);
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
  //
  // dedup() above can also turn several identical meshes into ONE mesh placed
  // by several nodes — real instancing, and a legitimate memory win with no
  // draw-call cost of its own. `primCount()` (the mesh list) goes to 1 in
  // that case and used to skip this block entirely, so an asset instanced
  // past the draw-call budget got the memory win silently and stayed over
  // budget: join() was never even asked to look at it. Giving up the
  // instancing is only worth it when the budget is actually failing on draw
  // calls, so that — not primCount() — is the second trigger; an instanced
  // asset that still clears maxDrawCalls keeps its instancing untouched.
  const primCount = () =>
    doc.getRoot().listMeshes().reduce((n, m) => n + m.listPrimitives().length, 0);
  const primsBefore = primCount();
  const drawCallsBefore = sceneDrawCalls(doc);
  if (primsBefore > 1 || drawCallsBefore > opts.profile.maxDrawCalls) {
    await doc.transform(palette({ min: 5 }), flatten(), join());
    const primsAfter = primCount();
    const drawCallsAfter = sceneDrawCalls(doc);
    if (drawCallsAfter < drawCallsBefore) {
      steps.push(`join ${drawCallsBefore}->${drawCallsAfter} draw calls`);
      log(`joined: ${drawCallsBefore} -> ${drawCallsAfter} draw calls`);
    } else if (primsAfter < primsBefore) {
      steps.push(`join ${primsBefore}->${primsAfter} prims`);
      log(`joined: ${primsBefore} -> ${primsAfter} draw calls`);
    }
  }

  await doc.transform(weld());
  steps.push('weld');
  log(`welded: ${countTriangles(doc).toLocaleString()} triangles`);

  // Error ladder: retry with looser geometric error until we reach the
  // budget or run out of tolerance. The last rung used is the upper bound on
  // how far the surface moved (fidelityBound).
  //
  // This used to stop within 10% of the target, which put the simplifier and
  // the budget rule in disagreement about the same asset: `optimize
  // --profile mobile-hero` would finish 7% over the cap and hand straight
  // back a perf/triangle-budget error telling the user to simplify. The
  // measured SSIM gate below is what protects fidelity here, not slop in the
  // stop condition.
  let fidelityBound = 0;
  let deformingPrims = 0;
  let degenerateDropped = 0;
  let lastRung: GeometrySnapshot | null = null;
  let rungsApplied = 0;
  let boundBy: 'budget' | 'fidelity' | null = null;
  let geometrySsimMin: number | null = null;
  await MeshoptSimplifier.ready;
  for (const error of LADDER) {
    const current = countTriangles(doc);
    if (current <= target) break;
    // Keep the state this rung starts from. If the measured fidelity below
    // says the rung went too far, this is what we go back to — the budget is
    // a target, the SSIM floor is the guarantee.
    lastRung = snapshot ? snapshotGeometry(doc) : null;
    rungsApplied++;
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
  // Fidelity check while the geometry can still be put back: textures and
  // meshopt have not run yet, so `snapshot` (taken before any mutation) and
  // the current doc differ by simplification alone. Only worth paying for
  // when the ladder had to escalate — an asset that met its target on the
  // gentlest rung has nothing to back off from.
  if (snapshot && lastRung && rungsApplied > 1) {
    const check = await perceptualCompare(snapshot, doc, false);
    geometrySsimMin = check.ssimMin;
    if (check.ssimMin < opts.profile.minSsim) {
      const restored = restoreGeometry(lastRung);
      if (restored) {
        boundBy = 'fidelity';
        fidelityBound = LADDER[rungsApplied - 2] ?? fidelityBound;
        // Re-measure what we backed off TO. Without this, the attribution
        // below still carries the score of the rung we rejected, and blames
        // the geometry for a floor the texture stage went on to cross.
        geometrySsimMin = (await perceptualCompare(snapshot, doc, false)).ssimMin;
        const back = countTriangles(doc);
        steps.push(`back off 1 rung -> ${back.toLocaleString()} (ssim ${(check.ssimMin * 100).toFixed(1)}% < floor)`);
        log(`backed off one rung: reaching ${target.toLocaleString()} triangles cost SSIM ${(check.ssimMin * 100).toFixed(1)}%, below the ${(opts.profile.minSsim * 100).toFixed(0)}% floor — stopped at ${back.toLocaleString()}`);
      }
    }
  }
  lastRung = null;
  if (boundBy === null && countTriangles(doc) <= target) boundBy = 'budget';

  if (addedNormals) steps.push('smooth-normals');

  // Simplification collapses vertices onto one another, so what comes out of
  // the ladder is a mesh full of bitwise-identical duplicates with zero-area
  // triangles between them. weld() ran before the ladder, nothing ran after
  // it, and both states are rules on our own report card (topo/unwelded,
  // topo/degenerate) — the optimizer was shipping an asset that failed the
  // linter that produced it, and paying for the duplicates in file size.
  degenerateDropped += dropDegenerateTriangles(doc);
  if (degenerateDropped) {
    steps.push(`drop-degenerate x${degenerateDropped.toLocaleString()}`);
    log(`dropped ${degenerateDropped.toLocaleString()} zero-area triangles`);
  }
  const verticesBeforeWeld = countVertices(doc);
  await doc.transform(weld());
  const weldedAway = verticesBeforeWeld - countVertices(doc);
  if (weldedAway > 0) {
    steps.push(`re-weld -${weldedAway.toLocaleString()} verts`);
    log(`re-welded: ${weldedAway.toLocaleString()} duplicate vertices merged`);
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
    const sizeOf = () => doc.getRoot().listTextures()
      .reduce((n, t) => n + (t.getImage()?.byteLength ?? 0), 0);
    const before = new Map(doc.getRoot().listTextures().map((t) => [t, { image: t.getImage(), mime: t.getMimeType() }]));
    const bytesBefore = sizeOf();
    // Normal maps carry geometry, not colour: lossy artifacts there show up
    // as shading noise rather than a subtle colour shift, so they get a high
    // quality rather than the default. They used to get `nearLossless`, which
    // on a detailed 2K normal map encodes LARGER than the source JPEG — the
    // whole texture payload of a chess set grew 18.1MB -> 24.2MB while the
    // command was reporting itself as an optimization.
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
        quality: 95,
        slots: /^normalTexture$/,
      }),
    );
    // A re-encode is only an optimization if it is smaller. Nothing in
    // gltf-transform guarantees that, so check rather than assume: an
    // already-well-compressed source survives untouched.
    let reverted = 0;
    for (const [texture, original] of before) {
      const now = texture.getImage();
      if (!original.image || !now || now.byteLength <= original.image.byteLength) continue;
      texture.setImage(original.image);
      if (original.mime) texture.setMimeType(original.mime);
      reverted++;
    }
    const bytesAfter = sizeOf();
    steps.push(`textures -> webp @ ${cap}px (${mbLabel(bytesBefore)} -> ${mbLabel(bytesAfter)}${reverted ? `, ${reverted} kept as-is` : ''})`);
    if (reverted) log(`kept ${reverted} texture(s) in their original encoding — the re-encode was larger`);
  }

  await doc.transform(prune());

  if (opts.compress !== false) {
    await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
    steps.push('meshopt');
    // meshopt quantizes positions/UVs/normals to int16/uint16, and
    // quantization merges values that were distinct in float space: about
    // half the vertices of a simplified asset become bitwise identical only
    // at this point. Every earlier weld ran before quantization and could not
    // see them. The compression extension is already registered and encodes
    // at write time, so this still ships compressed — with half as many
    // vertices to compress.
    const beforeQuantWeld = countVertices(doc);
    await doc.transform(weld());
    const merged = beforeQuantWeld - countVertices(doc);
    if (merged > 0) {
      steps.push(`post-quantize weld -${merged.toLocaleString()} verts`);
      log(`post-quantize weld: ${merged.toLocaleString()} vertices merged that only quantization made identical`);
    }
    // Same cause, other symptom: corners that quantize onto each other leave
    // zero-area triangles behind.
    const quantDegenerate = dropDegenerateTriangles(doc);
    if (quantDegenerate > 0) {
      degenerateDropped += quantDegenerate;
      steps.push(`post-quantize drop-degenerate x${quantDegenerate.toLocaleString()}`);
      log(`post-quantize: dropped ${quantDegenerate.toLocaleString()} zero-area triangles`);
    }
  }

  let perceptual: PerceptualVerdict | null = null;
  if (snapshot) {
    const result = await perceptualCompare(snapshot, doc, opts.keepViews);
    const threshold = opts.profile.minSsim;
    perceptual = { ...result, threshold, passed: result.ssimMin >= threshold };
    steps.push(`verify ssim=${result.ssimMin}${perceptual.passed ? '' : ' FAIL'}`);
    log(`visual fidelity: SSIM ${(result.ssimMean * 100).toFixed(1)}% mean, ${(result.ssimMin * 100).toFixed(1)}% min @ ${result.worstView} (floor ${(threshold * 100).toFixed(0)}%)`);
  }

  // Attribute a failed floor to the stage that crossed it. The geometry
  // check ran on the same asset with its ORIGINAL textures, so if that
  // cleared the floor and the finished asset does not, the texture re-encode
  // is what spent the difference — and simplifying less would not help.
  const fidelityLostAt: OptimizeSummary['fidelityLostAt'] =
    perceptual && !perceptual.passed
      ? (geometrySsimMin !== null && geometrySsimMin >= opts.profile.minSsim ? 'textures' : 'geometry')
      : null;
  return { steps, trianglesBefore, trianglesAfter: countTriangles(doc), fidelityBound, perceptual, boundBy, fidelityLostAt, geometrySsimMin };
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

/**
 * Prepare a document for a geometry-only LOD: strip materials, then weld by
 * POSITION ONLY so seam vertices (same point, different UV/normal) merge.
 * meshopt locks any position with 3+ attribute variants — every rim of a
 * layered forge mesh — which is why LOD targets stall far above the
 * request. At LOD distances the UV discontinuity this creates is
 * invisible; normals are dropped so optimize() regenerates them smooth on
 * the simplified surface. Deterministic (first vertex per position wins).
 */
export function prepareLod(doc: Document): { mergedVertices: number } {
  stripMaterials(doc);
  let merged = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) continue;
      const position = prim.getAttribute('POSITION');
      if (!position) continue;
      for (const sem of ['NORMAL', 'TANGENT']) {
        const acc = prim.getAttribute(sem);
        if (acc) { prim.setAttribute(sem, null); if (acc.listParents().length === 1) acc.dispose(); }
      }
      const pos = readFloat(position);
      const count = position.getCount();
      const canonical = canonicalByPosition(pos, count);
      const remap = new Uint32Array(count);
      let next = 0;
      for (let i = 0; i < count; i++) {
        if (canonical[i] === i) remap[i] = next++;
      }
      for (let i = 0; i < count; i++) remap[i] = remap[canonical[i]];
      if (next === count) continue;
      merged += count - next;
      compactPrimitive(prim, remap, next);
    }
  }
  return { mergedVertices: merged };
}
