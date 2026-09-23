/**
 * `glbforge companion <model.glb>` — put the asset on the desktop as a talking
 * character (see companion/README.md). The CLI does not depend on Electron:
 * it launches the companion from this checkout when it is built here, and
 * otherwise through `npx -y @glbforge/companion@<cli version>`, which
 * installs Electron once into the npx cache.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import { cliVersion } from './init.js';

const here = () => dirname(new URL(import.meta.url).pathname);

/** The companion in this checkout, when its dependencies are installed; else null. */
export function localCompanion(): string | null {
  // packages/cli/dist/companion-cmd.js -> ../../../companion
  const dir = resolve(here(), '..', '..', '..', 'companion');
  return existsSync(join(dir, 'bin.mjs')) && existsSync(join(dir, 'node_modules', 'electron')) ? dir : null;
}

/** glbforge's MCP server for the character's self-inspection: this checkout's build, or an installed @glbforge/mcp. */
export function localMcpServer(): string | null {
  const built = resolve(here(), '..', '..', 'mcp', 'dist', 'index.js');
  if (existsSync(built)) return built;
  try { return createRequire(import.meta.url).resolve('@glbforge/mcp/dist/index.js'); } catch { return null; }
}

export function companionLaunch(model: string | undefined, opts: { port?: number; size?: number; brain?: string; brainModel?: string; detach?: boolean }): { command: string; args: string[]; env: NodeJS.ProcessEnv; source: 'checkout' | 'npx' } {
  const local = localCompanion();
  const flags: string[] = [];
  if (model) flags.push(resolve(model));
  if (opts.port) flags.push('--port', String(opts.port));
  if (opts.size) flags.push('--size', String(opts.size));
  if (opts.brain) flags.push('--brain', opts.brain);
  if (opts.brainModel) flags.push('--brain-model', opts.brainModel);
  if (opts.detach) flags.push('--detach');
  const env: NodeJS.ProcessEnv = { ...process.env };
  const mcp = localMcpServer();
  if (mcp && !env.GLBFORGE_MCP_SERVER) env.GLBFORGE_MCP_SERVER = mcp;
  return local
    ? { command: process.execPath, args: [join(local, 'bin.mjs'), ...flags], env, source: 'checkout' }
    : { command: 'npx', args: ['-y', `@glbforge/companion@${cliVersion()}`, ...flags], env, source: 'npx' };
}

/** The `.mcp.json` entry for the companion bridge, matching how the launch resolves. */
export function companionMcpEntry(cwd: string): { command: string; args: string[] } {
  const local = localCompanion();
  return local ? { command: 'node', args: [join(local, 'mcp.mjs').startsWith(cwd) ? join(local, 'mcp.mjs').slice(cwd.length + 1) : join(local, 'mcp.mjs')] } : { command: 'npx', args: ['-y', `@glbforge/companion@${cliVersion()}`, 'mcp'] };
}

export function registerCompanionCommand(program: Command): void {
  program
    .command('companion')
    .description('Put a GLB on the desktop as a talking character: a transparent always-on-top window that plays its clips, gazes at the cursor, and answers typed messages with a Claude agent (on the Claude CLI login) or through any MCP client. Run `glbforge animate` first for an idle loop. Launches from this checkout when built here, else via npx -y @glbforge/companion (installs Electron once).')
    .argument('[file]', 'path to .glb (the optimized .web.glb or an animated .idle.glb)')
    .option('--port <n>', 'control port (default 4747)', (v) => parseInt(v, 10))
    .option('--size <px>', 'window width (height is 1.3x; default 320)', (v) => parseInt(v, 10))
    .option('--brain <mode>', 'who answers typed messages: sdk (Claude Agent SDK on the CLI login) | external (an MCP client via companion_listen) | off', 'sdk')
    .option('--brain-model <model>', 'model for the embedded brain, e.g. sonnet (default: Claude Code\'s default)')
    .option('--detach', 'return immediately and leave the window running')
    .option('--mcp', 'also register the companion MCP bridge as "companion" in ./.mcp.json')
    .option('--hooks', 'install Claude Code hooks (user settings) so every session\'s finish, permission prompt and start shows on the companion; --hooks-project for this repo only')
    .option('--hooks-project', 'like --hooks, but in ./.claude/settings.json')
    .option('--no-hooks-install', 'remove the companion hooks from user settings')
    .option('--json', 'emit JSON')
    .action(async (file: string | undefined, opts: { port?: number; size?: number; brain?: string; brainModel?: string; detach?: boolean; mcp?: boolean; hooks?: boolean; hooksProject?: boolean; hooksInstall?: boolean; json?: boolean }) => {
      const cwd = process.cwd();
      if (opts.hooks || opts.hooksProject || opts.hooksInstall === false) {
        // Delegate to the companion's own installer so the hook path matches where it actually lives (checkout or npx cache).
        const sub = opts.hooksInstall === false ? 'remove' : 'install';
        const launch = companionLaunch(undefined, {});
        const args = [...launch.args.filter((a) => a !== '--brain' && a !== 'sdk'), 'hooks', sub, ...(opts.hooksProject ? ['--project'] : []), ...(opts.port ? ['--port', String(opts.port)] : [])];
        const r = spawn(launch.command, args, { env: launch.env, stdio: 'inherit' });
        await new Promise<void>((done) => r.on('exit', () => done()));
      }
      if (opts.mcp) {
        const path = join(cwd, '.mcp.json');
        let cfg: Record<string, unknown> = {};
        try { cfg = JSON.parse(await readFile(path, 'utf8')); } catch { /* new file */ }
        const servers = (cfg.mcpServers ??= {}) as Record<string, unknown>;
        servers.companion = companionMcpEntry(cwd);
        await writeFile(path, JSON.stringify(cfg, null, 2) + '\n');
        if (!opts.json) console.log(`  .mcp.json: mcpServers.companion → ${(servers.companion as { command: string }).command} ${(servers.companion as { args: string[] }).args.join(' ')}`);
      }
      if (!file && !opts.mcp && !opts.hooks && !opts.hooksProject && opts.hooksInstall !== false) { console.error('  a .glb path is required (or --mcp / --hooks to only register)'); process.exitCode = 1; return; }
      if (!file) return;
      const launch = companionLaunch(file, opts);
      const port = opts.port ?? 4747;
      if (opts.json) console.log(JSON.stringify({ source: launch.source, command: launch.command, args: launch.args, port, mcpServer: launch.env.GLBFORGE_MCP_SERVER ?? null }, null, 2));
      else {
        console.log(`  companion: ${launch.source === 'checkout' ? 'this checkout' : `npx @glbforge/companion@${cliVersion()} (first run downloads Electron, ~100 MB)`}`);
        console.log(`  control:   http://127.0.0.1:${port}   (curl -s localhost:${port}/state · POST /chat /event /say /emote /snapshot /quit)`);
        console.log(`  brain:     ${opts.brain}${opts.brain === 'sdk' ? ' — needs the Claude CLI logged in (`claude`, then /login); without it, messages queue for an MCP agent' : ''}`);
        if (!opts.detach) console.log('  Ctrl-C quits the window.');
      }
      const child = spawn(launch.command, launch.args, { env: launch.env, stdio: opts.detach ? 'ignore' : 'inherit', detached: !!opts.detach });
      if (opts.detach) { child.unref(); return; }
      await new Promise<void>((done) => child.on('exit', (code) => { process.exitCode = code ?? 0; done(); }));
    });
}
