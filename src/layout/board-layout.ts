/**
 * Board-level layout (PB-873): a level with nets — a board's components and
 * the junctions of its nets — laid out the way a schematic sheet reads.
 *
 * - Components are grouped by function, from their taxonomy category:
 *   connectors and switches, power, the processor, sensors, outputs. Each
 *   group is a column (wrapped into sub-columns when tall), left to right.
 * - Passives and discretes (a decoupling capacitor, a pull-up, a crystal)
 *   are not groups of their own: each sits with the part it serves, named
 *   in its label ("U7 input", "LED driver VCC") or else the part it shares
 *   the most specific net with.
 * - Within a column, clusters are ordered by where their connections are
 *   (barycentre sweeps), so lines between columns cross less.
 * - Each net junction then goes to the free spot nearest the middle of the
 *   components it joins, never on a card or another junction.
 *
 * Same input, same output; no two boxes closer than the margins below.
 */
import { GRID } from "./router";

export interface BoardNode {
  id: string;
  w: number;
  h: number;
  /** A net junction (placed after the components). */
  net?: boolean;
  /** Taxonomy category ("power.regulator", "component.passive.capacitor"). */
  category?: string;
  label?: string;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type FunctionGroup = "io" | "power" | "mcu" | "sensor" | "output" | "other";
const GROUP_ORDER: FunctionGroup[] = ["io", "power", "mcu", "sensor", "output", "other"];

/** Card spacing inside a cluster, between clusters, and between columns (room for junctions). */
const GAP_IN_X = 144;
const GAP_IN_Y = 80;
const GAP_CLUSTER = 144;
const GAP_COLUMN = 360;
/** Clearance kept around a junction. */
const HUB_PAD_X = 36;
const HUB_PAD_Y = 18;
const STEP = GRID;

/** A passive or discrete part: placed with the part it serves rather than in a group of its own. */
export function isSatellite(category?: string): boolean {
  return !!category && /^component\.(passive|discrete)\b/.test(category);
}

/** The function group of a component, from its category. */
export function functionGroup(category?: string): FunctionGroup {
  const c = category ?? "";
  if (/^(connector|interconnect)\b|^component\.(switch|protection|button)\b|^mechanical\.connector/.test(c)) return "io";
  if (/^power\b|^energy\b|^battery\b/.test(c)) return "power";
  if (/^(microcontroller|processor|compute|fpga|soc)\b|^component\.(mcu|processor)\b/.test(c)) return "mcu";
  if (/^sensor\b/.test(c)) return "sensor";
  if (/^(actuator|display|lighting|audio|communication|radio|motor)\b|^component\.(display|led|ic|driver|audio)\b/.test(c)) return "output";
  return "other";
}

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

const words = (s: string) =>
  s
    .toUpperCase()
    .split(/[^A-Z0-9+-]+/)
    .filter((w) => w.length >= 3 && !GENERIC.has(w));
/** Words too common in part names to say which part a passive serves. */
const GENERIC = new Set(["THE", "AND", "FOR", "PULL-UP", "PULL-DOWN", "PULL", "BULK", "BYPASS", "INPUT", "OUTPUT", "SERIES", "UPPER", "LOWER", "TOP", "BOTTOM", "PAD", "PADS", "LOAD", "SENSE", "DIVIDER", "MODULE"]);

/** Whether `boxes` overlap once each is grown by its own padding. */
export function hits(a: Rect, b: Rect, padA = 0, padB = 0): boolean {
  return a.x - padA < b.x + b.w + padB && b.x - padB < a.x + a.w + padA && a.y - padA < b.y + b.h + padB && b.y - padB < a.y + a.h + padA;
}

/** Search offsets, cheapest first: a vertical move costs less than a sideways one (junctions stack in the gutters). */
let OFFSETS: [number, number][] | undefined;
function offsets(): [number, number][] {
  if (OFFSETS) return OFFSETS;
  const out: [number, number, number][] = [];
  const R = 90;
  for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) out.push([i * STEP, j * STEP, Math.abs(i) * 1.25 + Math.abs(j) + (i < 0 ? 0.01 : 0) + (j < 0 ? 0.005 : 0)]);
  out.sort((a, b) => a[2] - b[2]);
  OFFSETS = out.map(([x, y]) => [x, y]);
  return OFFSETS;
}

/**
 * The free top-left position nearest `ideal` (a centre) for a box of size w×h,
 * clear of every obstacle by the paddings. Falls back to below everything.
 */
export function freeSpot(ideal: [number, number], w: number, h: number, obstacles: Rect[], pad: { x: number; y: number } = { x: HUB_PAD_X, y: HUB_PAD_Y }): { x: number; y: number } {
  const x0 = Math.round((ideal[0] - w / 2) / STEP) * STEP;
  const y0 = Math.round((ideal[1] - h / 2) / STEP) * STEP;
  const clear = (x: number, y: number) =>
    obstacles.every((o) => !(x - pad.x < o.x + o.w && o.x < x + w + pad.x && y - pad.y < o.y + o.h && o.y < y + h + pad.y));
  for (const [dx, dy] of offsets()) if (clear(x0 + dx, y0 + dy)) return { x: x0 + dx, y: y0 + dy };
  const bottom = Math.max(0, ...obstacles.map((o) => o.y + o.h));
  return { x: x0, y: bottom + 2 * pad.y };
}

/**
 * Top-left positions by node id for a board level. `edges` are the lines
 * drawn between nodes (component ↔ junction, or component ↔ component).
 */
export function boardLayout(nodes: BoardNode[], edges: [string, string][]): Record<string, { x: number; y: number }> {
  if (!nodes.length) return {};
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const comps = nodes.filter((n) => !n.net).sort((a, b) => natural(a.id, b.id));
  const hubs = nodes.filter((n) => n.net).sort((a, b) => natural(a.id, b.id));

  // nets as member sets; component ↔ component lines count as two-member nets
  const members = new Map<string, Set<string>>();
  const direct: [string, string][] = [];
  for (const [a, b] of edges) {
    const na = byId.get(a);
    const nb = byId.get(b);
    if (!na || !nb || a === b) continue;
    if (na.net && !nb.net) members.set(a, (members.get(a) ?? new Set()).add(b));
    else if (nb.net && !na.net) members.set(b, (members.get(b) ?? new Set()).add(a));
    else if (!na.net && !nb.net) direct.push([a, b]);
  }
  const nets: string[][] = [...[...members.values()].map((s) => [...s].sort(natural)), ...direct];
  // affinity between components: a net of n members adds 1/(n−1) to each pair (a rail says little)
  const affinity = new Map<string, Map<string, number>>();
  const addAff = (a: string, b: string, w: number) => {
    const m = affinity.get(a) ?? new Map<string, number>();
    m.set(b, (m.get(b) ?? 0) + w);
    affinity.set(a, m);
  };
  for (const set of nets) {
    if (set.length < 2) continue;
    const w = 1 / (set.length - 1);
    for (let i = 0; i < set.length; i++) for (let j = i + 1; j < set.length; j++) {
      addAff(set[i], set[j], w);
      addAff(set[j], set[i], w);
    }
  }

  // ---- clusters: anchors and the satellites that serve them ----
  const satellite = (n: BoardNode) => isSatellite(n.category);
  const anchors = comps.filter((n) => !satellite(n));
  const group = new Map<string, FunctionGroup>(anchors.map((n) => [n.id, functionGroup(n.category)]));
  const rank = (id: string) => GROUP_ORDER.indexOf(group.get(id) ?? "other");
  const parentOf = new Map<string, string>();
  for (const s of comps.filter(satellite)) {
    const label = (s.label ?? "").toUpperCase();
    // 1. a designator named in the label ("U7 INPUT", "Y1 LOAD XL1")
    const named = comps.filter((o) => o !== s && new RegExp(`(^|[^A-Z0-9])${o.id.toUpperCase().replace(/[^A-Z0-9]/g, "")}([^A-Z0-9]|$)`).test(label));
    // 2. an anchor whose name shares a distinctive word ("LED DRIVER VCC" → "LED DRIVER")
    const own = new Set(words(label));
    const worded = anchors
      .map((o) => ({ o, n: words(o.label ?? "").filter((w) => own.has(w)).length }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n || rank(a.o.id) - rank(b.o.id) || natural(a.o.id, b.o.id));
    // 3. the component sharing the most specific nets (ties: the processor first)
    const aff = [...(affinity.get(s.id) ?? new Map<string, number>())].sort((a, b) => b[1] - a[1] || (group.has(a[0]) ? rank(a[0]) : 9) - (group.has(b[0]) ? rank(b[0]) : 9) || natural(a[0], b[0]));
    const pick = named[0]?.id ?? worded[0]?.o.id ?? aff[0]?.[0];
    if (pick) parentOf.set(s.id, pick);
  }
  // follow satellite → satellite chains to an anchor; a satellite with none becomes an anchor of its own
  const anchorOf = (id: string): string => {
    const seen = new Set<string>();
    let cur = id;
    while (parentOf.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = parentOf.get(cur)!;
    }
    return seen.has(cur) || !group.has(cur) ? id : cur;
  };
  // a connector or switch dedicated to one part (an LRA's pads, the SWD pads, a button) sits with
  // that part: every specific net it is on (three members or fewer) goes to the same cluster
  for (const n of anchors) {
    if (group.get(n.id) !== "io") continue;
    const targets = new Set<string>();
    for (const set of nets) if (set.includes(n.id) && set.length <= 3) for (const o of set) if (o !== n.id) targets.add(anchorOf(o));
    targets.delete(n.id);
    const [only] = targets;
    if (targets.size === 1 && group.has(only) && group.get(only) !== "io") {
      parentOf.set(n.id, only);
      group.delete(n.id);
    }
  }
  const clusters = new Map<string, string[]>();
  for (const n of comps) {
    const a = satellite(n) || !group.has(n.id) ? anchorOf(n.id) : n.id;
    if (!group.has(a)) group.set(a, "other");
    if (a !== n.id) clusters.set(a, [...(clusters.get(a) ?? []), n.id]);
    else if (!clusters.has(a)) clusters.set(a, []);
  }
  // satellites listed by what they hang from (Y1's load caps beside Y1), then by id
  for (const [a, sats] of clusters) {
    const chain = (id: string): string[] => (parentOf.has(id) && parentOf.get(id) !== a && sats.includes(parentOf.get(id)!) ? [...chain(parentOf.get(id)!), id] : [id]);
    sats.sort((x, y) => {
      const cx = chain(x);
      const cy = chain(y);
      return natural(cx[0], cy[0]) || cx.length - cy.length || natural(x, y);
    });
    clusters.set(a, sats);
  }

  // ---- cluster shapes: the anchor on top, its satellites in a grid below ----
  interface Cluster {
    id: string;
    group: FunctionGroup;
    w: number;
    h: number;
    /** Offsets of each card inside the cluster. */
    cards: Record<string, { x: number; y: number }>;
  }
  const shapes: Cluster[] = [...clusters].map(([a, sats]) => {
    const an = byId.get(a)!;
    const cards: Record<string, { x: number; y: number }> = {};
    if (!sats.length) {
      cards[a] = { x: 0, y: 0 };
      return { id: a, group: group.get(a)!, w: an.w, h: an.h, cards };
    }
    const cols = Math.min(3, Math.ceil(Math.sqrt(sats.length)));
    const cellW = Math.max(...sats.map((s) => byId.get(s)!.w));
    const gridW = cols * cellW + (cols - 1) * GAP_IN_X;
    const w = Math.max(an.w, gridW);
    cards[a] = { x: Math.round((w - an.w) / 2 / STEP) * STEP, y: 0 };
    let y = an.h + GAP_IN_Y + 20;
    for (let r = 0; r * cols < sats.length; r++) {
      const row = sats.slice(r * cols, r * cols + cols);
      const rowH = Math.max(...row.map((s) => byId.get(s)!.h));
      const x0 = (w - (row.length * cellW + (row.length - 1) * GAP_IN_X)) / 2;
      row.forEach((s, i) => (cards[s] = { x: Math.round((x0 + i * (cellW + GAP_IN_X)) / STEP) * STEP, y }));
      y += rowH + GAP_IN_Y;
    }
    return { id: a, group: group.get(a)!, w, h: y - GAP_IN_Y, cards };
  });
  const clusterOf = new Map<string, string>();
  for (const c of shapes) for (const id of Object.keys(c.cards)) clusterOf.set(id, c.id);

  // cluster ↔ cluster weights, for ordering
  const cw = new Map<string, Map<string, number>>();
  for (const [a, m] of affinity) {
    const ca = clusterOf.get(a)!;
    for (const [b, w] of m) {
      const cb = clusterOf.get(b)!;
      if (ca === cb) continue;
      const row = cw.get(ca) ?? new Map<string, number>();
      row.set(cb, (row.get(cb) ?? 0) + w);
      cw.set(ca, row);
    }
  }

  // ---- columns: one per function group, wrapped at a height that keeps the sheet landscape ----
  const area = shapes.reduce((s, c) => s + (c.w + GAP_COLUMN * 0.6) * (c.h + GAP_CLUSTER), 0);
  const maxH = Math.max(Math.max(...shapes.map((c) => c.h)), Math.sqrt(area / 1.5));
  const groups = GROUP_ORDER.map((g) => shapes.filter((c) => c.group === g).sort((a, b) => b.h * b.w - a.h * a.w || natural(a.id, b.id))).filter((g) => g.length);
  const centre = new Map<string, [number, number]>();

  const place = () => {
    const pos = new Map<string, { x: number; y: number }>();
    let x = 0;
    for (const col of groups) {
      // fill sub-columns top-down
      const subs: Cluster[][] = [[]];
      let h = 0;
      for (const c of col) {
        if (subs.at(-1)!.length && h + GAP_CLUSTER + c.h > maxH) {
          subs.push([]);
          h = 0;
        }
        h += (subs.at(-1)!.length ? GAP_CLUSTER : 0) + c.h;
        subs.at(-1)!.push(c);
      }
      for (const sub of subs) {
        const w = Math.max(...sub.map((c) => c.w));
        const total = sub.reduce((s, c) => s + c.h, 0) + GAP_CLUSTER * (sub.length - 1);
        let y = Math.round((maxH - total) / 2 / STEP) * STEP;
        for (const c of sub) {
          pos.set(c.id, { x: x + Math.round((w - c.w) / 2 / STEP) * STEP, y });
          centre.set(c.id, [x + w / 2, y + c.h / 2]);
          y += c.h + GAP_CLUSTER;
        }
        x += w + GAP_COLUMN;
      }
    }
    return pos;
  };
  let pos = place();
  // barycentre sweeps: order each column by the mean height of what it connects to elsewhere
  for (let sweep = 0; sweep < 6; sweep++) {
    for (const col of groups) {
      const key = new Map<string, number>();
      for (const c of col) {
        let s = 0;
        let n = 0;
        for (const [o, w] of cw.get(c.id) ?? []) {
          if (col.some((x) => x.id === o)) continue;
          s += centre.get(o)![1] * w;
          n += w;
        }
        key.set(c.id, n ? s / n : centre.get(c.id)![1]);
      }
      col.sort((a, b) => key.get(a.id)! - key.get(b.id)! || natural(a.id, b.id));
    }
    pos = place();
  }

  const out: Record<string, { x: number; y: number }> = {};
  const cards: Rect[] = [];
  for (const c of shapes) {
    const p = pos.get(c.id)!;
    for (const [id, o] of Object.entries(c.cards)) {
      const n = byId.get(id)!;
      out[id] = { x: p.x + o.x, y: p.y + o.y };
      cards.push({ x: p.x + o.x, y: p.y + o.y, w: n.w, h: n.h });
    }
  }

  // ---- junctions: nearest free spot to the middle of their members ----
  const hubMembers = (id: string) => [...(members.get(id) ?? [])].filter((m) => out[m]);
  const order = hubs.slice().sort((a, b) => hubMembers(a.id).length - hubMembers(b.id).length || natural(a.id, b.id));
  const all = cards.map((c) => ({ ...c, x: c.x - (HUB_PAD_X - 20), w: c.w + 2 * (HUB_PAD_X - 20) }));
  const right = Math.max(...cards.map((c) => c.x + c.w), 0);
  for (const hub of order) {
    const m = hubMembers(hub.id);
    const ideal: [number, number] = m.length
      ? [m.reduce((s, id) => s + out[id].x + byId.get(id)!.w / 2, 0) / m.length, m.reduce((s, id) => s + out[id].y + byId.get(id)!.h / 2, 0) / m.length]
      : [right + GAP_COLUMN / 2, 0];
    const at = freeSpot(ideal, hub.w, hub.h, all);
    out[hub.id] = at;
    all.push({ x: at.x, y: at.y, w: hub.w, h: hub.h });
  }

  const minX = Math.min(...Object.values(out).map((p) => p.x));
  const minY = Math.min(...Object.values(out).map((p) => p.y));
  for (const p of Object.values(out)) {
    p.x -= minX;
    p.y -= minY;
  }
  return out;
}
