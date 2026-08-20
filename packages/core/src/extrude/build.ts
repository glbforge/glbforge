import { Document } from '@gltf-transform/core';
import earcut from 'earcut';
import type { Loop } from './trace.js';

export interface ExtrudeMeshOptions {
  /** World width of the full image extent (meters). Default 1. */
  width?: number;
  /** Extrusion depth (meters). Default width * 0.08. */
  depth?: number;
  /** Bevel radius (meters). 0 = hard edge. Clamped to 49% of depth. */
  bevel?: number;
  /** Bevel roundness: 1 = chamfer, 3+ = rounded. Default 3. */
  bevelSegments?: number;
  /** Trace-space image dimensions (for UVs and scaling). */
  imageWidth: number;
  imageHeight: number;
  /** Pillow/relief: extra front-cap height (meters) at trace coords (x, y).
   *  Must be ~0 along contours so walls stay sealed. Disables the bevel. */
  frontHeightFn?: (x: number, y: number) => number;
  /** Mirror the height field onto the back cap too (full 3D object read
   *  from every angle instead of a flat-backed plaque). */
  doubleSided?: boolean;
}

export interface ExtrudeStats {
  loops: number;
  outerLoops: number;
  holes: number;
  triangles: number;
  vertices: number;
}

type Pt = [number, number];

/**
 * Builds an extruded, indexed, UV-mapped mesh from classified loops, with an
 * optional signage-style bevel (quarter-round profile) on both rims.
 *
 * Geometry layout per shape: front/back caps (earcut on the bevel-inset
 * contours), a straight wall between the bevels, and bevel strips with
 * smooth profile normals. Caps/walls/bevels do not share vertices, so rim
 * edges stay crisp while the bevel itself shades round.
 *
 * Winding is normalized empirically (caps by normal sign, walls/bevels by an
 * interior-point test per ring) rather than trusting loop orientation.
 */
export function buildExtrusion(
  doc: Document,
  loops: Loop[],
  opts: ExtrudeMeshOptions,
): { positions: Float32Array; normals: Float32Array; uvs: Float32Array; indices: Uint32Array; stats: ExtrudeStats } {
  const { imageWidth: iw, imageHeight: ih } = opts;
  const width = opts.width ?? 1;
  const scale = width / iw; // meters per trace pixel
  const depth = opts.depth ?? width * 0.08;
  const hz = depth / 2;
  const bevel = opts.frontHeightFn ? 0 : Math.min(opts.bevel ?? 0, depth * 0.49);
  const bevelPx = bevel / scale;
  const segments = Math.max(1, Math.round(opts.bevelSegments ?? 3));
  const cx = iw / 2, cy = ih / 2;

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const pushVert = (x: number, y: number, z: number, n: [number, number, number]): number => {
    positions.push((x - cx) * scale, (cy - y) * scale, z);
    normals.push(...n);
    uvs.push(x / iw, y / ih);
    return positions.length / 3 - 1;
  };

  const outers = loops.map((l, i) => ({ l, i })).filter(({ l }) => l.depth % 2 === 0);
  const holesFor = (outerIdx: number) =>
    loops.filter((l) => l.depth % 2 === 1 && l.parent === outerIdx);

  let outerCount = 0, holeCount = 0;

  for (const { l: outer, i: outerIdx } of outers) {
    outerCount++;
    const holes = holesFor(outerIdx);
    holeCount += holes.length;
    const solid = { outer, holes };

    // Per-ring: inward (into-solid) direction per vertex, miter-scaled and
    // clamped so the rim never crosses a thin stroke to the far side.
    const rings = [outer, ...holes].map((ring) => ({
      ring,
      insets: insetDirections(ring, solid, bevelPx),
    }));

    // --- walls + bevel strips per ring; strip top rings are captured so the
    // caps can reference those exact vertices (rim T-junctions impossible). ---
    const ringTopFront: number[][] = [];
    const ringTopBack: number[][] = [];

    for (const { ring, insets } of rings) {
      const pts = ring.points;
      const flipRing = wallsFaceInterior(pts, outer, holes);
      const orient = (a: number, b: number, c: number, d: number) =>
        flipRing ? indices.push(a, c, b, a, d, c) : indices.push(a, b, c, a, c, d);

      // Straight wall between the two bevel shoulders, flat per-edge normals.
      const wallTop = hz - bevel, wallBot = -hz + bevel;
      for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i];
        const [x2, y2] = pts[(i + 1) % pts.length];
        let nx = y2 - y1, ny = x2 - x1; // world-space perpendicular
        const nlen = Math.hypot(nx, ny) || 1;
        nx /= nlen; ny /= nlen;
        if (flipRing) { nx = -nx; ny = -ny; }
        const n: [number, number, number] = [nx, ny, 0];
        orient(
          pushVert(x1, y1, wallTop, n), pushVert(x1, y1, wallBot, n),
          pushVert(x2, y2, wallBot, n), pushVert(x2, y2, wallTop, n),
        );
      }

      if (bevel <= 0) {
        // No bevel: caps sit directly on the wall contour; record synthetic
        // "top rings" at the cap planes for the shared-vertex cap pass.
        const front: number[] = [], back: number[] = [];
        for (const [x, y] of pts) {
          front.push(pushVert(x, y, hz, [0, 0, 1]));
          back.push(pushVert(x, y, -hz, [0, 0, -1]));
        }
        ringTopFront.push(front);
        ringTopBack.push(back);
        continue;
      }

      // Bevel strips: profile levels from the wall shoulder (phi=0) to the
      // cap rim (phi=pi/2), for both front (+) and back (-) rims. Vertices
      // are shared along each ring level -> smooth round shading.
      for (const side of [1, -1] as const) {
        const levels: number[][] = [];
        for (let k = 0; k <= segments; k++) {
          const phi = (k / segments) * (Math.PI / 2);
          const offPx = bevelPx * (1 - Math.cos(phi));
          const z = side * (hz - bevel + bevel * Math.sin(phi));
          const level: number[] = [];
          for (let i = 0; i < pts.length; i++) {
            const [x, y] = pts[i];
            const [dx, dy] = insets[i];
            const vx = x + dx * offPx, vy = y + dy * offPx;
            // Outward world normal blended toward the cap normal by phi.
            // Image inset (dx,dy) -> world inward (dx,-dy) -> outward is negated.
            const ox = -dx, oy = dy;
            const olen = Math.hypot(ox, oy) || 1;
            const n: [number, number, number] = [
              (ox / olen) * Math.cos(phi),
              (oy / olen) * Math.cos(phi),
              side * Math.sin(phi),
            ];
            level.push(pushVert(vx, vy, z, n));
          }
          levels.push(level);
        }
        for (let k = 0; k < segments; k++) {
          for (let i = 0; i < pts.length; i++) {
            const j = (i + 1) % pts.length;
            // Front side keeps ring order; back side mirrors, so swap.
            if (side === 1) orient(levels[k][i], levels[k][j], levels[k + 1][j], levels[k + 1][i]);
            else orient(levels[k][j], levels[k][i], levels[k + 1][i], levels[k + 1][j]);
          }
        }
        (side === 1 ? ringTopFront : ringTopBack).push(levels[segments]);
      }
    }

    // --- caps: earcut over the strip-top vertices themselves. Consecutive
    // duplicate points (fully clamped bevel) are skipped for earcut but the
    // welded topology stays closed because they share positions. ---
    for (const [topRings, nz] of [[ringTopFront, 1], [ringTopBack, -1]] as const) {
      const flat: number[] = [];
      const globalIds: number[] = [];
      const holeIndices: number[] = [];
      let valid = true;
      rings.forEach(({ ring }, r) => {
        const ids = topRings[r];
        const deduped: Array<[number, number, number]> = [];
        for (let i = 0; i < ids.length; i++) {
          const gx = positions[ids[i] * 3], gy = positions[ids[i] * 3 + 1];
          const prev = deduped[deduped.length - 1];
          if (prev && prev[0] === gx && prev[1] === gy) continue;
          deduped.push([gx, gy, ids[i]]);
        }
        while (
          deduped.length > 1 &&
          deduped[0][0] === deduped[deduped.length - 1][0] &&
          deduped[0][1] === deduped[deduped.length - 1][1]
        ) deduped.pop();
        if (r === 0 && deduped.length < 3) { valid = false; return; }
        if (deduped.length < 3) return; // fully collapsed hole: drop
        if (r > 0) holeIndices.push(flat.length / 2);
        for (const [gx, gy, id] of deduped) {
          flat.push(gx, gy);
          globalIds.push(id);
        }
      });
      if (!valid) continue;
      const tris = earcut(flat, holeIndices.length ? holeIndices : undefined);

      if (opts.frontHeightFn && (nz === 1 || opts.doubleSided)) {
        // Displaced cap (front always; back too when double-sided —
        // mirrored, so the object reads as a full form from behind).
        const fn = opts.frontHeightFn;
        buildDisplacedCap(
          tris, globalIds, holeIndices, nz * hz,
          nz === 1 ? fn : (x, y) => -fn(x, y),
          nz,
        );
        continue;
      }

      for (let t = 0; t < tris.length; t += 3) {
        let [a, b, c] = [globalIds[tris[t]], globalIds[tris[t + 1]], globalIds[tris[t + 2]]];
        if (Math.sign(triNormalZ(positions, a, b, c)) !== nz) [b, c] = [c, b];
        indices.push(a, b, c);
      }
    }
  }

  /**
   * Densified, displaced front cap. Uniform 4:1 subdivision (no T-junctions
   * by construction) in TRACE coordinates, then each vertex is lifted by the
   * height function. Rim vertices reuse the existing strip-top ids so the
   * cap stays sealed to the walls; the height function is ~0 there anyway.
   */
  function buildDisplacedCap(
    tris: number[],
    rimIds: number[],
    holeStarts: number[],
    zBase: number,
    heightFn: (x: number, y: number) => number,
    normalSign = 1,
  ): void {
    // Recover trace coords for the rim ring from world positions (invert toWorld).
    const traceXY: number[] = [];
    for (const id of rimIds) {
      traceXY.push(positions[id * 3] / scale + cx, cy - positions[id * 3 + 1] / scale);
    }
    let verts = traceXY;             // [x, y] per vertex, trace space
    let faces = [...tris];
    // Vertex ids: first rimIds.length map to existing ids; new ones appended.
    const isRim = (i: number) => i < rimIds.length;

    // Ring (contour) edges must NEVER split: the wall quads keep whole
    // edges, so splitting the cap's rim would create T-junction cracks.
    const edgeKey = (a: number, b: number) => (a < b ? a * 1e7 + b : b * 1e7 + a);
    const ringEdges = new Set<number>();
    const starts = [0, ...holeStarts, rimIds.length];
    for (let r = 0; r < starts.length - 1; r++) {
      for (let i = starts[r]; i < starts[r + 1]; i++) {
        const j = i + 1 === starts[r + 1] ? starts[r] : i + 1;
        ringEdges.add(edgeKey(i, j));
      }
    }

    const ROUNDS = verts.length / 2 < 600 ? 4 : 3;
    const MAX_TRIS = 120_000;
    for (let round = 0; round < ROUNDS && (faces.length / 3) * 4 <= MAX_TRIS; round++) {
      const mid = new Map<number, number>();
      const nextFaces: number[] = [];
      const midpoint = (a: number, b: number): number | null => {
        const key = edgeKey(a, b);
        if (ringEdges.has(key)) return null;
        const hit = mid.get(key);
        if (hit !== undefined) return hit;
        const idx = verts.length / 2;
        verts.push((verts[a * 2] + verts[b * 2]) / 2, (verts[a * 2 + 1] + verts[b * 2 + 1]) / 2);
        mid.set(key, idx);
        return idx;
      };
      for (let t = 0; t < faces.length; t += 3) {
        const [a, b, c] = [faces[t], faces[t + 1], faces[t + 2]];
        const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
        const splits = [ab, bc, ca].filter((m) => m !== null).length;
        if (splits === 3) {
          nextFaces.push(a, ab!, ca!, ab!, b, bc!, ca!, bc!, c, ab!, bc!, ca!);
        } else if (splits === 2) {
          // Rotate so the unsplit edge is (a, b).
          let [p, q, r2, m1, m2] = ab === null
            ? [a, b, c, bc!, ca!]
            : bc === null
              ? [b, c, a, ca!, ab!]
              : [c, a, b, ab!, bc!];
          nextFaces.push(p, q, m1, p, m1, m2, m2, m1, r2);
        } else if (splits === 1) {
          const m = (ab ?? bc ?? ca)!;
          if (ab !== null) nextFaces.push(a, m, c, m, b, c);
          else if (bc !== null) nextFaces.push(b, m, a, m, c, a);
          else nextFaces.push(c, m, b, m, a, b);
        } else {
          nextFaces.push(a, b, c);
        }
      }
      faces = nextFaces;
    }

    // Emit vertices: rim ring reuses existing ids (sealed to walls); new
    // interior/midpoint vertices are pushed with displaced z.
    const emitted: number[] = [];
    for (let i = 0; i < verts.length / 2; i++) {
      if (isRim(i)) {
        emitted.push(rimIds[i]);
      } else {
        const x = verts[i * 2], y = verts[i * 2 + 1];
        emitted.push(pushVert(x, y, zBase + heightFn(x, y), [0, 0, normalSign]));
      }
    }

    // Faces (winding normalized against the cap's outward z), collected
    // for the smooth-normal pass.
    const capFaces: number[] = [];
    for (let t = 0; t < faces.length; t += 3) {
      let [a, b, c] = [emitted[faces[t]], emitted[faces[t + 1]], emitted[faces[t + 2]]];
      if (Math.sign(triNormalZ(positions, a, b, c)) !== normalSign) [b, c] = [c, b];
      indices.push(a, b, c);
      capFaces.push(a, b, c);
    }

    // Smooth normals over the displaced surface (area-weighted).
    const acc = new Map<number, [number, number, number]>();
    for (let t = 0; t < capFaces.length; t += 3) {
      const [a, b, c] = [capFaces[t], capFaces[t + 1], capFaces[t + 2]];
      const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
      const ux = positions[b * 3] - ax, uy = positions[b * 3 + 1] - ay, uz = positions[b * 3 + 2] - az;
      const vx = positions[c * 3] - ax, vy = positions[c * 3 + 1] - ay, vz = positions[c * 3 + 2] - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nzc = ux * vy - uy * vx;
      for (const vId of [a, b, c]) {
        const cur = acc.get(vId) ?? [0, 0, 0];
        cur[0] += nx; cur[1] += ny; cur[2] += nzc;
        acc.set(vId, cur);
      }
    }
    for (const [vId, n] of acc) {
      const len = Math.hypot(n[0], n[1], n[2]) || 1;
      normals[vId * 3] = n[0] / len;
      normals[vId * 3 + 1] = n[1] / len;
      normals[vId * 3 + 2] = n[2] / len;
    }
  }

  stitchCracks(positions, normals, indices);

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
    stats: {
      loops: loops.length,
      outerLoops: outerCount,
      holes: holeCount,
      triangles: indices.length / 3,
      vertices: positions.length / 3,
    },
  };
}

function triNormalZ(pos: number[], a: number, b: number, c: number): number {
  const ax = pos[a * 3], ay = pos[a * 3 + 1];
  const bx = pos[b * 3], by = pos[b * 3 + 1];
  const cxx = pos[c * 3], cyy = pos[c * 3 + 1];
  return (bx - ax) * (cyy - ay) - (by - ay) * (cxx - ax);
}

/**
 * Per-vertex unit directions (image space) pointing INTO the solid, with a
 * miter-limited scale so acute corners don't spike and thin strokes don't
 * self-intersect at small bevel radii.
 */
function insetDirections(
  ring: Loop,
  solid: { outer: Loop; holes: Loop[] },
  insetPx: number,
): Pt[] {
  const pts = ring.points;
  const n = pts.length;

  // Consistent per-edge normals; sign resolved once by an interior test.
  const edgeNormals: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % n];
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    edgeNormals.push([(y2 - y1) / len, -(x2 - x1) / len]);
  }
  // Test on the longest edge (stable), mirroring wallsFaceInterior's logic.
  let bestI = 0, bestLen = -1;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % n];
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len > bestLen) { bestLen = len; bestI = i; }
  }
  const [x1, y1] = pts[bestI];
  const [x2, y2] = pts[(bestI + 1) % n];
  const eps = Math.max(0.5, bestLen * 0.01);
  const probe: Pt = [
    (x1 + x2) / 2 + edgeNormals[bestI][0] * eps,
    (y1 + y2) / 2 + edgeNormals[bestI][1] * eps,
  ];
  const sign = insideSolid(probe, solid) ? 1 : -1;

  const dirs: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const prev = edgeNormals[(i - 1 + n) % n];
    const next = edgeNormals[i];
    let bx = (prev[0] + next[0]) * sign;
    let by = (prev[1] + next[1]) * sign;
    const blen = Math.hypot(bx, by);
    if (blen < 1e-6) {
      // 180-degree fold: fall back to one edge normal.
      bx = next[0] * sign; by = next[1] * sign;
      dirs.push([bx, by]);
      continue;
    }
    bx /= blen; by /= blen;
    // Miter scale 1/cos(theta/2), capped at 2.
    const cosHalf = Math.max(0.5, bx * next[0] * sign + by * next[1] * sign);
    dirs.push([bx / cosHalf, by / cosHalf]);
  }
  if (insetPx <= 0) return dirs;

  // Clamp inset so rims can't pierce or crisscross inside thin strokes:
  // 1) per-vertex max feasible scale, with a 2.2x safety margin: each rim
  //    point stays within (1/2.2) of the local stroke width, so two opposing
  //    rims can never cross;
  // 2) slope-limit the scales along the ring (no zigzag rims);
  // 3) snap near-zero scales flat.
  const scales = new Float64Array(n).fill(1);
  // Probe several depths along the inset ray, not just the far end — a
  // single far probe can jump clean across a thin hole and land back in
  // solid, falsely approving a rim that sits inside the hole.
  const PROBE_DEPTHS = [0.6, 1.0, 1.5, 2.2];
  for (let i = 0; i < n; i++) {
    let scale = 1;
    let ok = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      const fits = PROBE_DEPTHS.every((depthFactor) =>
        insideSolid(
          [
            pts[i][0] + dirs[i][0] * scale * insetPx * depthFactor,
            pts[i][1] + dirs[i][1] * scale * insetPx * depthFactor,
          ],
          solid,
        ),
      );
      if (fits) { ok = true; break; }
      scale /= 2;
    }
    scales[i] = ok ? scale : 0;
  }
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 0; i < n; i++) {
      const prev = scales[(i - 1 + n) % n];
      const nextS = scales[(i + 1) % n];
      scales[i] = Math.min(scales[i], prev + 0.2, nextS + 0.2);
    }
  }
  // Segment safety: endpoints can both be safe while the rim edge between
  // them crosses a boundary. Shrink both ends until edge midpoints hold.
  for (let pass = 0; pass < 3; pass++) {
    let dirty = false;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const mx = (pts[i][0] + dirs[i][0] * scales[i] * insetPx + pts[j][0] + dirs[j][0] * scales[j] * insetPx) / 2;
      const my = (pts[i][1] + dirs[i][1] * scales[i] * insetPx + pts[j][1] + dirs[j][1] * scales[j] * insetPx) / 2;
      if (!insideSolid([mx, my], solid)) {
        scales[i] /= 2; scales[j] /= 2;
        dirty = true;
      }
    }
    if (!dirty) break;
  }
  for (let i = 0; i < n; i++) {
    const s2 = scales[i] < 0.2 ? 0 : scales[i];
    dirs[i] = [dirs[i][0] * s2, dirs[i][1] * s2];
  }
  return dirs;
}

function insideSolid(pt: Pt, solid: { outer: Loop; holes: Loop[] }): boolean {
  const inLoop = (loop: Loop): boolean => {
    let inside = false;
    const lp = loop.points;
    const [px, py] = pt;
    for (let i = 0, j = lp.length - 1; i < lp.length; j = i++) {
      const [xi, yi] = lp[i];
      const [xj, yj] = lp[j];
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  return inLoop(solid.outer) && !solid.holes.some(inLoop);
}

/** True if the ring's naive wall normal points into the solid region. */
function wallsFaceInterior(pts: Pt[], outer: Loop, holes: Loop[]): boolean {
  let bestLen = -1, bestI = 0;
  for (let i = 0; i < pts.length; i++) {
    const [a, b] = pts[i];
    const [c, d] = pts[(i + 1) % pts.length];
    const len = Math.hypot(c - a, d - b);
    if (len > bestLen) { bestLen = len; bestI = i; }
  }
  const [x1, y1] = pts[bestI];
  const [x2, y2] = pts[(bestI + 1) % pts.length];
  let nx = y2 - y1, ny = -(x2 - x1);
  const nlen = Math.hypot(nx, ny) || 1;
  const epsilon = Math.max(0.5, bestLen * 0.01);
  const probe: Pt = [(x1 + x2) / 2 + (nx / nlen) * epsilon, (y1 + y2) / 2 + (ny / nlen) * epsilon];
  return insideSolid(probe, { outer, holes });
}

/**
 * Last-mile watertightness: pathological pinch regions can make earcut drop
 * sliver triangles no matter how carefully the bevel rims are inset. Find
 * the remaining boundary-edge loops in welded-position space and fill each
 * (they are planar, sitting in a cap plane) with earcut.
 */
function stitchCracks(positions: number[], normals: number[], indices: number[]): void {
  const vertexCount = positions.length / 3;
  const canonical = new Uint32Array(vertexCount);
  const seen = new Map<string, number>();
  for (let i = 0; i < vertexCount; i++) {
    const k = positions[i * 3] + '|' + positions[i * 3 + 1] + '|' + positions[i * 3 + 2];
    const e = seen.get(k);
    canonical[i] = e === undefined ? i : e;
    if (e === undefined) seen.set(k, i);
  }

  // Count welded-space edge incidence, remembering one directed original.
  const count = new Map<number, number>();
  const sample = new Map<number, [number, number]>();
  for (let t = 0; t < indices.length; t += 3) {
    const tri = [indices[t], indices[t + 1], indices[t + 2]];
    const [a, b, c] = tri.map((i) => canonical[i]);
    if (a === b || b === c || a === c) continue;
    const pairs: Array<[number, number]> = [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]];
    for (const [u0, v0] of pairs) {
      const u = canonical[u0], v = canonical[v0];
      const k = u < v ? u * vertexCount + v : v * vertexCount + u;
      count.set(k, (count.get(k) ?? 0) + 1);
      if (!sample.has(k)) sample.set(k, [u0, v0]);
    }
  }

  // Adjacency over boundary edges (canonical space).
  const adj = new Map<number, number[]>();
  for (const [k, c] of count) {
    if (c !== 1) continue;
    const u = Math.floor(k / vertexCount), v = k % vertexCount;
    (adj.get(u) ?? adj.set(u, []).get(u)!).push(v);
    (adj.get(v) ?? adj.set(v, []).get(v)!).push(u);
  }

  // Chain loops over VISITED EDGES (not vertices) so pinch points where a
  // vertex carries 4 boundary edges (figure-8 cracks) split into two loops.
  const edgeKey = (u: number, v: number) =>
    u < v ? u * vertexCount + v : v * vertexCount + u;
  const usedEdges = new Set<number>();
  const allBoundary: Array<[number, number]> = [];
  for (const [u, vs] of adj) for (const v of vs) if (u < v) allBoundary.push([u, v]);

  for (const [su, sv] of allBoundary) {
    if (usedEdges.has(edgeKey(su, sv))) continue;
    const loop: number[] = [su];
    usedEdges.add(edgeKey(su, sv));
    let prev = su;
    let cur = sv;
    let closed = false;
    while (loop.length <= 4096) {
      loop.push(cur);
      if (cur === su && loop.length > 2) { closed = true; loop.pop(); break; }
      const next = (adj.get(cur) ?? []).find(
        (x) => x !== prev && !usedEdges.has(edgeKey(cur, x)),
      );
      if (next === undefined) break;
      usedEdges.add(edgeKey(cur, next));
      prev = cur;
      cur = next;
    }
    if (!closed || loop.length < 3) continue;

    // Planarity check: loops we can fill live in one cap plane.
    const zs = loop.map((i) => positions[i * 3 + 2]);
    const zMin = Math.min(...zs), zMax = Math.max(...zs);
    if (zMax - zMin > 1e-6) continue;
    const nz = zs[0] > 0 ? 1 : -1;

    const flat: number[] = [];
    for (const i of loop) flat.push(positions[i * 3], positions[i * 3 + 1]);
    const tris = earcut(flat);
    for (let t = 0; t < tris.length; t += 3) {
      let [a, b, c] = [loop[tris[t]], loop[tris[t + 1]], loop[tris[t + 2]]];
      if (Math.sign(triNormalZ(positions, a, b, c)) !== nz) [b, c] = [c, b];
      indices.push(a, b, c);
    }
  }
}
