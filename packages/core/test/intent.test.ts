/**
 * intent@1: parsing the free-text expectation, measured contract checks
 * (shells, watertight, size, origin, units), the heuristic category prior
 * with its confidence, the glTF Z-up story, and `front` as declared only.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document } from '@gltf-transform/core';
import { CATEGORY_SIZES, createNodeIO, fromGltf, fromUsd, getPack, inspectScene, parseExpectation, readUsdLayer, runPacks, type RuleFinding } from '../src/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface Part { positions: number[]; indices: number[] }
function box(min: number[], size: number[]): Part {
  const p: number[] = [];
  for (let i = 0; i < 8; i++) p.push(min[0] + (i & 1 ? size[0] : 0), min[1] + (i & 2 ? size[1] : 0), min[2] + (i & 4 ? size[2] : 0));
  const faces = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  const idx: number[] = [];
  for (const [a, b, c, d] of faces) idx.push(a, b, c, a, c, d);
  return { positions: p, indices: idx };
}
const concat = (...parts: Part[]): Part => {
  const positions: number[] = [], indices: number[] = [];
  for (const part of parts) { const base = positions.length / 3; for (const v of part.positions) positions.push(v); for (const i of part.indices) indices.push(i + base); }
  return { positions, indices };
};
function doc(part: Part, name = 'mesh'): Document {
  const d = new Document();
  const buffer = d.createBuffer();
  const prim = d.createPrimitive()
    .setAttribute('POSITION', d.createAccessor().setType('VEC3').setArray(new Float32Array(part.positions)).setBuffer(buffer))
    .setIndices(d.createAccessor().setType('SCALAR').setArray(new Uint32Array(part.indices)).setBuffer(buffer));
  d.createScene('scene').addChild(d.createNode(name).setMesh(d.createMesh(name).addPrimitive(prim)));
  return d;
}
/** A chair-sized closed box standing on the origin plane, centred: 0.5 wide, 0.9 tall, 0.5 deep. */
const chair = () => fromGltf(doc(box([-0.25, 0, -0.25], [0.5, 0.9, 0.5]), 'chair'), { format: 'glb' });
const intent = (ir: ReturnType<typeof chair>, expect: string | object) => runPacks(ir, { packs: ['intent@1'], expect: expect as string });
const rules = (f: RuleFinding[]) => f.map((x) => x.rule);

describe('parseExpectation', () => {
  it('reads the brief\'s example and more', () => {
    const p = parseExpectation('chair, Z-up, meters, single-shell, 0.4-1.2m tall, front -Y, watertight, origin base');
    expect(p.expectation).toEqual({ category: 'chair', up: 'Z', units: 'm', shells: 1, size: { min: 0.4, max: 1.2, measure: 'height' }, front: '-Y', watertight: true, origin: 'base-center' });
    expect(p.unparsed).toEqual([]);
    expect(p.raw).toMatch(/^chair/);
  });

  it('units, ranges, singles, shell ranges, and unparsed tokens', () => {
    expect(parseExpectation('mm, 400-1200 tall').expectation.size).toEqual({ min: 0.4, max: 1.2, measure: 'height' });
    expect(parseExpectation('40cm-1.2m wide').expectation.size).toEqual({ min: 0.4, max: 1.2, measure: 'width' });
    expect(parseExpectation('about 80cm tall').expectation.size).toEqual({ min: 0.72, max: 0.88, measure: 'height' });
    expect(parseExpectation('0.1-0.3').expectation.size).toEqual({ min: 0.1, max: 0.3, measure: 'largest' });
    expect(parseExpectation('2-4 shells').expectation.shells).toEqual({ min: 2, max: 4 });
    expect(parseExpectation('shells: 3').expectation.shells).toBe(3);
    expect(parseExpectation('facing +Z').expectation.front).toBe('+Z');
    expect(parseExpectation('origin center').expectation.origin).toBe('center');
    const p = parseExpectation('lamp, purple, 12 legs, y-up');
    expect(p.expectation).toMatchObject({ category: 'lamp', up: 'Y' });
    expect(p.unparsed).toEqual(['purple', '12 legs']);
    expect(parseExpectation({ category: 'mug', shells: 1 })).toEqual({ raw: null, expectation: { category: 'mug', shells: 1 }, unparsed: [] });
  });
});

describe('intent@1', () => {
  it('is registered, runs only with an expectation, and is added automatically by runPacks / inspectScene', () => {
    expect(getPack('intent@1').rules.map((r) => r.id)).toEqual(['intent/units', 'intent/shells', 'intent/watertight', 'intent/size', 'intent/origin', 'intent/category-scale', 'intent/up-axis', 'intent/category-unknown']);
    expect(runPacks(chair()).packs).toEqual(['core-geometry@1', 'core-scene@1']);
    expect(runPacks(chair(), { expect: 'chair' }).packs).toEqual(['core-geometry@1', 'core-scene@1', 'intent@1']);
    expect(runPacks(chair(), { packs: ['intent@1'] }).findings).toEqual([]); // no expectation → nothing to check
  });

  it('a chair that meets its expectation is clean; front is recorded as declared', () => {
    const r = intent(chair(), 'chair, Z-up, meters, single-shell, 0.4-1.2m tall, front -Y, watertight, origin base');
    expect(rules(r.findings)).toEqual(['intent/up-axis']); // glTF is Y-up: informational, not a failure
    expect(r.findings[0]).toMatchObject({ severity: 'info', certainty: 'measured' });
    expect(r.findings[0].message).toMatch(/glTF stores Y-up by definition/);
    const rep = inspectScene(chair(), { expect: 'chair, front -Y, single-shell, watertight' });
    expect(rep.orientation).toEqual({ up_axis: 'Y', up_axis_source: 'format', front: '-Y', front_source: 'declared' });
    expect(rep.expectation!.expectation.front).toBe('-Y');
    expect(rep.scale).toMatchObject({ plausibility: 'plausible', plausibility_basis: { category: 'chair', typical_m: [0.4, 1.2], measure: 'height' } });
    expect(rep.summary).toMatch(/Front: -Y \(declared, not measured\)\. Expectation "chair, front -Y, single-shell, watertight": met\. Size plausible for a chair \(0\.40–1\.20 m height, 60% prior\)\./);
  });

  it('explicit checks are measured errors: shells, watertight, size, origin', () => {
    const two = fromGltf(doc(concat(box([-0.25, 0, -0.25], [0.5, 0.9, 0.5]), box([2, 0, 0], [0.1, 0.1, 0.1])), 'pair'), { format: 'glb' });
    const r = intent(two, 'single-shell, watertight, origin base, 0.4-1.2m tall');
    expect(rules(r.findings)).toEqual(['intent/shells', 'intent/origin']);
    expect(r.findings[0]).toMatchObject({ severity: 'error', certainty: 'measured', code: 'INTENT_SHELLS', prim_path: '/Asset' });
    expect(r.findings[0].message).toBe('Expected 1 connected shell; the asset has 2 (across 1 mesh).');
    expect(r.findings[0].likely_cause!.text).toMatch(/never joined|debris/);
    expect(r.findings[1].message).toMatch(/Expected the origin at the base centre; it is at no landmark/);

    const c = box([-0.25, 0, -0.25], [0.5, 0.9, 0.5]);
    const open = fromGltf(doc({ positions: c.positions, indices: c.indices.slice(6) }, 'lid'), { format: 'glb' });
    const w = intent(open, 'watertight');
    expect(rules(w.findings)).toEqual(['intent/watertight']);
    expect(w.findings[0].message).toBe('Expected a watertight solid; 1 of 1 mesh is not: lid (1 open loop, 0 non-manifold edges).');
    expect(w.findings[0].prim_path).toBe('/Asset/lid_0/Prim_0');
    expect(intent(open, 'open').findings).toEqual([]);

    const tall = intent(chair(), '1.5-2m tall');
    expect(rules(tall.findings)).toEqual(['intent/size']);
    expect(tall.findings[0]).toMatchObject({ severity: 'error', code: 'INTENT_SIZE' });
    expect(tall.findings[0].message).toBe('Expected 1.50 m–2.00 m tall; the asset is 90.0 cm along Y (0.60× the minimum).');
    expect(tall.findings[0].fix).toMatch(/Scale the asset by 1\.94/);
  });

  it('size causes: unit mix-up ×1000, ×100, lying on its side, or just wrong', () => {
    const mm = fromGltf(doc(box([-250, 0, -250], [500, 900, 500])), { format: 'glb' });
    expect(intent(mm, '0.4-1.2m tall').findings[0].likely_cause).toMatchObject({ confidence: 0.8 });
    expect(intent(mm, '0.4-1.2m tall').findings[0].likely_cause!.text).toMatch(/millimetres read as metres/);
    const cm = fromGltf(doc(box([-25, 0, -25], [50, 90, 50])), { format: 'glb' });
    expect(intent(cm, '0.4-1.2m tall').findings[0].likely_cause!.text).toMatch(/centimetres read as metres/);
    // Standing along Z, only 0.5 along Y: the Z extent fits the height range.
    const sideways = fromGltf(doc(box([-0.25, 0, 0], [0.5, 0.5, 0.9])), { format: 'glb' });
    const s = intent(sideways, '0.6-1.2m tall').findings[0];
    expect(s.likely_cause!.text).toMatch(/lying on its side: its Z extent \(90\.0 cm\) fits/);
    expect(s.likely_cause!.confidence).toBe(0.7);
    const wrong = fromGltf(doc(box([-1, 0, -1], [2, 3, 2])), { format: 'glb' });
    expect(intent(wrong, '0.4-1.2m tall').findings[0].likely_cause!.confidence).toBe(0.5);
  });

  it('category alone is a heuristic warning with a confidence; unknown categories say so', () => {
    const giant = fromGltf(doc(box([-1, 0, -1], [2, 4, 2]), 'chair'), { format: 'glb' });
    const r = intent(giant, 'chair');
    expect(rules(r.findings)).toEqual(['intent/category-scale']);
    expect(r.findings[0]).toMatchObject({ severity: 'warning', certainty: 'heuristic', confidence: 0.5, code: 'INTENT_CATEGORY_SCALE' });
    expect(r.findings[0].message).toBe('A chair is usually 40.0 cm–1.20 m tall; this one is 4.00 m along Y — 3.3× larger than the typical range (table prior, 50% confidence).');
    expect(r.findings[0].fix).toMatch(/pass an explicit range/i);
    // Explicit range wins over the prior.
    expect(rules(intent(giant, 'chair, 3-5m tall').findings)).toEqual([]);
    // Far off → higher confidence.
    const mmChair = fromGltf(doc(box([-250, 0, -250], [500, 900, 500])), { format: 'glb' });
    expect(intent(mmChair, 'chair').findings[0].confidence).toBe(0.8);
    const u = intent(chair(), 'gizmo');
    expect(rules(u.findings)).toEqual(['intent/category-unknown']);
    expect(u.findings[0]).toMatchObject({ severity: 'info', certainty: 'measured' });
    const rep = inspectScene(chair(), { expect: 'gizmo' });
    expect(rep.scale.plausibility).toBe('unknown');
    expect(Object.keys(CATEGORY_SIZES).length).toBeGreaterThan(30);
  });

  it('USD: up-axis and units are real checks against the layer metadata', () => {
    const usda = `#usda 1.0\n(\n  defaultPrim = "Root"\n  upAxis = "Z"\n  metersPerUnit = 0.01\n)\ndef Xform "Root" {\n  def Mesh "Box" {\n    int[] faceVertexCounts = [4]\n    int[] faceVertexIndices = [0, 1, 2, 3]\n    point3f[] points = [(0, 0, 0), (50, 0, 0), (50, 50, 0), (0, 50, 0)]\n  }\n}\n`;
    const ir = fromUsd(readUsdLayer(new TextEncoder().encode(usda)), { format: 'usda' });
    expect(ir.upAxis).toBe('Z');
    const r = intent(ir, 'Y-up, meters');
    expect(rules(r.findings)).toEqual(['intent/units', 'intent/up-axis']);
    expect(r.findings[0]).toMatchObject({ severity: 'error', code: 'INTENT_UNITS' });
    expect(r.findings[0].message).toMatch(/metersPerUnit = 0\.01 \(centimetres\)/);
    expect(r.findings[1]).toMatchObject({ severity: 'warning' });
    expect(r.findings[1].message).toBe('You expected Y-up; the layer declares upAxis = Z.');
  });

  it('runs on the optimized hero as a chair-sized object', async () => {
    const path = join(root, 'examples', 'veiled-guardian.web.glb');
    if (!existsSync(path)) return;
    const io = await createNodeIO();
    const ir = fromGltf(await io.readBinary(new Uint8Array(await readFile(path))), { format: 'glb' });
    const rep = inspectScene(ir, { expect: 'character, single-shell, watertight, 1.5-2.5m tall' });
    expect(rep.packs).toEqual(['core-geometry@1', 'core-scene@1', 'intent@1']);
    expect(rules(rep.findings).filter((r) => r.startsWith('intent/'))).toEqual(['intent/watertight']); // 152 non-manifold edges
    expect(rep.scale.plausibility).toBe('plausible');
    expect(rep.summary).toMatch(/Expectation "character, single-shell, watertight, 1\.5-2\.5m tall": 1 violation\./);
  });
});
