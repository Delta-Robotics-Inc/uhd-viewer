/**
 * Orthogonal link routing with filleted corners (design decision D3).
 * Pure geometry: no React.
 */

export type Side = "left" | "right" | "top" | "bottom";
export type Pt = [number, number];

const STUB = 18;

const DIR: Record<Side, Pt> = {
  left: [-1, 0],
  right: [1, 0],
  top: [0, -1],
  bottom: [0, 1],
};

function stub([x, y]: Pt, side: Side, len = STUB): Pt {
  const [dx, dy] = DIR[side];
  return [x + dx * len, y + dy * len];
}

const horizontal = (s: Side) => s === "left" || s === "right";

/** Remove duplicate and collinear points. */
export function simplify(points: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 0.5 && Math.abs(last[1] - p[1]) < 0.5) continue;
    out.push(p);
    while (out.length >= 3) {
      const [a, b, c] = out.slice(-3);
      const collinear =
        (Math.abs(a[0] - b[0]) < 0.5 && Math.abs(b[0] - c[0]) < 0.5) ||
        (Math.abs(a[1] - b[1]) < 0.5 && Math.abs(b[1] - c[1]) < 0.5);
      if (!collinear) break;
      out.splice(out.length - 2, 1);
    }
  }
  return out;
}

/** Insert elbows so every segment between consecutive points is axis-aligned. */
function orthogonalize(points: Pt[], startHorizontal: boolean): Pt[] {
  const out: Pt[] = [points[0]];
  let wasHorizontal = startHorizontal;
  for (let i = 1; i < points.length; i++) {
    const [px, py] = out[out.length - 1];
    const [x, y] = points[i];
    if (Math.abs(px - x) > 0.5 && Math.abs(py - y) > 0.5) {
      // continue in the current direction first, then turn
      out.push(wasHorizontal ? [x, py] : [px, y]);
    }
    out.push([x, y]);
    const [ax, ay] = out[out.length - 2];
    wasHorizontal = Math.abs(ay - y) < 0.5 && Math.abs(ax - x) > 0.5;
  }
  return out;
}

/**
 * Route from a port on `sourceSide` to a port on `targetSide`. Waypoints, when
 * given, are visited in order; otherwise a 1–2 elbow Manhattan route is used.
 */
export function route(
  source: Pt,
  sourceSide: Side,
  target: Pt,
  targetSide: Side,
  waypoints: Pt[] = [],
): Pt[] {
  const s1 = stub(source, sourceSide);
  const t1 = stub(target, targetSide);
  let middle: Pt[];

  if (waypoints.length > 0) {
    middle = waypoints;
  } else if (horizontal(sourceSide) && horizontal(targetSide)) {
    const mx = (s1[0] + t1[0]) / 2;
    middle = [[mx, s1[1]], [mx, t1[1]]];
  } else if (!horizontal(sourceSide) && !horizontal(targetSide)) {
    const my = (s1[1] + t1[1]) / 2;
    middle = [[s1[0], my], [t1[0], my]];
  } else if (horizontal(sourceSide)) {
    middle = [[t1[0], s1[1]]];
  } else {
    middle = [[s1[0], t1[1]]];
  }

  const pts = orthogonalize([source, s1, ...middle, t1], horizontal(sourceSide));
  // final approach must arrive along the target side's axis
  const last = pts[pts.length - 1];
  const [tx, ty] = target;
  if (horizontal(targetSide) && Math.abs(last[1] - ty) > 0.5) pts.push([last[0], ty]);
  if (!horizontal(targetSide) && Math.abs(last[0] - tx) > 0.5) pts.push([tx, last[1]]);
  pts.push(target);
  return simplify(pts);
}

/** SVG path through `points` with quadratic fillets of radius `r` (or per-corner radii). */
export function filletPath(points: Pt[], r: number | number[]): string {
  if (points.length < 2) return "";
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    const [cx, cy] = points[i + 1];
    const l1 = Math.hypot(bx - ax, by - ay);
    const l2 = Math.hypot(cx - bx, cy - by);
    const radius = Math.max(0, Math.min(Array.isArray(r) ? r[i - 1] : r, l1 / 2, l2 / 2));
    const p1x = bx - ((bx - ax) / l1) * radius;
    const p1y = by - ((by - ay) / l1) * radius;
    const p2x = bx + ((cx - bx) / l2) * radius;
    const p2y = by + ((cy - by) / l2) * radius;
    d += ` L${p1x},${p1y} Q${bx},${by} ${p2x},${p2y}`;
  }
  const [ex, ey] = points[points.length - 1];
  return `${d} L${ex},${ey}`;
}

export function length(points: Pt[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return total;
}

/** Point at fraction `t` (0..1) along the polyline. */
export function pointAt(points: Pt[], t: number): Pt {
  const target = length(points) * Math.min(1, Math.max(0, t));
  let walked = 0;
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    const seg = Math.hypot(bx - ax, by - ay);
    if (walked + seg >= target && seg > 0) {
      const f = (target - walked) / seg;
      return [ax + (bx - ax) * f, ay + (by - ay) * f];
    }
    walked += seg;
  }
  return points[points.length - 1];
}

/** Fraction along the path of the middle of its longest segment (default label spot). */
export function longestSegmentMid(points: Pt[]): number {
  const total = length(points) || 1;
  let best = 0;
  let bestMid = 0.5;
  let walked = 0;
  for (let i = 1; i < points.length; i++) {
    const seg = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    if (seg > best) {
      best = seg;
      bestMid = (walked + seg / 2) / total;
    }
    walked += seg;
  }
  return bestMid;
}

/**
 * Offset an orthogonal polyline sideways by `d` (positive = left of travel
 * direction in screen space). Returns the points and concentric fillet radii.
 */
export function offsetPolyline(points: Pt[], d: number, r: number): { points: Pt[]; radii: number[] } {
  const pts = simplify(points);
  if (pts.length < 2 || d === 0) return { points: pts, radii: pts.map(() => r) };
  const normals: Pt[] = [];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0];
    const dy = pts[i][1] - pts[i - 1][1];
    const len = Math.hypot(dx, dy) || 1;
    normals.push([dy / len, -dx / len]);
  }
  const out: Pt[] = [];
  const radii: number[] = [];
  out.push([pts[0][0] + normals[0][0] * d, pts[0][1] + normals[0][1] * d]);
  for (let i = 1; i < pts.length - 1; i++) {
    const n1 = normals[i - 1];
    const n2 = normals[i];
    out.push([pts[i][0] + (n1[0] + n2[0]) * d, pts[i][1] + (n1[1] + n2[1]) * d]);
    // turn direction: cross of incoming and outgoing direction vectors
    const din: Pt = [pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]];
    const dout: Pt = [pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]];
    const cross = Math.sign(din[0] * dout[1] - din[1] * dout[0]);
    // left-of-travel offsets sit on the outside of a right (clockwise) turn
    radii.push(Math.max(2, r + cross * d));
  }
  const n = normals[normals.length - 1];
  const last = pts[pts.length - 1];
  out.push([last[0] + n[0] * d, last[1] + n[1] * d]);
  return { points: out, radii };
}
