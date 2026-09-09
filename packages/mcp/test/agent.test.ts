/**
 * Agent-feedback integration tests: feed every failure-mode fixture to the
 * tools an agent would call from the descriptions alone, and assert the
 * stable code + prim_path come back; validate every response against the
 * published schemas; time validate(quick) on a 50k-triangle asset.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { writeAgentFixtures } from '../../core/test/agent-fixtures.js';
import { createServer } from '../src/server.js';

type Diagnostic = { code: string; severity: string; prim_path: string; property?: string; message: string; suggested_fix?: string };
type Envelope = { ok: boolean; summary: string; duration_ms: number; errors: Diagnostic[]; data: Record<string, unknown> };
type Block = { type: string; text?: string; data?: string; mimeType?: string };
type Result = { content: Block[]; structuredContent?: Record<string, unknown>; isError?: boolean };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const schemasDir = join(root, 'schemas');
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validators = new Map<string, ReturnType<typeof ajv.compile>>();

let dir: string;
let fx: Record<string, string>;
let client: Client;

/** Call a tool, validate its envelope against schemas/<tool>.output.json, return it. */
async function call(name: string, args: Record<string, unknown>): Promise<Envelope & { image?: Block; raw: Result }> {
  const raw = (await client.callTool({ name, arguments: args })) as Result;
  if (raw.content[0].text?.startsWith('MCP error')) throw new Error(`${name}: ${raw.content[0].text}`);
  const env = JSON.parse(raw.content[0].text!) as Envelope;
  const file = join(schemasDir, `${name}.output.json`);
  if (!existsSync(file)) throw new Error(`${file} missing — run pnpm --filter @glbforge/mcp build (emits schemas/)`);
  let validate = validators.get(name);
  if (!validate) { validate = ajv.compile(JSON.parse(await readFile(file, 'utf8'))); validators.set(name, validate); }
  if (!raw.isError && !validate(env)) throw new Error(`${name} response violates ${file}: ${ajv.errorsText(validate.errors)}`);
  expect(env.summary.length).toBeGreaterThan(8);
  expect(env.duration_ms).toBeGreaterThanOrEqual(0);
  for (const d of env.errors) {
    expect(d.code).toMatch(/^[A-Z0-9_]+$/);
    expect(['error', 'warning', 'info']).toContain(d.severity);
    expect(typeof d.prim_path).toBe('string');
  }
  return { ...env, image: raw.content.find((b) => b.type === 'image'), raw };
}

const has = (env: Envelope, code: string, prim?: string | RegExp) => env.errors.some((d) => d.code === code && (prim === undefined || (prim instanceof RegExp ? prim.test(d.prim_path) : d.prim_path === prim)));
const find = (env: Envelope, code: string) => env.errors.find((d) => d.code === code);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'glbforge-agent-'));
  fx = await writeAgentFixtures(dir);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverSide);
  client = new Client({ name: 'agent-test', version: '0' });
  await client.connect(clientSide);
}, 120_000);

afterAll(async () => {
  await client.close();
  await rm(dir, { recursive: true, force: true });
});

describe('tool descriptions carry the contract', () => {
  it('every tool has an output schema, a description that says what it returns, and a published schema file', async () => {
    const tools = (await client.listTools()).tools;
    expect(tools.length).toBe(25);
    for (const t of tools) {
      expect(t.outputSchema, t.name).toBeDefined();
      expect((t.description ?? '').length, t.name).toBeGreaterThan(60);
      expect(existsSync(join(schemasDir, `${t.name}.output.json`)), `${t.name}.output.json`).toBe(true);
      expect(existsSync(join(schemasDir, `${t.name}.input.json`)), `${t.name}.input.json`).toBe(true);
    }
    const index = JSON.parse(await readFile(join(schemasDir, 'index.json'), 'utf8'));
    expect(Object.keys(index.tools).sort()).toEqual(tools.map((t) => t.name).sort());
    expect(existsSync(join(root, 'docs', 'error-codes.md'))).toBe(true);
  });
});

describe('failure-mode fixtures → code + prim_path', () => {
  it('missing default prim (usda)', async () => {
    const v = await call('validate', { path: fx['missing-default-prim.usda'] });
    expect(v.ok).toBe(true);
    expect(v.data.default_prim).toBeNull();
    expect(has(v, 'MISSING_DEFAULT_PRIM', '/')).toBe(true);
    expect(find(v, 'MISSING_DEFAULT_PRIM')!.property).toBe('defaultPrim');
    expect(find(v, 'MISSING_DEFAULT_PRIM')!.suggested_fix).toMatch(/defaultPrim/);
  });

  it('Z-up asset (usda)', async () => {
    const v = await call('validate', { path: fx['z-up.usda'] });
    expect(v.data.up_axis).toBe('Z');
    expect(has(v, 'UP_AXIS_Z', '/')).toBe(true);
    const g = await call('inspect_geometry', { path: fx['z-up.usda'] });
    expect(g.data.up_axis).toBe('Z');
    expect((g.data.world_bounding_box as { size: number[] }).size[2]).toBeCloseTo(1.8, 5);
  });

  it('centimetre-scale asset (usda and glb)', async () => {
    const v = await call('validate', { path: fx['centimeters.usda'] });
    expect(v.data.meters_per_unit).toBe(0.01);
    expect(has(v, 'METERS_PER_UNIT_NONSTANDARD', '/')).toBe(true);
    const g = await call('inspect_geometry', { path: fx['centimeters.usda'] });
    expect(g.data.largest_dimension_m).toBeCloseTo(0.005, 6);
    expect(has(g, 'SCALE_TOO_SMALL', '/Root')).toBe(true);
    expect((g.data.scale_warnings as string[]).length).toBe(1);
    const g2 = await call('inspect_geometry', { path: fx['centimeters.glb'] });
    expect(has(g2, 'SCALE_TOO_SMALL', '/Asset')).toBe(true);
    const g3 = await call('inspect_geometry', { path: fx['centimeters.glb'], small_scale: 0.001 });
    expect(has(g3, 'SCALE_TOO_SMALL')).toBe(false); // configurable threshold
  });

  it('skeleton with no bound mesh (usda and glb)', async () => {
    const a = await call('inspect_animation', { path: fx['skeleton-unbound.usda'] });
    expect(has(a, 'SKELETON_UNBOUND', '/Root/Skel')).toBe(true);
    expect(has(a, 'MESH_NOT_DEFORMING', '/Root/Skel')).toBe(true);
    const skel = (a.data.skeletons as Array<{ prim_path: string; bound_meshes: string[]; joint_count: number; animated: boolean }>)[0];
    expect(skel.bound_meshes).toEqual([]);
    expect(skel.joint_count).toBe(2);
    expect(skel.animated).toBe(true);
    expect(a.data.has_animation).toBe(true);
    expect(a.data.time_unit).toBe('timecodes');
    expect(a.data.time_code_range).toEqual([0, 24]);
    expect(a.data.duration_seconds).toBe(1);
    const b = await call('inspect_animation', { path: fx['skeleton-unbound.glb'] });
    expect(has(b, 'SKELETON_UNBOUND', '/Asset/Skel_0')).toBe(true);
    expect(has(b, 'MESH_NOT_DEFORMING')).toBe(true);
    expect(b.data.time_unit).toBe('seconds');
  });

  it('blend shape with no driver (usda and glb)', async () => {
    const a = await call('inspect_animation', { path: fx['blendshape-undriven.usda'] });
    expect(has(a, 'BLENDSHAPE_UNDRIVEN', '/Root/Face/smile')).toBe(true);
    const bs = (a.data.blend_shapes as Array<{ name: string; is_driven: boolean; target_mesh: string }>)[0];
    expect(bs.name).toBe('smile');
    expect(bs.is_driven).toBe(false);
    expect(bs.target_mesh).toBe('/Root/Face');
    const b = await call('inspect_animation', { path: fx['blendshape-undriven.glb'] });
    expect(has(b, 'BLENDSHAPE_UNDRIVEN', '/Asset/morpher_0/Prim_0/BlendShape_0_puff')).toBe(true);
    expect(b.data.has_animation).toBe(false);
  });

  it('texture with a broken path (usda and gltf)', async () => {
    const m = await call('inspect_materials', { path: fx['texture-broken.usda'] });
    expect(has(m, 'TEXTURE_UNRESOLVED', '/Root/Materials/Painted')).toBe(true);
    expect(find(m, 'TEXTURE_UNRESOLVED')!.severity).toBe('error');
    const missing = m.data.missing_textures as Array<{ material: string; input: string; path: string }>;
    expect(missing[0]).toMatchObject({ material: '/Root/Materials/Painted', input: 'baseColor', path: 'textures/does-not-exist.png' });
    expect((m.data.textures as Array<{ resolved: boolean }>)[0].resolved).toBe(false);
    const v = await call('validate', { path: fx['texture-broken.usda'] });
    expect(v.data.arkit_compatible).toBe(false);
    expect(has(v, 'TEXTURE_UNRESOLVED')).toBe(true);
    const g = await call('inspect_materials', { path: fx['texture-broken.gltf'] });
    expect(has(g, 'TEXTURE_UNRESOLVED', '/Asset/Materials/painted_0')).toBe(true);
    expect((g.data.missing_textures as Array<{ path: string }>)[0].path).toBe('textures/missing-albedo.png');
  });

  it('mesh with no material (usda and glb)', async () => {
    const m = await call('inspect_materials', { path: fx['mesh-no-material.usda'] });
    expect(has(m, 'MESH_NO_MATERIAL', '/Root/Bare')).toBe(true);
    expect(has(m, 'MATERIAL_UNBOUND', '/Root/Unused')).toBe(true);
    expect(m.data.unbound_meshes).toEqual(['/Root/Bare']);
    const g = await call('inspect_materials', { path: fx['mesh-no-material.glb'] });
    expect(has(g, 'MESH_NO_MATERIAL', '/Asset/bare_0/Prim_0')).toBe(true);
    expect(find(g, 'MESH_NO_MATERIAL')!.property).toBe('material:binding');
  });

  it('asset over the ios_ar triangle budget', async () => {
    const p = await call('analyze_performance', { path: fx['over-ios-ar-budget.glb'] });
    const check = p.data.budget_check as { profile: string; pass: boolean; overages: Array<{ metric: string; value: number; limit: number; worst_offender_prim_path: string }> };
    expect(check.profile).toBe('ios_ar');
    expect(check.pass).toBe(false);
    const over = check.overages.find((o) => o.metric === 'max_triangles')!;
    expect(over.value).toBe(115_200);
    expect(over.limit).toBe(100_000);
    expect(over.worst_offender_prim_path).toBe('/Asset/dense_0/Prim_0');
    expect(has(p, 'TRIANGLE_BUDGET_EXCEEDED', '/Asset/dense_0/Prim_0')).toBe(true);
    expect(find(p, 'TRIANGLE_BUDGET_EXCEEDED')!.suggested_fix).toMatch(/optimize_glb/);
    const custom = await call('analyze_performance', { path: fx['over-ios-ar-budget.glb'], profile: 'web', custom_limits: { max_triangles: 200_000 } });
    expect((custom.data.budget_check as { pass: boolean }).pass).toBe(true);
    const legacy = await call('analyze_performance', { path: fx['over-ios-ar-budget.glb'], profile: 'mobile-hero@1' });
    expect((legacy.data.budget_check as { profile: string; pass: boolean }).profile).toBe('mobile-hero@1');
  });
});

describe('validate', () => {
  it('quick mode on a 50k-triangle asset completes in under 1 s', async () => {
    await call('validate', { path: fx['fifty-k.glb'] }); // warm the codecs
    const t0 = performance.now();
    const v = await call('validate', { path: fx['fifty-k.glb'] });
    const wall = performance.now() - t0;
    expect(v.data.opens).toBe(true);
    expect(v.data.format).toBe('glb');
    expect(v.data.mode).toBe('quick');
    expect(v.duration_ms).toBeLessThan(1000);
    expect(wall).toBeLessThan(1000);
    expect(v.image).toBeUndefined();
  }, 20_000);

  it('full mode adds performance and a render', async () => {
    const v = await call('validate', { path: fx['mesh-no-material.glb'], mode: 'full', profile: 'ios_ar' });
    expect(v.data.performance).toBeDefined();
    expect((v.data.render as { camera: { fov: number } }).camera.fov).toBeGreaterThan(0);
    expect(v.image?.mimeType).toBe('image/png');
  }, 20_000);

  it('reports unreadable / unsupported inputs as ok:false with a code', async () => {
    const missing = await call('validate', { path: join(dir, 'nope.glb') });
    expect(missing.ok).toBe(false);
    expect(missing.raw.isError).toBe(true);
    expect(has(missing, 'FILE_NOT_FOUND')).toBe(true);
    const bad = await call('validate', { path: fx['quad.bin'] ?? join(dir, 'quad.bin') });
    expect(bad.ok).toBe(false);
    expect(has(bad, 'FORMAT_UNSUPPORTED')).toBe(true);
  });
});

describe('render', () => {
  it('turntable returns one contact sheet of N angles with every camera, deterministically', async () => {
    const a = await call('render', { path: fx['mesh-no-material.glb'], view: 'turntable', angles: 8, size: 96 });
    expect(a.data.width).toBe(96 * 4);
    expect(a.data.height).toBe(96 * 2);
    expect((a.data.cameras as unknown[]).length).toBe(8);
    expect((a.data.camera as { position: number[] }).position.length).toBe(3);
    const b = await call('render', { path: fx['mesh-no-material.glb'], view: 'turntable', angles: 8, size: 96 });
    expect(b.image!.data).toBe(a.image!.data);
    const front = await call('render', { path: fx['z-up.usda'], view: 'front', size: 64 });
    expect(front.data.width).toBe(64);
    expect(front.data.triangles).toBe(12);
    const custom = await call('render', { path: fx['mesh-no-material.glb'], view: 'custom', camera: { position: [0, 2, 3], fov: 30 }, size: 64 });
    expect((custom.data.camera as { position: number[]; fov: number })).toMatchObject({ position: [0, 2, 3], fov: 30 });
  }, 30_000);

  it('render_animation_strip tiles the requested frames and can write a GIF', async () => {
    const out = join(dir, 'strip.png');
    const s = await call('render_animation_strip', { path: fx['skeleton-unbound.glb'], frames: [0, 15, 30], size: 64, columns: 3, include_clip: true, out });
    expect((s.data.frames as Array<{ frame: number; time_seconds: number }>).map((f) => f.frame)).toEqual([0, 15, 30]);
    expect(s.data.width).toBe(64 * 3);
    expect((s.data.clip as { name: string }).name).toBe('wave');
    expect(s.image).toBeDefined();
    expect((await stat(out)).size).toBeGreaterThan(100);
    expect(s.data.clip_file).toMatch(/\.strip\.gif$/);
    expect((await stat(s.data.clip_file as string)).size).toBeGreaterThan(100);
    expect(has(s, 'CLIP_FORMAT_UNSUPPORTED')).toBe(true); // no mp4 with this stack, GIF written
    const usd = await call('render_animation_strip', { path: fx['skeleton-unbound.usda'], times: [0, 0.5, 1], size: 64 });
    expect((usd.data.frames as Array<{ frame: number }>).map((f) => f.frame)).toEqual([0, 12, 24]);
    const clamped = await call('render', { path: fx['skeleton-unbound.glb'], time: 9, size: 64 });
    expect(has(clamped, 'FRAME_OUT_OF_RANGE')).toBe(true);
  }, 30_000);
});

describe('mutating tools', () => {
  it('optimize_glb dry_run returns the diff and post_validation without writing; real run reports every silent change', async () => {
    const out = join(dir, 'dry.web.glb');
    const d = await call('optimize_glb', { path: fx['mesh-no-material.glb'], out, dry_run: true, preview: 'none', verify: false });
    expect(d.ok).toBe(true);
    expect(d.data.dry_run).toBe(true);
    expect(d.data.written).toBe(false);
    expect(existsSync(out)).toBe(false);
    expect(has(d, 'DRY_RUN')).toBe(true);
    const diff = d.data.diff as { changed_properties: Array<{ prim_path: string; property: string }>; summary: string };
    expect(diff.changed_properties.some((c) => c.prim_path === '/Asset' && c.property === 'file_size_bytes')).toBe(true);
    expect((d.data.post_validation as { opens: boolean; mode: string }).opens).toBe(true);
    expect(d.image).toBeUndefined();

    const r = await call('optimize_glb', { path: fx['blendshape-undriven.glb'], out: join(dir, 'real.web.glb'), targetTriangles: 20, render: true, preview: 'none' });
    expect(r.data.written).toBe(true);
    expect(existsSync(join(dir, 'real.web.glb'))).toBe(true);
    expect(has(r, 'MESH_WELDED')).toBe(true);
    expect(has(r, 'MESH_SIMPLIFIED')).toBe(true);
    expect(has(r, 'FIDELITY_MEASURED') || has(r, 'FIDELITY_BELOW_FLOOR')).toBe(true);
    expect(r.image).toBeDefined(); // render:true overrides preview:none
  }, 60_000);

  it('export_usdz validates its own output and reports export-time changes', async () => {
    const out = join(dir, 'rig.usdz');
    const e = await call('export_usdz', { path: fx['blendshape-undriven.glb'], out, preview: 'none' });
    expect(e.ok).toBe(true);
    const post = e.data.post_validation as { usdz_spec_compliant: boolean; arkit_compatible: boolean; format: string; default_prim: string };
    expect(post.format).toBe('usdz');
    expect(post.usdz_spec_compliant).toBe(true);
    expect(post.arkit_compatible).toBe(true);
    expect(post.default_prim).toBe('/Asset');
    expect(has(e, 'UV_FLIPPED')).toBe(true);
    const diff = e.data.diff as { added_prims: string[] };
    expect(diff.added_prims.some((p) => /BlendShape|bulge|puff/.test(p) || p.startsWith('/Asset'))).toBe(true);
    // The written usdz round-trips through every read-only tool.
    const v = await call('validate', { path: out });
    expect(v.data.opens).toBe(true);
    expect(v.data.crate_version).toBe('0.8.0');
    const a = await call('inspect_animation', { path: out });
    expect((a.data.blend_shapes as Array<{ name: string }>).map((b) => b.name)).toContain('puff_morpher_0_Prim_0');
    const dry = await call('export_usdz', { path: fx['mesh-no-material.glb'], out: join(dir, 'never.usdz'), dry_run: true, preview: 'none' });
    expect(existsSync(join(dir, 'never.usdz'))).toBe(false);
    expect(has(dry, 'DEFAULT_MATERIAL_BOUND', '/Asset/bare_0/Prim_0')).toBe(true);
  }, 60_000);

  it('export_stl reports the axis/scale conversion; extrude_image returns diff + post_validation', async () => {
    const s = await call('export_stl', { path: fx['mesh-no-material.glb'], out: join(dir, 'x.stl'), preview: 'none', dry_run: true });
    expect(has(s, 'AXIS_CONVERTED')).toBe(true);
    expect(has(s, 'SCALE_CONVERTED')).toBe(true);
    expect((s.data.post_validation as { format: string }).format).toBe('stl');
  }, 30_000);
});

describe('inspect_all', () => {
  it('merges validate + geometry + animation + materials + performance with deduplicated errors', async () => {
    const all = await call('inspect_all', { path: fx['skeleton-unbound.glb'], profile: 'ios_ar' });
    expect(Object.keys(all.data)).toEqual(['path', 'validation', 'geometry', 'animation', 'materials', 'performance', 'sha256']);
    expect(has(all, 'SKELETON_UNBOUND', '/Asset/Skel_0')).toBe(true);
    expect(has(all, 'NODE_ANIMATION_DROPPED') || has(all, 'MESH_NOT_DEFORMING')).toBe(true);
    const keys = all.errors.map((d) => `${d.code}|${d.prim_path}|${d.message}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(all.summary).toMatch(/skeleton/);
  }, 30_000);
});
