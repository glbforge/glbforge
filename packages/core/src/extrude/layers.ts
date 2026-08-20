/**
 * Color quantization for layered extrusion: k-means over the solid pixels,
 * then a 3x3 majority filter over the label map — anti-aliased edge pixels
 * otherwise form thin halo rings between color regions.
 */

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
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
