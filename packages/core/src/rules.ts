import type { AnalysisResult, Finding } from './types.js';

type Rule = (r: AnalysisResult) => Finding | Finding[] | null;

const fmt = (n: number) => n.toLocaleString('en-US');
const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1) + 'MB';

/**
 * Named lint rules. `perf/*` are budget violations (errors — they fail CI).
 * `geo/*`, `topo/*`, `mat/*` describe defects typical of AI-generated
 * assets; most are warnings with a concrete fix attached.
 */
const RULES: Record<string, Rule> = {
  'perf/triangle-budget': (r) => {
    const { triangles } = r.geometry;
    const max = r.profile.maxTriangles;
    if (triangles <= max) return null;
    return {
      ruleId: 'perf/triangle-budget',
      severity: 'error',
      message: `${fmt(triangles)} triangles exceeds the ${r.profile.name} budget of ${fmt(max)} (${(triangles / max).toFixed(1)}x over).`,
      suggestion: `Simplify to ~${fmt(max)} triangles (xui optimize applies meshopt simplification), or switch to a profile with more headroom.`,
      data: { triangles, max },
    };
  },

  'perf/draw-calls': (r) => {
    const calls = r.geometry.drawCallEstimate;
    if (calls <= r.profile.maxDrawCalls) return null;
    return {
      ruleId: 'perf/draw-calls',
      severity: 'error',
      message: `~${calls} draw calls (one per primitive) exceeds budget of ${r.profile.maxDrawCalls}.`,
      suggestion: 'Merge primitives sharing a material (join), or palette/atlas materials to enable merging.',
      data: { calls, max: r.profile.maxDrawCalls },
    };
  },

  'perf/file-size': (r) => {
    if (!r.file.bytes || r.file.bytes <= r.profile.maxFileBytes) return null;
    return {
      ruleId: 'perf/file-size',
      severity: 'error',
      message: `File is ${mb(r.file.bytes)}; budget for ${r.profile.name} is ${mb(r.profile.maxFileBytes)}.`,
      suggestion: 'Geometry compression (meshopt/Draco) plus texture resize/WebP typically cuts AI-generated GLBs by 80-95%.',
      data: { bytes: r.file.bytes, max: r.profile.maxFileBytes },
    };
  },

  'tex/oversized': (r) => {
    const max = r.profile.maxTextureSize;
    const offenders = r.textures.filter(
      (t) => (t.width ?? 0) > max || (t.height ?? 0) > max,
    );
    return offenders.map((t) => ({
      ruleId: 'tex/oversized',
      severity: 'error' as const,
      message: `Texture "${t.name}" is ${t.width}x${t.height} (${mb(t.bytes)}); profile cap is ${max}px. Used by: ${t.slots.join(', ') || 'nothing'}.`,
      suggestion: `Resize to ${max}px and re-encode (WebP/KTX2). Detail loss is rarely visible at hero-asset screen sizes.`,
      data: { texture: t.name, width: t.width, height: t.height, max },
    }));
  },

  'tex/total-weight': (r) => {
    if (r.textureBytesTotal <= r.profile.maxTextureBytes) return null;
    return {
      ruleId: 'tex/total-weight',
      severity: 'error',
      message: `Total texture payload ${mb(r.textureBytesTotal)} exceeds ${mb(r.profile.maxTextureBytes)} budget.`,
      suggestion: 'Resize + convert to WebP or KTX2; drop occlusion maps that duplicate baked AO in baseColor.',
      data: { bytes: r.textureBytesTotal, max: r.profile.maxTextureBytes },
    };
  },

  'geo/missing-normals': (r) => {
    const n = r.geometry.primsMissingNormals;
    if (n === 0) return null;
    return {
      ruleId: 'geo/missing-normals',
      severity: 'warn',
      message: `${n} of ${r.geometry.primitiveCount} primitive(s) have no NORMAL attribute — three.js will shade them flat or black until normals are computed.`,
      suggestion: 'Generate smooth vertex normals during optimization (cheap, deterministic). Typical of Meshy geometry-stage exports.',
      data: { primitives: n },
    };
  },

  'geo/missing-uvs': (r) => {
    const n = r.geometry.primsMissingUVs;
    if (n === 0) return null;
    return {
      ruleId: 'geo/missing-uvs',
      severity: 'warn',
      message: `${n} primitive(s) have no TEXCOORD attribute — the asset cannot be textured as-is.`,
      suggestion: 'If this is a pre-texture generation export, run the texture stage (or unwrap in a DCC) before shipping.',
      data: { primitives: n },
    };
  },

  'geo/unindexed': (r) => {
    const n = r.geometry.primsUnindexed;
    if (n === 0) return null;
    return {
      ruleId: 'geo/unindexed',
      severity: 'warn',
      message: `${n} primitive(s) are unindexed — roughly 3x the vertex data needed, and no GPU vertex cache reuse.`,
      suggestion: 'Weld + index during optimization.',
      data: { primitives: n },
    };
  },

  'mat/no-material': (r) => {
    const bare = r.geometry.primitives.filter((p) => !p.materialName).length;
    if (bare === 0) return null;
    return {
      ruleId: 'mat/no-material',
      severity: 'info',
      message: `${bare} primitive(s) have no material and will render with the default white PBR material.`,
      suggestion: 'Assign a material, or expect to set one in the viewer.',
      data: { primitives: bare },
    };
  },

  'mat/duplicate-materials': (r) => {
    if (r.duplicateMaterialGroups.length === 0) return null;
    return {
      ruleId: 'mat/duplicate-materials',
      severity: 'warn',
      message: `${r.duplicateMaterialGroups.length} group(s) of identical materials: ${r.duplicateMaterialGroups.map((g) => g.join(' = ')).join('; ')}. AI exporters often emit one material per submesh.`,
      suggestion: 'Deduplicate, then merge the primitives that shared them to cut draw calls.',
      data: { groups: r.duplicateMaterialGroups },
    };
  },

  'mat/blend-alpha': (r) => {
    const blended = r.materials.filter((m) => m.alphaMode === 'BLEND');
    if (blended.length === 0) return null;
    return {
      ruleId: 'mat/blend-alpha',
      severity: 'info',
      message: `Material(s) using alpha BLEND: ${blended.map((m) => m.name).join(', ')}. Blending disables depth-write and causes sorting artifacts; AI exports often set it unintentionally.`,
      suggestion: 'If the texture has no meaningful alpha, switch to OPAQUE; for cutout-style alpha use MASK.',
      data: { materials: blended.map((m) => m.name) },
    };
  },

  'topo/unwelded': (r) => {
    const t = r.geometry.topology;
    if (!t) return null;
    // Position-only duplicates are usually UV-seam splits (required by the
    // format); only fully-identical vertices are actual waste.
    const ratio = t.redundantVertices / Math.max(1, r.geometry.vertices);
    if (ratio < 0.05) return null;
    return {
      ruleId: 'topo/unwelded',
      severity: 'warn',
      message: `${fmt(t.redundantVertices)} vertices (${(ratio * 100).toFixed(0)}%) are exact duplicates across all attributes — pure waste from an unwelded export.`,
      suggestion: 'Weld during optimization; this also unlocks better simplification and smaller files.',
      data: { redundant: t.redundantVertices, ratio },
    };
  },

  'topo/non-manifold': (r) => {
    const t = r.geometry.topology;
    if (!t || t.nonManifoldEdges === 0) return null;
    return {
      ruleId: 'topo/non-manifold',
      severity: 'warn',
      message: `${fmt(t.nonManifoldEdges)} non-manifold edge(s) (shared by 3+ triangles).`,
      suggestion: 'Harmless for display; problematic for physics, boolean ops, or 3D printing. Repair in a DCC if those matter.',
      data: { edges: t.nonManifoldEdges },
    };
  },

  'topo/degenerate': (r) => {
    const t = r.geometry.topology;
    if (!t || t.degenerateTriangles === 0) return null;
    return {
      ruleId: 'topo/degenerate',
      severity: 'warn',
      message: `${fmt(t.degenerateTriangles)} degenerate (zero-area) triangle(s).`,
      suggestion: 'Pruned automatically during optimization.',
      data: { triangles: t.degenerateTriangles },
    };
  },

  'scene/scale-sanity': (r) => {
    const b = r.geometry.bounds;
    if (!b) return null;
    const largest = Math.max(...b.size);
    if (largest > 0.01 && largest < 100) return null;
    return {
      ruleId: 'scene/scale-sanity',
      severity: 'warn',
      message: `Largest bounding-box dimension is ${largest.toPrecision(3)} — glTF units are meters, so this asset is ${largest >= 100 ? 'building-sized or larger' : 'smaller than a coin'}.`,
      suggestion: 'Normalize scale during optimization so cameras, lighting, and physics behave predictably.',
      data: { size: b.size },
    };
  },
};

export function runRules(result: AnalysisResult): Finding[] {
  const findings: Finding[] = [];
  for (const rule of Object.values(RULES)) {
    const out = rule(result);
    if (!out) continue;
    findings.push(...(Array.isArray(out) ? out : [out]));
  }
  const order = { error: 0, warn: 1, info: 2 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity]);
}

export const RULE_IDS = Object.keys(RULES);
