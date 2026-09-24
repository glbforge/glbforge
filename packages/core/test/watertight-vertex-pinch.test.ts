import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import ManifoldModule from 'manifold-3d';
import { extrudeImage, toStl } from '../src/index.js';
import { canonicalByPosition } from '../src/normals.js';
import { meshTopology } from '../src/inspect/topology.js';

/** Connected components of a welded vertex's "link" (the graph of the other
 *  two corners per incident triangle). A manifold vertex's link is one
 *  cycle or one path; more than one component means two fans meet only at
 *  that single point — the case edge-multiplicity counting cannot see. */
function maxLinkComponents(positions: Float32Array, indices: Uint32Array, vertexCount: number): number {
  const canonical = canonicalByPosition(positions, vertexCount);
  const linkAdj = new Map<number, Map<number, Set<number>>>();
  const link = (v: number, p: number, q: number): void => {
    let m = linkAdj.get(v);
    if (!m) { m = new Map(); linkAdj.set(v, m); }
    if (!m.has(p)) m.set(p, new Set());
    if (!m.has(q)) m.set(q, new Set());
    m.get(p)!.add(q);
    m.get(q)!.add(p);
  };
  for (let t = 0; t < indices.length; t += 3) {
    const a = canonical[indices[t]], b = canonical[indices[t + 1]], c = canonical[indices[t + 2]];
    if (a === b || b === c || a === c) continue;
    link(a, b, c); link(b, c, a); link(c, a, b);
  }
  let worst = 1;
  for (const [, neighbors] of linkAdj) {
    const seen = new Set<number>();
    let components = 0;
    for (const start of neighbors.keys()) {
      if (seen.has(start)) continue;
      components++;
      const stack = [start];
      seen.add(start);
      while (stack.length) {
        const n = stack.pop()!;
        for (const nb of neighbors.get(n) ?? []) if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
      }
    }
    if (components > worst) worst = components;
  }
  return worst;
}

/**
 * `meshTopology`'s `watertight` (backing `inspect`'s "watertight yes/no",
 * `export_stl`'s "print-ready", and `detectGenerator`'s forge note) is an
 * edge-multiplicity check: every edge shared by exactly two triangles. That
 * is necessary for a solid but not sufficient for a true 2-manifold — it
 * can't see a self-intersecting shell (two faces crossing in space) or a
 * vertex shared by two otherwise-disjoint fans (an hourglass pinch), because
 * both can leave every edge paired exactly twice.
 *
 * Two independent checks below, against real geometry libraries this build
 * does not otherwise depend on:
 *
 * 1. A hand-built hourglass (two tetrahedra sharing one vertex) — a
 *    dependency-free, textbook non-manifold vertex that `meshTopology`
 *    reports closed.
 * 2. `assets/ci-badge.png` (checked-in fixture) through `extrudeImage` with
 *    a small bevel, exported with `toStl()` exactly as `export_stl` ships
 *    it, and checked with the Manifold geometry library (`manifold-3d`,
 *    used by ManifoldCAD/OpenSCAD-alternatives — an authoritative,
 *    independent oracle for solid validity). `insetDirections`'s own doc
 *    comment already names the mechanism: "thin strokes don't self-
 *    intersect at small bevel radii" is a *miter limit*, not a guarantee —
 *    at `bevel: 0.005` on this fixture the exported STL self-intersects at
 *    a concave silhouette corner. `meshTopology` still reports it closed.
 */

describe('watertight vertex-pinch blind spot', () => {
  it('does not catch a non-manifold vertex in a hand-built hourglass (two tetra fans sharing one point)', () => {
    // Two independent tetrahedra, translated so they share exactly one
    // vertex (index 0 for both). Every edge is still paired exactly twice
    // *within its own tetrahedron*, so the edge-count check sees a closed
    // mesh; the shared apex is a textbook non-manifold vertex.
    const positions = new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1,
      0, 0, 0, -1, 0, 0, 0, -1, 0, 0, 0, -1,
    ]);
    const indices = new Uint32Array([
      0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2,
      4, 5, 6, 4, 6, 7, 4, 7, 5, 5, 7, 6,
    ]);
    const ir = {
      positions, indices, vertexCount: 8, mode: 'triangles', triangleCount: 8,
    } as unknown as Parameters<typeof meshTopology>[0];
    const t = meshTopology(ir)!;
    expect(t.boundaryEdges).toBe(0);
    expect(t.nonManifoldEdges).toBe(0);
    expect(t.watertight).toBe(true); // the blind spot: reports closed anyway

    // Ground truth: the shared apex has two disconnected triangle fans, not one.
    expect(maxLinkComponents(positions, indices, 8)).toBe(2);
  });

  it('reproduces a self-intersecting beveled export on a checked-in fixture; GLBForge still calls it watertight', async () => {
    const wasm = await ManifoldModule();
    wasm.setup();

    const png = readFileSync(join(__dirname, '..', '..', '..', 'assets', 'ci-badge.png'));
    const { doc } = await extrudeImage(new Uint8Array(png), { bevel: 0.005, texture: false });

    // GLBForge's own claim, the same computation `inspect`/`export_stl` use.
    const ir = (await import('../src/index.js')).fromGltf(doc, { format: 'glb' });
    const t = meshTopology(ir.meshes[0])!;
    expect(t.watertight).toBe(true);

    // The actual exported artifact, byte for byte what export_stl writes.
    const { stl } = toStl(doc, { targetSizeMm: 80 });
    const view = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
    const triCount = view.getUint32(80, true);
    const vertProperties = new Float32Array(triCount * 3 * 3);
    const triVerts = new Uint32Array(triCount * 3);
    let offset = 84, vi = 0;
    for (let tr = 0; tr < triCount; tr++) {
      offset += 12; // skip the STL's own face normal
      for (let c = 0; c < 3; c++) {
        vertProperties[vi * 3] = view.getFloat32(offset, true);
        vertProperties[vi * 3 + 1] = view.getFloat32(offset + 4, true);
        vertProperties[vi * 3 + 2] = view.getFloat32(offset + 8, true);
        offset += 12;
        triVerts[tr * 3 + c] = vi;
        vi++;
      }
      offset += 2;
    }
    const mesh = new wasm.Mesh({ numProp: 3, vertProperties, triVerts });
    mesh.merge(); // weld the triangle soup within tolerance, as any consumer would

    let status = 'NoError';
    try {
      const manifold = new wasm.Manifold(mesh);
      status = manifold.status();
      manifold.delete?.();
    } catch (e) {
      status = (e as Error).message;
    }
    expect(status).not.toBe('NoError'); // ground truth: not actually printable as one solid
  }, 30_000);
});
