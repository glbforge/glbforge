#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import { Logger, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

/** IO with all extensions + meshopt codecs (needed to read/write EXT_meshopt_compression). */
async function createIO(): Promise<NodeIO> {
  await MeshoptDecoder.ready;
  await MeshoptEncoder.ready;
  return new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'meshopt.decoder': MeshoptDecoder,
      'meshopt.encoder': MeshoptEncoder,
    });
}
import { analyze, extrudeImage, getProfile, optimize, PROFILES } from '@xui/core';
import { printDiff, printReport } from './report.js';
import { scaffoldViewer } from './scaffold.js';
import { registerMeshyCommands } from './meshy-cmd.js';
import { loadDotEnv } from './env.js';

loadDotEnv();

/**
 * Shared analyze -> optimize -> write -> re-analyze pipeline; returns
 * whether the written asset passes the profile. Used by `xui optimize`
 * and by `xui meshy … --optimize`.
 */
async function optimizeFile(
  input: string,
  output: string,
  profileName: string,
  extra: {
    target?: number; textures?: boolean; compress?: boolean; lods?: string;
  } = {},
): Promise<boolean> {
  const profile = getProfile(profileName);
  const bytes = await readFile(input);
  const io = await createIO();
  const doc = await io.readBinary(new Uint8Array(bytes));
  doc.setLogger(new Logger(Logger.Verbosity.ERROR));

  const before = analyze(doc, { profile, topology: false, filePath: input, fileBytes: bytes.byteLength });

  const summary = await optimize(doc, {
    profile,
    targetTriangles: extra.target,
    textures: extra.textures,
    compress: extra.compress,
    log: (msg) => console.log('  ' + msg),
  });

  const outBytes = await io.writeBinary(doc);
  await writeFile(output, outBytes);

  // Re-analyze the actual written file so the diff reflects reality.
  const after = analyze(await io.readBinary(outBytes), {
    profile, topology: false, filePath: output, fileBytes: outBytes.byteLength,
  });
  printDiff(before, after, summary.steps);

  // Optional LOD chain: simplify further from the already-optimized doc.
  if (extra.lods) {
    const targets = extra.lods.split(',').map((t) => parseInt(t.trim(), 10));
    for (let i = 0; i < targets.length; i++) {
      const lodDoc = await io.readBinary(outBytes);
      lodDoc.setLogger(new Logger(Logger.Verbosity.ERROR));
      await optimize(lodDoc, {
        profile, targetTriangles: targets[i],
        textures: false, compress: extra.compress,
      });
      const lodPath = output.replace(/\.glb$/i, `.lod${i + 1}.glb`);
      const lodBytes = await io.writeBinary(lodDoc);
      await writeFile(lodPath, lodBytes);
      console.log(`  lod${i + 1}: ${lodPath} (${(lodBytes.byteLength / 1048576).toFixed(1)}MB, target ${targets[i].toLocaleString()} tris)`);
    }
  }
  return after.passed;
}

const program = new Command()
  .name('xui')
  .description('Make AI-generated 3D assets web-ready: analyze, optimize, scaffold.')
  .version('0.1.0');

program
  .command('analyze')
  .description('Analyze a GLB/glTF against a web performance budget.')
  .argument('<file>', 'path to .glb or .gltf')
  .option('-p, --profile <name>', `budget profile: ${Object.keys(PROFILES).join(' | ')}`, 'mobile-hero')
  .option('--json', 'emit JSON instead of the report card')
  .option('--no-topology', 'skip the topology pass (faster on huge meshes)')
  .action(async (file: string, opts: { profile: string; json?: boolean; topology: boolean }) => {
    const profile = getProfile(opts.profile);
    const bytes = await readFile(file);

    const io = await createIO();
    const doc = await io.readBinary(new Uint8Array(bytes));

    const result = analyze(doc, {
      profile,
      topology: opts.topology,
      filePath: file,
      fileBytes: bytes.byteLength,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printReport(result);
    }
    // CI contract: non-zero exit when the asset is over budget.
    process.exitCode = result.passed ? 0 : 1;
  });

program
  .command('optimize')
  .description('Optimize a GLB to fit a web performance budget, then re-analyze.')
  .argument('<file>', 'path to .glb')
  .option('-p, --profile <name>', `budget profile: ${Object.keys(PROFILES).join(' | ')}`, 'mobile-hero')
  .option('-o, --out <file>', 'output path (default: <name>.web.glb)')
  .option('--target <triangles>', 'override triangle target', (v) => parseInt(v, 10))
  .option('--lods <targets>', 'extra LOD files, comma-separated triangle counts (e.g. 50000,15000)')
  .option('--no-textures', 'skip texture resize/re-encode')
  .option('--no-compress', 'skip meshopt compression')
  .action(async (file: string, opts: {
    profile: string; out?: string; target?: number; lods?: string;
    textures: boolean; compress: boolean;
  }) => {
    const outPath = opts.out ?? file.replace(/\.glb$/i, '') + '.web.glb';
    const passed = await optimizeFile(file, outPath, opts.profile, {
      target: opts.target, textures: opts.textures,
      compress: opts.compress, lods: opts.lods,
    });
    process.exitCode = passed ? 0 : 1;
  });

program
  .command('extrude')
  .description('Deterministic logo/graphic -> extruded 3D GLB (no AI). Traces the image silhouette and projects the source image back on as texture.')
  .argument('<image>', 'PNG/JPEG/WebP with transparent or white background')
  .option('-o, --out <file>', 'output GLB path (default: <name>.glb)')
  .option('--mode <mode>', 'solid-pixel test: alpha | luma (auto-detected)')
  .option('--threshold <n>', '0-255 cutoff for the mode', (v) => parseInt(v, 10))
  .option('--depth <m>', 'extrusion depth in meters', parseFloat)
  .option('--bevel <m>', 'bevel radius on both rims (signage look)', parseFloat, 0)
  .option('--bevel-segments <n>', 'bevel roundness: 1=chamfer, 3=rounded', (v) => parseInt(v, 10), 3)
  .option('--width <m>', 'world width in meters', parseFloat, 1)
  .option('--simplify <px>', 'contour simplification tolerance', parseFloat, 1.2)
  .option('--no-texture', 'flat color instead of projected source image')
  .option('--color <hex>', 'base color when --no-texture, e.g. #ff2266')
  .option('--metallic <n>', 'metallic factor 0-1', parseFloat, 0)
  .option('--roughness <n>', 'roughness factor 0-1', parseFloat, 0.6)
  .action(async (image: string, opts: {
    out?: string; mode?: 'alpha' | 'luma'; threshold?: number; depth?: number;
    bevel: number; bevelSegments: number;
    width: number; simplify: number; texture: boolean; color?: string;
    metallic: number; roughness: number;
  }) => {
    const outPath = opts.out ?? image.replace(/\.[a-z0-9]+$/i, '') + '.glb';
    const bytes = await readFile(image);
    const color = opts.color
      ? ([1, 3, 5].map((i) => parseInt(opts.color!.replace('#', '').padEnd(6, '0').slice(i - 1, i + 1), 16) / 255)
          .concat(1) as [number, number, number, number])
      : undefined;

    const { doc, stats } = await extrudeImage(new Uint8Array(bytes), {
      mode: opts.mode, threshold: opts.threshold, depth: opts.depth,
      bevel: opts.bevel, bevelSegments: opts.bevelSegments,
      width: opts.width, simplify: opts.simplify,
      texture: opts.texture, color, metallic: opts.metallic, roughness: opts.roughness,
    });

    const io = await createIO();
    const outBytes = await io.writeBinary(doc);
    await writeFile(outPath, outBytes);
    console.log(
      `  ${outPath} (${(outBytes.byteLength / 1048576).toFixed(1)}MB)  ` +
      `${stats.outerLoops} shape(s), ${stats.holes} hole(s), ` +
      `${stats.triangles.toLocaleString()} tris  [mode=${stats.mode}]`,
    );
  });

program
  .command('scaffold')
  .description('Emit a minimal Vite + React Three Fiber viewer for a GLB.')
  .argument('<file>', 'path to (optimized) .glb')
  .option('-o, --out <dir>', 'output directory', 'viewer')
  .action(async (file: string, opts: { out: string }) => {
    await scaffoldViewer(file, opts.out);
    console.log(`Viewer scaffolded in ${opts.out}/`);
    console.log(`  cd ${opts.out} && pnpm install && pnpm dev`);
  });

registerMeshyCommands(program, (input, output, profileName) =>
  optimizeFile(input, output, profileName));

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
