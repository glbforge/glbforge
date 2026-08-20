/**
 * Binary-mask contour tracing: marching squares over a padded mask, segment
 * chaining into closed loops, Douglas-Peucker simplification, and nesting
 * classification (outer boundaries vs holes) by containment parity.
 *
 * All coordinates are in (padded) pixel space; vertices sit on cell-edge
 * midpoints, so loops never self-intersect and every vertex has exactly two
 * incident segments (the two ambiguous marching-squares cases are split so
 * this invariant holds).
 */

export interface Loop {
  /** Closed polyline, first point NOT repeated at the end. */
  points: Array<[number, number]>;
  /** Containment depth: even = outer boundary, odd = hole. */
  depth: number;
  /** Index into the loops array of the immediate parent (or -1). */
  parent: number;
  area: number;
}

type Pt = [number, number];

const key = (p: Pt) => p[0] * 2 * 1_000_003 + p[1] * 2;

/** Marching-squares undirected segment table; midpoints of cell edges. */
function cellSegments(caseId: number, cx: number, cy: number): Array<[Pt, Pt]> {
  const top: Pt = [cx + 0.5, cy];
  const right: Pt = [cx + 1, cy + 0.5];
  const bottom: Pt = [cx + 0.5, cy + 1];
  const left: Pt = [cx, cy + 0.5];
  switch (caseId) {
    case 1: return [[left, top]];
    case 2: return [[top, right]];
    case 3: return [[left, right]];
    case 4: return [[right, bottom]];
    case 5: return [[left, top], [right, bottom]]; // ambiguous: split
    case 6: return [[top, bottom]];
    case 7: return [[left, bottom]];
    case 8: return [[bottom, left]];
    case 9: return [[top, bottom]];
    case 10: return [[top, right], [bottom, left]]; // ambiguous: split
    case 11: return [[right, bottom]];
    case 12: return [[right, left]];
    case 13: return [[top, right]];
    case 14: return [[left, top]];
    default: return [];
  }
}

function shoelace(points: Pt[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

export function pointInLoop(pt: Pt, loop: Pt[]): boolean {
  // Ray casting to +x.
  let inside = false;
  const [px, py] = pt;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [xi, yi] = loop[i];
    const [xj, yj] = loop[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Douglas-Peucker on an open polyline (endpoints kept). */
function dpSimplify(points: Pt[], epsilon: number): Pt[] {
  if (points.length < 3) return points;
  const [ax, ay] = points[0];
  const [bx, by] = points[points.length - 1];
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  let maxDist = -1, maxIdx = -1;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i];
    const dist = Math.abs(dy * (px - ax) - dx * (py - ay)) / len;
    if (dist > maxDist) { maxDist = dist; maxIdx = i; }
  }
  if (maxDist <= epsilon) return [points[0], points[points.length - 1]];
  const left = dpSimplify(points.slice(0, maxIdx + 1), epsilon);
  const right = dpSimplify(points.slice(maxIdx), epsilon);
  return [...left.slice(0, -1), ...right];
}

function simplifyLoop(points: Pt[], epsilon: number): Pt[] {
  if (points.length < 8 || epsilon <= 0) return points;
  // Split the closed loop at its two mutually farthest x-extremes so DP
  // endpoints are stable features, then rejoin.
  let minI = 0, maxI = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i][0] < points[minI][0]) minI = i;
    if (points[i][0] > points[maxI][0]) maxI = i;
  }
  const [a, b] = minI < maxI ? [minI, maxI] : [maxI, minI];
  const seg1 = dpSimplify(points.slice(a, b + 1), epsilon);
  const seg2 = dpSimplify([...points.slice(b), ...points.slice(0, a + 1)], epsilon);
  const merged = [...seg1.slice(0, -1), ...seg2.slice(0, -1)];
  return merged.length >= 3 ? merged : points;
}

/**
 * Trace a binary mask (row-major, w*h, nonzero = solid) into classified,
 * simplified loops. Coordinates are returned in unpadded pixel space.
 */
export function traceMask(
  mask: Uint8Array,
  w: number,
  h: number,
  opts: { simplify?: number; minLoopPoints?: number } = {},
): Loop[] {
  // Pad with a 1px zero border so shapes touching the edge still close.
  const W = w + 2, H = h + 2;
  const m = (x: number, y: number): number =>
    x >= 1 && x <= w && y >= 1 && y <= h ? (mask[(y - 1) * w + (x - 1)] ? 1 : 0) : 0;

  // Collect segments; index both endpoints for chaining.
  const segments: Array<[Pt, Pt]> = [];
  const byPoint = new Map<number, number[]>();
  for (let cy = 0; cy < H - 1; cy++) {
    for (let cx = 0; cx < W - 1; cx++) {
      const caseId =
        m(cx, cy) | (m(cx + 1, cy) << 1) | (m(cx + 1, cy + 1) << 2) | (m(cx, cy + 1) << 3);
      for (const seg of cellSegments(caseId, cx, cy)) {
        const idx = segments.length;
        segments.push(seg);
        for (const p of seg) {
          const k = key(p);
          const list = byPoint.get(k);
          if (list) list.push(idx);
          else byPoint.set(k, [idx]);
        }
      }
    }
  }

  // Chain segments into closed loops (every point touches exactly 2 segments).
  const used = new Uint8Array(segments.length);
  const rawLoops: Pt[][] = [];
  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue;
    const loop: Pt[] = [];
    let segIdx = start;
    let point = segments[start][0];
    while (!used[segIdx]) {
      used[segIdx] = 1;
      const [a, b] = segments[segIdx];
      const next: Pt = key(a) === key(point) ? b : a;
      loop.push(next);
      const candidates = byPoint.get(key(next))!;
      const nextSeg = candidates.find((i) => !used[i]);
      if (nextSeg === undefined) break;
      segIdx = nextSeg;
      point = next;
    }
    if (loop.length >= (opts.minLoopPoints ?? 8)) rawLoops.push(loop);
  }

  // Simplify, then classify nesting by containment parity.
  const eps = opts.simplify ?? 1.2;
  const simplified = rawLoops
    .map((loop) => simplifyLoop(loop, eps).map(([x, y]): Pt => [x - 1, y - 1]))
    .filter((loop) => loop.length >= 3);

  const loops: Loop[] = simplified.map((points) => ({
    points, depth: 0, parent: -1, area: Math.abs(shoelace(points)),
  }));
  for (let i = 0; i < loops.length; i++) {
    const containers: number[] = [];
    for (let j = 0; j < loops.length; j++) {
      if (i !== j && pointInLoop(loops[i].points[0], loops[j].points)) {
        containers.push(j);
      }
    }
    loops[i].depth = containers.length;
    if (containers.length > 0) {
      // Immediate parent = smallest containing loop.
      loops[i].parent = containers.reduce((best, j) =>
        loops[j].area < loops[best].area ? j : best, containers[0]);
    }
  }
  return loops;
}
