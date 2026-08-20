import { Document } from '@gltf-transform/core';
import type { AnalysisResult, Profile } from '../types.js';
import { analyzeGeometry } from './geometry.js';
import { analyzeMaterials } from './materials.js';
import { runRules } from '../rules.js';

export interface AnalyzeOptions {
  profile: Profile;
  /** Skip the (heavier) weld/edge topology pass. Default: run it. */
  topology?: boolean;
  filePath?: string;
  fileBytes?: number;
}

export function analyze(doc: Document, opts: AnalyzeOptions): AnalysisResult {
  const root = doc.getRoot();
  const geometry = analyzeGeometry(doc, { topology: opts.topology !== false });
  const { materials, duplicateMaterialGroups, textures, textureBytesTotal } =
    analyzeMaterials(doc);

  const result: AnalysisResult = {
    file: { path: opts.filePath ?? null, bytes: opts.fileBytes ?? 0 },
    asset: {
      generator: root.getAsset().generator ?? null,
      extensionsUsed: root.listExtensionsUsed().map((e) => e.extensionName),
    },
    scene: {
      scenes: root.listScenes().length,
      nodes: root.listNodes().length,
      skins: root.listSkins().length,
      animations: root.listAnimations().length,
    },
    geometry,
    materials,
    duplicateMaterialGroups,
    textures,
    textureBytesTotal,
    profile: opts.profile,
    findings: [],
    score: 100,
    passed: true,
  };

  result.findings = runRules(result);
  for (const f of result.findings) {
    if (f.severity === 'error') result.score -= 15;
    else if (f.severity === 'warn') result.score -= 5;
  }
  result.score = Math.max(0, result.score);
  result.passed = !result.findings.some((f) => f.severity === 'error');
  return result;
}
