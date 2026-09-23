import { describe, it, expect } from 'vitest';
import { Document } from '@gltf-transform/core';
import { analyze, getProfile, fromGltf, validateScene, inspectMaterials } from '../src/index.js';

/**
 * A texture whose bytes arrived but whose header will not read.
 *
 * `ImageUtils.getSize` reads a DataView straight off the image header, so a
 * truncated PNG threw "Offset is outside the bounds of the DataView" — and
 * nothing caught it. That escaped from analyze and from validate, naming no
 * file, no texture and no reason. validate is the tool you reach for to find
 * out why an asset is broken, and it was the one that could not survive this
 * asset.
 */

const PNG_1X1 = new Uint8Array(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
));

/** One textured triangle; `image` decides whether that texture is readable. */
function textured(image: Uint8Array, mimeType = 'image/png'): Document {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer))
    .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2')
      .setArray(new Float32Array([0, 0, 1, 0, 0, 1])).setBuffer(buffer));
  const tex = doc.createTexture('source').setMimeType(mimeType).setImage(image);
  prim.setMaterial(doc.createMaterial('surface').setBaseColorTexture(tex));
  doc.createScene().addChild(doc.createNode('n').setMesh(doc.createMesh('m').addPrimitive(prim)));
  return doc;
}

const truncated = () => textured(PNG_1X1.slice(0, 6));
const report = (doc: Document) => analyze(doc, { profile: getProfile('mobile-hero') });
const validated = (doc: Document) => validateScene(fromGltf(doc, { format: 'glb', sourcePath: 'x.glb', fileBytes: 0 }));

describe('a texture that cannot be decoded', () => {
  it('analyze reports it instead of throwing', () => {
    const r = report(truncated());
    const finding = r.findings.find((f) => f.ruleId === 'tex/undecodable');
    expect(finding, 'the report exists at all, and names the fault').toBeDefined();
    expect(finding!.severity).toBe('error');
    expect(finding!.message).toContain('"source"');
    // The rest of the asset is still measured.
    expect(r.geometry.triangles).toBe(1);
  });

  it('validate survives it, and still says the file opens', () => {
    const v = validated(truncated());
    // The container parses; one texture is broken. Those are different claims
    // and the report makes both, which is the whole point of the tool.
    expect(v.opens).toBe(true);
    expect(v.schema_errors).toHaveLength(0);
    expect(v.arkit_compatible).toBe(false);
    expect(v.diagnostics.some((d) => d.code === 'TEXTURE_UNDECODABLE')).toBe(true);
  });

  it('inspect_materials names the texture and its prim path', () => {
    const ir = fromGltf(truncated(), { format: 'glb', sourcePath: 'x.glb', fileBytes: 0 });
    const d = inspectMaterials(ir).diagnostics.find((x) => x.code === 'TEXTURE_UNDECODABLE');
    expect(d).toBeDefined();
    expect(d!.prim_path).toMatch(/Textures/);
  });

  it('says nothing about a texture that reads fine', () => {
    const r = report(textured(PNG_1X1));
    expect(r.findings.some((f) => f.ruleId === 'tex/undecodable')).toBe(false);
    expect(validated(textured(PNG_1X1)).diagnostics.some((d) => d.code === 'TEXTURE_UNDECODABLE')).toBe(false);
  });

  it('does not call a format it simply cannot measure corrupt', () => {
    // No size comes back for an unknown encoding either, but that is ignorance,
    // not damage, and the rule must not confuse the two.
    const r = report(textured(PNG_1X1.slice(0, 6), 'image/x-exotic'));
    expect(r.findings.some((f) => f.ruleId === 'tex/undecodable')).toBe(false);
  });
});
