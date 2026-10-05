/**
 * Exploded view by assembly order (PB-899). Parts that go together along the
 * model's up direction come apart along it in the order they are stacked:
 * the part at the bottom of a column stays, and each part above it rises
 * until it clears everything it sits on, plus a gap. Two parts interact only
 * where one lies over the other (their outlines, seen along the axis,
 * overlap), so four motors on four arms each lift off their own arm, not
 * off each other.
 *
 * The order is geometric, never the lowest coordinate alone (a cap whose
 * skirt reaches below the bottle's lip still comes after the bottle):
 *
 * - a part held inside another (the other surrounds it on every side across
 *   the axis: a cell in a case) comes out through the side the holder leaves
 *   open: up when less of the holder is above it than below, down the other
 *   way (a seal seated under a cap's ceiling), up when the holder closes
 *   round it (parts go in before the lid), and clears the holder entirely;
 * - otherwise the lower part, by its middle, comes first, and the upper one
 *   only has to clear the surface right under it.
 *
 * Pure: the scene samples each part's surfaces into height grids (raycasts in
 * CadView) and this module orders and spaces them.
 */

/**
 * A part's top and bottom surfaces over its outline, sampled on a grid in the
 * plane across the axis: `top[i]` is the highest point of the part above
 * cell i, `bottom[i]` the lowest (NaN where the part has nothing there).
 */
export interface HeightGrid {
  /** Lower corner (u, v) of the grid and the cell size along u and v. */
  u0: number;
  v0: number;
  du: number;
  dv: number;
  /** Cells along u and v. */
  nu: number;
  nv: number;
  top: Float64Array;
  bottom: Float64Array;
}

export interface StackPart {
  key: string;
  /** Extent along the axis (assembled). */
  lo: number;
  hi: number;
  /** Middle along the axis. */
  mid: number;
  /** Outline across the axis: [uMin, uMax, vMin, vMax]. */
  outline: [number, number, number, number];
  grid: HeightGrid;
}

export interface StackOptions {
  /** Space left between parts once apart (mm). */
  gap: number;
  /** Whether `holder` surrounds `part` across the axis (rays from the part's middle hit it on every side). */
  surrounds?: (holder: StackPart, part: StackPart) => boolean;
  /** Which way `part` leaves `holder` (default: `exitOf`, from the height grids). */
  exit?: (holder: StackPart, part: StackPart) => "up" | "down" | undefined;
}

/** The grid cell holding (u, v), or -1 outside. */
export function cellAt(g: HeightGrid, u: number, v: number): number {
  const i = Math.floor((u - g.u0) / g.du);
  const j = Math.floor((v - g.v0) / g.dv);
  if (i < 0 || j < 0 || i >= g.nu || j >= g.nv) return -1;
  return j * g.nu + i;
}

/** Centre of cell k. */
export const cellCentre = (g: HeightGrid, k: number): [number, number] => [g.u0 + ((k % g.nu) + 0.5) * g.du, g.v0 + (Math.floor(k / g.nu) + 0.5) * g.dv];

/** A grid for a part made of axis-aligned boxes (tests, and parts without a mesh to sample). */
export function boxGrid(outline: [number, number, number, number], boxes: { u: [number, number]; v: [number, number]; z: [number, number] }[], n = 12): HeightGrid {
  const [u0, u1, v0, v1] = outline;
  const du = Math.max(1e-6, (u1 - u0) / n);
  const dv = Math.max(1e-6, (v1 - v0) / n);
  const top = new Float64Array(n * n).fill(NaN);
  const bottom = new Float64Array(n * n).fill(NaN);
  const g: HeightGrid = { u0, v0, du, dv, nu: n, nv: n, top, bottom };
  for (let k = 0; k < n * n; k++) {
    const [u, v] = cellCentre(g, k);
    for (const b of boxes) {
      if (u < b.u[0] || u > b.u[1] || v < b.v[0] || v > b.v[1]) continue;
      top[k] = Number.isNaN(top[k]) ? b.z[1] : Math.max(top[k], b.z[1]);
      bottom[k] = Number.isNaN(bottom[k]) ? b.z[0] : Math.min(bottom[k], b.z[0]);
    }
  }
  return g;
}

/** The two outlines overlap (with a small tolerance). */
const overlaps = (a: StackPart, b: StackPart, eps = 1e-3) =>
  a.outline[0] < b.outline[1] - eps && b.outline[0] < a.outline[1] - eps && a.outline[2] < b.outline[3] - eps && b.outline[2] < a.outline[3] - eps;

const inOutline = (o: [number, number, number, number], u: number, v: number) => u >= o[0] && u <= o[1] && v >= o[2] && v <= o[3];

/**
 * How far `upper` must rise to clear `lower` where they lie over each other:
 * from the lowest point of `upper` over `lower`'s outline to the highest
 * point of `lower` under `upper`'s outline (a cap's skirt clears the bottle's
 * lip it reaches around; a motor clears only the arm's top under it).
 * Undefined when neither lies over the other.
 */
export function clearance(lower: StackPart, upper: StackPart): number | undefined {
  let top = -Infinity;
  const lg = lower.grid;
  for (let k = 0; k < lg.nu * lg.nv; k++) {
    if (Number.isNaN(lg.top[k])) continue;
    const [u, v] = cellCentre(lg, k);
    if (inOutline(upper.outline, u, v)) top = Math.max(top, lg.top[k]);
  }
  let bottom = Infinity;
  const ug = upper.grid;
  for (let k = 0; k < ug.nu * ug.nv; k++) {
    if (Number.isNaN(ug.bottom[k])) continue;
    const [u, v] = cellCentre(ug, k);
    if (inOutline(lower.outline, u, v)) bottom = Math.min(bottom, ug.bottom[k]);
  }
  return Number.isFinite(top) && Number.isFinite(bottom) ? top - bottom : undefined;
}

/**
 * Which way a part held by `holder` comes out: `up` when the holder has
 * material above the part at fewer points than below it, `down` the other
 * way. When that ties, the side the part sticks out of the holder further (a
 * probe through a cap's floor hangs below it); undefined when nothing
 * decides.
 */
export function exitOf(holder: StackPart, part: StackPart, eps = 0.05): "up" | "down" | undefined {
  const lines: ExitLine[] = [];
  const g = part.grid;
  for (let k = 0; k < g.nu * g.nv; k++) {
    if (Number.isNaN(g.top[k])) continue;
    const [u, v] = cellCentre(g, k);
    const c = cellAt(holder.grid, u, v);
    if (c < 0 || Number.isNaN(holder.grid.top[c])) continue;
    lines.push({ partTop: g.top[k], partBottom: g.bottom[k], above: holder.grid.top[c] > g.top[k] + eps, below: holder.grid.bottom[c] < g.bottom[k] - eps, holderTop: holder.grid.top[c], holderBottom: holder.grid.bottom[c] });
  }
  return exitFrom(lines, eps);
}

/** What a holder has along one line through a part, parallel to the axis. */
export interface ExitLine {
  partTop: number;
  partBottom: number;
  /** The holder has material above the part's top, below its bottom. */
  above: boolean;
  below: boolean;
  /** The holder's highest and lowest points on the line. */
  holderTop: number;
  holderBottom: number;
}

/** The exit decided from lines through the part (see `exitOf`). */
export function exitFrom(lines: readonly ExitLine[], eps = 0.05): "up" | "down" | undefined {
  const above = lines.filter((l) => l.above).length;
  const below = lines.filter((l) => l.below).length;
  if (above < below) return "up";
  if (below < above) return "down";
  const outUp = Math.max(-Infinity, ...lines.map((l) => l.partTop - l.holderTop));
  const outDown = Math.max(-Infinity, ...lines.map((l) => l.holderBottom - l.partBottom));
  if (Math.max(outUp, outDown) > eps && Math.abs(outUp - outDown) > eps) return outUp > outDown ? "up" : "down";
  return undefined;
}

/**
 * Whether `p` is the lower of the two where they lie over each other,
 * comparing the middles of their material there (a frame's tall centre stack
 * does not put it above a motor on the arm's tip); undefined when they never
 * lie over each other.
 */
export function lowerWhereTheyMeet(p: StackPart, q: StackPart): boolean | undefined {
  let sum = 0;
  let count = 0;
  const g = p.grid;
  for (let k = 0; k < g.nu * g.nv; k++) {
    if (Number.isNaN(g.top[k])) continue;
    const [u, v] = cellCentre(g, k);
    const c = cellAt(q.grid, u, v);
    if (c < 0 || Number.isNaN(q.grid.top[c])) continue;
    sum += (q.grid.top[c] + q.grid.bottom[c]) / 2 - (g.top[k] + g.bottom[k]) / 2;
    count++;
  }
  if (!count) return undefined;
  return sum > 0 || (sum === 0 && (p.mid < q.mid || (p.mid === q.mid && p.lo <= q.lo)));
}

/** `part`'s middle lies within `holder`'s extent (along the axis and across it). */
const within = (holder: StackPart, part: StackPart) => {
  const [cu, cv] = [(part.outline[0] + part.outline[1]) / 2, (part.outline[2] + part.outline[3]) / 2];
  return part.mid >= holder.lo && part.mid <= holder.hi && cu >= holder.outline[0] && cu <= holder.outline[1] && cv >= holder.outline[2] && cv <= holder.outline[3];
};

interface Relation {
  /** The lower part comes first. */
  lower: number;
  upper: number;
  /** How far the upper must rise above the lower's own rise. */
  need: number;
}

/**
 * Each part's rise along the axis when fully exploded (mm), by key. Parts
 * that lie over nothing stay where they are.
 */
export function planStack(parts: readonly StackPart[], options: StackOptions): Map<string, number> {
  const { gap } = options;
  const relations: Relation[] = [];
  for (let a = 0; a < parts.length; a++) {
    for (let b = a + 1; b < parts.length; b++) {
      const p = parts[a];
      const q = parts[b];
      if (!overlaps(p, q)) continue;
      // held inside: out through the open side, clear of the whole holder
      const held = (holder: StackPart, part: StackPart, hi: number, pi: number): Relation | undefined => {
        if (!within(holder, part) || !(options.surrounds?.(holder, part) ?? false)) return undefined;
        // a closed holder (a case drawn with its lid on): parts go in from above, before it is closed
        const exit = (options.exit ?? exitOf)(holder, part) ?? "up";
        return exit === "up" ? { lower: hi, upper: pi, need: holder.hi - part.lo } : { lower: pi, upper: hi, need: part.hi - holder.lo };
      };
      const nested = held(p, q, a, b) ?? held(q, p, b, a);
      if (nested) {
        relations.push(nested);
        continue;
      }
      // one over the other where they meet: the lower there first; the upper clears the surface under it
      const below = lowerWhereTheyMeet(p, q);
      if (below === undefined) continue;
      const [lo, up] = below ? [a, b] : [b, a];
      const need = clearance(parts[lo], parts[up]);
      if (need !== undefined) relations.push({ lower: lo, upper: up, need });
    }
  }

  // the stacking order: every lower part before the parts over it (ties and cycles by middle)
  const n = parts.length;
  const indegree = new Array(n).fill(0);
  const after = parts.map(() => [] as Relation[]);
  for (const r of relations) {
    after[r.lower].push(r);
    indegree[r.upper]++;
  }
  const byMid = (x: number, y: number) => parts[x].mid - parts[y].mid || parts[x].key.localeCompare(parts[y].key);
  const order: number[] = [];
  const placed = new Array(n).fill(false);
  while (order.length < n) {
    const ready = parts.map((_, i) => i).filter((i) => !placed[i] && indegree[i] === 0);
    // a cycle: release the lowest part still waiting
    const next = (ready.length ? ready : parts.map((_, i) => i).filter((i) => !placed[i])).sort(byMid)[0];
    placed[next] = true;
    order.push(next);
    for (const r of after[next]) indegree[r.upper]--;
  }

  const rank = new Array(n);
  order.forEach((i, k) => (rank[i] = k));
  const rise = new Array(n).fill(0);
  for (const i of order) {
    for (const r of relations) {
      if (r.upper !== i || rank[r.lower] > rank[i]) continue;
      rise[i] = Math.max(rise[i], rise[r.lower] + r.need + gap);
    }
  }
  return new Map(parts.map((p, i) => [p.key, rise[i]]));
}
