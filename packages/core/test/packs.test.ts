/**
 * Rule packs + welded-space topology: synthetic meshes with known answers,
 * profile-resolved severity, provenance-aware causes, the certainty
 * invariant, the diagnostic bridge, determinism, and a dogfood table over
 * every checked-in example asset so the linter and the pipeline cannot
 * drift apart silently.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document } from '@gltf-transform/core';
import {
  createNodeIO, detectProvenance, ERROR_CODES, findingToDiagnostic, fromGltf, getPack, getProfile, inspectGeometry, listRules, meshTopology, PACK_VERSIONS, packLabel,
  resolveRuleProfile, RULE_PROFILE_VERSIONS, runPacks, type RuleFinding, type SceneIR,
} from '../src/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** One triangle mesh in a Document. */
function meshDoc(positions: number[], indices: number[], name = 'mesh'): Document {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(positions)).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(indices)).setBuffer(buffer));
  const mesh = doc.createMesh(name).addPrimitive(prim);
  doc.createScene('scene').addChild(doc.createNode(name).setMesh(mesh));
  return doc;
}

/** Axis-aligned closed cube: 8 shared vertices, 12 triangles. */
function cube(offset = [0, 0, 0], size = 1): { positions: number[]; indices: number[] } {
  const p: number[] = [];
  for (let i = 0; i < 8; i++) p.push(offset[0] + (i & 1 ? size : 0), offset[1] + (i & 2 ? size : 0), offset[2] + (i & 4 ? size : 0));
  const faces = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  const idx: number[] = [];
  for (const [a, b, c, d] of faces) idx.push(a, b, c, a, c, d);
  return { positions: p, indices: idx };
}

/** Same cube with every face owning its own 4 vertices (24 verts) — how exporters split seams. */
function unweldedCube(): { positions: number[]; indices: number[] } {
  const { positions, indices } = cube();
  const p: number[] = [], idx: number[] = [];
  for (let t = 0; t < indices.length; t++) { const v = indices[t]; p.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]); idx.push(t); }
  return { positions: p, indices: idx };
}

/** n×n grid sheet: 2n² triangles, one boundary loop of 4n edges. */
function grid(n: number): { positions: number[]; indices: number[] } {
  const positions: number[] = [], indices: number[] = [];
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) positions.push(x, y, 0);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const a = y * (n + 1) + x, b = a + 1, c = a + n + 1, d = c + 1; indices.push(a, b, c, b, d, c); }
  return { positions, indices };
}

const concat = (...parts: Array<{ positions: number[]; indices: number[] }>) => {
  const positions: number[] = [], indices: number[] = [];
  for (const part of parts) {
    const base = positions.length / 3;
    for (const v of part.positions) positions.push(v); // no spread: parts can exceed the argument limit
    for (const i of part.indices) indices.push(i + base);
  }
  return { positions, indices };
};

const irOf = (doc: Document) => fromGltf(doc, { format: 'glb' });
/** Fake the optimizer's signature on an IR (the extension set is the only durable evidence). */
const asOptimized = (ir: SceneIR): SceneIR => ({ ...ir, extensions: { used: ['EXT_meshopt_compression', 'KHR_mesh_quantization', 'EXT_texture_webp'], required: [] } });
const topo = (parts: { positions: number[]; indices: number[] }) => meshTopology(irOf(meshDoc(parts.positions, parts.indices)).meshes[0])!;
const rulesFired = (findings: RuleFinding[]) => findings.map((f) => f.rule);
/** Run only the geometry pack (the scene pack has its own spec). */
const geo = (ir: SceneIR, opts: Parameters<typeof runPacks>[1] = {}) => runPacks(ir, { packs: ['core-geometry@1'], ...opts });
const topoOnly = (findings: RuleFinding[]) => findings.filter((f) => f.rule.startsWith('topo/'));
const withFin = (c: ReturnType<typeof cube>) => ({ positions: [...c.positions, 0.5, -1, 0], indices: [...c.indices, 0, 1, 8] });

describe('meshTopology (welded space)', () => {
  it('closed cube: watertight, one shell, no boundary', () => {
    const t = topo(cube());
    expect(t).toMatchObject({ boundaryEdges: 0, boundaryLoops: 0, nonManifoldEdges: 0, degenerateTriangles: 0, shells: 1, uniquePositions: 8, watertight: true });
    expect(t.shellTriangles).toEqual([12]);
  });

  it('seam-split cube welds back to the same answer (UV splits are not holes)', () => {
    expect(topo(unweldedCube())).toMatchObject({ boundaryEdges: 0, nonManifoldEdges: 0, shells: 1, uniquePositions: 8, watertight: true });
  });

  it('cube missing a face: one hole of four edges', () => {
    const c = cube();
    expect(topo({ positions: c.positions, indices: c.indices.slice(6) })).toMatchObject({ boundaryEdges: 4, boundaryLoops: 1, nonManifoldEdges: 0, shells: 1, watertight: false });
  });

  it('cube missing two opposite faces: two holes', () => {
    const c = cube();
    expect(topo({ positions: c.positions, indices: c.indices.slice(12) })).toMatchObject({ boundaryEdges: 8, boundaryLoops: 2, watertight: false });
  });

  it('two cubes in one primitive: two shells, still watertight', () => {
    const t = topo(concat(cube(), cube([3, 0, 0])));
    expect(t).toMatchObject({ shells: 2, boundaryEdges: 0, nonManifoldEdges: 0, watertight: true });
    expect(t.shellTriangles).toEqual([12, 12]);
  });

  it('a fin attached to a cube edge: one non-manifold edge, two open edges', () => {
    expect(topo(withFin(cube()))).toMatchObject({ nonManifoldEdges: 1, boundaryEdges: 2, boundaryLoops: 1, shells: 1, watertight: false });
  });

  it('degenerate triangles are counted and excluded from edges', () => {
    const c = cube();
    expect(topo({ positions: c.positions, indices: [...c.indices, 0, 0, 1, 2, 3, 2] })).toMatchObject({ degenerateTriangles: 2, boundaryEdges: 0, nonManifoldEdges: 0, watertight: true });
  });

  it('a grid sheet: one loop of 4n edges', () => {
    expect(topo(grid(20))).toMatchObject({ boundaryEdges: 80, boundaryLoops: 1, shells: 1, watertight: false });
  });

  it('large index space (> 65536 vertices) takes the four-pass radix path and stays exact', () => {
    const g = grid(300); // 90,601 vertices, 180,000 triangles
    expect(topo(g)).toMatchObject({ boundaryEdges: 1200, boundaryLoops: 1, nonManifoldEdges: 0, shells: 1 });
  });

  it('returns null for point / line / empty meshes', () => {
    expect(meshTopology(irOf(meshDoc([0, 0, 0, 1, 0, 0, 0, 1, 0], [])).meshes[0])).toBeNull();
  });
});

describe('core-geometry@1', () => {
  it('is registered, pinnable, and its rules are unique slash ids with alias codes in ERROR_CODES', () => {
    expect(packLabel(getPack('core-geometry'))).toBe('core-geometry@1');
    expect(getPack('core-geometry@1').version).toBe(1);
    expect(() => getPack('core-geometry@9')).toThrow(/no version 9/);
    expect(() => getPack('nope')).toThrow(/Unknown rule pack/);
    expect(PACK_VERSIONS['core-geometry'].map((p) => p.version)).toEqual([1]);
    const all = listRules().map((r) => r.id);
    expect(new Set(all).size).toBe(all.length);
    const rules = listRules([getPack('core-geometry@1')]);
    const ids = rules.map((r) => r.id);
    for (const r of rules) {
      expect(r.id).toMatch(/^[a-z]+\/[a-z0-9-]+$/);
      expect(r.code in ERROR_CODES).toBe(true);
      expect(['measured', 'heuristic']).toContain(r.certainty);
    }
    expect(ids).toEqual(['topo/open-edges', 'topo/non-manifold', 'topo/floating-fragments', 'topo/shells', 'topo/degenerate']);
  });

  it('a clean solid produces no findings', () => {
    const r = geo(irOf(meshDoc(cube().positions, cube().indices)));
    expect(r).toMatchObject({ profile: null, packs: ['core-geometry@1'], findings: [], skipped: [] });
    expect(r.provenance).toEqual({ optimized: false, forged: false, evidence: [] });
  });

  it('keeps the certainty invariant: measured messages carry only counts, every cause carries a confidence', () => {
    const debris = concat(grid(20), { positions: [50, 50, 50, 51, 50, 50, 50, 51, 50, 51, 51, 50], indices: [0, 1, 2, 1, 3, 2] });
    const fin = withFin(cube());
    const samples = [
      runPacks(irOf(meshDoc(debris.positions, debris.indices))),
      runPacks(irOf(meshDoc(fin.positions, fin.indices))),
      runPacks(asOptimized(irOf(meshDoc(fin.positions, fin.indices)))),
    ];
    for (const r of samples) for (const f of r.findings) {
      expect(f.certainty).toBe('measured');
      expect(f.confidence).toBeUndefined();
      expect(f.message).not.toMatch(/likely|probably|open sheet|artifact/i);
      expect(f.likely_cause).toBeDefined();
      expect(f.likely_cause!.confidence).toBeGreaterThan(0);
      expect(f.likely_cause!.confidence).toBeLessThanOrEqual(1);
      expect(f.default_severity).toBe(f.severity);
    }
  });

  it('open-edges: counts loops in the message, reads holes vs sheet in the cause', () => {
    const c = cube();
    const holes = geo(irOf(meshDoc(c.positions, c.indices.slice(12), 'lid')));
    expect(rulesFired(holes.findings)).toEqual(['topo/open-edges']);
    const f = holes.findings[0];
    expect(f).toMatchObject({ pack: 'core-geometry@1', code: 'TOPO_OPEN_EDGES', severity: 'warning', certainty: 'measured', prim_path: '/Asset/lid_0/Prim_0' });
    expect(f.message).toMatch(/2 boundary loops totalling 8 open edges/);
    expect(f.likely_cause!.text).toMatch(/Holes in a body/);
    expect(f.fix).toMatch(/Fill the holes/);
    expect(f.data).toMatchObject({ boundary_loops: 2, boundary_edges: 8 });

    const sheet = geo(irOf(meshDoc(grid(20).positions, grid(20).indices, 'sheet')));
    expect(sheet.findings[0].message).toMatch(/1 boundary loop totalling 80 open edges/);
    expect(sheet.findings[0].likely_cause).toMatchObject({ confidence: 0.8 });
    expect(sheet.findings[0].likely_cause!.text).toMatch(/open sheet/);
    expect(sheet.findings[0].fix).toMatch(/Solidify/);
  });

  it('shells vs floating fragments: a body with debris fires fragments, two equal parts fire shells only', () => {
    const debris = concat(grid(20), { positions: [50, 50, 50, 51, 50, 50, 50, 51, 50, 51, 51, 50], indices: [0, 1, 2, 1, 3, 2] });
    const r = geo(irOf(meshDoc(debris.positions, debris.indices, 'body')));
    expect(rulesFired(r.findings)).toEqual(['topo/open-edges', 'topo/floating-fragments', 'topo/shells']);
    const frag = r.findings.find((f) => f.rule === 'topo/floating-fragments')!;
    expect(frag.severity).toBe('warning');
    expect(frag.message).toMatch(/1 floating fragment of at most 2 triangles/);
    expect(frag.data).toMatchObject({ fragments: 1, shells: 2 });

    const two = concat(cube(), cube([3, 0, 0]));
    const r2 = geo(irOf(meshDoc(two.positions, two.indices, 'pair')));
    expect(rulesFired(r2.findings)).toEqual(['topo/shells']);
    expect(r2.findings[0]).toMatchObject({ severity: 'info', certainty: 'measured' });
    expect(r2.findings[0].message).toMatch(/2 separate pieces/);

    // Lower the threshold and the sliver becomes a "part".
    const r3 = geo(irOf(meshDoc(debris.positions, debris.indices, 'body')), { params: { 'core-geometry': { fragmentFraction: 0.001 } } });
    expect(rulesFired(r3.findings)).toEqual(['topo/open-edges', 'topo/shells']);
  });

  it('non-manifold: authoring cause by default, hedged simplification-artifact cause on optimizer output', () => {
    const fin = withFin(cube());
    const authored = geo(irOf(meshDoc(fin.positions, fin.indices, 'joined')));
    const nm = authored.findings.find((f) => f.rule === 'topo/non-manifold')!;
    expect(nm).toMatchObject({ code: 'MESH_NON_MANIFOLD', severity: 'warning' });
    expect(nm.message).toMatch(/1 non-manifold edge /);
    expect(nm.likely_cause!.text).toMatch(/boolean|join/i);
    expect(nm.data).toMatchObject({ optimized: false });

    // 1 pinched edge in 150k triangles after our optimizer: the cause says so, and says it is a proxy.
    const big = concat(grid(274), withFin(cube([1000, 0, 0])));
    const optimized = geo(asOptimized(irOf(meshDoc(big.positions, big.indices, 'hero'))));
    expect(optimized.provenance).toMatchObject({ optimized: true, evidence: ['EXT_meshopt_compression', 'KHR_mesh_quantization', 'EXT_texture_webp'] });
    const nm2 = optimized.findings.find((f) => f.rule === 'topo/non-manifold')!;
    expect(nm2.likely_cause!.text).toMatch(/simplification artifact rather than an authoring error/);
    expect(nm2.likely_cause!.text).toMatch(/proxy, not proof/);
    expect(nm2.likely_cause!.confidence).toBe(0.7);
    expect(nm2.fix).toMatch(/repair the source mesh/);
    expect(nm2.data).toMatchObject({ optimized: true });
  });

  it('provenance: meshopt alone is not enough; the pair is; a glbforge generator string is evidence', () => {
    const ir = irOf(meshDoc(cube().positions, cube().indices));
    expect(detectProvenance({ ...ir, extensions: { used: ['EXT_meshopt_compression'], required: [] } })).toMatchObject({ optimized: false, evidence: ['EXT_meshopt_compression'] });
    expect(detectProvenance({ ...ir, extensions: { used: ['KHR_mesh_quantization', 'EXT_meshopt_compression'], required: [] } }).optimized).toBe(true);
    expect(detectProvenance({ ...ir, generator: 'glbforge extrude' })).toMatchObject({ forged: true, optimized: false, evidence: ['generator "glbforge extrude"'] });
  });

  it('topology disabled: topology rules are reported as skipped, not silently absent', () => {
    const c = cube();
    const r = geo(irOf(meshDoc(c.positions, c.indices.slice(6))), { topology: false });
    expect(r.findings).toEqual([]);
    expect(r.skipped.map((s) => s.rule)).toEqual(listRules([getPack('core-geometry@1')]).map((x) => x.id));
    expect(r.skipped[0].reason).toMatch(/topology/);
  });

  it('bridges to envelope diagnostics with the alias code, the rule id, certainty and cause in data', () => {
    const c = cube();
    const r = runPacks(irOf(meshDoc(c.positions, c.indices.slice(6), 'lid')), { profile: 'mobile-hero' });
    const d = findingToDiagnostic(r.findings[0]);
    expect(d).toMatchObject({ code: 'TOPO_OPEN_EDGES', severity: 'info', prim_path: '/Asset/lid_0/Prim_0' });
    expect(d.suggested_fix).toBe(r.findings[0].fix);
    expect(d.data).toMatchObject({ rule: 'topo/open-edges', pack: 'core-geometry@1', certainty: 'measured', default_severity: 'warning', boundary_loops: 1, cause_confidence: 0.7 });
    expect(d.data!.likely_cause).toBe(r.findings[0].likely_cause!.text);
  });

  it('is deterministic', () => {
    const debris = concat(cube(), cube([3, 0, 0]), { positions: [9, 9, 9, 9.1, 9, 9, 9, 9.1, 9], indices: [0, 1, 2] });
    const doc = meshDoc(debris.positions, debris.indices);
    expect(JSON.stringify(runPacks(irOf(doc)))).toBe(JSON.stringify(runPacks(irOf(doc))));
  });

  it('inspectGeometry reports the same welded numbers as the pack engine', () => {
    const c = cube();
    const ir = irOf(meshDoc([...c.positions, 0.5, -1, 0], [...c.indices.slice(6), 0, 1, 8]));
    const g = inspectGeometry(ir).meshes[0];
    const t = meshTopology(ir.meshes[0])!;
    expect([g.boundary_edge_count, g.non_manifold_edge_count, g.degenerate_face_count, g.is_closed]).toEqual([t.boundaryEdges, t.nonManifoldEdges, t.degenerateTriangles, t.watertight]);
  });
});

describe('severity is the profile\'s call', () => {
  const fin = withFin(cube());
  const ir = () => irOf(meshDoc(fin.positions, fin.indices, 'joined'));

  it('pack defaults without a profile; authoring@1 keeps them', () => {
    const bare = runPacks(ir());
    const auth = runPacks(ir(), { profile: 'authoring' });
    expect(auth.profile).toBe('authoring@1');
    expect(auth.packs).toEqual(['core-geometry@1', 'core-scene@1']);
    expect(auth.findings.map((f) => [f.rule, f.severity])).toEqual(bare.findings.map((f) => [f.rule, f.severity]));
    expect(auth.findings.map((f) => [f.rule, f.severity])).toEqual([['topo/open-edges', 'warning'], ['topo/non-manifold', 'warning'], ['origin/not-at-base', 'info']]);
  });

  it('web budget profiles downgrade topology to info and keep the default visible', () => {
    for (const name of ['mobile-hero', 'desktop-hero@1', 'product-configurator']) {
      const r = runPacks(ir(), { profile: name });
      expect(r.profile).toMatch(/@1$/);
      expect(r.packs).toEqual(['core-geometry@1', 'core-scene@1']);
      expect(topoOnly(r.findings)).toHaveLength(2);
      for (const f of topoOnly(r.findings)) { expect(f.severity).toBe('info'); expect(f.default_severity).toBe('warning'); }
    }
    expect(getProfile('mobile-hero').rules?.severity?.['topo/non-manifold']).toBe('info');
  });

  it('profile objects and custom rule profiles resolve too', () => {
    const custom = resolveRuleProfile({ name: 'fdm-test', version: 1, description: 'print', packs: ['core-geometry@1'], severity: { 'topo/non-manifold': 'error', 'topo/open-edges': 'error' }, params: { 'core-geometry': { fragmentFraction: 0.05 } } });
    const r = runPacks(ir(), { profile: custom });
    expect(r.profile).toBe('fdm-test@1');
    expect(r.findings.map((f) => f.severity)).toEqual(['error', 'error']);
    expect(runPacks(ir(), { profile: getProfile('mobile-hero') }).findings.every((f) => f.severity === 'info')).toBe(true);
    expect(() => resolveRuleProfile('authoring@7')).toThrow(/no version 7/);
    expect(() => resolveRuleProfile('nope')).toThrow(/Unknown profile/);
    expect(RULE_PROFILE_VERSIONS.authoring.map((p) => p.version)).toEqual([1]);
  });
});

describe('dogfood: the pipeline\'s own outputs under the linter', () => {
  const load = async (rel: string) => {
    const path = join(root, rel);
    if (!existsSync(path)) return null;
    const io = await createNodeIO();
    return fromGltf(await io.readBinary(new Uint8Array(await readFile(path))), { format: 'glb' });
  };

  it('optimized Meshy hero: 152 non-manifold edges, no holes, 32 degenerate, one shell — attributed to the optimizer', async () => {
    const ir = await load('examples/veiled-guardian.web.glb');
    if (!ir) return;
    expect(meshTopology(ir.meshes[0])).toMatchObject({ nonManifoldEdges: 152, boundaryEdges: 0, boundaryLoops: 0, degenerateTriangles: 32, shells: 1, watertight: false });
    const r = runPacks(ir, { profile: 'authoring' });
    expect(r.provenance.optimized).toBe(true);
    expect(rulesFired(r.findings)).toEqual(['topo/non-manifold', 'topo/degenerate', 'origin/not-at-base']);
    expect(r.findings[0].likely_cause!.text).toMatch(/simplification artifact/);
    expect(runPacks(ir, { profile: 'mobile-hero' }).findings.map((f) => f.severity)).toEqual(['info', 'info', 'info']);
  });

  it('Hunyuan plush: a clean watertight solid, no findings', async () => {
    const ir = await load('examples/plush-hunyuan.glb');
    if (!ir) return;
    expect(meshTopology(ir.meshes[0])).toMatchObject({ nonManifoldEdges: 0, boundaryEdges: 0, degenerateTriangles: 0, shells: 1, watertight: true });
    expect(topoOnly(runPacks(ir).findings)).toEqual([]);
  });

  /**
   * Standing policy: every checked-in example is linted under authoring@1 and
   * the rule multiset is frozen here. A change in either the pipeline or a
   * rule shows up as a diff in this table and has to be argued for. Rows
   * marked OPT carry the optimizer signature.
   */
  const EXPECTED: Record<string, string> = {
    'boat-shipped.web.glb': 'floating-fragments shells origin/not-at-base',
    'dede-bevel-mcp.glb': 'open-edges shells origin/not-at-base',
    'dede-bevel.glb': 'open-edges origin/not-at-base',
    'dede-mcp-test.glb': 'origin/not-at-base',
    'dede-mcp-test.web.glb': 'origin/not-at-base',
    'dede-neon.glb': 'floating-fragments floating-fragments shells shells shells origin/not-at-base',
    'dede-v2.glb': 'floating-fragments floating-fragments shells shells shells origin/not-at-base',
    'dede.glb': 'origin/not-at-base',
    'guardian.web.glb': 'non-manifold degenerate origin/not-at-base',
    'guardian.web.lod1.glb': 'non-manifold floating-fragments shells degenerate origin/not-at-base',
    'guardian.web.lod2.glb': 'non-manifold floating-fragments shells degenerate origin/not-at-base',
    'lucky-cat.glb': 'origin/not-at-base',
    'lucky-cat.ktx2.glb': 'non-manifold origin/not-at-base',
    'lucky-cat.web.glb': 'non-manifold origin/not-at-base',
    'plush-hunyuan.glb': 'origin/not-at-base',
    'plush-hunyuan.web.glb': 'degenerate origin/not-at-base',
    'plushqlty-bevel.glb': 'origin/not-at-base',
    'plushqlty-layered.glb': 'floating-fragments floating-fragments floating-fragments shells shells shells shells origin/not-at-base',
    'plushqlty-plush.glb': 'floating-fragments floating-fragments floating-fragments shells shells shells shells origin/not-at-base',
    'plushqlty-plush.web.glb': 'open-edges non-manifold non-manifold non-manifold non-manifold floating-fragments floating-fragments floating-fragments shells shells shells shells degenerate degenerate origin/not-at-base',
    'plushqlty-v2.glb': 'floating-fragments floating-fragments floating-fragments shells shells shells shells origin/not-at-base',
    'plushqlty-v2.web.glb': 'non-manifold floating-fragments shells degenerate origin/not-at-base',
    'plushqlty.glb': 'origin/not-at-base',
    'smoke.glb': 'origin/not-at-base',
    'smoke.web.glb': 'non-manifold origin/not-at-base',
    'sneakercon.glb': 'origin/not-at-base',
    'sneakercon.web.glb': 'origin/not-at-base',
    'svg-test.glb': 'origin/not-at-base',
    'veiled-guardian.web.glb': 'non-manifold degenerate origin/not-at-base',
    'veiled-guardian.web.lod1.glb': 'non-manifold floating-fragments shells degenerate origin/not-at-base',
    'veiled-guardian.web.lod2.glb': 'non-manifold floating-fragments shells degenerate origin/not-at-base',
  };

  it('every checked-in example produces exactly the frozen finding set under authoring@1', async () => {
    const dir = join(root, 'examples');
    if (!existsSync(dir)) return;
    const files = (await readdir(dir)).filter((f) => f.endsWith('.glb')).sort();
    const actual: Record<string, string> = {};
    for (const f of files) {
      const ir = await load(`examples/${f}`);
      actual[f] = rulesFired(runPacks(ir!, { profile: 'authoring' }).findings).map((r) => r.replace('topo/', '')).join(' ');
      if (process.env.GLBFORGE_PRINT_DOGFOOD) console.log(`    '${f}': '${actual[f]}',`);
    }
    expect(actual).toEqual(EXPECTED);
  }, 60_000);
});
