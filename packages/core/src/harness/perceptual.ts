/**
 * Perceptual verification: SSIM between fixed-camera renders of an asset
 * before and after optimization. Turns "no visible loss" into a measured
 * number with a pass/fail threshold from the budget profile.
 *
 * SSIM (Wang et al. 2004) on grayscale, 11x11 Gaussian window (sigma 1.5),
 * K1=0.01 / K2=0.03 — the reference parameterization. The mean is taken
 * over pixels that either render actually covers (dilated by the window
 * radius), so a small object on a large identical background can't coast
 * to a high score. Pure arithmetic on raw RGBA: deterministic.
 */
import type { Document } from '@gltf-transform/core';
import type { AnalysisResult } from '../types.js';
import {
  computeFrame, renderRaw, verifyRig,
  type RawView, type RenderCamera, type RenderFrame, type TextureDecoder,
} from './render.js';

export interface ViewScore {
  name: string;
  ssim: number;
  /** Fraction of the frame covered by geometry in either render. */
  coverage: number;
}

export interface PerceptualResult {
  /** Mean SSIM across views, 0..1 (1 = pixel-identical). */
  ssimMean: number;
  /** The weakest view — what a reviewer would notice first. */
  ssimMin: number;
  worstView: string;
  views: ViewScore[];
  /** Whether base-color textures took part in the comparison. */
  textured: boolean;
  size: number;
  /** The rendered views themselves (only when requested — see keepViews). */
  rendered?: { reference: RawView[]; candidate: RawView[] };
}

export interface PerceptualVerdict extends PerceptualResult {
  threshold: number;
  passed: boolean;
}

const WINDOW = 11;
const SIGMA = 1.5;
const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;

function gaussianKernel(): Float64Array {
  const k = new Float64Array(WINDOW);
  const half = (WINDOW - 1) / 2;
  let sum = 0;
  for (let i = 0; i < WINDOW; i++) {
    k[i] = Math.exp(-((i - half) ** 2) / (2 * SIGMA * SIGMA));
    sum += k[i];
  }
  for (let i = 0; i < WINDOW; i++) k[i] /= sum;
  return k;
}
const KERNEL = gaussianKernel();

/** Separable Gaussian blur, edges clamped. */
function blur(src: Float64Array, size: number): Float64Array {
  const half = (WINDOW - 1) / 2;
  const tmp = new Float64Array(size * size);
  const out = new Float64Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = 0;
      for (let k = 0; k < WINDOW; k++) {
        const sx = Math.min(size - 1, Math.max(0, x + k - half));
        acc += src[y * size + sx] * KERNEL[k];
      }
      tmp[y * size + x] = acc;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = 0;
      for (let k = 0; k < WINDOW; k++) {
        const sy = Math.min(size - 1, Math.max(0, y + k - half));
        acc += tmp[sy * size + x] * KERNEL[k];
      }
      out[y * size + x] = acc;
    }
  }
  return out;
}

function gray(rgba: Uint8Array, size: number): Float64Array {
  const g = new Float64Array(size * size);
  for (let i = 0; i < size * size; i++) {
    g[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  }
  return g;
}

/** Union of both masks, dilated by the SSIM window radius. */
function unionMask(a: Uint8Array, b: Uint8Array, size: number): Uint8Array {
  const half = (WINDOW - 1) / 2;
  const base = new Uint8Array(size * size);
  for (let i = 0; i < size * size; i++) base[i] = a[i] | b[i];
  const tmp = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let hit = 0;
    for (let k = -half; k <= half && !hit; k++) {
      const sx = x + k;
      if (sx >= 0 && sx < size && base[y * size + sx]) hit = 1;
    }
    tmp[y * size + x] = hit;
  }
  const out = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let hit = 0;
    for (let k = -half; k <= half && !hit; k++) {
      const sy = y + k;
      if (sy >= 0 && sy < size && tmp[sy * size + x]) hit = 1;
    }
    out[y * size + x] = hit;
  }
  return out;
}

/** SSIM of two same-size RGBA images over the union of their coverage masks. */
export function ssim(a: RawView, b: RawView): ViewScore {
  if (a.size !== b.size) throw new Error('ssim: views differ in size');
  const size = a.size;
  const x = gray(a.rgba, size), y = gray(b.rgba, size);
  const mask = unionMask(a.mask, b.mask, size);

  const muX = blur(x, size), muY = blur(y, size);
  const xx = new Float64Array(size * size), yy = new Float64Array(size * size), xy = new Float64Array(size * size);
  for (let i = 0; i < size * size; i++) { xx[i] = x[i] * x[i]; yy[i] = y[i] * y[i]; xy[i] = x[i] * y[i]; }
  const sXX = blur(xx, size), sYY = blur(yy, size), sXY = blur(xy, size);

  let sum = 0, count = 0;
  for (let i = 0; i < size * size; i++) {
    if (!mask[i]) continue;
    const mx = muX[i], my = muY[i];
    const vx = sXX[i] - mx * mx, vy = sYY[i] - my * my, cov = sXY[i] - mx * my;
    const s = ((2 * mx * my + C1) * (2 * cov + C2)) / ((mx * mx + my * my + C1) * (vx + vy + C2));
    sum += s; count++;
  }
  return {
    name: a.name,
    ssim: count ? Math.min(1, Math.max(0, sum / count)) : 1,
    coverage: count / (size * size),
  };
}

/** Score two rendered view sets (same rig, same frame) against each other. */
export function compareViews(reference: RawView[], candidate: RawView[]): PerceptualResult {
  if (reference.length !== candidate.length) throw new Error('compareViews: view counts differ');
  const views = reference.map((ref, i) => ssim(ref, candidate[i]));
  let worst = views[0];
  for (const v of views) if (v.ssim < worst.ssim) worst = v;
  const mean = views.reduce((s, v) => s + v.ssim, 0) / Math.max(1, views.length);
  return {
    ssimMean: round(mean),
    ssimMin: round(worst?.ssim ?? 1),
    worstView: worst?.name ?? '',
    views: views.map((v) => ({ ...v, ssim: round(v.ssim), coverage: round(v.coverage) })),
    textured: false,
    size: reference[0]?.size ?? 0,
  };
}

const round = (n: number) => Math.round(n * 10000) / 10000;

export interface PerceptualOptions {
  /** Pixels per edge. Default 256 — enough for silhouette + shading changes, ~1s per asset. */
  size?: number;
  cameras?: RenderCamera[];
  /** Base-color decoder; omit to compare geometry/shading only. */
  textureDecoder?: TextureDecoder;
  /** Supersampling factor for the renders. Default 2 (anti-aliased). */
  supersample?: number;
}

/**
 * Two-phase API so callers can snapshot a document before mutating it in
 * place: `snapshot` renders the reference views and fixes the frame;
 * `compare` renders the candidate with the same cameras and scores it.
 */
export async function perceptualSnapshot(
  doc: Document,
  opts: PerceptualOptions = {},
): Promise<{ views: RawView[]; frame: RenderFrame; opts: Required<Pick<PerceptualOptions, 'size' | 'cameras' | 'supersample'>> & { textureDecoder?: TextureDecoder } }> {
  const size = opts.size ?? 256;
  const cameras = opts.cameras ?? verifyRig();
  const supersample = opts.supersample ?? 2;
  const frame = await computeFrame(doc);
  const views = await renderRaw(doc, { size, cameras, frame, supersample, textureDecoder: opts.textureDecoder });
  return { views, frame, opts: { size, cameras, supersample, textureDecoder: opts.textureDecoder } };
}

export async function perceptualCompare(
  snapshot: Awaited<ReturnType<typeof perceptualSnapshot>>,
  candidate: Document,
  keepViews = false,
): Promise<PerceptualResult> {
  const views = await renderRaw(candidate, { ...snapshot.opts, frame: snapshot.frame });
  return {
    ...compareViews(snapshot.views, views),
    textured: !!snapshot.opts.textureDecoder,
    ...(keepViews ? { rendered: { reference: snapshot.views, candidate: views } } : {}),
  };
}

/**
 * Where did the pixels change? Absolute luminance difference mapped to a
 * black → yellow → red ramp over the union coverage mask, so a reviewer (or
 * an agent) sees whether loss is hair, a seam, or the silhouette.
 */
export function diffHeatmap(a: RawView, b: RawView): RawView {
  if (a.size !== b.size) throw new Error('diffHeatmap: views differ in size');
  const size = a.size;
  const rgba = new Uint8Array(size * size * 4);
  const mask = new Uint8Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const ga = 0.299 * a.rgba[i * 4] + 0.587 * a.rgba[i * 4 + 1] + 0.114 * a.rgba[i * 4 + 2];
    const gb = 0.299 * b.rgba[i * 4] + 0.587 * b.rgba[i * 4 + 1] + 0.114 * b.rgba[i * 4 + 2];
    const d = Math.min(1, Math.abs(ga - gb) / 96); // 96 levels of gray = fully red
    const covered = a.mask[i] | b.mask[i];
    mask[i] = covered;
    // Ramp: 0 → dark, 0.5 → yellow, 1 → red. Uncovered background stays dim.
    const r = covered ? Math.round(255 * Math.min(1, d * 2)) : 24;
    const g = covered ? Math.round(255 * (d < 0.5 ? d * 2 : 2 - d * 2)) : 25;
    const bl = covered ? 0 : 28;
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = bl; rgba[i * 4 + 3] = 255;
  }
  return { name: `${a.name}_diff`, rgba, mask, size, camera: a.camera };
}

/** One-shot comparison of two independent documents (e.g. `glbforge verify`). */
export async function perceptualDiff(
  reference: Document,
  candidate: Document,
  opts: PerceptualOptions & { keepViews?: boolean } = {},
): Promise<PerceptualResult> {
  return perceptualCompare(await perceptualSnapshot(reference, opts), candidate, opts.keepViews);
}

export const PERCEPTUAL_RULE = 'fidelity/perceptual';

/**
 * Fold a perceptual verdict into a report card: a failing SSIM is an
 * error-severity finding (fails the budget like any perf/* rule); a passing
 * one is recorded as an info finding so the measured number ships with the
 * report everywhere reports are shown.
 */
export function applyPerceptualVerdict(report: AnalysisResult, verdict: PerceptualVerdict): AnalysisResult {
  const pct = (n: number) => (n * 100).toFixed(1) + '%';
  const data = {
    ssimMean: verdict.ssimMean, ssimMin: verdict.ssimMin, worstView: verdict.worstView,
    threshold: verdict.threshold, textured: verdict.textured, views: verdict.views,
  }; // never the rendered pixels — reports stay small
  if (verdict.passed) {
    report.findings.push({
      ruleId: PERCEPTUAL_RULE,
      severity: 'info',
      message: `Visual fidelity SSIM ${pct(verdict.ssimMean)} (weakest view ${pct(verdict.ssimMin)} @ ${verdict.worstView}) — above the ${pct(verdict.threshold)} floor: no visible loss by measurement.`,
      data,
    });
    return report;
  }
  report.findings.push({
    ruleId: PERCEPTUAL_RULE,
    severity: 'error',
    message: `Visual fidelity SSIM ${pct(verdict.ssimMean)} (weakest view ${pct(verdict.ssimMin)} @ ${verdict.worstView}) is below the profile floor of ${pct(verdict.threshold)}: optimization is visibly lossy.`,
    suggestion: 'Raise the triangle target (--target) or pick a roomier profile; if textures dominate the loss, try --ktx2 or a larger maxTextureSize profile. Skip the check with --no-verify only when the loss is acceptable.',
    data,
  });
  report.score = Math.max(0, report.score - 15);
  report.passed = false;
  return report;
}
