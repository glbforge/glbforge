/**
 * Pack + rule-profile registry and runner. Mirrors profiles.ts: every
 * published pack / rule-profile version is frozen, `name@N` pins, a bare
 * name resolves to the latest.
 */
import { diag, sortDiagnostics, type Diagnostic, type DiagnosticSeverity } from '../inspect/diagnostics.js';
import type { IRMesh, SceneIR } from '../inspect/ir.js';
import { meshTopology, type MeshTopology } from '../inspect/topology.js';
import { getProfile } from '../profiles.js';
import type { Profile } from '../types.js';
import { sceneExtent, type SceneExtent } from '../inspect/extent.js';
import { coreGeometryV1 } from './core-geometry.js';
import { coreSceneV1 } from './core-scene.js';
import type { PackRunResult, ParamValues, Provenance, RuleContext, RuleFinding, RulePack, RuleProfile } from './types.js';

// --- packs ---------------------------------------------------------------

/** Every published version of every pack, oldest first. Never edit a published entry. */
export const PACK_VERSIONS: Record<string, RulePack[]> = {
  'core-geometry': [coreGeometryV1],
  'core-scene': [coreSceneV1],
};

/** What runs when nothing names packs: every core pack, latest. */
export const DEFAULT_PACKS = ['core-geometry', 'core-scene'];

/** Latest version of each pack. */
export const PACKS: Record<string, RulePack> = Object.fromEntries(
  Object.entries(PACK_VERSIONS).map(([name, versions]) => [name, versions[versions.length - 1]]),
);

export function packLabel(pack: RulePack): string {
  return `${pack.name}@${pack.version}`;
}

function resolveVersioned<T extends { version: number }>(kind: string, table: Record<string, T[]>, spec: string): T {
  const m = /^([a-z0-9-]+)(?:@(\d+))?$/i.exec(spec.trim());
  const name = m?.[1] ?? spec;
  const versions = table[name];
  if (!versions) throw new Error(`Unknown ${kind} "${spec}". Available: ${Object.keys(table).join(', ')} (pin a version with name@N).`);
  if (!m?.[2]) return versions[versions.length - 1];
  const version = parseInt(m[2], 10);
  const hit = versions.find((p) => p.version === version);
  if (!hit) throw new Error(`${kind[0].toUpperCase()}${kind.slice(1)} "${name}" has no version ${version}. Published: ${versions.map((p) => p.version).join(', ')}.`);
  return hit;
}

/** Resolve "core-geometry" (latest) or "core-geometry@1" (pinned). */
export const getPack = (spec: string): RulePack => resolveVersioned('rule pack', PACK_VERSIONS, spec);

/** Every rule id across the latest packs, for docs and tests. */
export function listRules(packs: RulePack[] = Object.values(PACKS)): Array<{ id: string; pack: string; severity: DiagnosticSeverity; certainty: string; code: string; summary: string }> {
  return packs.flatMap((p) => p.rules.map((r) => ({ id: r.id, pack: packLabel(p), severity: r.severity, certainty: r.certainty, code: r.code, summary: r.summary })));
}

// --- rule profiles ----------------------------------------------------------

/**
 * `authoring@1`: an agent editing a mesh. Every topology fact at the pack's
 * default severity — a hole or an overlap is something you just did.
 */
const authoringV1: RuleProfile = {
  name: 'authoring',
  version: 1,
  description: 'Inner-loop authoring: topology problems are warnings because they are most likely the last edit\'s doing.',
  packs: ['core-geometry@1', 'core-scene@1'],
  severity: {},
  params: {},
};

/** Every published version of every rule profile, oldest first. Never edit a published entry. */
export const RULE_PROFILE_VERSIONS: Record<string, RuleProfile[]> = {
  authoring: [authoringV1],
};

export const ruleProfileLabel = (p: RuleProfile): string => `${p.name}@${p.version}`;

const isRuleProfile = (x: unknown): x is RuleProfile => typeof x === 'object' && x !== null && 'packs' in x && 'severity' in x && 'name' in x && !('maxTriangles' in x);
const isBudgetProfile = (x: unknown): x is Profile => typeof x === 'object' && x !== null && 'maxTriangles' in x;

/** A budget profile's rule overrides as a rule profile (defaults: latest core-geometry, pack severities). */
export function ruleProfileOf(profile: Profile): RuleProfile {
  return {
    name: profile.name, version: profile.version, description: profile.description,
    packs: profile.rules?.packs ?? DEFAULT_PACKS,
    severity: profile.rules?.severity ?? {},
    params: profile.rules?.params ?? {},
  };
}

/**
 * Resolve a profile argument: a rule-profile name (`authoring[@N]`), a budget
 * profile name (`mobile-hero[@N]`), or either object.
 */
export function resolveRuleProfile(spec: string | RuleProfile | Profile): RuleProfile {
  if (isRuleProfile(spec)) return spec;
  if (isBudgetProfile(spec)) return ruleProfileOf(spec);
  const name = spec.replace(/@\d+$/, '').trim();
  if (RULE_PROFILE_VERSIONS[name]) return resolveVersioned('rule profile', RULE_PROFILE_VERSIONS, spec);
  return ruleProfileOf(getProfile(spec));
}

// --- context ---------------------------------------------------------------

/**
 * What the metadata says about where the file has been. gltf-transform
 * overwrites `asset.generator` on write (even our own forge stamp), so the
 * only durable evidence is the extension set glbforge optimize writes.
 */
export function detectProvenance(ir: SceneIR): Provenance {
  const used = new Set(ir.extensions.used);
  const evidence: string[] = [];
  for (const ext of ['EXT_meshopt_compression', 'KHR_mesh_quantization', 'EXT_texture_webp', 'KHR_texture_basisu']) if (used.has(ext)) evidence.push(ext);
  const gen = (ir.generator ?? '').toLowerCase();
  const forged = gen.includes('glbforge extrude') || gen.includes('glbforge-forge');
  if (gen.includes('glbforge')) evidence.push(`generator "${ir.generator}"`);
  const optimized = evidence.includes('EXT_meshopt_compression') && evidence.includes('KHR_mesh_quantization');
  return { optimized, forged, evidence };
}

export interface RunPacksOptions {
  /** Severity + pack + param source: `authoring`, `mobile-hero@1`, or an object. Default: pack defaults over latest core-geometry. */
  profile?: string | RuleProfile | Profile;
  /** Explicit packs; overrides the profile's list. */
  packs?: Array<RulePack | string>;
  /** Run the welded topology pass. Default true; rules needing it are reported as skipped when false. */
  topology?: boolean;
  /** Param overrides per pack name, applied over the profile's. */
  params?: Record<string, ParamValues>;
  /** Caller-owned memo of mesh topology (IR mesh index → result) so a report and its packs share one pass. */
  topologyCache?: Map<number, MeshTopology | null>;
  /** Precomputed extent (see sceneExtent) so a report and its packs share one pass; null = no geometry. */
  extent?: SceneExtent | null;
}

const RANK: Record<DiagnosticSeverity, number> = { error: 0, warning: 1, info: 2 };

/** Evaluation context for one pack over one asset. */
export function createRuleContext(ir: SceneIR, pack: RulePack, opts: RunPacksOptions = {}, shared?: { topology: Map<number, MeshTopology | null>; provenance: Provenance; extent: { value?: SceneExtent | null } }): RuleContext {
  const topologyEnabled = opts.topology !== false;
  const cache = shared?.topology ?? new Map<number, MeshTopology | null>();
  const extentBox = shared?.extent ?? { value: opts.extent };
  const profile = opts.profile ? resolveRuleProfile(opts.profile) : null;
  const params: ParamValues = {};
  for (const [k, spec] of Object.entries(pack.params)) params[k] = spec.default;
  for (const source of [profile?.params[pack.name], opts.params?.[pack.name]]) {
    for (const [k, v] of Object.entries(source ?? {})) if (k in pack.params) params[k] = v;
  }
  return {
    ir,
    params,
    topologyEnabled,
    extent() {
      if (extentBox.value === undefined) extentBox.value = sceneExtent(ir);
      return extentBox.value;
    },
    provenance: shared?.provenance ?? detectProvenance(ir),
    rootPath: ir.format.startsWith('usd') ? ir.defaultPrim ?? '/' : '/Asset',
    topology(mesh: IRMesh) {
      if (!topologyEnabled) return null;
      let t = cache.get(mesh.index);
      if (t === undefined) { t = meshTopology(mesh); cache.set(mesh.index, t); }
      return t;
    },
  };
}

/** Run packs over an asset. Deterministic: same IR + same options = same findings in the same order. */
export function runPacks(ir: SceneIR, opts: RunPacksOptions = {}): PackRunResult {
  const profile = opts.profile ? resolveRuleProfile(opts.profile) : null;
  const packSpecs = opts.packs ?? profile?.packs ?? DEFAULT_PACKS;
  const resolved = packSpecs.map((p) => (typeof p === 'string' ? getPack(p) : p));
  const shared = { topology: opts.topologyCache ?? new Map<number, MeshTopology | null>(), provenance: detectProvenance(ir), extent: { value: opts.extent } };
  const findings: RuleFinding[] = [];
  const skipped: PackRunResult['skipped'] = [];
  for (const pack of resolved) {
    const ctx = createRuleContext(ir, pack, opts, shared);
    for (const rule of pack.rules) {
      if (rule.needs === 'topology' && !ctx.topologyEnabled) { skipped.push({ rule: rule.id, reason: 'topology pass disabled' }); continue; }
      const out = rule.check(ctx);
      if (!out) continue;
      for (const f of Array.isArray(out) ? out : [out]) {
        const override = profile?.severity[f.rule];
        findings.push(override ? { ...f, severity: override } : f);
      }
    }
  }
  const ordered = findings.map((f, i) => [f, i] as const).sort((a, b) => RANK[a[0].severity] - RANK[b[0].severity] || a[1] - b[1]).map(([f]) => f);
  return {
    profile: profile ? ruleProfileLabel(profile) : null,
    packs: resolved.map(packLabel),
    provenance: shared.provenance,
    findings: ordered,
    skipped,
  };
}

/** A pack finding as an envelope diagnostic: the alias code, the rule id, certainty and cause carried in data. */
export function findingToDiagnostic(f: RuleFinding): Diagnostic {
  return diag(f.code, f.prim_path, f.message, {
    severity: f.severity,
    property: f.property,
    suggested_fix: f.fix,
    data: {
      ...(f.data ?? {}),
      rule: f.rule, pack: f.pack, certainty: f.certainty,
      ...(f.severity !== f.default_severity ? { default_severity: f.default_severity } : {}),
      ...(f.confidence !== undefined ? { confidence: f.confidence } : {}),
      ...(f.likely_cause ? { likely_cause: f.likely_cause.text, cause_confidence: f.likely_cause.confidence } : {}),
    },
  });
}

export function packFindingsToDiagnostics(findings: RuleFinding[]): Diagnostic[] {
  return sortDiagnostics(findings.map(findingToDiagnostic));
}
