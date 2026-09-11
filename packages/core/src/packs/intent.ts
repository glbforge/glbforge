/**
 * intent@1 — the agent's declared expectation, checked against the asset.
 *
 * `--expect "chair, Z-up, meters, single-shell, 0.4-1.2m tall, front -Y"`
 * or a structured Expectation. Explicit expectations (shells, watertight,
 * a numeric size range, origin) are MEASURED checks and fail as errors:
 * they are a contract the caller wrote. A category alone gives a
 * plausibility check from a small size table, which is a HEURISTIC and
 * fails as a warning with its confidence. `front` is never checked — it is
 * recorded as declared, because nothing measurable distinguishes a chair's
 * front from its back.
 */
import { classifyOrigin, type OriginLandmark } from '../inspect/extent.js';
import type { LikelyCause, Rule, RuleContext, RuleFinding, RulePack } from './types.js';

export type Unit = 'm' | 'cm' | 'mm';
export type Measure = 'height' | 'width' | 'largest';
export type FrontAxis = '+X' | '-X' | '+Y' | '-Y' | '+Z' | '-Z';

export interface Expectation {
  /** Free text, e.g. "chair"; looked up in the size table. */
  category?: string;
  /** Authoring/scene up axis. glTF files are Y-up by definition; see intent/up-axis. */
  up?: 'Y' | 'Z';
  /** Unit the caller's numbers are in (default m). The file itself must be metres. */
  units?: Unit;
  /** Exact shell count, or a range. */
  shells?: number | { min?: number; max?: number };
  watertight?: boolean;
  /** Size range in metres along `measure`. */
  size?: { min: number; max: number; measure: Measure };
  /** Where the origin must be. */
  origin?: 'base-center' | 'center' | 'centroid';
  /** Declared front; recorded, never verified. */
  front?: FrontAxis;
}

export interface ParsedExpectation {
  raw: string | null;
  expectation: Expectation;
  /** Tokens the parser could not place (reported, never silently dropped). */
  unparsed: string[];
}

const UNIT_RE = /(m|meters?|metres?|cm|centimet(?:er|re)s?|mm|millimet(?:er|re)s?)/i;
const toUnit = (s: string | undefined, fallback: Unit): Unit => (!s ? fallback : /^mm|^milli/i.test(s) ? 'mm' : /^cm|^centi/i.test(s) ? 'cm' : 'm');
const toMetres = (v: number, u: Unit) => (u === 'mm' ? v / 1000 : u === 'cm' ? v / 100 : v);
const NUM = '(\\d+(?:\\.\\d+)?)';
const RANGE_RE = new RegExp(`^(?:about\\s+|~)?${NUM}\\s*${UNIT_RE.source}?\\s*(?:-|–|to)\\s*${NUM}\\s*${UNIT_RE.source}?\\s*(tall|high|height|wide|width|long|length|across|largest)?$`, 'i');
const SINGLE_RE = new RegExp(`^(?:about\\s+|~)?${NUM}\\s*${UNIT_RE.source}?\\s*(tall|high|height|wide|width|long|length|across|largest)?$`, 'i');
const measureOf = (w: string | undefined): Measure => (!w ? 'largest' : /tall|high|height/i.test(w) ? 'height' : /wide|width|long|length|across/i.test(w) ? 'width' : 'largest');

/** Parse the free-text form. Structured input passes through untouched (only `unparsed` is empty). */
export function parseExpectation(input: string | Expectation): ParsedExpectation {
  if (typeof input !== 'string') return { raw: null, expectation: { ...input }, unparsed: [] };
  const e: Expectation = {};
  const unparsed: string[] = [];
  const tokens = input.split(/[,;]/).map((t) => t.trim()).filter(Boolean);
  // Units first so ranges can default to them regardless of order.
  for (const t of tokens) if (/^(m|meters?|metres?|cm|centimet(?:er|re)s?|mm|millimet(?:er|re)s?)$/i.test(t)) e.units = toUnit(t, 'm');
  const unit = e.units ?? 'm';
  for (const t of tokens) {
    let m: RegExpExecArray | null;
    if (/^(m|meters?|metres?|cm|centimet(?:er|re)s?|mm|millimet(?:er|re)s?)$/i.test(t)) continue;
    if ((m = /^([yz])[\s-]?up$/i.exec(t))) { e.up = m[1].toUpperCase() as 'Y' | 'Z'; continue; }
    if (/^(single[\s-]?shell|one[\s-]?shell|one[\s-]?piece|single[\s-]?piece)$/i.test(t)) { e.shells = 1; continue; }
    if ((m = /^(\d+)\s*(?:-|–|to)\s*(\d+)\s*(?:shells?|pieces?)$/i.exec(t))) { e.shells = { min: +m[1], max: +m[2] }; continue; }
    if ((m = /^(\d+)\s*(?:shells?|pieces?)$/i.exec(t)) || (m = /^(?:shells?|pieces?)[\s:=]+(\d+)$/i.exec(t))) { e.shells = +m[1]; continue; }
    if (/^(watertight|closed|solid|manifold)$/i.test(t)) { e.watertight = true; continue; }
    if (/^(not[\s-]watertight|open)$/i.test(t)) { e.watertight = false; continue; }
    if ((m = /^(?:front|facing|faces)[\s:=]*([+-]?)\s*([xyz])$/i.exec(t))) { e.front = `${m[1] === '-' ? '-' : '+'}${m[2].toUpperCase()}` as FrontAxis; continue; }
    if ((m = /^origin[\s:=]*(?:at\s+)?(base[\s-]?cent(?:er|re)|base|bottom|cent(?:er|re)|centroid)$/i.exec(t))) {
      e.origin = /centroid/i.test(m[1]) ? 'centroid' : /base|bottom/i.test(m[1]) ? 'base-center' : 'center';
      continue;
    }
    if ((m = RANGE_RE.exec(t))) {
      const u1 = toUnit(m[2], unit), u2 = toUnit(m[4], u1);
      e.size = { min: toMetres(+m[1], u1), max: toMetres(+m[3], u2), measure: measureOf(m[5]) };
      continue;
    }
    if ((m = SINGLE_RE.exec(t)) && (m[2] || m[3])) {
      const v = toMetres(+m[1], toUnit(m[2], unit));
      e.size = { min: +(v * 0.9).toPrecision(12), max: +(v * 1.1).toPrecision(12), measure: measureOf(m[3]) };
      continue;
    }
    if (!e.category && /^[a-z][a-z0-9 _-]*$/i.test(t)) { e.category = t.toLowerCase(); continue; }
    unparsed.push(t);
  }
  return { raw: input, expectation: e, unparsed };
}

/** Typical real-world sizes in metres. Coarse on purpose: a table of priors, not a taxonomy. */
export const CATEGORY_SIZES: Record<string, { min: number; max: number; measure: Measure }> = {
  chair: { min: 0.4, max: 1.2, measure: 'height' }, stool: { min: 0.3, max: 0.8, measure: 'height' }, sofa: { min: 0.6, max: 1.1, measure: 'height' },
  couch: { min: 0.6, max: 1.1, measure: 'height' }, table: { min: 0.4, max: 1.1, measure: 'height' }, desk: { min: 0.65, max: 0.85, measure: 'height' },
  bed: { min: 0.3, max: 1.3, measure: 'height' }, shelf: { min: 0.5, max: 2.5, measure: 'height' }, cabinet: { min: 0.5, max: 2.4, measure: 'height' },
  lamp: { min: 0.15, max: 2.0, measure: 'height' }, door: { min: 1.9, max: 2.5, measure: 'height' }, window: { min: 0.4, max: 2.2, measure: 'height' },
  mug: { min: 0.07, max: 0.15, measure: 'height' }, cup: { min: 0.06, max: 0.15, measure: 'height' }, bottle: { min: 0.12, max: 0.4, measure: 'height' },
  vase: { min: 0.1, max: 0.6, measure: 'height' }, plant: { min: 0.1, max: 2.5, measure: 'height' }, tree: { min: 1.5, max: 40, measure: 'height' },
  rock: { min: 0.05, max: 5, measure: 'largest' }, stone: { min: 0.02, max: 3, measure: 'largest' },
  phone: { min: 0.12, max: 0.18, measure: 'largest' }, laptop: { min: 0.28, max: 0.42, measure: 'largest' }, book: { min: 0.12, max: 0.35, measure: 'largest' },
  keychain: { min: 0.03, max: 0.09, measure: 'largest' }, coin: { min: 0.015, max: 0.04, measure: 'largest' }, ring: { min: 0.015, max: 0.03, measure: 'largest' },
  shoe: { min: 0.22, max: 0.35, measure: 'largest' }, sneaker: { min: 0.22, max: 0.35, measure: 'largest' }, boot: { min: 0.25, max: 0.5, measure: 'largest' },
  helmet: { min: 0.2, max: 0.35, measure: 'largest' }, backpack: { min: 0.3, max: 0.6, measure: 'height' }, sword: { min: 0.6, max: 1.3, measure: 'largest' },
  guitar: { min: 0.9, max: 1.1, measure: 'largest' }, toy: { min: 0.05, max: 0.6, measure: 'largest' }, plush: { min: 0.1, max: 0.6, measure: 'largest' },
  person: { min: 1.4, max: 2.1, measure: 'height' }, human: { min: 1.4, max: 2.1, measure: 'height' }, character: { min: 0.3, max: 2.5, measure: 'height' },
  dog: { min: 0.2, max: 0.9, measure: 'height' }, cat: { min: 0.2, max: 0.35, measure: 'height' }, horse: { min: 1.4, max: 1.8, measure: 'height' },
  car: { min: 1.2, max: 2.0, measure: 'height' }, bicycle: { min: 0.9, max: 1.2, measure: 'height' }, motorcycle: { min: 0.9, max: 1.4, measure: 'height' },
  house: { min: 3, max: 15, measure: 'height' }, building: { min: 3, max: 200, measure: 'height' },
};

const PACK = 'intent@1';
const cause = (text: string, confidence: number): LikelyCause => ({ text, confidence });
const metres = (m: number) => (m < 0.01 ? `${(m * 1000).toFixed(2)} mm` : m < 1 ? `${(m * 100).toFixed(1)} cm` : `${m.toFixed(2)} m`);
const range = (r: { min: number; max: number }) => `${metres(r.min)}–${metres(r.max)}`;
const measureWord = (m: Measure) => (m === 'height' ? 'tall' : m === 'width' ? 'across' : 'in its largest dimension');

type Body = Omit<RuleFinding, 'rule' | 'pack' | 'code' | 'severity' | 'default_severity' | 'certainty'>;
const rule = (spec: Omit<Rule, 'check'>, body: (ctx: RuleContext, e: Expectation) => Body[] | Body | null): Rule => ({
  ...spec,
  check(ctx) {
    if (!ctx.expect) return null;
    const out = body(ctx, ctx.expect);
    if (!out) return null;
    return (Array.isArray(out) ? out : [out]).map((f) => ({ rule: spec.id, pack: PACK, code: spec.code, severity: spec.severity, default_severity: spec.severity, certainty: spec.certainty, ...f }));
  },
});

/** Extent along the expected measure, in metres, plus the axes used. */
function measured(ctx: RuleContext, measure: Measure): { value: number; axis: string } | null {
  const e = ctx.extent();
  if (!e) return null;
  if (measure === 'height') return { value: e.size[e.up], axis: 'XYZ'[e.up] };
  if (measure === 'width') { const others = [0, 1, 2].filter((i) => i !== e.up); const i = others.reduce((a, b) => (e.size[a] >= e.size[b] ? a : b)); return { value: e.size[i], axis: 'XYZ'[i] }; }
  const i = e.size.indexOf(e.largest);
  return { value: e.largest, axis: 'XYZ'[i] };
}

/** Why a size is off: unit mix-up, lying on its side, or just wrong. */
function sizeCause(ctx: RuleContext, r: { min: number; max: number; measure: Measure }, value: number): LikelyCause {
  const e = ctx.extent()!;
  const fits = (v: number) => v >= r.min && v <= r.max;
  if (fits(value / 1000) || fits(value * 1000)) return cause(`A unit mix-up: ${metres(value)} is ${value > r.max ? 'a thousand times too big' : 'a thousand times too small'}, which is exactly millimetres read as metres or the reverse.`, 0.8);
  if (fits(value / 100) || fits(value * 100)) return cause(`A unit mix-up: off by a factor of a hundred, which is centimetres read as metres or the reverse.`, 0.75);
  if (r.measure === 'height') {
    const others = [0, 1, 2].filter((i) => i !== e.up);
    const sideways = others.find((i) => fits(e.size[i]));
    if (sideways !== undefined) return cause(`The asset may be lying on its side: its ${'XYZ'[sideways]} extent (${metres(e.size[sideways])}) fits the expected height while ${'XYZ'[e.up]} does not — typical of Z-up geometry exported without the axis conversion.`, 0.7);
  }
  return cause('Modelled or generated at the wrong size; generators pick arbitrary scales, and no reference object pins them to real units.', 0.5);
}

const upAxis = rule(
  {
    id: 'intent/up-axis',
    summary: 'The expected up axis against the file\'s. glTF is Y-up by definition, so a Z-up expectation describes the authoring space and is reported, not failed.',
    severity: 'warning', certainty: 'measured', code: 'INTENT_UP_AXIS',
  },
  (ctx, e) => {
    if (!e.up || e.up === ctx.ir.upAxis) return null;
    const isGltf = !ctx.ir.format.startsWith('usd');
    return {
      prim_path: ctx.rootPath,
      severity: isGltf ? 'info' : 'warning',
      message: isGltf
        ? `You expected ${e.up}-up; the file is ${ctx.ir.upAxis}-up because glTF stores Y-up by definition. Heights were checked along ${ctx.ir.upAxis}.`
        : `You expected ${e.up}-up; the layer declares upAxis = ${ctx.ir.upAxis}.`,
      likely_cause: isGltf
        ? cause('Blender and most DCCs author Z-up and their glTF exporters convert to Y-up on the way out; the expectation names the scene convention, not the file\'s.', 0.8)
        : cause('The exporter wrote a different up axis than the scene was authored in, or the metadata was left at a default.', 0.6),
      fix: isGltf
        ? 'Nothing to do if the asset stands upright along Y (see intent/size or the bounding box). If it lies on its side, the exporter did not convert: bake a −90° X rotation.'
        : `Set upAxis = "${e.up}" on the layer, or bake the rotation so the geometry matches the declared axis.`,
      data: { expected: e.up, actual: ctx.ir.upAxis, format: ctx.ir.format },
    } as Body & { severity: 'info' | 'warning' };
  },
);

const units = rule(
  {
    id: 'intent/units',
    summary: 'The file must be in metres; USD layers that declare another metersPerUnit fail.',
    severity: 'error', certainty: 'measured', code: 'INTENT_UNITS',
  },
  (ctx) => {
    if (!ctx.ir.format.startsWith('usd') || ctx.ir.metersPerUnit === 1) return null;
    return {
      prim_path: ctx.rootPath,
      message: `The layer declares metersPerUnit = ${ctx.ir.metersPerUnit} (${ctx.ir.metersPerUnit === 0.01 ? 'centimetres' : ctx.ir.metersPerUnit === 0.001 ? 'millimetres' : 'not metres'}); you expected metres.`,
      likely_cause: cause('Exported from a scene whose unit scale was not metres, with the exporter preserving it as metadata instead of converting.', 0.7),
      fix: 'Bake the scale into the geometry and set metersPerUnit = 1, or set the exporter\'s unit scale to metres.',
      data: { meters_per_unit: ctx.ir.metersPerUnit },
    };
  },
);

const shells = rule(
  {
    id: 'intent/shells',
    summary: 'Connected shell count (welded space) against the expected count or range.',
    severity: 'error', certainty: 'measured', code: 'INTENT_SHELLS',
  },
  (ctx, e) => {
    if (e.shells === undefined || !ctx.topologyEnabled) return null;
    let total = 0;
    for (const m of ctx.ir.meshes) total += ctx.topology(m)?.shells ?? 0;
    const want = typeof e.shells === 'number' ? { min: e.shells, max: e.shells } : { min: e.shells.min ?? 0, max: e.shells.max ?? Infinity };
    if (total >= want.min && total <= want.max) return null;
    const wantText = want.min === want.max ? `${want.min}` : want.max === Infinity ? `at least ${want.min}` : `${want.min}–${want.max}`;
    return {
      prim_path: ctx.rootPath,
      message: `Expected ${wantText} connected shell${want.max === 1 ? '' : 's'}; the asset has ${total} (across ${ctx.ir.meshes.length} mesh${ctx.ir.meshes.length === 1 ? '' : 'es'}).`,
      likely_cause: total > want.max
        ? cause('Parts were placed but never joined into one surface, or a boolean left debris; see topo/shells and topo/floating-fragments for which pieces.', 0.7)
        : cause('Pieces that should be separate were merged, or the asset has fewer parts than intended.', 0.5),
      fix: total > want.max
        ? 'Boolean-union the parts that should be one solid and delete loose fragments; check the per-mesh shell counts in the report.'
        : 'Separate the parts (Blender: P › By Loose Parts) or model the missing ones.',
      data: { expected: want, actual: total },
    };
  },
);

const watertight = rule(
  {
    id: 'intent/watertight',
    summary: 'Every triangle mesh closed and manifold when watertight was expected (or not, when open was).',
    severity: 'error', certainty: 'measured', code: 'INTENT_WATERTIGHT',
  },
  (ctx, e) => {
    if (e.watertight === undefined || !ctx.topologyEnabled) return null;
    const meshes = ctx.ir.meshes.filter((m) => m.mode === 'triangles' && m.triangleCount > 0);
    const bad = meshes.filter((m) => { const t = ctx.topology(m); return t ? t.watertight !== e.watertight : false; });
    if (bad.length === 0) return null;
    const detail = bad.map((m) => { const t = ctx.topology(m)!; return `${m.name} (${t.boundaryLoops} open loop${t.boundaryLoops === 1 ? '' : 's'}, ${t.nonManifoldEdges} non-manifold edge${t.nonManifoldEdges === 1 ? '' : 's'})`; }).join('; ');
    return {
      prim_path: bad[0].path,
      message: e.watertight ? `Expected a watertight solid; ${bad.length} of ${meshes.length} mesh${meshes.length === 1 ? ' is' : 'es are'} not: ${detail}.` : `Expected an open surface; ${bad.length} mesh${bad.length === 1 ? ' is' : 'es are'} closed.`,
      likely_cause: e.watertight
        ? cause('Holes or overlapping faces introduced by the last edit — see the topo/* findings for each mesh, which name the loops and edges.', 0.7)
        : cause('The surface was capped or solidified when a sheet was intended.', 0.5),
      fix: e.watertight ? 'Fix the topo/open-edges and topo/non-manifold findings; re-run inspect until watertight is true.' : 'Remove the caps or the Solidify step.',
      data: { expected: e.watertight, failing: bad.map((m) => m.path) },
    };
  },
);

const size = rule(
  {
    id: 'intent/size',
    summary: 'Measured extent (height along up, width across, or largest) against the expected range in metres.',
    severity: 'error', certainty: 'measured', code: 'INTENT_SIZE',
  },
  (ctx, e) => {
    if (!e.size) return null;
    const m = measured(ctx, e.size.measure);
    if (!m) return null;
    if (m.value >= e.size.min && m.value <= e.size.max) return null;
    return {
      prim_path: ctx.rootPath,
      message: `Expected ${range(e.size)} ${measureWord(e.size.measure)}; the asset is ${metres(m.value)} along ${m.axis} (${(m.value / (m.value < e.size.min ? e.size.min : e.size.max)).toPrecision(2)}× the ${m.value < e.size.min ? 'minimum' : 'maximum'}).`,
      likely_cause: sizeCause(ctx, e.size, m.value),
      fix: `Scale the asset by ${((e.size.min + e.size.max) / 2 / m.value).toPrecision(3)} to land mid-range, or fix the exporter's unit scale if the cause is a unit mix-up.`,
      data: { expected_m: [e.size.min, e.size.max], measure: e.size.measure, actual_m: m.value, axis: m.axis },
    };
  },
);

const categoryScale = rule(
  {
    id: 'intent/category-scale',
    summary: 'Plausibility of the size for the declared category, from a coarse table of typical sizes (heuristic). Skipped when an explicit size range was given.',
    severity: 'warning', certainty: 'heuristic', code: 'INTENT_CATEGORY_SCALE',
  },
  (ctx, e) => {
    if (!e.category || e.size) return null;
    const key = e.category.replace(/s$/, '');
    const prior = CATEGORY_SIZES[e.category] ?? CATEGORY_SIZES[key];
    if (!prior) return null;
    const m = measured(ctx, prior.measure);
    if (!m) return null;
    if (m.value >= prior.min && m.value <= prior.max) return null;
    const factor = m.value < prior.min ? prior.min / m.value : m.value / prior.max;
    const confidence = factor >= 100 ? 0.8 : factor >= 5 ? 0.65 : 0.5;
    return {
      prim_path: ctx.rootPath,
      confidence,
      message: `A ${e.category} is usually ${range(prior)} ${measureWord(prior.measure)}; this one is ${metres(m.value)} along ${m.axis} — ${factor.toPrecision(2)}× ${m.value < prior.min ? 'smaller' : 'larger'} than the typical range (table prior, ${Math.round(confidence * 100)}% confidence).`,
      likely_cause: sizeCause(ctx, prior, m.value),
      fix: `If the size is intended (a model, a giant), pass an explicit range to make the check exact: "${prior.min}-${prior.max}m ${prior.measure === 'height' ? 'tall' : prior.measure === 'width' ? 'wide' : ''}". Otherwise scale by ${((prior.min + prior.max) / 2 / m.value).toPrecision(3)}.`,
      data: { category: e.category, typical_m: [prior.min, prior.max], measure: prior.measure, actual_m: m.value, axis: m.axis },
    };
  },
);

const categoryUnknown = rule(
  {
    id: 'intent/category-unknown',
    summary: 'The declared category has no entry in the size table, so plausibility stays unknown.',
    severity: 'info', certainty: 'measured', code: 'INTENT_CATEGORY_UNKNOWN',
  },
  (ctx, e) => {
    if (!e.category || e.size) return null;
    if (CATEGORY_SIZES[e.category] || CATEGORY_SIZES[e.category.replace(/s$/, '')]) return null;
    return {
      prim_path: ctx.rootPath,
      message: `No typical size is known for "${e.category}", so its plausibility is unknown.`,
      likely_cause: cause(`The category is not one of the ${Object.keys(CATEGORY_SIZES).length} in intent@1's table.`, 1),
      fix: 'Give an explicit range, e.g. "0.4-1.2m tall", to have the size checked exactly.',
      data: { category: e.category },
    };
  },
);

const origin = rule(
  {
    id: 'intent/origin',
    summary: 'Origin landmark (base centre / centre / centroid) against the expected one.',
    severity: 'error', certainty: 'measured', code: 'INTENT_ORIGIN',
  },
  (ctx, e) => {
    if (!e.origin) return null;
    const ext = ctx.extent();
    if (!ext) return null;
    const o = classifyOrigin(ext, Number(ctx.params.originTolerance));
    const ok = o.at === e.origin || (e.origin === 'center' && o.at === 'centroid' && o.distance_to_centroid_m < 1e-6);
    if (ok) return null;
    const name = (l: OriginLandmark) => (l === 'base-center' ? 'the base centre' : l === 'center' ? 'the bounding-box centre' : l === 'centroid' ? 'the vertex centroid' : 'no landmark');
    return {
      prim_path: ctx.rootPath,
      message: `Expected the origin at ${name(e.origin)}; it is at ${name(o.at)} (${o.position_in_bounds.map((v) => v.toFixed(2)).join(', ')} in bounds units, ${metres(Math.abs(o.height_above_base_m))} ${o.height_above_base_m >= 0 ? 'above' : 'below'} the base).`,
      likely_cause: cause('The pivot was left where the generator or "origin to geometry" put it.', 0.6),
      fix: e.origin === 'base-center'
        ? `Translate the geometry by (${o.offset_to_base_center_m.map((v) => +v.toFixed(4)).join(', ')}) m.`
        : `Translate the geometry so the origin lands at ${name(e.origin)} (Blender: Object › Set Origin).`,
      data: { expected: e.origin, actual: o.at, offset_to_base_center_m: o.offset_to_base_center_m },
    };
  },
);

export const intentV1: RulePack = {
  name: 'intent',
  version: 1,
  description: 'The caller\'s declared expectation (category, up axis, units, shells, watertight, size, origin, front) checked against the asset; explicit checks are measured errors, category plausibility is a heuristic warning, front is recorded only.',
  params: {
    originTolerance: { default: 0.05, description: 'Fraction of the bounds within which the origin counts as being at a landmark.' },
  },
  rules: [units, shells, watertight, size, origin, categoryScale, upAxis, categoryUnknown],
};
