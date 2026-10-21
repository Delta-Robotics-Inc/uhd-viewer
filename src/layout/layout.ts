/**
 * Layout: node boxes, port placement, and link routes for one level.
 * Layout data lives outside UHD (design D3, D6); a level can ship a hand
 * layout (from the bundle's display hints) and the user's drags override it.
 */
import { CARD_W, cardHeight, cardInsets, cardWidth } from "./card-body";
import type { ViewLink, ViewModel, ViewNode, ViewPort } from "../model/types";
import { route, type Pt, type Side } from "../canvas/routing";
import { GridRouter, GRID, snap } from "./router";
import { at, clearOfBends, lengths } from "../canvas/geometry";
import type { LinkLayout } from "../api";
import { boardLayout, freeSpot, hits } from "./board-layout";
import { gridLayout } from "./module-layout";

/** Distance kept between a corner and anything placed on a link (handles, toggles). */
export const BEND_CLEAR = 28;
/** How far a link keeps its label from a corner (LinkEdge: the corner radius, half a toggle, 4 px). */
const LABEL_CLEAR = 24;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A link's hand layout: part of the host contract (src/api.ts). */
export type { LinkLayout };

export interface LevelLayout {
  /** Top-level nodes: absolute. Nodes inside a container: relative to it. */
  nodes: Record<string, Partial<Box>>;
  /** Port side overrides keyed "node|port". */
  ports?: Record<string, Side>;
  links?: Record<string, LinkLayout>;
}

export interface PlacedPort {
  node: string;
  port: ViewPort;
  side: Side;
  /** Absolute position on the node outline. */
  x: number;
  y: number;
  /** Colour key: the link that decides this port's classification colour. */
  links: ViewLink[];
}

export interface PortGroup {
  protocol: string;
  domain: string;
  count: number;
}

export interface ComputedLayout {
  boxes: Record<string, Box>;
  ports: Record<string, PlacedPort>;
  /** Unlinked ports summarised per node (design D6: "UART ×4"). */
  groups: Record<string, PortGroup[]>;
  routes: Record<string, Pt[]>;
  /** Label anchor per link (absent: route too short to label). */
  labels: Record<string, Pt>;
  /** Label + toggle position as an arc length along the route. */
  labelAt: Record<string, number>;
  /** Harness region span along the route (arc lengths), for links that run through one. */
  runs: Record<string, [number, number]>;
  /** Pinned waypoints per link, and the automatic ones (the router's own bends). */
  pins: Record<string, Pt[]>;
  bends: Record<string, Pt[]>;
  /** Links whose label (and expansion point) the user or the display file placed. */
  labelFixed: Record<string, boolean>;
  /** The display file's and the user's label and tab placement per link, merged. */
  edits: Record<string, LinkLayout>;
}

export const portKey = (node: string, port: string) => `${node}|${port}`;

const PORT_PITCH = 22;

/** A card's size before it is placed: as wide as the labels of its linked interfaces (`labels`) need. */
function defaultSize(node: ViewNode, visiblePorts: number, labels: readonly string[] = []): { w: number; h: number } {
  if (node.sheetPort) return { w: 150, h: 30 };
  if (node.kind === "harness") return { w: 150, h: Math.max(30, 14 + (visiblePorts / 2) * 16) };
  // a net junction: as wide as its name, as tall as its busiest side needs (grown once ports have sides)
  if (node.kind === "net") return { w: Math.max(64, node.label.length * 8 + 40), h: 32 };
  if (node.shape === "circle") return /prop/i.test(node.label) ? { w: 60, h: 60 } : { w: 78, h: 78 };
  const perSide = Math.ceil(visiblePorts / 2);
  return { w: labels.length ? cardWidth(labels) : CARD_W, h: Math.max(84, 40 + perSide * PORT_PITCH) };
}

function center(b: Box): Pt {
  return [b.x + b.w / 2, b.y + b.h / 2];
}

function sideFacing(from: Box, to: Pt): Side {
  const [cx, cy] = center(from);
  const dx = to[0] - cx;
  const dy = to[1] - cy;
  // normalise by the box aspect so wide boxes prefer top/bottom less eagerly
  const nx = dx / (from.w / 2 + 40);
  const ny = dy / (from.h / 2 + 40);
  if (Math.abs(nx) >= Math.abs(ny)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

/** How an automatic layout starts (PB-1007): cards that keep their places, and an earlier arrangement to keep. */
export interface ArrangeOptions {
  /** Top-level cards that stay where they are (top-left). */
  fixed?: Record<string, { x: number; y: number }>;
  /** Each top-level card's centre in an earlier layout: the arrangement to start from. */
  seed?: Record<string, { x: number; y: number }>;
  /** The old default (one row), for comparing against. */
  legacy?: boolean;
}

/**
 * Auto layout for levels without a hand layout: modules in a grid shaped like
 * a screen, each beside what it connects to (module-layout.ts), and each sheet
 * port (the drilled-into module's boundary) on the canvas edge nearest the
 * child it exposes, stacked beside it. A level with nets is laid out as a
 * board (board-layout.ts).
 */
function autoPositions(vm: ViewModel, sizes: Record<string, { w: number; h: number }>, opts: ArrangeOptions = {}): Record<string, Box> {
  const top = vm.nodes.filter((n) => !n.parent && !n.sheetPort);
  const sheets = vm.nodes.filter((n) => n.sheetPort);
  if (top.some((n) => n.kind === "net")) {
    const boxes = netPositions(vm, top, sheets, sizes);
    for (const [id, p] of Object.entries(opts.fixed ?? {})) if (boxes[id]) Object.assign(boxes[id], p);
    return boxes;
  }
  if (opts.legacy) return rowPositions(vm, sizes);
  const ids = new Set(top.map((n) => n.id));
  const topOf = (id: string) => (ids.has(id) ? id : [...ids].find((t) => id.startsWith(`${t}/`)));
  const edges: [string, string][] = [];
  for (const l of vm.links) {
    if (l.passThrough || l.ground) continue;
    const a = topOf(l.source.node);
    const b = topOf(l.target.node);
    if (a && b && a !== b) edges.push([a, b]);
  }
  const at = gridLayout(
    top.map((n) => ({ id: n.id, ...sizes[n.id], category: n.category })),
    edges,
    { fixed: opts.fixed, seed: opts.seed },
  );
  const x0 = sheets.length ? 400 : 60;
  const y0 = 100;
  const boxes: Record<string, Box> = {};
  const fixed = opts.fixed ?? {};
  for (const n of top) boxes[n.id] = fixed[n.id] ? { ...fixed[n.id], ...sizes[n.id] } : { x: at[n.id].x + (Object.keys(fixed).length ? 0 : x0), y: at[n.id].y + (Object.keys(fixed).length ? 0 : y0), ...sizes[n.id] };
  placeSheets(boxes, sheets, sizes, y0);
  return boxes;
}

/** The layout before PB-1007: modules in one centred row (kept to measure against). */
function rowPositions(vm: ViewModel, sizes: Record<string, { w: number; h: number }>): Record<string, Box> {
  const boxes: Record<string, Box> = {};
  const top = vm.nodes.filter((n) => !n.parent && !n.sheetPort);
  const sheets = vm.nodes.filter((n) => n.sheetPort);
  const gapX = 300;
  const rowY = 140;
  let x = sheets.length ? 460 : 60;
  for (const n of top) {
    const s = sizes[n.id];
    boxes[n.id] = { x, y: rowY, ...s };
    x += s.w + gapX;
  }
  const rowRight = x - gapX;
  const mid = (sheets.length ? 460 : 60) + (rowRight - (sheets.length ? 460 : 60)) / 2;
  const columns: Record<"left" | "right", ViewNode[]> = { left: [], right: [] };
  for (const sheet of sheets) {
    const child = sheet.ports[0]?.exported?.child;
    const b = child ? boxes[child] : undefined;
    columns[b && b.x + b.w / 2 > mid ? "right" : "left"].push(sheet);
  }
  const rowH = Math.max(...top.map((n) => sizes[n.id].h), 100);
  for (const side of ["left", "right"] as const) {
    const col = columns[side];
    const pitch = 54;
    const y0 = rowY + rowH / 2 - ((col.length - 1) * pitch) / 2;
    col.forEach((n, i) => {
      const s = sizes[n.id];
      boxes[n.id] = { x: side === "left" ? 60 : rowRight + 180, y: y0 + i * pitch, ...s };
    });
  }
  return boxes;
}

/**
 * A level with nets (a board): components grouped by function and junctions
 * beside what they join (board-layout.ts), and each sheet port on the left
 * or right edge level with the child it exposes.
 */
function netPositions(vm: ViewModel, top: ViewNode[], sheets: ViewNode[], sizes: Record<string, { w: number; h: number }>): Record<string, Box> {
  const ids = new Set(top.map((n) => n.id));
  const edges = vm.links
    .filter((l) => !l.passThrough && !l.ground && ids.has(l.source.node) && ids.has(l.target.node))
    .map((l) => [l.source.node, l.target.node] as [string, string]);
  const degree = new Map<string, number>();
  for (const [a, b] of edges) for (const id of [a, b]) degree.set(id, (degree.get(id) ?? 0) + 1);
  // a junction grows to fit its ports once they have sides: lay it out at the size it will likely have
  const planned = (n: ViewNode) => (n.kind === "net" ? { w: sizes[n.id].w, h: Math.max(sizes[n.id].h, (Math.ceil((degree.get(n.id) ?? 0) / 2) + 1) * GRID) } : sizes[n.id]);
  const grows = (n: ViewNode) => n.kind !== "net" && n.shape !== "circle";
  const isNet = new Set(top.filter((n) => n.kind === "net").map((n) => n.id));
  const otherPorts = (id: string) =>
    new Set(
      vm.links
        .filter((l) => !l.ground && (l.source.node === id || l.target.node === id) && !isNet.has(l.source.node) && !isNet.has(l.target.node))
        .map((l) => (l.source.node === id ? l.source.port : l.target.port)),
    ).size;
  const at = boardLayout(
    top.map((n) => ({
      id: n.id,
      ...planned(n),
      net: n.kind === "net",
      ...(n.tapOf ? { tapOf: n.tapOf } : {}),
      category: n.category,
      label: n.label,
      ...(grows(n) ? { heightFor: (k: number) => Math.ceil((44 + k * PORT_PITCH) / GRID) * GRID, otherPorts: otherPorts(n.id) } : {}),
    })),
    edges,
  );
  const x0 = sheets.length ? 400 : 60;
  const y0 = 100;
  const boxes: Record<string, Box> = {};
  for (const n of top) boxes[n.id] = { x: at[n.id].x + x0, y: at[n.id].y + y0, ...sizes[n.id] };
  placeSheets(boxes, sheets, sizes, y0);
  return boxes;
}

/** Sheet ports (the drilled-into module's boundary) in a column on the left or right edge, level with the child each exposes. */
function placeSheets(boxes: Record<string, Box>, sheets: ViewNode[], sizes: Record<string, { w: number; h: number }>, y0: number) {
  const placed = Object.values(boxes);
  if (!sheets.length || !placed.length) return;
  const minX = Math.min(...placed.map((b) => b.x));
  const maxX = Math.max(...placed.map((b) => b.x + b.w));
  const mid = (minX + maxX) / 2;
  const columns: Record<"left" | "right", { node: ViewNode; y: number }[]> = { left: [], right: [] };
  for (const sheet of sheets) {
    const b = boxes[sheet.ports[0]?.exported?.child ?? ""];
    const side = b && b.x + b.w / 2 > mid ? "right" : "left";
    columns[side].push({ node: sheet, y: b ? b.y + b.h / 2 - sizes[sheet.id].h / 2 : y0 });
  }
  for (const side of ["left", "right"] as const) {
    let last = -Infinity;
    for (const { node, y } of columns[side].sort((a, b) => a.y - b.y)) {
      const s = sizes[node.id];
      const top = Math.max(y, last + 54);
      boxes[node.id] = { x: side === "left" ? minX - 340 : maxX + 180, y: top, ...s };
      last = top;
    }
  }
}

/**
 * Positions for the nodes a hand layout does not name (a part added since
 * the layout was saved, or the junctions of a layout that placed only the
 * components): each at the free spot nearest the nodes it is linked to,
 * sheet ports on the edges. Top-level nodes only; absolute.
 */
function fillMissing(vm: ViewModel, hand: LevelLayout, sizes: Record<string, { w: number; h: number }>): Record<string, Box> {
  const top = vm.nodes.filter((n) => !n.parent);
  const missing = top.filter((n) => !hand.nodes[n.id] || hand.nodes[n.id].x === undefined || hand.nodes[n.id].y === undefined);
  if (!missing.length) return {};
  const boxes: Record<string, Box> = {};
  for (const n of top) if (!missing.includes(n)) boxes[n.id] = { x: hand.nodes[n.id].x!, y: hand.nodes[n.id].y!, ...sizes[n.id] };
  const known = Object.values(boxes);
  const right = known.length ? Math.max(...known.map((b) => b.x + b.w)) : 60;
  const bottom = known.length ? Math.max(...known.map((b) => b.y + b.h)) : 60;
  const neighbours = (id: string) =>
    vm.links
      .filter((l) => !l.passThrough && !l.ground && (l.source.node === id || l.target.node === id))
      .map((l) => (l.source.node === id ? l.target.node : l.source.node))
      .map((o) => o.split("/")[0])
      .filter((o) => boxes[o]);
  const out: Record<string, Box> = {};
  // most-connected first, so a junction lands among its members before a lone part takes the spot
  const order = missing.filter((n) => !n.sheetPort).sort((a, b) => neighbours(b.id).length - neighbours(a.id).length || a.id.localeCompare(b.id));
  for (const n of order) {
    const ns = neighbours(n.id);
    const s = sizes[n.id];
    const ideal: [number, number] = ns.length
      ? [ns.reduce((t, o) => t + boxes[o].x + boxes[o].w / 2, 0) / ns.length, ns.reduce((t, o) => t + boxes[o].y + boxes[o].h / 2, 0) / ns.length]
      : [right + 120 + s.w / 2, bottom + 80];
    const at = freeSpot(ideal, s.w, s.h, Object.values(boxes), { x: 40, y: 24 });
    boxes[n.id] = out[n.id] = { ...at, ...s };
  }
  const sheets = missing.filter((n) => n.sheetPort);
  if (sheets.length) {
    const withSheets: Record<string, Box> = { ...boxes };
    placeSheets(withSheets, sheets, sizes, 100);
    for (const n of sheets) out[n.id] = withSheets[n.id];
  }
  return out;
}

/** Room kept inside a container expanded in place: left and right of its modules, under its label, and below them (where its links run). */
const CONTAINER_PAD = { left: 48, top: 64, right: 48, bottom: 48 };

/**
 * A module expanded in place whose children the display file does not place
 * (PB-897): the children are laid out as their own level would be (a row, or
 * a board's clusters and junctions), inside the container, and the container
 * takes the size that holds them with room for their links. Deepest
 * containers first, so one that holds another is laid out around its size.
 * Returns the children's positions relative to their container; `sizes` gets
 * the containers' sizes. A container the display file sizes, or whose
 * children it places, is left as it says.
 */
function containerLayouts(vm: ViewModel, hand: LevelLayout | undefined, sizes: Record<string, { w: number; h: number }>, arrange: ArrangeOptions = {}): Record<string, { x: number; y: number }> {
  const rel: Record<string, { x: number; y: number }> = {};
  const depth = (id: string) => {
    let d = 0;
    for (let n = vm.nodes.find((x) => x.id === id); n?.parent; n = vm.nodes.find((x) => x.id === n!.parent)) d++;
    return d;
  };
  const containers = vm.nodes.filter((n) => n.expanded).sort((a, b) => depth(b.id) - depth(a.id));
  for (const c of containers) {
    const kids = vm.nodes.filter((n) => n.parent === c.id);
    if (!kids.length) continue;
    const placed = (n: ViewNode) => hand?.nodes[n.id]?.x !== undefined && hand?.nodes[n.id]?.y !== undefined;
    const missing = kids.filter((n) => !placed(n));
    if (!missing.length) continue;
    const ids = new Set(kids.map((k) => k.id));
    if (missing.length === kids.length) {
      // none placed: the level's own automatic layout, moved into the container
      const sub: ViewModel = { ...vm, nodes: kids.map((k) => ({ ...k, parent: undefined })), links: vm.links.filter((l) => ids.has(l.source.node) && ids.has(l.target.node)) };
      const at = autoPositions(sub, sizes, { legacy: arrange.legacy });
      const minX = Math.min(...kids.map((k) => at[k.id].x));
      const minY = Math.min(...kids.map((k) => at[k.id].y));
      for (const k of kids) rel[k.id] = { x: snap(at[k.id].x - minX + CONTAINER_PAD.left), y: snap(at[k.id].y - minY + CONTAINER_PAD.top) };
    } else {
      // some placed (a part added since the layout was saved): the others at the free spot nearest what they are linked to
      const boxes: Record<string, Box> = {};
      for (const k of kids) if (placed(k)) boxes[k.id] = { x: hand!.nodes[k.id].x!, y: hand!.nodes[k.id].y!, ...sizes[k.id] };
      const neighbours = (id: string) =>
        vm.links
          .filter((l) => !l.ground && (l.source.node === id || l.target.node === id))
          .map((l) => (l.source.node === id ? l.target.node : l.source.node))
          .filter((o) => boxes[o]);
      for (const k of missing.sort((a, b) => neighbours(b.id).length - neighbours(a.id).length || a.id.localeCompare(b.id))) {
        const ns = neighbours(k.id);
        const known = Object.values(boxes);
        const s = sizes[k.id];
        const ideal: [number, number] = ns.length
          ? [ns.reduce((t, o) => t + boxes[o].x + boxes[o].w / 2, 0) / ns.length, ns.reduce((t, o) => t + boxes[o].y + boxes[o].h / 2, 0) / ns.length]
          : [Math.max(...known.map((b) => b.x + b.w)) + 80 + s.w / 2, CONTAINER_PAD.top + s.h / 2];
        const spot = freeSpot(ideal, s.w, s.h, known, { x: 40, y: 24 });
        // never left of, or above, the container's own padding
        const at = { x: Math.max(CONTAINER_PAD.left, spot.x), y: Math.max(CONTAINER_PAD.top, spot.y) };
        boxes[k.id] = { ...at, ...s };
        rel[k.id] = { x: snap(at.x), y: snap(at.y) };
      }
    }
    if (hand?.nodes[c.id]?.w) continue;
    const right = Math.max(...kids.map((k) => (rel[k.id]?.x ?? hand?.nodes[k.id]?.x ?? 0) + sizes[k.id].w));
    const bottom = Math.max(...kids.map((k) => (rel[k.id]?.y ?? hand?.nodes[k.id]?.y ?? 0) + sizes[k.id].h));
    const up = (v: number) => Math.ceil(v / GRID) * GRID;
    sizes[c.id] = { w: up(Math.max(sizes[c.id].w, right + CONTAINER_PAD.right)), h: up(Math.max(sizes[c.id].h, bottom + CONTAINER_PAD.bottom)) };
  }
  return rel;
}

/** The container (a module expanded in place) that holds both ends of a link, if one does: the innermost. */
function sharedContainer(vm: ViewModel, byId: Map<string, ViewNode>, a: string, b: string): ViewNode | undefined {
  const chain = (id: string) => {
    const out: string[] = [];
    const self = byId.get(id);
    // a container's own boundary port is on its outline: the line from it inward is inside it
    if (self?.expanded) out.push(id);
    for (let p = self?.parent; p; p = byId.get(p)?.parent) out.push(p);
    return out;
  };
  const inB = new Set(chain(b));
  const id = chain(a).find((x) => inB.has(x));
  return id ? byId.get(id) : undefined;
}

/** Nearest free grid position between lo and hi (exclusive) on one side of a card. */
function gridSlot(v: number, lo: number, hi: number, used: Map<string, Set<number>>, key: string): number {
  const taken = used.get(key) ?? new Set<number>();
  used.set(key, taken);
  const base = snap(v);
  for (let k = 0; k < 64; k++) {
    for (const c of k === 0 ? [base] : [base + k * GRID, base - k * GRID]) {
      if (c > lo && c < hi && !taken.has(c)) {
        taken.add(c);
        return c;
      }
    }
  }
  return v;
}

/**
 * A drag in progress: only the links touching what moves are rerouted, around
 * the routes the other links already have; everything is rerouted once the
 * drag ends. Keeps dragging a module or a waypoint at frame rate.
 */
export interface LiveLayout {
  previous: ComputedLayout;
  /** Nodes being dragged (their children move with them). */
  nodes?: Set<string>;
  /** Links whose waypoints are being dragged. */
  links?: Set<string>;
}

function linkedPortsOf(vm: ViewModel): Map<string, ViewLink[]> {
  const linkedPorts = new Map<string, ViewLink[]>();
  for (const link of vm.links) {
    for (const end of [link.source, link.target]) {
      const key = portKey(end.node, end.port);
      linkedPorts.set(key, [...(linkedPorts.get(key) ?? []), link]);
    }
  }
  return linkedPorts;
}

/** Each card's size before it is placed (a hand size wins), and the cards that grew wider than plain for their labels. */
function baseSizes(vm: ViewModel, hand: LevelLayout | undefined, linkedPorts = linkedPortsOf(vm)) {
  const sizes: Record<string, { w: number; h: number }> = {};
  const up = (v: number) => Math.ceil(v / GRID) * GRID;
  /** Cards that grew wider than the plain card for their labels, with the plain width. */
  const grown = new Map<string, number>();
  for (const node of vm.nodes) {
    const linked = node.ports.filter((p) => linkedPorts.has(portKey(node.id, p.id)));
    const hand0 = hand?.nodes[node.id];
    // a card is as wide as the labels of its linked interfaces need, up to a limit (card-body.ts)
    const d = defaultSize(node, linked.length, linked.map((p) => p.name));
    const plain = defaultSize(node, linked.length);
    sizes[node.id] = { w: up(hand0?.w ?? d.w), h: up(hand0?.h ?? d.h) };
    if (!hand0?.w && sizes[node.id].w > up(plain.w)) grown.set(node.id, up(plain.w));
  }
  return { sizes, grown };
}

/**
 * The automatic layout of a level as a hand layout (PB-1007, for a host that
 * writes it to the display file): top-level nodes absolute, nodes inside an
 * expanded module relative to it. `fixed` cards keep their places; a `seed`
 * keeps an earlier arrangement where it can.
 */
export function arrangeLevel(vm: ViewModel, opts: ArrangeOptions = {}, keepSizes?: LevelLayout): LevelLayout {
  // sizes set by hand (`keepSizes`) are kept; the places are all new
  const sized: LevelLayout | undefined = keepSizes && {
    nodes: Object.fromEntries(Object.entries(keepSizes.nodes).flatMap(([id, n]) => (n.w !== undefined || n.h !== undefined ? [[id, { ...(n.w !== undefined ? { w: n.w } : {}), ...(n.h !== undefined ? { h: n.h } : {}) }]] : []))),
  };
  const { sizes } = baseSizes(vm, sized);
  const inner = containerLayouts(vm, sized, sizes, opts);
  const boxes = autoPositions(vm, sizes, opts);
  const nodes: LevelLayout["nodes"] = {};
  for (const n of vm.nodes) {
    if (n.tapOf) continue;
    const p = n.parent ? inner[n.id] : boxes[n.id];
    if (p) nodes[n.id] = { x: snap(p.x), y: snap(p.y) };
  }
  return { nodes };
}

export function computeLayout(
  vm: ViewModel,
  hand: LevelLayout | undefined,
  overrides: Record<string, { x: number; y: number }>,
  showGrounds: boolean,
  linkOverrides?: Record<string, LinkLayout>,
  live?: LiveLayout,
  arrange?: ArrangeOptions,
): ComputedLayout {
  const linkedPorts = linkedPortsOf(vm);
  const up = (v: number) => Math.ceil(v / GRID) * GRID;
  const { sizes, grown } = baseSizes(vm, hand, linkedPorts);
  // a level the display file lays out placed its cards for the plain width: there a card grows only
  // into the room its neighbours on the right leave (three grid steps stay clear for the lines between them)
  if (hand) {
    for (const [id, plain] of grown) {
      const at = hand.nodes[id];
      const node = vm.nodes.find((n) => n.id === id)!;
      if (at?.x === undefined || at.y === undefined) continue;
      let room = Infinity;
      for (const other of vm.nodes) {
        const o = hand.nodes[other.id];
        if (other.id === id || other.parent !== node.parent || o?.x === undefined || o.y === undefined) continue;
        const oh = sizes[other.id].h;
        const apart = o.y >= at.y + sizes[id].h + GRID || o.y + oh + GRID <= at.y;
        if (!apart && o.x >= at.x + plain) room = Math.min(room, o.x - 3 * GRID - at.x);
      }
      sizes[id].w = Math.max(plain, Math.min(sizes[id].w, Math.floor(room / GRID) * GRID));
    }
  }

  // modules expanded in place: their children's places inside them, and the size that holds them
  const collapsed: Record<string, { w: number; h: number }> = {};
  for (const n of vm.nodes) if (n.expanded) collapsed[n.id] = { ...sizes[n.id] };
  const inner = containerLayouts(vm, hand, sizes, arrange);

  // positions (absolute)
  const auto = hand ? fillMissing(vm, hand, sizes) : autoPositions(vm, sizes, arrange);
  // a hand layout places the cards for their collapsed sizes: one that grew when expanded in place
  // makes room, moving the cards beside and below it by what it grew (not the ones the user dragged)
  const shift: Record<string, { x: number; y: number }> = {};
  if (hand) {
    for (const c of vm.nodes.filter((n) => n.expanded && !n.parent && !hand.nodes[n.id]?.w)) {
      const at = hand.nodes[c.id] ?? auto[c.id];
      if (at?.x === undefined || at?.y === undefined) continue;
      const was = collapsed[c.id];
      const grewX = sizes[c.id].w - was.w;
      const grewY = sizes[c.id].h - was.h;
      if (grewX <= 0 && grewY <= 0) continue;
      for (const n of vm.nodes) {
        if (n === c || n.parent || overrides[n.id]) continue;
        const p = hand.nodes[n.id] ?? auto[n.id];
        if (p?.x === undefined || p?.y === undefined) continue;
        const s = (shift[n.id] ??= { x: 0, y: 0 });
        // beside it (overlapping its rows) and to its right: pushed right; below it: pushed down
        const rows = p.y < at.y! + sizes[c.id].h && p.y + sizes[n.id].h > at.y!;
        if (grewX > 0 && rows && p.x >= at.x! + was.w) s.x += grewX;
        else if (grewY > 0 && p.y >= at.y! + was.h && p.x < at.x! + sizes[c.id].w && p.x + sizes[n.id].w > at.x!) s.y += grewY;
      }
    }
  }
  const boxes: Record<string, Box> = {};
  const place = (node: ViewNode) => {
    if (boxes[node.id]) return;
    const own = hand?.nodes[node.id];
    const size = sizes[node.id];
    let x = (own?.x ?? inner[node.id]?.x ?? auto[node.id]?.x ?? 0) + (shift[node.id]?.x ?? 0);
    let y = (own?.y ?? inner[node.id]?.y ?? auto[node.id]?.y ?? 0) + (shift[node.id]?.y ?? 0);
    if (node.parent) {
      const parent = vm.nodes.find((n) => n.id === node.parent)!;
      place(parent);
      const p = boxes[parent.id];
      x += p.x;
      y += p.y;
    }
    const o = overrides[node.id];
    if (o) {
      x = o.x;
      y = o.y;
    }
    if (node.parent) {
      // a module stays inside its container: it grows to the right and down, never to the left or above its label
      const p = boxes[node.parent];
      x = Math.max(x, p.x + GRID);
      y = Math.max(y, p.y + 2 * GRID);
    }
    boxes[node.id] = { x: snap(x), y: snap(y), ...size };
  };
  // containers without a hand size wrap their children
  for (const node of vm.nodes) place(node);
  const kidsOf = (id: string) => vm.nodes.filter((n) => n.parent === id);
  const wrapContainers = () => {
    // a size the display file gives is the least it draws at: it still holds its children (PB-1007)
    for (const node of vm.nodes.filter((n) => n.expanded)) {
      const kids = vm.nodes.filter((n) => n.parent === node.id).map((n) => boxes[n.id]);
      if (!kids.length) continue;
      const b = boxes[node.id];
      const maxX = Math.max(...kids.map((k) => k.x + k.w));
      const maxY = Math.max(...kids.map((k) => k.y + k.h));
      // a container laid out here keeps room for its links around its modules; one the display file lays out keeps its tighter wrap
      const laid = kidsOf(node.id).some((k) => inner[k.id]);
      b.w = Math.ceil(Math.max(b.w, maxX - b.x + (laid ? CONTAINER_PAD.right : 28)) / GRID) * GRID;
      b.h = Math.ceil(Math.max(b.h, maxY - b.y + (laid ? CONTAINER_PAD.bottom : 24)) / GRID) * GRID;
    }
  };
  wrapContainers();

  // port sides
  const ports: Record<string, PlacedPort> = {};
  const groups: Record<string, PortGroup[]> = {};
  const bySide = new Map<string, { key: string; order: number }[]>();

  for (const node of vm.nodes) {
    const box = boxes[node.id];
    const hidden = new Map<string, PortGroup>();
    for (const port of node.ports) {
      const key = portKey(node.id, port.id);
      const links = linkedPorts.get(key);
      if (!links) {
        const g = hidden.get(port.protocol) ?? { protocol: port.protocol, domain: port.domain, count: 0 };
        g.count++;
        hidden.set(port.protocol, g);
        continue;
      }
      // counterpart: prefer an external (non pass-through) link for boundary ports
      const external = links.find((l) => !l.passThrough) ?? links[0];
      const other = external.source.node === node.id && external.source.port === port.id ? external.target : external.source;
      const otherBox = boxes[other.node];
      const target: Pt = otherBox ? [...center(otherBox)] : [...center(box)];
      const inside = otherBox && node.expanded && other.node.startsWith(`${node.id}/`);
      if (node.parent && other.node === node.parent) {
        const parentPort = ports[portKey(other.node, other.port)];
        if (parentPort) {
          const [cx, cy] = center(box);
          const far = 400;
          const out: Record<Side, Pt> = { left: [cx - far, cy], right: [cx + far, cy], top: [cx, cy - far], bottom: [cx, cy + far] };
          target[0] = out[parentPort.side][0];
          target[1] = out[parentPort.side][1];
        }
      }
      // a line to or from a net junction leaves its card sideways, toward the junction's channel (a schematic's pins)
      const otherNode = vm.nodes.find((n) => n.id === other.node);
      const sideways = !node.parent && !node.expanded && !otherNode?.expanded && (node.kind === "net" || otherNode?.kind === "net");
      let side = hand?.ports?.[key] ?? (sideways ? (target[0] >= center(box)[0] ? "right" : "left") : sideFacing(box, target));
      if (node.sheetPort && !hand?.ports?.[key]) side = target[0] >= center(box)[0] ? "right" : "left";
      if (!hand?.ports?.[key] && inside) {
        // boundary port with only an inner counterpart: face outward on the nearest edge
        side = sideFacing(box, [target[0] + (target[0] - center(box)[0]) * 4, target[1] + (target[1] - center(box)[1]) * 4]);
      }
      ports[key] = { node: node.id, port, side, x: 0, y: 0, links };
      const sk = `${node.id}|${side}`;
      const order = side === "left" || side === "right" ? target[1] : target[0];
      bySide.set(sk, [...(bySide.get(sk) ?? []), { key, order }]);
    }
    groups[node.id] = [...hidden.values()].sort((a, b) => b.count - a.count);
  }

  // grow cards (without a hand-set height) so the busiest side fits its ports
  const sideCount = new Map<string, number>();
  for (const [sk, entries] of bySide) {
    const nodeId = sk.slice(0, sk.lastIndexOf("|"));
    const side = sk.slice(sk.lastIndexOf("|") + 1);
    if (side === "left" || side === "right") sideCount.set(nodeId, Math.max(sideCount.get(nodeId) ?? 0, entries.length));
  }
  for (const [nodeId, count] of sideCount) {
    const node = vm.nodes.find((n) => n.id === nodeId)!;
    if (hand?.nodes[nodeId]?.h || node.shape === "circle" || node.sheetPort || node.expanded || node.kind === "harness" || node.kind === "net") continue;
    boxes[nodeId].h = Math.ceil(Math.max(boxes[nodeId].h, 44 + count * PORT_PITCH) / GRID) * GRID;
  }
  // grow module cards (without a hand-set height) so the body (icon, title, protocol chips) clears the
  // labels of the ports on the top and bottom edges; a container then still wraps its grown children
  let grew = false;
  const labelsOf = new Map<string, { side: Side; name: string }[]>();
  for (const p of Object.values(ports)) labelsOf.set(p.node, [...(labelsOf.get(p.node) ?? []), { side: p.side, name: p.port.name }]);
  for (const node of vm.nodes) {
    if (hand?.nodes[node.id]?.h || node.shape === "circle" || node.sheetPort || node.expanded || node.kind === "harness" || node.kind === "net") continue;
    const b = boxes[node.id];
    const need = Math.ceil(cardHeight(node.label, b.w, groups[node.id] ?? [], cardInsets(labelsOf.get(node.id) ?? [], b.w)) / GRID) * GRID;
    if (need > b.h) {
      b.h = need;
      grew = true;
    }
  }
  if (grew) wrapContainers();
  // a junction keeps one grid step between its ports on every side
  for (const [sk, entries] of bySide) {
    const nodeId = sk.slice(0, sk.lastIndexOf("|"));
    const side = sk.slice(sk.lastIndexOf("|") + 1);
    const node = vm.nodes.find((n) => n.id === nodeId)!;
    if (node.kind !== "net" || hand?.nodes[nodeId]) continue;
    const need = (entries.length + 1) * GRID;
    if (side === "left" || side === "right") boxes[nodeId].h = Math.max(boxes[nodeId].h, need);
    else boxes[nodeId].w = Math.max(boxes[nodeId].w, need + 32);
  }

  // a grown junction placed automatically moves to the nearest spot where it overlaps nothing
  for (const node of vm.nodes) {
    if (node.kind !== "net" || node.parent || hand?.nodes[node.id]?.x !== undefined || overrides[node.id]) continue;
    const b = boxes[node.id];
    const others = vm.nodes.filter((n) => n !== node && !n.expanded && !n.parent).map((n) => boxes[n.id]);
    if (!others.some((o) => hits(b, o, 8))) continue;
    // ports get their positions below, from the box
    const at = freeSpot([b.x + b.w / 2, b.y + b.h / 2], b.w, b.h, others, { x: 24, y: 12 });
    b.x = at.x;
    b.y = at.y;
  }

  const counterpartOf = (key: string): Pt | undefined => {
    const p = ports[key];
    const link = p.links.find((l) => !l.passThrough) ?? p.links[0];
    const self = link.source.node === p.node && link.source.port === p.port.id;
    const other = ports[portKey(self ? link.target.node : link.source.node, self ? link.target.port : link.source.port)];
    return other ? [other.x, other.y] : undefined;
  };

  // distribute along each side, ordered by counterpart position; the second
  // pass re-orders by where the counterpart ports actually landed
  let used = new Map<string, Set<number>>();
  for (let pass = 0; pass < 2; pass++) {
  used = new Map();
  for (const [sk, entries] of bySide) {
    if (pass === 1) {
      for (const e of entries) {
        const c = counterpartOf(e.key);
        const side = ports[e.key].side;
        if (c) e.order = side === "left" || side === "right" ? c[1] : c[0];
      }
    }
    const [nodeId, side] = [sk.slice(0, sk.lastIndexOf("|")), sk.slice(sk.lastIndexOf("|") + 1) as Side];
    const box = boxes[nodeId];
    const node = vm.nodes.find((n) => n.id === nodeId)!;
    entries.sort((a, b) => a.order - b.order);
    const n = entries.length;
    entries.forEach(({ key }, i) => {
      const f = (i + 1) / (n + 1);
      const p = ports[key];
      if (node.shape === "circle") {
        const r = box.w / 2;
        const [cx, cy] = center(box);
        const spread = Math.min(0.9, 0.35 * n); // radians around the side's midpoint
        const base = { right: 0, bottom: Math.PI / 2, left: Math.PI, top: -Math.PI / 2 }[side];
        const angle = base + (n === 1 ? 0 : (f - 0.5) * 2 * spread);
        p.x = cx + Math.cos(angle) * r;
        p.y = cy + Math.sin(angle) * r;
      } else if (side === "left" || side === "right") {
        const harness = node.kind === "harness" || node.kind === "net";
        const inset = node.expanded ? 34 : harness ? 4 : 28;
        p.x = side === "left" ? box.x : box.x + box.w;
        p.y = gridSlot(box.y + inset + (box.h - inset - (harness ? 4 : 12)) * f, box.y, box.y + box.h, used, `${nodeId}|${side}`);
      } else {
        p.x = gridSlot(box.x + 16 + (box.w - 32) * f, box.x, box.x + box.w, used, `${nodeId}|${side}`);
        p.y = side === "top" ? box.y : box.y + box.h;
      }
    });
  }
  }

  // routes: the grid router, shortest links first, through any pinned waypoints
  const routes: Record<string, Pt[]> = {};
  const pins: Record<string, Pt[]> = {};
  const bends: Record<string, Pt[]> = {};
  const byId = new Map(vm.nodes.map((n) => [n.id, n]));
  /** Where a link between two modules of one container may run: inside it, under its label and off its outline. */
  const regionOf = (link: ViewLink): Box | undefined => {
    const c = sharedContainer(vm, byId, link.source.node, link.target.node);
    const b = c && boxes[c.id];
    return b ? { x: b.x + GRID, y: b.y + 2 * GRID, w: b.w - 2 * GRID, h: b.h - 3 * GRID } : undefined;
  };
  const obstacleNodes = vm.nodes.filter((n) => !n.expanded);
  const obstacles = obstacleNodes.map((n) => boxes[n.id]);
  const router = new GridRouter(obstacles, Object.values(ports).map((p) => [p.x, p.y] as Pt), 12, !live);
  const todo = vm.links
    .filter((link) => !(link.ground && !showGrounds))
    .map((link) => ({ link, a: ports[portKey(link.source.node, link.source.port)], b: ports[portKey(link.target.node, link.target.port)] }))
    .filter((x) => x.a && x.b)
    .sort((x, y) => Math.abs(x.a.x - x.b.x) + Math.abs(x.a.y - x.b.y) - (Math.abs(y.a.x - y.b.x) + Math.abs(y.a.y - y.b.y)));
  // live drag: keep the routes of links that nothing moved, and route the rest around them
  const moves = (node: string) => [...(live?.nodes ?? [])].some((m) => node === m || node.startsWith(`${m}/`));
  const affected = (link: ViewLink) =>
    !live || !live.previous.routes[link.id] || live.links?.has(link.linkId) || moves(link.source.node) || moves(link.target.node);
  for (const { link } of todo) {
    if (affected(link)) continue;
    routes[link.id] = live!.previous.routes[link.id];
    pins[link.id] = live!.previous.pins[link.id] ?? [];
    bends[link.id] = live!.previous.bends[link.id] ?? [];
    if (!link.passThrough) router.occupy(routes[link.id]);
  }
  for (const { link, a, b } of todo) {
    if (!affected(link)) continue;
    let sa = a.side;
    const fromContainer = vm.nodes.find((n) => n.id === link.source.node)?.expanded;
    if (link.passThrough && fromContainer) {
      sa = ({ left: "right", right: "left", top: "bottom", bottom: "top" } as const)[sa];
    }
    const wp = linkOverrides?.[link.id]?.waypoints ?? hand?.links?.[link.id]?.waypoints ?? [];
    pins[link.id] = wp;
    // a pass-through line (a container's boundary inward, a sheet port to its child) runs the plain way,
    // unless that would cross a card it does not end at (a sheet port's line across a board): then it
    // goes round the cards like the rest
    if (link.passThrough) {
      const plain = route([a.x, a.y], sa, [b.x, b.y], b.side, wp);
      const ends = new Set([link.source.node, link.target.node]);
      // a line from a container's boundary inward too: round the cards it does not end at, and inside the container
      routes[link.id] = !crossesCards(plain, obstacleNodes.filter((n) => !ends.has(n.id)).map((n) => boxes[n.id])) ? plain : router.route([a.x, a.y], sa, [b.x, b.y], b.side, wp, regionOf(link));
    } else routes[link.id] = router.route([a.x, a.y], sa, [b.x, b.y], b.side, wp, regionOf(link));
    const pts = routes[link.id];
    // automatic waypoints: every interior corner that is not a pin
    bends[link.id] = pts.slice(1, -1).filter((p) => !wp.some((w) => Math.abs(w[0] - p[0]) < 1 && Math.abs(w[1] - p[1]) < 1));
  }

  // harness regions: the middle of the route, clear of the port stubs
  const runs: Record<string, [number, number]> = {};
  for (const link of vm.links) {
    const pts = routes[link.id];
    if (!link.run || !pts) continue;
    const L = lengths(pts).at(-1)!;
    const inset = Math.min(56, L * 0.18);
    // the harness ends (connector handles) sit on straight stretches, never in a bend
    const a = clearOfBends(pts, inset, BEND_CLEAR, 12);
    const b = clearOfBends(pts, L - inset, BEND_CLEAR, 12);
    runs[link.id] = b - a >= 24 ? [a, b] : [inset, L - inset];
  }

  const labelAt = placeLabels(vm, routes, boxes, hand, linkOverrides, runs);
  const labels: Record<string, Pt> = Object.fromEntries(Object.entries(labelAt).map(([id, s]) => [id, at(routes[id], s).p]));
  const labelFixed = Object.fromEntries(vm.links.map((l) => [l.id, (linkOverrides?.[l.id]?.labelT ?? hand?.links?.[l.id]?.labelT) !== undefined]));
  const edits = Object.fromEntries(vm.links.map((l) => [l.id, { ...hand?.links?.[l.id], ...linkOverrides?.[l.id] }]));
  return { boxes, ports, groups, routes, labels, labelAt, runs, pins, bends, labelFixed, edits };
}

/** Whether an axis-aligned polyline runs through any of `cards` (inside them, not along an edge). */
function crossesCards(pts: Pt[], cards: Box[]): boolean {
  for (let i = 1; i < pts.length; i++) {
    const [x0, x1] = [Math.min(pts[i - 1][0], pts[i][0]), Math.max(pts[i - 1][0], pts[i][0])];
    const [y0, y1] = [Math.min(pts[i - 1][1], pts[i][1]), Math.max(pts[i - 1][1], pts[i][1])];
    if (cards.some((b) => x1 > b.x + 1 && x0 < b.x + b.w - 1 && y1 > b.y + 1 && y0 < b.y + b.h - 1)) return true;
  }
  return false;
}

const CANDIDATES = [0.5, 0.35, 0.65, 0.22, 0.78, 0.12, 0.88];

function labelSize(link: ViewLink): { w: number; h: number } {
  return { w: link.name.length * 5.6 + (link.children.length > 1 ? 44 : 16), h: 16 };
}

/** Whether a link opens into lanes (its label carries the +/− toggle, so it is always drawn). */
const opens = (link: ViewLink) => (link.lanes?.length ?? 0) > 1 || link.children.length > 1;

/**
 * Choose a label spot per link, as an arc length along its route. The label
 * reads along the line (design D13): above a horizontal stretch, turned
 * beside a vertical one. Candidates are spots along every straight stretch
 * long enough for the text, horizontal ones first; each is scored by what
 * the text would cover: a card or another label (never), other lines (as
 * few as possible). A label with no clear spot is left off (the line still
 * names itself in the inspector and on hover); a link that opens into lanes
 * keeps its label, as that is where its toggle is. A label made only of a
 * pin number (a resistor's "1") says nothing on the sheet and is left off.
 * Routes shorter than 70 px (e.g. prop-on-shaft) stay unlabelled.
 */
function placeLabels(
  vm: ViewModel,
  routes: Record<string, Pt[]>,
  boxes: Record<string, Box>,
  hand: LevelLayout | undefined,
  linkOverrides: Record<string, LinkLayout> | undefined,
  runs: Record<string, [number, number]>,
): Record<string, number> {
  const placed: Box[] = [];
  const out: Record<string, number> = {};
  const cards = [
    ...vm.nodes.filter((n) => !n.expanded).map((n) => boxes[n.id]),
    ...vm.nodes.filter((n) => n.expanded).map((n) => ({ ...boxes[n.id], h: 26 })),
  ];
  const overlaps = (a: Box, b: Box, pad = 3) =>
    a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
  // every drawn segment, for counting the lines a label would sit on
  const segs: { id: string; a: Pt; b: Pt }[] = [];
  for (const link of vm.links) {
    const pts = routes[link.id];
    if (pts) for (let i = 1; i < pts.length; i++) segs.push({ id: link.id, a: pts[i - 1], b: pts[i] });
  }
  const crossing = (r: Box, own: string) =>
    segs.filter(
      (s) => s.id !== own && Math.max(s.a[0], s.b[0]) > r.x && Math.min(s.a[0], s.b[0]) < r.x + r.w && Math.max(s.a[1], s.b[1]) > r.y && Math.min(s.a[1], s.b[1]) < r.y + r.h,
    ).length;
  /**
   * The text's box for a label asked for at arc length `s` along `pts`: where the link draws it (moved
   * off the bends onto a straight stretch, as LinkEdge does), above a horizontal stretch or right of a
   * vertical one. Returns the arc length it lands at too.
   */
  const rectAt = (pts: Pt[], s0: number, w: number): { rect: Box; vertical: boolean; s: number } => {
    const s = clearOfBends(pts, s0, LABEL_CLEAR, 12);
    const { p, d } = at(pts, s);
    const vertical = Math.abs(d[1]) > Math.abs(d[0]);
    // the drawn tab: text plus its padding and border, a few px off the line
    return vertical ? { rect: { x: p[0] + 2, y: p[1] - w / 2, w: 22, h: w }, vertical, s } : { rect: { x: p[0] - w / 2, y: p[1] - 22, w, h: 20 }, vertical, s };
  };

  const ordered = [...vm.links].sort((a, b) => Number(opens(b)) - Number(opens(a)) || b.children.length - a.children.length || a.id.localeCompare(b.id));
  for (const link of ordered) {
    const pts = routes[link.id];
    if (!pts || link.passThrough || link.segment === "b") continue;
    const L = pathLength(pts);
    if (L < 70) continue;
    const fixed = linkOverrides?.[link.id]?.labelT ?? hand?.links?.[link.id]?.labelT;
    const keep = opens(link);
    if (fixed === undefined && !keep && /^\d+$/.test(link.name.trim())) continue;
    const size = labelSize(link);
    const [lo, hi] = runs[link.id] ?? [0, L];
    const within = (t: number) => (lo + (hi - lo) * t) / L;
    // fractions of the route: the given one, or the classic spots plus the middle of every straight stretch the text fits on
    const tries: number[] = [];
    if (fixed !== undefined) tries.push(fixed);
    else {
      let walked = 0;
      const stretches: { mid: number; len: number }[] = [];
      for (let i = 1; i < pts.length; i++) {
        const len = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        if (len >= size.w + 2 * BEND_CLEAR) stretches.push({ mid: walked + len / 2, len });
        walked += len;
      }
      stretches.sort((a, b) => b.len - a.len);
      for (const st of stretches) for (const f of [0, -0.25, 0.25]) tries.push((st.mid + f * (st.len - size.w - 2 * BEND_CLEAR)) / L);
      tries.push(longestMid(pts), ...CANDIDATES.map(within));
    }
    let best: { at: number; score: number; rect: Box } | undefined;
    for (const t of tries) {
      const { rect, vertical, s } = rectAt(pts, t * L, size.w);
      const hard = cards.filter((b) => overlaps(rect, b, 0)).length + placed.filter((b) => overlaps(rect, b)).length;
      const score = hard * 100 + crossing(rect, link.id) * 2 + (vertical ? 1 : 0);
      if (!best || score < best.score) best = { at: fixed !== undefined ? t * L : s, score, rect };
      if (score === 0) break;
    }
    if (!best || (best.score >= 100 && fixed === undefined && !keep)) continue;
    out[link.id] = best.at;
    placed.push(best.rect);
  }
  return out;
}

function pathLength(pts: Pt[]): number {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return n;
}

function pointAlong(pts: Pt[], t: number): Pt {
  const target = pathLength(pts) * t;
  let walked = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (walked + seg >= target && seg > 0) {
      const f = (target - walked) / seg;
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f];
    }
    walked += seg;
  }
  return pts[pts.length - 1];
}

function longestMid(pts: Pt[]): number {
  const total = pathLength(pts) || 1;
  let best = 0;
  let mid = 0.5;
  let walked = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (seg > best) {
      best = seg;
      mid = (walked + seg / 2) / total;
    }
    walked += seg;
  }
  return mid;
}
