/**
 * Compact report shapes for models. The full AnalysisResult is hundreds of
 * lines for a textured asset; agents need the verdict, the numbers that
 * drive decisions, and a pointer to drill down — not every texture row.
 */
import { PERCEPTUAL_RULE, type AnalysisResult, type Finding, type Severity } from '@glbforge/core';
import type { ImageBlock } from './preview.js';

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

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
  return {
    file: r.file.path,
    profile: r.profile.name,
    profileVersion: r.profile.version,
    score: r.score,
    passed: r.passed,
    verdict: r.passed ? 'within budget' : 'over budget',
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
    nextActions: r.passed ? [] : [{
      tool: 'optimize_glb',
      args: { path: r.file.path, profile: r.profile.name },
      resolves: errors.map((f) => f.ruleId),
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
