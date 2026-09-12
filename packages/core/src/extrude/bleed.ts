/**
 * Flattening the projected artwork into an opaque plate.
 *
 * Artwork with a transparent background carries no colour outside its
 * silhouette — sharp and canvas both leave those texels at (0,0,0,0). The
 * forge projects that image with an OPAQUE material, so the RGB under
 * transparent texels is sampled anyway, and the rim geometry (walls and
 * bevel strips) samples exactly the 1-2 px antialiased boundary where the
 * art meets that void.
 *
 * Invisible in the source PNG; not to a lossy encoder. `optimize`'s WebP
 * pass does two things to it:
 *
 *   1. it rings across the hard art/void discontinuity, staining the
 *      boundary texels the rim samples; and
 *   2. it discards the RGB of fully transparent texels outright (libwebp
 *      cleans them to compress the alpha plane better), so padding the
 *      colour outward is not enough on its own — the padding is thrown
 *      away unless the texels are opaque.
 *
 * A 1 px texture error becomes a stippled band stretched along the entire
 * rim, and the perceptual gate reads it as visible loss (measured: 89-92%
 * min SSIM on a beveled badge, floor 94%).
 *
 * So: pad the colour out past the silhouette AND make every texel opaque.
 * The encoder then has nothing to ring on and nothing to throw away, and
 * bilinear filtering at the rim can no longer reach into the void.
 */

import { nearestSource } from './relief.js';

/**
 * Turn decoded RGBA artwork into an opaque projection plate, in place:
 * every fully transparent texel takes its nearest fully opaque texel's
 * colour, and every texel ends up at alpha 255. Partially transparent
 * texels are neither source nor target — they keep their own colour,
 * which is the authored antialiasing along the silhouette.
 *
 * Seeding from fully opaque texels only (rather than from anything with
 * some alpha) is what keeps the padding cheap: the antialiased boundary
 * holds a spread of blend values, and seeding from those paints the
 * padded region with a fine radial Voronoi that costs more to encode than
 * the artwork does. Seeded from the interior colours it is flat wherever
 * one colour owns a stretch of the silhouette, which is the common case.
 *
 * The alpha channel is the silhouette, and the silhouette is already in
 * the mesh: the trace runs on its own decode of the source image, so
 * flattening the projection cannot move a contour. Callers that also drop
 * the (now constant) channel at encode time just save the bytes.
 *
 * Exact (Felzenszwalb EDT over the seed set) and deterministic: same
 * pixels in, same pixels out — no sampling, no iteration count, no
 * tolerance.
 */
export function flattenProjection(px: Uint8Array, width: number, height: number): Uint8Array {
  const total = width * height;
  const seed = new Uint8Array(total);
  let seeds = 0, voids = 0;
  for (let i = 0; i < total; i++) {
    if (px[i * 4 + 3] === 255) { seed[i] = 1; seeds++; }
    if (px[i * 4 + 3] === 0) voids++;
  }
  // Artwork that is translucent throughout has no unambiguous colour to
  // spread; fall back to anything with some alpha rather than give up.
  if (seeds === 0) {
    for (let i = 0; i < total; i++) if (px[i * 4 + 3] > 0) { seed[i] = 1; seeds++; }
  }
  if (seeds === 0) return px; // fully transparent: no colour at all

  if (voids > 0) {
    const nearest = nearestSource(seed, width, height);
    for (let i = 0; i < total; i++) {
      if (px[i * 4 + 3] !== 0) continue;
      const s = nearest[i];
      if (s < 0) continue;
      px[i * 4] = px[s * 4];
      px[i * 4 + 1] = px[s * 4 + 1];
      px[i * 4 + 2] = px[s * 4 + 2];
    }
  }
  for (let i = 0; i < total; i++) px[i * 4 + 3] = 255;
  return px;
}
