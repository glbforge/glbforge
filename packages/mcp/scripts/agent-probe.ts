#!/usr/bin/env tsx
/**
 * Agent probe — what the test suite cannot assert.
 *
 * `pnpm -r test` already proves each tool answers with the right code and a
 * response that validates against its published schema. None of that says
 * whether an agent that *follows the advice* ends up with a better asset, and
 * that is the only thing the product is actually judged on. An agent reads
 * `nextActions`, runs them, and re-reads. If the suggested call does not clear
 * the rule ids it claims to resolve, GLBForge sent the agent in a circle and
 * every test still passed.
 *
 * Five sections, each answering a question a unit test does not:
 *
 *   surface   Do the places an agent learns what exists agree? The stdio
 *             server (not the in-memory one the tests use — this is the
 *             packaging an agent actually launches), schemas/index.json, the
 *             MCP README, site/llms.txt, server.json, and npm.
 *   advice    Execute every nextAction and every suggested_fix that names a
 *             tool. Did the claimed rule ids clear? Did following the advice
 *             introduce findings that were not there before?
 *   latency   p50/p90 per tool against a committed baseline. The inner-loop
 *             reframe is a latency bet; a 3x regression kills it silently.
 *   vocab     Every code and rule id observed must be in the envelope enum
 *             AND in docs/error-codes.md. Advice that names a tool must name
 *             a tool that exists.
 *   live      glbforge.dev is the other surface agents read. Is it up, and
 *             does its llms.txt match this checkout?
 *
 * Read-only and free: no Meshy, no fal, no Stripe, no paid path is touched.
 *
 * Usage:
 *   pnpm --filter @glbforge/mcp probe                     # human summary
 *   pnpm --filter @glbforge/mcp probe -- --json out.json  # machine report
 *   pnpm --filter @glbforge/mcp probe -- --gate           # exit 1 on regression
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Document } from '@gltf-transform/core';
import { createNodeIO } from '@glbforge/core';
import { writeAgentFixtures, makeGrid } from '../../core/test/agent-fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const schemasDir = join(root, 'schemas');

type Diagnostic = { code: string; severity: string; prim_path: string; message: string; suggested_fix?: string; rule?: string };
type Envelope = { ok: boolean; summary: string; duration_ms: number; errors: Diagnostic[]; data: Record<string, any> };
type NextAction = { tool: string; args: Record<string, unknown>; note?: string; resolves?: string[] };

/** Tools that cost money or reach a vendor. The probe never calls these. */
const PAID = new Set(['generate_image_to_3d', 'generation_status', 'meshy_create_task', 'meshy_task_status', 'meshy_download']);
/** Tools the advice section is allowed to execute (writes land in a temp dir). */
const EXECUTABLE = new Set(['optimize_glb', 'ship_asset', 'export_stl', 'export_usdz', 'extrude_image', 'inspect', 'inspect_report', 'inspect_all', 'inspect_geometry', 'inspect_materials', 'inspect_animation', 'analyze_glb', 'analyze_performance', 'validate', 'diff', 'render', 'render_preview', 'compare_glb', 'audit_directory', 'list_profiles', 'capabilities']);

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
/** pnpm runs this from packages/mcp; paths a caller types are repo-relative. */
const outPath = (name: string) => { const v = opt(name); return v ? resolve(root, v) : undefined; };

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validators = new Map<string, ReturnType<typeof ajv.compile>>();

let client: Client;
let dir: string;
let fx: Record<string, string> = {};

/** Everything the probe saw, so vocab/ can check codes nothing else looked at. */
const observed = { codes: new Set<string>(), rules: new Set<string>(), schemaViolations: [] as string[] };
/** Filled from listTools() before anything is graded. */
const toolNames = new Set<string>();
const timings = new Map<string, number[]>();

async function call(name: string, a: Record<string, unknown>): Promise<Envelope> {
  const t0 = Date.now();
  const raw = (await client.callTool({ name, arguments: a })) as { content: { type: string; text?: string }[]; isError?: boolean };
  const ms = Date.now() - t0;
  const text = raw.content.find((b) => b.type === 'text')?.text ?? '{}';
  if (text.startsWith('MCP error')) throw new Error(`${name}: ${text}`);
  let env: Envelope;
  try { env = JSON.parse(text) as Envelope; } catch { throw new Error(`${name}: response is not JSON: ${text.slice(0, 200)}`); }

  if (!timings.has(name)) timings.set(name, []);
  timings.get(name)!.push(ms);

  // Wall-clock vs the duration the tool reports about itself. A tool that
  // claims 12 ms on a call that took 900 ms is lying to the agent's budget.
  const file = join(schemasDir, `${name}.output.json`);
  if (existsSync(file) && !raw.isError) {
    let v = validators.get(name);
    if (!v) { v = ajv.compile(JSON.parse(await readFile(file, 'utf8'))); validators.set(name, v); }
    if (!v(env)) observed.schemaViolations.push(`${name}: ${ajv.errorsText(v.errors).slice(0, 300)}`);
  }
  for (const d of env.errors ?? []) {
    observed.codes.add(d.code);
    if (d.rule) observed.rules.add(d.rule);
  }
  if (Array.isArray(env.data?.topFindings)) for (const f of env.data.topFindings as { ruleId?: string }[]) if (f.ruleId) observed.rules.add(f.ruleId);
  if (Array.isArray(env.data?.findings)) for (const f of env.data.findings as { ruleId?: string }[]) if (f?.ruleId) observed.rules.add(f.ruleId);
  return env;
}

const ruleIdsOf = (env: Envelope): Set<string> => {
  const s = new Set<string>();
  for (const d of env.errors ?? []) if (d.rule) s.add(d.rule);
  if (Array.isArray(env.data?.topFindings)) for (const f of env.data.topFindings as { ruleId?: string }[]) if (f.ruleId) s.add(f.ruleId);
  if (Array.isArray(env.data?.findings)) for (const f of env.data.findings as { ruleId?: string }[]) if (f?.ruleId) s.add(f.ruleId);
  return s;
};
const codesOf = (env: Envelope) => new Set((env.errors ?? []).map((d) => d.code));


// ------------------------------------------------------- failing fixtures
/**
 * The core test fixtures are built to emit one code each; every one of them
 * passes mobile-hero, so `nextActions` is empty and there is no advice to
 * grade. These are built to FAIL, one per budget class the product claims to
 * fix, because "does optimize_glb actually resolve what analyze_glb said it
 * would" is only answerable on an asset that fails in the first place.
 */
async function writeFailingFixtures(into: string): Promise<Record<string, string>> {
  await mkdir(into, { recursive: true });
  const io = await createNodeIO();
  const sharp = (await import('sharp')).default;
  const out: Record<string, string> = {};

  const material = (doc: Document, name: string) =>
    doc.createMaterial(name).setBaseColorFactor([0.8, 0.3, 0.4, 1]).setRoughnessFactor(0.6);

  const write = async (name: string, doc: Document) => {
    const path = join(into, name);
    await writeFile(path, await io.writeBinary(doc));
    out[name] = path;
  };

  // 200k triangles: over mobile-hero's 150k. perf/triangle-budget.
  {
    const doc = new Document();
    const mesh = makeGrid(doc, 317, 1, { uvs: true, normals: true, name: 'dense' }); // 2*317^2 = 200,978
    mesh.listPrimitives()[0].setMaterial(material(doc, 'dense'));
    doc.createScene().addChild(doc.createNode('dense').setMesh(mesh));
    await write('over-triangles.glb', doc);
  }

  // 10 meshes, 10 materials: over maxDrawCalls (4) and maxMaterials (2).
  // join() + palette() are exactly what optimize claims to do about this.
  {
    const doc = new Document();
    const scene = doc.createScene();
    for (let i = 0; i < 10; i++) {
      const mesh = makeGrid(doc, 8, 0.3, { uvs: true, normals: true, name: `part${i}` });
      mesh.listPrimitives()[0].setMaterial(material(doc, `mat${i}`));
      scene.addChild(doc.createNode(`part${i}`).setMesh(mesh).setTranslation([i * 0.4, 0, 0]));
    }
    await write('over-drawcalls.glb', doc);
  }

  // A 4096 PNG: over mobile-hero's 2048 maxTextureSize and 4MB texture cap.
  {
    const size = 4096;
    const rgba = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // Structured noise, not flat colour: a solid texture is folded into
      // baseColorFactor by prune() and the size finding vanishes for the
      // wrong reason.
      rgba[i] = (x * 7 + y * 3) & 255; rgba[i + 1] = (x ^ y) & 255; rgba[i + 2] = (y * 5) & 255; rgba[i + 3] = 255;
    }
    const png = await sharp(rgba, { raw: { width: size, height: size, channels: 4 } }).png({ compressionLevel: 6 }).toBuffer();
    const doc = new Document();
    const mesh = makeGrid(doc, 8, 1, { uvs: true, normals: true, name: 'plate' });
    const tex = doc.createTexture('huge').setImage(new Uint8Array(png)).setMimeType('image/png');
    mesh.listPrimitives()[0].setMaterial(material(doc, 'painted').setBaseColorTexture(tex));
    doc.createScene().addChild(doc.createNode('plate').setMesh(mesh));
    await write('over-texture.glb', doc);
  }

  return out;
}

// ---------------------------------------------------------------- surface

async function surface() {
  const listed = (await client.listTools()).tools;
  const names = listed.map((t) => t.name).sort();
  for (const n of names) toolNames.add(n);
  const index = JSON.parse(await readFile(join(schemasDir, 'index.json'), 'utf8'));
  const indexed = Object.keys(index.tools).sort();
  const readme = await readFile(join(root, 'packages', 'mcp', 'README.md'), 'utf8');
  const llms = await readFile(join(root, 'site', 'llms.txt'), 'utf8');
  const serverJson = JSON.parse(await readFile(join(root, 'server.json'), 'utf8'));

  const pkgVersion = (p: string) => JSON.parse(execFileSync('cat', [join(root, 'packages', p, 'package.json')], { encoding: 'utf8' })).version as string;
  const versions = Object.fromEntries(['core', 'cli', 'mcp', 'meshy', 'studio'].map((p) => [p, pkgVersion(p)]));
  const repoVersion = versions.core;

  let npmVersion: string | null = null;
  if (!flag('no-live')) {
    try {
      const r = await fetch('https://registry.npmjs.org/glbforge/latest', { signal: AbortSignal.timeout(10_000) });
      if (r.ok) npmVersion = ((await r.json()) as { version: string }).version;
    } catch { /* offline is a finding, not a crash */ }
  }

  // llms.txt is the scope statement an agent reads before it installs
  // anything, so its claims are checked one by one rather than by scanning
  // for the version string anywhere in the file — "crate 0.8.0" is a USD
  // format version and satisfied a loose scan while the release claim on
  // line 15 was a year out.
  const llmsLine = llms.match(/the\s+(\d+\.\d+\.\d+)\s+line/)?.[1];
  const llmsToolCount = llms.match(/(\d+)-tool MCP server/)?.[1];
  const llmsProfileVersion = llms.match(/`@(\d+)`\s+is\s+current/)?.[1];

  // What the server itself says the current profile version is.
  let profileVersion: number | null = null;
  try {
    const profiles = await call('list_profiles', {});
    const rows = (profiles.data?.profiles ?? []) as { name?: string; version?: number }[];
    const hero = Array.isArray(rows) ? rows.find((x) => x.name === 'mobile-hero') : undefined;
    profileVersion = hero?.version ?? null;
  } catch { /* reported by the sweep */ }

  const findings: string[] = [];
  const missingFromIndex = names.filter((n) => !indexed.includes(n));
  const staleInIndex = indexed.filter((n) => !names.includes(n));
  const missingSchemaFiles = names.flatMap((n) => ['input', 'output'].filter((k) => !existsSync(join(schemasDir, `${n}.${k}.json`))).map((k) => `${n}.${k}.json`));
  const undocumentedInReadme = names.filter((n) => !readme.includes(n));

  if (missingFromIndex.length) findings.push(`tools on the server but not in schemas/index.json: ${missingFromIndex.join(', ')}`);
  if (staleInIndex.length) findings.push(`tools in schemas/index.json the server does not expose: ${staleInIndex.join(', ')}`);
  if (missingSchemaFiles.length) findings.push(`missing schema files: ${missingSchemaFiles.join(', ')}`);
  if (undocumentedInReadme.length) findings.push(`tools absent from packages/mcp/README.md: ${undocumentedInReadme.join(', ')}`);
  if (new Set(Object.values(versions)).size !== 1) findings.push(`package versions disagree: ${JSON.stringify(versions)}`);
  if (index.version !== repoVersion) findings.push(`schemas/index.json says ${index.version}, packages say ${repoVersion}`);
  if (serverJson.version && serverJson.version !== repoVersion) findings.push(`server.json says ${serverJson.version}, packages say ${repoVersion}`);
  if (llmsToolCount && Number(llmsToolCount) !== names.length) findings.push(`site/llms.txt advertises a ${llmsToolCount}-tool MCP server; the server exposes ${names.length}`);
  if (llmsLine && llmsLine !== repoVersion) findings.push(`site/llms.txt says it is in step with "the ${llmsLine} line"; the packages are ${repoVersion} — an agent reading it is told about a release that does not exist`);
  if (llmsProfileVersion && profileVersion != null && Number(llmsProfileVersion) !== profileVersion) findings.push(`site/llms.txt says profile "@${llmsProfileVersion} is current"; the server serves mobile-hero@${profileVersion} — an agent that pins @${llmsProfileVersion} on that advice gets different caps than the bare name`);
  if (npmVersion && npmVersion !== repoVersion) findings.push(`npm latest is ${npmVersion}, this checkout is ${repoVersion}`);

  return { tools: names.length, toolNames: names, versions, repoVersion, npmVersion, llmsToolCount, llmsLine, profileVersion, findings };
}


// ------------------------------------------------------------------ sweep
/**
 * Every read-only tool against every fixture. Nothing is asserted here: the
 * point is to make the code vocabulary an agent can actually encounter show
 * up in `observed`, so vocab/ measures coverage rather than the handful of
 * codes the advice path happened to trip.
 */
async function sweep() {
  const index = JSON.parse(await readFile(join(schemasDir, 'index.json'), 'utf8'));
  const readOnly = Object.entries(index.tools).filter(([n, t]: any) => t.readOnly && !PAID.has(n)).map(([n]) => n);
  const failures: string[] = [];
  const envelopes: { tool: string; fixture: string; env: Envelope }[] = [];

  for (const [label, path] of Object.entries(fx)) {
    for (const name of readOnly) {
      const a: Record<string, unknown> = name === 'list_profiles' || name === 'capabilities' ? {}
        : name === 'audit_directory' ? { dir }
        : name === 'diff' ? { before: path, after: path }
        : name === 'compare_glb' ? { reference: path, candidate: path }
        : { path };
      // A directory / profile listing does not vary per fixture.
      if ((name === 'list_profiles' || name === 'capabilities' || name === 'audit_directory') && label !== Object.keys(fx)[0]) continue;
      try { envelopes.push({ tool: name, fixture: label, env: await call(name, a) }); }
      catch (e) { failures.push(`${name}(${label}): ${String(e).slice(0, 160)}`); }
    }
  }
  return { calls: envelopes.length, failures, envelopes };
}

/** Every nextActions array anywhere in a payload, whichever tool produced it. */
function collectNextActions(node: unknown, acc: NextAction[] = []): NextAction[] {
  if (Array.isArray(node)) { for (const v of node) collectNextActions(v, acc); return acc; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'nextActions' && Array.isArray(v)) for (const a of v) if (a && typeof a === 'object' && 'tool' in (a as object)) acc.push(a as NextAction);
      else collectNextActions(v, acc);
    }
  }
  return acc;
}

// ----------------------------------------------------------------- advice

/**
 * Execute the advice and see whether the asset got better.
 *
 * Grading is split, deliberately, along the same line as the certainty
 * invariant in the packs: an action that carries `resolves` has made a claim
 * and is graded against exactly that claim; an action with no `resolves` has
 * claimed nothing, so it is only checked for running cleanly and for what it
 * broke. Grading an unclaimed action against every finding would invent a
 * promise the tool never made and report failures that are not failures.
 */
async function advice(envelopes: { tool: string; fixture: string; env: Envelope }[]) {
  const rows: any[] = [];
  const outDir = join(dir, 'advice');
  await mkdir(outDir, { recursive: true });
  let n = 0;

  for (const { tool: sourceTool, fixture, env: before } of envelopes) {
    const path = fx[fixture];
    for (const action of collectNextActions(before.data)) {
      if (PAID.has(action.tool)) { rows.push({ fixture, from: sourceTool, tool: action.tool, outcome: 'skipped', detail: 'paid path' }); continue; }
      if (!EXECUTABLE.has(action.tool)) { rows.push({ fixture, from: sourceTool, tool: action.tool, outcome: 'skipped', detail: 'not executable by the probe' }); continue; }

      const claimed = action.resolves ?? [];
      const out = join(outDir, `${++n}-${action.tool}-${fixture}`);
      let result: Envelope;
      try { result = await call(action.tool, { ...action.args, out }); }
      catch (e) { rows.push({ fixture, from: sourceTool, tool: action.tool, claimed, outcome: 'threw', detail: String(e).slice(0, 200) }); continue; }
      if (!result.ok) { rows.push({ fixture, from: sourceTool, tool: action.tool, claimed, outcome: 'refused', detail: result.summary }); continue; }

      const produced = (result.data?.outPath ?? result.data?.out ?? result.data?.path ?? out) as string;
      if (typeof produced !== 'string' || !existsSync(produced)) {
        // A read-only suggestion (drill-down, re-inspect) writes nothing; that
        // is not a failure, it just cannot be graded as a repair.
        rows.push({ fixture, from: sourceTool, tool: action.tool, claimed, outcome: claimed.length ? 'no output' : 'ran', detail: claimed.length ? String(produced) : 'read-only suggestion' });
        continue;
      }

      // Re-ask the tool that gave the advice, about the file the advice made.
      const reArgs: Record<string, unknown> = sourceTool === 'diff' ? { before: path, after: produced }
        : sourceTool === 'compare_glb' ? { reference: path, candidate: produced }
        : { path: produced, ...(before.data?.profile ? { profile: (before.data.profile as any)?.name ?? before.data.profile } : {}) };
      let after: Envelope;
      try { after = await call(sourceTool, reArgs); }
      catch (e) { rows.push({ fixture, from: sourceTool, tool: action.tool, claimed, outcome: 'unverifiable', detail: String(e).slice(0, 200) }); continue; }

      const afterRules = ruleIdsOf(after);
      const unresolved = claimed.filter((r) => afterRules.has(r));
      const beforeCodes = codesOf(before);
      const introduced = [...after.errors ?? []]
        .filter((d) => d.severity === 'error' && !beforeCodes.has(d.code))
        .map((d) => d.code);

      rows.push({
        fixture, from: sourceTool, tool: action.tool, claimed,
        resolved: claimed.filter((r) => !afterRules.has(r)),
        unresolved,
        introducedCodes: [...new Set(introduced)],
        scoreBefore: before.data?.score ?? null, scoreAfter: after.data?.score ?? null,
        passedBefore: before.data?.passed ?? null, passedAfter: after.data?.passed ?? null,
        outcome: claimed.length === 0 ? 'ran' : unresolved.length === 0 ? 'resolved' : 'incomplete',
      });
    }

    // Free-text advice: does every suggested_fix that names a tool name a
    // tool that exists? A fix pointing at a renamed tool is a dead end an
    // agent cannot recover from, and no schema catches it.
    for (const d of before.errors ?? []) {
      if (!d.suggested_fix) continue;
      // Only snake_case identifiers immediately followed by "(" — prose like
      // "before export (Blender: Ctrl+A)" is advice to a human, not a call.
      for (const m of [...d.suggested_fix.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\(/g)].map((x) => x[1])) {
        if (!toolNames.has(m)) rows.push({ fixture, from: sourceTool, code: d.code, outcome: 'dangling advice', detail: `suggested_fix names ${m}(), which is not a tool this server exposes` });
      }
    }
  }

  const claimedRows = rows.filter((r) => r.claimed?.length);
  const resolved = claimedRows.filter((r) => r.outcome === 'resolved').length;
  const executedRows = rows.filter((r) => ['resolved', 'incomplete', 'ran', 'threw', 'refused', 'no output', 'unverifiable'].includes(r.outcome));
  const broke = rows.filter((r) => ['threw', 'refused', 'no output', 'unverifiable'].includes(r.outcome));

  return {
    executed: executedRows.length,
    claimedActions: claimedRows.length,
    resolved,
    // The headline: of the repairs GLBForge promised, how many it delivered.
    resolutionRate: claimedRows.length ? Number((resolved / claimedRows.length).toFixed(3)) : null,
    failedToRun: broke.length,
    collateralRegressions: rows.filter((r) => (r.introducedCodes?.length ?? 0) > 0).length,
    danglingAdvice: rows.filter((r) => r.outcome === 'dangling advice').length,
    rows,
  };
}

// ---------------------------------------------------------------- latency

async function latency(unreachable: string[]) {
  const index = JSON.parse(await readFile(join(schemasDir, 'index.json'), 'utf8'));
  const glb = Object.entries(fx).find(([k]) => k.includes('fifty'))?.[1] ?? Object.values(fx).find((p) => p.endsWith('.glb'))!;
  const readOnly = Object.entries(index.tools).filter(([n, t]: any) => t.readOnly && !PAID.has(n)).map(([n]) => n);

  for (const name of readOnly) {
    const a: Record<string, unknown> = name === 'list_profiles' || name === 'capabilities' ? {}
      : name === 'audit_directory' ? { dir }
      : name === 'diff' ? { before: glb, after: glb }
      : name === 'compare_glb' ? { reference: glb, candidate: glb }
      : { path: glb };
    for (let i = 0; i < 3; i++) { try { await call(name, a); } catch (e) { unreachable.push(`${name}: ${String(e).slice(0, 160)}`); break; } }
  }

  const out: Record<string, { p50: number; p90: number; n: number }> = {};
  for (const [name, xs] of timings) {
    const s = [...xs].sort((x, y) => x - y);
    out[name] = { p50: s[Math.floor(s.length * 0.5)], p90: s[Math.min(s.length - 1, Math.floor(s.length * 0.9))], n: s.length };
  }
  return out;
}

// ------------------------------------------------------------------ vocab

async function vocab() {
  const envelope = JSON.parse(await readFile(join(schemasDir, 'envelope.json'), 'utf8'));
  const declared: string[] = envelope.properties.errors.items.properties.code.enum;
  const doc = await readFile(join(root, 'docs', 'error-codes.md'), 'utf8');

  const undeclared = [...observed.codes].filter((c) => !declared.includes(c));
  const undocumented = [...observed.codes].filter((c) => !doc.includes(`\`${c}\``));
  // A code nothing ever emits is not a bug, but a code documented in a table
  // no tool can produce is advice an agent will never be able to act on.
  const neverObserved = declared.filter((c) => !observed.codes.has(c));

  return {
    codesDeclared: declared.length,
    codesObserved: observed.codes.size,
    rulesObserved: [...observed.rules].sort(),
    undeclared,
    undocumented,
    neverObservedCount: neverObserved.length,
    schemaViolations: observed.schemaViolations,
  };
}

// ------------------------------------------------------------------- live

async function live() {
  if (flag('no-live')) return { skipped: true };
  const targets = ['https://glbforge.dev/', 'https://glbforge.dev/llms.txt', 'https://glbforge.dev/budgets/', 'https://glbforge.dev/studio/'];
  const checks: any[] = [];
  for (const url of targets) {
    const t0 = Date.now();
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      checks.push({ url, status: r.status, ms: Date.now() - t0, bytes: (await r.text()).length });
    } catch (e) { checks.push({ url, error: String(e).slice(0, 160), ms: Date.now() - t0 }); }
  }
  const findings: string[] = [];
  for (const c of checks) if (c.error || (c.status && c.status >= 400)) findings.push(`${c.url} → ${c.error ?? c.status}`);

  // Is the deployed llms.txt the one in this checkout? Drift here means the
  // scope statement agents read is not the scope that shipped.
  try {
    const r = await fetch('https://glbforge.dev/llms.txt', { signal: AbortSignal.timeout(15_000) });
    if (r.ok) {
      const deployed = (await r.text()).trim();
      const local = (await readFile(join(root, 'site', 'llms.txt'), 'utf8')).trim();
      if (deployed !== local) findings.push(`deployed llms.txt differs from site/llms.txt (${deployed.length} vs ${local.length} bytes) — the site is not serving this checkout`);
    }
  } catch { /* already reported above */ }

  return { checks, findings };
}

// ------------------------------------------------------------------- main

async function main() {
  dir = await mkdtemp(join(tmpdir(), 'glbforge-probe-'));
  fx = { ...(await writeAgentFixtures(dir)), ...(await writeFailingFixtures(join(dir, 'failing'))) };

  const entry = join(root, 'packages', 'mcp', 'dist', 'index.js');
  if (!existsSync(entry)) throw new Error(`${entry} missing — run pnpm -r build first`);
  // stdio, not the in-memory transport the tests use: this is the packaging an
  // agent actually launches, and it is where a bad bin/ or a missing dist file
  // shows up.
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd: root, stderr: 'pipe' });
  client = new Client({ name: 'agent-probe', version: '1' });
  await client.connect(transport);

  const report: any = {
    probe: 1,
    at: new Date().toISOString(),
    commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    host: `${process.platform}-${process.arch}-node${process.versions.node.split('.')[0]}`,
  };
  report.surface = await surface();
  const sweepResult = await sweep();
  report.advice = await advice(sweepResult.envelopes);
  const unreachable: string[] = [];
  report.sweep = { calls: sweepResult.calls, failures: sweepResult.failures };
  report.latency = await latency(unreachable);
  report.latency_unreachable = unreachable;
  report.vocab = await vocab();
  report.live = await live();

  await client.close();
  await rm(dir, { recursive: true, force: true });

  // ---- gate against the committed baseline
  const baselinePath = outPath('baseline') ?? join(root, 'docs', 'agent-loop', 'baseline.json');
  const regressions: string[] = [];
  if (existsSync(baselinePath)) {
    const b = JSON.parse(await readFile(baselinePath, 'utf8'));
    const r = report.advice.resolutionRate;
    if (b.advice?.resolutionRate != null && r != null && r < b.advice.resolutionRate - 0.001) regressions.push(`advice resolution ${r} < baseline ${b.advice.resolutionRate}`);
    if (report.advice.collateralRegressions > (b.advice?.collateralRegressions ?? 0)) regressions.push(`collateral regressions ${report.advice.collateralRegressions} > baseline ${b.advice?.collateralRegressions ?? 0}`);
    if (report.advice.danglingAdvice > (b.advice?.danglingAdvice ?? 0)) regressions.push(`dangling advice ${report.advice.danglingAdvice} > baseline ${b.advice?.danglingAdvice ?? 0}`);
    if (report.surface.tools < (b.surface?.tools ?? 0)) regressions.push(`tool count ${report.surface.tools} < baseline ${b.surface.tools}`);
    if (report.vocab.undeclared.length) regressions.push(`codes emitted but absent from the envelope enum: ${report.vocab.undeclared.join(', ')}`);
    if (report.vocab.undocumented.length) regressions.push(`codes emitted but absent from docs/error-codes.md: ${report.vocab.undocumented.join(', ')}`);
    if (report.vocab.schemaViolations.length) regressions.push(`${report.vocab.schemaViolations.length} response(s) violate their published schema`);
    // Latency is the one number that is not portable: a cloud runner is not
    // this laptop, and gating on it by default would cry regression on every
    // scheduled pass. Recorded always, gated only when asked, and only
    // meaningful against a baseline taken on the same `host`.
    if (flag('gate-latency')) {
      for (const [tool, v] of Object.entries(report.latency as Record<string, { p90: number }>)) {
        const was = b.latency?.[tool]?.p90;
        if (was != null && v.p90 > Math.max(was * 1.5, was + 50)) regressions.push(`${tool} p90 ${v.p90}ms vs baseline ${was}ms`);
      }
    }
  }
  report.regressions = regressions;

  const baselineOut = outPath('baseline-out');
  if (baselineOut) {
    await writeFile(baselineOut, JSON.stringify({
      recorded: report.at, commit: report.commit, host: report.host,
      surface: { tools: report.surface.tools },
      advice: {
        resolutionRate: report.advice.resolutionRate,
        claimedActions: report.advice.claimedActions,
        collateralRegressions: report.advice.collateralRegressions,
        danglingAdvice: report.advice.danglingAdvice,
        failedToRun: report.advice.failedToRun,
      },
      vocab: { codesObserved: report.vocab.codesObserved, codesDeclared: report.vocab.codesDeclared },
      latency: report.latency,
    }, null, 2) + '\n');
  }

  const jsonOut = outPath('json');
  if (jsonOut) await writeFile(jsonOut, JSON.stringify(report, null, 2));

  // ---- human summary
  const L: string[] = [];
  L.push(`# Agent probe — ${report.commit} — ${report.at}`);
  L.push('');
  L.push(`**Surface** ${report.surface.tools} tools over stdio; packages ${report.surface.repoVersion}, npm ${report.surface.npmVersion ?? 'unknown'}`);
  for (const f of report.surface.findings) L.push(`- ${f}`);
  L.push('');
  L.push(`**Advice** ${report.advice.resolved}/${report.advice.executed} suggested actions resolved what they claimed (${report.advice.resolutionRate ?? 'n/a'}); ${report.advice.collateralRegressions} introduced new findings; ${report.advice.danglingAdvice} dangling`);
  for (const r of report.advice.rows.filter((x: any) => x.outcome && x.outcome !== 'resolved')) {
    L.push(`- ${r.fixture} → ${r.tool ?? r.code}: ${r.outcome}${r.unresolved?.length ? ` (still: ${r.unresolved.join(', ')})` : ''}${r.introducedCodes?.length ? ` (introduced: ${r.introducedCodes.join(', ')})` : ''}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  L.push('');
  const slow = Object.entries(report.latency as Record<string, { p50: number; p90: number }>).sort((a, b) => b[1].p90 - a[1].p90).slice(0, 8);
  L.push('**Latency** (p50/p90 ms, slowest first)');
  for (const [t, v] of slow) L.push(`- ${t}: ${v.p50}/${v.p90}`);
  L.push('');
  L.push(`**Vocab** ${report.vocab.codesObserved}/${report.vocab.codesDeclared} codes exercised; ${report.vocab.undeclared.length} undeclared, ${report.vocab.undocumented.length} undocumented, ${report.vocab.schemaViolations.length} schema violations`);
  for (const v of report.vocab.schemaViolations.slice(0, 5)) L.push(`- ${v}`);
  L.push('');
  if (!report.live.skipped) {
    L.push('**Live** glbforge.dev');
    for (const c of report.live.checks) L.push(`- ${c.url} → ${c.error ?? `${c.status} in ${c.ms}ms`}`);
    for (const f of report.live.findings) L.push(`- ${f}`);
    L.push('');
  }
  if (regressions.length) { L.push('**Regressions vs baseline**'); for (const r of regressions) L.push(`- ${r}`); }
  else L.push('No regressions vs baseline.');

  const md = L.join('\n');
  const mdOut = outPath('markdown');
  if (mdOut) await writeFile(mdOut, md + '\n');
  console.log(md);

  if (flag('gate') && regressions.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(2); });
