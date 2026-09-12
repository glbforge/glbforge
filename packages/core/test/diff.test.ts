/**
 * diffAssets: the "what did I just change / break" read. Synthetic before /
 * after pairs with known answers, the change-note summary, profile
 * severities, mesh pairing across renumbered nodes, and the visual delta
 * with cameras fixed to the before framing.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document } from '@gltf-transform/core';
import { createNodeIO, diffAssets, diffV1, fromGltf, getProfile, listDiffRules, profileLabel, ERROR_CODES, type RuleFinding, type SceneIR } from '../src/index.js';

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
interface NodeSpec { name: string; mesh?: Part; translation?: number[]; scale?: number[] }
function scene(nodes: NodeSpec[]): SceneIR {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const s = doc.createScene('scene');
  for (const n of nodes) {
    const node = doc.createNode(n.name);
    if (n.mesh) {
      const prim = doc.createPrimitive()
        .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(n.mesh.positions)).setBuffer(buffer))
        .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(n.mesh.indices)).setBuffer(buffer));
      node.setMesh(doc.createMesh(n.name).addPrimitive(prim));
    }
    if (n.translation) node.setTranslation(n.translation as [number, number, number]);
    if (n.scale) node.setScale(n.scale as [number, number, number]);
    s.addChild(node);
  }
  return fromGltf(doc, { format: 'glb', fileBytes: nodes.length * 1000 });
}
/** A chair: seat slab plus four legs, standing on the origin plane, centred. */
const legs = (w = 0.05) => [
  { name: 'leg-fl', mesh: box([-0.25, 0, 0.2], [w, 0.45, w]) }, { name: 'leg-fr', mesh: box([0.2, 0, 0.2], [w, 0.45, w]) },
  { name: 'leg-bl', mesh: box([-0.25, 0, -0.25], [w, 0.45, w]) }, { name: 'leg-br', mesh: box([0.2, 0, -0.25], [w, 0.45, w]) },
];
const chair = (legWidth = 0.05) => scene([{ name: 'seat', mesh: box([-0.25, 0.45, -0.25], [0.5, 0.05, 0.5]) }, ...legs(legWidth)]);
const rules = (f: RuleFinding[]) => f.map((x) => x.rule);

describe('diff@1', () => {
  it('lists its rules with alias codes', () => {
    const ids = listDiffRules().map((r) => r.id);
    expect(ids).toEqual(['diff/watertight-lost', 'diff/open-edges-introduced', 'diff/non-manifold-introduced', 'diff/shells-changed', 'diff/origin-moved', 'diff/transform-changed', 'diff/size-changed', 'diff/triangles-changed', 'diff/meshes-removed', 'diff/meshes-added', 'diff/topology-improved', 'diff/visual-changed']);
    for (const r of diffV1.rules) expect(r.code in ERROR_CODES).toBe(true);
  });

  it('identical assets: no change', async () => {
    const r = await diffAssets(chair(), chair());
    expect(r.changed).toBe(false);
    expect(r.summary).toBe('No change.');
    expect(r.findings).toEqual([]);
    expect(r.meshes.every((m) => m.status === 'unchanged')).toBe(true);
    expect(r.topology).toMatchObject({ shells: { before: 5, after: 5, delta: 0 }, watertight: { before: true, after: true } });
  });

  it('thinner legs: names the parts and the axes, nothing else', async () => {
    const r = await diffAssets(chair(0.05), chair(0.03));
    expect(rules(r.findings)).toEqual(['diff/size-changed']);
    const f = r.findings[0];
    expect(f).toMatchObject({ pack: 'diff@1', severity: 'info', certainty: 'measured', code: 'DIFF_SIZE_CHANGED' });
    // The seat sets the overall bounds, so only the parts change — the brief's "you made the legs thinner".
    expect(f.message).toBe("The overall bounds are unchanged. 'leg-fl' is 40% narrower along X; 'leg-fr' is 40% narrower along X; 'leg-bl' is 40% narrower along X.");
    expect(f.likely_cause!.text).toMatch(/reshaped without changing the silhouette/);
    expect(r.meshes.find((m) => m.name === 'leg-br')!.size_m.pct).toEqual([-0.4, 0, -0.4]);
    expect(r.meshes.find((m) => m.name === 'seat')!.status).toBe('unchanged');
    expect(r.summary).toBe(`${f.message}`);
  });

  it('moved origin + broke watertightness: the summary reads like the brief', async () => {
    const before = chair();
    const seat = box([-0.25, 0.45, -0.25], [0.5, 0.05, 0.5]);
    const broken = scene([{ name: 'seat', mesh: { positions: seat.positions, indices: seat.indices.slice(6) } }, ...legs()].map((n) => ({ ...n, translation: [0.3, 0, 0] })));
    const r = await diffAssets(before, broken);
    expect(rules(r.findings)).toEqual(['diff/watertight-lost', 'diff/origin-moved', 'diff/transform-changed', 'diff/transform-changed', 'diff/transform-changed', 'diff/transform-changed', 'diff/transform-changed', 'diff/triangles-changed']);
    const wl = r.findings[0];
    expect(wl).toMatchObject({ severity: 'warning', prim_path: '/Asset/seat_0/Prim_0' });
    expect(wl.message).toBe("Watertightness lost on 'seat': 1 open loop (4 edges) appeared.");
    expect(wl.likely_cause!.text).toMatch(/deleted or moved faces/);
    const om = r.findings[1];
    expect(om.message).toMatch(/^The geometry moved 30\.0 cm relative to the origin \(bounds centre shifted by \(0\.3, 0, 0\) m\); the origin was at the base centre, now at no landmark\./);
    expect(om.fix).toMatch(/translate the geometry back by \(-0\.3, 0, 0\) m/);
    expect(r.origin).toMatchObject({ moved: true, shift_m: 0.3 });
    expect(r.topology.watertight).toEqual({ before: true, after: false });
    expect(r.summary).toMatch(/^Triangles 60 → 58 \(−3%\)\. Watertightness lost on 'seat': 1 open loop \(4 edges\) appeared\. The geometry moved 30\.0 cm relative to the origin/);
    expect(r.summary).toMatch(/7 regressions at warning or above\.$/);
  });

  it('shells: detaching is a warning, joining is info; added and removed meshes are named', async () => {
    const before = scene([{ name: 'body', mesh: box([-0.5, 0, -0.5], [1, 1, 1]) }]);
    const detached = scene([{ name: 'body', mesh: concat(box([-0.5, 0, -0.5], [1, 1, 1]), box([0.8, 0, -0.1], [0.2, 0.2, 0.2])) }]);
    const r = await diffAssets(before, detached);
    // The far piece also drags the bounds centre off the origin, which is a real origin drift.
    expect(rules(r.findings)).toEqual(['diff/shells-changed', 'diff/origin-moved', 'diff/size-changed', 'diff/triangles-changed']);
    expect(r.findings[0]).toMatchObject({ severity: 'warning', prim_path: '/Asset/body_0/Prim_0' });
    expect(r.findings[0].message).toBe("Shells 1 → 2: 1 new separate piece ('body' 1 → 2).");
    const joined = await diffAssets(detached, before);
    const j = joined.findings.find((f) => f.rule === 'diff/shells-changed')!;
    expect(j).toMatchObject({ severity: 'info', default_severity: 'info' });
    expect(j.message).toBe("Shells 2 → 1: 1 piece joined ('body' 2 → 1).");

    const withArm = scene([{ name: 'body', mesh: box([-0.5, 0, -0.5], [1, 1, 1]) }, { name: 'arm', mesh: box([0.5, 0.5, -0.1], [0.3, 0.1, 0.1]) }]);
    const bodyOnly = scene([{ name: 'body', mesh: box([-0.5, 0, -0.5], [1, 1, 1]) }]);
    const added = await diffAssets(bodyOnly, withArm);
    expect(rules(added.findings)).toEqual(['diff/shells-changed', 'diff/origin-moved', 'diff/size-changed', 'diff/triangles-changed', 'diff/meshes-added']);
    expect(added.findings.find((f) => f.rule === 'diff/meshes-added')!.message).toBe("1 mesh added: 'arm' (12 tris).");
    expect(added.meshes.find((m) => m.name === 'arm')!.status).toBe('added');
    const removed = await diffAssets(withArm, bodyOnly);
    expect(removed.findings.find((f) => f.rule === 'diff/meshes-removed')!.message).toBe("1 mesh removed: 'arm' (12 tris).");
  });

  it('pairs meshes by name when nodes are renumbered, and topology improvements are info', async () => {
    const seat = box([-0.25, 0.45, -0.25], [0.5, 0.05, 0.5]);
    const before = scene([{ name: 'seat', mesh: { positions: seat.positions, indices: seat.indices.slice(6) } }, ...legs()]);
    const after = scene([{ name: 'empty' }, ...legs(), { name: 'seat', mesh: seat }]); // seat moved to node index 5, hole closed
    const r = await diffAssets(before, after);
    const seatDelta = r.meshes.find((m) => m.name === 'seat')!;
    expect(seatDelta.status).toBe('changed');
    expect(seatDelta.prim_path).toBe('/Asset/seat_5/Prim_0');
    expect(seatDelta.watertight).toEqual({ before: false, after: true });
    expect(rules(r.findings)).toEqual(['diff/triangles-changed', 'diff/topology-improved']);
    expect(r.findings[1].message).toBe("'seat' is now watertight (was 1 open loop, 0 non-manifold).");
    expect(r.structural.added_prims.length).toBeGreaterThan(0); // the structural diff sees the renumbering; the mesh pairing does not care
  });

  it('web profiles downgrade regressions; topology off leaves topology fields null', async () => {
    const seat = box([-0.25, 0.45, -0.25], [0.5, 0.05, 0.5]);
    const broken = scene([{ name: 'seat', mesh: { positions: seat.positions, indices: seat.indices.slice(6) } }, ...legs()]);
    const web = await diffAssets(chair(), broken, { profile: 'mobile-hero' });
    expect(web.profile).toBe(profileLabel(getProfile('mobile-hero'))); // resolves + labels the latest version
    expect(web.findings.find((f) => f.rule === 'diff/watertight-lost')).toMatchObject({ severity: 'warning', default_severity: 'warning' }); // web profiles do not override diff rules yet
    const off = await diffAssets(chair(), broken, { topology: false });
    expect(off.topology.shells).toBeNull();
    expect(off.topology.watertight).toEqual({ before: null, after: null });
    expect(rules(off.findings)).toEqual(['diff/triangles-changed']);
  });

  it('is deterministic', async () => {
    const a = await diffAssets(chair(0.05), chair(0.03));
    const b = await diffAssets(chair(0.05), chair(0.03));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('visual delta: cameras fixed to the before framing, the changed view is named', async () => {
    const r = await diffAssets(chair(0.05), chair(0.02), { visual: true, visualSize: 96 });
    expect(r.visual).not.toBeNull();
    expect(r.visual!.framing).toBe('before');
    expect(r.visual!.views.map((v) => v.name)).toEqual(['front', 'side', 'top', 'iso']);
    expect(r.visual!.ssim_min).toBeLessThan(0.995);
    const vc = r.findings.find((f) => f.rule === 'diff/visual-changed')!;
    expect(vc).toBeDefined();
    expect(vc.message).toMatch(/view changed most \(SSIM 0\.\d+\)/);
    const same = await diffAssets(chair(), chair(), { visual: true, visualSize: 64 });
    expect(same.visual!.ssim_min).toBe(1);
    expect(same.findings).toEqual([]);
  });

  it('runs on a real pair: the raw Hunyuan plush vs its optimized output', async () => {
    const a = join(root, 'examples', 'plush-hunyuan.glb'), b = join(root, 'examples', 'plush-hunyuan.web.glb');
    if (!existsSync(a) || !existsSync(b)) return;
    const io = await createNodeIO();
    const before = fromGltf(await io.readBinary(new Uint8Array(await readFile(a))), { format: 'glb', sourcePath: a });
    const after = fromGltf(await io.readBinary(new Uint8Array(await readFile(b))), { format: 'glb', sourcePath: b });
    const t0 = performance.now();
    const r = await diffAssets(before, after);
    expect(performance.now() - t0).toBeLessThan(2500); // ~250 ms alone; generous for a parallel suite
    expect(r.scene.triangles.before).toBe(232616);
    expect(r.scene.triangles.after).toBeLessThan(232616);
    expect(rules(r.findings)).toContain('diff/triangles-changed');
    expect(r.summary).toMatch(/Triangles 232,616 → /);
  });
});
