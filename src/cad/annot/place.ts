/**
 * Label placement for open callouts (PB-1184). Each label is placed near its
 * anchor on one of a fixed set of slots (above or below, left or right, at a
 * few distances, reached by an option A leader: ./leader.ts), greedily in
 * priority order. A slot is refused when its label would leave the view,
 * overlap a label already placed, cover the anchored part's screen box or
 * another label's anchor, or when its leader would run through a placed
 * label. Among the rest the cheapest wins: the shortest leader, fewest
 * crossings of other leaders, the side away from the part's centre, and the
 * slot the label had last frame (so labels do not hop while the camera moves).
 * A label with no legal slot collapses to a numbered pin. Pure: screen pixels,
 * y down.
 */
import { CHAMFER, boxesOverlap, routeLeader, segmentHitsBox, segmentsCross, type Box, type Leader, type LegKind, type Pt } from "./leader";

export interface PlaceItem {
  id: string;
  anchor: Pt;
  w: number;
  h: number;
  /** The anchored part's screen box (labels stay off it). */
  part?: Box;
  /** Higher first (a pinned or hovered card before the rest). */
  priority?: number;
  /** The slot it had last frame. */
  prev?: string;
}

export interface Placed {
  id: string;
  box: Box;
  side: 1 | -1;
  slot: string;
  leader: Leader;
}

export interface PlaceResult {
  placed: Map<string, Placed>;
  /** Items with no legal slot: drawn as numbered pins. */
  pinned: string[];
}

export interface PlaceOptions {
  width: number;
  height: number;
  margins?: { top: number; bottom: number; left: number; right: number };
  /** Screen areas no label may cover (floating chrome). */
  obstacles?: Box[];
  /** A part box larger than this share of the view is not avoided (a frame filling the screen). DEFAULT 0.35. */
  hugePart?: number;
}

/** DEFAULT (PB-1184): rises of the 45° and vertical legs, and runs of a flat leader, in CSS px. */
export const RISES = [28, 52, 84, 124] as const;
export const RUNS = [36, 64] as const;
/** DEFAULT: px kept between a label and anything it avoids. */
const GAP = 4;

interface Slot {
  key: string;
  kind: LegKind;
  dir: 1 | -1;
  v: 1 | -1 | 0;
  dist: number;
}

const slotsFor = (rises: number[], runs: number[]): Slot[] => {
  const out: Slot[] = [];
  for (const dist of rises)
    for (const dir of [1, -1] as const)
      for (const v of [-1, 1] as const) {
        out.push({ key: `d${dir}${v}${dist}`, kind: "diagonal", dir, v, dist });
        out.push({ key: `v${dir}${v}${dist}`, kind: "vertical", dir, v, dist });
      }
  for (const dist of runs) for (const dir of [1, -1] as const) out.push({ key: `f${dir}${dist}`, kind: "flat", dir, v: 0, dist });
  return out;
};
const SLOTS: Slot[] = slotsFor([...RISES], [...RUNS]);

/**
 * Slots that just clear the anchored part's screen box (a big part: the fixed rises stay on top of it): legs long
 * enough to put the label above, below or beside the box, rounded to 8 px so the keys stay stable while moving.
 */
function partSlots(a: Pt, part: Box, h: number): Slot[] {
  const r8 = (n: number) => Math.ceil(n / 8) * 8;
  const up = r8(a[1] - part.y + 4);
  const down = r8(part.y + part.h + h + 4 - a[1]);
  const right = r8(part.x + part.w - a[0] + 4);
  const left = r8(a[0] - part.x + 4);
  const out: Slot[] = [];
  for (const dir of [1, -1] as const) {
    for (const [v, d] of [
      [-1, up],
      [1, down],
    ] as const) {
      if (d <= 0 || d > 2000) continue;
      out.push({ key: `d${dir}${v}${d}`, kind: "diagonal", dir, v, dist: d });
      out.push({ key: `v${dir}${v}${d}`, kind: "vertical", dir, v, dist: d });
    }
    const run = dir > 0 ? right : left;
    if (run > 0 && run < 2000) out.push({ key: `f${dir}${run}`, kind: "flat", dir, v: 0, dist: run });
  }
  return out;
}

/** The shelf start for a slot. */
function shelfStart(a: Pt, s: Slot): Pt {
  if (s.kind === "flat") return [a[0] + s.dir * s.dist, a[1]];
  if (s.kind === "diagonal") return [a[0] + s.dir * s.dist, a[1] + s.v * s.dist];
  return [a[0] + s.dir * CHAMFER, a[1] + s.v * s.dist];
}

export function placeLabels(items: PlaceItem[], o: PlaceOptions): PlaceResult {
  const m = o.margins ?? { top: 8, bottom: 8, left: 8, right: 8 };
  const huge = (o.hugePart ?? 0.35) * o.width * o.height;
  const order = [...items].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id));
  const placed = new Map<string, Placed>();
  const pinned: string[] = [];
  const boxes: Box[] = [];
  const leaders: Pt[][] = [];
  const anchors = items.map((i) => ({ id: i.id, p: i.anchor }));
  const parts = items.filter((i) => i.part && i.part.w * i.part.h <= huge).map((i) => ({ id: i.id, b: i.part! }));
  for (const it of order) {
    const a = it.anchor;
    const own = it.part && it.part.w * it.part.h <= huge ? it.part : undefined;
    const centreX = own ? own.x + own.w / 2 : a[0];
    let best: { cost: number; p: Placed } | undefined;
    for (const s of own ? [...SLOTS, ...partSlots(a, own, it.h)] : SLOTS) {
      const start = shelfStart(a, s);
      const box: Box = { x: s.dir > 0 ? start[0] : start[0] - it.w, y: start[1] - it.h, w: it.w, h: it.h };
      // in the view
      if (box.x < m.left || box.y < m.top || box.x + box.w > o.width - m.right || box.y + box.h > o.height - m.bottom) continue;
      if (boxes.some((b) => boxesOverlap(b, box, GAP))) continue;
      if (o.obstacles?.some((b) => boxesOverlap(b, box, GAP))) continue;
      if (own && boxesOverlap(own, box, 2)) continue;
      // never over an anchor (its own or another label's)
      if (anchors.some(({ p }) => p[0] > box.x - 6 && p[0] < box.x + box.w + 6 && p[1] > box.y - 6 && p[1] < box.y + box.h + 6)) continue;
      const leader = routeLeader(a, start, s.dir * it.w, s.kind);
      if (!leader) continue;
      const legs = leader.points.slice(0, -1);
      let blocked = false;
      for (let i = 1; i < legs.length && !blocked; i++) blocked = boxes.some((b) => segmentHitsBox(legs[i - 1], legs[i], b, 1));
      if (blocked) continue;
      let cost = 0;
      for (let i = 1; i < legs.length; i++) cost += Math.hypot(legs[i][0] - legs[i - 1][0], legs[i][1] - legs[i - 1][1]);
      for (const other of leaders) for (let i = 1; i < legs.length; i++) for (let j = 1; j < other.length; j++) if (segmentsCross(legs[i - 1], legs[i], other[j - 1], other[j])) cost += 200;
      for (const p of parts) if (p.id !== it.id && boxesOverlap(p.b, box)) cost += 60;
      // away from the part's centre, above rather than below
      if ((a[0] - centreX) * s.dir < -1) cost += 24;
      if (s.v > 0) cost += 6;
      if (it.prev && it.prev !== s.key) cost += 40;
      if (!best || cost < best.cost) best = { cost, p: { id: it.id, box, side: s.dir, slot: s.key, leader } };
    }
    if (!best) {
      pinned.push(it.id);
      continue;
    }
    placed.set(it.id, best.p);
    boxes.push(best.p.box);
    leaders.push(best.p.leader.points.slice(0, -1));
  }
  return { placed, pinned };
}

/** The screen box of projected points (the corners of a part's bounds). */
export function screenBox(points: Pt[]): Box | undefined {
  if (!points.length) return undefined;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of points) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
