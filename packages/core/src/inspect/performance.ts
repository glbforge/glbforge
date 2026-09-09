/**
 * analyze_performance: totals, estimates, instancing candidates, and a
 * budget check against a performance profile with the worst offender's
 * prim path per overage.
 */
import { diag, type Diagnostic, type DiagnosticCode } from './diagnostics.js';
import { geometryFingerprint, sceneGraphDepth, type SceneIR } from './ir.js';
import { textureVramBytes } from './materials.js';
import { PERFORMANCE_LIMIT_KEYS, type PerformanceLimitKey, type PerformanceProfile } from './perf-profiles.js';

export interface Overage {
  metric: PerformanceLimitKey;
  value: number;
  limit: number;
  worst_offender_prim_path: string;
}

export interface PerformanceReport {
  total_triangles: number;
  total_vertices: number;
  draw_call_estimate: number;
  material_count: number;
  texture_count: number;
  file_size_bytes: number;
  estimated_gpu_memory_mb: number;
  gpu_memory_breakdown_mb: { textures: number; geometry: number };
  texture_bytes: number;
  largest_texture_px: number;
  prim_count: number;
  scene_graph_depth: number;
  animation_seconds: number;
  instancing_candidates: Array<{ prims: string[]; copies: number; triangle_count: number }>;
  budget_check: { profile: string; pass: boolean; overages: Overage[] };
  diagnostics: Diagnostic[];
}

const CODE_FOR: Record<PerformanceLimitKey, DiagnosticCode> = {
  max_triangles: 'TRIANGLE_BUDGET_EXCEEDED',
  max_vertices: 'VERTEX_BUDGET_EXCEEDED',
  max_draw_calls: 'DRAW_CALL_BUDGET_EXCEEDED',
  max_materials: 'MATERIAL_BUDGET_EXCEEDED',
  max_textures: 'TEXTURE_BYTES_BUDGET_EXCEEDED',
  max_file_bytes: 'FILE_SIZE_BUDGET_EXCEEDED',
  max_gpu_memory_mb: 'GPU_MEMORY_BUDGET_EXCEEDED',
  max_texture_size: 'TEXTURE_SIZE_BUDGET_EXCEEDED',
  max_texture_bytes: 'TEXTURE_BYTES_BUDGET_EXCEEDED',
  max_prim_count: 'PRIM_COUNT_BUDGET_EXCEEDED',
  max_scene_depth: 'SCENE_DEPTH_BUDGET_EXCEEDED',
  max_animation_seconds: 'ANIMATED_ASSET',
};

const mb = (b: number) => Math.round((b / 1048576) * 100) / 100;

export function analyzePerformance(ir: SceneIR, profile: PerformanceProfile): PerformanceReport {
  const diagnostics: Diagnostic[] = [];
  const rootPath = ir.format.startsWith('usd') ? ir.defaultPrim ?? '/' : '/Asset';

  let tris = 0, verts = 0, geoBytes = 0;
  let heaviest: { path: string; tris: number } = { path: rootPath, tris: -1 };
  for (const m of ir.meshes) {
    tris += m.triangleCount; verts += m.vertexCount; geoBytes += m.geometryBytes;
    if (m.triangleCount > heaviest.tris) heaviest = { path: m.path, tris: m.triangleCount };
  }
  const drawCalls = ir.meshes.filter((m) => m.mode === 'triangles' && m.triangleCount > 0).length;
  let texVram = 0, texBytes = 0, largestPx = 0;
  let largestTex = rootPath, heaviestTex = rootPath, heaviestTexVram = -1, largestDim = -1;
  for (const t of ir.textures) {
    const v = textureVramBytes(t.width, t.height, t.mimeType);
    texVram += v; texBytes += t.bytes;
    const dim = Math.max(t.width ?? 0, t.height ?? 0);
    if (dim > largestPx) largestPx = dim;
    if (dim > largestDim) { largestDim = dim; largestTex = t.path; }
    if (v > heaviestTexVram) { heaviestTexVram = v; heaviestTex = t.path; }
  }
  const depth = sceneGraphDepth(ir);
  let deepest = rootPath;
  {
    const visit = (i: number, d: number, best: { d: number }) => { if (d > best.d) { best.d = d; deepest = ir.nodes[i].path; } for (const c of ir.nodes[i].children) visit(c, d + 1, best); };
    const best = { d: 0 };
    for (const r of ir.roots) visit(r, 1, best);
  }
  const busiestNode = ir.nodes.reduce((b, n) => (n.meshes.length > (b?.meshes.length ?? 0) ? n : b), ir.nodes[0]);
  const animSeconds = ir.animations.reduce((s, a) => s + (a.end - a.start) / (ir.format.startsWith('usd') ? ir.fps ?? 24 : 1), 0);

  // Instancing candidates: identical geometry that is not shared (different source meshes).
  const byFingerprint = new Map<string, { prims: string[]; sources: Set<number>; tris: number }>();
  for (const m of ir.meshes) {
    if (m.triangleCount < 12) continue;
    const key = geometryFingerprint(m);
    const e = byFingerprint.get(key) ?? { prims: [], sources: new Set(), tris: m.triangleCount };
    e.prims.push(m.path); e.sources.add(m.sourceMesh);
    byFingerprint.set(key, e);
  }
  const instancing_candidates = [...byFingerprint.values()].filter((e) => e.sources.size > 1)
    .map((e) => ({ prims: e.prims, copies: e.sources.size, triangle_count: e.tris }));
  for (const c of instancing_candidates) {
    diagnostics.push(diag('INSTANCING_CANDIDATE', c.prims[0], `${c.copies} separate copies of the same ${c.triangle_count}-triangle geometry: ${c.prims.join(', ')}.`, { data: { prims: c.prims, copies: c.copies } }));
  }

  const values: Record<PerformanceLimitKey, { value: number; worst: string }> = {
    max_triangles: { value: tris, worst: heaviest.path },
    max_vertices: { value: verts, worst: heaviest.path },
    max_draw_calls: { value: drawCalls, worst: busiestNode?.path ?? rootPath },
    max_materials: { value: ir.materials.length, worst: rootPath },
    max_textures: { value: ir.textures.length, worst: rootPath },
    max_file_bytes: { value: ir.fileBytes, worst: heaviestTexVram > 0 ? heaviestTex : heaviest.path },
    max_gpu_memory_mb: { value: mb(texVram + geoBytes), worst: heaviestTexVram > 0 && heaviestTexVram > geoBytes ? heaviestTex : heaviest.path },
    max_texture_size: { value: largestPx, worst: largestTex },
    max_texture_bytes: { value: texBytes, worst: heaviestTex },
    max_prim_count: { value: ir.primCount, worst: rootPath },
    max_scene_depth: { value: depth, worst: deepest },
    max_animation_seconds: { value: animSeconds, worst: ir.animations[0]?.path ?? rootPath },
  };
  const overages: Overage[] = [];
  for (const key of PERFORMANCE_LIMIT_KEYS) {
    const limit = profile[key];
    if (typeof limit !== 'number') continue;
    const { value, worst } = values[key];
    if (value <= limit) continue;
    overages.push({ metric: key, value, limit, worst_offender_prim_path: worst });
    const severity = key === 'max_animation_seconds' ? 'info' : undefined;
    diagnostics.push(diag(CODE_FOR[key], worst, `${key.replace('max_', '')} = ${Number.isInteger(value) ? value.toLocaleString('en-US') : value} exceeds the ${profile.name} limit of ${limit.toLocaleString('en-US')} (${(value / limit).toFixed(1)}x).`, { severity, data: { metric: key, value, limit } }));
  }

  return {
    total_triangles: tris, total_vertices: verts, draw_call_estimate: drawCalls,
    material_count: ir.materials.length, texture_count: ir.textures.length,
    file_size_bytes: ir.fileBytes,
    estimated_gpu_memory_mb: mb(texVram + geoBytes), gpu_memory_breakdown_mb: { textures: mb(texVram), geometry: mb(geoBytes) },
    texture_bytes: texBytes, largest_texture_px: largestPx,
    prim_count: ir.primCount, scene_graph_depth: depth, animation_seconds: Math.round(animSeconds * 1000) / 1000,
    instancing_candidates,
    budget_check: { profile: profile.name, pass: overages.length === 0, overages },
    diagnostics,
  };
}
