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
  it("layers: 'auto' layers flat-coloured artwork and leaves a gradient as one shell", async () => {
    const { extrudeImage } = await import('../src/index.js');
    const sharp = (await import('sharp')).default;
    const size = 128;
    // Same silhouette twice: flat colour bands vs a smooth radial ramp. k-means
    // returns k clusters for either one, so only a measurement can tell them apart.
    const disc = (color: (r: number) => [number, number, number]) => {
      const rgba = Buffer.alloc(size * size * 4);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const r = Math.hypot(x - size / 2 + 0.5, y - size / 2 + 0.5);
        if (r > size / 2 - 4) continue;
        const i = (y * size + x) * 4;
        [rgba[i], rgba[i + 1], rgba[i + 2]] = color(r / (size / 2));
        rgba[i + 3] = 255;
      }
      return sharp(rgba, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
    };
    const flat = await disc((r) => (r < 0.4 ? [200, 40, 40] : [30, 70, 140]));
    const gradient = await disc((r) => [Math.round(40 + r * 200), Math.round(30 + r * 120), 60]);

    const layered = await extrudeImage(new Uint8Array(flat), { layers: 'auto', texture: false });
    expect(layered.stats.flatness).toMatchObject({ layers: 2, distinct: 2 });
    expect(layered.stats.flatness!.coverage).toBeGreaterThan(0.9);
    expect(layered.stats.layerInfo).toHaveLength(2);

    const single = await extrudeImage(new Uint8Array(gradient), { layers: 'auto', texture: false });
    expect(single.stats.flatness!.layers).toBe(0);
    expect(single.stats.flatness!.coverage).toBeLessThan(0.85);
    expect(single.stats.layerInfo).toBeUndefined();

    // An explicit count stays the caller's call, measurement or not.
    const forced = await extrudeImage(new Uint8Array(gradient), { layers: 3, texture: false });
    expect(forced.stats.layerInfo).toHaveLength(3);

    // Relief detail is uniform subdivision, so it needs a ceiling: `ship` forges
    // inside the budget instead of simplifying back down to it afterwards.
    const lavish = await extrudeImage(new Uint8Array(flat), { layers: 'auto', pillow: 0.02, texture: false });
    const budgeted = await extrudeImage(new Uint8Array(flat), { layers: 'auto', pillow: 0.02, texture: false, maxReliefTriangles: 24_000 });
    expect(budgeted.stats.triangles).toBeLessThan(lavish.stats.triangles / 2);
    expect(budgeted.stats.triangles).toBeLessThan(24_000);
    for (const r of [lavish, budgeted]) {
      const topo = analyze(r.doc, { profile: getProfile('mobile-hero') }).geometry.topology!;
      expect(topo.boundaryEdges).toBe(0);
      expect(topo.nonManifoldEdges).toBe(0);
    }
  });

  it('winds every face to agree with its authored normals on plain, bevelled, pillow, emboss and layered output', async () => {
    const { extrudeImage, fromGltf, inspectGeometry, readFloat } = await import('../src/index.js');
    const { NodeIO } = await import('@gltf-transform/core');
    const sharp = (await import('sharp')).default;
    const size = 96;
    const paint = (fill: (x: number, y: number) => [number, number, number, number] | null) => {
      const rgba = Buffer.alloc(size * size * 4);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const px = fill(x, y);
        if (px) rgba.set(px, (y * size + x) * 4);
      }
      return sharp(rgba, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer()
        .then((b) => new Uint8Array(b));
    };
    const ring = await paint((x, y) => {
      const r = Math.hypot(x - 48, y - 48);
      return r < 36 && r > 14 ? [255, 255, 255, 255] : null;
    });
    const twoTone = await paint((x, y) => {
      const r = Math.hypot(x - 48, y - 48);
      return r < 40 ? (r < 20 ? [255, 40, 40, 255] : [30, 90, 220, 255]) : null;
    });

    // Signed volume of a closed mesh: positive iff the winding faces outward.
    const signedVolume = (doc: Document): number => {
      let vol = 0;
      for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
        const p = readFloat(prim.getAttribute('POSITION')!);
        const idx = prim.getIndices()!.getArray()!;
        for (let t = 0; t < idx.length; t += 3) {
          const [a, b, c] = [idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3];
          vol += (
            p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
            p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
            p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])
          ) / 6;
        }
      }
      return vol;
    };

    const variants: Array<[string, Uint8Array, Parameters<typeof extrudeImage>[1]]> = [
      ['plain', ring, { texture: false }],
      ['bevel', ring, { texture: false, bevel: 0.01, bevelSegments: 3 }],
      ['chamfer', ring, { texture: false, bevel: 0.01, bevelSegments: 1 }],
      ['pillow', ring, { texture: false, pillow: 0.04 }],
      ['pillow-flat-back', ring, { texture: false, pillow: 0.04, doubleSided: false }],
      ['emboss', ring, { texture: false, emboss: 0.012, depth: 0.05 }],
      ['layers', twoTone, { texture: false, layers: 2 }],
      ['layers-bevel', twoTone, { texture: false, layers: 3, bevel: 0.01 }],
    ];
    const io = new NodeIO();
    for (const [name, png, opts] of variants) {
      const { doc } = await extrudeImage(png, opts);
      // The inspect rule (inspect/geometry.ts invertedNormals): a face is
      // inverted when its geometric normal points against the summed
      // authored vertex normals. Forge output must trip it on zero faces —
      // materials are single-sided, so an inverted wall is culled.
      const geo = inspectGeometry(fromGltf(doc));
      for (const m of geo.meshes) expect(m.inverted_normal_face_count, `${name}: ${m.name}`).toBe(0);
      expect(geo.diagnostics.map((d) => d.code), name).not.toContain('NORMALS_INVERTED');
      // Still watertight.
      const result = analyze(doc, { profile: getProfile('mobile-hero') });
      expect(result.geometry.topology!.boundaryEdges, name).toBe(0);
      expect(result.geometry.topology!.nonManifoldEdges, name).toBe(0);
      // Outward: the closed shell encloses positive volume.
      expect(signedVolume(doc), name).toBeGreaterThan(0);
      // Deterministic: a second build is byte-identical.
      const again = await extrudeImage(png, opts);
      expect(Buffer.from(await io.writeBinary(again.doc)).equals(Buffer.from(await io.writeBinary(doc))), name).toBe(true);
    }
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

    // Layer offsets are baked into the vertices: every node is identity and
    // the backs are coplanar in mesh space, so xform/unapplied cannot fire.
    const zRange = (n: (typeof nodes)[number]) => {
      const p = n.getMesh()!.listPrimitives()[0].getAttribute('POSITION')!.getArray() as Float32Array;
      let lo = Infinity, hi = -Infinity;
      for (let i = 2; i < p.length; i += 3) { lo = Math.min(lo, p[i]); hi = Math.max(hi, p[i]); }
      return [lo, hi];
    };
    const nodes = doc.getRoot().listNodes();
    for (const n of nodes) {
      expect(n.getTranslation()).toEqual([0, 0, 0]);
      expect(n.getRotation()).toEqual([0, 0, 0, 1]);
      expect(n.getScale()).toEqual([1, 1, 1]);
    }
    const [back0, front0] = zRange(nodes[0]);
    const [back1, front1] = zRange(nodes[1]);
    expect(back1).toBeCloseTo(back0, 6);
    expect(front1 - front0).toBeCloseTo(stats.layerInfo![1].depth - stats.layerInfo![0].depth, 6);

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
    // Solid square with a transparent border (a full-bleed fill now
    // correctly triggers the photograph guard).
    const rgba = Buffer.alloc(32 * 32 * 4);
    for (let y = 4; y < 28; y++) for (let x = 4; x < 28; x++) {
      const i = (y * 32 + x) * 4;
      rgba[i] = 80; rgba[i + 1] = 200; rgba[i + 2] = 255; rgba[i + 3] = 255;
    }
    const png = await sharp(rgba, { raw: { width: 32, height: 32, channels: 4 } }).png().toBuffer();
    const { doc } = await extrudeImage(new Uint8Array(png), { texture: false, preset: 'acrylic' });
    expect(doc.getRoot().listExtensionsUsed().map((e) => e.extensionName))
      .toContain('KHR_materials_transmission');
  });
});

describe('projected artwork survives the texture re-encode', () => {
  /** 128x128 two-tone badge on a transparent background: gold disc with a
   *  dark red centre. Two colours so the texture cannot be folded into a
   *  base-color factor — the re-encode has to actually run. */
  async function badge(): Promise<Uint8Array> {
    const sharp = (await import('sharp')).default;
    const size = 128;
    const rgba = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const r = Math.hypot(x - 64 + 0.5, y - 64 + 0.5);
      if (r >= 56) continue;
      rgba.set(r < 20 ? [122, 18, 32, 255] : [217, 165, 33, 255], (y * size + x) * 4);
    }
    return new Uint8Array(await sharp(rgba, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer());
  }

  it('flattenProjection pads the void with interior colour and leaves nothing transparent', async () => {
    const { flattenProjection } = await import('../src/index.js');
    // 4x1 strip: opaque red, half-alpha green, empty, empty.
    const px = new Uint8Array([
      200, 0, 0, 255,
      0, 200, 0, 128,
      9, 9, 9, 0,
      9, 9, 9, 0,
    ]);
    const out = flattenProjection(px, 4, 1);
    expect(out).toBe(px); // in place
    expect([...px.slice(0, 4)]).toEqual([200, 0, 0, 255]);   // opaque: untouched
    expect([...px.slice(4, 8)]).toEqual([0, 200, 0, 255]);   // antialiased: colour kept, opaque now
    // Voids take the nearest *fully opaque* texel — the half-alpha texel is
    // authored antialiasing, not a colour to spread.
    expect([...px.slice(8, 12)]).toEqual([200, 0, 0, 255]);
    expect([...px.slice(12, 16)]).toEqual([200, 0, 0, 255]);
  });

  it('flattenProjection is a no-op on opaque artwork and deterministic', async () => {
    const { flattenProjection } = await import('../src/index.js');
    const opaque = new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]);
    expect([...flattenProjection(Uint8Array.from(opaque), 2, 1)]).toEqual([...opaque]);

    const src = await badge();
    const sharp = (await import('sharp')).default;
    const decode = async () => {
      const raw = await sharp(Buffer.from(src)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return flattenProjection(new Uint8Array(raw.data), raw.info.width, raw.info.height);
    };
    expect([...(await decode())]).toEqual([...(await decode())]);
  });

  it('forged textures carry no transparent texels, so the rim keeps its colour through optimize', async () => {
    const { extrudeImage } = await import('../src/index.js');
    const png = await badge();
    const { doc } = await extrudeImage(png, { width: 0.07, depth: 0.011, bevel: 0.005 });

    // The embedded projection is an opaque plate: alpha is gone entirely,
    // so the WebP pass has no transparent region whose RGB it may discard.
    const sharp = (await import('sharp')).default;
    const texture = doc.getRoot().listTextures()[0];
    const meta = await sharp(Buffer.from(texture.getImage()!)).metadata();
    expect(meta.channels).toBe(3);
    expect(meta.hasAlpha).toBe(false);

    // The texels the walls and bevel sample sit on the silhouette; the
    // void beyond it must read as artwork, not as the (0,0,0) it decoded as.
    const raw = await sharp(Buffer.from(texture.getImage()!)).raw().toBuffer({ resolveWithObject: true });
    const { width, height } = raw.info;
    const corner = (raw.data[0] + raw.data[1] + raw.data[2]) / 3;
    expect(corner).toBeGreaterThan(32);
    const edge = ((y: number, x: number) => raw.data[(y * width + x) * 3]);
    expect(edge(Math.floor(height / 2), 1)).toBeGreaterThan(32);

    // And the whole point: the re-encode is no longer visible loss. At the
    // profile floor of 94%, an unpadded transparent-background projection
    // measured 92.3% here (86.6% with a pillow) — the rim sampled a 1-2 px
    // ring that WebP had rung across.
    const profile = getProfile('mobile-hero');
    const summary = await optimize(doc, { profile });
    expect(summary.perceptual).not.toBeNull();
    expect(summary.perceptual!.ssimMin).toBeGreaterThanOrEqual(profile.minSsim);
  }, 60_000);
});

describe('alignment harness', () => {
  it('scores identity as near-perfect and decimation as high-fidelity', async () => {
    const { alignmentScore, extrudeImage, optimize: opt } = await import('../src/index.js');
    const sharp = (await import('sharp')).default;
    const size = 96;
    const rgba = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const r = Math.hypot(x - 48, y - 48);
      if (r < 36 && r > 14) { const i = (y * size + x) * 4; rgba[i] = rgba[i+1] = rgba[i+2] = rgba[i+3] = 255; }
    }
    const png = await sharp(rgba, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
    const { doc: reference } = await extrudeImage(new Uint8Array(png), { texture: false, pillow: 0.04 });
    const { doc: identical } = await extrudeImage(new Uint8Array(png), { texture: false, pillow: 0.04 });

    // Identity: deterministic forge = identical mesh = near-perfect scores.
    const same = alignmentScore(identical, reference, { samples: 6000 });
    expect(same.proportion).toBeGreaterThan(0.9);
    expect(same.fscore1).toBeGreaterThan(0.99);
    expect(same.chamfer).toBeLessThan(0.001);

    // Aggressive decimation: coarser but still high-fidelity to the source.
    const { doc: decimated } = await extrudeImage(new Uint8Array(png), { texture: false, pillow: 0.04 });
    await opt(decimated, { profile: (await import('../src/index.js')).getProfile('mobile-hero'), targetTriangles: 800, textures: false, compress: false });
    const dec = alignmentScore(decimated, reference, { samples: 6000 });
    expect(dec.fscore2).toBeGreaterThan(0.75); // 98% decimation of a curved surface: measured ~0.80
    expect(dec.proportion).toBeGreaterThan(0.6);
    expect(dec.chamfer).toBeGreaterThan(same.chamfer); // decimation must cost something
  }, 60_000);
});
