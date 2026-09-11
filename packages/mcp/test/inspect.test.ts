/**
 * The `inspect` tool: the edit-loop read. Envelope + schema validation,
 * rule findings mirrored into errors[] with alias codes, profile-resolved
 * severity, topology-off honesty, and the descriptions that route agents
 * to it after every edit.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

type Diagnostic = { code: string; severity: string; prim_path: string; message: string; suggested_fix?: string; data?: Record<string, unknown> };
type Envelope = { ok: boolean; summary: string; duration_ms: number; errors: Diagnostic[]; data: Record<string, unknown> };
type Result = { content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validators = new Map<string, ReturnType<typeof ajv.compile>>();

let dir: string;
let fx: Record<string, string>;
let client: Client;

async function call(name: string, args: Record<string, unknown>): Promise<Envelope> {
  const raw = (await client.callTool({ name, arguments: args })) as Result;
  const env = JSON.parse(raw.content[0].text!) as Envelope;
  const file = join(root, 'schemas', `${name}.output.json`);
  if (!existsSync(file)) throw new Error(`${file} missing — run pnpm --filter @glbforge/mcp build (emits schemas/)`);
  let validate = validators.get(name);
  if (!validate) { validate = ajv.compile(JSON.parse(await readFile(file, 'utf8'))); validators.set(name, validate); }
  if (!raw.isError && !validate(env)) throw new Error(`${name} response violates ${file}: ${ajv.errorsText(validate.errors)}`);
  return env;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'glbforge-inspect-'));
  fx = await writeAgentFixtures(dir);
  const server = createServer();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
});
afterAll(async () => { await client.close(); await rm(dir, { recursive: true, force: true }); });

describe('inspect', () => {
  it('is described as the after-every-edit call, and the overlapping tools point at it', async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.inspect.description).toMatch(/after EVERY edit/);
    expect(byName.inspect.annotations?.readOnlyHint).toBe(true);
    expect(byName.inspect_geometry.description).toMatch(/call `inspect`/);
    expect(byName.inspect_all.description).toMatch(/call `inspect` instead/);
    expect(tools.length).toBe(26);
  });

  it('reads a centimetre-scale sheet: measured facts, a scale/too-small finding with cause + fix, mirrored into errors[]', async () => {
    const env = await call('inspect', { path: fx['centimeters.glb'] });
    expect(env.ok).toBe(true);
    expect(env.duration_ms).toBeLessThan(1000);
    const d = env.data as { profile: string; packs: string[]; summary: string; topology: { shells: number; watertight: boolean }; scale: { largest_dimension_m: number; plausibility: string }; orientation: { front: string }; findings: Array<{ rule: string; severity: string; certainty: string; likely_cause: { confidence: number }; fix: string }>; sha256: string };
    expect(d.profile).toBe('authoring@1');
    expect(d.packs).toEqual(['core-geometry@1', 'core-scene@1']);
    expect(d.topology).toMatchObject({ shells: 1, watertight: false });
    expect(d.scale.largest_dimension_m).toBeCloseTo(0.005, 6);
    expect(d.scale.plausibility).toBe('unknown');
    expect(d.orientation.front).toBe('unknown');
    expect(env.summary).toBe(d.summary);
    expect(env.summary).toMatch(/Front: unknown/);
    const rules = d.findings.map((f) => f.rule);
    expect(rules).toContain('scale/too-small');
    expect(rules).toContain('topo/open-edges');
    const small = d.findings.find((f) => f.rule === 'scale/too-small')!;
    expect(small).toMatchObject({ severity: 'warning', certainty: 'measured' });
    expect(small.likely_cause.confidence).toBeGreaterThan(0);
    const err = env.errors.find((e) => e.code === 'SCALE_TOO_SMALL')!;
    expect(err).toMatchObject({ severity: 'warning', prim_path: '/Asset' });
    expect(err.data).toMatchObject({ rule: 'scale/too-small', pack: 'core-scene@1', certainty: 'measured' });
    expect(err.suggested_fix).toBe(small.fix);
    expect(d.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('profile decides severity; topology off is reported as skipped; params reach the pack', async () => {
    const web = await call('inspect', { path: fx['centimeters.glb'], profile: 'mobile-hero' });
    const wd = web.data as { profile: string; findings: Array<{ rule: string; severity: string; default_severity: string }> };
    expect(wd.profile).toBe('mobile-hero@1');
    const open = wd.findings.find((f) => f.rule === 'topo/open-edges')!;
    expect(open).toMatchObject({ severity: 'info', default_severity: 'warning' });
    expect(wd.findings.find((f) => f.rule === 'scale/too-small')!.severity).toBe('warning');

    const off = await call('inspect', { path: fx['centimeters.glb'], topology: false });
    const od = off.data as { topology: { shells: number | null }; skipped: Array<{ rule: string }> };
    expect(od.topology.shells).toBeNull();
    expect(od.skipped.map((s) => s.rule)).toContain('topo/open-edges');

    const custom = await call('inspect', { path: fx['centimeters.glb'], packs: ['core-scene@1'], params: { 'core-scene': { smallScale: 0.001 } } });
    const cd = custom.data as { packs: string[]; findings: Array<{ rule: string }> };
    expect(cd.packs).toEqual(['core-scene@1']);
    expect(cd.findings.map((f) => f.rule)).not.toContain('scale/too-small');
  });

  it('expect: contract violations are errors, front is declared, unparsed tokens are reported; structured form works too', async () => {
    const env = await call('inspect', { path: fx['centimeters.glb'], expect: 'chair, single-shell, watertight, 0.4-1.2m tall, front -Y, purple' });
    const d = env.data as { packs: string[]; orientation: { front: string; front_source: string }; expectation: { unparsed: string[] }; scale: { plausibility: string }; findings: Array<{ rule: string; severity: string }> };
    expect(d.packs).toContain('intent@1');
    expect(d.orientation).toMatchObject({ front: '-Y', front_source: 'declared' });
    expect(d.expectation.unparsed).toEqual(['purple']);
    expect(d.scale.plausibility).toBe('implausible');
    const intent = d.findings.filter((f) => f.rule.startsWith('intent/'));
    expect(intent.map((f) => [f.rule, f.severity])).toEqual([['intent/watertight', 'error'], ['intent/size', 'error']]);
    expect(env.errors.some((e) => e.code === 'INTENT_SIZE' && e.severity === 'error')).toBe(true);
    expect(env.summary).toMatch(/2 violations/);

    const structured = await call('inspect', { path: fx['centimeters.glb'], expect: { category: 'coin', watertight: false } });
    const sd = structured.data as { expectation: { raw: string | null }; scale: { plausibility: string }; findings: Array<{ rule: string }> };
    expect(sd.expectation.raw).toBeNull();
    expect(sd.scale.plausibility).toBe('implausible'); // a 5 mm sheet against a coin's 15–40 mm prior
    expect(sd.findings.map((f) => f.rule)).toContain('intent/category-scale');
  });

  it('fails cleanly on a missing file', async () => {
    const env = await call('inspect', { path: join(dir, 'nope.glb') });
    expect(env.ok).toBe(false);
    expect(env.errors[0].code).toBe('FILE_NOT_FOUND');
  });

  it('reads USD too', async () => {
    const env = await call('inspect', { path: fx['z-up.usda'] ?? Object.values(fx).find((p) => p.endsWith('.usda'))! });
    expect(env.ok).toBe(true);
    expect((env.data as { format: string }).format).toBe('usda');
  });
});
