/**
 * Bridge from the legacy analyze() findings (rule ids, free text) to
 * envelope diagnostics (stable codes + prim paths), so analyze_glb /
 * optimize_glb / ship_asset speak the same language as the inspect tools.
 */
import { diag, RULE_TO_CODE, type AnalysisResult, type Diagnostic, type DiagnosticCode, type Finding, type SceneIR } from '@glbforge/core';

export function findingsToDiagnostics(r: AnalysisResult, ir: SceneIR | null): Diagnostic[] {
  const root = '/Asset';
  const heaviest = ir?.meshes.reduce((b, m) => (m.triangleCount > (b?.triangleCount ?? -1) ? m : b), ir.meshes[0] ?? null) ?? null;
  const heaviestTex = ir?.textures.reduce((b, t) => ((t.width ?? 0) * (t.height ?? 0) > ((b?.width ?? 0) * (b?.height ?? 0)) ? t : b), ir.textures[0] ?? null) ?? null;
  const texByName = (name: unknown) => ir?.textures.find((t) => t.name === name)?.path ?? heaviestTex?.path ?? root;
  const matByName = (name: unknown) => ir?.materials.find((m) => m.name === name)?.path ?? root;
  const out: Diagnostic[] = [];
  for (const f of r.findings) {
    let code: DiagnosticCode = RULE_TO_CODE[f.ruleId] ?? 'GENERATOR_FINGERPRINT';
    let path = root;
    let property: string | undefined;
    const d = f.data ?? {};
    switch (f.ruleId) {
      case 'perf/triangle-budget': path = heaviest?.path ?? root; break;
      case 'tex/oversized': path = texByName(d.texture); break;
      case 'tex/total-weight': case 'tex/vram-estimate': path = heaviestTex?.path ?? root; break;
      case 'geo/missing-normals': path = ir?.meshes.find((m) => m.normalsSource === 'missing')?.path ?? root; property = 'normals'; break;
      case 'geo/missing-uvs': path = ir?.meshes.find((m) => m.uvs.length === 0)?.path ?? root; property = 'primvars:st'; break;
      case 'geo/unindexed': path = ir?.meshes.find((m) => !m.indices)?.path ?? root; break;
      case 'mat/no-material': path = ir?.meshes.find((m) => m.material === null)?.path ?? root; property = 'material:binding'; break;
      case 'mat/duplicate-materials': path = matByName((d.groups as string[][] | undefined)?.[0]?.[0]); break;
      case 'mat/blend-without-alpha': case 'mat/blend-alpha': path = matByName((d.materials as string[] | undefined)?.[0]); property = 'inputs:opacity'; break;
      case 'scene/scale-sanity': { const size = (d.size as number[] | undefined) ?? []; code = Math.max(...size, 0) >= 100 ? 'SCALE_TOO_LARGE' : 'SCALE_TOO_SMALL'; break; }
      case 'fidelity/perceptual': code = f.severity === 'error' ? 'FIDELITY_BELOW_FLOOR' : 'FIDELITY_MEASURED'; break;
      default: break;
    }
    const severity = f.severity === 'warn' ? 'warning' : f.severity;
    out.push(diag(code, path, f.message, { property, severity, suggested_fix: f.suggestion, data: { rule: f.ruleId, ...d } }));
  }
  return out;
}

export type { Finding };
