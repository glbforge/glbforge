/**
 * Performance profiles for analyze_performance. These are the agent-facing
 * targets (ios_ar / visionos / web) — separate from the versioned web
 * delivery budgets in profiles.ts, which remain contracts with their own
 * SSIM floors. Any of the legacy budget names (mobile-hero, desktop-hero,
 * product-configurator, optionally @version) is accepted too and mapped
 * onto the same limit keys. A custom profile is a JSON object with any
 * subset of the limit keys. Documented in docs/performance-profiles.md.
 */
import { getProfile, PROFILE_VERSIONS } from '../profiles.js';

export interface PerformanceProfile {
  name: string;
  description: string;
  max_triangles?: number;
  max_vertices?: number;
  max_draw_calls?: number;
  max_materials?: number;
  max_textures?: number;
  max_file_bytes?: number;
  /** Decoded textures + geometry buffers, in MB. */
  max_gpu_memory_mb?: number;
  /** Largest texture dimension in pixels. */
  max_texture_size?: number;
  /** Total encoded texture payload in bytes. */
  max_texture_bytes?: number;
  max_prim_count?: number;
  max_scene_depth?: number;
  /** Total clip duration a runtime is expected to keep resident, seconds (advisory). */
  max_animation_seconds?: number;
}

export type PerformanceLimitKey = Exclude<keyof PerformanceProfile, 'name' | 'description'>;

export const PERFORMANCE_LIMIT_KEYS: PerformanceLimitKey[] = [
  'max_triangles', 'max_vertices', 'max_draw_calls', 'max_materials', 'max_textures', 'max_file_bytes',
  'max_gpu_memory_mb', 'max_texture_size', 'max_texture_bytes', 'max_prim_count', 'max_scene_depth', 'max_animation_seconds',
];

const MB = 1048576;

export const PERFORMANCE_PROFILES: Record<string, PerformanceProfile> = {
  ios_ar: {
    name: 'ios_ar',
    description: 'AR Quick Look on iPhone/iPad (USDZ). Apple guidance: ~100k triangles, 2048px textures, a package that downloads in a few seconds over cellular.',
    max_triangles: 100_000,
    max_vertices: 200_000,
    max_draw_calls: 16,
    max_materials: 8,
    max_textures: 12,
    max_file_bytes: 25 * MB,
    max_gpu_memory_mb: 128,
    max_texture_size: 2048,
    max_texture_bytes: 12 * MB,
    max_prim_count: 500,
    max_scene_depth: 16,
    max_animation_seconds: 30,
  },
  visionos: {
    name: 'visionos',
    description: 'RealityKit on Apple Vision Pro (USDZ / Reality Composer Pro). Several entities coexist in a shared space, so per-asset budgets stay moderate.',
    max_triangles: 200_000,
    max_vertices: 400_000,
    max_draw_calls: 32,
    max_materials: 16,
    max_textures: 24,
    max_file_bytes: 50 * MB,
    max_gpu_memory_mb: 256,
    max_texture_size: 2048,
    max_texture_bytes: 24 * MB,
    max_prim_count: 1000,
    max_scene_depth: 16,
    max_animation_seconds: 60,
  },
  web: {
    name: 'web',
    description: 'General web viewer (three.js / model-viewer) on a mid-range device. For a gated, versioned contract use the mobile-hero / desktop-hero budgets instead.',
    max_triangles: 200_000,
    max_vertices: 300_000,
    max_draw_calls: 16,
    max_materials: 8,
    max_textures: 12,
    max_file_bytes: 10 * MB,
    max_gpu_memory_mb: 128,
    max_texture_size: 2048,
    max_texture_bytes: 6 * MB,
    max_prim_count: 500,
    max_scene_depth: 16,
    max_animation_seconds: 60,
  },
};

/** Legacy budget profile (profiles.ts) expressed as a performance profile. */
export function fromBudgetProfile(spec: string): PerformanceProfile {
  const p = getProfile(spec);
  return {
    name: `${p.name}@${p.version}`, description: p.description,
    max_triangles: p.maxTriangles, max_draw_calls: p.maxDrawCalls, max_materials: p.maxMaterials,
    max_file_bytes: p.maxFileBytes, max_gpu_memory_mb: Math.round(p.maxTextureVramBytes / MB),
    max_texture_size: p.maxTextureSize, max_texture_bytes: p.maxTextureBytes,
  };
}

/**
 * Resolve a profile argument: a known name (ios_ar | visionos | web), a legacy
 * budget name (mobile-hero[@N] …), or a custom object of limits.
 */
export function resolvePerformanceProfile(spec: string | Partial<PerformanceProfile> | undefined): PerformanceProfile {
  if (!spec) return PERFORMANCE_PROFILES.ios_ar;
  if (typeof spec === 'object') {
    const limits: Partial<PerformanceProfile> = {};
    for (const k of PERFORMANCE_LIMIT_KEYS) if (typeof spec[k] === 'number') (limits as Record<string, number>)[k] = spec[k] as number;
    return { name: spec.name ?? 'custom', description: spec.description ?? 'Custom limits supplied by the caller.', ...limits };
  }
  const key = spec.trim();
  if (PERFORMANCE_PROFILES[key]) return PERFORMANCE_PROFILES[key];
  const base = key.replace(/@\d+$/, '');
  if (PROFILE_VERSIONS[base]) return fromBudgetProfile(key);
  throw new Error(`Unknown performance profile "${spec}". Known: ${Object.keys(PERFORMANCE_PROFILES).join(', ')}, ${Object.keys(PROFILE_VERSIONS).join(', ')} (or a custom object of max_* limits).`);
}
