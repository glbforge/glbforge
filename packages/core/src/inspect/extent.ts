/**
 * World-space extent of a scene in metres — bounds, vertex centroid, up
 * axis — and where the origin sits relative to it. Shared by the report
 * and the core-scene rule pack so both read the same numbers.
 */
import { IDENTITY, transformPoint, type SceneIR } from './ir.js';

export interface SceneExtent {
  /** Metres. */
  min: number[];
  max: number[];
  size: number[];
  largest: number;
  /** Mean vertex position, metres (unweighted). */
  centroid: number[];
  /** Index of the up axis (1 = Y, 2 = Z). */
  up: 0 | 1 | 2;
  vertices: number;
}

export type OriginLandmark = 'base-center' | 'center' | 'centroid' | 'elsewhere';

export interface OriginPlacement {
  at: OriginLandmark;
  /** 0 = min … 1 = max per axis. */
  position_in_bounds: number[];
  /** Signed height of the origin above the bottom of the bounds along the up axis. */
  height_above_base_m: number;
  distance_to_centroid_m: number;
  /** Origin within the bounds (with tolerance). */
  inside_bounds: boolean;
  /** Translation that would put the origin at the base centre. */
  offset_to_base_center_m: number[];
}

const z0 = (v: number) => (v === 0 ? 0 : v); // no negative zero in reports

export function sceneExtent(ir: SceneIR): SceneExtent | null {
  const mpu = ir.metersPerUnit || 1;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], sum = [0, 0, 0];
  let count = 0;
  for (const m of ir.meshes) {
    const w = ir.nodes[m.node]?.world ?? IDENTITY;
    const p = m.positions;
    for (let i = 0; i < m.vertexCount; i++) {
      const v = transformPoint(w, p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
      for (let a = 0; a < 3; a++) { if (v[a] < min[a]) min[a] = v[a]; if (v[a] > max[a]) max[a] = v[a]; sum[a] += v[a]; }
      count++;
    }
  }
  if (!count || !Number.isFinite(min[0])) return null;
  const size = max.map((v, i) => (v - min[i]) * mpu);
  return {
    min: min.map((v) => z0(v * mpu)), max: max.map((v) => z0(v * mpu)), size,
    largest: Math.max(...size),
    centroid: sum.map((v) => z0((v / count) * mpu)),
    up: ir.upAxis === 'Z' ? 2 : 1,
    vertices: count,
  };
}

/** Where the world origin is relative to the extent. `tol` is a fraction of the bounds per axis (default 0.05). */
export function classifyOrigin(e: SceneExtent, tol = 0.05): OriginPlacement {
  const position_in_bounds = e.size.map((s, i) => z0(s > 0 ? (0 - e.min[i]) / s : 0.5));
  const within = (i: number, target: number) => Math.abs(position_in_bounds[i] - target) <= tol || e.size[i] <= e.largest * 1e-3;
  const across = [0, 1, 2].filter((i) => i !== e.up);
  const centeredAcross = across.every((i) => within(i, 0.5));
  const distance_to_centroid_m = Math.hypot(e.centroid[0], e.centroid[1], e.centroid[2]);
  let at: OriginLandmark = 'elsewhere';
  if (centeredAcross && within(e.up, 0)) at = 'base-center';
  else if (centeredAcross && within(e.up, 0.5)) at = 'center';
  else if (distance_to_centroid_m <= tol * e.largest) at = 'centroid';
  const inside_bounds = position_in_bounds.every((v) => v >= -tol && v <= 1 + tol);
  const offset_to_base_center_m = [0, 1, 2].map((i) => z0(i === e.up ? -e.min[i] : -(e.min[i] + e.max[i]) / 2));
  return { at, position_in_bounds, height_above_base_m: z0(-e.min[e.up]), distance_to_centroid_m, inside_bounds, offset_to_base_center_m };
}
