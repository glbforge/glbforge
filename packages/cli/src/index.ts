#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
import { alignmentScore, analyze, applyPerceptualVerdict, auditDirectory, buildLod, cliSession, clearUsage, diffAssets, extrudeImage, getProfile, inspectScene, loadScene, optimize, OUTPUT_PATTERN, PACK_VERSIONS, perceptualDiff, PROFILES, recordUsage, renderViews, RULE_PROFILE_VERSIONS, setUsageEnabled, sharpTextureDecoder, toStl, toUsdz, usageSummary } from '@glbforge/core';
import { resolve as resolvePath } from 'node:path';

/** Opt-in local usage event (see core/usage.ts); never throws, never networked. */
const usage = (tool: string, path: string, extra: { sha256?: string | null; edge?: { from: string; to: string } | null; lineage?: string | null; duration_ms: number; ok: boolean }) =>
  recordUsage({ tool, surface: 'cli', session: cliSession(), path: resolvePath(path), sha256: extra.sha256 ?? null, edge: extra.edge ?? null, lineage: extra.lineage ?? null, duration_ms: extra.duration_ms, ok: extra.ok });
import { printDiff, printDiffReport, printInspect, printReport } from './report.js';
import { scaffoldViewer } from './scaffold.js';
import { registerMeshyCommands } from './meshy-cmd.js';
import { cliVersion, registerInitCommand } from './init.js';
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
    json?: boolean; textureFormat?: 'webp' | 'ktx2'; verify?: boolean;
    /** Print nothing; the caller owns the output (ship --json embeds the report). */
    silent?: boolean;
  } = {},
): Promise<{ passed: boolean; report: Record<string, unknown> }> {
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
    verify: extra.verify,
    log: extra.json || extra.silent ? undefined : (msg) => console.log('  ' + msg),
  });

  const outBytes = await io.writeBinary(doc);
  await writeFile(output, outBytes);

  // Re-analyze the actual written file so the diff reflects reality.
  const after = analyze(await io.readBinary(outBytes), {
    profile, topology: false, filePath: output, fileBytes: outBytes.byteLength,
  });
  // The measured visual verdict is part of the report card: a failing SSIM
  // fails the budget like any perf/* rule.
  if (summary.perceptual) applyPerceptualVerdict(after, summary.perceptual);
  if (!extra.json && !extra.silent) printDiff(before, after, summary.steps, summary.perceptual, summary.fidelityBound);

  // Optional LOD chain: simplify further from the already-optimized doc.
  const lodFiles: Array<{ path: string; bytes: number; triangles: number; target: number; method: string }> = [];
  if (extra.lods) {
    const targets = extra.lods.split(',').map((t) => parseInt(t.trim(), 10));
    for (let i = 0; i < targets.length; i++) {
      const lodDoc = await io.readBinary(outBytes);
      lodDoc.setLogger(new Logger(Logger.Verbosity.ERROR));
      const lod = await buildLod(lodDoc, targets[i], { profile, compress: extra.compress });
      const lodPath = output.replace(/\.glb$/i, `.lod${i + 1}.glb`);
      const lodBytes = await io.writeBinary(lodDoc);
      await writeFile(lodPath, lodBytes);
      lodFiles.push({ path: lodPath, bytes: lodBytes.byteLength, triangles: lod.triangles, target: targets[i], method: lod.method });
      if (!extra.json && !extra.silent) {
        console.log(`  lod${i + 1}: ${lodPath} (${(lodBytes.byteLength / 1048576).toFixed(1)}MB, ${lod.triangles.toLocaleString()} tris, target ${targets[i].toLocaleString()}${lod.method === 'cluster' ? ', grid-clustered' : ''})`);
      }
    }
  }
  const report = {
    outPath: output,
    sha256: createHash('sha256').update(outBytes).digest('hex'),
    steps: summary.steps,
    fidelityBound: summary.fidelityBound,
    perceptual: summary.perceptual,
    before: { triangles: before.geometry.triangles, bytes: bytes.byteLength, score: before.score },
    after,
    savedPct: Math.round((1 - outBytes.byteLength / bytes.byteLength) * 1000) / 10,
    lods: lodFiles,
  };
  if (extra.json && !extra.silent) console.log(JSON.stringify(report, null, 2));
  return { passed: after.passed, report };
}

// `glbforge analyze x.glb | head -1` closes our stdout mid-write. Node turns
// that into an unhandled EPIPE and a stack trace, which is a crash report for
// something the user asked for. Swallow it and carry on: the process still
// exits with the code it earned, because that exit code is this CLI's contract
// (a budget failure piped into `head` must not silently become success).
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE' && err.code !== 'ERR_STREAM_DESTROYED') throw err;
  });
}

const program = new Command()
  .name('glbforge')
  .description('GLBForge — make AI-generated 3D assets web-ready: analyze, optimize, extrude, scaffold.')
  .version(cliVersion());

program
  .command('analyze')
  .description('Analyze a GLB/glTF against a web performance budget.')
  .argument('<file>', 'path to .glb or .gltf')
  .option('-p, --profile <name>', `budget profile: ${Object.keys(PROFILES).join(' | ')} (pin a version: mobile-hero@1)`, 'mobile-hero')
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
    await usage('analyze', file, { sha256: createHash('sha256').update(bytes).digest('hex'), duration_ms: 0, ok: true });
  });

program
  .command('inspect')
  .description('Semantic read of a mesh for the edit loop: one shell or floating pieces, watertight or not, size in metres, up axis, origin placement, unapplied transforms — named, versioned rules with causes and fixes. Sub-second; run it after every edit.')
  .argument('<file>', 'path to .glb / .gltf / .usdz / .usda / .usdc')
  .option('-p, --profile <name>', `rule profile deciding severities: ${Object.keys(RULE_PROFILE_VERSIONS).join(' | ')} or a budget profile (${Object.keys(PROFILES).join(' | ')}); pin with name@N`, 'authoring')
  .option('--packs <list>', `comma-separated rule packs instead of the profile's (${Object.keys(PACK_VERSIONS).join(', ')}; pin with name@N)`)
  .option('--no-topology', 'skip the welded topology pass (shells / watertight rules are reported as skipped)')
  .option('-e, --expect <spec>', 'what you meant to make, checked as a contract: e.g. "chair, Z-up, meters, single-shell, 0.4-1.2m tall, front -Y, watertight, origin base". Violations are errors (exit 1); a bare category gives a plausibility warning; front is recorded, never measured')
  .option('--strict', 'exit 1 on warnings as well as errors')
  .option('--lineage <id>', 'name this asset across renames for the local opt-in usage counter (see `glbforge usage`)')
  .option('--json', 'emit the full report as JSON')
  .action(async (file: string, opts: { profile: string; packs?: string; topology: boolean; expect?: string; strict?: boolean; lineage?: string; json?: boolean }) => {
    const t0 = performance.now();
    const loaded = await loadScene(file);
    const report = inspectScene(loaded.ir, {
      profile: opts.profile,
      topology: opts.topology,
      packs: opts.packs ? opts.packs.split(',').map((p) => p.trim()).filter(Boolean) : undefined,
      expect: opts.expect,
    });
    const duration_ms = Math.round(performance.now() - t0);
    if (opts.json) console.log(JSON.stringify({ path: file, ...report, duration_ms }, null, 2));
    else printInspect(report, file, duration_ms);
    const failing = report.findings.some((f) => f.severity === 'error' || (opts.strict && f.severity === 'warning'));
    process.exitCode = failing ? 1 : 0;
    await usage('inspect', file, { sha256: createHash('sha256').update(loaded.bytes).digest('hex'), lineage: opts.lineage, duration_ms, ok: true });
  });

program
  .command('diff')
  .description('What changed between two versions of an asset, including what the edit broke: size / triangle / shell deltas per part, topology regressions (was watertight, now is not), origin drift, node transforms, meshes added or removed, and (--visual) a front/side/top/iso render delta with cameras fixed to the before framing.')
  .argument('<before>', 'the earlier file (.glb / .gltf / .usdz / .usda / .usdc)')
  .argument('<after>', 'the later file')
  .option('-p, --profile <name>', `rule profile deciding severities: ${Object.keys(RULE_PROFILE_VERSIONS).join(' | ')} or a budget profile (${Object.keys(PROFILES).join(' | ')})`, 'authoring')
  .option('--visual', 'also render four canonical views of both and score SSIM per view (~150 ms per file at 128 px)')
  .option('--size <px>', 'pixels per view for --visual', (v) => parseInt(v, 10), 128)
  .option('--no-topology', 'skip the welded topology pass (shell / watertight deltas become null)')
  .option('--strict', 'exit 1 on warnings (regressions) as well as errors')
  .option('--lineage <id>', 'name this asset across renames for the local opt-in usage counter (see `glbforge usage`)')
  .option('--json', 'emit the full report as JSON')
  .action(async (before: string, after: string, opts: { profile: string; visual?: boolean; size: number; topology: boolean; strict?: boolean; lineage?: string; json?: boolean }) => {
    const t0 = performance.now();
    const [b, a] = await Promise.all([loadScene(before), loadScene(after)]);
    const report = await diffAssets(b.ir, a.ir, { profile: opts.profile, topology: opts.topology, visual: opts.visual, visualSize: opts.size });
    const duration_ms = Math.round(performance.now() - t0);
    const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    const lineage = { before_sha256: sha(b.bytes), after_sha256: sha(a.bytes) };
    if (opts.json) console.log(JSON.stringify({ ...report, lineage, duration_ms }, null, 2));
    else printDiffReport(report, before, after, duration_ms);
    const failing = report.findings.some((f) => f.severity === 'error' || (opts.strict && f.severity === 'warning'));
    process.exitCode = failing ? 1 : 0;
    await usage('diff', after, { sha256: lineage.after_sha256, edge: { from: lineage.before_sha256, to: lineage.after_sha256 }, lineage: opts.lineage, duration_ms, ok: true });
  });

program
  .command('usage')
  .description('The local, opt-in usage counter: invocations per asset (lineage-aware), sessions, tools. Nothing is ever sent anywhere; the log is a JSONL file you can read and delete.')
  .option('--enable', 'opt in: write { "usage": true } to the config dir (or set GLBFORGE_USAGE=1 per shell)')
  .option('--disable', 'opt out')
  .option('--clear', 'delete the log')
  .option('--since <days>', 'only count events from the last N days', parseFloat)
  .option('--threshold <n>', 'invocations per lineage that count as "in the loop"', (v) => parseInt(v, 10), 5)
  .option('--json', 'emit JSON')
  .action(async (opts: { enable?: boolean; disable?: boolean; clear?: boolean; since?: number; threshold: number; json?: boolean }) => {
    if (opts.enable) console.log(`  usage counter enabled → ${await setUsageEnabled(true)}`);
    if (opts.disable) console.log(`  usage counter disabled → ${await setUsageEnabled(false)}`);
    if (opts.clear) { await clearUsage(); console.log('  usage log cleared'); }
    const r = await usageSummary({ since: opts.since ? Date.now() - opts.since * 86_400_000 : undefined, innerLoopThreshold: opts.threshold });
    if (opts.json) return void console.log(JSON.stringify(r, null, 2));
    console.log(`  ${r.enabled ? 'enabled' : 'disabled'} · ${r.file}`);
    if (!r.events) { console.log(r.enabled ? '  no events yet — run inspect / diff and come back' : '  opt in with `glbforge usage --enable` or GLBFORGE_USAGE=1; nothing leaves this machine'); return; }
    console.log(`  ${r.events} invocations across ${r.lineages} asset lineage${r.lineages === 1 ? '' : 's'} in ${r.sessions} session${r.sessions === 1 ? '' : 's'}${r.window.from ? `  (${r.window.from.slice(0, 10)} → ${r.window.to!.slice(0, 10)})` : ''}`);
    const m = r.invocations_per_lineage;
    console.log(`  invocations per asset   median ${m.median}   p90 ${m.p90}   mean ${m.mean}   max ${m.max}`);
    console.log(`  in the loop (≥ ${r.inner_loop_threshold})       ${(r.inner_loop_share * 100).toFixed(0)}% of assets`);
    console.log(`  tools                   ${Object.entries(r.tools).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    console.log(`  distribution            ${r.distribution.slice(0, 12).join(' ')}${r.distribution.length > 12 ? ' …' : ''}`);
  });

program
  .command('optimize')
  .description('Optimize a GLB to fit a web performance budget, then re-analyze.')
  .argument('<file>', 'path to .glb')
  .option('-p, --profile <name>', `budget profile: ${Object.keys(PROFILES).join(' | ')} (pin a version: mobile-hero@1)`, 'mobile-hero')
  .option('-o, --out <file>', 'output path (default: <name>.web.glb)')
  .option('--target <triangles>', 'override triangle target', (v) => parseInt(v, 10))
  .option('--lods <targets>', 'extra LOD files, comma-separated triangle counts (e.g. 50000,15000)')
  .option('--no-textures', 'skip texture resize/re-encode')
  .option('--no-compress', 'skip meshopt compression')
  .option('--ktx2', 'encode textures as KTX2/BasisU (GPU-resident, ~8x less video memory; needs basisu or toktx installed)')
  .option('--no-verify', 'skip perceptual verification (SSIM of fixed-camera renders before vs after)')
  .option('--json', 'emit JSON instead of the diff table')
  .action(async (file: string, opts: {
    profile: string; out?: string; target?: number; lods?: string;
    textures: boolean; compress: boolean; json?: boolean; ktx2?: boolean; verify: boolean;
  }) => {
    const outPath = opts.out ?? file.replace(/\.glb$/i, '') + '.web.glb';
    const { passed } = await optimizeFile(file, outPath, opts.profile, {
      target: opts.target, textures: opts.textures,
      compress: opts.compress, lods: opts.lods, json: opts.json,
      textureFormat: opts.ktx2 ? 'ktx2' : 'webp', verify: opts.verify,
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
  .option('--layers <n>', 'layered color extrusion: quantize into N color layers (2-6), or "auto" to layer only artwork measured to be flat-coloured', (v) => {
    if (v === 'auto') return 'auto' as const;
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) throw new Error(`--layers takes 2-6 or "auto", got "${v}"`);
    return n;
  })
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
    bevel: number; bevelSegments: number; layers?: number | 'auto'; layerStep?: number;
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
      const layerNote = stats.layerInfo
        ? `, ${stats.layerInfo.length} layers`
        : stats.flatness ? `, 1 layer (${stats.flatness.distinct < 2 ? 'one colour' : 'not flat-coloured'})` : '';
      console.log(
        `  ${outPath} (${(outBytes.byteLength / 1048576).toFixed(1)}MB)  ` +
        `${stats.outerLoops} shape(s), ${stats.holes} hole(s)${layerNote}, ` +
        `${stats.triangles.toLocaleString()} tris  [mode=${stats.mode}]`,
      );
    }
  });

program
  .command('ship')
  .description('Anything → web-ready, one command: GLBs are optimized to budget; flat artwork is forged; photos are generated (FAL_KEY/MESHY_API_KEY) — then analyzed, optimized, and budget-gated.')
  .argument('<input>', 'a .glb, or an image (png/jpg/webp/svg)')
  .option('-p, --profile <name>', `budget profile: ${Object.keys(PROFILES).join(' | ')} (pin a version: mobile-hero@1)`, 'mobile-hero')
  .option('-o, --out <file>', 'output path (default: <input>.web.glb)')
  .option('--prefer <route>', 'force image routing: forge | gen')
  .option('--model <name>', 'generator for photos: hunyuan | trellis | triposr | meshy', 'hunyuan')
  .option('--ktx2', 'KTX2 textures (GPU-resident)')
  .option('--lods <targets>', 'LOD chain triangle targets, e.g. 40000,10000')
  .option('--no-verify', 'skip perceptual verification of the optimization')
  .option('--json', 'emit one JSON document: the route taken, the intermediate, and the optimization report')
  .action(async (input: string, opts: {
    profile: string; out?: string; prefer?: 'forge' | 'gen';
    model: string; ktx2?: boolean; lods?: string; verify: boolean; json?: boolean;
  }) => {
    // What ship DECIDED, which is the half an agent cannot recover from the
    // optimize report: which route, and what the forge made of the artwork.
    let routing: Record<string, unknown> = { routed: 'glb' };
    const say = (line: string) => { if (!opts.json) console.log(line); };

    const finish = async (glbPath: string) => {
      // Always named for the INPUT, never for the intermediate, so the
      // routes agree: photo.png → photo.web.glb whether it was forged or generated.
      const outPath = opts.out ?? input.replace(/\.(glb|png|jpe?g|webp|svg)$/i, '') + '.web.glb';
      const { passed, report } = await optimizeFile(glbPath, outPath, opts.profile, {
        textureFormat: opts.ktx2 ? 'ktx2' : 'webp', lods: opts.lods, verify: opts.verify,
        silent: opts.json,
      });
      if (opts.json) {
        console.log(JSON.stringify({
          input, ...routing, source: glbPath, outPath, passed, optimize: report,
        }, null, 2));
      }
      process.exitCode = passed ? 0 : 1;
    };

    if (/\.glb$/i.test(input)) return finish(input);
    if (!/\.(png|jpe?g|webp|svg)$/i.test(input)) {
      throw new Error('ship takes a .glb or an image (png/jpg/webp/svg)');
    }

    // Image: forge first (instant, free, exact) unless the tracer says the
    // input is photographic — then route to a generative model.
    const raw = new Uint8Array(await readFile(input));
    // Our own namespace (`*.forge.glb`, like `*.web.glb`) — never `<input>.glb`,
    // which is a file the user may well have authored themselves.
    const forged = input.replace(/\.[a-z0-9]+$/i, '') + '.forge.glb';
    const generated = input.replace(/\.[a-z0-9]+$/i, '') + '.gen.glb';
    if (opts.prefer !== 'gen') {
      try {
        // layers: 'auto' — flat-colour artwork gets the layered look, a
        // gradient or a painting stays one shell instead of becoming stacked
        // slabs with noisy contours (hundreds of thousands of triangles).
        // maxReliefTriangles: a sticker that has to be simplified back down to
        // the budget loses at the SSIM gate what the subdivision bought.
        const { doc, stats } = await extrudeImage(raw, { layers: 'auto', pillow: 0.02, maxReliefTriangles: 24_000 });
        const io = await createIO();
        await writeFile(forged, await io.writeBinary(doc));
        const f = stats.flatness;
        const why = !f ? ''
          : f.distinct < 2 ? ' (one colour — nothing to layer)'
          : ` (not flat-coloured: its ${f.distinct} dominant colours cover only ${(f.coverage * 100).toFixed(0)}%)`;
        const shape = stats.layerInfo
          ? `${stats.layerInfo.length} colour layers${f ? ` (${(f.coverage * 100).toFixed(0)}% of the artwork)` : ''}`
          : `one shell${why}`;
        routing = {
          routed: 'forge',
          forge: {
            path: forged, triangles: stats.triangles, vertices: stats.vertices,
            layers: stats.layerInfo?.length ?? 1, flatness: f ?? null,
          },
        };
        say(`  routed to forge → ${forged}: ${stats.triangles.toLocaleString()} tris, ${shape}`);
        const { collectSample } = await import('./collect.js');
        await collectSample({
          provenance: 'forge', glbPath: forged, sourceImagePath: input,
          meta: { generator: 'glbforge-extrude', via: 'ship', triangles: stats.triangles },
        });
        return finish(forged);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (opts.prefer === 'forge' || !/photograph|noisy mask/i.test(message)) throw err;
        routing = { routed: 'generation', reason: 'photographic input' };
        say('  routed to generation (photographic input)');
      }
    }

    if (opts.model === 'meshy') {
      const { MeshyClient } = await import('@glbforge/meshy');
      const client = new MeshyClient();
      const ext = input.toLowerCase().split('.').pop() ?? '';
      const mime = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' } as Record<string, string>)[ext];
      const taskId = await client.createImageTo3D({
        image_url: `data:${mime};base64,${Buffer.from(raw).toString('base64')}`,
        should_texture: true,
      });
      say(`  meshy task ${taskId}`);
      routing = { routed: 'generation', generator: { model: 'meshy-image-to-3d', taskId, path: generated } };
      const task = await client.waitForTask('image-to-3d', taskId, {
        onProgress: (t) => { if (!opts.json) process.stdout.write(`\r  ${t.status.toLowerCase()} ${t.progress}%   `); },
      });
      if (!opts.json) process.stdout.write('\n');
      await writeFile(generated, await client.downloadModel(task, 'glb'));
      const { collectSample } = await import('./collect.js');
      await collectSample({
        provenance: 'meshy-eval-only', glbPath: generated, sourceImagePath: input,
        meta: { generator: 'meshy-image-to-3d', via: 'ship' },
      });
      return finish(generated);
    }

    const { FAL_MODELS, FalClient } = await import('@glbforge/meshy');
    const model = FAL_MODELS[opts.model as keyof typeof FAL_MODELS];
    if (!model) throw new Error(`Unknown model "${opts.model}"`);
    const ext = input.toLowerCase().split('.').pop() ?? '';
    const mime = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' } as Record<string, string>)[ext];
    const fal = new FalClient();
    const requestId = await fal.submit(model, `data:${mime};base64,${Buffer.from(raw).toString('base64')}`);
    say(`  ${model} request ${requestId}`);
    routing = { routed: 'generation', generator: { model, requestId, path: generated } };
    for (;;) {
      const st = await fal.status(model, requestId);
      if (!opts.json) process.stdout.write(`\r  ${st.status.toLowerCase().padEnd(12)}   `);
      if (st.status === 'COMPLETED') break;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    if (!opts.json) process.stdout.write('\n');
    await writeFile(generated, await fal.downloadGlb(await fal.resultGlbUrl(model, requestId)));
    const { collectSample } = await import('./collect.js');
    await collectSample({
      provenance: 'open-models', glbPath: generated, sourceImagePath: input,
      meta: { generator: model, requestId, via: 'ship',
              licenseNote: opts.model === 'hunyuan' ? 'VERIFY Tencent community license before training' : 'MIT model output' },
    });
    return finish(generated);
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
    const { collectSample } = await import('./collect.js');
    await collectSample({
      provenance: opts.model === 'hunyuan' ? 'open-models' : 'open-models',
      glbPath: opts.out, sourceImagePath: image,
      meta: { generator: model, requestId, textured: opts.texture,
              licenseNote: opts.model === 'hunyuan' ? 'VERIFY Tencent community license before training' : 'MIT model output' },
    });
    if (opts.optimize) {
      const { passed } = await optimizeFile(opts.out, opts.out.replace(/\.glb$/i, '') + '.web.glb', opts.profile);
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
  .option('-p, --profile <name>', `budget profile: ${Object.keys(PROFILES).join(' | ')} (pin a version: mobile-hero@1)`, 'mobile-hero')
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
      if (OUTPUT_PATTERN.test(filename)) return; // our own outputs
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
  .command('audit')
  .description('Analyze every GLB in a directory against a budget (skips GLBForge outputs: *.web.glb, *.forge.glb, *.gen.glb). Exits non-zero when any asset fails — the `glb:check` script.')
  .argument('<dir>', 'directory containing GLBs')
  .option('-p, --profile <name>', `budget profile: ${Object.keys(PROFILES).join(' | ')} (pin a version: mobile-hero@1)`, 'mobile-hero')
  .option('-r, --recursive', 'descend into subdirectories (max depth 4)')
  .option('--limit <n>', 'max files to analyze', (v) => parseInt(v, 10), 50)
  .option('--json', 'emit JSON')
  .action(async (dir: string, opts: { profile: string; recursive?: boolean; limit: number; json?: boolean }) => {
    const audit = await auditDirectory(dir, { profile: getProfile(opts.profile), recursive: opts.recursive, limit: opts.limit });
    if (opts.json) {
      console.log(JSON.stringify(audit, null, 2));
    } else {
      for (const r of audit.results) {
        if (r.error) { console.log(`  ✗ ${r.path}  error: ${r.error}`); continue; }
        const mark = r.passed ? '✓' : '✗';
        console.log(`  ${mark} ${r.path}  ${String(r.score).padStart(3)}/100  ${r.triangles!.toLocaleString()} tris  ${(r.bytes! / 1048576).toFixed(1)}MB${r.passed ? '' : '  ' + r.topFinding}`);
      }
      console.log(`  ${audit.scanned} asset(s) audited against ${audit.profile}: ${audit.failing.length} failing${audit.truncated ? ` (${audit.truncated} more not scanned — raise --limit)` : ''}`);
    }
    process.exitCode = audit.failing.length === 0 && !audit.results.some((r) => r.error) ? 0 : 1;
  });

program
  .command('verify')
  .description('Measure visual fidelity between two GLBs: SSIM over fixed-camera renders, gated on the profile floor. E.g. verify model.web.glb model.glb')
  .argument('<candidate>', 'candidate .glb (e.g. the optimized file)')
  .argument('<reference>', 'reference .glb (e.g. the original)')
  .option('-p, --profile <name>', `budget profile supplying the SSIM floor: ${Object.keys(PROFILES).join(' | ')}`, 'mobile-hero')
  .option('--min-ssim <n>', 'override the SSIM floor (0..1)', parseFloat)
  .option('--size <px>', 'render size per view', (v) => parseInt(v, 10), 256)
  .option('--no-textures', 'compare geometry and shading only')
  .option('--json', 'emit JSON')
  .action(async (candidate: string, reference: string, opts: {
    profile: string; minSsim?: number; size: number; textures: boolean; json?: boolean;
  }) => {
    const io = await createIO();
    const candDoc = await io.readBinary(new Uint8Array(await readFile(candidate)));
    const refDoc = await io.readBinary(new Uint8Array(await readFile(reference)));
    const threshold = opts.minSsim ?? getProfile(opts.profile).minSsim;
    const result = await perceptualDiff(refDoc, candDoc, {
      size: opts.size, textureDecoder: opts.textures ? sharpTextureDecoder() : undefined,
    });
    const passed = result.ssimMin >= threshold;
    if (opts.json) {
      console.log(JSON.stringify({ ...result, threshold, passed }, null, 2));
    } else {
      const pct = (n: number) => (n * 100).toFixed(1) + '%';
      for (const v of result.views) console.log(`  ${v.name.padEnd(12)} SSIM ${pct(v.ssim)}   (coverage ${pct(v.coverage)})`);
      console.log(`  mean ${pct(result.ssimMean)}   min ${pct(result.ssimMin)} @ ${result.worstView}   floor ${pct(threshold)}${result.textured ? '' : '   (untextured)'}`);
      console.log(passed ? '  ✓ no visible loss by measurement' : '  ✗ visibly lossy');
    }
    process.exitCode = passed ? 0 : 1;
  });

program
  .command('align')
  .description('Score how faithfully a candidate mesh matches a reference (rigid alignment; proportion IoU, chamfer, F-scores). E.g. measure optimization fidelity: align model.web.glb model.glb')
  .argument('<candidate>', 'candidate .glb')
  .argument('<reference>', 'reference .glb')
  .option('--samples <n>', 'surface samples per mesh', (v) => parseInt(v, 10), 15000)
  .option('--json', 'emit JSON')
  .action(async (candidate: string, reference: string, opts: { samples: number; json?: boolean }) => {
    const io = await createIO();
    const candDoc = await io.readBinary(new Uint8Array(await readFile(candidate)));
    const refDoc = await io.readBinary(new Uint8Array(await readFile(reference)));
    const score = alignmentScore(candDoc, refDoc, { samples: opts.samples });
    if (opts.json) return void console.log(JSON.stringify(score, null, 2));
    console.log(`  proportion IoU   ${(score.proportion * 100).toFixed(1)}%`);
    console.log(`  chamfer          ${(score.chamfer * 100).toFixed(3)}% of extent`);
    console.log(`  F-score @1%      ${(score.fscore1 * 100).toFixed(1)}%`);
    console.log(`  F-score @2%      ${(score.fscore2 * 100).toFixed(1)}%`);
    if (score.rotation !== 0) console.log(`  (aligned via octahedral rotation #${score.rotation})`);
  });

program
  .command('dataset')
  .description('Render every GLB in a directory from a rig of known cameras — (image, mesh, camera) training pairs for fine-tuning image-to-3D models.')
  .argument('<dir>', 'directory of .glb files')
  .option('-o, --out <dir>', 'output dataset directory', 'dataset')
  .option('--size <px>', 'render resolution', (v) => parseInt(v, 10), 512)
  .action(async (dir: string, opts: { out: string; size: number }) => {
    const { readdir, mkdir, cp } = await import('node:fs/promises');
    const { join: joinPath, basename } = await import('node:path');
    const io = await createIO();
    const files = (await readdir(dir)).filter((f) => /\.glb$/i.test(f) && !/\.web(\.lod\d+)?\.glb$/i.test(f));
    const manifest: string[] = [];
    for (const file of files) {
      const name = basename(file, '.glb');
      const sampleDir = joinPath(opts.out, name);
      await mkdir(sampleDir, { recursive: true });
      const doc = await io.readBinary(new Uint8Array(await readFile(joinPath(dir, file))));
      const views = await renderViews(doc, { size: opts.size });
      const cameraIndex: Record<string, unknown> = {};
      for (const view of views) {
        await writeFile(joinPath(sampleDir, `${view.name}.png`), view.png);
        cameraIndex[view.name] = view.camera;
      }
      await writeFile(joinPath(sampleDir, 'cameras.json'), JSON.stringify(cameraIndex, null, 2));
      await cp(joinPath(dir, file), joinPath(sampleDir, 'mesh.glb'));
      manifest.push(JSON.stringify({ name, views: views.length, mesh: `${name}/mesh.glb` }));
      console.log(`  ${name}: ${views.length} views`);
    }
    await writeFile(joinPath(opts.out, 'manifest.jsonl'), manifest.join('\n') + '\n');
    console.log(`  dataset: ${files.length} sample(s) -> ${opts.out}/`);
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
  .command('usdz')
  .description('Export a GLB as USDZ for iOS AR Quick Look (binary usdc layer, UsdPreviewSurface materials, PNG/JPEG textures, 64-byte-aligned store-only zip). Skinned assets export a UsdSkel skeleton with the first animation clip sampled at 30 fps; morph targets become blend shapes.')
  .argument('<file>', 'path to .glb (an optimized .web.glb works — WebP is transcoded)')
  .option('-o, --out <file>', 'output path (default: <name>.usdz)')
  .option('--jpeg', 'encode opaque color textures as JPEG (smaller) instead of PNG')
  .option('--usda', 'write the layer as ASCII usda instead of binary usdc (debugging; ~10x larger)')
  .option('--json', 'emit JSON')
  .action(async (file: string, opts: { out?: string; jpeg?: boolean; usda?: boolean; json?: boolean }) => {
    const outPath = opts.out ?? file.replace(/\.glb$/i, '') + '.usdz';
    const io = await createIO();
    const doc = await io.readBinary(new Uint8Array(await readFile(file)));
    doc.setLogger(new Logger(Logger.Verbosity.ERROR));
    const result = await toUsdz(doc, { colorFormat: opts.jpeg ? 'jpeg' : 'png', format: opts.usda ? 'usda' : 'usdc' });
    await writeFile(outPath, result.usdz);
    if (opts.json) {
      console.log(JSON.stringify({ outPath, bytes: result.usdz.byteLength, ...result, usdz: undefined }, null, 2));
    } else {
      console.log(`  ${outPath} (${(result.usdz.byteLength / 1048576).toFixed(1)}MB)  ${result.meshes} mesh(es), ${result.triangles.toLocaleString()} tris, ${result.materials} material(s), ${result.textures} texture(s)${result.skeletons ? `, ${result.skeletons} skeleton(s)${result.frames ? ` + ${result.frames}-frame clip @30fps` : ''}` : ''}`);
      for (const w of result.warnings) console.log(`  ! ${w}`);
      console.log('  iOS: AirDrop or serve the .usdz; Safari opens it in AR Quick Look. <model-viewer ios-src="…">');
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

registerInitCommand(program);
registerMeshyCommands(program, async (input, output, profileName) =>
  (await optimizeFile(input, output, profileName)).passed);

program.parseAsync().catch((err) => {
  const e = err as NodeJS.ErrnoException;
  if (e?.code === 'ENOENT' && e.path) {
    console.error(`File not found: ${e.path}`);
  } else {
    console.error(err instanceof Error ? err.message : err);
  }
  process.exit(1);
});
