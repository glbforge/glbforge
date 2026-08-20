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
