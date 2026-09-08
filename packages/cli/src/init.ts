/**
 * `glbforge init` — make a project agent-ready for 3D assets:
 *   1. a marker-delimited section in CLAUDE.md telling future agent sessions
 *      how (and when) to use GLBForge,
 *   2. `glb:*` npm scripts (+ glbforge as a devDependency),
 *   3. the MCP server registered in .mcp.json (Claude Code) and/or
 *      .cursor/mcp.json.
 * Idempotent: a second run reports every target as unchanged. Pure text
 * templating — no network, no randomness.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import type { Command } from 'commander';
import { PROFILES } from '@glbforge/core';

export interface InitOptions {
  cwd: string;
  profile?: string;
  /** Directory the project keeps GLBs in (relative to cwd). Auto-detected when omitted. */
  assets?: string;
  client?: 'claude' | 'cursor' | 'both';
  /** Register the MCP server from this monorepo's build instead of npx. */
  local?: boolean;
  claudeMd?: boolean;
  scripts?: boolean;
  mcp?: boolean;
  /** Overwrite existing `glb:*` scripts whose command differs. */
  force?: boolean;
  dryRun?: boolean;
}

export interface InitChange {
  file: string;
  status: 'created' | 'updated' | 'unchanged' | 'skipped';
  note?: string;
}

export const START = '<!-- glbforge:start -->';
export const END = '<!-- glbforge:end -->';

const CANDIDATE_ASSET_DIRS = ['public/models', 'public/assets', 'public', 'assets', 'static/models', 'static', 'models'];

export function cliVersion(): string {
  try {
    return createRequire(import.meta.url)('../package.json').version;
  } catch {
    return '0.0.0';
  }
}

export function claudeSection(profile: string, assets: string): string {
  const p = PROFILES[profile];
  const caps = p
    ? `≤${p.maxTriangles.toLocaleString('en-US')} triangles, ≤${Math.round(p.maxFileBytes / 1048576)}MB file, ≤${p.maxDrawCalls} draw calls, textures ≤${p.maxTextureSize}px, SSIM floor ${p.minSsim}`
    : 'see `npx glbforge --help`';
  return `${START}
## 3D assets: GLBForge

This project ships 3D assets (GLB) under a web performance budget. GLBForge is
installed as the \`glbforge\` MCP server and as \`glb:*\` npm scripts. Use it —
do not hand-roll mesh or texture optimization, and do not guess at budgets.

- Budget profile: **${profile}** (${caps}). Budgets are contracts: \`glbforge analyze\` exits non-zero when an asset is over budget.
- Assets live in \`${assets}/\`. Before committing any \`.glb\`: \`npm run glb:check\` audits every asset there; \`npm run glb:optimize -- <file.glb>\` writes a web-ready \`<name>.web.glb\` beside it (ship that one). \`npm run glb:ship -- <file>\` takes a GLB or an image the whole way.
- Start a 3D task by calling the \`capabilities\` MCP tool: it says which generation providers have keys and whether KTX2 is available, so plans never dead-end on a missing key.
- MCP tools (prefer these inside a session): \`analyze_glb\` (compact card + thumbnail), \`inspect_report\` (full findings / textures / topology), \`optimize_glb\` and \`ship_asset\` (optimize + measured visual fidelity), \`render_preview\` (look at any asset), \`extrude_image\` (flat logos/icons → 3D, deterministic, no AI), \`export_stl\`, \`generate_image_to_3d\` (photos → 3D, needs FAL_KEY).
- Routing: flat artwork (logos, icons, wordmarks) → \`extrude_image\`; photographic or dimensional subjects → generation; every GLB → optimize, then gate.
- "No visible loss" is measured, not assumed: optimization renders four fixed cameras before and after and reports SSIM; a result under the profile floor fails. Only pass \`--no-verify\` when the loss is acceptable, and say so.
- Everything is deterministic (same input + settings = identical bytes), so re-running is safe and CI can gate on it. The \`glbforge/glbforge\` GitHub Action posts report cards on PRs and can open a PR with optimized files.
${END}`;
}

export function mergeClaudeMd(existing: string | null, section: string): { text: string; status: InitChange['status'] } {
  if (existing === null) return { text: section + '\n', status: 'created' };
  const s = existing.indexOf(START), e = existing.indexOf(END);
  if (s !== -1 && e !== -1 && e > s) {
    const text = existing.slice(0, s) + section + existing.slice(e + END.length);
    return { text, status: text === existing ? 'unchanged' : 'updated' };
  }
  const sep = existing.endsWith('\n') ? (existing.endsWith('\n\n') ? '' : '\n') : '\n\n';
  return { text: existing + sep + section + '\n', status: 'updated' };
}

export function scriptsFor(profile: string, assets: string): Record<string, string> {
  return {
    'glb:check': `glbforge audit ${assets} --recursive --profile ${profile}`,
    'glb:analyze': `glbforge analyze --profile ${profile}`,
    'glb:optimize': `glbforge optimize --profile ${profile}`,
    'glb:ship': `glbforge ship --profile ${profile}`,
    'glb:verify': `glbforge verify --profile ${profile}`,
    'glb:studio': 'glbforge ui',
  };
}

export function mcpEntry(local: boolean, cwd: string): { command: string; args: string[] } {
  if (local) {
    // packages/cli/dist/init.js -> ../../mcp/dist/index.js
    const here = dirname(new URL(import.meta.url).pathname);
    const server = resolve(here, '..', '..', 'mcp', 'dist', 'index.js');
    const rel = relative(cwd, server);
    return { command: 'node', args: [rel.startsWith('..') ? server : rel] };
  }
  return { command: 'npx', args: ['-y', '@glbforge/mcp'] };
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

function detectAssets(cwd: string): string {
  for (const dir of CANDIDATE_ASSET_DIRS) if (existsSync(join(cwd, dir))) return dir;
  return 'assets';
}

export async function runInit(opts: InitOptions): Promise<{ changes: InitChange[]; profile: string; assets: string }> {
  const cwd = resolve(opts.cwd);
  const profile = opts.profile ?? 'mobile-hero';
  if (!PROFILES[profile]) throw new Error(`Unknown profile "${profile}". Available: ${Object.keys(PROFILES).join(', ')}`);
  const assets = (opts.assets ?? detectAssets(cwd)).replace(/\/+$/, '') || '.';
  const changes: InitChange[] = [];
  const write = async (path: string, text: string, status: InitChange['status'], note?: string) => {
    if (!opts.dryRun && status !== 'unchanged' && status !== 'skipped') {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
    }
    changes.push({ file: relative(cwd, path) || '.', status, note });
  };

  // 1. CLAUDE.md
  if (opts.claudeMd !== false) {
    const path = join(cwd, 'CLAUDE.md');
    const existing = existsSync(path) ? await readFile(path, 'utf8') : null;
    const { text, status } = mergeClaudeMd(existing, claudeSection(profile, assets));
    await write(path, text, status, 'agent instructions between <!-- glbforge:start/end --> markers');
  }

  // 2. package.json scripts + devDependency
  if (opts.scripts !== false) {
    const path = join(cwd, 'package.json');
    const pkg = await readJson(path);
    if (!pkg) {
      changes.push({ file: 'package.json', status: 'skipped', note: 'no package.json here — npm scripts not added' });
    } else {
      const before = JSON.stringify(pkg);
      const scripts = (pkg.scripts ??= {}) as Record<string, string>;
      const notes: string[] = [];
      for (const [name, cmd] of Object.entries(scriptsFor(profile, assets))) {
        if (scripts[name] === undefined || scripts[name] === cmd) scripts[name] = cmd;
        else if (opts.force) { scripts[name] = cmd; notes.push(`overwrote ${name}`); }
        else notes.push(`kept existing ${name} (use --force to replace)`);
      }
      const dev = (pkg.devDependencies ??= {}) as Record<string, string>;
      const deps = (pkg.dependencies ?? {}) as Record<string, string>;
      if (!dev.glbforge && !deps.glbforge) {
        dev.glbforge = `^${cliVersion()}`;
        notes.push('added glbforge to devDependencies — run your package manager\'s install');
      }
      const text = JSON.stringify(pkg, null, 2) + '\n';
      await write(path, text, JSON.stringify(pkg) === before ? 'unchanged' : 'updated', notes.join('; ') || undefined);
    }
  }

  // 3. MCP registration
  if (opts.mcp !== false) {
    const client = opts.client ?? 'claude';
    const targets = client === 'both' ? ['.mcp.json', '.cursor/mcp.json'] : client === 'cursor' ? ['.cursor/mcp.json'] : ['.mcp.json'];
    for (const rel of targets) {
      const path = join(cwd, rel);
      const cfg = (await readJson(path)) ?? {};
      const before = JSON.stringify(cfg);
      const servers = (cfg.mcpServers ??= {}) as Record<string, unknown>;
      servers.glbforge = mcpEntry(!!opts.local, cwd);
      const text = JSON.stringify(cfg, null, 2) + '\n';
      const status: InitChange['status'] = !existsSync(path) ? 'created' : JSON.stringify(cfg) === before ? 'unchanged' : 'updated';
      await write(path, text, status, `mcpServers.glbforge → ${(servers.glbforge as { command: string; args: string[] }).command} ${(servers.glbforge as { args: string[] }).args.join(' ')}`);
    }
  }

  return { changes, profile, assets };
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Make this project agent-ready for 3D assets: CLAUDE.md instructions, glb:* npm scripts, and the glbforge MCP server in .mcp.json. Idempotent.')
    .argument('[dir]', 'project directory', '.')
    .option('-p, --profile <name>', `budget profile: ${Object.keys(PROFILES).join(' | ')}`, 'mobile-hero')
    .option('--assets <dir>', 'where the project keeps GLBs (auto-detected: public/models, public, assets, …)')
    .option('--client <name>', 'MCP client config to write: claude (.mcp.json) | cursor (.cursor/mcp.json) | both', 'claude')
    .option('--local', 'register the MCP server from this checkout (node packages/mcp/dist/index.js) instead of npx -y @glbforge/mcp')
    .option('--no-claude-md', 'skip CLAUDE.md')
    .option('--no-scripts', 'skip package.json scripts')
    .option('--no-mcp', 'skip MCP registration')
    .option('--force', 'replace existing glb:* scripts that differ')
    .option('--dry-run', 'show what would change without writing')
    .option('--json', 'emit JSON')
    .action(async (dir: string, opts: {
      profile: string; assets?: string; client: 'claude' | 'cursor' | 'both'; local?: boolean;
      claudeMd: boolean; scripts: boolean; mcp: boolean; force?: boolean; dryRun?: boolean; json?: boolean;
    }) => {
      const result = await runInit({ cwd: dir, ...opts });
      if (opts.json) return void console.log(JSON.stringify(result, null, 2));
      const icon = { created: '+', updated: '~', unchanged: '=', skipped: '-' };
      console.log(`  glbforge init${opts.dryRun ? ' (dry run)' : ''} — profile ${result.profile}, assets in ${result.assets}/`);
      for (const c of result.changes) {
        console.log(`  ${icon[c.status]} ${c.file.padEnd(18)} ${c.status}${c.note ? '  ' + c.note : ''}`);
      }
      if (!opts.dryRun && result.changes.some((c) => c.file === '.mcp.json' && c.status !== 'unchanged')) {
        console.log('  restart Claude Code (or reload MCP servers) to pick up the glbforge server.');
      }
    });
}
