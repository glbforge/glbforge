import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzePerformance, diffScenes, ERROR_CODES, fromGltf, fromUsd, inspectAnimation, inspectGeometry, inspectMaterials, poseScene,
  readUsda, readUsdc, readUsdz, renderErrorCodesMarkdown, renderScene, resolvePerformanceProfile, toUsdz, validateScene, walkPrims, writeUsdc, buildUsdLayer, frontRig,
  type SceneIR,
} from '../src/index.js';
import { makeRiggedCylinder } from './fixtures.js';
import { blendShapeUndriven, meshNoMaterial, skeletonNoBoundMesh, USDA_FIXTURES, USDA_SKELETON_UNBOUND, USDA_TEXTURE_BROKEN, centimeterScale } from './agent-fixtures.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('error code registry', () => {
  it('docs/error-codes.md is generated from ERROR_CODES (run pnpm --filter @glbforge/mcp build to refresh)', () => {
    const doc = readFileSync(join(root, 'docs', 'error-codes.md'), 'utf8');
    expect(doc).toBe(renderErrorCodesMarkdown());
    for (const code of Object.keys(ERROR_CODES)) expect(doc).toContain(`\`${code}\``);
  });

  it('every code has a severity, a meaning and a fix', () => {
    for (const [code, s] of Object.entries(ERROR_CODES)) {
      expect(code).toMatch(/^[A-Z0-9_]+$/);
      expect(['error', 'warning', 'info']).toContain(s.severity);
      expect(s.meaning.length, code).toBeGreaterThan(20);
      expect(s.fix.length, code).toBeGreaterThan(10);
    }
  });
});

describe('USD readers', () => {
  it('usda and usdc readers agree on the same layer (our writer → both encodings)', async () => {
    const doc = makeRiggedCylinder();
    const usda = await toUsdz(doc, { format: 'usda' });
    const usdc = await toUsdz(doc, { format: 'usdc' });
    const a = readUsdz(usda.usdz), c = readUsdz(usdc.usdz);
    expect(a.specCompliant).toBe(true);
    expect(c.specCompliant).toBe(true);
    const la = readUsda(new TextDecoder().decode(a.layer!.data));
    const lc = readUsdc(c.layer!.data);
    expect(lc.crateVersion).toBe('0.8.0');
    expect(la.primCount).toBe(lc.primCount);
    const pathsA = [...walkPrims(la.prims)].map((p) => `${p.typeName}:${p.path}`);
    const pathsC = [...walkPrims(lc.prims)].map((p) => `${p.typeName}:${p.path}`);
    expect(pathsA).toEqual(pathsC);
    // Values round-trip: points, joint indices, time samples.
    const meshA = [...walkPrims(la.prims)].find((p) => p.typeName === 'Mesh')!;
    const meshC = [...walkPrims(lc.prims)].find((p) => p.path === meshA.path)!;
    const pa = meshA.properties.find((p) => p.name === 'points')!.value as Float32Array;
    const pc = meshC.properties.find((p) => p.name === 'points')!.value as Float32Array;
    expect(pa.length).toBe(pc.length);
    for (let i = 0; i < pa.length; i += 97) expect(pa[i]).toBeCloseTo(pc[i], 5);
    const animA = [...walkPrims(la.prims)].find((p) => p.typeName === 'SkelAnimation')!;
    const animC = [...walkPrims(lc.prims)].find((p) => p.typeName === 'SkelAnimation')!;
    const rotA = animA.properties.find((p) => p.name === 'rotations')!.timeSamples!;
    const rotC = animC.properties.find((p) => p.name === 'rotations')!.timeSamples!;
    expect(rotA.times).toEqual(rotC.times);
    expect(Array.from(rotA.values[30] as Float32Array).map((x) => +x.toFixed(4))).toEqual(Array.from(rotC.values[30] as Float32Array).map((x) => +x.toFixed(4)));
  });

  it('reads Pixar-style usda: metadata, list ops, references, variants, dictionaries, faceVarying primvars', () => {
    const layer = readUsda(`#usda 1.0
(
    defaultPrim = "Root"
    metersPerUnit = 0.01
    subLayers = [@base.usda@]
    upAxis = "Z"
)

def Xform "Root" (
    customData = { string note = "hi"; int n = 3 }
    prepend references = @./other.usda@</Other>
    variants = { string lod = "high" }
    prepend variantSets = "lod"
    kind = "component"
)
{
    variantSet "lod" = {
        "high" { def Mesh "Extra" { } }
        "low" { }
    }
    double3 xformOp:translate = (1, 2, 3)
    uniform token[] xformOpOrder = ["xformOp:translate"]

    def Mesh "Grid" (
        prepend apiSchemas = ["MaterialBindingAPI"]
    )
    {
        point3f[] points = [(0,0,0), (1,0,0), (1,1,0), (0,1,0)]
        int[] faceVertexCounts = [4]
        int[] faceVertexIndices = [0, 1, 2, 3]
        texCoord2f[] primvars:st = [(0,0), (1,0), (1,1), (0,1)] (
            interpolation = "faceVarying"
        )
        quatf xformOp:orient = (1, 0, 0, 0)
        rel material:binding = </Root/Mat>
    }
    def Material "Mat" { }
}
`);
    expect(layer.meta.defaultPrim).toBe('Root');
    expect(layer.meta.metersPerUnit).toBe(0.01);
    expect(layer.meta.upAxis).toBe('Z');
    const rootPrim = layer.prims[0];
    expect(rootPrim.arcs).toEqual(expect.arrayContaining([expect.stringMatching(/references: \.\/other\.usda<\/Other>/), 'variantSet: lod']));
    expect(rootPrim.arcs.filter((a) => a === 'variantSet: lod').length).toBe(1);
    expect((rootPrim.meta.customData as { note: string; n: number })).toEqual({ note: 'hi', n: 3 });
    expect(rootPrim.children.map((c) => c.name)).toEqual(['Grid', 'Mat']); // variant content is not composed
    const grid = rootPrim.children[0];
    expect(grid.apiSchemas).toEqual(['MaterialBindingAPI']);
    expect(grid.properties.find((p) => p.name === 'primvars:st')!.meta.interpolation).toBe('faceVarying');
    expect(Array.from(grid.properties.find((p) => p.name === 'xformOp:orient')!.value as number[])).toEqual([0, 0, 0, 1]); // (w,x,y,z) text → (x,y,z,w)
    expect(grid.properties.find((p) => p.name === 'material:binding')!.targets).toEqual(['/Root/Mat']);
    const ir = fromUsd(layer, { format: 'usda', layerName: 'test.usda' });
    expect(ir.upAxis).toBe('Z');
    expect(ir.metersPerUnit).toBe(0.01);
    expect(ir.layerStack).toEqual(expect.arrayContaining(['test.usda', 'subLayer: base.usda']));
    expect(ir.diagnostics.filter((d) => d.code === 'UNRESOLVED_COMPOSITION_ARC').length).toBeGreaterThanOrEqual(3);
    expect(ir.meshes[0].vertexCount).toBe(4); // faceVarying st on a single quad unwelds to 4 corners
    expect(ir.meshes[0].material).toBe(0);
    expect(ir.nodes[0].translation).toEqual([1, 2, 3]);
  });
});

describe('inspectors on the built-in rig', () => {
  it('sees the skeleton, the driven blend shape, and poses the clip', async () => {
    const doc = makeRiggedCylinder();
    const ir = fromGltf(doc, { format: 'glb' });
    const a = inspectAnimation(ir);
    expect(a.has_animation).toBe(true);
    expect(a.skeletons[0]).toMatchObject({ prim_path: '/Asset/Skel_0', joint_count: 2, max_influences_per_vertex: 2, unbound_vertex_count: 0, animated: true });
    expect(a.skeletons[0].bound_meshes).toEqual(['/Asset/tube_2/Prim_0']);
    expect(a.blend_shapes[0]).toMatchObject({ name: 'bulge', is_driven: true, target_mesh: '/Asset/tube_2/Prim_0' });
    expect(a.diagnostics.map((d) => d.code)).not.toContain('BLENDSHAPE_UNDRIVEN');
    expect(a.diagnostics.map((d) => d.code)).not.toContain('SKELETON_UNBOUND');
    // Posing: at t=1 the upper joint is rotated 90° about Z; the top ring moves off the axis.
    const rest = poseScene(ir);
    const posed = poseScene(ir, { time: 1 });
    const top = ir.meshes[0].vertexCount - 1;
    expect(rest.meshes[0].positions[top * 3 + 1]).toBeCloseTo(2, 4);
    expect(Math.abs(posed.meshes[0].positions[top * 3 + 1] - rest.meshes[0].positions[top * 3 + 1])).toBeGreaterThan(0.5);
    // The blend shape weight peaks (1.0) at 0.5 s and is back to 0 at 1 s.
    const mid = poseScene(ir, { time: 0.5 });
    expect(mid.weights.get(ir.meshes[0].node)![0]).toBeCloseTo(1, 5);
    expect(posed.weights.get(ir.meshes[0].node)![0]).toBeCloseTo(0, 5);
    expect(poseScene(ir, { time: 0.25 }).weights.get(ir.meshes[0].node)![0]).toBeCloseTo(0.5, 5);
    // Rendering the posed scene is deterministic and covers pixels.
    const r1 = await renderScene(ir, { cameras: frontRig(), size: 64, time: 1 });
    const r2 = await renderScene(ir, { cameras: frontRig(), size: 64, time: 1 });
    expect(Buffer.from(r1.views[0].rgba).equals(Buffer.from(r2.views[0].rgba))).toBe(true);
    expect(r1.views[0].mask.reduce((s, v) => s + v, 0)).toBeGreaterThan(100);
  });

  it('geometry / materials / performance report paths and thresholds', () => {
    const ir = fromGltf(centimeterScale(), { format: 'glb', fileBytes: 1234 });
    const g = inspectGeometry(ir);
    expect(g.meshes[0].prim_path).toBe('/Asset/tiny_0/Prim_0');
    expect(g.meshes[0].is_manifold).toBe(true);
    expect(g.meshes[0].normals).toBe('authored');
    expect(g.diagnostics.map((d) => d.code)).toContain('SCALE_TOO_SMALL');
    expect(inspectGeometry(ir, { smallScale: 0.001 }).diagnostics.map((d) => d.code)).not.toContain('SCALE_TOO_SMALL');
    const m = inspectMaterials(ir);
    expect(m.materials[0].bound_meshes).toEqual(['/Asset/tiny_0/Prim_0']);
    const p = analyzePerformance(ir, resolvePerformanceProfile('ios_ar'));
    expect(p.budget_check.pass).toBe(true);
    expect(p.file_size_bytes).toBe(1234);
    expect(() => resolvePerformanceProfile('nope')).toThrow(/Unknown performance profile/);
  });

  it('validate flags AR Quick Look problems and the diff sees mutations', async () => {
    const before = fromGltf(skeletonNoBoundMesh(), { format: 'glb' });
    const v = validateScene(before);
    expect(v.opens).toBe(true);
    expect(v.arkit_compatible).toBe(true);
    // A clip on a plain (non-joint) node cannot be carried by UsdSkel → reported, not dropped silently.
    const nodeAnim = meshNoMaterial();
    const buffer = nodeAnim.getRoot().listBuffers()[0];
    const sampler = nodeAnim.createAnimationSampler()
      .setInput(nodeAnim.createAccessor().setType('SCALAR').setArray(new Float32Array([0, 1])).setBuffer(buffer))
      .setOutput(nodeAnim.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 0, 1, 0])).setBuffer(buffer));
    nodeAnim.createAnimation('slide').addSampler(sampler).addChannel(nodeAnim.createAnimationChannel().setTargetNode(nodeAnim.getRoot().listNodes()[0]).setTargetPath('translation').setSampler(sampler));
    expect(validateScene(fromGltf(nodeAnim, { format: 'glb' })).diagnostics.map((d) => d.code)).toContain('NODE_ANIMATION_DROPPED');
    const after = fromGltf(blendShapeUndriven(), { format: 'glb' });
    const d = diffScenes(before, after);
    expect(d.removed_prims).toContain('/Asset/Skel_0');
    expect(d.added_prims).toContain('/Asset/morpher_0/Prim_0');
    expect(d.removed_prims).toContain('/Asset/Animations/wave_0');
    expect(d.summary).toMatch(/^2 prim\(s\) added, 4 removed/);
  });

  it('USD fixtures produce the expected codes through fromUsd', () => {
    const skel = fromUsd(readUsda(USDA_SKELETON_UNBOUND), { format: 'usda' });
    expect(inspectAnimation(skel).diagnostics.map((d) => `${d.code}@${d.prim_path}`)).toContain('SKELETON_UNBOUND@/Root/Skel');
    const tex = fromUsd(readUsda(USDA_TEXTURE_BROKEN), { format: 'usda', resolveAsset: () => null });
    expect(inspectMaterials(tex).diagnostics.map((d) => `${d.code}@${d.prim_path}`)).toContain('TEXTURE_UNRESOLVED@/Root/Materials/Painted');
    for (const text of Object.values(USDA_FIXTURES)) expect(() => readUsda(text)).not.toThrow();
  });

  it('crate reader handles our own writer output for every value type the exporter emits', () => {
    const doc = makeRiggedCylinder();
    const { layer } = buildUsdLayer(doc, new Map(), { warnings: [] });
    const bytes = writeUsdc(layer);
    const back = readUsdc(bytes);
    const skelAnim = [...walkPrims(back.prims)].find((p) => p.typeName === 'SkelAnimation')!;
    expect(skelAnim.properties.find((p) => p.name === 'scales')!.typeName).toBe('half3[]');
    const scales = skelAnim.properties.find((p) => p.name === 'scales')!.timeSamples!.values[0] as Float32Array;
    expect(Array.from(scales)).toEqual([1, 1, 1, 1, 1, 1]);
    const ir: SceneIR = fromUsd(back, { format: 'usdc' });
    expect(ir.skins.length).toBe(1);
    expect(ir.meshes[0].joints).not.toBeNull();
    expect(ir.animations[0].channels.length).toBeGreaterThan(0);
  });
});
