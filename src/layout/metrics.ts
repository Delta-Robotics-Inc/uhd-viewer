/**
 * Layout quality (PB-1007): numbers that say whether a diagram reads, measured
 * on what the viewer draws (the boxes, and the routes the grid router gives
 * the links), so an agent can check a layout without looking at it.
 *
 * - crossings: places where two links' lines cross;
 * - overlaps: pairs of boxes that overlap (a card and a junction, two cards);
 * - aspect: the drawing's width over its height (a screen is about 1.6);
 * - strip: the most cards one straight line, across or down, passes through
 *   (a long row or column of parts; a tidy level of twenty cards has 4 or 5);
 * - underCards: links whose line runs under a card it does not end at;
 * - length: the total length of the lines, in diagram units.
 *
 * `findings` turns them into what to fix, with the thresholds below.
 */
import type { ViewModel } from "../model/types";
import type { Pt } from "../canvas/routing";
import type { Box, ComputedLayout } from "./layout";

export interface LayoutMetrics {
  /** Cards on the level: modules, components and harnesses (not junctions, sheet ports or open containers). */
  cards: number;
  /** Boundary ports drawn (the exports of the module this level shows). */
  boundary: number;
  /** Lines drawn. */
  links: number;
  crossings: number;
  overlaps: number;
  /** Width over height of the drawing (0 when it is empty). */
  aspect: number;
  width: number;
  height: number;
  strip: number;
  /** Whether the strip runs across (a row) or down (a column). */
  stripAxis: "row" | "column";
  /** The cards of the strip, in order. */
  stripCards: string[];
  underCards: number;
  length: number;
  /** The overlapping pairs and the links under cards, by id. */
  detail: { overlaps: [string, string][]; underCards: { link: string; card: string }[] };
}

export interface LayoutFinding {
  severity: "warning" | "info";
  code: "strip" | "crossings" | "overlaps" | "under-cards" | "aspect";
  message: string;
}

/**
 * What `findings` flags. A row or column of up to `strip(cards)` cards is
 * fine (a row of a grid shaped like a screen: 6 for up to 16 cards, then
 * one and a half times the square root of the count); more reads as a strip.
 */
export const LAYOUT_LIMITS = {
  strip: (cards: number) => Math.max(6, Math.ceil(1.5 * Math.sqrt(cards))),
  /** Crossings allowed: a few, and more on a level with many lines. */
  crossings: (links: number) => Math.max(3, Math.ceil(links / 8)),
  /** Aspect ratios outside this range read as a strip too. */
  aspect: [1 / 3, 3] as [number, number],
};

const ancestorOf = (a: string, b: string) => b.startsWith(`${a}/`);

/** Whether two boxes overlap by more than a hairline. */
function overlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1;
}

interface Seg {
  link: string;
  a: Pt;
  b: Pt;
}

function segments(id: string, pts: Pt[]): Seg[] {
  const out: Seg[] = [];
  for (let i = 1; i < pts.length; i++) if (pts[i - 1][0] !== pts[i][0] || pts[i - 1][1] !== pts[i][1]) out.push({ link: id, a: pts[i - 1], b: pts[i] });
  return out;
}

/** Whether a horizontal and a vertical segment cross inside both (not at an end, not touching). */
function cross(s: Seg, t: Seg): boolean {
  const h = (x: Seg) => Math.abs(x.a[1] - x.b[1]) < 0.5;
  const v = (x: Seg) => Math.abs(x.a[0] - x.b[0]) < 0.5;
  let H: Seg;
  let V: Seg;
  if (h(s) && v(t)) [H, V] = [s, t];
  else if (v(s) && h(t)) [H, V] = [t, s];
  else return obliqueCross(s, t);
  const y = H.a[1];
  const x = V.a[0];
  const [x0, x1] = [Math.min(H.a[0], H.b[0]), Math.max(H.a[0], H.b[0])];
  const [y0, y1] = [Math.min(V.a[1], V.b[1]), Math.max(V.a[1], V.b[1])];
  return x > x0 + 0.5 && x < x1 - 0.5 && y > y0 + 0.5 && y < y1 - 0.5;
}

/** A crossing of two segments when either is not axis-aligned (pass-through lines drawn straight). */
function obliqueCross(s: Seg, t: Seg): boolean {
  const d = (p: Pt, q: Pt, r: Pt) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = d(t.a, t.b, s.a);
  const d2 = d(t.a, t.b, s.b);
  const d3 = d(s.a, s.b, t.a);
  const d4 = d(s.a, s.b, t.b);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Whether a segment runs through the inside of a box (not along its edge). */
function through(s: Seg, b: Box): boolean {
  const [x0, x1] = [Math.min(s.a[0], s.b[0]), Math.max(s.a[0], s.b[0])];
  const [y0, y1] = [Math.min(s.a[1], s.b[1]), Math.max(s.a[1], s.b[1])];
  return x1 > b.x + 2 && x0 < b.x + b.w - 2 && y1 > b.y + 2 && y0 < b.y + b.h - 2;
}

/**
 * The most boxes one line along an axis passes through, and which: a sweep
 * over the boxes' extents on the other axis.
 */
function stab(boxes: { id: string; b: Box }[], axis: "row" | "column"): string[] {
  const lo = (x: { b: Box }) => (axis === "row" ? x.b.y : x.b.x);
  const hi = (x: { b: Box }) => (axis === "row" ? x.b.y + x.b.h : x.b.x + x.b.w);
  const along = (x: { b: Box }) => (axis === "row" ? x.b.x : x.b.y);
  let best: string[] = [];
  // the line through the middle of an overlap of extents: try each box's centre and edges (inset a little)
  const tries = [...new Set(boxes.flatMap((x) => [lo(x) + 4, (lo(x) + hi(x)) / 2, hi(x) - 4]))].sort((a, b) => a - b);
  for (const at of tries) {
    const hit = boxes.filter((x) => lo(x) <= at && hi(x) >= at);
    if (hit.length > best.length) best = hit.sort((a, b) => along(a) - along(b)).map((x) => x.id);
  }
  return best;
}

/** Measure a level as the viewer lays it out. `vm` is what is drawn (after rail taps). */
export function measureLayout(vm: ViewModel, layout: ComputedLayout): LayoutMetrics {
  const byId = new Map(vm.nodes.map((n) => [n.id, n]));
  const drawn = vm.nodes.filter((n) => layout.boxes[n.id]);
  const isCard = (id: string) => {
    const n = byId.get(id);
    return !!n && n.kind !== "net" && !n.sheetPort && !n.expanded;
  };
  const cards = drawn.filter((n) => isCard(n.id)).map((n) => ({ id: n.id, b: layout.boxes[n.id] }));

  // overlaps: any two boxes, except a container and what it holds
  const overlaps: [string, string][] = [];
  for (let i = 0; i < drawn.length; i++)
    for (let j = i + 1; j < drawn.length; j++) {
      const a = drawn[i].id;
      const b = drawn[j].id;
      if (ancestorOf(a, b) || ancestorOf(b, a)) continue;
      if (overlap(layout.boxes[a], layout.boxes[b])) overlaps.push([a, b].sort() as [string, string]);
    }

  // lines
  const routed = vm.links.filter((l) => layout.routes[l.id]?.length);
  const segs = routed.flatMap((l) => segments(l.id, layout.routes[l.id]));
  let crossings = 0;
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++) if (segs[i].link !== segs[j].link && cross(segs[i], segs[j])) crossings++;

  const under: { link: string; card: string }[] = [];
  for (const l of routed) {
    const ends = [l.source.node, l.target.node];
    const mine = (id: string) => ends.some((e) => e === id || ancestorOf(id, e) || ancestorOf(e, id));
    const own = segments(l.id, layout.routes[l.id]);
    for (const c of cards) {
      if (mine(c.id)) continue;
      if (own.some((s) => through(s, c.b))) under.push({ link: l.id, card: c.id });
    }
  }

  let length = 0;
  for (const s of segs) length += Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);

  const all = drawn.map((n) => layout.boxes[n.id]);
  const minX = all.length ? Math.min(...all.map((b) => b.x)) : 0;
  const minY = all.length ? Math.min(...all.map((b) => b.y)) : 0;
  const width = all.length ? Math.max(...all.map((b) => b.x + b.w)) - minX : 0;
  const height = all.length ? Math.max(...all.map((b) => b.y + b.h)) - minY : 0;

  // the strip counts the level's boundary ports too (a drilled-into module's exports, drawn in a column at the edge)
  const sheets = drawn.filter((n) => n.sheetPort).map((n) => ({ id: n.id, b: layout.boxes[n.id] }));
  const row = stab([...cards, ...sheets], "row");
  const column = stab([...cards, ...sheets], "column");
  const [strip, stripAxis] = column.length > row.length ? [column, "column" as const] : [row, "row" as const];

  return {
    cards: cards.length,
    boundary: sheets.length,
    links: routed.length,
    crossings,
    overlaps: overlaps.length,
    aspect: height ? Math.round((width / height) * 100) / 100 : 0,
    width: Math.round(width),
    height: Math.round(height),
    strip: strip.length,
    stripAxis,
    stripCards: strip,
    underCards: new Set(under.map((u) => u.link)).size,
    length: Math.round(length),
    detail: { overlaps, underCards: under },
  };
}

/** What a level's layout needs fixed, worst first. */
export function layoutFindings(m: LayoutMetrics, limits: typeof LAYOUT_LIMITS = LAYOUT_LIMITS): LayoutFinding[] {
  const out: LayoutFinding[] = [];
  if (m.overlaps) out.push({ severity: "warning", code: "overlaps", message: `${m.overlaps} pair${m.overlaps === 1 ? "" : "s"} of boxes overlap (${m.detail.overlaps.slice(0, 3).map((p) => p.join(" / ")).join(", ")}${m.overlaps > 3 ? ", …" : ""})` });
  const strip = limits.strip(m.cards + (m.boundary ?? 0));
  const ports = m.stripCards.filter((id) => id.startsWith("@")).length * 2 > m.stripCards.length;
  if (m.strip > strip)
    out.push({
      severity: "warning",
      code: "strip",
      message: `${m.strip} cards in one ${m.stripAxis} (${m.stripCards.slice(0, 4).join(", ")}${m.strip > 4 ? ", …" : ""}): more than ${strip} reads as a strip; ${ports ? "most are the level's boundary ports: export fewer, grouped interfaces from this module (composites) rather than one per signal" : "arrange them in a block around what they connect to"}`,
    });
  const [lo, hi] = limits.aspect;
  if (m.cards > 3 && m.aspect && (m.aspect < lo || m.aspect > hi)) out.push({ severity: "warning", code: "aspect", message: `the drawing is ${m.aspect > 1 ? `${m.aspect}× as wide as it is tall` : `${Math.round(100 / m.aspect) / 100}× as tall as it is wide`}: aim for a screen's shape (about 1.6)` });
  const allowed = limits.crossings(m.links);
  if (m.crossings > allowed) out.push({ severity: "warning", code: "crossings", message: `${m.crossings} line crossings (up to ${allowed} is fine for ${m.links} lines): move cards next to what they connect to` });
  if (m.underCards) out.push({ severity: "info", code: "under-cards", message: `${m.underCards} line${m.underCards === 1 ? " runs" : "s run"} under a card (${m.detail.underCards.slice(0, 2).map((u) => `${u.link} under ${u.card}`).join(", ")}${m.detail.underCards.length > 2 ? ", …" : ""})` });
  return out;
}
