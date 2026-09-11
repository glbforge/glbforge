/**
 * core-scene@1: origin placement, unapplied / mirrored / non-uniform node
 * transforms (quantized meshes exempt), real-unit scale sanity — with the
 * web profiles' stance on each.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document } from '@gltf-transform/core';
import { createNodeIO, fromGltf, getPack, inspectScene, listRules, runPacks, type RuleFinding } from '../src/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface Part { positions: number[]; indices: number[] }
function cube(min = [0, 0, 0], size = 1): Part {
  const p: number[] = [];
  for (let i = 0; i < 8; i++) p.push(min[0] + (i & 1 ? size : 0), min[1] + (i & 2 ? size : 0), min[2] + (i & 4 ? size : 0));
  const faces = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  const idx: number[] = [];
  for (const [a, b, c, d] of faces) idx.push(a, b, c, a, c, d);
  return { positions: p, indices: idx };
}
interface NodeSpec { name: string; mesh?: Part; translation?: number[]; rotation?: number[]; scale?: number[]; quantized?: boolean }
function sceneDoc(nodes: NodeSpec[]): Document {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('scene');
  for (const spec of nodes) {
    const node = doc.createNode(spec.name);
    if (spec.mesh) {
      const pos = spec.quantized
        ? doc.createAccessor().setType('VEC3').setArray(new Int16Array(spec.mesh.positions.map((v) => Math.round(v * 1000)))).setNormalized(false).setBuffer(buffer)
        : doc.createAccessor().setType('VEC3').setArray(new Float32Array(spec.mesh.positions)).setBuffer(buffer);
      const prim = doc.createPrimitive().setAttribute('POSITION', pos).setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(spec.mesh.indices)).setBuffer(buffer));
      node.setMesh(doc.createMesh(spec.name).addPrimitive(prim));
    }
    if (spec.translation) node.setTranslation(spec.translation as [number, number, number]);
    if (spec.rotation) node.setRotation(spec.rotation as [number, number, number, number]);
    if (spec.scale) node.setScale(spec.scale as [number, number, number]);
    scene.addChild(node);
  }
  return doc;
}
const irOf = (nodes: NodeSpec[]) => fromGltf(sceneDoc(nodes), { format: 'glb' });
const scene = (nodes: NodeSpec[], opts = {}) => runPacks(irOf(nodes), { packs: ['core-scene@1'], ...opts });
const rules = (f: RuleFinding[]) => f.map((x) => x.rule);

describe('core-scene@1', () => {
  it('is registered and every rule has an alias code', () => {
    expect(getPack('core-scene@1').rules.map((r) => r.id)).toEqual(['origin/outside-bounds', 'origin/not-at-base', 'xform/unapplied', 'xform/mirrored', 'xform/non-uniform-scale', 'scale/too-small', 'scale/too-large']);
    expect(listRules().map((r) => r.pack)).toContain('core-scene@1');
    expect(runPacks(irOf([{ name: 'b', mesh: cube([-0.5, 0, -0.5]) }])).packs).toEqual(['core-geometry@1', 'core-scene@1']);
  });

  it('a well-placed applied cube is clean', () => {
    expect(scene([{ name: 'b', mesh: cube([-0.5, 0, -0.5]) }]).findings).toEqual([]);
  });

  it('origin/not-at-base: centre and corner, with the exact translation that fixes it', () => {
    const centred = scene([{ name: 'b', mesh: cube([-0.5, -0.5, -0.5]) }]).findings;
    expect(rules(centred)).toEqual(['origin/not-at-base']);
    expect(centred[0]).toMatchObject({ severity: 'info', certainty: 'measured', code: 'PIVOT_NOT_AT_BASE', prim_path: '/Asset' });
    expect(centred[0].message).toBe('The origin is at the bounding-box centre, 50.0 cm above the bottom of the bounds along Y.');
    expect(centred[0].fix).toMatch(/translate the geometry by \(0, 0\.5, 0\) m/);
    expect(centred[0].data).toMatchObject({ at: 'center', offset_to_base_center_m: [0, 0.5, 0] });
    expect(centred[0].likely_cause!.confidence).toBe(0.6);

    const corner = scene([{ name: 'b', mesh: cube([0, 0, 0]) }]).findings[0];
    expect(corner.message).toMatch(/at \(0, 0, 0\) in bounds units, 0\.00 mm above/);
    expect(corner.fix).toMatch(/\(-0\.5, 0, -0\.5\) m/);
  });

  it('origin/outside-bounds fires when the pivot is off the object; web profiles make it info', () => {
    const r = scene([{ name: 'b', mesh: cube([5, 2, 0]) }]);
    expect(rules(r.findings)).toEqual(['origin/outside-bounds']);
    expect(r.findings[0]).toMatchObject({ severity: 'warning', code: 'ORIGIN_OUTSIDE_BOUNDS' });
    expect(r.findings[0].message).toMatch(/nearest point of the bounds is 5\.39 m away/);
    expect(r.findings[0].fix).toMatch(/\(-5\.5, -2, -0\.5\) m/);
    expect(runPacks(irOf([{ name: 'b', mesh: cube([5, 2, 0]) }]), { profile: 'mobile-hero' }).findings.find((f) => f.rule === 'origin/outside-bounds')!.severity).toBe('info');
  });

  it('xform/unapplied lists what is unapplied; a translated node that is also off-origin gets both findings', () => {
    // Shifted along z: the origin stays inside the bounds but off the footprint centre.
    const r = scene([{ name: 'moved', mesh: cube([-0.5, 0, -0.5]), translation: [0, 0, 0.3], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2], scale: [2, 2, 2] }]);
    expect(rules(r.findings)).toEqual(['xform/unapplied', 'origin/not-at-base']);
    const u = r.findings[0];
    expect(u).toMatchObject({ severity: 'warning', code: 'XFORM_UNAPPLIED', prim_path: '/Asset/moved_0' });
    expect(u.message).toBe('moved carries an unapplied transform: translation (0, 0, 0.3) m, rotation 90.0°, scale (2, 2, 2). Its mesh coordinates are not the coordinates you see.');
    // Lifted a metre: the origin is now below the geometry, which is the outside-bounds case.
    expect(rules(scene([{ name: 'lifted', mesh: cube([-0.5, 0, -0.5]), translation: [0, 1, 0] }]).findings)).toEqual(['origin/outside-bounds', 'xform/unapplied']);
    expect(u.fix).toMatch(/Ctrl\+A/);
    expect(u.data).toMatchObject({ rotation_deg: 90 });
  });

  it('quantized meshes are exempt: the node transform is the encoding, and the report says so', () => {
    const q = irOf([{ name: 'packed', mesh: cube([-0.5, 0, -0.5]), scale: [0.001, 0.001, 0.001], quantized: true }]);
    expect(q.meshes[0].positionsQuantized).toBe(true);
    expect(rules(runPacks(q, { packs: ['core-scene@1'] }).findings)).toEqual([]);
    const rep = inspectScene(q);
    expect(rep.hierarchy.unapplied_transforms[0]).toMatchObject({ name: 'packed', dequantization: true });
    expect(rep.summary).toMatch(/1 quantized mesh node \(node transform is the encoding\)/);
    expect(irOf([{ name: 'f', mesh: cube() }]).meshes[0].positionsQuantized).toBe(false);
  });

  it('mirrored and non-uniform scale are separate findings; mirrored stays a warning on the web', () => {
    const r = scene([
      { name: 'flipped', mesh: cube([-0.5, 0, -0.5]), scale: [-1, 1, 1] },
      { name: 'stretched', mesh: cube([1, 0, -0.5]), scale: [1, 2, 1] },
    ]);
    expect(rules(r.findings)).toEqual(['xform/unapplied', 'xform/unapplied', 'xform/mirrored', 'origin/not-at-base', 'xform/non-uniform-scale']);
    const m = r.findings.find((f) => f.rule === 'xform/mirrored')!;
    expect(m).toMatchObject({ severity: 'warning', code: 'XFORM_MIRRORED', prim_path: '/Asset/flipped_0' });
    expect(m.message).toMatch(/wind inside-out/);
    const nu = r.findings.find((f) => f.rule === 'xform/non-uniform-scale')!;
    expect(nu).toMatchObject({ severity: 'info', prim_path: '/Asset/stretched_1' });
    const web = runPacks(irOf([{ name: 'flipped', mesh: cube([-0.5, 0, -0.5]), scale: [-1, 1, 1] }]), { profile: 'desktop-hero' }).findings;
    expect(web.find((f) => f.rule === 'xform/mirrored')!.severity).toBe('warning');
    expect(web.find((f) => f.rule === 'xform/unapplied')!.severity).toBe('info');
  });

  it('scale sanity: millimetre and building-sized assets, with unit-conversion causes; thresholds are params', () => {
    const tiny = scene([{ name: 't', mesh: cube([-0.001, 0, -0.001], 0.002) }]).findings;
    expect(rules(tiny)).toEqual(['scale/too-small']);
    expect(tiny[0]).toMatchObject({ severity: 'warning', code: 'SCALE_TOO_SMALL', prim_path: '/Asset' });
    expect(tiny[0].message).toMatch(/Largest dimension is 2\.00 mm/);
    expect(tiny[0].likely_cause!.text).toMatch(/Millimetres or centimetres were exported as metres/);
    expect(tiny[0].fix).toMatch(/Scale by 1000/);
    const huge = scene([{ name: 'h', mesh: cube([-25, 0, -25], 50) }]).findings;
    expect(rules(huge)).toEqual(['scale/too-large']);
    expect(huge[0].message).toMatch(/50\.00 m; the asset is building-sized/);
    expect(rules(scene([{ name: 'h', mesh: cube([-25, 0, -25], 50) }], { params: { 'core-scene': { largeScale: 100 } } }).findings)).toEqual([]);
  });

  it('the optimized hero: dequantization transform raises nothing, origin at centre is info, web profile all info', async () => {
    const path = join(root, 'examples', 'veiled-guardian.web.glb');
    if (!existsSync(path)) return;
    const io = await createNodeIO();
    const ir = fromGltf(await io.readBinary(new Uint8Array(await readFile(path))), { format: 'glb' });
    expect(ir.meshes[0].positionsQuantized).toBe(true);
    const auth = runPacks(ir, { profile: 'authoring' });
    expect(rules(auth.findings)).toEqual(['topo/non-manifold', 'topo/degenerate', 'origin/not-at-base']);
    expect(runPacks(ir, { profile: 'mobile-hero' }).findings.every((f) => f.severity === 'info')).toBe(true);
    const rep = inspectScene(ir);
    expect(rep.hierarchy.unapplied_transforms[0].dequantization).toBe(true);
    expect(rep.summary).toMatch(/1 node: 1 quantized mesh node \(node transform is the encoding\)\./);
  });
});
