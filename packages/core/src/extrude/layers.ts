/**
 * Color quantization for layered extrusion: k-means over the solid pixels,
 * then a 3x3 majority filter over the label map — anti-aliased edge pixels
 * otherwise form thin halo rings between color regions.
 */
import { srgbToLinear as srgbToLinearUnit } from '../color.js';

export interface Quantization {
  /** Per-pixel cluster index (-1 outside the solid mask). */
  labels: Int16Array;
  /** Cluster colors, sRGB 0-255. */
  colors: Array<[number, number, number]>;
  /** Solid-pixel count per cluster. */
  counts: number[];
}

export function quantizeColors(
  px: Uint8Array | Buffer,
  mask: Uint8Array,
  width: number,
  height: number,
  k: number,
): Quantization {
  const total = width * height;

  // Sample for fitting (cap ~40k points for speed).
  const solidIdx: number[] = [];
  for (let i = 0; i < total; i++) if (mask[i]) solidIdx.push(i);
  if (solidIdx.length === 0) {
    return { labels: new Int16Array(total).fill(-1), colors: [], counts: [] };
  }
  const stride = Math.max(1, Math.floor(solidIdx.length / 40_000));
  const samples: number[] = [];
  for (let s = 0; s < solidIdx.length; s += stride) samples.push(solidIdx[s]);

  // Init centroids spread along luminance order (stable, no RNG).
  const byLuma = [...samples].sort((a, b) => {
    const la = px[a * 4] * 0.2126 + px[a * 4 + 1] * 0.7152 + px[a * 4 + 2] * 0.0722;
    const lb = px[b * 4] * 0.2126 + px[b * 4 + 1] * 0.7152 + px[b * 4 + 2] * 0.0722;
    return la - lb;
  });
  const centroids: Array<[number, number, number]> = [];
  for (let c = 0; c < k; c++) {
    const i = byLuma[Math.floor(((c + 0.5) / k) * byLuma.length)];
    centroids.push([px[i * 4], px[i * 4 + 1], px[i * 4 + 2]]);
  }

  const nearest = (r: number, g: number, b: number): number => {
    let best = 0, bestDist = Infinity;
    for (let c = 0; c < centroids.length; c++) {
      const dr = r - centroids[c][0], dg = g - centroids[c][1], db = b - centroids[c][2];
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) { bestDist = dist; best = c; }
    }
    return best;
  };

  for (let iter = 0; iter < 12; iter++) {
    const sums = centroids.map(() => [0, 0, 0, 0]);
    for (const i of samples) {
      const c = nearest(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
      sums[c][0] += px[i * 4]; sums[c][1] += px[i * 4 + 1];
      sums[c][2] += px[i * 4 + 2]; sums[c][3]++;
    }
    let moved = 0;
    for (let c = 0; c < centroids.length; c++) {
      if (!sums[c][3]) continue;
      const next: [number, number, number] = [
        sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3],
      ];
      moved += Math.abs(next[0] - centroids[c][0]) + Math.abs(next[1] - centroids[c][1]) + Math.abs(next[2] - centroids[c][2]);
      centroids[c] = next;
    }
    if (moved < 1) break;
  }

  // Assign every solid pixel.
  const labels = new Int16Array(total).fill(-1);
  for (const i of solidIdx) {
    labels[i] = nearest(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
  }

  // 3x3 majority filter (2 passes): removes AA halos and speckle.
  for (let pass = 0; pass < 2; pass++) {
    const prev = Int16Array.from(labels);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (prev[i] < 0) continue;
        const votes = new Map<number, number>();
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const lab = prev[ny * width + nx];
            if (lab >= 0) votes.set(lab, (votes.get(lab) ?? 0) + 1);
          }
        }
        let best = prev[i], bestVotes = 0;
        for (const [lab, n] of votes) if (n > bestVotes) { bestVotes = n; best = lab; }
        labels[i] = best;
      }
    }
  }

  const counts = centroids.map(() => 0);
  for (const i of solidIdx) if (labels[i] >= 0) counts[labels[i]]++;

  return {
    labels,
    colors: centroids.map((c) => [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])]),
    counts,
  };
}

/** sRGB 0-255 -> linear 0-1 (glTF baseColorFactor space). */
export function srgbToLinear(value: number): number {
  return srgbToLinearUnit(value / 255);
}

/**
 * Is this artwork made of flat colour regions, or is it a gradient/photo?
 * Layered extrusion quantizes into k clusters whatever it is given, so a
 * smooth gradient becomes k stacked slabs with noisy contours — hundreds of
 * thousands of triangles and a shape nobody drew. Measured on a coarse
 * colour histogram of the solid pixels (deterministic, one pass).
 */
export interface Flatness {
  /** Share of the artwork sitting in the dominant flat colours. */
  coverage: number;
  /** Colour buckets holding at least MIN_SHARE of the artwork each. */
  distinct: number;
  /** Layers `layers: 'auto'` extrudes: 0 when the artwork is not flat-coloured. */
  layers: number;
}

/** Bits kept per channel: 16 levels, so JPEG noise and antialiasing collapse. */
const BUCKET_BITS = 4;
/** A colour has to own this much of the artwork to be a layer of its own. */
const MIN_SHARE = 0.08;
/** Below this, the dominant colours do not describe the artwork — it is a gradient or a photo. */
const FLAT_COVERAGE = 0.85;

export function measureFlatness(
  px: Uint8Array | Buffer,
  mask: Uint8Array,
  width: number,
  height: number,
  maxLayers = 4,
): Flatness {
  const shift = 8 - BUCKET_BITS;
  const bins = new Map<number, number>();
  let solid = 0;
  for (let i = 0; i < width * height; i++) {
    if (!mask[i]) continue;
    solid++;
    const key = ((px[i * 4] >> shift) << (2 * BUCKET_BITS)) | ((px[i * 4 + 1] >> shift) << BUCKET_BITS) | (px[i * 4 + 2] >> shift);
    bins.set(key, (bins.get(key) ?? 0) + 1);
  }
  if (solid === 0) return { coverage: 0, distinct: 0, layers: 0 };

  // Key as tiebreak: same counts must order the same way on every run.
  const counts = [...bins.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([, n]) => n);
  const distinct = Math.min(maxLayers, counts.filter((n) => n / solid >= MIN_SHARE).length);
  const coverage = counts.slice(0, Math.max(1, distinct)).reduce((s, n) => s + n, 0) / solid;
  return { coverage, distinct, layers: distinct >= 2 && coverage >= FLAT_COVERAGE ? distinct : 0 };
}
