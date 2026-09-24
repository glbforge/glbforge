import { describe, it, expect } from 'vitest';
import { Document } from '@gltf-transform/core';
import { detectGenerator } from '../src/detect.js';

function forgedDoc(): Document {
  const doc = new Document();
  doc.createBuffer();
  doc.getRoot().getAsset().generator = 'glbforge';
  return doc;
}

describe('detectGenerator', () => {
  it('hedges the forge note on a beveled-rim self-intersection risk when topology is not measured', () => {
    const { guess, notes } = detectGenerator(forgedDoc());
    expect(guess).toBe('glbforge-forge');
    // Not an unconditional "watertight by construction" — see L33/watertight-vertex-pinch.test.ts:
    // a beveled extrude can self-intersect at a concave corner and still measure edge-closed.
    expect(notes[0]).not.toMatch(/watertight by construction/i);
    expect(notes[0]).toMatch(/self-intersect/i);
  });

  it('says so plainly when this asset is measured non-manifold', () => {
    const { notes } = detectGenerator(forgedDoc(), {
      boundaryEdges: 0, nonManifoldEdges: 3, degenerateTriangles: 0,
      duplicateVertexPositions: 0, redundantVertices: 0, uniquePositions: 10,
    });
    expect(notes[0]).toMatch(/not closed/i);
    expect(notes[0]).toMatch(/3 non-manifold/);
    expect(notes[0]).not.toMatch(/watertight by construction/i);
  });

  it('does not claim the self-intersection caveat when topology measures this asset closed', () => {
    const { notes } = detectGenerator(forgedDoc(), {
      boundaryEdges: 0, nonManifoldEdges: 0, degenerateTriangles: 0,
      duplicateVertexPositions: 0, redundantVertices: 0, uniquePositions: 10,
    });
    // Still hedged (edge-closed isn't full solid validity), not a "not closed" note.
    expect(notes[0]).not.toMatch(/not closed/i);
  });
});
