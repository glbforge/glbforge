import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { analyze, getProfile, optimize } from '../src/index.js';

/** Two triangles sharing an edge, but with the shared verts duplicated
 *  (unwelded), no normals, no UVs, no material. A miniature of typical
 *  AI-generator output. */
function makeDirtyQuad(): Document {
  const doc = new Document();
  const buffer = doc.createBuffer();
  // 6 verts for 2 tris; verts 1/4 and 2/5 are position-duplicates.
  const positions = new Float32Array([
    0, 0, 0,  1, 0, 0,  0, 1, 0,   // tri A
    1, 0, 0,  0, 1, 0,  1, 1, 0,   // tri B (unwelded shared edge)
  ]);
  const indices = new Uint16Array([0, 1, 2, 3, 4, 5]);
  const position = doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer);
  const idx = doc.createAccessor().setType('SCALAR').setArray(indices).setBuffer(buffer);
  const prim = doc.createPrimitive().setAttribute('POSITION', position).setIndices(idx);
  const mesh = doc.createMesh('quad').addPrimitive(prim);
  const node = doc.createNode('quad').setMesh(mesh);
  doc.createScene().addChild(node);
  return doc;
}

describe('analyze', () => {
  const profile = getProfile('mobile-hero');

  it('reports counts, missing attributes, and unwelded topology', () => {
    const result = analyze(makeDirtyQuad(), { profile });

    expect(result.geometry.triangles).toBe(2);
    expect(result.geometry.vertices).toBe(6);
    expect(result.geometry.primsMissingNormals).toBe(1);
    expect(result.geometry.primsMissingUVs).toBe(1);

    const topo = result.geometry.topology!;
    expect(topo.duplicateVertexPositions).toBe(2);
    expect(topo.redundantVertices).toBe(2);
    expect(topo.uniquePositions).toBe(4);
    // Welded, the quad has 5 edges: 4 boundary + 1 interior shared edge.
    expect(topo.boundaryEdges).toBe(4);
    expect(topo.nonManifoldEdges).toBe(0);
    expect(topo.degenerateTriangles).toBe(0);

    const ids = result.findings.map((f) => f.ruleId);
    expect(ids).toContain('geo/missing-normals');
    expect(ids).toContain('geo/missing-uvs');
    expect(ids).toContain('mat/no-material');
    expect(ids).toContain('topo/unwelded');
  });

  it('passes a small clean asset', () => {
    const doc = makeDirtyQuad();
    const result = analyze(doc, { profile });
    // Two triangles are far under every numeric budget.
    const errors = result.findings.filter((f) => f.severity === 'error');
    expect(errors).toHaveLength(0);
    expect(result.passed).toBe(true);
  });
});

// Real fixtures live in git LFS; a non-LFS checkout (e.g. CI) sees tiny
// pointer files, so require a plausible size before running fixture specs.
const hasFixture = (path: string) =>
  existsSync(path) && statSync(path).size > 100_000;

const FIXTURE = new URL('../../../fixtures/veiled-guardian.glb', import.meta.url).pathname;

describe.skipIf(!hasFixture(FIXTURE))('meshy fixture', () => {
  it('flags the real Meshy 7 high-detail export', async () => {
    const bytes = readFileSync(FIXTURE);
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
    const doc = await io.readBinary(new Uint8Array(bytes));
    const result = analyze(doc, {
      profile: getProfile('mobile-hero'),
      fileBytes: bytes.byteLength,
      filePath: FIXTURE,
    });

    expect(result.geometry.triangles).toBe(1_993_468);
    expect(result.passed).toBe(false);
    const ids = result.findings.map((f) => f.ruleId);
    expect(ids).toContain('perf/triangle-budget');
    expect(ids).toContain('perf/file-size');
    expect(ids).toContain('geo/missing-normals');
    // Meshy 7 geometry output is welded + manifold — assert we do NOT cry wolf.
    expect(ids).not.toContain('topo/unwelded');
    expect(ids).not.toContain('topo/non-manifold');
  }, 30_000);
});

const TEX_FIXTURE = new URL('../../../fixtures/veiled-guardian-tex4k.glb', import.meta.url).pathname;

describe.skipIf(!hasFixture(TEX_FIXTURE))('meshy textured fixture', () => {
  it('flags 4K textures but not UV-seam splits', async () => {
    const bytes = readFileSync(TEX_FIXTURE);
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
    const doc = await io.readBinary(new Uint8Array(bytes));
    const result = analyze(doc, {
      profile: getProfile('mobile-hero'),
      fileBytes: bytes.byteLength,
    });

    const ids = result.findings.map((f) => f.ruleId);
    expect(ids).toContain('tex/oversized');
    expect(ids).toContain('tex/total-weight');
    // 77k position-duplicates here are UV-seam splits, NOT waste:
    expect(result.geometry.topology!.redundantVertices).toBe(0);
    expect(ids).not.toContain('topo/unwelded');
  }, 60_000);
});

describe('optimize', () => {
  it('welds and fills normals on a dirty quad', async () => {
    const doc = makeDirtyQuad();
    const summary = await optimize(doc, {
      profile: getProfile('mobile-hero'),
      compress: false,
      textures: false,
    });
    expect(summary.trianglesAfter).toBe(2);
    expect(summary.steps).toContain('weld');
    expect(summary.steps).toContain('smooth-normals');

    const after = analyze(doc, { profile: getProfile('mobile-hero') });
    expect(after.geometry.topology!.redundantVertices).toBe(0);
    expect(after.geometry.primsMissingNormals).toBe(0);
  });
});

describe('extrudeImage', () => {
  it('extrudes a ring into a watertight donut with a hole', async () => {
    const { extrudeImage } = await import('../src/index.js');
    // Synthetic 64x64 PNG: white ring on transparent background.
    const sharp = (await import('sharp')).default;
    const size = 64;
    const rgba = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const r = Math.hypot(x - size / 2 + 0.5, y - size / 2 + 0.5);
        if (r < 24 && r > 10) {
          const i = (y * size + x) * 4;
          rgba[i] = rgba[i + 1] = rgba[i + 2] = rgba[i + 3] = 255;
        }
      }
    }
    const png = await sharp(rgba, { raw: { width: size, height: size, channels: 4 } })
      .png().toBuffer();

    const { doc, stats } = await extrudeImage(new Uint8Array(png), { texture: false });
    expect(stats.mode).toBe('alpha');
    expect(stats.outerLoops).toBe(1);
    expect(stats.holes).toBe(1);
    expect(stats.triangles).toBeGreaterThan(50);

    // A correct extrusion is watertight: welded-space topology must show
    // zero boundary edges and zero non-manifold edges.
    const result = analyze(doc, { profile: getProfile('mobile-hero') });
    expect(result.geometry.topology!.boundaryEdges).toBe(0);
    expect(result.geometry.topology!.nonManifoldEdges).toBe(0);
    expect(result.geometry.primsMissingNormals).toBe(0);
    expect(result.geometry.primsMissingUVs).toBe(0);

    // Emboss relief must keep the seal too (edge-faded height field).
    const embossed = await extrudeImage(new Uint8Array(png), {
      texture: false, emboss: 0.012, depth: 0.05,
    });
    const embossResult = analyze(embossed.doc, { profile: getProfile('mobile-hero') });
    expect(embossResult.geometry.topology!.boundaryEdges).toBe(0);
    expect(embossResult.geometry.topology!.nonManifoldEdges).toBe(0);

    // Beveled variant must also be watertight and strictly heavier.
    const beveled = await extrudeImage(new Uint8Array(png), {
      texture: false, bevel: 0.01, bevelSegments: 3,
    });
    expect(beveled.stats.triangles).toBeGreaterThan(stats.triangles);
    const bevelResult = analyze(beveled.doc, { profile: getProfile('mobile-hero') });
    expect(bevelResult.geometry.topology!.boundaryEdges).toBe(0);
    expect(bevelResult.geometry.topology!.nonManifoldEdges).toBe(0);
  });
});

describe('multi-material optimize', () => {
  it('joins primitives sharing a material into one draw call', async () => {
    const doc = makeDirtyQuad();
    const mesh = doc.getRoot().listMeshes()[0];
    const buffer = doc.getRoot().listBuffers()[0];
    const material = doc.createMaterial('shared');
    // Second primitive, different geometry, same material as the first.
    const positions = new Float32Array([2, 0, 0, 3, 0, 0, 2, 1, 0]);
    const indices = new Uint16Array([0, 1, 2]);
    const prim2 = doc
      .createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(indices).setBuffer(buffer))
      .setMaterial(material);
    mesh.listPrimitives()[0].setMaterial(material);
    mesh.addPrimitive(prim2);

    const before = analyze(doc, { profile: getProfile('mobile-hero'), topology: false });
    expect(before.geometry.drawCallEstimate).toBe(2);

    await optimize(doc, { profile: getProfile('mobile-hero'), compress: false, textures: false });
    const after = analyze(doc, { profile: getProfile('mobile-hero'), topology: false });
    expect(after.geometry.drawCallEstimate).toBe(1);
    expect(after.geometry.triangles).toBe(3);
  });
});

describe('alpha sniffing', () => {
  it('detects missing alpha channels and flags pointless BLEND', async () => {
    const sharp = (await import('sharp')).default;
    const { imageHasAlpha } = await import('../src/analyze/materials.js');

    const rgb = Buffer.alloc(16 * 16 * 3, 128);
    const opaquePng = await sharp(rgb, { raw: { width: 16, height: 16, channels: 3 } }).png().toBuffer();
    const rgba = Buffer.alloc(16 * 16 * 4, 128);
    const alphaPng = await sharp(rgba, { raw: { width: 16, height: 16, channels: 4 } }).png().toBuffer();
    const opaqueWebp = await sharp(rgb, { raw: { width: 16, height: 16, channels: 3 } }).webp().toBuffer();
    const alphaWebp = await sharp(rgba, { raw: { width: 16, height: 16, channels: 4 } }).webp().toBuffer();
    const jpeg = await sharp(rgb, { raw: { width: 16, height: 16, channels: 3 } }).jpeg().toBuffer();

    expect(imageHasAlpha(new Uint8Array(opaquePng), 'image/png')).toBe(false);
    expect(imageHasAlpha(new Uint8Array(alphaPng), 'image/png')).toBe(true);
    expect(imageHasAlpha(new Uint8Array(opaqueWebp), 'image/webp')).toBe(false);
    expect(imageHasAlpha(new Uint8Array(alphaWebp), 'image/webp')).toBe(true);
    expect(imageHasAlpha(new Uint8Array(jpeg), 'image/jpeg')).toBe(false);

    // Material set to BLEND with a provably alpha-free baseColor -> warn.
    const doc = makeDirtyQuad();
    const texture = doc.createTexture('base').setImage(new Uint8Array(opaquePng)).setMimeType('image/png');
    const material = doc.createMaterial('glass?').setAlphaMode('BLEND').setBaseColorTexture(texture);
    doc.getRoot().listMeshes()[0].listPrimitives()[0].setMaterial(material);

    const result = analyze(doc, { profile: getProfile('mobile-hero'), topology: false });
    const ids = result.findings.map((f) => f.ruleId);
    expect(ids).toContain('mat/blend-without-alpha');
    expect(ids).not.toContain('mat/blend-alpha');
  });
});

describe('ktx2', () => {
  it('encodes textures as KTX2 and requires KHR_texture_basisu', async () => {
    const { detectKtx2Encoder, optimize: opt } = await import('../src/index.js');
    const encoder = await detectKtx2Encoder();
    if (!encoder) return; // encoder CLI not installed — skip silently

    const sharp = (await import('sharp')).default;
    // Non-uniform pixels: prune()'s pruneSolidTextures would (correctly)
    // replace a solid-color texture with a material factor.
    const rgba = Buffer.alloc(64 * 64 * 4);
    for (let i = 0; i < 64 * 64; i++) {
      rgba[i * 4] = i % 256; rgba[i * 4 + 1] = (i * 7) % 256;
      rgba[i * 4 + 2] = 90; rgba[i * 4 + 3] = 255;
    }
    const png = await sharp(rgba, { raw: { width: 64, height: 64, channels: 4 } }).png().toBuffer();

    const doc = makeDirtyQuad();
    const texture = doc.createTexture('base').setImage(new Uint8Array(png)).setMimeType('image/png');
    const material = doc.createMaterial('m').setBaseColorTexture(texture);
    doc.getRoot().listMeshes()[0].listPrimitives()[0].setMaterial(material);

    await opt(doc, {
      profile: getProfile('mobile-hero'),
      textureFormat: 'ktx2',
      compress: false,
    });

    const tex = doc.getRoot().listTextures()[0];
    expect(tex.getMimeType()).toBe('image/ktx2');
    expect(
      doc.getRoot().listExtensionsRequired().map((e) => e.extensionName),
    ).toContain('KHR_texture_basisu');

    // Analyzer reads KTX2 dimensions and uses the compressed VRAM estimate.
    const result = analyze(doc, { profile: getProfile('mobile-hero'), topology: false });
    expect(result.textures[0].width).toBe(64);
    expect(result.textures[0].vramBytes).toBeLessThan(64 * 64 * 4);
  }, 60_000);
});

describe('toStl', () => {
  it('exports a binary STL with correct structure and mm scaling', async () => {
    const { extrudeImage, toStl } = await import('../src/index.js');
    const sharp = (await import('sharp')).default;
    const size = 64;
    const rgba = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const r = Math.hypot(x - 32, y - 32);
      if (r < 24) { const i = (y * size + x) * 4; rgba[i] = rgba[i+1] = rgba[i+2] = rgba[i+3] = 255; }
    }
    const png = await sharp(rgba, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
    const { doc } = await extrudeImage(new Uint8Array(png), { texture: false });

    const { stl, triangles, sizeMm } = toStl(doc, { targetSizeMm: 50 });
    // Binary STL: 80B header + u32 count + 50B per triangle.
    expect(stl.byteLength).toBe(84 + triangles * 50);
    const count = new DataView(stl.buffer).getUint32(80, true);
    expect(count).toBe(triangles);
    expect(Math.max(...sizeMm)).toBeCloseTo(50, 1);
  });
});

describe('layered extrusion', () => {
  it('splits a two-color graphic into stepped watertight layers', async () => {
    const { extrudeImage } = await import('../src/index.js');
    const sharp = (await import('sharp')).default;
    const size = 96;
    const rgba = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // Red square backdrop with a blue circle detail.
      if (x > 8 && x < 88 && y > 8 && y < 88) {
        rgba[i] = 220; rgba[i + 1] = 40; rgba[i + 2] = 40; rgba[i + 3] = 255;
        if (Math.hypot(x - 48, y - 48) < 20) { rgba[i] = 40; rgba[i + 1] = 60; rgba[i + 2] = 220; }
      }
    }
    const png = await sharp(rgba, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();

    const { doc, stats } = await extrudeImage(new Uint8Array(png), { layers: 2, texture: false });
    expect(stats.layerInfo).toHaveLength(2);
    // Backdrop (red, larger area) first and shallower; detail deeper.
    expect(stats.layerInfo![0].depth).toBeLessThan(stats.layerInfo![1].depth);
    expect(doc.getRoot().listMaterials()).toHaveLength(2);
    expect(doc.getRoot().listMeshes()).toHaveLength(2);

    const result = analyze(doc, { profile: getProfile('mobile-hero') });
    expect(result.geometry.drawCallEstimate).toBe(2);
    expect(result.geometry.topology!.boundaryEdges).toBe(0);
    expect(result.geometry.topology!.nonManifoldEdges).toBe(0);
  });
});

describe('pillow relief + presets', () => {
  it('domes the front cap, stays sealed, applies enamel preset', async () => {
    const { extrudeImage } = await import('../src/index.js');
    const sharp = (await import('sharp')).default;
    const size = 96;
    const rgba = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (Math.hypot(x - 48, y - 48) < 36) {
        const i = (y * size + x) * 4;
        rgba[i] = 255; rgba[i + 1] = 120; rgba[i + 2] = 60; rgba[i + 3] = 255;
      }
    }
    const png = await sharp(rgba, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();

    const { doc } = await extrudeImage(new Uint8Array(png), {
      texture: false, pillow: 0.05, depth: 0.05, preset: 'enamel',
    });

    // Front cap must rise above the flat extrusion depth (dome exists)...
    const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
    const pos = prim.getAttribute('POSITION')!.getArray()!;
    let maxZ = -Infinity;
    for (let i = 2; i < pos.length; i += 3) maxZ = Math.max(maxZ, pos[i]);
    expect(maxZ).toBeGreaterThan(0.05); // hz = 0.025; dome adds up to 0.05

    // ...while staying watertight (rim shared with walls, height 0 at edges).
    const result = analyze(doc, { profile: getProfile('mobile-hero') });
    expect(result.geometry.topology!.boundaryEdges).toBe(0);
    expect(result.geometry.topology!.nonManifoldEdges).toBe(0);

    // Enamel is layer-aware: layer 0 (the only layer here) is the metal base.
    const material = doc.getRoot().listMaterials()[0];
    expect(material.getMetallicFactor()).toBeCloseTo(1);
    expect(material.getRoughnessFactor()).toBeCloseTo(0.35);
  }, 30_000);

  it('acrylic preset attaches KHR_materials_transmission', async () => {
    const { extrudeImage } = await import('../src/index.js');
    const sharp = (await import('sharp')).default;
    const rgba = Buffer.alloc(32 * 32 * 4);
    for (let i = 0; i < 32 * 32; i++) {
      rgba[i * 4] = 80; rgba[i * 4 + 1] = 200; rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = 255;
    }
    const png = await sharp(rgba, { raw: { width: 32, height: 32, channels: 4 } }).png().toBuffer();
    const { doc } = await extrudeImage(new Uint8Array(png), { texture: false, preset: 'acrylic' });
    expect(doc.getRoot().listExtensionsUsed().map((e) => e.extensionName))
      .toContain('KHR_materials_transmission');
  });
});
