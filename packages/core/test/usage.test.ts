/**
 * Usage counter: opt-in gate, append/read, and the lineage rules that make
 * "invocations per asset" measurable when every edit changes the hash.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearUsage, isUsageEnabled, lineagesOf, readUsage, recordUsage, setUsageEnabled, usageFile, usageReport, usageSummary, type UsageEvent } from '../src/index.js';

let dir: string;
const saved: Record<string, string | undefined> = {};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'glbforge-usage-'));
  for (const k of ['GLBFORGE_USAGE', 'GLBFORGE_CONFIG_DIR', 'GLBFORGE_SESSION']) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(dir, { recursive: true, force: true });
});

const ev = (over: Partial<UsageEvent> & { tool: string }): Omit<UsageEvent, 'ts'> & { ts?: string } => ({
  surface: 'cli', session: null, path: null, sha256: null, edge: null, lineage: null, duration_ms: 10, ok: true, ...over,
});
const at = (min: number) => new Date(Date.UTC(2026, 8, 11, 12, min)).toISOString();

describe('opt-in', () => {
  it('records nothing until enabled; env wins over config; disable stops it', async () => {
    const o = { configDir: dir };
    expect(await isUsageEnabled(o)).toBe(false);
    expect(await recordUsage(ev({ tool: 'inspect', path: '/a.glb', sha256: 'aa' }), o)).toBe(false);
    expect(existsSync(await usageFile(o))).toBe(false);

    await setUsageEnabled(true, o);
    expect(await isUsageEnabled(o)).toBe(true);
    expect(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))).toEqual({ usage: true });
    expect(await recordUsage(ev({ tool: 'inspect', path: '/a.glb', sha256: 'aa' }), o)).toBe(true);
    expect((await readUsage(o)).length).toBe(1);

    process.env.GLBFORGE_USAGE = '0';
    expect(await isUsageEnabled(o)).toBe(false);
    process.env.GLBFORGE_USAGE = '1';
    await setUsageEnabled(false, o);
    expect(await isUsageEnabled(o)).toBe(true); // env still wins
    delete process.env.GLBFORGE_USAGE;
    expect(await isUsageEnabled(o)).toBe(false);

    await clearUsage(o);
    expect(await readUsage(o)).toEqual([]);
  });

  it('honours GLBFORGE_CONFIG_DIR', async () => {
    process.env.GLBFORGE_CONFIG_DIR = dir;
    process.env.GLBFORGE_USAGE = '1';
    await recordUsage(ev({ tool: 'diff', path: '/b.glb', sha256: 'bb' }));
    expect(await usageFile()).toBe(join(dir, 'usage.jsonl'));
    expect((await usageSummary()).events).toBe(1);
  });
});

describe('lineage', () => {
  it('(a) same session + path joins hashes across edits; different sessions do not', () => {
    const events: UsageEvent[] = [
      { ...ev({ tool: 'inspect', session: 'S1', path: '/chair.glb', sha256: 'h1' }), ts: at(0) },
      { ...ev({ tool: 'inspect', session: 'S1', path: '/chair.glb', sha256: 'h2' }), ts: at(5) },
      { ...ev({ tool: 'inspect', session: 'S1', path: '/chair.glb', sha256: 'h3' }), ts: at(9) },
      { ...ev({ tool: 'inspect', session: 'S2', path: '/chair.glb', sha256: 'h9' }), ts: at(10) },
    ];
    const l = [...lineagesOf(events).values()].map((x) => x.length).sort();
    expect(l).toEqual([1, 3]);
  });

  it('(b) without a session, the same path within two hours chains; a gap breaks it', () => {
    const events: UsageEvent[] = [
      { ...ev({ tool: 'inspect', path: '/t.glb', sha256: 'a' }), ts: at(0) },
      { ...ev({ tool: 'inspect', path: '/t.glb', sha256: 'b' }), ts: at(60) },
      { ...ev({ tool: 'inspect', path: '/t.glb', sha256: 'c' }), ts: at(100) },
      { ...ev({ tool: 'inspect', path: '/t.glb', sha256: 'd' }), ts: at(100 + 121) }, // > 2 h after c
    ];
    expect([...lineagesOf(events).values()].map((x) => x.length).sort()).toEqual([1, 3]);
  });

  it('(c) a diff edge joins two hashes even across paths; (d) an explicit id joins anything', () => {
    const events: UsageEvent[] = [
      { ...ev({ tool: 'inspect', path: '/v1.glb', sha256: 'h1' }), ts: at(0) },
      { ...ev({ tool: 'inspect', path: '/v2.glb', sha256: 'h2' }), ts: at(1) },
      { ...ev({ tool: 'diff', path: '/v2.glb', sha256: 'h2', edge: { from: 'h1', to: 'h2' } }), ts: at(2) },
      { ...ev({ tool: 'inspect', path: '/elsewhere/x.glb', sha256: 'h7', lineage: 'L' }), ts: at(3) },
      { ...ev({ tool: 'inspect', path: '/other/y.usdz', sha256: 'h8', lineage: 'L' }), ts: at(4) },
      { ...ev({ tool: 'inspect', path: '/lonely.glb', sha256: 'h0' }), ts: at(5) },
    ];
    expect([...lineagesOf(events).values()].map((x) => x.length).sort()).toEqual([1, 2, 3]);
  });

  it('events without a hash fall back to the path; events with neither are ignored', () => {
    const events: UsageEvent[] = [
      { ...ev({ tool: 'analyze', path: '/p.glb' }), ts: at(0) },
      { ...ev({ tool: 'analyze', path: '/p.glb' }), ts: at(1) },
      { ...ev({ tool: 'capabilities' }), ts: at(2) },
    ];
    expect([...lineagesOf(events).values()].map((x) => x.length)).toEqual([2]);
  });

  it('the report: invocations per lineage, sessions, tools, inner-loop share', () => {
    const events: UsageEvent[] = [];
    for (let i = 0; i < 20; i++) events.push({ ...ev({ tool: i % 4 === 3 ? 'diff' : 'inspect', session: 'S', path: '/loop.glb', sha256: `l${i}` }), ts: at(i) });
    events.push({ ...ev({ tool: 'analyze', session: 'S', path: '/once.glb', sha256: 'o' }), ts: at(30) });
    const r = usageReport(events, '/x/usage.jsonl', true);
    expect(r).toMatchObject({ events: 21, sessions: 1, lineages: 2, tools: { inspect: 15, diff: 5, analyze: 1 } });
    expect(r.invocations_per_lineage).toEqual({ mean: 10.5, median: 10.5, p90: 18.1, max: 20 });
    expect(r.distribution).toEqual([20, 1]);
    expect(r.inner_loop_share).toBe(0.5);
    expect(r.window).toEqual({ from: at(0), to: at(30) });
  });
});
