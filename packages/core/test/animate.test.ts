import { describe, it, expect } from 'vitest';
import { Accessor, Document } from '@gltf-transform/core';
import { animate, createNodeIO, fromGltf, inspectAnimation, netDisplacement, PIVOT_NAME, PIVOT_OFFSET_NAME, poseScene, readUsdz, readUsdLayer, findUsdzEntry, fromUsd, toUsdz } from '../src/index.js';

/** A 0.5 m box on a pedestal node, offset from the origin so the pivot is not trivially zero. */
function boxDoc(): Document {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const s = 0.25;
  const pos = new Float32Array([
    -s, 0, -s, s, 0, -s, s, 2 * s, -s, -s, 2 * s, -s, // back face
    -s, 0, s, s, 0, s, s, 2 * s, s, -s, 2 * s, s,     // front face
  ]);
  const idx = new Uint16Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2, 3, 2, 6, 3, 6, 7, 0, 4, 5, 0, 5, 1]);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType(Accessor.Type.VEC3).setArray(pos).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType(Accessor.Type.SCALAR).setArray(idx).setBuffer(buffer));
  const node = doc.createNode('box').setMesh(doc.createMesh('box').addPrimitive(prim)).setTranslation([1, 0.5, -2]);
  doc.createScene('scene').addChild(node);
  doc.getRoot().setDefaultScene(doc.getRoot().listScenes()[0]);
  return doc;
}

describe('animate', () => {
  it('inserts a base-centre pivot pair above the roots and leaves the original node alone', () => {
    const doc = boxDoc();
    const r = animate(doc, { preset: 'idle' });
    const scene = doc.getRoot().getDefaultScene()!;
    expect(scene.listChildren().map((n) => n.getName())).toEqual([PIVOT_NAME]);
    const pivot = scene.listChildren()[0];
    expect(pivot.listChildren().map((n) => n.getName())).toEqual([PIVOT_OFFSET_NAME]);
    expect(pivot.listChildren()[0].listChildren().map((n) => n.getName())).toEqual(['box']);
    expect(r.pivot).toEqual([1, 0.5, -2]);                         // base centre of the translated box
    expect(r.height).toBeCloseTo(0.5, 6);
    expect(doc.getRoot().listNodes().find((n) => n.getName() === 'box')!.getTranslation()).toEqual([1, 0.5, -2]);
    // world placement is unchanged at rest: pivot(+base) · offset(-base) = identity
    const world = doc.getRoot().listNodes().find((n) => n.getName() === 'box')!.getWorldMatrix();
    expect(Array.from(world.slice(12, 15)).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([1, 0.5, -2]);
  });

  it('bakes a closed loop that the animation inspector sees as motion, and poses differ mid-clip', () => {
    const doc = boxDoc();
    const r = animate(doc, { preset: 'idle', duration: 2 });
    expect(r.keys).toBe(61);
    expect(r.channels).toBe(2);                                    // translation + rotation; no scale in idle
    const ir = fromGltf(doc, { format: 'glb' });
    const report = inspectAnimation(ir);
    expect(report.has_animation).toBe(true);
    expect(report.clips[0].name).toBe('idle');
    expect(report.clips[0].has_motion).toBe(true);
    expect(report.duration_seconds).toBeCloseTo(2, 5);
    const rest = poseScene(ir, { animation: 0, time: 0 }).meshes[0].positions;
    const mid = poseScene(ir, { animation: 0, time: 1 }).meshes[0].positions;
    const end = poseScene(ir, { animation: 0, time: 2 }).meshes[0].positions;
    let moved = 0, closed = 0;
    for (let i = 0; i < rest.length; i++) { moved = Math.max(moved, Math.abs(mid[i] - rest[i])); closed = Math.max(closed, Math.abs(end[i] - rest[i])); }
    expect(moved).toBeGreaterThan(0.005);                          // the 2% rise on a 0.5 m box is 10 mm
    expect(closed).toBeLessThan(1e-6);                             // last key equals the first
  });

  it('is deterministic and idempotent: same bytes twice, and a re-run replaces the clip instead of nesting pivots', async () => {
    const io = await createNodeIO();
    const a = await io.writeBinary(animateAndReturn(boxDoc(), 'hop'));
    const b = await io.writeBinary(animateAndReturn(boxDoc(), 'hop'));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const doc = boxDoc();
    animate(doc, { preset: 'hop' });
    const r2 = animate(doc, { preset: 'hop' });
    expect(r2.reused_pivot).toBe(true);
    expect(doc.getRoot().listAnimations().map((x) => x.getName())).toEqual(['hop']);
    expect(doc.getRoot().listNodes().filter((n) => n.getName() === PIVOT_NAME).length).toBe(1);
    const r3 = animate(doc, { preset: 'spin' });
    expect(r3.reused_pivot).toBe(true);
    expect(doc.getRoot().listAnimations().map((x) => x.getName())).toEqual(['hop', 'spin']);
  });

  it('every preset closes its loop and amplitude 0 bakes nothing', () => {
    for (const preset of ['idle', 'bob', 'spin', 'sway', 'breathe', 'hop'] as const) {
      const doc = boxDoc();
      const r = animate(doc, { preset });
      expect(r.channels).toBeGreaterThan(0);
      for (const s of doc.getRoot().listAnimations()[0].listSamplers()) {
        const out = s.getOutput()!.getArray()!;
        const w = s.getOutput()!.getElementSize();
        for (let c = 0; c < w; c++) expect(out[c]).toBeCloseTo(out[out.length - w + c], 6);
      }
    }
    const doc = boxDoc();
    const r = animate(doc, { preset: 'bob', amplitude: 0 });
    expect(r.channels).toBe(0);
    expect(doc.getRoot().listAnimations().length).toBe(0);
    expect(r.warnings[0]).toMatch(/amplitude 0/);
  });

  it('reaches USDZ as xform time samples the USD reader turns back into a moving clip', async () => {
    const doc = boxDoc();
    animate(doc, { preset: 'spin', duration: 1 });
    const usdz = await toUsdz(doc, { format: 'usda' });
    expect(usdz.frames).toBe(31);
    expect(usdz.warnings.find((w) => /static/.test(w))).toBeUndefined();
    const container = readUsdz(usdz.usdz);
    const layer = readUsdLayer(container.layer!.data);
    const ir = fromUsd(layer, { format: 'usdz', sourcePath: 'box.usdz', fileBytes: usdz.usdz.byteLength, layerName: container.layer!.name, resolveAsset: (p) => findUsdzEntry(container, p, container.layer!.name)?.data ?? null, diagnostics: container.diagnostics });
    const report = inspectAnimation(ir);
    expect(report.has_animation).toBe(true);
    expect(report.clips[0].has_motion).toBe(true);
    expect(report.duration_seconds).toBeCloseTo(1, 3);
  });
});

describe('inspect_animation on baked clips', () => {
  it('a closed loop is not root motion; a clip that travels is, with the distance measured', () => {
    const doc = boxDoc();
    animate(doc, { preset: 'hop', duration: 1.2 });
    const report = inspectAnimation(fromGltf(doc, { format: 'glb' }));
    expect(report.root_motion_detected).toBe(false);
    expect(report.diagnostics.find((d) => d.code === 'ROOT_MOTION')).toBeUndefined();
    expect(report.clips[0].duration_seconds).toBe(1.2);                  // not 1.2000000476837158

    // Make the hop travel: move its last translation key 0.5 m along X.
    const anim = doc.getRoot().listAnimations()[0];
    const tr = anim.listChannels().find((c) => c.getTargetPath() === 'translation')!.getSampler()!.getOutput()!;
    const arr = tr.getArray() as Float32Array;
    arr[arr.length - 3] += 0.5;
    tr.setArray(arr);
    const ir = fromGltf(doc, { format: 'glb' });
    const travel = inspectAnimation(ir);
    expect(travel.root_motion_detected).toBe(true);
    expect(travel.diagnostics.find((d) => d.code === 'ROOT_MOTION')?.message).toMatch(/0\.500 m/);
    expect(netDisplacement(ir.animations[0].channels.find((c) => c.property === 'translation')!)).toBeCloseTo(0.5, 5);
  });
});

function animateAndReturn(doc: Document, preset: 'hop'): Document { animate(doc, { preset }); return doc; }
