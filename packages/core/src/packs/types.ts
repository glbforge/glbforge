/**
 * Rule packs: the public, versioned vocabulary of what GLBForge can say
 * about an asset.
 *
 * - A rule id is slash-namespaced (`topo/shells`, later `fdm/wall-thickness`)
 *   and is the public API. Its SCREAMING_CASE `code` is an alias for the MCP
 *   envelope, so `docs/error-codes.md` stays complete.
 * - Rules are versioned by their PACK (`core-geometry@1`), the way budget
 *   profiles are versioned (`mobile-hero@1`): a rule that changes meaning is
 *   a new pack version, and a profile pins pack versions.
 * - A pack declares a DEFAULT severity per rule; the PROFILE decides what
 *   it means for its target. The same 152 non-manifold edges are info for
 *   a web hero, a warning while authoring, an error for a print profile.
 * - Certainty invariant: a finding's `message` states only what the rule
 *   MEASURED (or, for a `heuristic` rule, carries a `confidence`). Any
 *   interpretation of why it happened lives in `likely_cause`, which always
 *   carries its own confidence, because a cause is always an inference.
 * - Findings describe problems. Facts that are fine (one shell, watertight)
 *   belong in the report the caller assembles, not in findings.
 */
import type { DiagnosticCode, DiagnosticSeverity } from '../inspect/diagnostics.js';
import type { IRMesh, SceneIR } from '../inspect/ir.js';
import type { MeshTopology } from '../inspect/topology.js';

export type Certainty = 'measured' | 'heuristic';

/**
 * Why a finding probably happened. `confidence` is an authored prior in
 * 0..1 for this pack version — not a calibrated probability; calibration
 * against the fixture corpus is future work and would be a new pack version.
 */
export interface LikelyCause {
  text: string;
  confidence: number;
}

export interface RuleFinding {
  /** Slash-namespaced rule id, e.g. `topo/shells`. */
  rule: string;
  /** Pack label the rule came from, e.g. `core-geometry@1`. */
  pack: string;
  /** SCREAMING_CASE alias used in MCP envelopes. */
  code: DiagnosticCode;
  /** After the profile's override, when one applied. */
  severity: DiagnosticSeverity;
  /** The pack's default, kept so a reader can see what the profile changed. */
  default_severity: DiagnosticSeverity;
  certainty: Certainty;
  /** 0..1, present only when `certainty` is `heuristic`. */
  confidence?: number;
  prim_path: string;
  property?: string;
  /** What was found, in one sentence an agent can act on. Measured facts only unless the rule is heuristic. */
  message: string;
  likely_cause?: LikelyCause;
  /** Concrete next step. */
  fix: string;
  data?: Record<string, unknown>;
}

export interface ParamSpec {
  default: number | string | boolean;
  description: string;
}

export type ParamValues = Record<string, number | string | boolean>;

/** What the file's metadata says about where it has been. Evidence, not proof. */
export interface Provenance {
  /** Looks like it passed through glbforge optimize (meshopt + quantization + WebP signature, or a glbforge generator string). */
  optimized: boolean;
  /** Looks like glbforge forge output. */
  forged: boolean;
  evidence: string[];
}

export interface RuleContext {
  ir: SceneIR;
  /** Pack params: profile and caller overrides merged over defaults. */
  params: ParamValues;
  /** Welded-space topology of a mesh, memoized; null when disabled or not a triangle mesh. */
  topology(mesh: IRMesh): MeshTopology | null;
  topologyEnabled: boolean;
  provenance: Provenance;
  /** `/Asset` for glTF, the default prim for USD. */
  rootPath: string;
}

export interface Rule {
  id: string;
  /** One line for docs: what the rule measures and when it fires. */
  summary: string;
  /** Default severity; a profile may override it per rule. */
  severity: DiagnosticSeverity;
  certainty: Certainty;
  code: DiagnosticCode;
  /** Prerequisite; the rule is reported as skipped when the caller disabled it. */
  needs?: 'topology';
  check(ctx: RuleContext): RuleFinding[] | RuleFinding | null;
}

export interface RulePack {
  name: string;
  version: number;
  description: string;
  params: Record<string, ParamSpec>;
  rules: Rule[];
}

/**
 * What a profile says about rules: which packs (pinned), severities, params.
 * Declared in ../types.ts so budget profiles can carry it without importing packs.
 */
export type { RuleOverrides } from '../types.js';

/**
 * A rule profile is the pluggable half of a profile: a named, versioned
 * choice of packs and severities for one purpose (authoring, a print
 * process). Budget profiles (`mobile-hero@1`) carry the same fields under
 * `rules`, so either kind resolves to one of these.
 */
export interface RuleProfile extends Required<import('../types.js').RuleOverrides> {
  name: string;
  version: number;
  description: string;
}

export interface PackRunResult {
  /** Profile label the severities came from, or null for pack defaults. */
  profile: string | null;
  /** Packs that ran, as labels. */
  packs: string[];
  provenance: Provenance;
  /** Errors first, then warnings, then info; stable within a severity. */
  findings: RuleFinding[];
  /** Rules not evaluated and why (e.g. topology disabled). */
  skipped: Array<{ rule: string; reason: string }>;
}
