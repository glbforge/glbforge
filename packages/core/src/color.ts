/**
 * The sRGB transfer function (IEC 61966-2-1), in one place.
 *
 * glTF splits base color across two encodings and the difference is not
 * cosmetic: `baseColorFactor` is LINEAR, while a base-color *texture* is
 * sRGB-encoded bytes. Anything that mixes the two — the deterministic
 * renderer above all — has to convert, or the same colour scores as two
 * different colours depending on which slot it happens to live in.
 *
 * Data textures (normal, ORM, occlusion) are linear by definition and must
 * NEVER be decoded through here.
 */

/** sRGB-encoded 0..1 -> linear 0..1. */
export function srgbToLinear(value: number): number {
  const c = value <= 0 ? 0 : value >= 1 ? 1 : value;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Linear 0..1 -> sRGB-encoded 0..1. */
export function linearToSrgb(value: number): number {
  const c = value <= 0 ? 0 : value >= 1 ? 1 : value;
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/**
 * sRGB byte -> linear float, tabulated. The rasterizer decodes a texel per
 * covered pixel and the supersample resolve decodes three channels per
 * sample; both are hot enough to care that this is a lookup, not a pow().
 * Values are identical to `srgbToLinear(i / 255)` by construction.
 */
export const SRGB8_TO_LINEAR: Float64Array = (() => {
  const table = new Float64Array(256);
  for (let i = 0; i < 256; i++) table[i] = srgbToLinear(i / 255);
  return table;
})();

/** Linear 0..1 -> sRGB byte, rounded and clamped. Inverse of SRGB8_TO_LINEAR. */
export function linearToSrgb8(value: number): number {
  return Math.round(linearToSrgb(value) * 255);
}
