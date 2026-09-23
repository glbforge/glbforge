import { describe, it, expect } from 'vitest';
import { Document } from '@gltf-transform/core';
import { analyze, getProfile } from '../src/index.js';

/**
 * A grid whose positions repeat in a narrow magnitude range and whose
 * normals repeat exactly across long runs — the shape that broke
 * `analyze/geometry.ts`'s weld hash while profiling a real "neon sign"
 * asset (a tube with a repeating cross-section: many vertices sharing an
 * identical NORMAL, positions all in the same narrow band). A hash that
 * masks its low bits straight into a bucket index — fine on typical
 * continuous float32 data — clustered almost every vertex from a
 * 12k-vertex prim into a few thousand buckets there (>100 probes/lookup
 * average, worse than the string keys it replaced). This grid reproduces
 * the same shape synthetically so the regression doesn't depend on a
 * fixture: every row shares one of four normals, and every coordinate is a
 * small integer multiple, matching what a KHR_mesh_quantization-decoded or
 * hand-authored asset looks like.
 */
function makeStructuredGrid(gridSize: number): Document {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const n = gridSize * gridSize;
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      const i = y * gridSize + x;
      positions[i * 3] = (x - gridSize / 2) * 137;
      positions[i * 3 + 1] = (y - gridSize / 2) * 211;
      positions[i * 3 + 2] = (x % 4) * 53; // a handful of repeated Z bands
      // Every vertex in a row shares one of four exact normals — the
      // repeated-attribute pattern a symmetric revolve/extrude produces.
      const dir = y % 4;
      normals[i * 3] = dir === 0 ? 1 : 0;
      normals[i * 3 + 1] = dir === 1 ? 1 : 0;
      normals[i * 3 + 2] = dir >= 2 ? 1 : 0;
    }
  }
  const indices: number[] = [];
  for (let y = 0; y < gridSize - 1; y++) {
    for (let x = 0; x < gridSize - 1; x++) {
      const a = y * gridSize + x, b = a + 1, c = a + gridSize, d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer))
    .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(normals).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(indices)).setBuffer(buffer));
  const mesh = doc.createMesh('grid').addPrimitive(prim);
  doc.createScene().addChild(doc.createNode('grid').setMesh(mesh));
  return doc;
}

describe('analyze() topology stays correct on structured/repeated attributes', () => {
  it('welds exactly, not approximately, under heavy hash-bucket collisions', () => {
    // Every (x, y) has a unique position by construction (posX depends only
    // on x, posY only on y, both strictly monotonic), so the correct answer
    // is "zero duplicates, zero redundant vertices" despite most vertices
    // sharing one of four exact NORMAL values — exactly the shape that drove
    // a masked-but-unmixed hash to >100 probes/lookup on a real asset (see
    // the doc comment above). A hash bug that reports a false match under
    // collision would fail this by undercounting `uniquePositions`; an
    // infinite/runaway probe loop would fail it by timing out the test
    // runner. This does not assert a latency bound — see the pass file for
    // measured before/after numbers (`docs/agent-loop/passes/`); the
    // codebase's other radix/hash weld path (`inspect/topology.ts`,
    // `test/packs.test.ts`'s "large index space" case) follows the same
    // correctness-only convention for exactly this reason: a tight ms bound
    // here would be measuring CI noise, not the algorithm.
    const gridSize = 220; // 48,400 vertices — well above the 12k that showed the regression
    const doc = makeStructuredGrid(gridSize);
    const profile = getProfile('mobile-hero');
    const topology = analyze(doc, { profile, topology: true }).geometry.topology;
    expect(topology).not.toBeNull();
    expect(topology!.uniquePositions).toBe(gridSize * gridSize);
    expect(topology!.duplicateVertexPositions).toBe(0);
    expect(topology!.redundantVertices).toBe(0);
    expect(topology!.degenerateTriangles).toBe(0);
  });

  it('reports exact, implementation-independent topology counts on a small hand-built case', () => {
    // Two triangles sharing an edge, unwelded (verts 1/4 and 2/5 are
    // position-duplicates), plus a third, degenerate triangle appended.
    const doc = new Document();
    const buffer = doc.createBuffer();
    const positions = new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 1, 0, // tri A
      1, 0, 0, 0, 1, 0, 1, 1, 0, // tri B (shares an edge with A, unwelded)
      2, 2, 2, 2, 2, 2, 2, 2, 2, // tri C: same position repeated 3x (degenerate)
    ]);
    const indices = new Uint16Array([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(indices).setBuffer(buffer));
    const mesh = doc.createMesh('tris').addPrimitive(prim);
    doc.createScene().addChild(doc.createNode('tris').setMesh(mesh));

    const profile = getProfile('mobile-hero');
    const topology = analyze(doc, { profile, topology: true }).geometry.topology;
    expect(topology).not.toBeNull();
    // 9 verts total; tri C's 3 verts are one canonical position (2 fewer
    // unique), tri A/B's shared edge (verts 1/4, 2/5) is 2 more — 5 unique
    // positions, 4 duplicates.
    expect(topology!.uniquePositions).toBe(5);
    expect(topology!.duplicateVertexPositions).toBe(4);
    expect(topology!.degenerateTriangles).toBe(1);
    // Tri A and B share one edge (canonical verts 1-2, now internal, count
    // 2) and have 4 other edges that appear once each — 4 boundary edges.
    // Tri C contributes no edges (degenerate, skipped before edges are
    // pushed).
    expect(topology!.boundaryEdges).toBe(4);
    expect(topology!.nonManifoldEdges).toBe(0);
  });
});
