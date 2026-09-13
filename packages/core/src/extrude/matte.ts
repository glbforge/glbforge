/**
 * Subject lifting: synthesize an alpha channel for artwork that has none.
 *
 * The forge traces a silhouette, so it needs to know which pixels are the
 * subject. Artwork with transparency says so directly and white-background
 * artwork is separated by luma; a photograph answers neither and is refused
 * (`extrudeFromRgba`'s full-bleed guard). This module is the third answer: it
 * grows the background inward from the frame edge and calls what survives the
 * subject — the same idea as a phone's "lift subject", done with plain
 * connectivity instead of a segmentation model, so it costs no download, runs
 * identically in Node and a browser, and produces the same bytes every time.
 *
 * What it cannot do is pretend. A mask is an *inference*, and a photograph of
 * a cluttered room has no separable subject at all, so every matte carries a
 * confidence and the numbers behind it. Callers are expected to refuse a weak
 * one rather than forge a blob.
 *
 * Versioned like the rule packs: `matte/border@1` is a contract, and the
 * pixels it produces are part of the deterministic output. Tune it in a new
 * version, never in place.
 */

/**
 * Bumped from @1 (same day) when the distance function learned about shadows
 * and the mask gained a smoothing pass: the pixels this produces are part of
 * the deterministic output, so the algorithm's identity has to move with them.
 * @1 was never pinnable — there is no version argument yet — so nothing can be
 * left behind on it; when the first caller needs to pin, this becomes a table
 * like PROFILE_VERSIONS and every published version stays.
 */
export const MATTE_VERSION = 'matte/border@2';

export interface MatteOptions {
  /**
   * How far a pixel's colour may sit from a background reference and still
   * count as background, as a distance in RGB space (0-441). Default 34:
   * tolerant of JPEG mush and gentle vignetting, tight enough that a subject
   * rarely dissolves into the wall behind it.
   */
  tolerance?: number;
  /**
   * How far a pixel may sit from a background reference *in colour alone*
   * while being darker than it, and still count as background — the shadow
   * rule (see `isBackgroundColour`). Default 22. Raise it on a hard-lit
   * photograph, drop it to 0 to disable shadow matching entirely.
   */
  shadowTolerance?: number;
  /**
   * Passes of a 3x3 majority filter over the background mask before anything
   * is traced, which is what stops JPEG noise from becoming a ragged rim.
   * Default 2; 0 = off.
   */
  smoothing?: number;
  /**
   * Enclosed background regions this small (as a share of the subject) are
   * filled in rather than kept as holes — specular highlights, light gaps in
   * fur, compression speckle. Anything larger is a real hole and stays
   * transparent, so a mug handle keeps its opening. Default 0.02.
   */
  holeShare?: number;
  /**
   * Subject components smaller than this share of the largest are dropped as
   * debris (a shadow blob, a crumb, a bit of the next object). Default 0.05.
   */
  minComponentShare?: number;
}

export interface Matte {
  /** 0 or 255 per pixel, row-major — the synthesized alpha channel. */
  alpha: Uint8Array;
  /** Share of the canvas the subject covers (0-1). */
  coverage: number;
  /** Share of the frame edge that agreed on a background colour (0-1). */
  backgroundUniformity: number;
  /** Mean colour distance across the subject's boundary, normalized (0-1). */
  edgeContrast: number;
  /**
   * How much to trust this mask (0-1). An inference, never a measurement:
   * it says how separable the subject looked, not whether the cut is right.
   */
  confidence: number;
  /** Subject pieces kept, and how many were dropped as debris. */
  components: number;
  droppedComponents: number;
  /** Holes kept open, and how many were filled as speckle. */
  holes: number;
  filledHoles: number;
  /** Which algorithm produced this, for the report. */
  version: string;
  /** Why the confidence is what it is, worst first. */
  notes: string[];
}

/** Quantization for the border histogram: 16 levels per channel. */
const BUCKET_BITS = 4;
const BUCKET_SHIFT = 8 - BUCKET_BITS;
/** Background references are taken until they cover this much of the edge. */
const REFERENCE_COVERAGE = 0.75;
/** …and never more than this many, so a busy edge does not swallow everything. */
const MAX_REFERENCES = 4;
/** How far below the background's brightness the shadow rule still reaches. */
const SHADOW_FLOOR = 0.45;
/**
 * The shadow-aware cut must leave at least this share of what the strict cut
 * kept, or it is discarded as having eaten the object rather than its shadow.
 */
const SHADOW_KEEP_SHARE = 0.3;
/** A subject smaller/larger than these is not a subject worth cutting out. */
const MIN_SENSIBLE_COVERAGE = 0.005;
const MAX_SENSIBLE_COVERAGE = 0.92;

const distance = (px: Uint8Array | Buffer, i: number, r: number, g: number, b: number): number =>
  Math.sqrt((px[i] - r) ** 2 + (px[i + 1] - g) ** 2 + (px[i + 2] - b) ** 2);

const luma = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Distance in colour with luminance discounted — a shadow is the ground's own
 * colour at lower brightness, so this is small across one and large across a
 * genuinely different material.
 *
 * Normalizing by brightness is what makes it luminance-free: (r,g,b) and
 * (r,g,b)*0.6 have the same chromaticity. The `+1` keeps near-black stable,
 * where chromaticity stops meaning anything.
 */
const chromaDistance = (
  px: Uint8Array | Buffer, i: number, r: number, g: number, b: number,
): number => {
  const pSum = px[i] + px[i + 1] + px[i + 2] + 1;
  const rSum = r + g + b + 1;
  return 255 * Math.sqrt(
    (px[i] / pSum - r / rSum) ** 2
    + (px[i + 1] / pSum - g / rSum) ** 2
    + (px[i + 2] / pSum - b / rSum) ** 2,
  );
};

/**
 * A 3x3 majority filter, run in place over a 0/1 mask.
 *
 * The flood follows colour exactly, so JPEG ringing along an edge leaves it
 * frayed — and a frayed mask becomes a frayed silhouette, which the tracer
 * then faithfully turns into hundreds of tiny contours. Smoothing the mask is
 * cheaper and more predictable than smoothing the geometry afterwards.
 */
function smoothMask(mask: Uint8Array, width: number, height: number, passes: number): void {
  if (passes <= 0) return;
  const next = new Uint8Array(mask.length);
  for (let pass = 0; pass < passes; pass++) {
    next.set(mask);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const p = y * width + x;
        let on = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx || dy) on += mask[p + dy * width + dx];
          }
        }
        // Isolated pixels lose, enclosed pixels win, everything else holds —
        // so edges move at most one pixel per pass and corners survive.
        if (on <= 2) next[p] = 0;
        else if (on >= 6) next[p] = 1;
      }
    }
    mask.set(next);
  }
}

/**
 * Lift the subject out of an opaque image.
 *
 * Background is what the frame edge agrees on and what connects to it; the
 * subject is what is left. Connectivity is what makes this work on a subject
 * that happens to share a colour with the wall — it is only background if it
 * *reaches* the edge through pixels of that colour.
 */
export function liftSubject(
  px: Uint8Array | Buffer,
  width: number,
  height: number,
  opts: MatteOptions = {},
): Matte {
  const tolerance = opts.tolerance ?? 34;
  const shadowTolerance = opts.shadowTolerance ?? 22;
  const smoothing = opts.smoothing ?? 2;
  const holeShare = opts.holeShare ?? 0.02;
  const minComponentShare = opts.minComponentShare ?? 0.05;
  const n = width * height;
  const notes: string[] = [];

  // --- 1. What does the frame edge think the background is? ----------------
  // A histogram of the edge ring, quantized, dominant buckets first. Taking
  // several buckets (not one mean) is what lets a photo shot against a wall
  // *and* a table surface still separate: both are on the edge, neither is
  // the subject.
  const bins = new Map<number, { count: number; r: number; g: number; b: number }>();
  let edgePixels = 0;
  const noteEdge = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    const key = ((px[i] >> BUCKET_SHIFT) << (2 * BUCKET_BITS))
      | ((px[i + 1] >> BUCKET_SHIFT) << BUCKET_BITS)
      | (px[i + 2] >> BUCKET_SHIFT);
    const bin = bins.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bin.count++; bin.r += px[i]; bin.g += px[i + 1]; bin.b += px[i + 2];
    bins.set(key, bin);
    edgePixels++;
  };
  for (let x = 0; x < width; x++) { noteEdge(x, 0); noteEdge(x, height - 1); }
  for (let y = 1; y < height - 1; y++) { noteEdge(0, y); noteEdge(width - 1, y); }

  // Key as the tiebreak: equal counts must order identically on every run.
  const ranked = [...bins.entries()].sort((a, b) => b[1].count - a[1].count || a[0] - b[0]);
  const references: Array<{ r: number; g: number; b: number }> = [];
  let referenced = 0;
  for (const [, bin] of ranked) {
    if (references.length >= MAX_REFERENCES || referenced / edgePixels >= REFERENCE_COVERAGE) break;
    references.push({ r: bin.r / bin.count, g: bin.g / bin.count, b: bin.b / bin.count });
    referenced += bin.count;
  }
  const backgroundUniformity = referenced / edgePixels;

  /**
   * Background is a match in colour *or* a shadow of one.
   *
   * The shadow arm is deliberately one-sided: a pixel qualifies only if it is
   * chromatically close AND darker than the reference. A cast shadow is the
   * ground's own colour with the light taken away, so it lands here and stops
   * being welded to the object that cast it — while a white mug on a grey desk
   * is *brighter* than the ground and is never absorbed by it. The floor stops
   * the rule from running all the way down into black, where every colour is
   * chromatically close to every other.
   */
  const isBackgroundColour = (i: number, withShadowArm: boolean): boolean => references.some((ref) => {
    if (distance(px, i, ref.r, ref.g, ref.b) <= tolerance) return true;
    if (!withShadowArm || shadowTolerance <= 0) return false;
    const pixelLuma = luma(px[i], px[i + 1], px[i + 2]);
    const refLuma = luma(ref.r, ref.g, ref.b);
    return pixelLuma <= refLuma
      && pixelLuma >= refLuma * SHADOW_FLOOR
      && chromaDistance(px, i, ref.r, ref.g, ref.b) <= shadowTolerance;
  });

  // --- 2 & 3. Classify, grow the background inward, keep what is real ------
  // Colour decides the class and connectivity decides what to do about it —
  // that split is what keeps a ring's eye open. Deciding by connectivity
  // alone would weld the hole shut, because the eye is "not background the
  // flood could reach" and so is the ring itself.
  const queue = new Int32Array(n);

  interface Pass {
    alpha: Uint8Array; subject: number;
    components: number; droppedComponents: number;
    holes: number; filledHoles: number;
  }

  const build = (withShadowArm: boolean): Pass => {
    const backgroundLike = new Uint8Array(n);
    for (let p = 0; p < n; p++) backgroundLike[p] = isBackgroundColour(p * 4, withShadowArm) ? 1 : 0;
    // Smooth the classification, not the geometry: a frayed mask becomes a
    // frayed silhouette, and the tracer would turn every JPEG artifact along
    // the rim into its own contour.
    smoothMask(backgroundLike, width, height, smoothing);

    // Seeded only from edge pixels that match a reference, so a subject
    // running off the frame (a cropped object, a hand at the bottom) is not
    // itself a seed and does not get eaten from the outside in.
    const background = new Uint8Array(n);
    let head = 0, tail = 0;
    const push = (p: number) => {
      if (background[p] || !backgroundLike[p]) return;
      background[p] = 1;
      queue[tail++] = p;
    };
    for (let x = 0; x < width; x++) { push(x); push((height - 1) * width + x); }
    for (let y = 1; y < height - 1; y++) { push(y * width); push(y * width + width - 1); }
    while (head < tail) {
      const p = queue[head++];
      const x = p % width, y = (p / width) | 0;
      if (x > 0) push(p - 1);
      if (x < width - 1) push(p + 1);
      if (y > 0) push(p - width);
      if (y < height - 1) push(p + width);
    }

    /** Connected components within one class, in scan order (stable labels). */
    const componentsOf = (member: (p: number) => boolean): { labels: Int32Array; sizes: number[] } => {
      const labels = new Int32Array(n).fill(-1);
      const sizes: number[] = [];
      for (let seed = 0; seed < n; seed++) {
        if (labels[seed] !== -1 || !member(seed)) continue;
        const label = sizes.length;
        let size = 0;
        head = tail = 0;
        labels[seed] = label; queue[tail++] = seed;
        while (head < tail) {
          const p = queue[head++];
          size++;
          const x = p % width, y = (p / width) | 0;
          const visit = (q: number) => {
            if (labels[q] !== -1 || !member(q)) return;
            labels[q] = label; queue[tail++] = q;
          };
          if (x > 0) visit(p - 1);
          if (x < width - 1) visit(p + 1);
          if (y > 0) visit(p - width);
          if (y < height - 1) visit(p + width);
        }
        sizes.push(size);
      }
      return { labels, sizes };
    };

    const subjectParts = componentsOf((p) => !backgroundLike[p]);
    const largest = subjectParts.sizes.length ? Math.max(...subjectParts.sizes) : 0;
    const kept = subjectParts.sizes.map((size) => size >= largest * minComponentShare);
    const components = kept.filter(Boolean).length;
    const droppedComponents = kept.length - components;

    const alpha = new Uint8Array(n);
    let subject = 0;
    for (let p = 0; p < n; p++) {
      const label = subjectParts.labels[p];
      if (label !== -1 && kept[label]) { alpha[p] = 255; subject++; }
    }

    // Background-coloured pixels the flood could not reach are enclosed. Small
    // ones are noise inside the subject — a highlight, a JPEG artifact, a gap
    // in fur — and get filled; large ones are real openings and stay
    // transparent, so a mug keeps its handle. Debris dropped above is never
    // refilled: it was excluded on purpose, not by enclosure.
    const enclosed = componentsOf((p) => backgroundLike[p] === 1 && !background[p]);
    const fill = enclosed.sizes.map((size) => subject > 0 && size < subject * holeShare);
    for (let p = 0; p < n; p++) {
      const label = enclosed.labels[p];
      if (label !== -1 && fill[label]) { alpha[p] = 255; subject++; }
    }
    return {
      alpha, subject, components, droppedComponents,
      holes: fill.filter((f) => !f).length,
      filledHoles: fill.filter(Boolean).length,
    };
  };

  // The shadow arm is an inference on top of an inference, and it has one
  // catastrophic failure: a neutral object DARKER than a neutral ground is
  // chromatically identical to a shadow of that ground, so the arm eats the
  // whole subject (a grey laptop on a white desk). Nothing local can tell
  // those apart — but the outcome can. Build both and keep the shadow-aware
  // cut only while it still leaves a subject behind; a shadow is part of the
  // scene around an object, so removing it should cost a fraction of the
  // object, never most of it.
  let pass = build(shadowTolerance > 0);
  let shadowArm = shadowTolerance > 0;
  if (shadowArm) {
    const strict = build(false);
    if (pass.subject < Math.max(n * MIN_SENSIBLE_COVERAGE, strict.subject * SHADOW_KEEP_SHARE)) {
      pass = strict;
      shadowArm = false;
      notes.push('shadow matching removed almost the whole subject, so the strict cut was used instead — the object is probably a darker shade of the background\'s own colour');
    }
  }
  const { alpha, components, droppedComponents, holes, filledHoles } = pass;
  let subject = pass.subject;

  // --- 4. How separable was it, really? ------------------------------------
  // Edge contrast across the cut: a crisp subject on a clean ground reads far
  // apart, a subject the flood invented out of texture reads close.
  let boundarySamples = 0, boundaryDistance = 0;
  for (let p = 0; p < n; p++) {
    if (!alpha[p]) continue;
    const x = p % width, y = (p / width) | 0;
    const neighbours = [
      x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1,
      y > 0 ? p - width : -1, y < height - 1 ? p + width : -1,
    ];
    for (const q of neighbours) {
      if (q === -1 || alpha[q]) continue;
      boundaryDistance += distance(px, p * 4, px[q * 4], px[q * 4 + 1], px[q * 4 + 2]);
      boundarySamples++;
    }
  }
  const edgeContrast = boundarySamples ? Math.min(1, boundaryDistance / boundarySamples / 120) : 0;
  const coverage = subject / n;

  // Confidence is the product of three independent doubts, so any one of them
  // being bad is enough to disqualify the mask — which is the behaviour we
  // want: a beautiful edge around 99% of the canvas is still not a subject.
  let sanity = 1;
  if (coverage < MIN_SENSIBLE_COVERAGE) {
    sanity = 0;
    notes.push(`the subject is only ${(coverage * 100).toFixed(1)}% of the image — nothing separable was found`);
  } else if (coverage > MAX_SENSIBLE_COVERAGE) {
    sanity = 0;
    notes.push(`the subject fills ${(coverage * 100).toFixed(0)}% of the image — the background never separated`);
  } else if (coverage > 0.85) {
    sanity = 0.5;
    notes.push(`the subject fills ${(coverage * 100).toFixed(0)}% of the image, leaving little background to judge by`);
  }
  if (backgroundUniformity < 0.6) {
    notes.push(`the frame edge is busy — only ${(backgroundUniformity * 100).toFixed(0)}% of it agreed on a background colour`);
  }
  if (edgeContrast < 0.35) {
    notes.push(`the cut runs through low contrast (${(edgeContrast * 100).toFixed(0)}%), so the outline may wander`);
  }
  if (droppedComponents > 0) {
    notes.push(`dropped ${droppedComponents} small piece${droppedComponents === 1 ? '' : 's'} as debris`);
  }
  const confidence = Math.max(0, Math.min(1, backgroundUniformity * edgeContrast * sanity));

  return {
    alpha,
    coverage,
    backgroundUniformity,
    edgeContrast,
    confidence,
    components,
    droppedComponents,
    holes,
    filledHoles,
    version: MATTE_VERSION,
    notes,
  };
}

/**
 * Paint the mask onto a copy of the image: the cut, as a picture.
 *
 * Numbers describe a matte; they do not show it. Anyone choosing a tolerance —
 * a person moving a slider, an agent sweeping values — needs to see which
 * pixels survived before committing to geometry, and `alpha` on its own is not
 * something either can look at.
 *
 * `dim` is how much of the removed background to keep as a ghost (0 = fully
 * transparent, 0.15 = a faint reminder of what was cut). A ghost is more
 * useful than empty space: it shows whether the cut took the shadow, clipped
 * the handle, or ate the whole object.
 */
export function cutoutRgba(
  px: Uint8Array | Buffer,
  matte: Pick<Matte, 'alpha'>,
  dim = 0.15,
): Uint8Array {
  const out = new Uint8Array(px.length);
  out.set(px);
  for (let p = 0; p < matte.alpha.length; p++) {
    if (matte.alpha[p]) { out[p * 4 + 3] = 255; continue; }
    out[p * 4 + 3] = Math.round(255 * dim);
  }
  return out;
}
