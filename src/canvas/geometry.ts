/**
 * Geometry along a routed link (PB-803): positions by arc length, sub-paths,
 * lanes that fan out of the centre line, and harness regions traced around
 * whatever runs through them. Pure functions, no React.
 */
import { filletPath, offsetPolyline, type Pt } from "./routing";

export const RUN = 24; // length of one fan
export const STAGE = 24; // stagger between fan stages (outer lanes first)
export const LANE_PITCH = 16;
export const RIBBON_PITCH = 6;
const RADIUS = 12;

export function lengths(points: Pt[]): number[] {
  const out = [0];
  for (let i = 1; i < points.length; i++) out.push(out[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  return out;
}

export const totalLength = (points: Pt[]) => lengths(points).at(-1) ?? 0;

/** Point and unit direction at arc length `s`. */
export function at(points: Pt[], s: number): { p: Pt; d: Pt } {
  const L = lengths(points);
  const t = Math.max(0, Math.min(L[L.length - 1], s));
  for (let i = 1; i < points.length; i++) {
    if (L[i] >= t || i === points.length - 1) {
      const seg = L[i] - L[i - 1] || 1;
      const f = (t - L[i - 1]) / seg;
      const [a, b] = [points[i - 1], points[i]];
      return { p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], d: [(b[0] - a[0]) / seg, (b[1] - a[1]) / seg] };
    }
  }
  return { p: points[0], d: [1, 0] };
}

/** The polyline between arc lengths s0 and s1. */
export function subpath(points: Pt[], s0: number, s1: number): Pt[] {
  const L = lengths(points);
  const out: Pt[] = [at(points, s0).p];
  for (let i = 1; i < points.length - 1; i++) if (L[i] > s0 && L[i] < s1) out.push(points[i]);
  out.push(at(points, s1).p);
  return out;
}

/** Arc length of the point on the polyline nearest to `q`. */
export function project(points: Pt[], q: Pt): number {
  const L = lengths(points);
  let best = { d: Infinity, s: 0 };
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    const len2 = vx * vx + vy * vy || 1;
    const f = Math.max(0, Math.min(1, ((q[0] - a[0]) * vx + (q[1] - a[1]) * vy) / len2));
    const px = a[0] + vx * f;
    const py = a[1] + vy * f;
    const d = Math.hypot(q[0] - px, q[1] - py);
    if (d < best.d) best = { d, s: L[i - 1] + f * Math.sqrt(len2) };
  }
  return best.s;
}

export interface LaneShape {
  d: string;
  /** Dense points (for regions and hit tests). */
  samples: Pt[];
  /** Where the lane runs at its full offset (for names). */
  from: number;
  to: number;
}

const add = (a: Pt, b: Pt, k = 1): Pt => [a[0] + b[0] * k, a[1] + b[1] * k];
const normal = (d: Pt): Pt => [d[1], -d[0]]; // left of travel, as offsetPolyline

/**
 * A lane that leaves the centre line at arc length `sa`, runs offset by `o`,
 * and rejoins it at `sb`. Offset 0 is the centre line itself.
 */
export function lane(points: Pt[], o: number, sa: number, sb: number): LaneShape {
  if (o === 0 || sb - sa < 2 * RUN + 2) {
    const sub = subpath(points, sa, sb);
    return { d: filletPath(sub, RADIUS), samples: densify(sub), from: sa, to: sb };
  }
  const mid = subpath(points, sa + RUN, sb - RUN);
  const off = offsetPolyline(mid, o, RADIUS);
  const a = at(points, sa);
  const b = at(points, sb);
  const first = off.points[0];
  const last = off.points[off.points.length - 1];
  const da = at(points, sa + RUN).d;
  const db = at(points, sb - RUN).d;
  const body = filletPath(off.points, off.radii).replace(/^M[^L]*/, "");
  const d =
    `M${a.p[0]},${a.p[1]} C${add(a.p, a.d, RUN / 2).join(",")} ${add(first, da, -RUN / 2).join(",")} ${first[0]},${first[1]}` +
    ` L${first[0]},${first[1]}${body}` +
    ` C${add(last, db, RUN / 2).join(",")} ${add(b.p, b.d, -RUN / 2).join(",")} ${b.p[0]},${b.p[1]}`;
  const samples = [...densify([a.p, first]), ...densify(off.points), ...densify([last, b.p])];
  return { d, samples, from: sa + RUN, to: sb - RUN };
}

export function densify(points: Pt[], step = 3): Pt[] {
  const out: Pt[] = [];
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  if (points.length) out.push(points[points.length - 1]);
  return out;
}

/** Offsets for n lanes centred on the line. */
export const offsets = (n: number, pitch: number) => Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * pitch);

/**
 * Staged fans (basic mode): outer lanes leave first and rejoin last. Returns
 * [start, end] arc lengths per lane between `s0` and `s1`.
 */
export function stagedSpans(offs: number[], s0: number, s1: number): [number, number][] {
  const mags = [...new Set(offs.map((o) => Math.abs(o)).filter((m) => m > 0))].sort((a, b) => b - a);
  const inner = Math.max(0, mags.length - 1);
  return offs.map((o) => {
    const stage = o === 0 ? inner : mags.indexOf(Math.abs(o));
    return [s0 + stage * STAGE, s1 - stage * STAGE];
  });
}

/** Stroke points of a ribbon (parallel conductors at a fixed pitch) along the whole route. */
export function ribbon(points: Pt[], n: number): { d: string; samples: Pt[] }[] {
  return offsets(n, RIBBON_PITCH).map((o) => {
    const off = offsetPolyline(points, o, RADIUS);
    return { d: filletPath(off.points, off.radii), samples: densify(off.points) };
  });
}

/**
 * A ribbon that stays tight outside [s0, s1] and fans out to lanes inside
 * it (detailed mode, expanded): every conductor fans at once.
 */
export function ribbonExpanded(points: Pt[], n: number, s0: number, s1: number): LaneShape[] {
  const tight = offsets(n, RIBBON_PITCH);
  const wide = offsets(n, LANE_PITCH);
  return tight.map((t, i) => {
    const whole = offsetPolyline(points, t, RADIUS).points;
    const head = subpath(whole, 0, s0);
    const tail = subpath(whole, s1, totalLength(whole));
    const mid = subpath(points, s0 + RUN, s1 - RUN);
    const w = offsetPolyline(mid, wide[i], RADIUS);
    const first = w.points[0];
    const last = w.points[w.points.length - 1];
    const a = at(whole, s0);
    const b = at(whole, s1);
    const d =
      `${filletPath(head, RADIUS)} C${add(a.p, a.d, RUN / 2).join(",")} ${add(first, at(points, s0 + RUN).d, -RUN / 2).join(",")} ${first[0]},${first[1]}` +
      filletPath(w.points, w.radii).replace(/^M[^L]*/, "") +
      ` C${add(last, at(points, s1 - RUN).d, RUN / 2).join(",")} ${add(b.p, b.d, -RUN / 2).join(",")} ${b.p[0]},${b.p[1]}` +
      filletPath(tail, RADIUS).replace(/^M[^L]*/, "");
    return { d, samples: [...densify(head), ...densify(w.points), ...densify(tail)], from: s0 + RUN, to: s1 - RUN };
  });
}

/**
 * A closed outline around every sample (dilated by `pad`), traced on a 2 px
 * raster and smoothed: the harness region, tight to what runs through it.
 */
export function regionOutline(samples: Pt[], pad: number): string {
  if (!samples.length) return "";
  const C = 2;
  const xs = samples.map((p) => p[0]);
  const ys = samples.map((p) => p[1]);
  const x0 = Math.min(...xs) - pad - 4;
  const y0 = Math.min(...ys) - pad - 4;
  const W = Math.ceil((Math.max(...xs) + pad + 4 - x0) / C);
  const H = Math.ceil((Math.max(...ys) + pad + 4 - y0) / C);
  const grid = new Uint8Array(W * H);
  const r = Math.ceil(pad / C);
  const disc: [number, number][] = [];
  for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) if (dx * dx + dy * dy <= r * r) disc.push([dx, dy]);
  for (const [x, y] of samples) {
    const cx = Math.round((x - x0) / C);
    const cy = Math.round((y - y0) / C);
    for (const [dx, dy] of disc) {
      const X = cx + dx;
      const Y = cy + dy;
      if (X >= 0 && Y >= 0 && X < W && Y < H) grid[Y * W + X] = 1;
    }
  }
  let start = -1;
  for (let i = 0; i < grid.length && start < 0; i++) if (grid[i]) start = i;
  if (start < 0) return "";
  const nb: [number, number][] = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]];
  const filled = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && grid[y * W + x] === 1;
  let cur: [number, number] = [start % W, Math.floor(start / W)];
  const first = cur;
  let back = 0;
  const contour: Pt[] = [cur];
  for (let guard = 0; guard < W * H * 4; guard++) {
    let moved = false;
    for (let k = 0; k < 8; k++) {
      const d = (back + 1 + k) % 8;
      const nx = cur[0] + nb[d][0];
      const ny = cur[1] + nb[d][1];
      if (filled(nx, ny)) {
        back = (d + 4) % 8;
        cur = [nx, ny];
        moved = true;
        break;
      }
    }
    if (!moved || (cur[0] === first[0] && cur[1] === first[1] && contour.length > 2)) break;
    contour.push(cur);
  }
  let poly: Pt[] = contour.filter((_, i) => i % 2 === 0).map(([x, y]) => [x0 + (x + 0.5) * C, y0 + (y + 0.5) * C]);
  for (let it = 0; it < 3; it++) {
    const next: Pt[] = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      next.push([0.75 * p[0] + 0.25 * q[0], 0.75 * p[1] + 0.25 * q[1]], [0.25 * p[0] + 0.75 * q[0], 0.25 * p[1] + 0.75 * q[1]]);
    }
    poly = next;
  }
  return "M" + poly.filter((_, i) => i % 2 === 0).map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("L") + "Z";
}
