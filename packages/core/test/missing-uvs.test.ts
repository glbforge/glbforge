import { describe, it, expect } from 'vitest';
import { Document } from '@gltf-transform/core';
import { analyze, getProfile } from '../src/index.js';

/**
 * A primitive without UVs is only a defect when something wants to read them,
 * so the rule asks the material rather than the vertex layout alone.
 *
 * The case that forced this apart: our own optimizer folds a single-colour
 * base-color texture into the material factor and drops the UV set with it,
 * losslessly. Reporting that as a warning told the reader an asset we had just
 * optimized "cannot be textured as-is", suggested undoing it, and put a
 * warning in the count that gates CI.
 */

/** A real 1x1 PNG: analyze reads image headers, so a stub buffer will not do. */
const PNG_1X1 = new Uint8Array(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
));

/** One triangle, no TEXCOORD, with the material this case needs. */
function quad(material: 'none' | 'flat' | 'textured'): Document {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const position = doc.createAccessor().setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer);
  const prim = doc.createPrimitive().setAttribute('POSITION', position);
  if (material !== 'none') {
    const mat = doc.createMaterial('surface').setBaseColorFactor([1, 0.2, 0.4, 1]);
    if (material === 'textured') {
      const tex = doc.createTexture('base').setMimeType('image/png').setImage(PNG_1X1);
      mat.setBaseColorTexture(tex);
    }
    prim.setMaterial(mat);
  }
  doc.createScene().addChild(doc.createNode('n').setMesh(doc.createMesh('m').addPrimitive(prim)));
  return doc;
}

const uvFindings = (doc: Document) =>
  analyze(doc, { profile: getProfile('mobile-hero') })
    .findings.filter((f) => f.ruleId === 'geo/missing-uvs');

describe('geo/missing-uvs asks what the material wants', () => {
  it('is an error when the material samples a texture it cannot apply', () => {
    // This one really does render wrong, which the old rule called a warning.
    const [f, ...rest] = uvFindings(quad('textured'));
    expect(rest).toHaveLength(0);
    expect(f.severity).toBe('error');
    expect(f.message).toMatch(/samples 1 texture slot\(s\) \(baseColor\)/);
  });

  it('is a warning when there is no material yet — a pre-texture export', () => {
    const [f] = uvFindings(quad('none'));
    expect(f.severity).toBe('warn');
    expect(f.message).toMatch(/no material/);
  });

  it('is information when the colour is a flat factor and nothing reads UVs', () => {
    const [f] = uvFindings(quad('flat'));
    expect(f.severity).toBe('info');
    expect(f.message).toMatch(/nothing reads UVs/);
  });

  it('keeps a flat-colour asset out of the warning count that gates CI', () => {
    const report = analyze(quad('flat'), { profile: getProfile('mobile-hero') });
    expect(report.findings.filter((f) => f.severity === 'warn' && f.ruleId === 'geo/missing-uvs')).toHaveLength(0);
    expect(report.passed).toBe(true);
  });

  it('says nothing at all when the primitive has UVs', () => {
    const doc = quad('textured');
    const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
    const buffer = doc.getRoot().listBuffers()[0];
    prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2')
      .setArray(new Float32Array([0, 0, 1, 0, 0, 1])).setBuffer(buffer));
    expect(uvFindings(doc)).toHaveLength(0);
  });
});
