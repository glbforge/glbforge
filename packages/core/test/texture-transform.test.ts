import { describe, it, expect } from 'vitest';
import { Document } from '@gltf-transform/core';
import { KHRTextureTransform } from '@gltf-transform/extensions';
import { computeFrame, renderRaw, sharpTextureDecoder, verifyRig } from '../src/index.js';

/**
 * `KHR_texture_transform` reassigns what a raw TEXCOORD_0 value samples.
 * Tools that atlas or tile textures rely on it (gltfpack does, unprompted,
 * the moment it repacks an already-quantized GLB) — a renderer that reads
 * TEXCOORD_0 raw and ignores the extension samples a different texel than
 * the asset actually shows, not a subtle shift: an SSIM verdict against a
 * gltfpack rival output measured 0.32 (rendered wrong) before this fixed it,
 * 0.999 (matches) after.
 */
async function quadTexels(): Promise<Uint8Array> {
  const sharp = (await import('sharp')).default;
  // 2x2 texel image: top-left red, everything else a different colour, so
  // "sampled only the top-left texel" and "sampled the whole image" render
  // visibly differently.
  const rgba = Buffer.from([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 255, 255,
  ]);
  return new Uint8Array(await sharp(rgba, { raw: { width: 2, height: 2, channels: 4 } }).png().toBuffer());
}

/** A single camera-facing quad, textured, with the given TEXCOORD_0 corners. */
async function quadDoc(uvs: [number, number, number, number, number, number, number, number]): Promise<Document> {
  const doc = new Document();
  doc.createBuffer();
  const buffer = doc.getRoot().listBuffers()[0];
  const texture = doc.createTexture('checker').setImage(await quadTexels()).setMimeType('image/png');
  const material = doc.createMaterial('m').setBaseColorTexture(texture).setRoughnessFactor(1).setMetallicFactor(0);
  const positions = new Float32Array([-0.4, -0.4, 0, 0.4, -0.4, 0, -0.4, 0.4, 0, 0.4, 0.4, 0]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const indices = new Uint16Array([0, 1, 2, 2, 1, 3]);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer))
    .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(normals).setBuffer(buffer))
    .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(uvs)).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(indices).setBuffer(buffer))
    .setMaterial(material);
  const mesh = doc.createMesh('quad').addPrimitive(prim);
  const node = doc.createNode('quad').setMesh(mesh);
  doc.createScene('scene').addChild(node);
  return doc;
}

async function renderFirstView(doc: Document) {
  const frame = await computeFrame(doc);
  const [view] = await renderRaw(doc, {
    size: 64, cameras: verifyRig().slice(0, 1), frame, textureDecoder: sharpTextureDecoder(),
  });
  return view;
}

describe('KHR_texture_transform', () => {
  it('reassigns which texel a raw UV samples, and the renderer honours it', async () => {
    // Full-range UVs pre-scaled by hand into the top-left texel's quadrant —
    // the "correct" render, computed without relying on the extension at all.
    const preTransformed = await quadDoc([0, 0, 0.5, 0, 0, 0.5, 0.5, 0.5]);

    // Same full-range UVs as an untransformed quad would use, but with a
    // KHR_texture_transform on the base-color TextureInfo doing the scaling.
    const transformed = await quadDoc([0, 0, 1, 0, 0, 1, 1, 1]);
    const ext = transformed.createExtension(KHRTextureTransform);
    const info = transformed.getRoot().listMaterials()[0].getBaseColorTextureInfo()!;
    info.setExtension('KHR_texture_transform', ext.createTransform().setScale([0.5, 0.5]));

    // The untouched full-range quad, for contrast: it must sample more than
    // just the top-left texel, or this test would be vacuous.
    const untransformed = await quadDoc([0, 0, 1, 0, 0, 1, 1, 1]);

    const a = await renderFirstView(preTransformed);
    const b = await renderFirstView(transformed);
    const c = await renderFirstView(untransformed);

    expect(Buffer.from(b.rgba).equals(Buffer.from(a.rgba))).toBe(true);
    expect(Buffer.from(b.rgba).equals(Buffer.from(c.rgba))).toBe(false);
  });
});
