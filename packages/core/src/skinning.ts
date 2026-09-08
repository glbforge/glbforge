/**
 * Bone-aware simplification for deforming primitives (skinned meshes and
 * morph targets). gltf-transform's simplify() is geometry-only: it happily
 * collapses vertices across joint boundaries, which shows up as stretched
 * skin the moment the rig animates. Here meshoptimizer's attribute-aware
 * simplifier sees the skin weights (and per-target morph deltas) as extra
 * vertex attributes, and vertices where the dominant joint changes are
 * locked so the deformation rings survive. All attributes — JOINTS_n,
 * WEIGHTS_n, morph targets — are remapped by the same vertex compaction, so
 * the skin, its inverse bind matrices, and every animation clip stay valid.
 */
import { Document, type Primitive } from '@gltf-transform/core';
import { compactPrimitive } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import { readFloat } from './accessors.js';

export function isDeforming(prim: Primitive): boolean {
  return !!prim.getAttribute('JOINTS_0') || prim.listTargets().length > 0;
}

export interface DeformingSimplifyOptions {
  /** Target ratio of triangles to keep (0..1). */
  ratio: number;
  /** Error limit as a fraction of mesh radius. */
  error: number;
  /** Keep open-mesh borders fixed (default true — seams on skinned meshes are usually deliberate). */
  lockBorder?: boolean;
}

export interface DeformingSimplifyResult {
  trianglesBefore: number;
  trianglesAfter: number;
  lockedVertices: number;
  error: number;
}

/** Index of the joint carrying the largest weight for each vertex (-1 when unskinned). */
export function dominantJoints(prim: Primitive): Int32Array | null {
  const joints = prim.getAttribute('JOINTS_0');
  const weights = prim.getAttribute('WEIGHTS_0');
  if (!joints || !weights) return null;
  const count = joints.getCount();
  const j = joints.getArray()!;
  const w = readFloat(weights);
  const out = new Int32Array(count).fill(-1);
  for (let i = 0; i < count; i++) {
    let best = -1, bestW = -Infinity;
    for (let k = 0; k < 4; k++) {
      if (w[i * 4 + k] > bestW) { bestW = w[i * 4 + k]; best = j[i * 4 + k]; }
    }
    out[i] = bestW > 0 ? best : -1;
  }
  return out;
}

export async function simplifyDeformingPrimitive(
  prim: Primitive,
  opts: DeformingSimplifyOptions,
): Promise<DeformingSimplifyResult> {
  await MeshoptSimplifier.ready;
  // simplifyWithAttributes is behind meshoptimizer's experimental flag.
  (MeshoptSimplifier as unknown as { useExperimentalFeatures: boolean }).useExperimentalFeatures = true;
  const doc = Document.fromGraph(prim.getGraph())!;
  const position = prim.getAttribute('POSITION')!;
  const vertexCount = position.getCount();
  const indicesAcc = prim.getIndices();
  const indices = indicesAcc
    ? new Uint32Array(indicesAcc.getArray()!)
    : Uint32Array.from({ length: vertexCount }, (_, i) => i);
  const positions = readFloat(position);
  const trianglesBefore = Math.floor(indices.length / 3);

  // Attribute vector per vertex: skin weights (up to 8) + per-target morph
  // delta magnitude (normalized), so collapses that would change how a
  // vertex deforms are penalized alongside geometric error.
  const channels: Array<{ values: Float32Array; stride: number; weight: number }> = [];
  for (const sem of ['WEIGHTS_0', 'WEIGHTS_1']) {
    const acc = prim.getAttribute(sem);
    if (acc) channels.push({ values: readFloat(acc), stride: 4, weight: 0.5 });
  }
  const targets = prim.listTargets().slice(0, 8);
  for (const target of targets) {
    const delta = target.getAttribute('POSITION');
    if (!delta) continue;
    const d = readFloat(delta);
    const mag = new Float32Array(vertexCount);
    let max = 0;
    for (let i = 0; i < vertexCount; i++) {
      mag[i] = Math.hypot(d[i * 3], d[i * 3 + 1], d[i * 3 + 2]);
      if (mag[i] > max) max = mag[i];
    }
    if (max > 0) for (let i = 0; i < vertexCount; i++) mag[i] /= max;
    channels.push({ values: mag, stride: 1, weight: 0.5 });
  }
  const stride = channels.reduce((s, c) => s + c.stride, 0);
  const attributes = new Float32Array(vertexCount * Math.max(1, stride));
  const attributeWeights: number[] = [];
  let offset = 0;
  for (const c of channels) {
    for (let i = 0; i < vertexCount; i++) {
      for (let k = 0; k < c.stride; k++) attributes[i * stride + offset + k] = c.values[i * c.stride + k];
    }
    for (let k = 0; k < c.stride; k++) attributeWeights.push(c.weight);
    offset += c.stride;
  }

  // Lock vertices on edges where the dominant joint changes: those rings
  // are exactly where a collapse turns into visible skin stretching.
  const lock = new Uint8Array(vertexCount);
  let lockedVertices = 0;
  const dominant = dominantJoints(prim);
  if (dominant) {
    for (let t = 0; t + 2 < indices.length; t += 3) {
      const a = indices[t], b = indices[t + 1], c = indices[t + 2];
      if (dominant[a] !== dominant[b]) { lock[a] = 1; lock[b] = 1; }
      if (dominant[b] !== dominant[c]) { lock[b] = 1; lock[c] = 1; }
      if (dominant[c] !== dominant[a]) { lock[c] = 1; lock[a] = 1; }
    }
    for (let i = 0; i < vertexCount; i++) lockedVertices += lock[i];
  }

  const targetCount = Math.max(3, Math.floor((opts.ratio * indices.length) / 3) * 3);
  const flags: Array<'LockBorder'> = opts.lockBorder === false ? [] : ['LockBorder'];
  const [dst, error] = stride > 0
    ? MeshoptSimplifier.simplifyWithAttributes(
        indices, positions, 3, attributes, stride, attributeWeights, dominant ? lock : null,
        targetCount, opts.error, flags,
      )
    : MeshoptSimplifier.simplify(indices, positions, 3, targetCount, opts.error, flags);

  // Assign the surviving triangles and compact every attribute — including
  // JOINTS/WEIGHTS and each morph target — with one shared remap.
  const buffer = position.getBuffer() ?? doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
  const dstIndices = doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(dst)).setBuffer(buffer);
  prim.setIndices(dstIndices);
  if (indicesAcc && indicesAcc.listParents().length === 1) indicesAcc.dispose();
  compactPrimitive(prim);
  const compacted = prim.getIndices()!;
  if (prim.getAttribute('POSITION')!.getCount() <= 65534) {
    compacted.setArray(new Uint16Array(compacted.getArray()!));
  }

  return { trianglesBefore, trianglesAfter: Math.floor(compacted.getCount() / 3), lockedVertices, error };
}
