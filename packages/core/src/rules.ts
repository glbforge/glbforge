import { undecodableTexture } from './analyze/materials.js';
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
    const { triangles, uniqueTriangles, instancedNodes } = r.geometry;
    const max = r.profile.maxTriangles;
    if (triangles <= max) return null;
    // Naming the instancing matters: the mesh list can sit comfortably under
    // the cap while the scene draws several times over it, and the fix is to
    // place fewer copies, not to simplify the mesh.
    const instanced = instancedNodes > 0 && triangles > uniqueTriangles
      ? ` The mesh list holds ${fmt(uniqueTriangles)}; the scene places them across ${fmt(instancedNodes + 1)} nodes, and every copy is drawn.`
      : '';
    return {
      ruleId: 'perf/triangle-budget',
      severity: 'error',
      message: `${fmt(triangles)} triangles exceeds the ${r.profile.name} budget of ${fmt(max)} (${(triangles / max).toFixed(1)}x over).${instanced}`,
      suggestion: instanced
        ? `Place fewer copies, or simplify the shared meshes — each one costs its triangle count every time it is drawn.`
        : `Simplify to ~${fmt(max)} triangles (glbforge optimize applies meshopt simplification), or switch to a profile with more headroom.`,
      data: { triangles, uniqueTriangles, max },
    };
  },

  'perf/draw-calls': (r) => {
    const calls = r.geometry.drawCallEstimate;
    if (calls <= r.profile.maxDrawCalls) return null;
    // Where the calls come from still matters for what the fix costs, even
    // though optimize_glb can act on either: joining primitives that already
    // share one mesh is free (nothing else was paying for them), but joining
    // separate NODES placing a shared mesh bakes out the copies dedup just
    // made and gives up that memory win to buy the draw call back. Same split
    // perf/triangle-budget already makes.
    const instanced = r.geometry.instancedNodes > 0;
    return {
      ruleId: 'perf/draw-calls',
      severity: 'error',
      message: `~${calls} draw calls (one per primitive, per node that places it) exceeds budget of ${r.profile.maxDrawCalls}.`
        + (instanced ? ` ${r.geometry.instancedNodes} of them are repeat placements of a shared mesh.` : ''),
      suggestion: instanced
        ? 'optimize_glb will bake these repeat placements into one primitive (join) to clear the budget, trading away the memory dedup saved. To keep both, add EXT_mesh_gpu_instancing by hand — it draws every copy in one call.'
        : 'Merge primitives sharing a material (join), or palette/atlas materials to enable merging.',
      data: { calls, max: r.profile.maxDrawCalls, instancedNodes: r.geometry.instancedNodes },
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

  /**
   * Missing UVs are only a defect if something wants to read them, so ask the
   * material rather than the vertex layout alone.
   *
   * A flat-colour material reads none, and our own optimizer produces exactly
   * that: prune folds a single-colour base-color texture into the factor and
   * the UV set goes with it, losslessly (measured at SSIM 0.9998 on a forged
   * logo). Reporting that as a warning told the reader an asset we had just
   * finished optimizing "cannot be textured as-is", and advised running a
   * texture stage or unwrapping in a DCC — undoing the optimization to fix a
   * non-problem, and putting a warning in the count that gates CI.
   *
   * The three cases are genuinely different and only one of them is a bug:
   * a material that samples a texture and has no UVs to sample it with WILL
   * render wrong, which is worth an error, not the warning it used to get.
   */
  /**
   * Bytes present, format known, no size readable: the image is truncated or
   * corrupt. It used to escape as a raw "Offset is outside the bounds of the
   * DataView" from the header reader, killing the whole report rather than
   * appearing in it.
   */
  'tex/undecodable': (r) => {
    const bad = r.textures.filter(undecodableTexture);
    if (bad.length === 0) return null;
    return {
      ruleId: 'tex/undecodable',
      severity: 'error',
      message: `${bad.length} texture(s) cannot be decoded — ${bad.map((t) => `"${t.name}" (${t.mimeType}, ${t.bytes} bytes)`).join(', ')}. The bytes are there but the image header does not read, so the size and GPU cost are unknown and the texture will not upload.`,
      suggestion: 'Re-export or replace the image. optimize_glb cannot re-encode what it cannot decode.',
      data: { textures: bad.map((t) => t.name) },
    };
  },

  'geo/missing-uvs': (r) => {
    const missing = r.geometry.primitives.filter((p) => !p.attributes.some((a) => a.startsWith('TEXCOORD')));
    if (missing.length === 0) return null;
    // true = its material samples a texture, false = flat material, null = no material.
    const samplesTexture = (name: string | null) => {
      const mat = name === null ? undefined : r.materials.find((m) => m.name === name);
      return mat ? mat.textureSlots.length > 0 : null;
    };
    const broken = missing.filter((p) => samplesTexture(p.materialName) === true);
    const bare = missing.filter((p) => samplesTexture(p.materialName) === null);
    const flat = missing.filter((p) => samplesTexture(p.materialName) === false);
    const out: Finding[] = [];
    if (broken.length) {
      const slots = [...new Set(broken.flatMap((p) => r.materials.find((m) => m.name === p.materialName)?.textureSlots ?? []))];
      out.push({
        ruleId: 'geo/missing-uvs',
        severity: 'error',
        message: `${broken.length} primitive(s) have no TEXCOORD attribute but their material samples ${slots.length} texture slot(s) (${slots.join(', ')}) — those textures cannot be applied and the surface will render without them.`,
        suggestion: 'Unwrap the primitive, or drop the texture bindings the geometry cannot carry.',
        data: { primitives: broken.length, slots },
      });
    }
    if (bare.length) {
      out.push({
        ruleId: 'geo/missing-uvs',
        severity: 'warn',
        message: `${bare.length} primitive(s) have no TEXCOORD attribute and no material — the asset cannot be textured as-is.`,
        suggestion: 'If this is a pre-texture generation export, run the texture stage (or unwrap in a DCC) before shipping.',
        data: { primitives: bare.length },
      });
    }
    if (flat.length) {
      out.push({
        ruleId: 'geo/missing-uvs',
        severity: 'info',
        message: `${flat.length} primitive(s) have no TEXCOORD attribute; their material carries colour as a factor and samples no texture, so nothing reads UVs.`,
        suggestion: 'Nothing to do unless you intend to texture it later, which needs an unwrap first.',
        data: { primitives: flat.length },
      });
    }
    return out;
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
    // Split into provably-pointless blending (baseColor image has no alpha
    // channel at all) vs possibly-intentional blending.
    const findings: Finding[] = [];
    const pointless: string[] = [];
    const maybe: string[] = [];
    for (const mat of blended) {
      const baseColor = r.textures.find((t) =>
        t.slots.includes(`${mat.name}/baseColor`),
      );
      if (baseColor && baseColor.hasAlpha === false) pointless.push(mat.name);
      else maybe.push(mat.name);
    }
    if (pointless.length) {
      findings.push({
        ruleId: 'mat/blend-without-alpha',
        severity: 'warn',
        message: `Material(s) set to alpha BLEND but their baseColor image has NO alpha channel: ${pointless.join(', ')}. This buys sorting artifacts and disabled depth-write for nothing.`,
        suggestion: 'Switch alphaMode to OPAQUE — provably safe here.',
        data: { materials: pointless },
      });
    }
    if (maybe.length) {
      findings.push({
        ruleId: 'mat/blend-alpha',
        severity: 'info',
        message: `Material(s) using alpha BLEND: ${maybe.join(', ')}. Blending disables depth-write and causes sorting artifacts; AI exports often set it unintentionally.`,
        suggestion: 'If the alpha is cutout-style, MASK renders more robustly than BLEND.',
        data: { materials: maybe },
      });
    }
    return findings;
  },

  'tex/vram-estimate': (r) => {
    if (r.textureVramTotal <= r.profile.maxTextureVramBytes) return null;
    return {
      ruleId: 'tex/vram-estimate',
      severity: 'warn',
      message: `Textures decode to ~${mb(r.textureVramTotal)} of GPU memory (file size is not GPU size: WebP/JPEG/PNG upload as raw RGBA). Budget for ${r.profile.name} is ${mb(r.profile.maxTextureVramBytes)}.`,
      suggestion: 'Use KTX2/BasisU (stays compressed on the GPU, ~8x less memory) or reduce texture dimensions.',
      data: { vram: r.textureVramTotal, max: r.profile.maxTextureVramBytes },
    };
  },

  'topo/unwelded': (r) => {
    const t = r.geometry.topology;
    if (!t) return null;
    // Position-only duplicates are usually UV-seam splits (required by the
    // format); only fully-identical vertices are actual waste.
    // Topology is measured on the mesh list, so the ratio must be against
    // unique vertices — not the instanced count the budget uses.
    const ratio = t.redundantVertices / Math.max(1, r.geometry.uniqueVertices);
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

  'gen/profile': (r) => {
    if (r.generator.guess === 'unknown' || r.generator.notes.length === 0) return null;
    return {
      ruleId: 'gen/profile',
      severity: 'info',
      message: `Generator fingerprint: ${r.generator.guess} (${r.generator.confidence} confidence).`,
      suggestion: r.generator.notes.join(' '),
      data: { generator: r.generator.guess },
    };
  },

  'scene/animated-asset': (r) => {
    if (!r.scene.skins && !r.scene.animations) return null;
    const parts = [];
    if (r.scene.skins) parts.push(`${r.scene.skins} skin${r.scene.skins > 1 ? 's' : ''}`);
    if (r.scene.animations) parts.push(`${r.scene.animations} animation clip${r.scene.animations > 1 ? 's' : ''}`);
    return {
      ruleId: 'scene/animated-asset',
      severity: 'info',
      message: `Deforming asset: ${parts.join(', ')}. Optimization preserves skins, joint boundaries, morph targets, and clips (bone-aware simplification).`,
      suggestion: 'Budget triangles with animation in mind — deformation costs per frame. USDZ export carries the skeleton, blend shapes, and the first clip (UsdSkel); STL bakes the bind pose.',
      data: { skins: r.scene.skins, animations: r.scene.animations },
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

/**
 * Rules that read `geometry.topology` and therefore cannot run when the
 * welded topology pass is disabled. `analyze` reports these as skipped so a
 * cheap run is never confused with a full one — all three are warnings, so
 * skipping them silently lifts the score by 5 points each.
 */
export const TOPOLOGY_RULE_IDS = ['topo/unwelded', 'topo/non-manifold', 'topo/degenerate'] as const;
