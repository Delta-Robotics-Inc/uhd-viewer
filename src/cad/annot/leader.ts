/**
 * Leader routing, option A (plan.md overnight DEFAULT, Kevin's ruling: legs
 * horizontal, vertical or 45°, never an arbitrary angle, never a square
 * elbow): from the anchor a straight leg at 0°, 45° or 90°, a 45° chamfer
 * where a vertical leg meets the shelf, then a horizontal shelf under the
 * label. At most one bend before the shelf; a 4 px terminal dot at the
 * anchor; no arrowheads. Screen pixels, y down. Pure.
 */

export type Pt = [number, number];
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** DEFAULT (PB-1184): the chamfer where a vertical leg turns onto the shelf, in CSS px. */
export const CHAMFER = 8;

export type LegKind = "flat" | "diagonal" | "vertical";

export interface Leader {
  kind: LegKind;
  /** Anchor, (bend points), shelf start, shelf end. */
  points: Pt[];
}

/**
 * The leader from `a` (the anchor) to a shelf starting at `s` and running
 * `shelf` px away from the anchor's side (+1 right, -1 left):
 * - `flat`: the anchor is level with the shelf: one straight line;
 * - `diagonal`: a 45° leg covers the height, the shelf the rest (needs |dx| >= |dy|);
 * - `vertical`: a vertical leg, a 45° chamfer of `CHAMFER` px, then the shelf (needs |dx| >= chamfer).
 * Returns undefined when the requested leg cannot reach the shelf with legal angles.
 */
export function routeLeader(a: Pt, s: Pt, shelf: number, kind: LegKind): Leader | undefined {
  const dx = s[0] - a[0];
  const dy = s[1] - a[1];
  const dir = Math.sign(shelf) || 1;
  const end: Pt = [s[0] + shelf, s[1]];
  // the shelf runs away from the anchor: the leg must arrive from the anchor's side
  if (dx * dir < -0.5) return undefined;
  if (kind === "flat") return Math.abs(dy) < 0.5 ? { kind, points: [a, s, end] } : undefined;
  if (kind === "diagonal") {
    if (Math.abs(dx) + 0.5 < Math.abs(dy) || Math.abs(dy) < 0.5) return undefined;
    const bend: Pt = [a[0] + dir * Math.abs(dy), s[1]];
    return { kind, points: [a, bend, ...(Math.abs(bend[0] - s[0]) > 0.5 ? [s] : []), end] };
  }
  const c = Math.min(CHAMFER, Math.abs(dy));
  if (Math.abs(dy) < 0.5 || Math.abs(dx) + 0.5 < c) return undefined;
  const up = Math.sign(dy);
  const p1: Pt = [a[0], s[1] - up * c];
  const p2: Pt = [a[0] + dir * c, s[1]];
  return { kind, points: [a, p1, p2, ...(Math.abs(p2[0] - s[0]) > 0.5 ? [s] : []), end] };
}

/** Every segment's angle is 0°, 45° or 90° (the ruling, checked by the tests). */
export function legalAngles(points: Pt[]): boolean {
  for (let i = 1; i < points.length; i++) {
    const dx = Math.abs(points[i][0] - points[i - 1][0]);
    const dy = Math.abs(points[i][1] - points[i - 1][1]);
    if (dx < 0.01 || dy < 0.01) continue;
    if (Math.abs(dx - dy) > 0.01) return false;
  }
  return true;
}

/** SVG path data for a leader. */
export const leaderPath = (l: Leader): string => l.points.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");

/** Length of a polyline (for the scan-out dash animation). */
export function polylineLength(points: Pt[]): number {
  let n = 0;
  for (let i = 1; i < points.length; i++) n += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return n;
}

/** Whether segment p–q passes through box `b` (inflated by `pad`). */
export function segmentHitsBox(p: Pt, q: Pt, b: Box, pad = 0): boolean {
  const x0 = b.x - pad;
  const y0 = b.y - pad;
  const x1 = b.x + b.w + pad;
  const y1 = b.y + b.h + pad;
  // Liang-Barsky clip
  let t0 = 0;
  let t1 = 1;
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const clip = (pp: number, qq: number) => {
    if (Math.abs(pp) < 1e-9) return qq >= 0;
    const r = qq / pp;
    if (pp < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return clip(-dx, p[0] - x0) && clip(dx, x1 - p[0]) && clip(-dy, p[1] - y0) && clip(dy, y1 - p[1]) && t0 <= t1;
}

/** Whether two segments cross (touching at an end does not count). */
export function segmentsCross(p1: Pt, p2: Pt, q1: Pt, q2: Pt): boolean {
  const d = (a: Pt, b: Pt, c: Pt) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(q1, q2, p1);
  const d2 = d(q1, q2, p2);
  const d3 = d(p1, p2, q1);
  const d4 = d(p1, p2, q2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

export const boxesOverlap = (a: Box, b: Box, gap = 0): boolean => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
