/**
 * Layout: node boxes, port placement, and link routes for one level.
 * Layout data lives outside UHD (design D3, D6); a level can ship a hand
 * layout (from the bundle's display hints) and the user's drags override it.
 */
import type { ViewLink, ViewModel, ViewNode, ViewPort } from "../model/types";
import { route, type Pt, type Side } from "../canvas/routing";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LinkLayout {
  /** Waypoints in absolute canvas coordinates. */
  waypoints?: Pt[];
  /** Label position as a fraction along the route. */
  labelT?: number;
}

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
}

export const portKey = (node: string, port: string) => `${node}|${port}`;

const CARD_W = 170;
const PORT_PITCH = 22;

function defaultSize(node: ViewNode, visiblePorts: number): { w: number; h: number } {
  if (node.sheetPort) return { w: 150, h: 30 };
  if (node.kind === "harness") return { w: 150, h: Math.max(30, 14 + (visiblePorts / 2) * 16) };
  if (node.shape === "circle") return /prop/i.test(node.label) ? { w: 60, h: 60 } : { w: 78, h: 78 };
  const perSide = Math.ceil(visiblePorts / 2);
  return { w: CARD_W, h: Math.max(84, 40 + perSide * PORT_PITCH) };
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

/**
 * Auto layout for levels without a hand layout: modules in a centred row,
 * and each sheet port (the drilled-into module's boundary) on the canvas
 * edge nearest the child it exposes, stacked beside it.
 */
function autoPositions(vm: ViewModel, sizes: Record<string, { w: number; h: number }>): Record<string, Box> {
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

export function computeLayout(
  vm: ViewModel,
  hand: LevelLayout | undefined,
  overrides: Record<string, { x: number; y: number }>,
  showGrounds: boolean,
): ComputedLayout {
  const linkedPorts = new Map<string, ViewLink[]>();
  for (const link of vm.links) {
    for (const end of [link.source, link.target]) {
      const key = portKey(end.node, end.port);
      linkedPorts.set(key, [...(linkedPorts.get(key) ?? []), link]);
    }
  }

  // sizes
  const sizes: Record<string, { w: number; h: number }> = {};
  for (const node of vm.nodes) {
    const visible = node.ports.filter((p) => linkedPorts.has(portKey(node.id, p.id))).length;
    const hand0 = hand?.nodes[node.id];
    const d = defaultSize(node, visible);
    sizes[node.id] = { w: hand0?.w ?? d.w, h: hand0?.h ?? d.h };
  }

  // positions (absolute)
  const auto = hand ? {} : autoPositions(vm, sizes);
  const boxes: Record<string, Box> = {};
  const place = (node: ViewNode) => {
    if (boxes[node.id]) return;
    const own = hand?.nodes[node.id];
    const size = sizes[node.id];
    let x = own?.x ?? auto[node.id]?.x ?? 0;
    let y = own?.y ?? auto[node.id]?.y ?? 0;
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
    boxes[node.id] = { x, y, ...size };
  };
  // containers without a hand size wrap their children
  for (const node of vm.nodes) place(node);
  for (const node of vm.nodes.filter((n) => n.expanded)) {
    if (hand?.nodes[node.id]?.w) continue;
    const kids = vm.nodes.filter((n) => n.parent === node.id).map((n) => boxes[n.id]);
    if (!kids.length) continue;
    const b = boxes[node.id];
    const maxX = Math.max(...kids.map((k) => k.x + k.w));
    const maxY = Math.max(...kids.map((k) => k.y + k.h));
    b.w = Math.max(b.w, maxX - b.x + 28);
    b.h = Math.max(b.h, maxY - b.y + 24);
  }

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
      let side = hand?.ports?.[key] ?? sideFacing(box, target);
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
    if (hand?.nodes[nodeId]?.h || node.shape === "circle" || node.sheetPort || node.expanded || node.kind === "harness") continue;
    boxes[nodeId].h = Math.max(boxes[nodeId].h, 44 + count * PORT_PITCH);
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
  for (let pass = 0; pass < 2; pass++)
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
        const harness = node.kind === "harness";
        const inset = node.expanded ? 34 : harness ? 4 : 28;
        p.x = side === "left" ? box.x : box.x + box.w;
        p.y = box.y + inset + (box.h - inset - (harness ? 4 : 12)) * f;
      } else {
        p.x = box.x + 16 + (box.w - 32) * f;
        p.y = side === "top" ? box.y : box.y + box.h;
      }
    });
  }

  // routes
  const routes: Record<string, Pt[]> = {};
  for (const link of vm.links) {
    if (link.ground && !showGrounds) continue;
    const a = ports[portKey(link.source.node, link.source.port)];
    const b = ports[portKey(link.target.node, link.target.port)];
    if (!a || !b) continue;
    let sa = a.side;
    let sb = b.side;
    // a pass-through runs inward from the boundary
    const fromContainer = vm.nodes.find((n) => n.id === link.source.node)?.expanded;
    if (link.passThrough && fromContainer) {
      sa = ({ left: "right", right: "left", top: "bottom", bottom: "top" } as const)[sa];
    }
    const wp = hand?.links?.[link.id]?.waypoints ?? [];
    routes[link.id] = route([a.x, a.y], sa, [b.x, b.y], sb, wp);
  }

  separateSegments(routes);
  const labels = placeLabels(vm, routes, boxes, hand);
  return { boxes, ports, groups, routes, labels };
}

/**
 * Nudge interior segments of different links apart when they would run on
 * top of each other (same axis, within 5 px, overlapping span). The first
 * and last segments are port stubs and never move.
 */
function separateSegments(routes: Record<string, Pt[]>, gap = 9): void {
  type Seg = { id: string; i: number; vertical: boolean; at: number; lo: number; hi: number };
  const taken: Seg[] = [];
  const segsOf = (id: string, pts: Pt[]): Seg[] => {
    const out: Seg[] = [];
    for (let i = 1; i < pts.length - 2; i++) {
      const [a, b] = [pts[i], pts[i + 1]];
      const vertical = Math.abs(a[0] - b[0]) < 0.5;
      const horizontal = Math.abs(a[1] - b[1]) < 0.5;
      if (!vertical && !horizontal) continue;
      out.push(
        vertical
          ? { id, i, vertical, at: a[0], lo: Math.min(a[1], b[1]), hi: Math.max(a[1], b[1]) }
          : { id, i, vertical, at: a[1], lo: Math.min(a[0], b[0]), hi: Math.max(a[0], b[0]) },
      );
    }
    return out;
  };
  const clash = (s: Seg) =>
    taken.some((t) => t.id !== s.id && t.vertical === s.vertical && Math.abs(t.at - s.at) < gap - 1 && t.lo < s.hi - 2 && s.lo < t.hi - 2);

  for (const [id, pts] of Object.entries(routes)) {
    for (const seg of segsOf(id, pts)) {
      let shift = 0;
      for (const step of [gap, -gap, 2 * gap, -2 * gap, 3 * gap, -3 * gap]) {
        if (!clash({ ...seg, at: seg.at + shift })) break;
        shift = step;
      }
      if (shift !== 0) {
        const axis = seg.vertical ? 0 : 1;
        pts[seg.i][axis] += shift;
        pts[seg.i + 1][axis] += shift;
        seg.at += shift;
      }
      taken.push(seg);
    }
  }
}

const CANDIDATES = [0.5, 0.35, 0.65, 0.22, 0.78, 0.12, 0.88];

function labelSize(link: ViewLink): { w: number; h: number } {
  return { w: link.name.length * 5.6 + (link.children.length > 1 ? 44 : 16), h: 16 };
}

/**
 * Choose a label spot per link: the longest segment's middle by default,
 * moved along the route to avoid other labels and module cards. Routes
 * shorter than 70 px (e.g. prop-on-shaft) stay unlabelled.
 */
function placeLabels(
  vm: ViewModel,
  routes: Record<string, Pt[]>,
  boxes: Record<string, Box>,
  hand: LevelLayout | undefined,
): Record<string, Pt> {
  const placed: Box[] = [];
  const out: Record<string, Pt> = {};
  const cards = [
    ...vm.nodes.filter((n) => !n.expanded).map((n) => boxes[n.id]),
    // title bars of expanded groups and modules
    ...vm.nodes.filter((n) => n.expanded).map((n) => ({ ...boxes[n.id], h: 26 })),
  ];
  const overlaps = (a: Box, b: Box, pad = 3) =>
    a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

  const ordered = [...vm.links].sort((a, b) => b.children.length - a.children.length);
  for (const link of ordered) {
    const pts = routes[link.id];
    if (!pts || link.passThrough || link.segment === "b") continue;
    if (pathLength(pts) < 70) continue;
    const size = labelSize(link);
    const fixed = hand?.links?.[link.id]?.labelT;
    const tries = fixed !== undefined ? [fixed] : [longestMid(pts), ...CANDIDATES];
    let best: { p: Pt; score: number } | undefined;
    for (const t of tries) {
      const p = pointAlong(pts, t);
      const rect = { x: p[0] - size.w / 2, y: p[1] - size.h / 2, ...size };
      const score =
        placed.filter((b) => overlaps(rect, b)).length * 10 + cards.filter((b) => overlaps(rect, b, 0)).length * 4;
      if (!best || score < best.score) best = { p, score };
      if (score === 0) break;
    }
    if (!best) continue;
    out[link.id] = best.p;
    placed.push({ x: best.p[0] - size.w / 2, y: best.p[1] - size.h / 2, ...size });
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
