import { describe, it, expect } from 'vitest';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { analyze, dominantJoints, getProfile, optimize } from '../src/index.js';

/** A two-joint skinned cylinder with a rotation clip and one morph target. */
function makeRiggedCylinder(rings = 24, segments = 32): Document {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const vertexCount = rings * segments;
  const positions = new Float32Array(vertexCount * 3);
  const joints = new Uint8Array(vertexCount * 4);
  const weights = new Float32Array(vertexCount * 4);
  const bulge = new Float32Array(vertexCount * 3);
  for (let r = 0; r < rings; r++) {
    const y = (r / (rings - 1)) * 2;
    const w1 = Math.min(1, Math.max(0, (y - 0.5) / 1.0));
    for (let s = 0; s < segments; s++) {
      const i = r * segments + s;
      const a = (s / segments) * Math.PI * 2;
      positions[i * 3] = Math.cos(a) * 0.3; positions[i * 3 + 1] = y; positions[i * 3 + 2] = Math.sin(a) * 0.3;
      joints[i * 4 + 1] = 1;
      weights[i * 4] = 1 - w1; weights[i * 4 + 1] = w1;
      const k = Math.max(0, 1 - Math.abs(y - 1) / 0.25);
      bulge[i * 3] = Math.cos(a) * 0.15 * k; bulge[i * 3 + 2] = Math.sin(a) * 0.15 * k;
    }
  }
  const indices: number[] = [];
  for (let r = 0; r < rings - 1; r++) for (let s = 0; s < segments; s++) {
    const a = r * segments + s, b = r * segments + (s + 1) % segments;
    const c = a + segments, d = b + segments;
    indices.push(a, c, b, b, c, d);
  }
  const acc = (type: 'VEC3' | 'VEC4' | 'SCALAR', arr: Float32Array | Uint8Array | Uint16Array) =>
    doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer);
  const target = doc.createPrimitiveTarget('bulge').setAttribute('POSITION', acc('VEC3', bulge));
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', acc('VEC3', positions))
    .setAttribute('JOINTS_0', acc('VEC4', joints))
    .setAttribute('WEIGHTS_0', acc('VEC4', weights))
    .setIndices(acc('SCALAR', new Uint16Array(indices)))
    .addTarget(target);
  const mesh = doc.createMesh('tube').addPrimitive(prim).setWeights([0]);

  const root = doc.createNode('root');
  const upper = doc.createNode('upper').setTranslation([0, 1, 0]);
  root.addChild(upper);
  const ibm = doc.createAccessor().setType('MAT4').setBuffer(buffer).setArray(new Float32Array([
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1,
  ]));
  const skin = doc.createSkin('rig').setSkeleton(root).addJoint(root).addJoint(upper).setInverseBindMatrices(ibm);
  const meshNode = doc.createNode('tube').setMesh(mesh).setSkin(skin);

  const s = Math.SQRT1_2;
  const sampler = doc.createAnimationSampler()
    .setInput(acc('SCALAR', new Float32Array([0, 1])))
    .setOutput(acc('VEC4', new Float32Array([0, 0, 0, 1, 0, 0, s, s])))
    .setInterpolation('LINEAR');
  const channel = doc.createAnimationChannel().setTargetNode(upper).setTargetPath('rotation').setSampler(sampler);
  doc.createAnimation('bend').addSampler(sampler).addChannel(channel);

  doc.createScene().addChild(root).addChild(meshNode);
  return doc;
}

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
