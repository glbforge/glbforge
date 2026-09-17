import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createNodeIO, extrudeImage, getProfile, profileLabel } from '@glbforge/core';
import { createServer } from '../src/server.js';

type Block = { type: string; text?: string; data?: string; mimeType?: string };
type Result = { content: Block[]; structuredContent?: Record<string, unknown>; isError?: boolean };

let dir: string;
let glb: string;
let client: Client;

const envelope = (r: Result) => JSON.parse(r.content[0].text!);
const parse = (r: Result) => envelope(r).data;
const image = (r: Result) => r.content.find((b) => b.type === 'image');

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'glbforge-mcp-'));
  const sharp = (await import('sharp')).default;
  const size = 96;
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const r = Math.hypot(x - 48, y - 48);
    if (r < 36 && r > 14) {
      const i = (y * size + x) * 4;
      rgba[i] = 220; rgba[i + 1] = 60; rgba[i + 2] = 90; rgba[i + 3] = 255;
    }
  }
  const png = await sharp(rgba, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
  await writeFile(join(dir, 'ring.png'), png);
  // A subject on a plain ground with no alpha of its own: the case matte exists
  // for, and the only input that exercises the matte reply shapes.
  const opaque = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    const inside = Math.hypot(x - 48, y - 48) < 30;
    opaque[i] = inside ? 30 : 240; opaque[i + 1] = inside ? 90 : 240;
    opaque[i + 2] = inside ? 200 : 240; opaque[i + 3] = 255;
  }
  await writeFile(join(dir, 'blob.png'), await sharp(opaque, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer());
  const { doc } = await extrudeImage(new Uint8Array(png), { pillow: 0.04 });
  glb = join(dir, 'ring.glb');
  await writeFile(glb, await (await createNodeIO()).writeBinary(doc));

  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverSide);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
}, 60_000);

afterAll(async () => {
  await client.close();
  await rm(dir, { recursive: true, force: true });
});

describe('agent-friendly MCP surface', () => {
  it('lists every tool with the preview/drill-down surface', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'analyze_glb', 'analyze_performance', 'audit_directory', 'capabilities', 'compare_glb', 'diff', 'export_stl', 'export_usdz', 'extrude_image', 'generate_image_to_3d',
      'generation_status', 'inspect', 'inspect_all', 'inspect_animation', 'inspect_geometry', 'inspect_materials', 'inspect_report', 'list_profiles', 'meshy_create_task', 'meshy_download',
      'meshy_task_status', 'optimize_glb', 'render', 'render_animation_strip', 'render_preview', 'ship_asset', 'validate',
    ]);
  });

  it('analyze_glb returns a compact card, structuredContent, and a thumbnail', async () => {
    const r = (await client.callTool({ name: 'analyze_glb', arguments: { path: glb } })) as Result;
    const card = parse(r);
    expect(card.score).toBeTypeOf('number');
    expect(card.verdict).toMatch(/budget/);
    expect(card.drillDown.tool).toBe('inspect_report');
    expect(card.textures).toBeTypeOf('number'); // count, not the per-texture table
    expect((r.structuredContent?.data as { score: number }).score).toBe(card.score);
    const env = envelope(r);
    expect(env.ok).toBe(true);
    expect(env.summary).toMatch(/score \d+\/100/);
    expect(env.duration_ms).toBeTypeOf('number');
    expect(Array.isArray(env.errors)).toBe(true);
    expect(r.content[0].text!.length).toBeLessThan(6000);
    const img = image(r)!;
    expect(img.mimeType).toBe('image/png');
    expect(Buffer.from(img.data!, 'base64').subarray(1, 4).toString()).toBe('PNG');
  }, 30_000);

  it('preview=none drops the image', async () => {
    const r = (await client.callTool({ name: 'analyze_glb', arguments: { path: glb, preview: 'none' } })) as Result;
    expect(image(r)).toBeUndefined();
  });

  it('inspect_report drills into sections and filters findings', async () => {
    const topo = parse((await client.callTool({ name: 'inspect_report', arguments: { path: glb, section: 'topology' } })) as Result);
    expect(topo.topology.boundaryEdges).toBe(0);
    const tex = parse((await client.callTool({ name: 'inspect_report', arguments: { path: glb, section: 'textures' } })) as Result);
    expect(Array.isArray(tex.textures)).toBe(true);
    const errs = parse((await client.callTool({ name: 'inspect_report', arguments: { path: glb, severity: 'error' } })) as Result);
    expect(errs.findings.every((f: { severity: string }) => f.severity === 'error')).toBe(true);
    const all = parse((await client.callTool({ name: 'inspect_report', arguments: { path: glb, section: 'all' } })) as Result);
    expect(all.geometry.primitives).toBeDefined();
  }, 30_000);

  it('optimize_glb reports measured fidelity and previews the output', async () => {
    const out = join(dir, 'ring.web.glb');
    const r = (await client.callTool({ name: 'optimize_glb', arguments: { path: glb, out, targetTriangles: 3000 } })) as Result;
    const res = parse(r);
    expect(res.outPath).toBe(out);
    expect(res.fidelity.geometricBound).toBeGreaterThanOrEqual(0);
    expect(res.fidelity.ssimMin).toBeGreaterThan(0.5);
    expect(res.fidelity.passed).toBeTypeOf('boolean');
    expect(res.after.visualFidelity.ssimMin).toBe(res.fidelity.ssimMin);
    expect(image(r)).toBeDefined();
  }, 60_000);

  it('render_preview returns a deterministic 2x2 turntable and can save it', async () => {
    const out = join(dir, 'turn.png');
    const a = (await client.callTool({ name: 'render_preview', arguments: { path: glb, size: 128, out } })) as Result;
    const b = (await client.callTool({ name: 'render_preview', arguments: { path: glb, size: 128 } })) as Result;
    expect(parse(a).views).toEqual(['verify_45', 'verify_135', 'verify_225', 'verify_315']);
    expect(parse(a).width).toBe(256);
    expect(image(a)!.data).toBe(image(b)!.data);
    expect(parse(a).out).toBe(out);
  }, 30_000);

  it('advertises annotations so clients can auto-approve read-only tools', async () => {
    const tools = (await client.listTools()).tools;
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations as { readOnlyHint?: boolean } | undefined]));
    expect(byName.analyze_glb?.readOnlyHint).toBe(true);
    expect(byName.inspect_report?.readOnlyHint).toBe(true);
    expect(byName.optimize_glb?.readOnlyHint).toBe(false);
    expect(byName.generate_image_to_3d?.readOnlyHint).toBe(false);
  });

  it('capabilities reports providers, ktx2, versions, and profiles', async () => {
    const c = parse((await client.callTool({ name: 'capabilities', arguments: {} })) as Result);
    expect(c.versions.mcp).toMatch(/^\d+\./);
    expect(c.versions.core).toMatch(/^\d+\./);
    expect(typeof c.generation.fal.available).toBe('boolean');
    expect(typeof c.ktx2.available).toBe('boolean');
    expect(c.profiles).toContain(profileLabel(getProfile('mobile-hero'))); // latest version, whichever it is
  });

  it('compare_glb scores two files and returns a comparison sheet', async () => {
    const out = join(dir, 'ring-cmp.web.glb');
    await client.callTool({ name: 'optimize_glb', arguments: { path: glb, out, targetTriangles: 400, preview: 'none' } });
    const r = (await client.callTool({ name: 'compare_glb', arguments: { reference: glb, candidate: out, size: 128, geometry: true } })) as Result;
    const res = parse(r);
    expect(res.visual.ssimMin).toBeLessThan(1);
    expect(res.visual.threshold).toBeGreaterThan(0.9);
    expect(res.geometry.chamfer).toBeGreaterThanOrEqual(0);
    expect(res.sheet.views).toHaveLength(3);
    expect(res.visual.rendered).toBeUndefined();
    const img = image(r)!;
    const png = Buffer.from(img.data!, 'base64');
    expect(png.readUInt32BE(16)).toBe(128 * 3); // PNG IHDR width: three panels
  }, 60_000);

  it('optimize_glb returns hashes, honors every error in the card, and sends the comparison sheet on failure', async () => {
    const out = join(dir, 'ring-fail.web.glb');
    const r = (await client.callTool({ name: 'optimize_glb', arguments: { path: glb, out, targetTriangles: 120, compress: false } })) as Result;
    const res = parse(r);
    expect(res.sha256).toMatch(/^[0-9a-f]{64}$/);
    if (!res.fidelity.passed) {
      const png = Buffer.from(image(r)!.data!, 'base64');
      expect(png.readUInt32BE(16)).toBe(256 * 3);
      expect(res.after.topFindings.some((f: { ruleId: string }) => f.ruleId === 'fidelity/perceptual' || f.severity === 'error')).toBe(true);
    }
    const again = parse((await client.callTool({ name: 'optimize_glb', arguments: { path: glb, out, targetTriangles: 120, compress: false, preview: 'none' } })) as Result);
    expect(again.sha256).toBe(res.sha256); // deterministic
  }, 60_000);

  it('list_profiles is compact and carries the SSIM floor', async () => {
    const r = parse((await client.callTool({ name: 'list_profiles', arguments: {} })) as Result);
    expect(r.profiles.map((p: { name: string }) => p.name)).toContain('mobile-hero');
    expect(r.profiles[0].minSsim).toBeGreaterThan(0.9);
    expect(r.profiles[0].pin).toMatch(/^mobile-hero@\d+$/);
    expect(r.profiles[0].rationale).toBeUndefined();
    const full = parse((await client.callTool({ name: 'list_profiles', arguments: { rationale: true } })) as Result);
    expect(full.profiles[0].rationale.minSsim).toMatch(/fixed-camera/);
    const pinned = (await client.callTool({ name: 'analyze_glb', arguments: { path: glb, profile: 'mobile-hero@1', preview: 'none' } })) as Result;
    expect(parse(pinned).profileVersion).toBe(1);
  });

  it('extrude_image and export_stl return thumbnails and next actions', async () => {
    const out = join(dir, 'forged.glb');
    const r = (await client.callTool({ name: 'extrude_image', arguments: { path: join(dir, 'ring.png'), out, layers: 2 } })) as Result;
    expect(parse(r).nextActions[0].tool).toBe('analyze_glb');
    expect(image(r)).toBeDefined();
    const stl = (await client.callTool({ name: 'export_stl', arguments: { path: out, out: join(dir, 'forged.stl'), preview: 'turntable' } })) as Result;
    expect(parse(stl).watertight).toBe(true);
    expect(image(stl)).toBeDefined();
    const usdz = (await client.callTool({ name: 'export_usdz', arguments: { path: out, out: join(dir, 'forged.usdz'), preview: 'none' } })) as Result;
    expect(parse(usdz).files[0].name).toBe('model.usdc');
    expect(parse(usdz).textures).toBeGreaterThan(0);
  }, 60_000);

  it('says it folded a solid texture, and stops calling the result a defect', async () => {
    // prune folds a single-colour base-color texture into the material factor
    // and the UV set goes with it — free and invisible (SSIM ~1.0). Every other
    // thing the pipeline does on its own carries a code; this one carried none,
    // and the only trace was a UV_MISSING *warning* on our own output telling
    // the reader it "cannot be textured as-is" and to go run a texture stage.
    const out = join(dir, 'folded.web.glb');
    const r = (await client.callTool({
      name: 'optimize_glb', arguments: { path: glb, out, preview: 'none' },
    })) as Result;
    const errors = envelope(r).errors as Array<{ code: string; severity: string }>;
    const folded = errors.find((e) => e.code === 'TEXTURES_FOLDED');
    expect(folded, 'the fold is reported with a code').toBeDefined();
    expect(folded!.severity).toBe('info');
    for (const uv of errors.filter((e) => e.code === 'UV_MISSING')) {
      expect(uv.severity).toBe('info');
    }
  }, 60_000);

  it('matte_preview answers with the cut, not a forge', async () => {
    // It writes no file, so it has no out/diff/post_validation: a data shape the
    // forge schema does not describe. Validated clients reject the whole reply
    // when the schema does not admit it, which made the preview unreachable.
    const r = (await client.callTool({
      name: 'extrude_image',
      arguments: { path: join(dir, 'blob.png'), out: join(dir, 'unused.glb'), matte: 'auto', matte_preview: true },
    })) as Result;
    const d = parse(r);
    expect(envelope(r).ok).toBe(true);
    expect(d.preview_only).toBe(true);
    expect(d.written).toBe(false);
    expect(d.matte.usable).toBe(true);
    expect(d.matte.ladder.length).toBeGreaterThan(1);
    expect(image(r)).toBeDefined();
  }, 60_000);

  it('a matte forge reports the cut without shipping the mask', async () => {
    // core hands back the mask itself — one byte per traced pixel. In-process
    // that is the point; over MCP it is a quarter-million numbers of JSON that
    // an agent cannot read and must pay for. The numbers travel, the pixels do not.
    const r = (await client.callTool({
      name: 'extrude_image',
      arguments: { path: join(dir, 'blob.png'), out: join(dir, 'matted.glb'), matte: 'auto', preview: 'none' },
    })) as Result;
    const d = parse(r);
    expect(d.written).toBe(true);
    expect(d.mode).toBe('matte');
    expect(d.matte.confidence).toBeGreaterThan(0.4);
    expect(d.matte).not.toHaveProperty('alpha');
    expect(JSON.stringify(d).length).toBeLessThan(8000);
  }, 60_000);
});
