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
import { analyze, extrudeImage, getProfile, optimize, PROFILES, stripMaterials, toStl } from '@glbforge/core';
import { printDiff, printReport } from './report.js';
import { scaffoldViewer } from './scaffold.js';
import { registerMeshyCommands } from './meshy-cmd.js';
import { loadDotEnv } from './env.js';

loadDotEnv();

/**
 * Shared analyze -> optimize -> write -> re-analyze pipeline; returns
 * whether the written asset passes the profile. Used by `glbforge optimize`
 * and by `glbforge meshy … --optimize`.
 */
async function optimizeFile(
  input: string,
  output: string,
  profileName: string,
  extra: {
    target?: number; textures?: boolean; compress?: boolean; lods?: string;
    json?: boolean; textureFormat?: 'webp' | 'ktx2';
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
    textureFormat: extra.textureFormat,
    log: extra.json ? undefined : (msg) => console.log('  ' + msg),
  });

  const outBytes = await io.writeBinary(doc);
  await writeFile(output, outBytes);

  // Re-analyze the actual written file so the diff reflects reality.
  const after = analyze(await io.readBinary(outBytes), {
    profile, topology: false, filePath: output, fileBytes: outBytes.byteLength,
  });
  if (extra.json) {
    console.log(JSON.stringify({
      outPath: output,
      steps: summary.steps,
      before: { triangles: before.geometry.triangles, bytes: bytes.byteLength, score: before.score },
      after,
      savedPct: Math.round((1 - outBytes.byteLength / bytes.byteLength) * 1000) / 10,
    }, null, 2));
  } else {
    printDiff(before, after, summary.steps);
  }

  // Optional LOD chain: simplify further from the already-optimized doc.
  if (extra.lods) {
    const targets = extra.lods.split(',').map((t) => parseInt(t.trim(), 10));
    for (let i = 0; i < targets.length; i++) {
      const lodDoc = await io.readBinary(outBytes);
      lodDoc.setLogger(new Logger(Logger.Verbosity.ERROR));
      // LOD files are geometry-only; the viewer reuses the primary's materials.
      stripMaterials(lodDoc);
      await optimize(lodDoc, {
        profile, targetTriangles: targets[i],
        textures: false, compress: extra.compress,
      });
      const lodPath = output.replace(/\.glb$/i, `.lod${i + 1}.glb`);
      const lodBytes = await io.writeBinary(lodDoc);
      await writeFile(lodPath, lodBytes);
      if (!extra.json) console.log(`  lod${i + 1}: ${lodPath} (${(lodBytes.byteLength / 1048576).toFixed(1)}MB, target ${targets[i].toLocaleString()} tris)`);
    }
  }
  return after.passed;
}

const program = new Command()
  .name('glbforge')
  .description('GLBForge — make AI-generated 3D assets web-ready: analyze, optimize, extrude, scaffold.')
  .version('0.3.0');

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
  .option('--ktx2', 'encode textures as KTX2/BasisU (GPU-resident, ~8x less video memory; needs basisu or toktx installed)')
  .option('--json', 'emit JSON instead of the diff table')
  .action(async (file: string, opts: {
    profile: string; out?: string; target?: number; lods?: string;
    textures: boolean; compress: boolean; json?: boolean; ktx2?: boolean;
  }) => {
    const outPath = opts.out ?? file.replace(/\.glb$/i, '') + '.web.glb';
    const passed = await optimizeFile(file, outPath, opts.profile, {
      target: opts.target, textures: opts.textures,
      compress: opts.compress, lods: opts.lods, json: opts.json,
      textureFormat: opts.ktx2 ? 'ktx2' : 'webp',
    });
    process.exitCode = passed ? 0 : 1;
  });

program
  .command('extrude')
  .description('Deterministic logo/graphic -> extruded 3D GLB (no AI). Traces the image silhouette and projects the source image back on as texture.')
  .argument('<image>', 'PNG/JPEG/WebP/SVG with transparent or white background')
  .option('-o, --out <file>', 'output GLB path (default: <name>.glb)')
  .option('--mode <mode>', 'solid-pixel test: alpha | luma (auto-detected)')
  .option('--threshold <n>', '0-255 cutoff for the mode', (v) => parseInt(v, 10))
  .option('--depth <m>', 'extrusion depth in meters', parseFloat)
  .option('--bevel <m>', 'bevel radius on both rims (signage look)', parseFloat, 0)
  .option('--layers <n>', 'layered color extrusion: quantize into N color layers (2-6)', (v) => parseInt(v, 10))
  .option('--layer-step <m>', 'extra depth per layer in meters', parseFloat)
  .option('--pillow <m>', 'puffy-sticker dome height in meters (supersedes bevel)', parseFloat)
  .option('--emboss <m>', 'luminance micro-relief in meters (bright rises; try depth*0.15)', parseFloat)
  .option('--preset <name>', 'material preset: enamel | chrome | neon | acrylic | rubber')
  .option('--bevel-segments <n>', 'bevel roundness: 1=chamfer, 3=rounded', (v) => parseInt(v, 10), 3)
  .option('--width <m>', 'world width in meters', parseFloat, 1)
  .option('--simplify <px>', 'contour simplification tolerance', parseFloat, 1.2)
  .option('--no-texture', 'flat color instead of projected source image')
  .option('--color <hex>', 'base color when --no-texture, e.g. #ff2266')
  .option('--metallic <n>', 'metallic factor 0-1', parseFloat, 0)
  .option('--roughness <n>', 'roughness factor 0-1', parseFloat, 0.6)
  .option('--json', 'emit JSON stats instead of the summary line')
  .action(async (image: string, opts: {
    out?: string; mode?: 'alpha' | 'luma'; threshold?: number; depth?: number;
    bevel: number; bevelSegments: number; layers?: number; layerStep?: number;
    pillow?: number; emboss?: number; preset?: 'enamel' | 'chrome' | 'neon' | 'acrylic' | 'rubber';
    width: number; simplify: number; texture: boolean; color?: string;
    metallic: number; roughness: number; json?: boolean;
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
      layers: opts.layers, layerStep: opts.layerStep,
      pillow: opts.pillow, emboss: opts.emboss, preset: opts.preset,
      width: opts.width, simplify: opts.simplify,
      texture: opts.texture, color, metallic: opts.metallic, roughness: opts.roughness,
    });

    const io = await createIO();
    const outBytes = await io.writeBinary(doc);
    await writeFile(outPath, outBytes);
    if (opts.json) {
      console.log(JSON.stringify({ outPath, bytes: outBytes.byteLength, ...stats }, null, 2));
    } else {
      const layerNote = stats.layerInfo ? `, ${stats.layerInfo.length} layers` : '';
      console.log(
        `  ${outPath} (${(outBytes.byteLength / 1048576).toFixed(1)}MB)  ` +
        `${stats.outerLoops} shape(s), ${stats.holes} hole(s)${layerNote}, ` +
        `${stats.triangles.toLocaleString()} tris  [mode=${stats.mode}]`,
      );
    }
  });

program
  .command('gen')
  .description('Image → true 3D via open models on fal.ai (Hunyuan3D, TRELLIS, TripoSR). Needs FAL_KEY.')
  .argument('<image>', 'path to the source image')
  .option('--model <name>', 'hunyuan | trellis | triposr', 'hunyuan')
  .option('--no-texture', 'geometry only (faster; Hunyuan skips its paint stage)')
  .option('-o, --out <file>', 'output GLB path', 'gen-output.glb')
  .option('--optimize', 'run glbforge optimize on the result')
  .option('-p, --profile <name>', 'budget profile for --optimize', 'mobile-hero')
  .action(async (image: string, opts: { model: string; out: string; optimize?: boolean; profile: string; texture: boolean }) => {
    const { FAL_MODELS, FalClient } = await import('@glbforge/meshy');
    const model = FAL_MODELS[opts.model as keyof typeof FAL_MODELS];
    if (!model) throw new Error(`Unknown model "${opts.model}" (hunyuan | trellis | triposr)`);
    const ext = image.toLowerCase().split('.').pop() ?? '';
    const mime = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' } as Record<string, string>)[ext];
    if (!mime) throw new Error(`Unsupported image extension ".${ext}"`);
    const bytes = await readFile(image);

    const client = new FalClient();
    const requestId = await client.submit(model, `data:${mime};base64,${bytes.toString('base64')}`, { textured: opts.texture });
    console.log(`  ${model} request ${requestId}`);
    for (;;) {
      const st = await client.status(model, requestId);
      process.stdout.write(`\r  ${st.status.toLowerCase().padEnd(12)}${st.queuePosition !== null ? ` queue #${st.queuePosition}` : ''}   `);
      if (st.status === 'COMPLETED') break;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    process.stdout.write('\n');
    const glb = await client.downloadGlb(await client.resultGlbUrl(model, requestId));
    await writeFile(opts.out, glb);
    console.log(`  saved ${opts.out} (${(glb.byteLength / 1048576).toFixed(1)}MB)`);
    if (opts.optimize) {
      const passed = await optimizeFile(opts.out, opts.out.replace(/\.glb$/i, '') + '.web.glb', opts.profile);
      process.exitCode = passed ? 0 : 1;
    }
  });

program
  .command('ui')
  .description('Open GLBForge Studio — a local web UI for the whole pipeline.')
  .argument('[files...]', 'GLB files to preload into the asset rail')
  .option('--port <n>', 'port to serve on', (v) => parseInt(v, 10), 5177)
  .option('-p, --profile <name>', 'default budget profile', 'mobile-hero')
  .action(async (files: string[], opts: { port: number; profile: string }) => {
    const { startUiServer } = await import('./ui-server.js');
    await startUiServer({ port: opts.port, preload: files, profile: opts.profile });
    // Keep serving until interrupted.
    await new Promise(() => {});
  });

program
  .command('watch')
  .description('Watch a directory: new or changed GLBs are analyzed and optimized automatically.')
  .argument('<dir>', 'directory to watch')
  .option('-p, --profile <name>', `budget profile: ${Object.keys(PROFILES).join(' | ')}`, 'mobile-hero')
  .option('--ktx2', 'encode textures as KTX2 in the outputs')
  .action(async (dir: string, opts: { profile: string; ktx2?: boolean }) => {
    const { watch } = await import('node:fs');
    const { stat } = await import('node:fs/promises');
    const { join: joinPath } = await import('node:path');

    console.log(`Watching ${dir} for GLBs (profile: ${opts.profile}) — Ctrl-C to stop.`);
    // Debounce per file: exports are written in chunks; wait for quiet.
    const timers = new Map<string, NodeJS.Timeout>();
    const seen = new Map<string, number>();

    watch(dir, (_event, filename) => {
      if (!filename || !/\.glb$/i.test(filename)) return;
      if (/\.web(\.lod\d+)?\.glb$/i.test(filename)) return; // our own outputs
      const full = joinPath(dir, filename);
      clearTimeout(timers.get(full));
      timers.set(full, setTimeout(async () => {
        try {
          const info = await stat(full);
          if (seen.get(full) === info.mtimeMs) return;
          seen.set(full, info.mtimeMs);
          console.log(`\n→ ${filename}`);
          const outPath = full.replace(/\.glb$/i, '') + '.web.glb';
          await optimizeFile(full, outPath, opts.profile, {
            textureFormat: opts.ktx2 ? 'ktx2' : 'webp',
          });
        } catch (err) {
          console.error(`  ${filename}: ${err instanceof Error ? err.message : err}`);
        }
      }, 750));
    });
    // Keep the process alive.
    await new Promise(() => {});
  });

program
  .command('stl')
  .description('Export a GLB as binary STL for 3D printing (scaled to mm, z-up).')
  .argument('<file>', 'path to .glb')
  .option('-o, --out <file>', 'output path (default: <name>.stl)')
  .option('--size <mm>', 'largest printed dimension in millimeters', parseFloat, 80)
  .option('--json', 'emit JSON stats')
  .action(async (file: string, opts: { out?: string; size: number; json?: boolean }) => {
    const outPath = opts.out ?? file.replace(/\.glb$/i, '') + '.stl';
    const bytes = await readFile(file);
    const io = await createIO();
    const doc = await io.readBinary(new Uint8Array(bytes));

    // Printability check: slicers want watertight geometry.
    const report = analyze(doc, { profile: getProfile('mobile-hero') });
    const topo = report.geometry.topology!;

    const { stl, triangles, sizeMm } = toStl(doc, { targetSizeMm: opts.size });
    await writeFile(outPath, stl);

    const dims = sizeMm.map((v) => v.toFixed(1)).join(' x ');
    if (opts.json) {
      console.log(JSON.stringify({
        outPath, bytes: stl.byteLength, triangles, sizeMm,
        watertight: topo.boundaryEdges === 0 && topo.nonManifoldEdges === 0,
        boundaryEdges: topo.boundaryEdges, nonManifoldEdges: topo.nonManifoldEdges,
      }, null, 2));
    } else {
      console.log(`  ${outPath} (${(stl.byteLength / 1048576).toFixed(1)}MB)  ${triangles.toLocaleString()} tris, prints ${dims} mm`);
      if (topo.boundaryEdges > 0 || topo.nonManifoldEdges > 0) {
        console.log(`  ⚠ not watertight (${topo.boundaryEdges} boundary, ${topo.nonManifoldEdges} non-manifold edges) — most slicers will auto-repair, but check the result.`);
      } else {
        console.log('  ✓ watertight — print-ready');
      }
    }
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
  const e = err as NodeJS.ErrnoException;
  if (e?.code === 'ENOENT' && e.path) {
    console.error(`File not found: ${e.path}`);
  } else {
    console.error(err instanceof Error ? err.message : err);
  }
  process.exit(1);
});
