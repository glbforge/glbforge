import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit, START, END } from '../src/init.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'glbforge-init-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const statuses = (changes: { file: string; status: string }[]) => Object.fromEntries(changes.map((c) => [c.file, c.status]));

describe('glbforge init', () => {
  it('creates CLAUDE.md, scripts, and .mcp.json in a fresh project, then is idempotent', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'app', scripts: { dev: 'vite' } }));
    await mkdir(join(dir, 'public', 'models'), { recursive: true });

    const first = await runInit({ cwd: dir });
    expect(first.assets).toBe('public/models');
    expect(statuses(first.changes)).toEqual({ 'CLAUDE.md': 'created', 'package.json': 'updated', '.mcp.json': 'created' });

    const claude = await readFile(join(dir, 'CLAUDE.md'), 'utf8');
    expect(claude.startsWith(START)).toBe(true);
    expect(claude).toContain('mobile-hero');
    expect(claude).toContain('public/models/');

    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    expect(pkg.scripts.dev).toBe('vite');
    expect(pkg.scripts['glb:check']).toBe('glbforge audit public/models --recursive --profile mobile-hero');
    expect(pkg.devDependencies.glbforge).toMatch(/^\^\d/);

    const mcp = JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.glbforge).toEqual({ command: 'npx', args: ['-y', '@glbforge/mcp'] });

    const second = await runInit({ cwd: dir });
    expect(statuses(second.changes)).toEqual({ 'CLAUDE.md': 'unchanged', 'package.json': 'unchanged', '.mcp.json': 'unchanged' });
    expect(await readFile(join(dir, 'CLAUDE.md'), 'utf8')).toBe(claude);
  });

  it('preserves surrounding CLAUDE.md content, other MCP servers, and custom scripts', async () => {
    await writeFile(join(dir, 'CLAUDE.md'), '# My project\n\nRules here.\n');
    await writeFile(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } } }));
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'app', scripts: { 'glb:check': 'my-own-check' } }));

    await runInit({ cwd: dir, profile: 'desktop-hero', assets: 'assets/3d' });
    const claude = await readFile(join(dir, 'CLAUDE.md'), 'utf8');
    expect(claude.startsWith('# My project\n\nRules here.\n')).toBe(true);
    expect(claude).toContain(START);
    expect(claude).toContain('desktop-hero');
    expect(claude.trim().endsWith(END)).toBe(true);

    const mcp = JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf8'));
    expect(Object.keys(mcp.mcpServers).sort()).toEqual(['glbforge', 'other']);

    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    expect(pkg.scripts['glb:check']).toBe('my-own-check');
    expect(pkg.scripts['glb:optimize']).toBe('glbforge optimize --profile desktop-hero');

    // Re-running with a different profile replaces only the marked section.
    await runInit({ cwd: dir, profile: 'mobile-hero', assets: 'assets/3d', force: true });
    const again = await readFile(join(dir, 'CLAUDE.md'), 'utf8');
    expect(again.split(START).length).toBe(2);
    expect(again).toContain('mobile-hero');
    expect(again).not.toContain('desktop-hero');
    expect(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).scripts['glb:check']).toContain('glbforge audit');
  });

  it('dry-run writes nothing; cursor client targets .cursor/mcp.json; no package.json is skipped', async () => {
    const dry = await runInit({ cwd: dir, dryRun: true, client: 'both' });
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(dir, '.mcp.json'))).toBe(false);
    expect(statuses(dry.changes)['package.json']).toBe('skipped');
    expect(dry.changes.map((c) => c.file)).toContain('.cursor/mcp.json');

    await runInit({ cwd: dir, client: 'cursor', local: true });
    const cursor = JSON.parse(await readFile(join(dir, '.cursor', 'mcp.json'), 'utf8'));
    expect(cursor.mcpServers.glbforge.command).toBe('node');
    expect(cursor.mcpServers.glbforge.args[0]).toMatch(/mcp[\\/]dist[\\/]index\.js$/);
    expect(existsSync(join(dir, '.mcp.json'))).toBe(false);
  });
});
