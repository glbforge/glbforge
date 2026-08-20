/**
 * Exact Euclidean distance transform (Felzenszwalb & Huttenlocher):
 * distance in pixels from each solid pixel to the nearest outside pixel.
 * Drives pillow/relief height profiles.
 */

const INF = 1e20;

function edt1d(f: Float64Array, n: number, d: Float64Array): void {
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  let k = 0;
  v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/** Distance (px) from each pixel to the nearest zero-mask pixel. */
export function distanceTransform(mask: Uint8Array, width: number, height: number): Float32Array {
  const grid = new Float64Array(width * height);
  for (let i = 0; i < grid.length; i++) grid[i] = mask[i] ? INF : 0;

  const f = new Float64Array(Math.max(width, height));
  const d = new Float64Array(Math.max(width, height));
  // Columns.
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = grid[y * width + x];
    edt1d(f, height, d);
    for (let y = 0; y < height; y++) grid[y * width + x] = d[y];
  }
  // Rows.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) f[x] = grid[y * width + x];
    edt1d(f, width, d);
    for (let x = 0; x < width; x++) grid[y * width + x] = d[x];
  }

  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = Math.sqrt(grid[i]);
  return out;
}

/** Bilinear sample of the distance field at fractional pixel coords. */
export function sampleDistance(
  dist: Float32Array, width: number, height: number, x: number, y: number,
): number {
  const cx = Math.min(Math.max(x, 0), width - 1.001);
  const cy = Math.min(Math.max(y, 0), height - 1.001);
  const x0 = Math.floor(cx), y0 = Math.floor(cy);
  const fx = cx - x0, fy = cy - y0;
  const i = y0 * width + x0;
  return (
    dist[i] * (1 - fx) * (1 - fy) +
    dist[i + 1] * fx * (1 - fy) +
    dist[i + width] * (1 - fx) * fy +
    dist[i + width + 1] * fx * fy
  );
}
