import { Document } from '@gltf-transform/core';

/** A two-joint skinned cylinder with a rotation clip and one morph target. */
export function makeRiggedCylinder(rings = 24, segments = 32): Document {
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
  const wSampler = doc.createAnimationSampler()
    .setInput(acc('SCALAR', new Float32Array([0, 0.5, 1])))
    .setOutput(acc('SCALAR', new Float32Array([0, 1, 0])))
    .setInterpolation('LINEAR');
  const wChannel = doc.createAnimationChannel().setTargetNode(meshNode).setTargetPath('weights').setSampler(wSampler);
  doc.createAnimation('bend').addSampler(sampler).addChannel(channel).addSampler(wSampler).addChannel(wChannel);

  doc.createScene().addChild(root).addChild(meshNode);
  return doc;
}

