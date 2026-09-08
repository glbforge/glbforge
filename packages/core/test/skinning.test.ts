import { describe, it, expect } from 'vitest';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { analyze, dominantJoints, getProfile, optimize } from '../src/index.js';
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
