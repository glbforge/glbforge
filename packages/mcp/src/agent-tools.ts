/**
 * Agent-oriented inspection tools: validate, inspect_geometry,
 * inspect_animation, inspect_materials, analyze_performance, render,
 * render_animation_strip, inspect_all. Every one reads GLB / glTF / USDZ /
 * USDA / USDC through the shared SceneIR and answers with the common
 * envelope (stable codes + prim paths). Read-only; renders are opt-in.
 */
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  analyzePerformance, customCamera, diag, frontRig, inspectAnimation, inspectGeometry, inspectMaterials, loadScene, PERFORMANCE_PROFILES, PROFILE_VERSIONS,
  renderScene, resolvePerformanceProfile, sharpTextureDecoder, thumbnailRig, turntableRig, validateScene,
  type Diagnostic, type LoadedScene, type RawView, type RenderCamera, type SceneIR, type PerformanceProfile,
} from '@glbforge/core';
import { note, noteAll, plural, reply, severityTail, withContext } from './envelope.js';
import { renderContactSheet, renderGif, type Preview } from './preview.js';
import { envelopeShape, ToolDataSchemas, type ToolName } from './schemas.js';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITES_FILES = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const PATH = z.string().describe('Absolute path to a .glb, .gltf, .usdz, .usda, .usdc or .usd file');
const PERF_PROFILE = z.string().default('ios_ar').describe(`Performance profile: ${Object.keys(PERFORMANCE_PROFILES).join(' | ')} (documented in docs/performance-profiles.md), or a budget profile ${Object.keys(PROFILE_VERSIONS).join(' | ')}[@N]`);
const CUSTOM_LIMITS = z.record(z.number()).optional().describe('Custom limits (override / replace the named profile): max_triangles, max_vertices, max_draw_calls, max_materials, max_textures, max_file_bytes, max_gpu_memory_mb, max_texture_size, max_texture_bytes, max_prim_count, max_scene_depth');

/** Register a tool with the envelope output schema and the call context. */
export function registerEnvelopeTool<Args extends z.ZodRawShape>(
  server: McpServer, name: ToolName, config: { description: string; annotations: Record<string, boolean>; inputSchema: Args },
  handler: (args: z.objectOutputType<Args, z.ZodTypeAny>) => Promise<ReturnType<typeof reply>>,
): void {
  server.registerTool(name, { ...config, outputSchema: envelopeShape(ToolDataSchemas[name]) } as never, ((args: z.objectOutputType<Args, z.ZodTypeAny>) => withContext(name, () => handler(args))) as never);
}

const cameraOf = (v: RawView) => ({ position: v.camera.position, target: v.camera.target, fov: v.camera.fovDeg });
const loadErrors = (ir: SceneIR) => ir.diagnostics.filter((d) => d.severity === 'error');
const profileOf = (profile: string, custom?: Record<string, number>): PerformanceProfile => {
  const base = resolvePerformanceProfile(profile);
  return custom && Object.keys(custom).length ? { ...base, ...resolvePerformanceProfile({ ...custom, name: `${base.name}+custom` }), name: `${base.name}+custom` } : base;
};

function validationData(loaded: LoadedScene, mode: 'quick' | 'full') {
  const v = validateScene(loaded.ir, { container: loaded.usd?.container ?? null, layer: loaded.usd?.layer ?? null });
  const { diagnostics, ...rest } = v;
  return { data: { path: loaded.ir.sourcePath ?? '', mode, ...rest, sha256: sha256(loaded.bytes) }, diagnostics };
}

function counts(ir: SceneIR): string {
  const parts = [plural(ir.meshes.length, 'mesh')];
  if (ir.skins.length) parts.push(plural(ir.skins.length, 'skeleton'));
  if (ir.materials.length) parts.push(plural(ir.materials.length, 'material'));
  if (ir.textures.length) parts.push(plural(ir.textures.length, 'texture'));
  if (ir.animations.length) parts.push(plural(ir.animations.length, 'clip'));
  return parts.join(', ');
}

const clampTime = (ir: SceneIR, t: number, animIndex: number): number => {
  const a = ir.animations[animIndex];
  if (!a) return t;
  if (t < a.start || t > a.end) {
    note(diag('FRAME_OUT_OF_RANGE', a.path, `Requested time ${t}s is outside the clip range ${a.start}–${a.end}s; clamped.`, { data: { requested: t, start: a.start, end: a.end } }));
    return Math.min(a.end, Math.max(a.start, t));
  }
  return t;
};

async function renderIR(ir: SceneIR, opts: { cameras: RenderCamera[]; size: number; time?: number; animation?: number; textures: boolean }) {
  const r = await renderScene(ir, { cameras: opts.cameras, size: opts.size, supersample: 2, time: opts.time, animation: opts.animation, textureDecoder: opts.textures ? sharpTextureDecoder() : undefined });
  if (r.triangles === 0) note(diag('NO_GEOMETRY_TO_RENDER', ir.format.startsWith('usd') ? ir.defaultPrim ?? '/' : '/Asset', 'The scene has no renderable triangles.'));
  return r;
}

export function registerAgentTools(server: McpServer): void {
  registerEnvelopeTool(server, 'validate', {
    annotations: READ_ONLY,
    description:
      'Does the asset open, and is it well-formed for its target? Returns format, USDZ packaging compliance (stored entries, 64-byte alignment, allowed file types), ' +
      'layer metadata (default_prim, up_axis, meters_per_unit, layer_stack), schema errors, and AR Quick Look compatibility with arkit_issues — every issue with a stable code and prim_path. ' +
      'mode=quick (default) runs no renders and finishes well under a second; mode=full adds analyze_performance and a front render. Call it first on any file, and after every mutation.',
    inputSchema: {
      path: PATH,
      profile: PERF_PROFILE.optional().describe('mode=full only: performance profile for the budget check (default ios_ar)'),
      mode: z.enum(['quick', 'full']).default('quick'),
    },
  }, async ({ path, profile, mode }) => {
    const loaded = await loadScene(path);
    const { data, diagnostics } = validationData(loaded, mode);
    let image: Preview['image'] | null = null;
    const extra: Record<string, unknown> = {};
    if (mode === 'full') {
      const perf = analyzePerformance(loaded.ir, profileOf(profile ?? 'ios_ar'));
      const { diagnostics: pd, ...perfData } = perf;
      extra.performance = perfData;
      diagnostics.push(...pd);
      const r = await renderIR(loaded.ir, { cameras: frontRig(), size: 256, textures: true });
      const sheet = await renderContactSheet(r.views, ['front'], 1);
      image = sheet.image;
      extra.render = { camera: cameraOf(r.views[0]), size: 256 };
    }
    const ir = loaded.ir;
    return reply({ ...data, ...extra }, {
      summary: `Validated ${basename(path)} (${ir.format}): ${counts(ir)} — ${data.opens ? 'opens' : 'does not open'}, ${data.arkit_compatible ? 'AR Quick Look compatible' : 'not AR Quick Look compatible'}, ${severityTail(diagnostics)}`,
      errors: diagnostics, image,
    });
  });

  registerEnvelopeTool(server, 'inspect_geometry', {
    annotations: READ_ONLY,
    description:
      'Per-mesh geometry facts keyed by prim_path: vertex/face/triangle counts, is_manifold, degenerate faces, normals authored|missing and inverted-normal count, UV sets with out-of-range flags, world bounding box in metres; ' +
      'scene-level bounds, pivot position (pivot_at_base for AR placement) and scale warnings (largest dimension < small_scale or > large_scale). Use it to decide whether an asset needs normals, rescaling or re-pivoting before export.',
    inputSchema: {
      path: PATH,
      small_scale: z.number().positive().default(0.01).describe('Metres; SCALE_TOO_SMALL below this'),
      large_scale: z.number().positive().default(20).describe('Metres; SCALE_TOO_LARGE above this'),
      topology: z.boolean().default(true).describe('Run the manifold / degenerate edge pass (O(n); skip for speed on huge meshes)'),
    },
  }, async ({ path, small_scale, large_scale, topology }) => {
    const loaded = await loadScene(path);
    const g = inspectGeometry(loaded.ir, { smallScale: small_scale, largeScale: large_scale, skipTopology: !topology });
    const { diagnostics, ...data } = g;
    const errors = [...loadErrors(loaded.ir), ...diagnostics];
    const dim = g.largest_dimension_m !== null ? `${g.largest_dimension_m.toPrecision(3)} m` : 'no geometry';
    return reply({ path, ...data }, { summary: `Geometry of ${basename(path)}: ${plural(g.mesh_count, 'mesh')}, ${g.total_triangles.toLocaleString('en-US')} triangles, largest dimension ${dim}, pivot ${g.pivot_at_base ? 'at base' : 'not at base'} — ${severityTail(errors)}`, errors });
  });

  registerEnvelopeTool(server, 'inspect_animation', {
    annotations: READ_ONLY,
    description:
      'Does anything actually move? Clips with time range / fps / duration, animated prims and which properties animate, skeletons (joint_count, bound_meshes, max_influences_per_vertex, unbound_vertex_count), ' +
      'blend shapes with is_driven, root motion. Codes: SKELETON_UNBOUND, MESH_NOT_DEFORMING, BLENDSHAPE_UNDRIVEN, ANIMATION_ZERO_LENGTH, ANIMATION_NO_MOTION. Call it before render_animation_strip or export_usdz on any rigged asset.',
    inputSchema: { path: PATH },
  }, async ({ path }) => {
    const loaded = await loadScene(path);
    const a = inspectAnimation(loaded.ir);
    const { diagnostics, ...data } = a;
    const errors = [...loadErrors(loaded.ir), ...diagnostics];
    const moving = a.clips.filter((c) => c.has_motion).length;
    return reply({ path, ...data }, {
      summary: a.has_animation
        ? `Animation in ${basename(path)}: ${plural(moving, 'moving clip')} (${a.duration_seconds.toFixed(2)} s), ${plural(a.skeletons.length, 'skeleton')}, ${plural(a.blend_shapes.length, 'blend shape')}${a.root_motion_detected ? ', root motion' : ''} — ${severityTail(errors)}`
        : `No animation in ${basename(path)}: ${plural(a.skeletons.length, 'skeleton')}, ${plural(a.blend_shapes.length, 'blend shape')}, ${plural(a.clips.length, 'clip')} — ${severityTail(errors)}`,
      errors,
    });
  });

  registerEnvelopeTool(server, 'inspect_materials', {
    annotations: READ_ONLY,
    description:
      'Materials with shader_type and bound_meshes, unbound_meshes, every texture (resolved, resolution, format, size_bytes, channel, color_space, used_by material+input, memory estimate), missing_textures, ' +
      'texture_memory_estimate_mb, non_power_of_two and oversized (threshold configurable). Codes: TEXTURE_UNRESOLVED, MATERIAL_UNBOUND, MESH_NO_MATERIAL, TEXTURE_OVERSIZED, TEXTURE_NPOT, TEXTURE_FORMAT_UNSUPPORTED.',
    inputSchema: {
      path: PATH,
      oversized_threshold: z.number().int().positive().default(2048).describe('Pixels; TEXTURE_OVERSIZED above this on either axis'),
    },
  }, async ({ path, oversized_threshold }) => {
    const loaded = await loadScene(path);
    const m = inspectMaterials(loaded.ir, { oversizedThreshold: oversized_threshold });
    const { diagnostics, ...data } = m;
    const errors = [...loadErrors(loaded.ir), ...diagnostics];
    return reply({ path, ...data, oversized_threshold }, {
      summary: `Materials of ${basename(path)}: ${plural(m.materials.length, 'material')}, ${plural(m.textures.length, 'texture')} (${m.texture_memory_estimate_mb} MB GPU), ${plural(m.missing_textures.length, 'missing texture')}, ${plural(m.unbound_meshes.length, 'mesh')} without material — ${severityTail(errors)}`,
      errors,
    });
  });

  registerEnvelopeTool(server, 'analyze_performance', {
    annotations: READ_ONLY,
    description:
      'Totals and estimates (triangles, vertices, draw calls, file size, GPU memory, prim count, scene depth, animation seconds), instancing_candidates, and a budget_check against a profile ' +
      '(ios_ar | visionos | web, a budget profile like mobile-hero, or custom_limits) — each overage names the metric, value, limit and worst_offender_prim_path. Use it to pick targetTriangles for optimize_glb.',
    inputSchema: { path: PATH, profile: PERF_PROFILE, custom_limits: CUSTOM_LIMITS },
  }, async ({ path, profile, custom_limits }) => {
    const loaded = await loadScene(path);
    const prof = profileOf(profile, custom_limits);
    const p = analyzePerformance(loaded.ir, prof);
    const { diagnostics, ...data } = p;
    const errors = [...loadErrors(loaded.ir), ...diagnostics];
    const { name: _n, description: _d, ...limits } = prof;
    return reply({ path, ...data, profile_limits: limits }, {
      summary: `${basename(path)} ${p.budget_check.pass ? 'passes' : 'fails'} ${prof.name}: ${p.total_triangles.toLocaleString('en-US')} triangles, ${plural(p.draw_call_estimate, 'draw call')}, ${(p.file_size_bytes / 1048576).toFixed(2)} MB, ~${p.estimated_gpu_memory_mb} MB GPU${p.budget_check.overages.length ? `; over on ${p.budget_check.overages.map((o) => o.metric.replace('max_', '')).join(', ')}` : ''}`,
      errors,
    });
  });

  registerEnvelopeTool(server, 'render', {
    annotations: WRITES_FILES,
    description:
      'Deterministic software render (no GPU) of any GLB / USDZ / USD: view=front (one straight-on view), thumbnail (one 3/4 view), turntable (N angles tiled into one contact sheet, default 8), ' +
      'or custom (explicit camera position/target/fov). Pass time (seconds) or frame (index at fps) to pose an animated asset. Returns the PNG plus the camera(s) used so you know what you are looking at. Optionally saves the PNG.',
    inputSchema: {
      path: PATH,
      view: z.enum(['front', 'turntable', 'custom', 'thumbnail']).default('front'),
      angles: z.number().int().min(2).max(24).default(8).describe('turntable: number of azimuths'),
      camera: z.object({ position: z.array(z.number()).length(3), target: z.array(z.number()).length(3).optional(), fov: z.number().min(5).max(120).optional() }).optional().describe('custom: eye position (world metres), look-at target (default scene centre), vertical fov in degrees (default 40)'),
      size: z.number().int().min(64).max(1024).default(256).describe('Pixels per view/tile'),
      time: z.number().min(0).optional().describe('Animation time in seconds (posed render)'),
      frame: z.number().int().min(0).optional().describe('Animation frame index at fps (alternative to time)'),
      fps: z.number().positive().default(30).describe('Frame rate used to convert frame → time (USD files use their own timeCodesPerSecond)'),
      animation: z.number().int().min(0).default(0).describe('Clip index when the asset has several'),
      textures: z.boolean().default(true).describe('Sample base-color textures'),
      out: z.string().optional().describe('Absolute path to also save the PNG'),
    },
  }, async ({ path, view, angles, camera, size, time, frame, fps, animation, textures, out }) => {
    const loaded = await loadScene(path);
    const ir = loaded.ir;
    const rate = ir.format.startsWith('usd') ? ir.fps ?? fps : fps;
    let t = time ?? (frame !== undefined ? frame / rate : undefined);
    if (t !== undefined) t = clampTime(ir, t, animation);
    let cameras: RenderCamera[];
    if (view === 'front') cameras = frontRig();
    else if (view === 'thumbnail') cameras = thumbnailRig();
    else if (view === 'turntable') cameras = turntableRig(angles);
    else {
      if (!camera) throw Object.assign(new Error('view=custom needs a camera {position, target?, fov?}'), { code: 'TOOL_ERROR' });
      const pre = await renderScene(ir, { cameras: frontRig(), size: 8 });
      cameras = customCamera(camera.position as [number, number, number], (camera.target ?? pre.frame.center) as [number, number, number], camera.fov ?? 40);
    }
    const r = await renderIR(ir, { cameras, size, time: t, animation, textures });
    const columns = view === 'turntable' ? Math.min(4, angles) : 1;
    const sheet = await renderContactSheet(r.views, r.views.map((v) => (t !== undefined ? `${v.name} @${t.toFixed(2)}s` : v.name)), columns);
    if (out) await writeFile(out, sheet.png);
    return reply({
      path, view, camera: cameraOf(r.views[0]), cameras: r.views.map((v) => ({ name: v.name, camera: cameraOf(v) })),
      size, width: sheet.width, height: sheet.height, columns, frame: t ?? null, triangles: r.triangles, ...(out ? { out } : {}),
    }, { summary: `Rendered ${basename(path)} ${view}${view === 'turntable' ? ` (${angles} angles)` : ''}${t !== undefined ? ` at ${t.toFixed(2)} s` : ''}: ${r.triangles.toLocaleString('en-US')} triangles, ${sheet.width}x${sheet.height}`, image: sheet.image });
  });

  registerEnvelopeTool(server, 'render_animation_strip', {
    annotations: WRITES_FILES,
    description:
      'Contact sheet of an animated asset at the requested frames (stills, labelled with frame and time) so you can verify that it moves the way it should. frames are indices at fps (or pass times in seconds). ' +
      'include_clip=true also writes an animated GIF next to the sheet for human reviewers. Run inspect_animation first to learn the clip range.',
    inputSchema: {
      path: PATH,
      frames: z.array(z.number().int().min(0)).optional().describe('Frame indices at fps, e.g. [0, 10, 20, 30]. Default: 8 evenly spaced frames over the clip'),
      times: z.array(z.number().min(0)).optional().describe('Times in seconds (alternative to frames)'),
      fps: z.number().positive().default(30).describe('Frame rate for frame → time (USD files use their own timeCodesPerSecond)'),
      animation: z.number().int().min(0).default(0).describe('Clip index'),
      view: z.enum(['front', 'thumbnail', 'custom']).default('front'),
      camera: z.object({ position: z.array(z.number()).length(3), target: z.array(z.number()).length(3).optional(), fov: z.number().min(5).max(120).optional() }).optional(),
      size: z.number().int().min(64).max(512).default(192).describe('Pixels per tile'),
      columns: z.number().int().min(1).max(8).default(4),
      textures: z.boolean().default(true),
      include_clip: z.boolean().default(false).describe('Also write an animated GIF (<out or path>.strip.gif)'),
      out: z.string().optional().describe('Absolute path to save the contact sheet PNG'),
    },
  }, async ({ path, frames, times, fps, animation, view, camera, size, columns, textures, include_clip, out }) => {
    const loaded = await loadScene(path);
    const ir = loaded.ir;
    const clip = ir.animations[animation] ?? null;
    const rate = ir.format.startsWith('usd') ? ir.fps ?? fps : fps;
    let list: Array<{ frame: number; time_seconds: number }>;
    if (times?.length) list = times.map((tm) => ({ frame: Math.round(tm * rate), time_seconds: tm }));
    else if (frames?.length) list = frames.map((f) => ({ frame: f, time_seconds: f / rate }));
    else if (clip) list = Array.from({ length: 8 }, (_, i) => { const tm = clip.start + ((clip.end - clip.start) * i) / 7; return { frame: Math.round(tm * rate), time_seconds: tm }; });
    else list = [{ frame: 0, time_seconds: 0 }];
    if (!clip) note(diag('ANIMATION_NO_MOTION', ir.format.startsWith('usd') ? ir.defaultPrim ?? '/' : '/Asset', `${basename(path)} has no animation clip; every frame shows the rest pose.`, { severity: 'warning' }));
    list = list.map((f) => ({ ...f, time_seconds: clip ? clampTime(ir, f.time_seconds, animation) : f.time_seconds }));
    let cameras: RenderCamera[] = view === 'front' ? frontRig() : thumbnailRig();
    // Fixed framing across frames: frame on the rest pose so the camera does not chase the motion.
    const rest = await renderScene(ir, { cameras: frontRig(), size: 8 });
    if (view === 'custom') {
      if (!camera) throw Object.assign(new Error('view=custom needs a camera {position, target?, fov?}'), { code: 'TOOL_ERROR' });
      cameras = customCamera(camera.position as [number, number, number], (camera.target ?? rest.frame.center) as [number, number, number], camera.fov ?? 40);
    }
    const views: RawView[] = [];
    const decoder = textures ? sharpTextureDecoder() : undefined;
    for (const f of list) {
      const r = await renderScene(ir, { cameras, size, supersample: 2, time: f.time_seconds, animation, frame: rest.frame, textureDecoder: decoder });
      views.push({ ...r.views[0], name: `f${f.frame}` });
    }
    const labels = list.map((f) => `f${f.frame} @${f.time_seconds.toFixed(2)}s`);
    const sheet = await renderContactSheet(views, labels, columns);
    if (out) await writeFile(out, sheet.png);
    let clip_file: string | null = null;
    if (include_clip) {
      clip_file = (out ?? path).replace(/\.[^.]+$/, '') + '.strip.gif';
      try { await writeFile(clip_file, await renderGif(views, Math.round(1000 / Math.max(1, Math.min(rate, 12))))); }
      catch (err) { clip_file = null; note(diag('CLIP_FORMAT_UNSUPPORTED', '', `GIF encoding failed: ${err instanceof Error ? err.message : String(err)}`)); }
      note(diag('CLIP_FORMAT_UNSUPPORTED', '', 'Only animated GIF can be written with this stack (no mp4 encoder); assemble the frames with ffmpeg if you need video.'));
    }
    return reply({
      path, frames: list.map((f, i) => ({ ...f, label: labels[i] })), fps: rate,
      clip: clip ? { index: animation, name: clip.name, duration_seconds: clip.end - clip.start } : null,
      camera: cameraOf(views[0]), size, width: sheet.width, height: sheet.height, columns, ...(out ? { out } : {}), clip_file,
    }, { summary: `Animation strip of ${basename(path)}: ${plural(list.length, 'frame')} from ${clip ? `"${clip.name}" (${(clip.end - clip.start).toFixed(2)} s)` : 'a static asset'}, ${sheet.width}x${sheet.height}${clip_file ? `, GIF at ${clip_file}` : ''}`, image: sheet.image });
  });

  registerEnvelopeTool(server, 'inspect_all', {
    annotations: READ_ONLY,
    description:
      'Everything at once for an unfamiliar asset: validate + inspect_geometry + inspect_animation + inspect_materials + analyze_performance merged into one response, errors deduplicated. ' +
      'Call this first, then the individual tools for details or after a fix.',
    inputSchema: { path: PATH, profile: PERF_PROFILE, custom_limits: CUSTOM_LIMITS },
  }, async ({ path, profile, custom_limits }) => {
    const loaded = await loadScene(path);
    const ir = loaded.ir;
    const v = validationData(loaded, 'quick');
    const g = inspectGeometry(ir);
    const a = inspectAnimation(ir);
    const m = inspectMaterials(ir);
    const p = analyzePerformance(ir, profileOf(profile, custom_limits));
    const errors: Diagnostic[] = [...v.diagnostics, ...g.diagnostics, ...a.diagnostics, ...m.diagnostics, ...p.diagnostics];
    noteAll([]);
    const { path: _p, mode: _m, sha256: sha, ...validation } = v.data;
    const strip = <T extends { diagnostics: Diagnostic[] }>(x: T) => { const { diagnostics: _d, ...rest } = x; return rest; };
    return reply({ path, validation, geometry: strip(g), animation: strip(a), materials: { ...strip(m), oversized_threshold: 2048 }, performance: { ...strip(p), profile_limits: Object.fromEntries(Object.entries(profileOf(profile, custom_limits)).filter(([k]) => k !== 'name' && k !== 'description')) }, sha256: sha }, {
      summary: `${basename(path)} (${ir.format}): ${counts(ir)}, ${g.total_triangles.toLocaleString('en-US')} triangles, ${a.has_animation ? 'animated' : 'static'}, ${p.budget_check.pass ? 'within' : 'over'} ${p.budget_check.profile}${v.data.arkit_compatible ? '' : ', not AR Quick Look compatible'} — ${severityTail(errors)}`,
      errors,
    });
  });
}
