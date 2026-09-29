/**
 * Geometry along a routed link (PB-803): positions by arc length, sub-paths,
 * lanes that fan out of the centre line, and harness regions traced around
 * whatever runs through them. Pure functions, no React.
 */
import { filletPath, offsetPolyline, type Pt } from "./routing";

export const RUN = 24; // length of one fan
const RUN_DEFAULT = RUN;
export const STAGE = 24; // stagger between fan stages (outer lanes first)
const STAGE_DEFAULT = STAGE;
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
export function lane(points: Pt[], o: number, sa: number, sb: number, RUN = RUN_DEFAULT): LaneShape {
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
export function stagedSpans(offs: number[], s0: number, s1: number, STAGE = STAGE_DEFAULT): [number, number][] {
  const mags = [...new Set(offs.map((o) => Math.abs(o)).filter((m) => m > 0))].sort((a, b) => b - a);
  const inner = Math.max(0, mags.length - 1);
  return offs.map((o) => {
    const stage = o === 0 ? inner : mags.indexOf(Math.abs(o));
    return [s0 + stage * STAGE, s1 - stage * STAGE];
  });
}

/** Fillet radius for the centre line of a ribbon `width` wide, so its inner conductor still turns round. */
export const ribbonRadius = (width: number) => Math.max(RADIUS, width / 2 + 6);

/** Stroke points of a ribbon (parallel conductors at a fixed pitch) along the whole route. */
export function ribbon(points: Pt[], n: number, radius = RADIUS): { d: string; samples: Pt[] }[] {
  return offsets(n, RIBBON_PITCH).map((o) => {
    const off = offsetPolyline(points, o, radius);
    return { d: filletPath(off.points, off.radii), samples: densify(off.points) };
  });
}

/**
 * Conductors that run at offsets `tight` outside [s0, s1] and fan to offsets
 * `wide` inside it, all at once over `fan` (ribbon mode, expanded). Both
 * sides are offsets of the same centre line, so every conductor leaves and
 * rejoins exactly where its neighbours do.
 */
export function fanned(points: Pt[], tight: number[], wide: number[], s0: number, s1: number, fan = RUN, radius = RADIUS): LaneShape[] {
  const L = totalLength(points);
  const da = at(points, s0 + fan).d;
  const db = at(points, s1 - fan).d;
  return tight.map((t, i) => {
    const head = offsetPolyline(subpath(points, 0, s0), t, radius);
    const tail = offsetPolyline(subpath(points, s1, L), t, radius);
    const w = offsetPolyline(subpath(points, s0 + fan, s1 - fan), wide[i], radius);
    const a = head.points[head.points.length - 1];
    const b = tail.points[0];
    const first = w.points[0];
    const last = w.points[w.points.length - 1];
    const ad = at(points, s0).d;
    const bd = at(points, s1).d;
    const d =
      `${filletPath(head.points, head.radii)} C${add(a, ad, fan / 2).join(",")} ${add(first, da, -fan / 2).join(",")} ${first[0]},${first[1]}` +
      filletPath(w.points, w.radii).replace(/^M[^L]*/, "") +
      ` C${add(last, db, fan / 2).join(",")} ${add(b, bd, -fan / 2).join(",")} ${b[0]},${b[1]}` +
      filletPath(tail.points, tail.radii).replace(/^M[^L]*/, "");
    return { d, samples: [...densify(head.points), ...densify([a, first]), ...densify(w.points), ...densify([last, b]), ...densify(tail.points)], from: s0 + fan, to: s1 - fan };
  });
}

/**
 * The straight stretches of a route as arc-length intervals, each kept `clear`
 * of the corners at its ends (and `end` of the route's own ends).
 */
export function straights(points: Pt[], clear: number, end = 0): [number, number][] {
  const L = lengths(points);
  const out: [number, number][] = [];
  for (let i = 1; i < points.length; i++) {
    const a = L[i - 1] + (i > 1 ? clear : end);
    const b = L[i] - (i < points.length - 1 ? clear : end);
    if (b >= a) out.push([a, b]);
  }
  return out;
}

/**
 * The nearest arc length to `s` that sits on a straight stretch, clear of the
 * bends (handles and toggles never sit in a corner). Where no stretch is long
 * enough, the middle of the longest segment.
 */
export function clearOfBends(points: Pt[], s: number, clear: number, end = 0): number {
  const iv = straights(points, clear, end);
  if (!iv.length) {
    const L = lengths(points);
    let best = 1;
    for (let i = 2; i < points.length; i++) if (L[i] - L[i - 1] > L[best] - L[best - 1]) best = i;
    return (L[best - 1] + L[best]) / 2;
  }
  let out = s;
  let dist = Infinity;
  for (const [a, b] of iv) {
    const c = Math.max(a, Math.min(b, s));
    if (Math.abs(c - s) < dist) {
      dist = Math.abs(c - s);
      out = c;
    }
  }
  return out;
}

/** The straight stretch (with `clear` at its corners) that contains arc length `s`. */
export function stretchAt(points: Pt[], s: number, clear: number, end = 0): [number, number] {
  const L = lengths(points);
  for (let i = 1; i < points.length; i++) {
    if (s <= L[i] + 0.5 || i === points.length - 1) return [L[i - 1] + (i > 1 ? clear : end), L[i] - (i < points.length - 1 ? clear : end)];
  }
  return [0, L[L.length - 1]];
}

/**
 * Turn short S-jogs (a sidestep between two runs in the same direction,
 * shorter than `min`) into a gentle diagonal: a wide ribbon cannot take two
 * right angles in less than its own width without its conductors crossing.
 */
export function easeJogs(points: Pt[], min: number): Pt[] {
  let pts = points.map((p) => [...p] as Pt);
  for (let guard = 0; guard < 16; guard++) {
    let changed = false;
    for (let i = 1; i < pts.length - 2; i++) {
      const [a, b, c, e] = [pts[i - 1], pts[i], pts[i + 1], pts[i + 2]];
      const j = Math.hypot(c[0] - b[0], c[1] - b[1]);
      const lin = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const lout = Math.hypot(e[0] - c[0], e[1] - c[1]);
      if (j >= min || j < 0.5 || !lin || !lout) continue;
      const din: Pt = [(b[0] - a[0]) / lin, (b[1] - a[1]) / lin];
      const dout: Pt = [(e[0] - c[0]) / lout, (e[1] - c[1]) / lout];
      if (din[0] * dout[0] + din[1] * dout[1] < 0.99) continue; // not an S-jog
      // leave the first and last runs (the port stubs) a little straight
      const k = Math.min(Math.max(min, 2 * j), lin - (i === 1 ? 10 : 2), lout - (i + 2 === pts.length - 1 ? 10 : 2));
      if (k < j / 2) continue;
      pts = [...pts.slice(0, i), add(b, din, -k), add(c, dout, k), ...pts.slice(i + 2)];
      changed = true;
      break;
    }
    if (!changed) break;
  }
  return pts;
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
