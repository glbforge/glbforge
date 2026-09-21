/**
 * Compact report shapes for models. The full AnalysisResult is hundreds of
 * lines for a textured asset; agents need the verdict, the numbers that
 * drive decisions, and a pointer to drill down — not every texture row.
 */
import { PERCEPTUAL_RULE, type AnalysisResult, type Finding, type Severity } from '@glbforge/core';
import type { ImageBlock } from './preview.js';

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

/**
 * The rules `optimize_glb` actually has a step for.
 *
 * `resolves` is a machine-readable promise: an agent runs the action, re-runs
 * analyze, and branches on whether the rule cleared. Listing every error —
 * which is what this did — promises repairs the optimizer has no step for, so
 * the agent re-runs optimize on its own output, gets the identical card back
 * with the identical suggestion, and has nowhere to go. An empty nextActions
 * is not a worse answer than a false one; the findings still carry their own
 * suggestions, and topology or authoring problems are not the optimizer's to
 * fix. Add an id here only when a step in optimize() can clear it.
 */
const OPTIMIZER_RESOLVES = new Set([
  'perf/triangle-budget',   // meshopt simplification
  'perf/file-size',         // quantize + meshopt + texture re-encode
  'perf/draw-calls',        // join(), but only when there is something to join
  'tex/oversized',          // resize to the profile cap
  'tex/total-weight',       // re-encode
  'tex/vram-estimate',      // resize / KTX2
  'mat/duplicate-materials',// dedup + palette
  'geo/missing-normals',    // computeSmoothNormals
  'geo/unindexed',          // weld
  'topo/unwelded',          // weld
]);

/** What optimize can promise about THIS asset, as opposed to in general. */
function optimizerResolves(errors: Finding[]): string[] {
  return errors
    .filter((f) => OPTIMIZER_RESOLVES.has(f.ruleId))
    // Draw calls from repeat placements of a shared mesh are already deduped;
    // join has nothing to merge and the count will not move.
    .filter((f) => !(f.ruleId === 'perf/draw-calls' && ((f.data as { instancedNodes?: number } | undefined)?.instancedNodes ?? 0) > 0))
    .map((f) => f.ruleId);
}

export interface VisualFidelity {
  ssimMin: number;
  ssimMean: number;
  threshold: number;
  worstView: string;
  passed: boolean;
}

/** Pull the measured SSIM verdict back out of the report's finding. */
export function visualFidelityOf(r: AnalysisResult): VisualFidelity | null {
  const f = r.findings.find((x) => x.ruleId === PERCEPTUAL_RULE);
  if (!f?.data) return null;
  const d = f.data as { ssimMin: number; ssimMean: number; threshold: number; worstView: string };
  return { ssimMin: d.ssimMin, ssimMean: d.ssimMean, threshold: d.threshold, worstView: d.worstView, passed: f.severity !== 'error' };
}

export function compact(r: AnalysisResult) {
  const ordered = [...r.findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const count = (s: Severity) => r.findings.filter((f) => f.severity === s).length;
  const fidelity = visualFidelityOf(r);
  const errors = r.findings.filter((f) => f.severity === 'error');
  const resolves = optimizerResolves(errors);
  return {
    file: r.file.path,
    profile: r.profile.name,
    profileVersion: r.profile.version,
    score: r.score,
    passed: r.passed,
    verdict: r.passed ? 'within budget' : 'over budget',
    // A partial run cannot fire the rules it skipped, so its score reads high.
    // Agents compare scores across calls; tell them when one is not comparable.
    ...(r.skipped.length ? { skippedRules: r.skipped } : {}),
    fileBytes: r.file.bytes,
    triangles: r.geometry.triangles,
    vertices: r.geometry.vertices,
    drawCalls: r.geometry.drawCallEstimate,
    materials: r.materials.length,
    textures: r.textures.length,
    textureBytes: r.textureBytesTotal,
    vramBytes: r.textureVramTotal,
    generator: r.generator.guess,
    ...(r.scene.skins || r.scene.animations
      ? { animated: { skins: r.scene.skins, animations: r.scene.animations } }
      : {}),
    findings: { errors: count('error'), warnings: count('warn'), info: count('info') },
    // Every error is always listed (a hidden error would be a wrong verdict);
    // warnings/info fill the card up to three entries.
    topFindings: ordered
      .filter((f, i) => f.severity === 'error' || (f.ruleId !== PERCEPTUAL_RULE && i < 3))
      .map((f) => ({ ruleId: f.ruleId, severity: f.severity, message: f.message })),
    ...(fidelity ? { visualFidelity: fidelity } : {}),
    // Machine-actionable: the tool calls that would resolve the findings.
    nextActions: r.passed || resolves.length === 0 ? [] : [{
      tool: 'optimize_glb',
      args: { path: r.file.path, profile: r.profile.name },
      resolves,
    }],
    drillDown: {
      tool: 'inspect_report',
      args: { path: r.file.path, profile: r.profile.name, section: 'findings' },
      note: 'full findings with fix suggestions; sections: textures | materials | topology | geometry | scene | all',
    },
  };
}

export type ReportSection = 'findings' | 'textures' | 'materials' | 'topology' | 'geometry' | 'scene' | 'all';

export function section(r: AnalysisResult, which: ReportSection, filter: { ruleId?: string; severity?: Severity } = {}) {
  switch (which) {
    case 'findings': {
      let findings: Finding[] = r.findings;
      if (filter.ruleId) findings = findings.filter((f) => f.ruleId === filter.ruleId || f.ruleId.startsWith(filter.ruleId + '/'));
      if (filter.severity) findings = findings.filter((f) => f.severity === filter.severity);
      return { file: r.file.path, profile: r.profile.name, score: r.score, passed: r.passed, findings };
    }
    case 'textures':
      return { file: r.file.path, textureBytesTotal: r.textureBytesTotal, textureVramTotal: r.textureVramTotal, textures: r.textures };
    case 'materials':
      return { file: r.file.path, materials: r.materials, duplicateMaterialGroups: r.duplicateMaterialGroups };
    case 'topology':
      return { file: r.file.path, topology: r.geometry.topology, note: r.geometry.topology ? undefined : 'topology pass skipped (topology=false)' };
    case 'geometry': {
      const { topology: _t, ...geometry } = r.geometry;
      return { file: r.file.path, geometry };
    }
    case 'scene':
      return { file: r.file.path, asset: r.asset, scene: r.scene, generator: r.generator, bounds: r.geometry.bounds };
    case 'all':
      return r;
  }
}

type TextBlock = { type: 'text'; text: string };

/** Tool reply: compact JSON text (+ structuredContent), plus an optional image. */
export function reply(data: Record<string, unknown>, image?: ImageBlock | null) {
  const content: Array<TextBlock | ImageBlock> = [{ type: 'text', text: JSON.stringify(data) }];
  if (image) content.push(image);
  return { content, structuredContent: data };
}
