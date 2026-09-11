/**
 * inspectScene: the facts an agent asks for — shells, watertight, size in
 * metres, up axis, origin landmark, unapplied transforms — plus findings and
 * a deterministic summary. Front is always unknown.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document } from '@gltf-transform/core';
import { createNodeIO, fromGltf, inspectScene, runPacks } from '../src/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface Part { positions: number[]; indices: number[] }

/** Closed cube with its minimum corner at `min` and edge `size`. */
function cube(min = [0, 0, 0], size = 1): Part {
  const p: number[] = [];
  for (let i = 0; i < 8; i++) p.push(min[0] + (i & 1 ? size : 0), min[1] + (i & 2 ? size : 0), min[2] + (i & 4 ? size : 0));
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

interface NodeSpec { name: string; mesh?: Part; translation?: number[]; rotation?: number[]; scale?: number[]; children?: NodeSpec[] }

function sceneDoc(nodes: NodeSpec[]): Document {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('scene');
  const build = (spec: NodeSpec) => {
    const node = doc.createNode(spec.name);
    if (spec.mesh) {
      const prim = doc.createPrimitive()
        .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(spec.mesh.positions)).setBuffer(buffer))
        .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(spec.mesh.indices)).setBuffer(buffer));
      node.setMesh(doc.createMesh(spec.name).addPrimitive(prim));
    }
    if (spec.translation) node.setTranslation(spec.translation as [number, number, number]);
    if (spec.rotation) node.setRotation(spec.rotation as [number, number, number, number]);
    if (spec.scale) node.setScale(spec.scale as [number, number, number]);
    for (const c of spec.children ?? []) node.addChild(build(c));
    return node;
  };
  for (const n of nodes) scene.addChild(build(n));
  return doc;
}

const report = (nodes: NodeSpec[], opts = {}) => inspectScene(fromGltf(sceneDoc(nodes), { format: 'glb' }), opts);

describe('inspectScene facts', () => {
  it('a unit cube sitting on the origin plane, centred: base-center, one watertight shell, 1 × 1 × 1 m, Y-up, front unknown', () => {
    const r = report([{ name: 'box', mesh: cube([-0.5, 0, -0.5]) }]);
    expect(r.scene).toMatchObject({ meshes: 1, triangles: 12, vertices: 8, nodes: 1, depth: 1 });
    expect(r.topology).toMatchObject({ shells: 1, watertight: true });
    expect(r.topology.meshes[0]).toMatchObject({ prim_path: '/Asset/box_0/Prim_0', shells: 1, watertight: true, boundary_loops: 0, non_manifold_edges: 0 });
    expect(r.scale).toMatchObject({ units: 'm', meters_per_unit: 1, largest_dimension_m: 1, plausibility: 'unknown' });
    expect(r.scale.bounding_box!.size).toEqual([1, 1, 1]);
    expect(r.orientation).toEqual({ up_axis: 'Y', up_axis_source: 'format', front: 'unknown' });
    expect(r.origin).toMatchObject({ at: 'base-center', height_above_base_m: 0 });
    expect(r.origin.position_in_bounds).toEqual([0.5, 0, 0.5]);
    expect(r.hierarchy).toMatchObject({ nodes: 1, mesh_nodes: 1, unapplied_transforms: [], non_uniform_scale: [], mirrored: [], root_names: ['box'] });
    expect(r.findings).toEqual([]);
    expect(r.profile).toBe('authoring@1');
    expect(r.summary).toBe('1 mesh, 12 triangles, 1.00 × 1.00 × 1.00 m, Y-up. One watertight shell. Origin at the base centre. 1 node, transforms applied. Front: unknown (declare it with an expectation).');
  });

  it('classifies the origin: center, centroid, elsewhere', () => {
    expect(report([{ name: 'c', mesh: cube([-0.5, -0.5, -0.5]) }]).origin).toMatchObject({ at: 'center', height_above_base_m: 0.5 });
    expect(report([{ name: 'c', mesh: cube([0, 0, 0]) }]).origin).toMatchObject({ at: 'elsewhere', height_above_base_m: 0, position_in_bounds: [0, 0, 0] });
    // Small cube at x∈[-1.5,-0.5], big cube at x∈[-0.5,2.5]: bbox centre x = 0.5, vertex mean x = 0 → origin is at the centroid, not the centre.
    const lopsided = concat(cube([-1.5, -0.5, -0.5], 1), cube([-0.5, -1.5, -1.5], 3));
    const r = report([{ name: 'l', mesh: lopsided }]);
    expect(r.origin.at).toBe('centroid');
    expect(r.origin.distance_to_centroid_m).toBeCloseTo(0, 6);
    expect(r.summary).toMatch(/Origin at the vertex centroid, 1\.50 m above the base/);
    expect(report([{ name: 'c', mesh: cube([-0.5, -2, -0.5]) }]).summary).toMatch(/\(0\.50, 2\.00, 0\.50 inside the bounds\), 2\.00 m above the base/);
    expect(report([{ name: 'c', mesh: cube([-0.5, 2, -0.5]) }]).summary).toMatch(/2\.00 m below the base/);
  });

  it('reports unapplied, non-uniform and mirrored transforms on mesh nodes, and hierarchy depth', () => {
    const r = report([{
      name: 'root',
      children: [
        { name: 'moved', mesh: cube(), translation: [0, 1, 0], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] },
        { name: 'stretched', mesh: cube([3, 0, 0]), scale: [1, 2, 1] },
        { name: 'flipped', mesh: cube([6, 0, 0]), scale: [-1, 1, 1] },
        { name: 'empty' },
      ],
    }]);
    expect(r.hierarchy.nodes).toBe(5);
    expect(r.hierarchy.mesh_nodes).toBe(3);
    expect(r.hierarchy.depth).toBe(2);
    expect(r.hierarchy.unapplied_transforms.map((t) => t.name)).toEqual(['moved', 'stretched', 'flipped']);
    expect(r.hierarchy.unapplied_transforms[0]).toMatchObject({ prim_path: '/Asset/moved_1', translation: [0, 1, 0], rotation_deg: 90, scale: [1, 1, 1] });
    expect(r.hierarchy.non_uniform_scale).toEqual(['/Asset/stretched_2']);
    expect(r.hierarchy.mirrored).toEqual(['/Asset/flipped_3']);
    expect(r.hierarchy.root_names).toEqual(['root']);
    expect(r.summary).toMatch(/5 nodes \(depth 2\): 3 mesh nodes with unapplied transforms, 1 mirrored node, 1 node with non-uniform scale\./);
    // World-space bounds honour the transforms: the moved cube sits at y 1..2.
    expect(r.scale.bounding_box!.min[1]).toBe(0);
    expect(r.scale.bounding_box!.max[1]).toBe(2);
  });

  it('carries findings and the summary names the top ones; topology off says so', () => {
    const c = cube();
    const r = report([{ name: 'lid', mesh: { positions: c.positions, indices: c.indices.slice(6) } }]);
    expect(r.findings.map((f) => f.rule)).toEqual(['topo/open-edges', 'origin/not-at-base']);
    expect(r.topology).toMatchObject({ shells: 1, watertight: false });
    expect(r.summary).toMatch(/One shell, not watertight\./);
    expect(r.summary).toMatch(/WARNING topo\/open-edges: lid is not a closed surface: 1 boundary loop totalling 4 open edges/);

    const off = report([{ name: 'lid', mesh: { positions: c.positions, indices: c.indices.slice(6) } }], { topology: false });
    expect(off.topology).toMatchObject({ shells: null, watertight: null });
    expect(off.topology.meshes[0].shells).toBeNull();
    expect(off.skipped.length).toBe(5);
    expect(off.summary).toMatch(/Topology not checked\./);
  });

  it('takes the profile: web profile downgrades, and the report agrees with runPacks', () => {
    const c = cube();
    const ir = fromGltf(sceneDoc([{ name: 'lid', mesh: { positions: c.positions, indices: c.indices.slice(6) } }]), { format: 'glb' });
    const r = inspectScene(ir, { profile: 'mobile-hero' });
    expect(r.profile).toBe('mobile-hero@1');
    expect(r.findings[0].severity).toBe('info');
    expect(r.summary).toMatch(/INFO topo\/open-edges/);
    expect(JSON.stringify(r.findings)).toBe(JSON.stringify(runPacks(ir, { profile: 'mobile-hero' }).findings));
  });

  it('is deterministic', () => {
    const doc = sceneDoc([{ name: 'a', mesh: cube(), translation: [0.1, 0, 0] }, { name: 'b', mesh: cube([2, 0, 0]) }]);
    expect(JSON.stringify(inspectScene(fromGltf(doc, { format: 'glb' })))).toBe(JSON.stringify(inspectScene(fromGltf(doc, { format: 'glb' }))));
  });

  it('reads the optimized Meshy hero in one pass, well under the inner-loop budget', async () => {
    const path = join(root, 'examples', 'veiled-guardian.web.glb');
    if (!existsSync(path)) return;
    const io = await createNodeIO();
    const ir = fromGltf(await io.readBinary(new Uint8Array(await readFile(path))), { format: 'glb', sourcePath: path });
    const t0 = performance.now();
    const r = inspectScene(ir);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(400);
    expect(r.topology).toMatchObject({ shells: 1, watertight: false });
    expect(r.scale.largest_dimension_m).toBeCloseTo(1.904, 2);
    expect(r.origin.at).toBe('center');
    expect(r.hierarchy.unapplied_transforms).toHaveLength(1); // mesh_node carries the 0.952 dequantization scale
    expect(r.hierarchy.unapplied_transforms[0].dequantization).toBe(true);
    expect(r.provenance.optimized).toBe(true);
    expect(r.summary).toMatch(/^1 mesh, 150,000 triangles, 1\.43 × 1\.90 × 1\.28 m, Y-up\. One shell, not watertight\. Origin at the bounding-box centre, 0\.95 m above the base\. 1 node: 1 quantized mesh node \(node transform is the encoding\)\. Front: unknown/);
    expect(r.summary).toMatch(/WARNING topo\/non-manifold: mesh has 152 non-manifold edges/);
  });
});
