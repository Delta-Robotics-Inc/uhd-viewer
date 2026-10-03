/**
 * Board-level layout (PB-873): a level with nets — a board's components and
 * the junctions of its nets — laid out the way a schematic sheet reads, as
 * layers with channels between them.
 *
 * - Components are clustered: a passive or discrete part (a decoupling
 *   capacitor, a pull-up, a crystal) sits under the part it serves, named in
 *   its label ("U7 input") or else the part it shares the most specific net
 *   with; a connector or switch that serves one part only sits with it too.
 * - Clusters go in columns by function, from the taxonomy category:
 *   connectors, power, the processor, then sensors and outputs. A part driven
 *   only by another peripheral (the LEDs of an LED driver) goes one column
 *   further out. A column too tall for a landscape sheet wraps.
 * - Within a column, clusters are ordered by barycentre sweeps and set at
 *   the height of what they connect to, as close as the gaps allow, so lines
 *   between columns run level and cross less.
 * - Junctions go in the channels between columns, each in the channel
 *   between the parts it joins, level with them; a channel holds one or more
 *   lanes of junctions and is as wide as its lines need.
 *
 * Same input, same output; nothing overlaps.
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
  /** A junction that is one tap of a rail drawn in several places: the rail's id (taps.ts). */
  tapOf?: string;
  /** A card's height once one side holds this many ports (cards grow to fit their ports). */
  heightFor?: (perSide: number) => number;
  /** Ports on lines that do not go to a junction (a sheet port's, a direct link's): either side. */
  otherPorts?: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type FunctionGroup = "io" | "power" | "mcu" | "sensor" | "output" | "other";
const GROUP_ORDER: FunctionGroup[] = ["io", "power", "mcu", "sensor", "output", "other"];
/** Column of each group: sensors and outputs share the column after the processor. */
const GROUP_COLUMN: Record<FunctionGroup, number> = { io: 0, power: 1, mcu: 2, sensor: 3, output: 3, other: 3 };

/** Card spacing inside a cluster, and between clusters in a column. */
const GAP_IN_X = 96;
const GAP_IN_Y = 64;
const GAP_CLUSTER = 112;
/** Junction lanes: the gap between junctions in a lane, and between lanes. */
const HUB_GAP_Y = 32;
const LANE_GAP = 96;
/** How far a junction may be pushed down its lane before the channel opens another. */
const LANE_PUSH = 480;
/** Room between a column and the junction lanes beside it: a base, and a grid track per few lines. */
const CHANNEL_PAD = 80;
const STEP = GRID;
/** A column shorter than this never wraps. */
const WRAP_MIN = 1600;

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
const snapUp = (v: number) => Math.ceil(v / STEP) * STEP;
const snapTo = (v: number) => Math.round(v / STEP) * STEP;

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

/** Search offsets, cheapest first: a vertical move costs less than a sideways one. */
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
export function freeSpot(ideal: [number, number], w: number, h: number, obstacles: Rect[], pad: { x: number; y: number } = { x: 36, y: 18 }): { x: number; y: number } {
  const x0 = Math.round((ideal[0] - w / 2) / STEP) * STEP;
  const y0 = Math.round((ideal[1] - h / 2) / STEP) * STEP;
  const clear = (x: number, y: number) =>
    obstacles.every((o) => !(x - pad.x < o.x + o.w && o.x < x + w + pad.x && y - pad.y < o.y + o.h && o.y < y + h + pad.y));
  for (const [dx, dy] of offsets()) if (clear(x0 + dx, y0 + dy)) return { x: x0 + dx, y: y0 + dy };
  const bottom = Math.max(0, ...obstacles.map((o) => o.y + o.h));
  return { x: x0, y: bottom + 2 * pad.y };
}

/**
 * Isotonic placement: tops for boxes in a fixed order, each at least `gap`
 * below the one before, as close to its ideal top as that allows (least
 * squares, pool-adjacent-violators).
 */
export function pack(ideal: number[], heights: number[], gap: number): number[] {
  // z_i = y_i − (the room the boxes above take); z must not decrease
  const offset: number[] = [];
  let acc = 0;
  for (let i = 0; i < ideal.length; i++) {
    offset.push(acc);
    acc += heights[i] + gap;
  }
  const blocks: { sum: number; n: number }[] = [];
  for (let i = 0; i < ideal.length; i++) {
    blocks.push({ sum: ideal[i] - offset[i], n: 1 });
    while (blocks.length > 1 && blocks[blocks.length - 2].sum / blocks[blocks.length - 2].n > blocks[blocks.length - 1].sum / blocks[blocks.length - 1].n) {
      const b = blocks.pop()!;
      blocks[blocks.length - 1].sum += b.sum;
      blocks[blocks.length - 1].n += b.n;
    }
  }
  const out: number[] = [];
  for (const b of blocks) for (let k = 0; k < b.n; k++) out.push(snapTo(b.sum / b.n + offset[out.length]));
  // snapping can close a gap by a step: open it again
  for (let i = 1; i < out.length; i++) out[i] = Math.max(out[i], out[i - 1] + snapUp(heights[i - 1]) + gap);
  return out;
}

/** What the layout and the rail taps share: the clusters of a board level. */
export interface BoardClusters {
  /** Cluster (its anchor's id) of each component. */
  clusterOf: Map<string, string>;
  /** Members of each cluster: the anchor first, then its satellites in reading order. */
  clusters: Map<string, string[]>;
  /** Function group of each cluster. */
  group: Map<string, FunctionGroup>;
  /** Component members of each junction. */
  members: Map<string, string[]>;
  /** Component ↔ component lines (two-member nets of their own). */
  direct: [string, string][];
}

/** Cluster a board level's components: each passive with the part it serves, a dedicated connector with its part. */
export function boardClusters(nodes: BoardNode[], edges: [string, string][]): BoardClusters {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const comps = nodes.filter((n) => !n.net).sort((a, b) => natural(a.id, b.id));

  // nets as member sets; component ↔ component lines count as two-member nets
  const memberSets = new Map<string, Set<string>>();
  const direct: [string, string][] = [];
  for (const [a, b] of edges) {
    const na = byId.get(a);
    const nb = byId.get(b);
    if (!na || !nb || a === b) continue;
    if (na.net && !nb.net) memberSets.set(a, (memberSets.get(a) ?? new Set()).add(b));
    else if (nb.net && !na.net) memberSets.set(b, (memberSets.get(b) ?? new Set()).add(a));
    else if (!na.net && !nb.net) direct.push([a, b]);
  }
  const members = new Map([...memberSets].map(([k, s]) => [k, [...s].sort(natural)]));
  const nets: string[][] = [...members.values(), ...direct];
  const affinity = affinities(nets);

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
  const sats = new Map<string, string[]>();
  for (const n of comps) {
    const a = satellite(n) || !group.has(n.id) ? anchorOf(n.id) : n.id;
    if (!group.has(a)) group.set(a, "other");
    if (a !== n.id) sats.set(a, [...(sats.get(a) ?? []), n.id]);
    else if (!sats.has(a)) sats.set(a, []);
  }
  const clusters = new Map<string, string[]>();
  const clusterOf = new Map<string, string>();
  for (const [a, list] of sats) {
    // satellites listed by what they hang from (Y1's load caps beside Y1), then by id
    const chain = (id: string): string[] => (parentOf.has(id) && parentOf.get(id) !== a && list.includes(parentOf.get(id)!) ? [...chain(parentOf.get(id)!), id] : [id]);
    list.sort((x, y) => {
      const cx = chain(x);
      const cy = chain(y);
      return natural(cx[0], cy[0]) || cx.length - cy.length || natural(x, y);
    });
    clusters.set(a, [a, ...list]);
    for (const id of [a, ...list]) clusterOf.set(id, a);
  }
  return { clusterOf, clusters, group, members, direct };
}

/** Affinity between components: a net of n members adds 1/(n−1) to each pair (a rail says little). */
function affinities(nets: string[][]): Map<string, Map<string, number>> {
  const affinity = new Map<string, Map<string, number>>();
  const add = (a: string, b: string, w: number) => {
    const m = affinity.get(a) ?? new Map<string, number>();
    m.set(b, (m.get(b) ?? 0) + w);
    affinity.set(a, m);
  };
  for (const set of nets) {
    if (set.length < 2) continue;
    const w = 1 / (set.length - 1);
    for (let i = 0; i < set.length; i++)
      for (let j = i + 1; j < set.length; j++) {
        add(set[i], set[j], w);
        add(set[j], set[i], w);
      }
  }
  return affinity;
}

interface Cluster {
  id: string;
  col: number;
  w: number;
  h: number;
  /** Offsets of each card inside the cluster. */
  cards: Record<string, { x: number; y: number }>;
}

/**
 * Top-left positions by node id for a board level. `edges` are the lines
 * drawn between nodes (component ↔ junction, or component ↔ component).
 */
export function boardLayout(nodes: BoardNode[], edges: [string, string][]): Record<string, { x: number; y: number }> {
  if (!nodes.length) return {};
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const hubs = nodes.filter((n) => n.net).sort((a, b) => natural(a.id, b.id));
  const { clusterOf, clusters, group, members, direct } = boardClusters(nodes, edges);
  const hubMembers = (id: string) => members.get(id) ?? [];

  // ---- cluster shapes: the anchor on top, its satellites in up to two stacks below it ----
  // (left and right: a satellite goes on the side its junctions are, so its lines leave the cluster
  // without crossing the other stack; before the sides are known, alternately)
  const shapeCluster = (c: Cluster, side?: (id: string) => "L" | "R", order?: (id: string) => number) => {
    const [a, ...sats] = clusters.get(c.id)!;
    const an = byId.get(a)!;
    const cards: Record<string, { x: number; y: number }> = {};
    if (!sats.length) {
      cards[a] = { x: 0, y: 0 };
      Object.assign(c, { w: an.w, h: an.h, cards });
      return;
    }
    let L = sats.filter((id, i) => (side ? side(id) === "L" : i % 2 === 1));
    let R = sats.filter((id) => !L.includes(id));
    if (order) {
      L = L.slice().sort((x, y) => order(x) - order(y));
      R = R.slice().sort((x, y) => order(x) - order(y));
    }
    const stackW = (ids: string[]) => (ids.length ? Math.max(...ids.map((id) => byId.get(id)!.w)) : 0);
    const wl = stackW(L);
    const wr = stackW(R);
    const both = wl && wr;
    const gridW = wl + wr + (both ? GAP_IN_X : 0);
    const w = Math.max(an.w, gridW);
    cards[a] = { x: snapTo((w - an.w) / 2), y: 0 };
    const x0 = snapTo((w - gridW) / 2);
    let h = an.h;
    for (const [ids, x, sw] of [
      [L, x0, wl],
      [R, x0 + (wl ? wl + GAP_IN_X : 0), wr],
    ] as [string[], number, number][]) {
      let y = snapUp(an.h + GAP_IN_Y);
      for (const id of ids) {
        const n = byId.get(id)!;
        // a stack's cards line up on the cluster's outer edge (the side their lines leave from)
        cards[id] = { x: snapTo(ids === L ? x : x + sw - n.w), y };
        y = snapUp(y + n.h + GAP_IN_Y);
        h = Math.max(h, y - GAP_IN_Y);
      }
    }
    Object.assign(c, { w, h, cards });
  };
  const shapes: Cluster[] = [...clusters.keys()].map((id) => {
    const c: Cluster = { id, col: 0, w: 0, h: 0, cards: {} };
    shapeCluster(c);
    return c;
  });
  const shapeOf = new Map(shapes.map((c) => [c.id, c]));

  // cluster ↔ cluster weights, from the nets (each junction's members) and the direct lines
  // (a rail's taps count as the one net they are: what a rail joins belongs near its source, if weakly)
  const merged = new Map<string, Set<string>>();
  for (const [hub, list] of members) {
    const key = byId.get(hub)?.tapOf ?? hub;
    merged.set(key, new Set([...(merged.get(key) ?? []), ...list]));
  }
  const clusterWeights = (nets: string[][]) => {
    const out = new Map<string, Map<string, number>>();
    for (const [a, m] of affinities(nets)) {
      const ca = clusterOf.get(a);
      if (!ca) continue;
      for (const [b, w] of m) {
        const cb = clusterOf.get(b);
        if (!cb || ca === cb) continue;
        const row = out.get(ca) ?? new Map<string, number>();
        row.set(cb, (row.get(cb) ?? 0) + w);
        out.set(ca, row);
      }
    }
    return out;
  };
  const cw = clusterWeights([...[...merged.values()].map((x) => [...x]), ...direct]);
  // the lines actually drawn (a rail's taps stay within their cluster), for who drives whom
  const drawnCw = clusterWeights([...members.values(), ...direct]);

  // ---- columns: by function; a peripheral driven only by another peripheral one column further out ----
  const hasMcu = shapes.some((c) => group.get(c.id) === "mcu");
  for (const c of shapes) c.col = hasMcu ? GROUP_COLUMN[group.get(c.id)!] : GROUP_ORDER.indexOf(group.get(c.id)!);
  if (hasMcu) {
    for (let round = 0; round < 3; round++) {
      for (const c of shapes) {
        if (c.col < 3) continue;
        const ns = [...(drawnCw.get(c.id) ?? [])].map(([o]) => shapeOf.get(o)!);
        if (!ns.length || ns.some((o) => o.col < 3)) continue;
        // only to peripherals: beside the one it hangs from (the most connected)
        const best = [...(drawnCw.get(c.id) ?? [])].sort((a, b) => b[1] - a[1] || natural(a[0], b[0]))[0][0];
        const driver = shapeOf.get(best)!;
        // the driver itself answers to the processor or the power stage (two peripherals joined only to each other stay put)
        const driven = [...(drawnCw.get(driver.id) ?? [])].some(([o]) => shapeOf.get(o)!.col < 3);
        if (driven && driver.col >= c.col) c.col = driver.col + 1;
      }
    }
  }
  const used = [...new Set(shapes.map((c) => c.col))].sort((a, b) => a - b);
  for (const c of shapes) c.col = used.indexOf(c.col);

  // wrap a column taller than a landscape sheet allows into several
  const area = shapes.reduce((s, c) => s + (c.w + 2 * CHANNEL_PAD + 160) * (c.h + GAP_CLUSTER), 0);
  // (never below a screen's worth: a short column stays one column)
  const maxH = Math.max(Math.max(...shapes.map((c) => c.h)), Math.sqrt(area / 1.6), WRAP_MIN);
  const byCol: Cluster[][] = used.map((_, i) => shapes.filter((c) => c.col === i).sort((a, b) => b.h * b.w - a.h * a.w || natural(a.id, b.id)));
  const columns: Cluster[][] = [];
  for (const col of byCol) {
    const total = col.reduce((s, c) => s + c.h + GAP_CLUSTER, -GAP_CLUSTER);
    const n = Math.max(1, Math.ceil(total / maxH));
    const per = Math.ceil(col.length / n);
    for (let k = 0; k < n; k++) if (col.slice(k * per, k * per + per).length) columns.push(col.slice(k * per, k * per + per));
  }
  columns.forEach((col, i) => col.forEach((c) => (c.col = i)));

  const colOf = (id: string) => shapeOf.get(clusterOf.get(id)!)!.col;

  // ---- junctions: a channel each (channel k lies right of column k; −1 left of the first) ----
  const channelHubs = new Map<number, BoardNode[]>();
  const lastCol = columns.length - 1;
  const load = new Map<number, number>();
  const ordered = hubs.slice().sort((a, b) => hubMembers(b.id).length - hubMembers(a.id).length || natural(a.id, b.id));
  for (const hub of ordered) {
    const m = hubMembers(hub.id).filter((id) => clusterOf.has(id));
    let ch: number;
    if (!m.length) ch = lastCol;
    else {
      const cols = m.map(colOf).sort((a, b) => a - b);
      const lo = cols[0];
      const hi = cols[cols.length - 1];
      if (lo === hi) {
        // all in one column: the side with less in it already (the outer side of the edge columns last)
        const sides = [lo - 1, lo].filter((k) => k >= 0 && k < lastCol);
        const pool = sides.length ? sides : [lo === 0 ? 0 : lo - 1];
        ch = pool.sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0) || b - a)[0];
        if (lastCol === 0) ch = 0;
      } else {
        // the channel with as many members on either side as it can have
        let best = lo;
        let score = Infinity;
        for (let k = lo; k < hi; k++) {
          const s = cols.reduce((t, c) => t + Math.abs(c - (k + 0.5)), 0);
          if (s < score - 1e-9) [best, score] = [k, s];
        }
        ch = best;
      }
    }
    channelHubs.set(ch, [...(channelHubs.get(ch) ?? []), hub]);
    load.set(ch, (load.get(ch) ?? 0) + 1);
  }

  // a junction is as tall as the ports on its busier side need (members left of its channel on its left)
  const hubH = new Map<string, number>();
  for (const [ch, list] of channelHubs)
    for (const h of list) {
      const m = hubMembers(h.id).filter((id) => clusterOf.has(id));
      const left = m.filter((id) => colOf(id) <= ch).length;
      hubH.set(h.id, Math.max(h.h, (Math.max(left, m.length - left) + 1) * STEP));
    }
  const H = (h: BoardNode) => hubH.get(h.id) ?? h.h;

  // cards as tall as their busier side will be (junctions left of their column on the left)
  for (const n of nodes) {
    if (n.net || !n.heightFor || !clusterOf.has(n.id)) continue;
    const chs = [...channelHubs].flatMap(([ch, list]) => list.filter((h) => hubMembers(h.id).includes(n.id)).map(() => ch));
    const l = chs.filter((ch) => ch < colOf(n.id)).length;
    const h = n.heightFor(Math.max(l, chs.length - l) + (n.otherPorts ?? 0) + 1);
    if (h > n.h) byId.set(n.id, { ...n, h });
  }
  for (const c of shapes) shapeCluster(c);

  // satellites to the side of the channel their junctions are in (the side with fewer, for one with none)
  const hubsOf = new Map<string, string[]>();
  for (const [ch, list] of channelHubs) for (const h of list) for (const m of hubMembers(h.id)) hubsOf.set(m, [...(hubsOf.get(m) ?? []), h.id]);
  const channelOf = new Map<string, number>();
  for (const [ch, list] of channelHubs) for (const h of list) channelOf.set(h.id, ch);
  const sideOf = new Map<string, "L" | "R">();
  for (const c of shapes) {
    const sats = clusters.get(c.id)!.slice(1);
    let nl = 0;
    let nr = 0;
    for (const id of sats) {
      const chs = (hubsOf.get(id) ?? []).map((h) => channelOf.get(h)!);
      const l = chs.filter((ch) => ch < c.col).length;
      const r = chs.length - l;
      const side = l > r || (l === r && !chs.length && nl < nr) ? "L" : "R";
      sideOf.set(id, side);
      if (side === "L") nl++;
      else nr++;
    }
    shapeCluster(c, (id) => sideOf.get(id)!);
  }

  // each junction hangs off its smallest member card (the LED, not its driver): the cluster of that card
  // is given room down the side of the junction's channel for it, so a channel's junctions fit one lane
  const demand = new Map<string, { L: number; R: number }>();
  for (const [ch, list] of channelHubs)
    for (const h of list) {
      const m = hubMembers(h.id).filter((id) => clusterOf.has(id));
      if (!m.length) continue;
      const owner = m.slice().sort((a, b) => byId.get(a)!.h - byId.get(b)!.h || natural(a, b))[0];
      const c = clusterOf.get(owner)!;
      const d = demand.get(c) ?? { L: 0, R: 0 };
      d[ch < colOf(owner) ? "L" : "R"] += H(h) + HUB_GAP_Y;
      demand.set(c, d);
    }
  const slot = (c: Cluster) => snapUp(Math.max(c.h, demand.get(c.id)?.L ?? 0, demand.get(c.id)?.R ?? 0));

  // ---- heights: barycentre sweeps, then each column packed toward the height of what it joins ----
  // (`top` is the top of a cluster's slot: its cards sit in the middle of it)
  const top = new Map<string, number>();
  const mid = (c: Cluster) => top.get(c.id)! + slot(c) / 2;
  for (const col of columns) {
    const total = col.reduce((s, c) => s + slot(c) + GAP_CLUSTER, -GAP_CLUSTER);
    let y = snapTo((maxH - total) / 2);
    for (const c of col) {
      top.set(c.id, y);
      y += slot(c) + GAP_CLUSTER;
    }
  }
  const sweepOrder = columns.map((_, i) => i).sort((a, b) => columns[b].reduce((s, c) => s + slot(c), 0) - columns[a].reduce((s, c) => s + slot(c), 0));
  for (let sweep = 0; sweep < 8; sweep++) {
    // the tallest column first: the others line up with it
    for (const i of sweep === 0 ? sweepOrder.slice(1) : sweepOrder) {
      const col = columns[i];
      const key = new Map<string, number>();
      for (const c of col) {
        let s = 0;
        let n = 0;
        for (const [o, w] of cw.get(c.id) ?? []) {
          const oc = shapeOf.get(o)!;
          if (oc.col === c.col) continue;
          // nearer columns pull harder
          const k = w / Math.abs(oc.col - c.col);
          s += mid(oc) * k;
          n += k;
        }
        key.set(c.id, n ? s / n : NaN);
      }
      // a cluster joined to nothing in another column (a cell's pads on a tapped rail) goes last, packed
      const last = Math.max(0, ...col.map((c) => key.get(c.id)!).filter((k) => !Number.isNaN(k)));
      for (const c of col) if (Number.isNaN(key.get(c.id)!)) key.set(c.id, last + 1);
      col.sort((a, b) => key.get(a.id)! - key.get(b.id)! || natural(a.id, b.id));
      const ys = pack(col.map((c) => key.get(c.id)! - slot(c) / 2), col.map(slot), GAP_CLUSTER);
      col.forEach((c, k) => top.set(c.id, ys[k]));
    }
  }

  // card positions without x yet: x comes once the channels are sized
  const cardY = new Map<string, number>();
  const cardMidY = (id: string) => cardY.get(id)! + byId.get(id)!.h / 2;
  const setCardY = () => {
    for (const c of shapes) for (const [id, o] of Object.entries(c.cards)) cardY.set(id, top.get(c.id)! + snapTo((slot(c) - c.h) / 2) + o.y);
  };
  setCardY();

  // lanes: junctions in order of the height of what they join; a new lane where one would be pushed far
  interface Lane {
    hubs: BoardNode[];
    ideal: number[];
  }
  // a junction's height: where the lines to it run shortest. A card's port can sit anywhere along its
  // side, so each member is the span of its card, and the best height is the one nearest every span
  // (ties: nearest the weighted mean of their middles)
  const hubIdeal = (h: BoardNode) => {
    const m = hubMembers(h.id).filter((id) => cardY.has(id));
    if (!m.length) return maxH / 2;
    const spans = m.map((id) => {
      const t = cardY.get(id)!;
      const bh = byId.get(id)!.h;
      const inset = Math.min(32, bh / 2);
      return [t + inset, t + bh - inset] as [number, number];
    });
    const cost = (y: number) => spans.reduce((s, [a, b]) => s + (y < a ? a - y : y > b ? y - b : 0), 0);
    // the middles weighted toward the small cards (an LED's junction sits by the LED, not its driver's middle)
    const wt = (id: string) => 1 / byId.get(id)!.h ** 2;
    const mean = m.reduce((s, id) => s + cardMidY(id) * wt(id), 0) / m.reduce((s, id) => s + wt(id), 0);
    let best = mean;
    let bc = cost(mean);
    for (const y of spans.flat()) {
      const c = cost(y);
      if (c < bc - 1e-6 || (Math.abs(c - bc) < 1e-6 && Math.abs(y - mean) < Math.abs(best - mean))) [best, bc] = [y, c];
    }
    // within the best range, as near the mean as it allows
    const lo = Math.min(...spans.flat().filter((y) => Math.abs(cost(y) - bc) < 1e-6), best);
    const hi = Math.max(...spans.flat().filter((y) => Math.abs(cost(y) - bc) < 1e-6), best);
    return Math.max(lo, Math.min(hi, mean));
  };
  const makeLanes = () => {
  const channelLanes = new Map<number, Lane[]>();
  for (const [ch, list] of channelHubs) {
    const sorted = list.slice().sort((a, b) => hubIdeal(a) - hubIdeal(b) || natural(a.id, b.id));
    const lanes: Lane[] = [];
    const bottoms: number[] = [];
    for (const h of sorted) {
      const ideal = hubIdeal(h) - H(h) / 2;
      let pick = -1;
      let push = Infinity;
      bottoms.forEach((b, i) => {
        const p = Math.max(0, b + HUB_GAP_Y - ideal);
        if (p < push - 1e-9) [pick, push] = [i, p];
      });
      // lanes side by side cross each other's lines: a second one only where one lane would push far
      if (pick < 0 || (push > LANE_PUSH && lanes.length < 3)) {
        lanes.push({ hubs: [], ideal: [] });
        bottoms.push(-Infinity);
        pick = lanes.length - 1;
      }
      lanes[pick].hubs.push(h);
      lanes[pick].ideal.push(ideal);
      bottoms[pick] = Math.max(bottoms[pick] + HUB_GAP_Y, ideal) + H(h);
    }
    channelLanes.set(ch, lanes);
  }
  return channelLanes;
  };

  // place the junctions once, then order each satellite stack by the height of its junctions, and again
  let channelLanes = makeLanes();
  const hubMid = new Map<string, number>();
  for (const lanes of channelLanes.values())
    for (const lane of lanes) {
      const ys = pack(lane.ideal, lane.hubs.map(H), HUB_GAP_Y);
      lane.hubs.forEach((h, i) => hubMid.set(h.id, ys[i] + H(h) / 2));
    }
  const satKey = (id: string) => {
    const hs = (hubsOf.get(id) ?? []).filter((h) => hubMid.has(h));
    return hs.length ? hs.reduce((t, h) => t + hubMid.get(h)!, 0) / hs.length : cardMidY(id);
  };
  for (const c of shapes) if (clusters.get(c.id)!.length > 2) shapeCluster(c, (id) => sideOf.get(id)!, satKey);
  setCardY();
  channelLanes = makeLanes();

  // lines into each side of a channel: room for their vertical runs
  const sideLines = (ch: number, side: "left" | "right") => {
    let n = 0;
    for (const h of channelHubs.get(ch) ?? []) for (const m of hubMembers(h.id)) if (clusterOf.has(m) && (side === "left" ? colOf(m) <= ch : colOf(m) > ch)) n++;
    return n;
  };
  const pad = (n: number) => snapUp(CHANNEL_PAD + Math.min(320, n * 8));

  // ---- x: columns and channels left to right ----
  const out: Record<string, { x: number; y: number }> = {};
  let x = 0;
  const place = (ch: number) => {
    const lanes = channelLanes.get(ch) ?? [];
    if (!lanes.length) {
      x += ch < 0 || ch >= lastCol ? 0 : snapUp(2 * CHANNEL_PAD + 64);
      return;
    }
    x += pad(sideLines(ch, "left"));
    for (const lane of lanes) {
      const w = Math.max(...lane.hubs.map((h) => h.w));
      const ys = pack(lane.ideal, lane.hubs.map(H), HUB_GAP_Y);
      lane.hubs.forEach((h, i) => (out[h.id] = { x: snapTo(x + (w - h.w) / 2), y: ys[i] }));
      x += w + LANE_GAP;
    }
    x += pad(sideLines(ch, "right")) - LANE_GAP;
  };
  place(-1);
  columns.forEach((col, i) => {
    const w = Math.max(...col.map((c) => c.w));
    for (const c of col) {
      const cx = snapTo(x + (w - c.w) / 2);
      for (const [id, o] of Object.entries(c.cards)) out[id] = { x: cx + o.x, y: cardY.get(id)! };
    }
    x = snapUp(x + w);
    place(i);
  });

  const all = Object.values(out);
  const minX = Math.min(...all.map((p) => p.x));
  const minY = Math.min(...all.map((p) => p.y));
  for (const p of all) {
    p.x -= minX;
    p.y -= minY;
  }
  return out;
}
