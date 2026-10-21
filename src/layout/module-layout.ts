/**
 * Module-level layout (PB-1007): the default for a level of modules (no
 * nets), which used to be one long row. The cards go in a grid shaped like
 * a screen, each next to what it connects to:
 *
 * - the grid has about as many columns as a 16:10 screen holds for the
 *   level's cards, so no level is a strip;
 * - the hub (the card with the most links: a flight controller, a processor)
 *   starts in the middle, and the others are added in order of how strongly
 *   they join what is placed, each at the free cell that suits it best;
 * - then cards swap cells while that lowers the cost: link length, links that
 *   bend (neither in a row nor a column), lines crossing, lines that a card
 *   sits in the way of, and, mildly, the reading order of a block diagram
 *   (connectors and power left of the processor, what it drives right of it);
 * - empty rows and columns go, and each column is as wide, and each row as
 *   tall, as its largest card, with room between them for the lines and
 *   their labels.
 *
 * Same input, same output: every choice breaks ties by id.
 *
 * `fixed` cards keep their places (top-left, as saved); a `seed` (each card's
 * centre in an earlier layout) starts the grid from that arrangement instead
 * (a tidy keeps what the person laid out where it can).
 */
import { freeSpot, functionGroup, hits } from "./board-layout";
import { GRID } from "./router";

export interface GridNode {
  id: string;
  w: number;
  h: number;
  category?: string;
}

export interface GridOptions {
  /** Cards that stay where they are: top-left positions. */
  fixed?: Record<string, { x: number; y: number }>;
  /** Where each card's centre was: the starting arrangement. */
  seed?: Record<string, { x: number; y: number }>;
  /** Width over height to aim for (default 1.6). */
  aspect?: number;
}

/** Room between columns (lines and their labels run there) and between rows. */
export const GRID_GAP_X = 192;
export const GRID_GAP_Y = 128;

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
const snapUp = (v: number) => Math.ceil(v / GRID) * GRID;
const snapTo = (v: number) => Math.round(v / GRID) * GRID;

/** Reading order of a block diagram: what feeds the processor left of it (−1), what it drives right (+1). */
function flowSide(category?: string): number {
  const g = functionGroup(category);
  return g === "power" || g === "io" ? -1 : g === "sensor" || g === "output" ? 1 : 0;
}

interface Edge {
  a: number;
  b: number;
  w: number;
}

/**
 * Top-left positions by id for a level of modules. `edges` are the lines
 * between cards (one entry per line; several between two cards weigh more,
 * though less than that many).
 */
export function gridLayout(nodes: GridNode[], edges: [string, string][], opts: GridOptions = {}): Record<string, { x: number; y: number }> {
  // cards linked to nothing (a consumable, an adhesive pad, a seal) go in rows under the block, out of the lines' way
  const linked = new Set(edges.filter(([a, b]) => a !== b).flat());
  const loose = nodes.filter((n) => !linked.has(n.id) && !opts.fixed?.[n.id]).sort((a, b) => natural(a.id, b.id));
  if (!loose.length || loose.length === nodes.length) return gridCore(nodes, edges, opts);
  const out = gridCore(
    nodes.filter((n) => !loose.includes(n)),
    edges,
    opts,
  );
  const placed = nodes.filter((n) => out[n.id]).map((n) => ({ ...out[n.id], w: n.w, h: n.h }));
  const left = Math.min(...placed.map((b) => b.x));
  const right = Math.max(...placed.map((b) => b.x + b.w));
  let y = snapUp(Math.max(...placed.map((b) => b.y + b.h)) + GRID_GAP_Y);
  // as many to a row as fit under the block (three at least)
  const gap = GRID_GAP_X / 2;
  const rows: GridNode[][] = [];
  let row: GridNode[] = [];
  let width = 0;
  for (const n of loose) {
    if (row.length >= 3 && width + gap + n.w > right - left) {
      rows.push(row);
      row = [];
      width = 0;
    }
    width += (row.length ? gap : 0) + n.w;
    row.push(n);
  }
  if (row.length) rows.push(row);
  for (const r of rows) {
    const w = r.reduce((s, n) => s + n.w, 0) + gap * (r.length - 1);
    let x = snapTo(left + (right - left - w) / 2);
    for (const n of r) {
      out[n.id] = { x, y };
      x = snapUp(x + n.w + gap);
    }
    y = snapUp(y + Math.max(...r.map((n) => n.h)) + GRID_GAP_Y / 2);
  }
  return out;
}

function gridCore(nodes: GridNode[], edges: [string, string][], opts: GridOptions = {}): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  if (!nodes.length) return out;
  const list = nodes.slice().sort((a, b) => natural(a.id, b.id));
  const index = new Map(list.map((n, i) => [n.id, i]));
  const n = list.length;
  const fixed = opts.fixed ?? {};

  // links between two cards, weighted 1 + ln(count)
  const pairCount = new Map<string, number>();
  for (const [a, b] of edges) {
    const i = index.get(a);
    const j = index.get(b);
    if (i === undefined || j === undefined || i === j) continue;
    const key = i < j ? `${i},${j}` : `${j},${i}`;
    pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
  }
  const E: Edge[] = [...pairCount]
    .sort((x, y) => natural(x[0], y[0]))
    .map(([k, c]) => {
      const [a, b] = k.split(",").map(Number);
      return { a, b, w: 1 + Math.log(c) };
    });
  const incident: number[][] = list.map(() => []);
  E.forEach((e, k) => {
    incident[e.a].push(k);
    incident[e.b].push(k);
  });
  const degree = list.map((_, i) => incident[i].reduce((s, k) => s + E[k].w, 0));

  // the grid: about as many columns as a screen's shape holds for these cards
  const avgW = list.reduce((s, x) => s + x.w, 0) / n + GRID_GAP_X;
  const avgH = list.reduce((s, x) => s + x.h, 0) / n + GRID_GAP_Y;
  const aspect = opts.aspect ?? 1.6;
  let cols = Math.max(1, Math.min(n, Math.round(Math.sqrt((n * aspect * avgH) / avgW))));
  // two or three cards sit side by side
  if (n <= 3) cols = n;
  let rows = Math.ceil(n / cols);
  // a little room to move: one spare cell at least, beyond a handful of cards
  if (n > 4 && cols * rows === n) cols++;
  rows = Math.ceil(n / cols);
  const cells = cols * rows;
  const cW = avgW;
  const cH = avgH;

  const cellOf = new Int32Array(n).fill(-1);
  const at = new Int32Array(cells).fill(-1);
  const put = (i: number, c: number) => {
    cellOf[i] = c;
    at[c] = i;
  };
  const cx = (c: number) => c % cols;
  const cy = (c: number) => Math.floor(c / cols);

  // ---- cost ----
  const mcu = list.map((x) => functionGroup(x.category) === "mcu");
  const side = list.map((x) => flowSide(x.category));
  const edgeCost = (e: Edge): number => {
    const ca = cellOf[e.a];
    const cb = cellOf[e.b];
    if (ca < 0 || cb < 0) return 0;
    const dx = Math.abs(cx(ca) - cx(cb));
    const dy = Math.abs(cy(ca) - cy(cb));
    let c = e.w * (dx * cW + dy * cH);
    // a line that must bend (neither in a row nor a column)
    if (dx && dy) c += e.w * 0.35 * Math.min(dx * cW, dy * cH);
    // cards in the way of a straight line
    if (!dx || !dy) {
      const steps = Math.max(dx, dy);
      const sx = Math.sign(cx(cb) - cx(ca));
      const sy = Math.sign(cy(cb) - cy(ca));
      for (let k = 1; k < steps; k++) if (at[(cy(ca) + sy * k) * cols + cx(ca) + sx * k] >= 0) c += e.w * cW;
    }
    // reading order around a processor
    for (const [m, o] of [[e.a, e.b], [e.b, e.a]] as const) {
      if (!mcu[m] || !side[o]) continue;
      const d = cx(cellOf[o]) - cx(cellOf[m]);
      if (Math.sign(d) !== side[o]) c += e.w * 0.3 * cW;
    }
    return c;
  };
  // straight centre-to-centre lines of two links cross (links that share a card never count)
  const crosses = (e: Edge, f: Edge): boolean => {
    if (e.a === f.a || e.a === f.b || e.b === f.a || e.b === f.b) return false;
    const p = [cellOf[e.a], cellOf[e.b], cellOf[f.a], cellOf[f.b]];
    if (p.some((c) => c < 0)) return false;
    const P = p.map((c) => [cx(c) * cW, cy(c) * cH]);
    const d = (o: number[], q: number[], r: number[]) => (q[0] - o[0]) * (r[1] - o[1]) - (q[1] - o[1]) * (r[0] - o[0]);
    const d1 = d(P[2], P[3], P[0]);
    const d2 = d(P[2], P[3], P[1]);
    const d3 = d(P[0], P[1], P[2]);
    const d4 = d(P[0], P[1], P[3]);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  };
  const CROSS = 0.9 * cW;
  /** The part of the cost that changes when the cards in `moved` (and the cells `cellsTouched`) change. */
  const localCost = (moved: number[], cellsTouched: number[]): number => {
    const mine = new Set<number>();
    for (const i of moved) if (i >= 0) for (const k of incident[i]) mine.add(k);
    let c = 0;
    for (const k of mine) c += edgeCost(E[k]);
    for (const k of mine)
      for (let f = 0; f < E.length; f++) {
        if (f === k || (mine.has(f) && f < k)) continue;
        if (crosses(E[k], E[f])) c += CROSS * Math.min(E[k].w, E[f].w);
      }
    // other links whose straight line passes the touched cells
    for (let f = 0; f < E.length; f++) {
      if (mine.has(f)) continue;
      const e = E[f];
      const ca = cellOf[e.a];
      const cb = cellOf[e.b];
      if (ca < 0 || cb < 0) continue;
      if (cx(ca) !== cx(cb) && cy(ca) !== cy(cb)) continue;
      for (const t of cellsTouched) {
        const tx = cx(t);
        const ty = cy(t);
        const between =
          (cy(ca) === cy(cb) && ty === cy(ca) && tx > Math.min(cx(ca), cx(cb)) && tx < Math.max(cx(ca), cx(cb))) ||
          (cx(ca) === cx(cb) && tx === cx(ca) && ty > Math.min(cy(ca), cy(cb)) && ty < Math.max(cy(ca), cy(cb)));
        if (between && at[t] >= 0) c += e.w * cW;
      }
    }
    // a card joined to nothing stays near the middle rather than at a far corner
    for (const i of moved) if (i >= 0 && !incident[i].length) c += 0.05 * (Math.abs(cx(cellOf[i]) - (cols - 1) / 2) * cW + Math.abs(cy(cellOf[i]) - (rows - 1) / 2) * cH);
    return c;
  };

  // ---- fixed cards: the cell nearest where they are, on a grid anchored on the first of them ----
  const fixedIds = Object.keys(fixed).filter((id) => index.has(id)).sort(natural);
  const locked = new Uint8Array(n);
  const order = list.map((_, i) => i).sort((a, b) => degree[b] - degree[a] || Number(mcu[b]) - Number(mcu[a]) || natural(list[a].id, list[b].id));
  if (fixedIds.length) {
    const centre = (id: string) => ({ x: fixed[id].x + list[index.get(id)!].w / 2, y: fixed[id].y + list[index.get(id)!].h / 2 });
    const a = centre(fixedIds[0]);
    const startX = Math.floor((cols - 1) / 2);
    const startY = Math.floor((rows - 1) / 2);
    for (const id of fixedIds) {
      const p = centre(id);
      const gx = Math.max(0, Math.min(cols - 1, startX + Math.round((p.x - a.x) / cW)));
      const gy = Math.max(0, Math.min(rows - 1, startY + Math.round((p.y - a.y) / cH)));
      // the nearest free cell to that
      let best = -1;
      let bd = Infinity;
      for (let c = 0; c < cells; c++) {
        if (at[c] >= 0) continue;
        const d = Math.abs(cx(c) - gx) + Math.abs(cy(c) - gy);
        if (d < bd) [best, bd] = [c, d];
      }
      if (best >= 0) {
        put(index.get(id)!, best);
        locked[index.get(id)!] = 1;
      }
    }
  }

  // ---- the starting arrangement ----
  const free = () => [...Array(cells).keys()].filter((c) => at[c] < 0);
  if (opts.seed && list.some((x) => opts.seed![x.id])) {
    // rows by height, then columns by x, as they were
    const seeded = order.filter((i) => cellOf[i] < 0).sort((a, b) => (opts.seed![list[a].id]?.y ?? Infinity) - (opts.seed![list[b].id]?.y ?? Infinity) || natural(list[a].id, list[b].id));
    const slots = free();
    const byRow = new Map<number, number[]>();
    for (const c of slots) byRow.set(cy(c), [...(byRow.get(cy(c)) ?? []), c]);
    let k = 0;
    for (const r of [...byRow.keys()].sort((a, b) => a - b)) {
      const row = byRow.get(r)!;
      const take = seeded.slice(k, k + row.length).sort((a, b) => (opts.seed![list[a].id]?.x ?? Infinity) - (opts.seed![list[b].id]?.x ?? Infinity) || natural(list[a].id, list[b].id));
      take.forEach((i, j) => put(i, row[j]));
      k += take.length;
    }
  } else {
    // the hub in the middle, then each card at the best free cell, strongest joined first
    const placed = new Set<number>(order.filter((i) => cellOf[i] >= 0));
    const weightTo = (i: number) => incident[i].reduce((s, k) => s + (placed.has(E[k].a === i ? E[k].b : E[k].a) ? E[k].w : 0), 0);
    while (placed.size < n) {
      let pick = -1;
      let best = -Infinity;
      for (const i of order) {
        if (placed.has(i)) continue;
        const w = weightTo(i);
        if (w > best) [pick, best] = [i, w];
      }
      if (!placed.size || best <= 0) {
        // nothing placed it joins: the middle (the hub), or the free cell nearest the middle
        const mid = Math.floor((rows - 1) / 2) * cols + Math.floor((cols - 1) / 2);
        const c = free().sort((a, b) => Math.abs(cx(a) - cx(mid)) + Math.abs(cy(a) - cy(mid)) - (Math.abs(cx(b) - cx(mid)) + Math.abs(cy(b) - cy(mid))) || a - b)[0];
        put(pick, c);
      } else {
        let bc = -1;
        let bv = Infinity;
        for (const c of free()) {
          put(pick, c);
          const v = localCost([pick], [c]);
          at[c] = -1;
          cellOf[pick] = -1;
          if (v < bv - 1e-9) [bc, bv] = [c, v];
        }
        put(pick, bc);
      }
      placed.add(pick);
    }
  }

  // ---- swaps (and moves to empty cells) while they help ----
  for (let pass = 0; pass < 24; pass++) {
    let improved = false;
    for (let c1 = 0; c1 < cells; c1++)
      for (let c2 = c1 + 1; c2 < cells; c2++) {
        const i = at[c1];
        const j = at[c2];
        if (i < 0 && j < 0) continue;
        if ((i >= 0 && locked[i]) || (j >= 0 && locked[j])) continue;
        const before = localCost([i, j], [c1, c2]);
        at[c1] = j;
        at[c2] = i;
        if (i >= 0) cellOf[i] = c2;
        if (j >= 0) cellOf[j] = c1;
        const after = localCost([i, j], [c1, c2]);
        if (after < before - 1e-6) improved = true;
        else {
          at[c1] = i;
          at[c2] = j;
          if (i >= 0) cellOf[i] = c1;
          if (j >= 0) cellOf[j] = c2;
        }
      }
    if (!improved) break;
  }

  // ---- positions: empty rows and columns dropped, each column as wide and each row as tall as its largest card ----
  const usedCols = [...new Set([...cellOf].map(cx))].sort((a, b) => a - b);
  const usedRows = [...new Set([...cellOf].map(cy))].sort((a, b) => a - b);
  const colW = usedCols.map((c) => Math.max(...list.filter((_, i) => cx(cellOf[i]) === c).map((x) => x.w)));
  const rowH = usedRows.map((r) => Math.max(...list.filter((_, i) => cy(cellOf[i]) === r).map((x) => x.h)));
  const colX: number[] = [];
  let x = 0;
  colW.forEach((w) => {
    colX.push(x);
    x = snapUp(x + w + GRID_GAP_X);
  });
  const rowY: number[] = [];
  let y = 0;
  rowH.forEach((h) => {
    rowY.push(y);
    y = snapUp(y + h + GRID_GAP_Y);
  });
  list.forEach((node, i) => {
    const ci = usedCols.indexOf(cx(cellOf[i]));
    const ri = usedRows.indexOf(cy(cellOf[i]));
    out[node.id] = { x: snapTo(colX[ci] + (colW[ci] - node.w) / 2), y: snapTo(rowY[ri] + (rowH[ri] - node.h) / 2) };
  });

  // fixed cards where they were: the grid moved so the first sits there, then each where it was
  if (fixedIds.length) {
    const first = fixedIds[0];
    const dx = fixed[first].x - out[first].x;
    const dy = fixed[first].y - out[first].y;
    for (const id of Object.keys(out)) out[id] = { x: out[id].x + dx, y: out[id].y + dy };
    for (const id of fixedIds) out[id] = { ...fixed[id] };
    // a card the move put on a fixed one goes to the nearest free spot
    const settled = fixedIds.map((id) => ({ ...out[id], w: list[index.get(id)!].w, h: list[index.get(id)!].h }));
    for (const i of order) {
      const node = list[i];
      if (locked[i]) continue;
      const b = { ...out[node.id], w: node.w, h: node.h };
      if (settled.some((o) => hits(b, o, GRID_GAP_Y / 4))) {
        const spot = freeSpot([b.x + b.w / 2, b.y + b.h / 2], b.w, b.h, settled, { x: GRID_GAP_X / 2, y: GRID_GAP_Y / 2 });
        out[node.id] = spot;
        b.x = spot.x;
        b.y = spot.y;
      }
      settled.push(b);
    }
  }
  return out;
}
