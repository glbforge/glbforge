import { describe, it, expect } from 'vitest';
import { alignmentScore, analyze, buildLod, extrudeImage, getProfile, optimize } from '../src/index.js';

async function layeredPng(): Promise<Uint8Array> {
  const sharp = (await import('sharp')).default;
  const size = 160;
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const r = Math.hypot(x - 80, y - 80);
    const i = (y * size + x) * 4;
    if (r < 70) { rgba[i] = r < 40 ? 220 : 40; rgba[i + 1] = r < 40 ? 60 : 120; rgba[i + 2] = r < 40 ? 80 : 220; rgba[i + 3] = 255; }
  }
  return new Uint8Array(await sharp(rgba, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer());
}

describe('geometry-only LODs', () => {
  it('reaches the target on stacked-layer (non-manifold) forge meshes by clustering, and stays deterministic', async () => {
    // Two color layers at stepped depths share coplanar faces: meshopt locks
    // the shared rims and stalls; clustering must take over.
    const { doc } = await extrudeImage(await layeredPng(), { layers: 2, pillow: 0.03, simplify: 0.3 });
    const profile = getProfile('mobile-hero');
    await optimize(doc, { profile, textures: false, compress: false, verify: false });
    const before = analyze(doc, { profile, topology: true });
    expect(before.geometry.topology!.nonManifoldEdges).toBeGreaterThan(0);
    const start = before.geometry.triangles;
    const target = Math.floor(start / 8);

    const io = (await import('../src/index.js')).createNodeIO;
    const nodeIo = await io();
    const bytes = await nodeIo.writeBinary(doc);
    const run = async () => {
      const lodDoc = await nodeIo.readBinary(bytes);
      const lod = await buildLod(lodDoc, target, { profile, compress: false });
      const after = analyze(lodDoc, { profile, topology: false });
      return { lod, after, indices: Array.from(lodDoc.getRoot().listMeshes()[0].listPrimitives()[0].getIndices()!.getArray()!) };
    };
    const a = await run();
    expect(a.lod.triangles).toBeLessThanOrEqual(target * 1.1);
    expect(a.lod.triangles).toBeGreaterThan(target * 0.3);
    expect(a.after.geometry.primsMissingNormals).toBe(0);   // smooth normals regenerated
    expect(a.after.materials.length).toBe(0);               // geometry only
    expect(a.lod.steps.join(' ')).toMatch(/weld-positions/);
    const b = await run();
    expect(b.indices).toEqual(a.indices);
    expect(b.lod.method).toBe(a.lod.method);
  }, 60_000);

  it('records how far the cluster-decimate fallback drifts from the source surface, not just its triangle count', async () => {
    // buildLod reports { triangles, method } but no geometric-fidelity
    // number — a rival pass (gltfpack's -si, matched to the same triangle
    // budget on this same non-manifold asset) measured this fallback at
    // 2-4x worse chamfer/f-score than a competing simplifier once the
    // reduction is severe enough to force clustering. Nothing today would
    // catch that getting worse. This pins today's fidelity as a floor using
    // the harness's own alignment scorer (already deterministic and
    // seeded), so a regression in clusterDecimate or smoothPositions shows
    // up here even without a rival installed.
    const { doc } = await extrudeImage(await layeredPng(), { layers: 2, pillow: 0.03, simplify: 0.3 });
    const profile = getProfile('mobile-hero');
    await optimize(doc, { profile, textures: false, compress: false, verify: false });
    const before = analyze(doc, { profile, topology: true });
    expect(before.geometry.topology!.nonManifoldEdges).toBeGreaterThan(0);

    const io = (await import('../src/index.js')).createNodeIO;
    const nodeIo = await io();
    const referenceBytes = await nodeIo.writeBinary(doc);
    const reference = await nodeIo.readBinary(referenceBytes);

    // Severe enough (well past the 1.1x stall threshold) to force the
    // cluster fallback on this asset's stacked, locked rims.
    const target = Math.floor(before.geometry.triangles / 150);
    const lodDoc = await nodeIo.readBinary(referenceBytes);
    const lod = await buildLod(lodDoc, target, { profile, compress: false });
    expect(lod.method).toBe('cluster');

    const score = alignmentScore(lodDoc, reference);
    // Measured today (this asset, this target): chamfer ~0.030, f-score@1%
    // ~0.15, f-score@2% ~0.28. Floors below with headroom for float/host
    // noise, not for a future regression to hide behind.
    expect(score.chamfer).toBeLessThan(0.05);
    expect(score.fscore1).toBeGreaterThan(0.08);
    expect(score.fscore2).toBeGreaterThan(0.18);
  }, 60_000);
});
