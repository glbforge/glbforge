/**
 * GLBForge MCP server — exposes the analyze/optimize/forge/export pipeline
 * and the generation APIs as MCP tools, so agents (Claude Code, Cursor, …)
 * can take an asset from generation to web-ready inside one conversation.
 *
 * Design notes:
 * - Results are COMPACT: verdict, the numbers that drive decisions, every
 *   error plus the top findings, `nextActions`, and a `drillDown` pointer.
 *   `inspect_report` returns any full section on demand (analysis is
 *   deterministic and fast, so nothing is cached server-side).
 * - Every tool that reads or writes a GLB returns a rendered PNG (thumbnail,
 *   2x2 turntable, or a reference | result | change sheet when SSIM fails)
 *   so an agent can look at what it produced. `render_preview` and
 *   `compare_glb` do it standalone.
 * - Written files carry a sha256 so agents and CI can check determinism.
 * - Tool annotations mark read-only tools so clients can auto-approve them.
 * - Generation tools are split into create/status/download rather than one
 *   blocking call: tasks take minutes and MCP clients time out long calls.
 * - Deterministic: same file + same arguments = same JSON and same pixels.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join as joinPath } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Document, Logger } from '@gltf-transform/core';
import {
  alignmentScore,
  analyze,
  applyPerceptualVerdict,
  auditDirectory,
  BUDGET_METHODOLOGY_URL,
  createNodeIO,
  detectKtx2Encoder,
  extrudeImage,
  getProfile,
  optimize,
  perceptualDiff,
  profileLabel,
  PROFILES,
  sharpTextureDecoder,
  stripMaterials,
  toStl,
  toUsdz,
  type AnalysisResult,
  type OptimizeSummary,
} from '@glbforge/core';
import { FAL_MODELS, FalClient, MeshyClient, type TaskKind } from '@glbforge/meshy';
import { compact, reply, section, visualFidelityOf, type ReportSection } from './compact.js';
import { renderComparison, renderPreview, type PreviewKind } from './preview.js';

const VERSION: string = (() => {
  try {
    return createRequire(import.meta.url)('../package.json').version;
  } catch {
    return '0.0.0';
  }
})();

/** Load `.env` from the client's project dir (never overrides real env vars, never logs values). */
export function loadDotEnv(cwd = process.cwd()): void {
  try {
    for (const line of readFileSync(joinPath(cwd, '.env'), 'utf8').split('\n')) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !line.trimStart().startsWith('#') && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch { /* no .env — fine */ }
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Tool annotations: lets clients auto-approve read-only tools. */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITES_FILES = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const NETWORK = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

const PROFILE_ENUM = z.string().describe(`Budget profile: ${Object.keys(PROFILES).join(' | ')}; pin a version with name@N (e.g. mobile-hero@1)`);
const PREVIEW_ENUM = z.enum(['thumbnail', 'turntable', 'compare', 'none']);
const previewField = (what: string) => PREVIEW_ENUM.default('thumbnail')
  .describe(`Rendered PNG of ${what} returned with the result: thumbnail (one 3/4 view) | turntable (4 angles tiled 2x2) | none`);

type IO = Awaited<ReturnType<typeof createNodeIO>>;

async function readDoc(path: string): Promise<{ doc: Document; bytes: Buffer }> {
  const bytes = await readFile(path);
  const io = await createNodeIO();
  const doc = await io.readBinary(new Uint8Array(bytes));
  doc.setLogger(new Logger(Logger.Verbosity.ERROR));
  return { doc, bytes };
}

const quiet = (doc: Document) => { doc.setLogger(new Logger(Logger.Verbosity.ERROR)); return doc; };

function fidelityOf(summary: OptimizeSummary, after: AnalysisResult) {
  const visual = visualFidelityOf(after);
  return {
    geometricBound: summary.fidelityBound,
    ...(visual ? { ssimMin: visual.ssimMin, ssimMean: visual.ssimMean, worstView: visual.worstView, threshold: visual.threshold, passed: visual.passed }
      : { ssim: null, note: 'perceptual verification skipped' }),
  };
}

/** Geometry-only LOD chain from the already-optimized bytes. */
async function writeLods(
  io: IO, outBytes: Uint8Array, outPath: string, prof: ReturnType<typeof getProfile>,
  lods: number[] | undefined, compress: boolean,
): Promise<Array<{ path: string; bytes: number; sha256: string; target: number }>> {
  const files = [];
  for (let i = 0; i < (lods?.length ?? 0); i++) {
    const lodDoc = quiet(await io.readBinary(outBytes));
    // LOD files are geometry-only; the viewer reuses the primary's materials.
    stripMaterials(lodDoc);
    await optimize(lodDoc, { profile: prof, targetTriangles: lods![i], textures: false, compress, verify: false });
    const lodPath = outPath.replace(/\.glb$/i, `.lod${i + 1}.glb`);
    const lodBytes = await io.writeBinary(lodDoc);
    await writeFile(lodPath, lodBytes);
    files.push({ path: lodPath, bytes: lodBytes.byteLength, sha256: sha256(lodBytes), target: lods![i] });
  }
  return files;
}

/**
 * The image an agent should see after an optimization: the requested preview,
 * or — when SSIM failed or `compare` was asked for — reference | result |
 * change heatmap for the weakest camera.
 */
async function previewOrComparison(afterDoc: Document, preview: PreviewKind | 'compare', summary: OptimizeSummary) {
  const p = summary.perceptual;
  const wantCompare = preview === 'compare' || (p && !p.passed && preview !== 'none');
  if (wantCompare && p?.rendered) {
    const i = Math.max(0, p.rendered.reference.findIndex((v) => v.name === p.worstView));
    return (await renderComparison(p.rendered.reference[i], p.rendered.candidate[i])).image;
  }
  if (preview === 'compare') return (await renderPreview(afterDoc, 'thumbnail'))?.image;
  return (await renderPreview(afterDoc, preview))?.image;
}

export function createServer(): McpServer {
  const server = new McpServer({ name: 'glbforge', version: VERSION });

  server.registerTool(
    'capabilities',
    {
      annotations: READ_ONLY,
      description:
        'What this GLBForge install can do right now: versions, which generation providers have keys ' +
        '(FAL_KEY → generate_image_to_3d; MESHY_API_KEY → meshy_*), whether a KTX2 encoder is installed ' +
        '(textureFormat=ktx2), profiles, and the working directory .env is read from. Call it before planning ' +
        'a generation or KTX2 route so you never hit a missing-key error mid-plan.',
      inputSchema: {},
    },
    async () => {
      const ktx2 = await detectKtx2Encoder().catch(() => null);
      let coreVersion = 'unknown';
      try {
        // core's exports map hides package.json; resolve the entry and walk up.
        const entry = createRequire(import.meta.url).resolve('@glbforge/core');
        coreVersion = JSON.parse(readFileSync(joinPath(entry, '..', '..', 'package.json'), 'utf8')).version;
      } catch { /* optional */ }
      return reply({
        versions: { mcp: VERSION, core: coreVersion, node: process.version },
        cwd: process.cwd(),
        generation: {
          fal: { available: !!process.env.FAL_KEY, models: ['hunyuan', 'trellis', 'triposr'], tool: 'generate_image_to_3d' },
          meshy: { available: !!process.env.MESHY_API_KEY, tool: 'meshy_create_task' },
        },
        ktx2: { available: !!ktx2, encoder: ktx2 ?? null, note: ktx2 ? 'textureFormat=ktx2 works' : 'install basisu (brew install basis_universal) or toktx to enable textureFormat=ktx2' },
        deterministic: { forge: true, optimize: true, previews: true, generation: false },
        profiles: Object.values(PROFILES).map((p) => profileLabel(p)),
        methodology: BUDGET_METHODOLOGY_URL,
        previews: 'every GLB-touching tool returns a PNG; optimize/ship return a reference|result|change sheet when SSIM fails',
      });
    },
  );

  server.registerTool(
    'compare_glb',
    {
      annotations: READ_ONLY,
      description:
        'Measure how faithfully a candidate GLB matches a reference: visual SSIM over four fixed cameras ' +
        '(gated on the profile floor) plus geometric alignment (point-to-surface chamfer, F-scores, proportion IoU). ' +
        'Returns a reference | candidate | change-heatmap sheet for the weakest view. Use it to judge any ' +
        'optimization, a regenerated asset against the original, or two generators against each other.',
      inputSchema: {
        reference: z.string().describe('Absolute path to the reference .glb (e.g. the original)'),
        candidate: z.string().describe('Absolute path to the candidate .glb (e.g. the optimized file)'),
        profile: PROFILE_ENUM.default('mobile-hero'),
        minSsim: z.number().min(0).max(1).optional().describe('Override the SSIM floor'),
        textures: z.boolean().default(true).describe('Include base-color textures in the renders'),
        geometry: z.boolean().default(false).describe('Also run the geometric alignment score (chamfer, F-scores, IoU). Costs seconds on 100k-tri meshes and up to a minute on multi-million-tri inputs; the visual score alone takes ~5s'),
        size: z.number().int().min(64).max(512).default(256),
      },
    },
    async ({ reference, candidate, profile, minSsim, textures, geometry, size }) => {
      const ref = await readDoc(reference);
      const cand = await readDoc(candidate);
      const threshold = minSsim ?? getProfile(profile).minSsim;
      const visual = await perceptualDiff(ref.doc, cand.doc, {
        size, textureDecoder: textures ? sharpTextureDecoder() : undefined, keepViews: true,
      });
      const i = Math.max(0, visual.rendered!.reference.findIndex((v) => v.name === visual.worstView));
      const sheet = await renderComparison(visual.rendered!.reference[i], visual.rendered!.candidate[i]);
      const align = geometry ? alignmentScore(cand.doc, ref.doc, { samples: 8000 }) : null;
      const { rendered: _rendered, ...visualOut } = visual;
      return reply({
        reference, candidate,
        visual: { ...visualOut, threshold, passed: visual.ssimMin >= threshold },
        ...(align ? { geometry: align } : {}),
        sheet: { views: sheet.views, note: 'reference | candidate | change (black=same, yellow→red=more change)' },
      }, sheet.image);
    },
  );

  server.registerTool(
    'list_profiles',
    {
      annotations: READ_ONLY,
      description:
        'List the web performance budget profiles: triangle/draw-call/texture/file-size/GPU-memory caps, ' +
        'the minimum visual-fidelity SSIM an optimization must keep, the profile version to pin in CI, ' +
        'and (with rationale=true) why each cap is what it is.',
      inputSchema: {
        rationale: z.boolean().default(false).describe('Include the per-cap methodology text'),
      },
    },
    async ({ rationale }) => reply({
      methodology: BUDGET_METHODOLOGY_URL,
      profiles: Object.values(PROFILES).map((p) => ({
        name: p.name, version: p.version, pin: profileLabel(p), description: p.description,
        maxTriangles: p.maxTriangles, maxDrawCalls: p.maxDrawCalls, maxMaterials: p.maxMaterials,
        maxTextureSize: p.maxTextureSize, maxTextureBytes: p.maxTextureBytes,
        maxTextureVramBytes: p.maxTextureVramBytes, maxFileBytes: p.maxFileBytes, minSsim: p.minSsim,
        ...(rationale ? { rationale: p.rationale } : {}),
      })),
    }),
  );

  server.registerTool(
    'analyze_glb',
    {
      annotations: READ_ONLY,
      description:
        'Analyze a GLB/glTF against a web performance budget. Returns a compact report card ' +
        '(score, pass/fail, key numbers, every error + top findings, nextActions) plus a rendered thumbnail. ' +
        'Call inspect_report for full findings/textures/topology. Run before and after any optimization.',
      inputSchema: {
        path: z.string().describe('Absolute path to the .glb file'),
        profile: PROFILE_ENUM.default('mobile-hero'),
        topology: z.boolean().default(true).describe('Run the (slower) weld/edge topology pass'),
        preview: previewField('the asset'),
      },
    },
    async ({ path, profile, topology, preview }) => {
      const { doc, bytes } = await readDoc(path);
      const result = analyze(doc, { profile: getProfile(profile), topology, filePath: path, fileBytes: bytes.byteLength });
      const image = await renderPreview(doc, preview as PreviewKind);
      return reply({ ...compact(result), sha256: sha256(bytes) }, image?.image);
    },
  );

  server.registerTool(
    'inspect_report',
    {
      annotations: READ_ONLY,
      description:
        'Drill into an analysis: full findings (with fix suggestions and rule data), per-texture stats, ' +
        'materials, welded-space topology, geometry per primitive, scene/generator facts, or the whole report. ' +
        'Re-analyzes deterministically, so it works on any file at any time.',
      inputSchema: {
        path: z.string().describe('Absolute path to the .glb file'),
        profile: PROFILE_ENUM.default('mobile-hero'),
        section: z.enum(['findings', 'textures', 'materials', 'topology', 'geometry', 'scene', 'all']).default('findings'),
        ruleId: z.string().optional().describe('findings only: exact rule id or prefix, e.g. "tex" or "perf/file-size"'),
        severity: z.enum(['error', 'warn', 'info']).optional().describe('findings only'),
      },
    },
    async ({ path, profile, section: which, ruleId, severity }) => {
      const { doc, bytes } = await readDoc(path);
      const needsTopology = which === 'topology' || which === 'all' || which === 'findings';
      const result = analyze(doc, { profile: getProfile(profile), topology: needsTopology, filePath: path, fileBytes: bytes.byteLength });
      return reply(section(result, which as ReportSection, { ruleId, severity }) as Record<string, unknown>);
    },
  );

  server.registerTool(
    'render_preview',
    {
      annotations: WRITES_FILES,
      description:
        'Render a GLB with the deterministic software rasterizer (no GPU): one thumbnail or a 2x2 ' +
        'turntable of four angles. Use it to look at an asset before deciding, or to verify a result. ' +
        'Optionally saves the PNG.',
      inputSchema: {
        path: z.string().describe('Absolute path to the .glb'),
        view: z.enum(['thumbnail', 'turntable']).default('turntable'),
        size: z.number().int().min(64).max(1024).default(256).describe('Pixels per view'),
        out: z.string().optional().describe('Absolute path to also save the PNG'),
      },
    },
    async ({ path, view, size, out }) => {
      const { doc } = await readDoc(path);
      const preview = (await renderPreview(doc, view, size))!;
      if (out) await writeFile(out, preview.png);
      return reply({ path, views: preview.views, width: preview.width, height: preview.height, ...(out ? { out } : {}) }, preview.image);
    },
  );

  server.registerTool(
    'ship_asset',
    {
      annotations: WRITES_FILES,
      description:
        'One call from anything to web-ready. A .glb is optimized to the budget and gated. ' +
        'An image is routed: flat artwork forges instantly (free); photographic input returns ' +
        'a routing instruction to call generate_image_to_3d (then optimize_glb the result). ' +
        'Returns the compact report, a geometric fidelity bound, the measured visual-fidelity SSIM ' +
        '(fixed-camera renders before vs after), a sha256 of the output, and a thumbnail — or a ' +
        'reference | result | change sheet when SSIM fails.',
      inputSchema: {
        input: z.string().describe('Absolute path: .glb or image (png/jpg/webp/svg)'),
        out: z.string().optional().describe('Output path (default: <input>.web.glb)'),
        profile: PROFILE_ENUM.default('mobile-hero'),
        textureFormat: z.enum(['webp', 'ktx2']).default('webp'),
        verify: z.boolean().default(true).describe('Perceptual (SSIM) verification; a failing SSIM fails the report'),
        targetTriangles: z.number().int().positive().optional().describe('Override the profile triangle target'),
        lods: z.array(z.number().int().positive()).optional().describe('Extra geometry-only LOD files, e.g. [40000, 10000]'),
        preview: previewField('the shipped asset'),
      },
    },
    async ({ input, out, profile, textureFormat, verify, targetTriangles, lods, preview }) => {
      const prof = getProfile(profile);
      const io = await createNodeIO();
      const outPath = out ?? input.replace(/\.(glb|png|jpe?g|webp|svg)$/i, '') + '.web.glb';

      const finish = async (doc: Document, sourceBytes: number) => {
        quiet(doc);
        const summary = await optimize(doc, { profile: prof, textureFormat, verify, targetTriangles, keepViews: true });
        const outBytes = await io.writeBinary(doc);
        await writeFile(outPath, outBytes);
        const afterDoc = quiet(await io.readBinary(outBytes));
        const after = analyze(afterDoc, { profile: prof, topology: false, filePath: outPath, fileBytes: outBytes.byteLength });
        if (summary.perceptual) applyPerceptualVerdict(after, summary.perceptual);
        const lodFiles = await writeLods(io, outBytes, outPath, prof, lods, true);
        const image = await previewOrComparison(afterDoc, preview as PreviewKind | 'compare', summary);
        return reply({
          outPath,
          sha256: sha256(outBytes),
          savedPct: sourceBytes ? Math.round((1 - outBytes.byteLength / sourceBytes) * 1000) / 10 : null,
          steps: summary.steps,
          fidelity: fidelityOf(summary, after),
          report: compact(after),
          ...(lodFiles.length ? { lods: lodFiles } : {}),
        }, image);
      };

      if (/\.glb$/i.test(input)) {
        const { doc, bytes } = await readDoc(input);
        return finish(doc, bytes.byteLength);
      }
      try {
        const raw = new Uint8Array(await readFile(input));
        const { doc } = await extrudeImage(raw, { layers: 4, pillow: 0.02 });
        return finish(doc, raw.byteLength);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/photograph|noisy mask/i.test(message)) {
          return reply({
            routed: 'generation',
            reason: 'Input looks photographic — deterministic forging would produce mush.',
            nextActions: [
              { tool: 'generate_image_to_3d', args: { image: input, model: 'hunyuan' } },
              { tool: 'generation_status', note: 'poll until COMPLETED, download with out=...' },
              { tool: 'ship_asset', note: 'then ship the downloaded .glb' },
            ],
          });
        }
        throw err;
      }
    },
  );

  server.registerTool(
    'audit_directory',
    {
      annotations: READ_ONLY,
      description:
        'Analyze every GLB in a directory against a budget profile in one call. ' +
        'Returns a per-file score table plus the failing list — then call ' +
        'optimize_glb on each failure (or ask before bulk-optimizing).',
      inputSchema: {
        dir: z.string().describe('Absolute directory path'),
        profile: PROFILE_ENUM.default('mobile-hero'),
        recursive: z.boolean().default(false),
      },
    },
    async ({ dir, profile, recursive }) => {
      const audit = await auditDirectory(dir, { profile: getProfile(profile), recursive });
      return reply({
        ...audit,
        nextActions: audit.failing.map((path) => ({ tool: 'optimize_glb', args: { path, profile } })),
      });
    },
  );

  server.registerTool(
    'optimize_glb',
    {
      annotations: WRITES_FILES,
      description:
        'Optimize a GLB for web delivery: weld, simplify to the profile triangle budget (bone-aware for ' +
        'skinned/morphing meshes), fill smooth normals, resize/re-encode textures to WebP, meshopt-compress. ' +
        'Writes the optimized file and returns a before/after diff, the measured visual-fidelity SSIM, ' +
        'the compact report, a sha256 of the output, and a thumbnail of the output — or a ' +
        'reference | result | change sheet when SSIM fails. Typically 90%+ smaller.',
      inputSchema: {
        path: z.string().describe('Absolute path to the input .glb'),
        out: z.string().optional().describe('Output path (default: <input>.web.glb)'),
        profile: PROFILE_ENUM.default('mobile-hero'),
        targetTriangles: z.number().int().positive().optional(),
        lods: z.array(z.number().int().positive()).optional()
          .describe('Extra LOD triangle targets, e.g. [40000, 10000]'),
        textures: z.boolean().default(true),
        compress: z.boolean().default(true),
        textureFormat: z.enum(['webp', 'ktx2']).default('webp')
          .describe('webp = smallest file; ktx2 = GPU-resident compression, ~8x less video memory (needs basisu/toktx installed)'),
        verify: z.boolean().default(true)
          .describe('Perceptual verification: SSIM of fixed-camera renders before vs after, gated on the profile floor; a failing SSIM fails the report'),
        preview: PREVIEW_ENUM.default('thumbnail')
          .describe('thumbnail | turntable | compare (reference | result | change heatmap of the weakest view) | none. A failing SSIM always returns the comparison sheet.'),
      },
    },
    async ({ path, out, profile, targetTriangles, lods, textures, compress, textureFormat, verify, preview }) => {
      const outPath = out ?? path.replace(/\.glb$/i, '') + '.web.glb';
      const prof = getProfile(profile);
      const { doc, bytes } = await readDoc(path);
      const io = await createNodeIO();

      const before = analyze(doc, { profile: prof, topology: false, fileBytes: bytes.byteLength });
      const summary = await optimize(doc, { profile: prof, targetTriangles, textures, compress, textureFormat, verify, keepViews: true });
      const outBytes = await io.writeBinary(doc);
      await writeFile(outPath, outBytes);
      const afterDoc = quiet(await io.readBinary(outBytes));
      const after = analyze(afterDoc, { profile: prof, topology: false, filePath: outPath, fileBytes: outBytes.byteLength });
      if (summary.perceptual) applyPerceptualVerdict(after, summary.perceptual);
      const lodFiles = await writeLods(io, outBytes, outPath, prof, lods, compress);

      const image = await previewOrComparison(afterDoc, preview as PreviewKind | 'compare', summary);
      return reply({
        outPath,
        sha256: sha256(outBytes),
        savedPct: Math.round((1 - outBytes.byteLength / bytes.byteLength) * 1000) / 10,
        steps: summary.steps,
        before: { triangles: before.geometry.triangles, bytes: bytes.byteLength, score: before.score },
        fidelity: fidelityOf(summary, after),
        after: compact(after),
        lods: lodFiles,
      }, image);
    },
  );

  server.registerTool(
    'extrude_image',
    {
      annotations: WRITES_FILES,
      description:
        'Deterministic 2D graphic -> extruded 3D GLB (no AI, no credits, instant). Traces the ' +
        'image silhouette and projects the source image back on as texture. USE THIS instead of ' +
        'generation for flat artwork: logos, wordmarks, icons, stickers. Use generation for ' +
        'photographic or dimensional subjects. Supports a signage-style bevel on the rims. ' +
        'Returns the mesh stats and a thumbnail of the forged piece.',
      inputSchema: {
        path: z.string().describe('Absolute path to a PNG/JPEG/WebP with transparent or white background'),
        out: z.string().describe('Absolute output path for the .glb'),
        mode: z.enum(['alpha', 'luma']).optional()
          .describe('Solid-pixel test: alpha (transparent bg) | luma (white bg). Auto-detected.'),
        threshold: z.number().int().min(0).max(255).optional(),
        width: z.number().positive().default(1).describe('World width in meters'),
        depth: z.number().positive().optional().describe('Extrusion depth in meters (default width*0.08)'),
        bevel: z.number().min(0).default(0).describe('Bevel radius in meters (signage look; try depth*0.25)'),
        bevelSegments: z.number().int().min(1).max(8).default(3),
        layers: z.number().int().min(2).max(6).optional()
          .describe('Layered color extrusion: quantize into N color layers at stepped depths (the "layered acrylic" look)'),
        pillow: z.number().min(0).optional()
          .describe('Puffy-sticker dome height in meters (e.g. 0.04); supersedes bevel'),
        emboss: z.number().optional()
          .describe('Luminance micro-relief in meters — bright artwork rises (try depth*0.15)'),
        preset: z.enum(['enamel', 'chrome', 'neon', 'acrylic', 'rubber']).optional()
          .describe('Material preset for the forged piece'),
        simplify: z.number().min(0).default(1.2).describe('Contour tolerance in trace pixels'),
        texture: z.boolean().default(true).describe('Project source image as baseColor'),
        color: z.string().optional().describe('Hex color when texture=false, e.g. "#ff2266"'),
        metallic: z.number().min(0).max(1).default(0),
        roughness: z.number().min(0).max(1).default(0.6),
        preview: previewField('the forged piece'),
      },
    },
    async ({ path, out, mode, threshold, width, depth, bevel, bevelSegments, layers, pillow, emboss, preset, simplify, texture, color, metallic, roughness, preview }) => {
      const bytes = await readFile(path);
      const rgba = color
        ? ([1, 3, 5].map((i) => parseInt(color.replace('#', '').padEnd(6, '0').slice(i - 1, i + 1), 16) / 255)
            .concat(1) as [number, number, number, number])
        : undefined;
      const { doc, stats } = await extrudeImage(new Uint8Array(bytes), {
        mode, threshold, width, depth, bevel, bevelSegments, layers, pillow, emboss, preset, simplify,
        texture, color: rgba, metallic, roughness,
      });
      const io = await createNodeIO();
      const outBytes = await io.writeBinary(doc);
      await writeFile(out, outBytes);
      const image = await renderPreview(doc, preview as PreviewKind);
      return reply({
        out, bytes: outBytes.byteLength, sha256: sha256(outBytes), ...stats,
        nextActions: [{ tool: 'analyze_glb', args: { path: out }, note: 'verify watertightness + budget' }],
      }, image?.image);
    },
  );

  server.registerTool(
    'export_stl',
    {
      annotations: WRITES_FILES,
      description:
        'Export a GLB as binary STL for 3D printing — scaled to millimeters, rotated z-up. ' +
        'Reports watertightness (glbforge-extruded assets are watertight by construction; ' +
        'simplified AI meshes usually are too). Returns a thumbnail of the exported geometry.',
      inputSchema: {
        path: z.string().describe('Absolute path to the .glb'),
        out: z.string().describe('Absolute output path for the .stl'),
        sizeMm: z.number().positive().default(80).describe('Largest printed dimension in millimeters'),
        preview: previewField('the exported geometry'),
      },
    },
    async ({ path, out, sizeMm, preview }) => {
      const { doc } = await readDoc(path);
      const report = analyze(doc, { profile: getProfile('mobile-hero') });
      const topo = report.geometry.topology!;
      const { stl, triangles, sizeMm: dims } = toStl(doc, { targetSizeMm: sizeMm });
      await writeFile(out, stl);
      const image = await renderPreview(doc, preview as PreviewKind);
      return reply({
        out, bytes: stl.byteLength, sha256: sha256(stl), triangles, sizeMm: dims,
        watertight: topo.boundaryEdges === 0 && topo.nonManifoldEdges === 0,
        boundaryEdges: topo.boundaryEdges,
        nonManifoldEdges: topo.nonManifoldEdges,
      }, image?.image);
    },
  );

  server.registerTool(
    'export_usdz',
    {
      annotations: WRITES_FILES,
      description:
        'Export a GLB as USDZ for iOS AR Quick Look: UsdPreviewSurface materials, PNG/JPEG textures ' +
        '(WebP is transcoded; KTX2 is rejected), store-only 64-byte-aligned zip. Static: skins and clips ' +
        'are baked to the bind pose. Use on the optimized .web.glb. Returns a thumbnail.',
      inputSchema: {
        path: z.string().describe('Absolute path to the .glb'),
        out: z.string().describe('Absolute output path for the .usdz'),
        jpeg: z.boolean().default(false).describe('Encode opaque color textures as JPEG (smaller) instead of PNG'),
        preview: previewField('the exported asset'),
      },
    },
    async ({ path, out, jpeg, preview }) => {
      const { doc } = await readDoc(path);
      const result = await toUsdz(doc, { colorFormat: jpeg ? 'jpeg' : 'png' });
      await writeFile(out, result.usdz);
      const image = await renderPreview(doc, preview as PreviewKind);
      return reply({
        out, bytes: result.usdz.byteLength, sha256: sha256(result.usdz), files: result.files,
        meshes: result.meshes, triangles: result.triangles, materials: result.materials, textures: result.textures,
        warnings: result.warnings,
        hint: 'Serve it and reference from <model-viewer ios-src>; iOS Safari opens it in AR Quick Look.',
      }, image?.image);
    },
  );

  const imageToDataUrl = async (image: string): Promise<string> => {
    if (/^https?:\/\//.test(image)) return image;
    const ext = image.toLowerCase().split('.').pop();
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }[ext ?? ''];
    if (!mime) throw new Error(`Unsupported image extension ".${ext}" (png/jpg/webp)`);
    return `data:${mime};base64,${(await readFile(image)).toString('base64')}`;
  };

  server.registerTool(
    'generate_image_to_3d',
    {
      annotations: NETWORK,
      description:
        'True volumetric 3D from a single image via open models on fal.ai GPU inference ' +
        '(needs FAL_KEY — check capabilities first): hunyuan (Hunyuan3D-2, highest quality), trellis (balanced), ' +
        'triposr (fastest). Cheaper than Meshy for most subjects; use Meshy for the richest ' +
        'PBR texturing. Returns a request id — poll generation_status, then download.',
      inputSchema: {
        image: z.string().describe('Local path or http(s) URL of the source image'),
        model: z.enum(['hunyuan', 'trellis', 'triposr']).default('hunyuan'),
      },
    },
    async ({ image, model }) => {
      const client = new FalClient();
      const requestId = await client.submit(FAL_MODELS[model], await imageToDataUrl(image));
      return reply({
        requestId, model, hint: 'Poll generation_status; typical time 1-3 minutes.',
        nextActions: [{ tool: 'generation_status', args: { requestId, model } }],
      });
    },
  );

  server.registerTool(
    'generation_status',
    {
      annotations: NETWORK,
      description:
        'Check an open-model generation (from generate_image_to_3d); when COMPLETED, pass download=true ' +
        'with an out path to save the GLB — the result then includes a thumbnail of what was generated.',
      inputSchema: {
        requestId: z.string(),
        model: z.enum(['hunyuan', 'trellis', 'triposr']),
        download: z.boolean().default(false),
        out: z.string().optional().describe('Absolute output path for the .glb when downloading'),
        preview: previewField('the downloaded model'),
      },
    },
    async ({ requestId, model, download, out, preview }) => {
      const client = new FalClient();
      const st = await client.status(FAL_MODELS[model], requestId);
      if (!download || st.status !== 'COMPLETED') {
        return reply({ status: st.status, queuePosition: st.queuePosition });
      }
      if (!out) throw new Error('pass "out" to download the finished model');
      const bytes = await client.downloadGlb(await client.resultGlbUrl(FAL_MODELS[model], requestId));
      await writeFile(out, bytes);
      const { doc } = await readDoc(out);
      const image = await renderPreview(doc, preview as PreviewKind);
      return reply({
        status: 'COMPLETED', out, bytes: bytes.byteLength, sha256: sha256(bytes),
        nextActions: [{ tool: 'ship_asset', args: { input: out } }],
      }, image?.image);
    },
  );

  server.registerTool(
    'meshy_create_task',
    {
      annotations: NETWORK,
      description:
        'Start a Meshy generation task (needs MESHY_API_KEY — check capabilities first). kind "image-to-3d" takes a ' +
        'local image path or URL; kind "text-to-3d" takes a prompt (geometry preview stage — ' +
        'pass refine_from to texture a finished preview). Returns a task id immediately; ' +
        'poll meshy_task_status (generation takes minutes).',
      inputSchema: {
        kind: z.enum(['image-to-3d', 'text-to-3d', 'remesh', 'retexture']),
        image: z.string().optional().describe('image-to-3d: local path or http(s) URL'),
        prompt: z.string().optional().describe('text-to-3d: what to generate; retexture: the style prompt'),
        refine_from: z.string().optional()
          .describe('text-to-3d: preview task id to refine (texture stage)'),
        input_task_id: z.string().optional()
          .describe('remesh/retexture: the SUCCEEDED task to operate on'),
        topology: z.enum(['quad', 'triangle']).optional().describe('remesh: output topology'),
        should_texture: z.boolean().default(true).describe('image-to-3d: run the texture stage'),
        enable_pbr: z.boolean().default(false),
        target_polycount: z.number().int().positive().optional(),
      },
    },
    async ({ kind, image, prompt, refine_from, input_task_id, topology, should_texture, enable_pbr, target_polycount }) => {
      const client = new MeshyClient();
      let taskId: string;
      if (kind === 'remesh') {
        if (!input_task_id) throw new Error('remesh requires "input_task_id"');
        taskId = await client.createRemesh({ input_task_id, topology, target_polycount });
      } else if (kind === 'retexture') {
        if (!input_task_id || !prompt) throw new Error('retexture requires "input_task_id" and "prompt" (the style)');
        taskId = await client.createRetexture({ input_task_id, text_style_prompt: prompt, enable_pbr });
      } else if (kind === 'image-to-3d') {
        if (!image) throw new Error('image-to-3d requires "image"');
        taskId = await client.createImageTo3D({
          image_url: await imageToDataUrl(image), should_texture, enable_pbr, target_polycount,
        });
      } else if (refine_from) {
        taskId = await client.createTextTo3DRefine({ preview_task_id: refine_from, enable_pbr });
      } else {
        if (!prompt) throw new Error('text-to-3d requires "prompt" (or "refine_from")');
        taskId = await client.createTextTo3DPreview({ prompt, target_polycount });
      }
      return reply({
        taskId, kind, hint: 'Poll meshy_task_status; typical time 2-10 minutes.',
        nextActions: [{ tool: 'meshy_task_status', args: { kind, taskId } }],
      });
    },
  );

  server.registerTool(
    'meshy_task_status',
    {
      annotations: NETWORK,
      description: 'Check a Meshy task: status, progress %, and (when finished) model URLs.',
      inputSchema: {
        kind: z.enum(['image-to-3d', 'text-to-3d', 'remesh', 'retexture']),
        taskId: z.string(),
      },
    },
    async ({ kind, taskId }) => {
      const task = await new MeshyClient().getTask(kind as TaskKind, taskId);
      return reply({
        id: task.id, status: task.status, progress: task.progress,
        error: task.task_error?.message ?? null,
        formats: Object.keys(task.model_urls ?? {}),
        ...(task.status === 'SUCCEEDED' ? { nextActions: [{ tool: 'meshy_download', args: { kind, taskId } }] } : {}),
      });
    },
  );

  server.registerTool(
    'meshy_download',
    {
      annotations: NETWORK,
      description: 'Download a finished Meshy task\'s GLB to a local path; returns a thumbnail of the model.',
      inputSchema: {
        kind: z.enum(['image-to-3d', 'text-to-3d', 'remesh', 'retexture']),
        taskId: z.string(),
        out: z.string().describe('Absolute output path for the .glb'),
        preview: previewField('the downloaded model'),
      },
    },
    async ({ kind, taskId, out, preview }) => {
      const client = new MeshyClient();
      const task = await client.getTask(kind as TaskKind, taskId);
      if (task.status !== 'SUCCEEDED') {
        throw new Error(`Task is ${task.status} (${task.progress}%) — not downloadable yet.`);
      }
      const bytes = await client.downloadModel(task, 'glb');
      await writeFile(out, bytes);
      const { doc } = await readDoc(out);
      const image = await renderPreview(doc, preview as PreviewKind);
      return reply({
        out, bytes: bytes.byteLength, sha256: sha256(bytes),
        nextActions: [{ tool: 'ship_asset', args: { input: out } }],
      }, image?.image);
    },
  );

  // --- Guided workflows (MCP prompts) ---------------------------------------
  server.registerPrompt(
    'web-ready-mobile-hero',
    {
      description: 'Take any 3D asset (or a source image) to a mobile-hero web asset with proof.',
      argsSchema: { input: z.string().describe('Path to a .glb, or an image to generate/forge from') },
    },
    ({ input }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Make ${input} web-ready for a mobile hero section using glbforge tools. Call capabilities first. ` +
            'If it is an image: flat artwork (logo/wordmark/icon) goes to extrude_image; ' +
            'photographic or dimensional subjects go to generate_image_to_3d (hunyuan) or meshy. ' +
            'Then analyze_glb with profile mobile-hero, optimize_glb until it passes, and ' +
            'report the before/after numbers (triangles, file size, GPU memory) and the measured ' +
            'visual-fidelity SSIM as the proof. Look at the returned thumbnail to confirm the ' +
            'result matches the source before declaring success.',
        },
      }],
    }),
  );

  server.registerPrompt(
    'logo-keychain',
    {
      description: 'Turn a logo image into a printable keychain STL.',
      argsSchema: { image: z.string().describe('Path to the logo (PNG/SVG/JPEG/WebP)') },
    },
    ({ image }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Forge ${image} into a printable keychain: extrude_image with layers 4, ` +
            'pillow ~0.03 and a fitting preset, check the thumbnail, verify watertightness via ' +
            'inspect_report section topology (boundary and non-manifold edges must be 0), then ' +
            'export_stl at 70mm. If not watertight, retry without layers before reporting failure.',
        },
      }],
    }),
  );

  server.registerPrompt(
    'audit-and-fix-folder',
    {
      description: 'Audit every GLB in a folder against a budget; optimize the failures.',
      argsSchema: {
        dir: z.string().describe('Directory containing GLBs'),
        profile: z.string().optional().describe('Budget profile (default mobile-hero)'),
      },
    },
    ({ dir, profile }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Run audit_directory on ${dir} with profile ${profile ?? 'mobile-hero'}. ` +
            'List the failures with their top finding, then optimize_glb each failing file ' +
            '(writing alongside the original) and re-audit to confirm everything passes. ' +
            'Summarize total bytes saved and the lowest visual-fidelity SSIM seen.',
        },
      }],
    }),
  );

  return server;
}
