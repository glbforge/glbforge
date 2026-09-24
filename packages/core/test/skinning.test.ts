import { describe, it, expect } from 'vitest';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { analyze, dominantJoints, getProfile, optimize, sceneBounds } from '../src/index.js';
import { fromGltf } from '../src/inspect/from-gltf.js';
import { worldBounds } from '../src/inspect/ir.js';
import { makeRiggedCylinder } from './fixtures.js';

describe('skinning + morph targets through optimization', () => {
  it('simplifies bone-aware and keeps the skin, targets, and clip intact', async () => {
    const doc = makeRiggedCylinder();
    const profile = getProfile('mobile-hero');
    const beforeReport = analyze(doc, { profile, topology: false });
    expect(beforeReport.scene.skins).toBe(1);
    expect(beforeReport.findings.some((f) => f.ruleId === 'scene/animated-asset')).toBe(true);

    const prim0 = doc.getRoot().listMeshes()[0].listPrimitives()[0];
    const trisBefore = prim0.getIndices()!.getCount() / 3;
    const summary = await optimize(doc, { profile, targetTriangles: 600, textures: false, compress: false, verify: false });
    expect(summary.steps.join(' ')).toMatch(/bone-aware/);
    expect(summary.trianglesAfter).toBeLessThanOrEqual(660);
    expect(summary.trianglesAfter).toBeLessThan(trisBefore);

    const root = doc.getRoot();
    expect(root.listSkins()).toHaveLength(1);
    expect(root.listSkins()[0].listJoints().map((j) => j.getName())).toEqual(['root', 'upper']);
    expect(root.listSkins()[0].getInverseBindMatrices()!.getCount()).toBe(2);
    expect(root.listAnimations()).toHaveLength(1);
    const channel = root.listAnimations()[0].listChannels()[0];
    expect(channel.getTargetNode()!.getName()).toBe('upper');
    expect(Array.from(channel.getSampler()!.getOutput()!.getArray()!).length).toBe(8);

    const prim = root.listMeshes()[0].listPrimitives()[0];
    const n = prim.getAttribute('POSITION')!.getCount();
    expect(prim.getAttribute('JOINTS_0')!.getCount()).toBe(n);
    expect(prim.getAttribute('WEIGHTS_0')!.getCount()).toBe(n);
    expect(prim.listTargets()).toHaveLength(1);
    expect(prim.listTargets()[0].getAttribute('POSITION')!.getCount()).toBe(n);
    expect(root.listMeshes()[0].getWeights()).toEqual([0]);

    // Weights still normalized, both joints still in use, and the blend
    // band between them survived (that's what the vertex locks protect).
    const w = prim.getAttribute('WEIGHTS_0')!.getArray()!;
    let blended = 0;
    for (let i = 0; i < n; i++) {
      const sum = w[i * 4] + w[i * 4 + 1] + w[i * 4 + 2] + w[i * 4 + 3];
      expect(Math.abs(sum - 1)).toBeLessThan(1e-4);
      if (w[i * 4 + 1] > 0.05 && w[i * 4 + 1] < 0.95) blended++;
    }
    expect(new Set(dominantJoints(prim)!).size).toBe(2);
    expect(blended).toBeGreaterThanOrEqual(16);

    // Survives a GLB round trip with the meshopt/quantization path too.
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
    const again = await io.readBinary(await io.writeBinary(doc));
    expect(again.getRoot().listSkins()).toHaveLength(1);
    expect(again.getRoot().listAnimations()[0].listChannels()[0].getTargetNode()!.getName()).toBe('upper');
    const after = analyze(again, { profile, topology: false });
    expect(after.scene.animations).toBe(1);
  }, 30_000);

  it('is deterministic', async () => {
    const run = async () => {
      const doc = makeRiggedCylinder();
      await optimize(doc, { profile: getProfile('mobile-hero'), targetTriangles: 600, textures: false, compress: false, verify: false });
      return Array.from(doc.getRoot().listMeshes()[0].listPrimitives()[0].getIndices()!.getArray()!);
    };
    expect(await run()).toEqual(await run());
  });
});

describe('skinned quantization', () => {
  // glTF ignores a skinned mesh node's transform, so gltf-transform cannot put
  // the dequantization scale there — it bakes it into the skin's inverse bind
  // matrices instead. Anything that reads POSITION through the node matrix then
  // sees the raw [-1,1] quantization cube rather than the model. `compress` and
  // `verify` together are what expose it, which is why the tests above, which
  // switch both off, never caught it.
  const sizeOf = (doc: Parameters<typeof analyze>[0]) => worldBounds(fromGltf(doc))!.size;

  it('measures bounds, fidelity and the animate pivot on the model, not the [-1,1] cube', async () => {
    const profile = getProfile('mobile-hero');
    const src = sizeOf(makeRiggedCylinder());          // the tube is ~0.6 x 2 x 0.6
    // The fixture has to be thinner than the cube on some axis, or the old bug
    // would be invisible here: its height alone is 2 either way.
    expect(src[0]).toBeLessThan(1);
    expect(src[1]).toBeGreaterThan(1.5);

    const doc = makeRiggedCylinder();
    const summary = await optimize(doc, { profile, textures: false, compress: true, verify: true });

    // The SSIM gate must judge the asset, not a blob. No simplification is
    // needed at this size, so fidelity should be near-perfect.
    expect(summary.perceptual).not.toBeNull();
    expect(summary.perceptual!.passed).toBe(true);
    expect(summary.perceptual!.ssimMin).toBeGreaterThan(summary.perceptual!.threshold);

    // The old failure signature: the thin axes widen onto the 2-unit cube.
    const out = sizeOf(doc);
    expect(out[0]).toBeCloseTo(src[0], 3);
    expect(out[1]).toBeCloseTo(src[1], 3);
    expect(out[2]).toBeCloseTo(src[2], 3);
    expect(out[0]).toBeLessThan(1);

    // animate() positions its pivot from sceneBounds and scales the motion by
    // the measured height, so it reads the same geometry.
    const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
    const b = sceneBounds(scene)!;
    expect(b.max[0] - b.min[0]).toBeCloseTo(src[0], 3);
    expect(b.max[1] - b.min[1]).toBeCloseTo(src[1], 3);
  }, 60_000);
});
