/**
 * inspect_materials: materials and their bindings, textures with resolution
 * / format / channel / color space / users, unresolved references, memory
 * estimate, non-power-of-two and oversized textures.
 */
import { diag, type Diagnostic } from './diagnostics.js';
import type { SceneIR } from './ir.js';

export interface MaterialsInspectOptions {
  /** Texture dimension above which TEXTURE_OVERSIZED fires. Default 2048. */
  oversizedThreshold?: number;
}

export interface TextureReport {
  prim_path: string;
  name: string;
  /** External path / package entry, or "embedded". */
  path: string;
  resolved: boolean;
  resolution: [number, number] | null;
  format: string | null;
  size_bytes: number;
  /** Channels read by its users, e.g. "rgba" or "g,b". */
  channel: string;
  color_space: 'sRGB' | 'raw' | 'auto' | 'mixed';
  used_by: Array<{ material: string; input: string; channel: string }>;
  memory_estimate_mb: number;
  is_power_of_two: boolean | null;
}

export interface MaterialReport {
  prim_path: string;
  name: string;
  shader_type: string;
  bound_meshes: string[];
  inputs: Array<{ input: string; texture: string; channel: string; color_space: string; tex_coord: number }>;
  alpha_mode: string;
  double_sided: boolean;
  unsupported_features: string[];
}

export interface MaterialsReport {
  materials: MaterialReport[];
  unbound_meshes: string[];
  textures: TextureReport[];
  missing_textures: Array<{ texture: string; path: string; material: string; input: string }>;
  texture_memory_estimate_mb: number;
  non_power_of_two: string[];
  oversized: string[];
  diagnostics: Diagnostic[];
}

const isPot = (n: number) => n > 0 && (n & (n - 1)) === 0;
const mb = (bytes: number) => Math.round((bytes / 1048576) * 100) / 100;

/** Decoded GPU bytes incl. mipmaps: RGBA8, or ~4 bpp for KTX2. */
export function textureVramBytes(width: number | null, height: number | null, mimeType: string | null): number {
  if (!width || !height) return 0;
  const base = mimeType === 'image/ktx2' ? width * height : width * height * 4;
  return Math.round(base * 1.33);
}

export function inspectMaterials(ir: SceneIR, opts: MaterialsInspectOptions = {}): MaterialsReport {
  const threshold = opts.oversizedThreshold ?? 2048;
  const diagnostics: Diagnostic[] = [];
  const usedBy = new Map<number, TextureReport['used_by']>();
  const channelsOf = new Map<number, Set<string>>();
  const spacesOf = new Map<number, Set<string>>();

  const materials: MaterialReport[] = ir.materials.map((m) => {
    const bound = ir.meshes.filter((x) => x.material === m.index).map((x) => x.path);
    const inputs = m.textures.map((u) => {
      const tex = ir.textures[u.texture];
      usedBy.set(u.texture, [...(usedBy.get(u.texture) ?? []), { material: m.path, input: u.input, channel: u.channel }]);
      channelsOf.set(u.texture, new Set([...(channelsOf.get(u.texture) ?? []), u.channel]));
      spacesOf.set(u.texture, new Set([...(spacesOf.get(u.texture) ?? []), u.colorSpace]));
      return { input: u.input, texture: tex?.path ?? '', channel: u.channel, color_space: u.colorSpace, tex_coord: u.texCoord };
    });
    if (bound.length === 0) diagnostics.push(diag('MATERIAL_UNBOUND', m.path, `Material "${m.name}" is not bound to any mesh.`, { property: 'material:binding' }));
    if (m.unsupportedFeatures.length) {
      diagnostics.push(diag('MATERIAL_FEATURE_UNSUPPORTED', m.path, `Material "${m.name}" uses ${m.unsupportedFeatures.join(', ')}; not representable in UsdPreviewSurface / basic PBR.`, { data: { features: m.unsupportedFeatures } }));
    }
    if (m.alphaMode === 'BLEND') {
      const base = m.textures.find((u) => u.input === 'baseColor');
      const tex = base ? ir.textures[base.texture] : null;
      if (tex && tex.hasAlpha === false) {
        diagnostics.push(diag('MATERIAL_BLEND_WITHOUT_ALPHA', m.path, `Material "${m.name}" is set to BLEND but its base color image has no alpha channel.`, { property: 'inputs:opacity' }));
      } else {
        diagnostics.push(diag('MATERIAL_ALPHA_BLEND', m.path, `Material "${m.name}" uses alpha blending.`, { property: 'inputs:opacity' }));
      }
    }
    return {
      prim_path: m.path, name: m.name, shader_type: m.shaderType, bound_meshes: bound, inputs,
      alpha_mode: m.alphaMode, double_sided: m.doubleSided, unsupported_features: m.unsupportedFeatures,
    };
  });

  const unbound_meshes = ir.meshes.filter((m) => m.material === null && m.mode === 'triangles').map((m) => m.path);
  for (const p of unbound_meshes) diagnostics.push(diag('MESH_NO_MATERIAL', p, `${p} has no material binding.`, { property: 'material:binding' }));

  const textures: TextureReport[] = [];
  const missing: MaterialsReport['missing_textures'] = [];
  const npot: string[] = [], oversized: string[] = [];
  let vramTotal = 0;
  for (const t of ir.textures) {
    const users = usedBy.get(t.index) ?? [];
    const vram = textureVramBytes(t.width, t.height, t.mimeType);
    vramTotal += vram;
    const spaces = [...(spacesOf.get(t.index) ?? [])];
    const pot = t.width && t.height ? isPot(t.width) && isPot(t.height) : null;
    const report: TextureReport = {
      prim_path: t.path, name: t.name, path: t.uri ?? 'embedded', resolved: t.resolved,
      resolution: t.width && t.height ? [t.width, t.height] : null,
      format: t.mimeType, size_bytes: t.bytes,
      channel: [...(channelsOf.get(t.index) ?? [])].join(',') || 'unused',
      color_space: spaces.length === 0 ? 'auto' : spaces.length === 1 ? (spaces[0] as TextureReport['color_space']) : 'mixed',
      used_by: users, memory_estimate_mb: mb(vram), is_power_of_two: pot,
    };
    textures.push(report);
    if (!t.resolved) {
      if (users.length === 0) {
        missing.push({ texture: t.path, path: t.uri ?? 'embedded', material: '', input: '' });
        diagnostics.push(diag('TEXTURE_UNRESOLVED', t.path, `Texture "${t.name}" (${t.uri ?? 'embedded'}) could not be resolved.`, { property: 'inputs:file' }));
      }
      for (const u of users) {
        missing.push({ texture: t.path, path: t.uri ?? 'embedded', material: u.material, input: u.input });
        diagnostics.push(diag('TEXTURE_UNRESOLVED', u.material, `Texture "${t.uri ?? t.name}" referenced by ${u.material} (${u.input}) could not be resolved.`, { property: `inputs:${u.input}`, data: { texture: t.path, path: t.uri } }));
      }
      continue;
    }
    if (users.length === 0) diagnostics.push(diag('TEXTURE_UNUSED', t.path, `Texture "${t.name}" is not used by any material.`));
    if (pot === false) {
      npot.push(t.path);
      diagnostics.push(diag('TEXTURE_NPOT', t.path, `Texture "${t.name}" is ${t.width}x${t.height} (not a power of two).`, { data: { width: t.width, height: t.height } }));
    }
    if ((t.width ?? 0) > threshold || (t.height ?? 0) > threshold) {
      oversized.push(t.path);
      diagnostics.push(diag('TEXTURE_OVERSIZED', t.path, `Texture "${t.name}" is ${t.width}x${t.height}; threshold ${threshold}px. Used by: ${users.map((u) => `${u.material} (${u.input})`).join(', ') || 'nothing'}.`, { data: { width: t.width, height: t.height, threshold } }));
    }
    if (t.mimeType === 'image/ktx2') {
      diagnostics.push(diag('TEXTURE_FORMAT_UNSUPPORTED', t.path, `Texture "${t.name}" is KTX2; only web runtimes with a Basis transcoder decode it, and USDZ cannot carry it.`, { severity: 'info', data: { format: t.mimeType } }));
    }
  }

  return {
    materials, unbound_meshes, textures, missing_textures: missing,
    texture_memory_estimate_mb: mb(vramTotal), non_power_of_two: npot, oversized, diagnostics,
  };
}
