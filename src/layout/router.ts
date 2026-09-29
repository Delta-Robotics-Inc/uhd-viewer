/**
 * Grid router (PB-803, design D12): orthogonal routes on the 16 px grid.
 *
 * A* over grid cells with a direction in the state. It avoids module cards,
 * penalises bends and crossings, and keeps parallel runs one grid step apart
 * by charging for cells another route already runs along. Pinned waypoints
 * (dragged by the user, saved in the display file) are visited in order; the
 * bends it chooses itself are the automatic waypoints.
 */
import type { Pt, Side } from "../canvas/routing";
import { simplify } from "../canvas/routing";

export const GRID = 16;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const DIRS: Pt[] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const SIDE_DIR: Record<Side, number> = { right: 0, bottom: 1, left: 2, top: 3 };

const COST = { step: 1, bend: 4, parallel: 12, cross: 3 };

export const snap = (v: number) => Math.round(v / GRID) * GRID;

class Heap {
  private a: { k: number; v: number }[] = [];
  push(k: number, v: number) {
    const a = this.a;
    a.push({ k, v });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].k <= a[i].k) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): number | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0].v;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].k < a[m].k) m = l;
        if (r < a.length && a[r].k < a[m].k) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  get size() {
    return this.a.length;
  }
}

export class GridRouter {
  private x0: number;
  private y0: number;
  private W: number;
  private H: number;
  private blocked: Uint8Array;
  /** Cells used by earlier routes: bit 1 horizontal run, bit 2 vertical run. */
  private used: Uint8Array;
  /** Search state, allocated once and reused: a state is valid when its stamp is the current search's. */
  private g: Float64Array;
  private prev: Int32Array;
  private stamp: Uint32Array;
  private gen = 0;

  constructor(obstacles: Rect[], extra: Pt[] = [], margin = 12) {
    const xs = [...obstacles.flatMap((b) => [b.x, b.x + b.w]), ...extra.map((p) => p[0])];
    const ys = [...obstacles.flatMap((b) => [b.y, b.y + b.h]), ...extra.map((p) => p[1])];
    this.x0 = Math.floor(Math.min(...xs) / GRID) - margin;
    this.y0 = Math.floor(Math.min(...ys) / GRID) - margin;
    this.W = Math.ceil(Math.max(...xs) / GRID) + margin - this.x0 + 1;
    this.H = Math.ceil(Math.max(...ys) / GRID) + margin - this.y0 + 1;
    this.blocked = new Uint8Array(this.W * this.H);
    this.used = new Uint8Array(this.W * this.H);
    this.g = new Float64Array(this.W * this.H * 4);
    this.prev = new Int32Array(this.W * this.H * 4);
    this.stamp = new Uint32Array(this.W * this.H * 4);
    for (const b of obstacles) {
      // a cell is blocked when its point lies inside the card (edges included, so routes keep off outlines)
      for (let gx = Math.ceil(b.x / GRID); gx <= Math.floor((b.x + b.w) / GRID); gx++) {
        for (let gy = Math.ceil(b.y / GRID); gy <= Math.floor((b.y + b.h) / GRID); gy++) {
          const i = this.idx(gx, gy);
          if (i >= 0) this.blocked[i] = 1;
        }
      }
    }
  }

  private idx(gx: number, gy: number): number {
    const x = gx - this.x0;
    const y = gy - this.y0;
    return x < 0 || y < 0 || x >= this.W || y >= this.H ? -1 : y * this.W + x;
  }

  /**
   * Route from a port (on `fromSide` of its card) to another port, through
   * `pins` in order. Returns the polyline in canvas coordinates.
   */
  route(from: Pt, fromSide: Side, to: Pt, toSide: Side, pins: Pt[] = []): Pt[] {
    const d0 = SIDE_DIR[fromSide];
    const dEnd = SIDE_DIR[toSide];
    const s: Pt = [snap(from[0]) / GRID + DIRS[d0][0], snap(from[1]) / GRID + DIRS[d0][1]];
    const t: Pt = [snap(to[0]) / GRID + DIRS[dEnd][0], snap(to[1]) / GRID + DIRS[dEnd][1]];
    const stops: Pt[] = [...pins.map((p) => [snap(p[0]) / GRID, snap(p[1]) / GRID] as Pt), t];
    let cells: Pt[] = [s];
    let dir = d0;
    for (let k = 0; k < stops.length; k++) {
      const last = k === stops.length - 1;
      // arrive at the end cell heading into the target port
      const arrive = last ? (dEnd + 2) % 4 : -1;
      const leg = this.search(cells[cells.length - 1], dir, stops[k], arrive);
      if (!leg) {
        cells.push(stops[k]);
        continue;
      }
      cells = cells.concat(leg.cells.slice(1));
      dir = leg.dir;
    }
    this.mark(cells);
    const pts: Pt[] = [from, ...cells.map(([gx, gy]) => [gx * GRID, gy * GRID] as Pt), to];
    return orthogonal(simplify(pts));
  }

  private search(start: Pt, startDir: number, goal: Pt, arriveDir: number): { cells: Pt[]; dir: number } | undefined {
    const { g, prev, stamp } = this;
    const gen = ++this.gen;
    const cost = (st: number) => (stamp[st] === gen ? g[st] : Infinity);
    const si = this.idx(start[0], start[1]);
    const gi = this.idx(goal[0], goal[1]);
    if (si < 0 || gi < 0) return undefined;
    const heap = new Heap();
    const h = (i: number) => Math.abs((i % this.W) - (gi % this.W)) + Math.abs(Math.floor(i / this.W) - Math.floor(gi / this.W));
    const s0 = si * 4 + startDir;
    g[s0] = 0;
    prev[s0] = -1;
    stamp[s0] = gen;
    heap.push(h(si), s0);
    let found = -1;
    let expanded = 0;
    // a search that has to wander this far is blocked (e.g. mid-drag, a card over a port): give up and jog
    const limit = 6000 + 80 * (Math.abs(start[0] - goal[0]) + Math.abs(start[1] - goal[1]));
    while (heap.size && expanded < limit) {
      const st = heap.pop()!;
      expanded++;
      const cell = st >> 2;
      const dir = st & 3;
      if (cell === gi && (arriveDir < 0 || dir === arriveDir)) {
        found = st;
        break;
      }
      const cx = cell % this.W;
      const cy = Math.floor(cell / this.W);
      for (let nd = 0; nd < 4; nd++) {
        if (nd === (dir + 2) % 4) continue;
        const nx = cx + DIRS[nd][0];
        const ny = cy + DIRS[nd][1];
        if (nx < 0 || ny < 0 || nx >= this.W || ny >= this.H) continue;
        const ni = ny * this.W + nx;
        if (this.blocked[ni] && ni !== gi) continue;
        const horizontal = nd % 2 === 0;
        const u = this.used[ni];
        let c = COST.step + (nd !== dir ? COST.bend : 0);
        if (u) c += (horizontal ? u & 1 : u & 2) ? COST.parallel : COST.cross;
        const ns = ni * 4 + nd;
        const ng = g[st] + c;
        if (ng < cost(ns)) {
          g[ns] = ng;
          prev[ns] = st;
          stamp[ns] = gen;
          heap.push(ng + h(ni), ns);
        }
      }
    }
    if (found < 0) return undefined;
    const cells: Pt[] = [];
    for (let st = found; st >= 0; st = prev[st]) {
      const cell = st >> 2;
      cells.push([(cell % this.W) + this.x0, Math.floor(cell / this.W) + this.y0]);
    }
    cells.reverse();
    return { cells, dir: found & 3 };
  }

  /** Treat an existing route (canvas coordinates, axis-aligned) as occupied, as if it had just been routed. */
  occupy(points: Pt[]) {
    const cells = points.map(([x, y]) => [Math.round(x / GRID), Math.round(y / GRID)] as Pt);
    this.mark(cells.filter((c, i) => i === 0 || c[0] !== cells[i - 1][0] || c[1] !== cells[i - 1][1]));
  }

  private mark(cells: Pt[]) {
    for (let i = 1; i < cells.length; i++) {
      const [a, b] = [cells[i - 1], cells[i]];
      const horizontal = a[1] === b[1];
      const n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      for (let k = 0; k <= n; k++) {
        const x = a[0] + Math.sign(b[0] - a[0]) * k;
        const y = a[1] + Math.sign(b[1] - a[1]) * k;
        const idx = this.idx(x, y);
        if (idx >= 0) this.used[idx] |= horizontal ? 1 : 2;
      }
    }
  }
}

/** Make every segment axis-aligned (ports that sit off the grid get a short jog). */
function orthogonal(points: Pt[]): Pt[] {
  const out: Pt[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const [px, py] = out[out.length - 1];
    const [x, y] = points[i];
    if (Math.abs(px - x) > 0.5 && Math.abs(py - y) > 0.5) out.push([px, y]);
    out.push([x, y]);
  }
  return simplify(out);
}
