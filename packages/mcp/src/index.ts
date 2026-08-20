#!/usr/bin/env node
/**
 * GLBForge MCP server — exposes the analyze/optimize/scaffold pipeline and the
 * Meshy generation API as MCP tools, so agents (Claude Code, Cursor, …) can
 * take an asset from generation to web-ready inside one conversation.
 *
 * Design notes:
 * - Generation tools are split into create/status/download rather than one
 *   blocking call: Meshy tasks take minutes and MCP clients time out long
 *   tool calls. The agent polls meshy_task_status at its own pace.
 * - Tool results are compact JSON strings (findings, budgets, diffs) meant
 *   to be read by a model, not a human terminal.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Logger } from '@gltf-transform/core';
import {
  analyze,
  createNodeIO,
  extrudeImage,
  getProfile,
  optimize,
  PROFILES,
  stripMaterials,
  toStl,
  type AnalysisResult,
} from '@glbforge/core';
import { MeshyClient, type TaskKind } from '@glbforge/meshy';

// --- .env (never overrides real env vars, never logs values) ---
try {
  for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch { /* no .env — fine */ }

const PROFILE_ENUM = z.enum(
  Object.keys(PROFILES) as [string, ...string[]],
);

/** Trim an AnalysisResult to what an agent needs to reason about. */
function summarize(r: AnalysisResult) {
  return {
    score: r.score,
    passed: r.passed,
    profile: r.profile.name,
    fileBytes: r.file.bytes,
    triangles: r.geometry.triangles,
    vertices: r.geometry.vertices,
    drawCalls: r.geometry.drawCallEstimate,
    materials: r.materials.length,
    textures: r.textures.map((t) => ({
      name: t.name, size: `${t.width}x${t.height}`, mime: t.mimeType, bytes: t.bytes,
      hasAlpha: t.hasAlpha, vramBytes: t.vramBytes,
    })),
    textureBytesTotal: r.textureBytesTotal,
    textureVramTotal: r.textureVramTotal,
    bounds: r.geometry.bounds?.size ?? null,
    topology: r.geometry.topology,
    findings: r.findings,
  };
}

const json = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});

const server = new McpServer({ name: 'glbforge', version: '0.3.0' });

server.registerTool(
  'list_profiles',
  {
    description:
      'List the available web performance budget profiles (triangle/texture/file-size caps).',
    inputSchema: {},
  },
  async () => json(PROFILES),
);

server.registerTool(
  'analyze_glb',
  {
    description:
      'Analyze a GLB/glTF file against a web performance budget. Returns a score, ' +
      'budget pass/fail, geometry+texture stats, and named lint findings with fixes. ' +
      'Run this before and after any optimization.',
    inputSchema: {
      path: z.string().describe('Absolute path to the .glb file'),
      profile: PROFILE_ENUM.default('mobile-hero'),
      topology: z.boolean().default(true).describe('Run the (slower) weld/edge topology pass'),
    },
  },
  async ({ path, profile, topology }) => {
    const bytes = await readFile(path);
    const io = await createNodeIO();
    const doc = await io.readBinary(new Uint8Array(bytes));
    const result = analyze(doc, {
      profile: getProfile(profile),
      topology,
      filePath: path,
      fileBytes: bytes.byteLength,
    });
    return json(summarize(result));
  },
);

server.registerTool(
  'optimize_glb',
  {
    description:
      'Optimize a GLB for web delivery: weld, simplify to the profile triangle budget, ' +
      'fill smooth normals, resize/re-encode textures to WebP, meshopt-compress. ' +
      'Writes the optimized file and returns a before/after diff. Typically 90%+ smaller.',
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
    },
  },
  async ({ path, out, profile, targetTriangles, lods, textures, compress, textureFormat }) => {
    const outPath = out ?? path.replace(/\.glb$/i, '') + '.web.glb';
    const prof = getProfile(profile);
    const bytes = await readFile(path);
    const io = await createNodeIO();
    const doc = await io.readBinary(new Uint8Array(bytes));
    doc.setLogger(new Logger(Logger.Verbosity.ERROR));

    const before = analyze(doc, { profile: prof, topology: false, fileBytes: bytes.byteLength });
    const summary = await optimize(doc, {
      profile: prof, targetTriangles, textures, compress, textureFormat,
    });
    const outBytes = await io.writeBinary(doc);
    await writeFile(outPath, outBytes);
    const after = analyze(await io.readBinary(outBytes), {
      profile: prof, topology: false, filePath: outPath, fileBytes: outBytes.byteLength,
    });

    const lodFiles: Array<{ path: string; bytes: number; target: number }> = [];
    for (let i = 0; i < (lods?.length ?? 0); i++) {
      const lodDoc = await io.readBinary(outBytes);
      lodDoc.setLogger(new Logger(Logger.Verbosity.ERROR));
      // LOD files are geometry-only; the viewer reuses the primary's materials.
      stripMaterials(lodDoc);
      await optimize(lodDoc, {
        profile: prof, targetTriangles: lods![i], textures: false, compress,
      });
      const lodPath = outPath.replace(/\.glb$/i, `.lod${i + 1}.glb`);
      const lodBytes = await io.writeBinary(lodDoc);
      await writeFile(lodPath, lodBytes);
      lodFiles.push({ path: lodPath, bytes: lodBytes.byteLength, target: lods![i] });
    }

    return json({
      outPath,
      steps: summary.steps,
      before: { triangles: before.geometry.triangles, bytes: bytes.byteLength, score: before.score },
      after: summarize(after),
      savedPct: Math.round((1 - outBytes.byteLength / bytes.byteLength) * 1000) / 10,
      lods: lodFiles,
    });
  },
);

server.registerTool(
  'extrude_image',
  {
    description:
      'Deterministic 2D graphic -> extruded 3D GLB (no AI, no credits, instant). Traces the ' +
      'image silhouette and projects the source image back on as texture. USE THIS instead of ' +
      'Meshy generation for flat artwork: logos, wordmarks, icons, stickers. Use Meshy for ' +
      'photographic or dimensional subjects. Supports a signage-style bevel on the rims.',
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
    },
  },
  async ({ path, out, mode, threshold, width, depth, bevel, bevelSegments, layers, pillow, emboss, preset, simplify, texture, color, metallic, roughness }) => {
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
    return json({ out, bytes: outBytes.byteLength, ...stats });
  },
);

server.registerTool(
  'export_stl',
  {
    description:
      'Export a GLB as binary STL for 3D printing — scaled to millimeters, rotated z-up. ' +
      'Reports watertightness (glbforge-extruded assets are watertight by construction; ' +
      'simplified AI meshes usually are too).',
    inputSchema: {
      path: z.string().describe('Absolute path to the .glb'),
      out: z.string().describe('Absolute output path for the .stl'),
      sizeMm: z.number().positive().default(80).describe('Largest printed dimension in millimeters'),
    },
  },
  async ({ path, out, sizeMm }) => {
    const bytes = await readFile(path);
    const io = await createNodeIO();
    const doc = await io.readBinary(new Uint8Array(bytes));
    const report = analyze(doc, { profile: getProfile('mobile-hero') });
    const topo = report.geometry.topology!;
    const { stl, triangles, sizeMm: dims } = toStl(doc, { targetSizeMm: sizeMm });
    await writeFile(out, stl);
    return json({
      out, bytes: stl.byteLength, triangles, sizeMm: dims,
      watertight: topo.boundaryEdges === 0 && topo.nonManifoldEdges === 0,
      boundaryEdges: topo.boundaryEdges,
      nonManifoldEdges: topo.nonManifoldEdges,
    });
  },
);

server.registerTool(
  'meshy_create_task',
  {
    description:
      'Start a Meshy generation task (needs MESHY_API_KEY). kind "image-to-3d" takes a ' +
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
      let imageUrl = image;
      if (!/^https?:\/\//.test(image)) {
        const ext = image.toLowerCase().split('.').pop();
        const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }[ext ?? ''];
        if (!mime) throw new Error(`Unsupported image extension ".${ext}" (png/jpg/webp)`);
        imageUrl = `data:${mime};base64,${(await readFile(image)).toString('base64')}`;
      }
      taskId = await client.createImageTo3D({
        image_url: imageUrl, should_texture, enable_pbr, target_polycount,
      });
    } else if (refine_from) {
      taskId = await client.createTextTo3DRefine({
        preview_task_id: refine_from, enable_pbr,
      });
    } else {
      if (!prompt) throw new Error('text-to-3d requires "prompt" (or "refine_from")');
      taskId = await client.createTextTo3DPreview({ prompt, target_polycount });
    }
    return json({ taskId, kind, hint: 'Poll meshy_task_status; typical time 2-10 minutes.' });
  },
);

server.registerTool(
  'meshy_task_status',
  {
    description: 'Check a Meshy task: status, progress %, and (when finished) model URLs.',
    inputSchema: {
      kind: z.enum(['image-to-3d', 'text-to-3d', 'remesh', 'retexture']),
      taskId: z.string(),
    },
  },
  async ({ kind, taskId }) => {
    const task = await new MeshyClient().getTask(kind as TaskKind, taskId);
    return json({
      id: task.id, status: task.status, progress: task.progress,
      error: task.task_error?.message ?? null,
      formats: Object.keys(task.model_urls ?? {}),
    });
  },
);

server.registerTool(
  'meshy_download',
  {
    description: 'Download a finished Meshy task\'s GLB to a local path.',
    inputSchema: {
      kind: z.enum(['image-to-3d', 'text-to-3d', 'remesh', 'retexture']),
      taskId: z.string(),
      out: z.string().describe('Absolute output path for the .glb'),
    },
  },
  async ({ kind, taskId, out }) => {
    const client = new MeshyClient();
    const task = await client.getTask(kind as TaskKind, taskId);
    if (task.status !== 'SUCCEEDED') {
      throw new Error(`Task is ${task.status} (${task.progress}%) — not downloadable yet.`);
    }
    const bytes = await client.downloadModel(task, 'glb');
    await writeFile(out, bytes);
    return json({ out, bytes: bytes.byteLength });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
