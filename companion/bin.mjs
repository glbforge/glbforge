#!/usr/bin/env node
/**
 * `glbforge-companion <model.glb>` — launch the desktop companion.
 * `glbforge-companion mcp`         — run the MCP bridge over stdio.
 *
 *   npx -y @glbforge/companion model.idle.glb
 *
 * Flags map to the environment the app reads: --port, --size, --brain
 * (sdk | external | off), --brain-model, --detach.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

if (args[0] === 'mcp') {
  await import('./mcp.mjs');
} else if (args.includes('-h') || args.includes('--help') || (!args.length && !process.env.GLBFORGE_COMPANION_MODEL)) {
  console.log(`glbforge-companion <model.glb> [--port 4747] [--size 320] [--brain sdk|external|off] [--brain-model sonnet] [--detach]
glbforge-companion mcp            # MCP bridge over stdio (register as "companion" next to glbforge)

A GLB that lives on your desktop and talks. Give it a .web.glb (run \`glbforge animate\` first for an idle loop).
The brain runs on the Claude CLI's login (\`claude\` then \`/login\`); with none, typed messages queue for an agent on the MCP bridge.
Control it: curl localhost:<port>/state · POST /chat /event /say /emote /play /move /snapshot /quit`);
  process.exit(args.length ? 0 : 1);
} else {
  const env = { ...process.env };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i], next = () => args[++i];
    if (a === '--port') env.GLBFORGE_COMPANION_PORT = next();
    else if (a === '--size') env.GLBFORGE_COMPANION_SIZE = next();
    else if (a === '--brain') env.GLBFORGE_COMPANION_BRAIN = next();
    else if (a === '--brain-model') env.GLBFORGE_COMPANION_BRAIN_MODEL = next();
    else if (a === '--detach') env.GLBFORGE_COMPANION_DETACH = '1';
    else positional.push(a);
  }
  const model = positional.find((a) => /\.(glb|gltf)$/i.test(a));
  if (model) env.GLBFORGE_COMPANION_MODEL = path.resolve(model);
  // The electron package's main export is the path to the binary; ELECTRON_RUN_AS_NODE would turn it into plain node.
  const electron = createRequire(import.meta.url)('electron');
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [path.join(HERE, 'main.mjs')], { env, stdio: env.GLBFORGE_COMPANION_DETACH ? 'ignore' : 'inherit', detached: !!env.GLBFORGE_COMPANION_DETACH });
  if (env.GLBFORGE_COMPANION_DETACH) { child.unref(); console.log(`glbforge companion detached (pid ${child.pid}) on http://127.0.0.1:${env.GLBFORGE_COMPANION_PORT || 4747}`); }
  else child.on('exit', (code) => process.exit(code ?? 0));
}
