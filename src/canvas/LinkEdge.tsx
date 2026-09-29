/**
 * One link on the canvas (PB-803, design board 09 · D12).
 *
 * Basic mode: one line at each module. Ribbon mode: every conductor end to
 * end at a tight pitch in its own colour over a soft band. Expanding a link
 * opens one level at a time in both modes: its lanes appear (a lane that is
 * itself a bundle stays one line, or one sub-ribbon, with its own toggle) and
 * each bundle opens again in place. A link that runs through a harness gets a
 * tight dotted region along the harness's span that grows around whatever is
 * drawn inside it, with the harness ends marked.
 *
 * The expansion sits on one straight stretch of the route, centred on the
 * toggle; its length follows the stretch between a minimum (room for the lane
 * names) and a maximum. The toggles of every level overlap at that point and
 * the label sits beside them; dragging the label or a toggle moves the whole
 * expansion along the route. Handles and toggles never sit in a bend.
 *
 * When the link is selected its waypoints show: automatic bends hollow,
 * pinned ones solid. Dragging a bend pins it; double-clicking a pin releases it.
 */
import { useMemo, useState } from "react";
import { BaseEdge, EdgeLabelRenderer, useReactFlow, type Edge, type EdgeProps } from "@xyflow/react";
import type { ViewConductor, ViewLane, ViewLink } from "../model/types";
import { colorFor, conductorColor, type Classification } from "../model/classification";
import { filletPath, offsetPolyline, type Pt } from "./routing";
import {
  LANE_PITCH,
  RIBBON_PITCH,
  RUN,
  STAGE,
  at,
  clearOfBends,
  densify,
  easeJogs,
  fanned,
  lane,
  offsets,
  project,
  regionOutline,
  ribbon,
  ribbonRadius,
  stagedSpans,
  straights,
  stretchAt,
  subpath,
  totalLength,
} from "./geometry";
import { Icon } from "./Icon";
import { GRID } from "../layout/router";

export type Detail = "basic" | "ribbon";

export interface LinkData extends Record<string, unknown> {
  link: ViewLink;
  points: Pt[];
  color: string;
  faded: boolean;
  mode: Classification;
  detail: Detail;
  /** Expanded (lanes shown). */
  open: boolean;
  openLanes: Set<string>;
  /** Harness span along the route (arc lengths). */
  run?: [number, number];
  /** Label + toggle position (arc length); absent: no label. */
  labelAt?: number;
  /** The label was placed by the user (or the display file): honour it even on a short stretch. */
  labelFixed?: boolean;
  pins: Pt[];
  bends: Pt[];
  onToggle: (id: string) => void;
  onToggleLane: (id: string) => void;
  onLabel: (linkId: string, t: number) => void;
  onPins: (linkId: string, pins: Pt[]) => void;
}

export type LinkEdgeType = Edge<LinkData, "link">;

const RADIUS = 12;
const TOGGLE = 16; // toggle box length along the link
const NAME_CHAR = 5; // lane-name width per character (7.5 px UI font)
const MAX_EXTRA = 32; // an expansion grows at most this much past what its names need (short enough to slide)
const MIN_STRAIGHT = 16; // shortest expansion the user can force onto a short stretch

/** One thing drawn inside an expansion: a lane, a sub-bundle, or (ribbon) a conductor. */
interface Item {
  id: string;
  name: string;
  lane?: ViewLane;
  /** Conductor indices (ribbon mode). */
  conductors: number[];
  children: Item[];
}

const bundle = (it: Item) => it.children.length > 1;

/**
 * Last press on a pinned waypoint, for double-press detection. Module-level on
 * purpose: selecting a link remounts its edge between the clicks, so neither
 * dblclick nor a ref survives.
 */
const lastPress: { current: { key: string; t: number } | null } = { current: null };
/** The label or toggle being slid along its link (module-level for the same reason). */
const slide: { current: { x: number; y: number; moved: boolean } | null } = { current: null };

/** The expansion's items: lanes in basic mode, lanes grouping their conductors in ribbon mode. */
function itemsOf(link: ViewLink, ribbonMode: boolean): Item[] {
  const conductors = link.conductors ?? [];
  const index = new Map(conductors.map((c, i) => [c.id, i]));
  const leaf = (i: number): Item => ({ id: conductors[i].id, name: conductors[i].label, conductors: [i], children: [] });
  const fromLane = (l: ViewLane): Item => {
    if (!ribbonMode) return { id: l.id, name: l.name, lane: l, conductors: [], children: l.children.length > 1 ? l.children.map(fromLane) : [] };
    const cs = (l.conductors ?? []).map((id) => index.get(id)).filter((i): i is number => i !== undefined).sort((a, b) => a - b);
    let children = l.children.map(fromLane).filter((c) => c.conductors.length);
    // a lane of several conductors opens into them even when UHD names no children
    if (children.length < 2) children = cs.length > 1 ? cs.map(leaf) : [];
    if (cs.length === 1) return { ...leaf(cs[0]), id: l.id, lane: l };
    return { id: l.id, name: l.name, lane: l, conductors: cs, children };
  };
  let items = (link.lanes ?? []).map(fromLane);
  if (ribbonMode) {
    items = items.filter((it) => it.conductors.length);
    const used = new Set(items.flatMap((it) => it.conductors));
    conductors.forEach((_, i) => {
      if (!used.has(i)) items.push(leaf(i));
    });
    items.sort((a, b) => Math.min(...a.conductors) - Math.min(...b.conductors));
  }
  // one lane carrying everything: open straight into its children
  if (items.length === 1 && bundle(items[0])) items = items[0].children;
  return items;
}

/** Items as drawn: open bundles replaced by their children, recursively. */
function visibleItems(items: Item[], open: Set<string>, depth = 1, parents: Item[] = []): { item: Item; depth: number; parents: Item[] }[] {
  return items.flatMap((it) =>
    bundle(it) && open.has(it.id) ? visibleItems(it.children, open, depth + 1, [...parents, it]) : [{ item: it, depth, parents }],
  );
}

const horizontal = (d: Pt) => Math.abs(d[0]) > Math.abs(d[1]);

interface ToggleBox {
  key: string;
  /** Extent across the link (offsets from the centre line). */
  lo: number;
  hi: number;
  /** Where the +/− sits (offset). */
  glyph: number;
  open: boolean;
  depth: number;
  onClick: () => void;
}

export function LinkEdge({ id, data, selected }: EdgeProps<LinkEdgeType>) {
  const flow = useReactFlow();
  const [drag, setDrag] = useState<{ kind: "pin" | "bend"; index: number; at: Pt } | null>(null);

  const geo = useMemo(() => {
    if (!data || data.points.length < 2) return null;
    // conductors follow the classification: domain, DRC state, or signal type
    const tint = (c: ViewConductor) =>
      data.mode === "signal" ? conductorColor(c.protocol) : colorFor({ domain: c.domain, protocol: c.protocol, state: c.state }, data.mode);
    const { link, detail, open } = data;
    const conductors = link.conductors ?? [];
    const n = conductors.length;
    const ribbonMode = detail === "ribbon" && n > 1;
    const R = ribbonMode ? ribbonRadius(n * RIBBON_PITCH) : RADIUS;
    // a ribbon cannot sidestep in less than its own width: short jogs become diagonals
    const P = ribbonMode ? easeJogs(data.points, 2 * R) : data.points;
    const L = totalLength(P);
    const onP = (s: number) => (P === data.points ? s : project(P, at(data.points, s).p));

    const items = itemsOf(link, ribbonMode);
    const expandable = ribbonMode ? n > 1 : items.length > 1;
    const vis = visibleItems(items, data.openLanes);
    const tight = offsets(n, RIBBON_PITCH);

    // offsets across the expansion: one per visible item; in ribbon mode items keep their conductors at the ribbon pitch
    const wide: number[] = new Array(n).fill(0);
    let itemOff: number[];
    if (ribbonMode) {
      let x = 0;
      itemOff = vis.map(({ item }, k) => {
        if (k > 0) x += LANE_PITCH;
        const start = x;
        item.conductors.forEach((ci, j) => (wide[ci] = start + j * RIBBON_PITCH));
        x += (item.conductors.length - 1) * RIBBON_PITCH;
        return (start + x) / 2;
      });
      const mid = x / 2;
      itemOff = itemOff.map((o) => o - mid);
      for (let i = 0; i < n; i++) wide[i] -= mid;
    } else itemOff = offsets(vis.length, LANE_PITCH);

    // fan length, and the straight part the lane names need
    const mags = [...new Set(itemOff.map((o) => Math.abs(o)).filter((m) => m > 0))];
    const F = ribbonMode ? Math.max(RUN, Math.min(40, Math.max(...wide.map((w, i) => Math.abs(w - tight[i]))) * 0.7)) : RUN + Math.max(0, mags.length - 1) * STAGE;
    const nameW = Math.max(0, ...vis.map((v) => v.item.name.length)) * NAME_CHAR + (ribbonMode ? 9 : 0) + 8;
    // names then toggle: centred needs the names' room on both sides; tight puts the toggle after the names
    const centred = 2 * (6 + nameW + 6 + TOGGLE / 2);
    const need = 6 + nameW + 6 + TOGGLE + 4;

    // the expansion point: on a straight stretch, clear of the bends
    const clear = R + TOGGLE / 2 + 4;
    let c = clearOfBends(P, data.labelAt !== undefined ? onP(data.labelAt) : L / 2, clear, 12);
    const expanded = open && expandable;
    let win: [number, number] | undefined;
    let fan = F;
    let straight: [number, number] = [0, L];
    let showNames = true;
    if (expanded) {
      if (!data.labelFixed) {
        // placed automatically: move to the nearest stretch the expansion fits on (or the longest)
        const iv = straights(P, R + (data.run ? 14 : 0), 12);
        const fit = iv.filter(([a, b]) => b - a >= need + 2 * F);
        const pool = fit.length ? fit : iv.length ? [iv.reduce((x, y) => (y[1] - y[0] > x[1] - x[0] ? y : x))] : [];
        let best = c;
        let dist = Infinity;
        for (const [a, b] of pool) {
          const q = Math.max(a, Math.min(b, c));
          if (Math.abs(q - c) < dist) [best, dist] = [q, Math.abs(q - c)];
        }
        c = best;
      }
      // leave room at both ends of the stretch for the harness ends (connector handles) outside the fans
      const [a, b] = stretchAt(P, c, R + (data.run ? 14 : 0), 12);
      const avail = b - a;
      // on a stretch too short for full fans, the fans steepen before the names lose their room
      fan = avail >= need + 2 * F ? F : Math.max(12, Math.min(F, (avail - need) / 2));
      const S = Math.max(MIN_STRAIGHT, Math.min(centred + MAX_EXTRA, avail - 2 * fan));
      showNames = S >= need;
      const W = S + 2 * fan;
      const w0 = W <= avail ? Math.max(a, Math.min(b - W, c - W / 2)) : Math.max(2, Math.min(L - W - 2, c - W / 2));
      win = [w0, w0 + W];
      c = S >= centred ? w0 + W / 2 : w0 + W - fan - TOGGLE / 2 - 4;
      straight = [w0 + fan, w0 + W - fan];
    }

    // what gets drawn
    const lines: { d: string; color: string; width: number; key: string }[] = [];
    const samples: Pt[] = [];
    const names: { s: number; o: number; text: string; color: string; swatch?: boolean }[] = [];
    let band: string | undefined;
    const laneColor = (l?: ViewLane) => (data.mode === "domain" || !l ? data.color : colorFor(l, data.mode));

    if (ribbonMode) {
      if (win) {
        const shapes = fanned(P, tight, wide, win[0], win[1], fan, R);
        shapes.forEach((sh, i) => {
          lines.push({ d: sh.d, color: tint(conductors[i]), width: 2.4, key: conductors[i].id });
          samples.push(...sh.samples);
        });
        vis.forEach(({ item }, k) => {
          const single = item.conductors.length === 1;
          names.push({ s: straight[0] + 6, o: itemOff[k], text: item.name, color: single ? tint(conductors[item.conductors[0]]) : data.color, swatch: single });
        });
        const inWin = (p: Pt) => {
          const q = project(P, p);
          return q > win[0] - 4 && q < win[1] + 4;
        };
        band = regionOutline(shapes.flatMap((s) => s.samples.filter(inWin)), 5);
      } else {
        ribbon(P, n, R).forEach((r, i) => {
          lines.push({ d: r.d, color: tint(conductors[i]), width: 2.4, key: conductors[i].id });
          samples.push(...r.samples);
        });
      }
    } else if (win) {
      const k = fan / F; // steeper fans on a short stretch
      const spans = stagedSpans(itemOff, win[0], win[1], STAGE * k);
      const innerStart = Math.max(...spans.map((s) => s[0]));
      const innerEnd = Math.min(...spans.map((s) => s[1]));
      const near = subpath(P, 0, innerStart);
      const far = subpath(P, innerEnd, L);
      lines.push({ d: filletPath(near, RADIUS), color: data.color, width: 2, key: "near" }, { d: filletPath(far, RADIUS), color: data.color, width: 2, key: "far" });
      samples.push(...densify(near), ...densify(far));
      vis.forEach(({ item }, i) => {
        const sh = lane(P, itemOff[i], spans[i][0], spans[i][1], RUN * k);
        const color = laneColor(item.lane);
        lines.push({ d: sh.d, color, width: bundle(item) ? 3 : 2, key: item.id });
        samples.push(...sh.samples);
        names.push({ s: straight[0] + 6, o: itemOff[i], text: item.name, color });
      });
    } else {
      samples.push(...densify(P));
    }

    // toggles: every level at the same point, inner ones on top of the ones that contain them
    const boxes: ToggleBox[] = [];
    const at0 = at(P, c);
    const nrm: Pt = [at0.d[1], -at0.d[0]];
    // caps go on the label's side (above a horizontal link, right of a vertical one), clear of the harness tab
    const capHi = horizontal(at0.d) ? nrm[1] < 0 : nrm[0] > 0;
    const withGlyph = (key: string, lo: number, hi: number, isOpen: boolean, depth: number, onClick: () => void, inner: ToggleBox[]) => {
      const mid = (lo + hi) / 2;
      const covered = inner.some((b) => b.depth === depth + 1 && mid > b.lo - 5 && mid < b.hi + 5);
      if (!covered) return boxes.push({ key, lo, hi, glyph: mid, open: isOpen, depth, onClick });
      return capHi
        ? boxes.push({ key, lo, hi: hi + 14, glyph: hi + 7, open: isOpen, depth, onClick })
        : boxes.push({ key, lo: lo - 14, hi, glyph: lo - 7, open: isOpen, depth, onClick });
    };
    if (expandable) {
      if (!expanded) {
        const half = ribbonMode ? (n * RIBBON_PITCH) / 2 + 2 : 10;
        withGlyph("main", -half, half, false, 0, () => data.onToggle(link.linkId), []);
      } else {
        const extentOf = (it: Item): [number, number] => {
          if (ribbonMode) {
            const ws = it.conductors.map((ci) => wide[ci]);
            return [Math.min(...ws) - RIBBON_PITCH / 2 - 2, Math.max(...ws) + RIBBON_PITCH / 2 + 2];
          }
          const ks = vis.map((v, k) => ({ v, k })).filter(({ v }) => v.item === it || v.parents.includes(it)).map(({ k }) => itemOff[k]);
          return [Math.min(...ks) - 8, Math.max(...ks) + 8];
        };
        // nested bundles first (deepest first), so a parent knows whether its centre is covered
        const nested: { it: Item; depth: number }[] = [];
        const walk = (list: Item[], depth: number) => {
          for (const it of list) {
            if (!bundle(it)) continue;
            nested.push({ it, depth });
            if (data.openLanes.has(it.id)) walk(it.children, depth + 1);
          }
        };
        walk(items, 1);
        nested.sort((x, y) => y.depth - x.depth);
        for (const { it, depth } of nested) {
          const [lo, hi] = extentOf(it);
          const isOpen = data.openLanes.has(it.id);
          withGlyph(`n${it.id}`, lo, hi, isOpen, depth, () => data.onToggleLane(it.id), isOpen ? [...boxes] : []);
        }
        const all = ribbonMode ? wide : itemOff;
        withGlyph("main", Math.min(...all) - 10, Math.max(...all) + 10, true, 0, () => data.onToggle(link.linkId), [...boxes]);
      }
      boxes.sort((x, y) => x.depth - y.depth);
    }

    // harness region: tight to what runs inside the harness span (grown to take in the expansion)
    let region: string | undefined;
    let regionBox: { x: number; y: number; side: "above" | "below" | "left" } | undefined;
    let run = data.run ? ([onP(data.run[0]), onP(data.run[1])] as [number, number]) : undefined;
    if (run && win) {
      // grown to take in the expansion, with its ends (connector handles) still on straight stretches
      const iv = straights(P, R + 6, 8);
      const before = (s: number) => Math.max(6, ...iv.filter(([a]) => a <= s).map(([a, b]) => Math.min(b, s)));
      const after = (s: number) => Math.min(L - 6, ...iv.filter(([, b]) => b >= s).map(([a, b]) => Math.max(a, s)));
      run = [run[0] < win[0] - 8 ? run[0] : before(win[0] - 8), run[1] > win[1] + 8 ? run[1] : after(win[1] + 8)];
    }
    if (run) {
      const [r0, r1] = run;
      const inside = (p: Pt) => {
        const s = project(P, p);
        return s >= r0 - 1 && s <= r1 + 1;
      };
      const core =
        ribbonMode && !win
          ? tight.flatMap((o) => densify(offsetPolyline(subpath(P, r0, r1), o, R).points))
          : densify(subpath(P, r0, r1));
      const inner = [...core, ...samples.filter(inside)];
      region = regionOutline(inner, 10);
      // the name tab runs along the region, reading upright or bottom-to-top (design D13): on a
      // vertical region it sits on the left edge; on a horizontal one on top, or underneath on a short run
      const xs = inner.map((p) => p[0]);
      const ys = inner.map((p) => p[1]);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      const vertical = y1 - y0 > x1 - x0;
      const below = !vertical && r1 - r0 < 260;
      regionBox = vertical
        ? { x: x0 - 10, y: y0 + 16, side: "left" }
        : { x: x0 - 10, y: below ? y1 + 10 : y0 - 10, side: below ? "below" : "above" };
    }

    // label: beside the toggles, on the side away from the caps
    const extent = boxes.length ? boxes.reduce((e, b) => [Math.min(e[0], b.lo), Math.max(e[1], b.hi)], [Infinity, -Infinity]) : [-4, 4];
    const ends = [0, 1].map((k) => {
      const o = extent[k];
      return [at0.p[0] + nrm[0] * o, at0.p[1] + nrm[1] * o] as Pt;
    });

    return {
      P,
      L,
      R,
      lines,
      samples,
      names: showNames ? names : [],
      band,
      region,
      regionBox,
      run,
      anchor: data.labelAt !== undefined ? at0 : undefined,
      nrm,
      ends,
      ribbonMode,
      expandable,
      expanded,
      boxes,
      conductors,
      tint,
    };
  }, [data]);

  if (!data || !geo) return null;
  const { link, points, color, faded } = data;
  const opacity = faded ? 0.16 : link.passThrough ? 0.55 : 1;
  const main = filletPath(geo.P, geo.R);
  const toFlow = (e: React.PointerEvent): Pt => {
    const p = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    return [p.x, p.y];
  };
  const snapPt = (p: Pt): Pt => [Math.round(p[0] / GRID) * GRID, Math.round(p[1] / GRID) * GRID];

  /** Drag the label or a toggle along the route; a press without a drag is a click. */
  const slider = (onClick?: () => void) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.stopPropagation();
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      slide.current = { x: e.clientX, y: e.clientY, moved: false };
    },
    onPointerMove: (e: React.PointerEvent) => {
      const d = slide.current;
      if (!d) return;
      if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
      d.moved = true;
      data.onLabel(link.linkId, project(points, toFlow(e)) / totalLength(points));
    },
    onPointerUp: (e: React.PointerEvent) => {
      e.stopPropagation();
      const d = slide.current;
      slide.current = null;
      if (d && !d.moved) onClick?.();
    },
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
  });

  const handleAt = (s: number, key: string) => {
    const { p, d } = at(geo.P, s);
    const n = geo.conductors.length;
    const len = n * RIBBON_PITCH + 2;
    const horiz = horizontal(d);
    const offs = offsets(n, RIBBON_PITCH);
    const nrm: Pt = [d[1], -d[0]];
    return (
      <g key={key}>
        <rect
          x={p[0] - (horiz ? 4 : len / 2)}
          y={p[1] - (horiz ? len / 2 : 4)}
          width={horiz ? 8 : len}
          height={horiz ? len : 8}
          rx={3}
          fill="var(--canvas-bg)"
          stroke={color}
          strokeWidth={1.3}
        />
        {geo.conductors.map((c, i) => (
          <circle key={c.id} cx={p[0] + nrm[0] * offs[i]} cy={p[1] + nrm[1] * offs[i]} r={2.2} fill={geo.tint(c)} />
        ))}
      </g>
    );
  };

  const endMark = (s: number, key: string) => {
    const { p } = at(geo.P, s);
    return <rect key={key} x={p[0] - 4} y={p[1] - 4} width={8} height={8} rx={1} fill="var(--canvas-bg)" stroke={color} strokeWidth={1.5} />;
  };

  const toggle = (b: ToggleBox) => {
    const { p, d } = geo.anchor!;
    const nrm = geo.nrm;
    const corners = [b.lo, b.hi].flatMap((o) => [-1, 1].map((k) => [p[0] + nrm[0] * o + d[0] * k * (TOGGLE / 2), p[1] + nrm[1] * o + d[1] * k * (TOGGLE / 2)]));
    const x0 = Math.min(...corners.map((q) => q[0]));
    const y0 = Math.min(...corners.map((q) => q[1]));
    const x1 = Math.max(...corners.map((q) => q[0]));
    const y1 = Math.max(...corners.map((q) => q[1]));
    const g: Pt = [p[0] + nrm[0] * b.glyph, p[1] + nrm[1] * b.glyph];
    return (
      <g key={b.key} className="link-toggle-box nodrag nopan" style={{ cursor: "pointer", pointerEvents: "all" }} {...slider(b.onClick)}>
        <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} rx={4} fill="var(--canvas-bg)" stroke={color} strokeWidth={b.depth ? 1.2 : 1.5} />
        <path
          d={b.open ? `M${g[0] - 3.5},${g[1]} h7` : `M${g[0] - 3.5},${g[1]} h7 M${g[0]},${g[1] - 3.5} v7`}
          stroke={color}
          strokeWidth={b.depth ? 1.2 : 1.5}
          strokeLinecap="round"
        />
      </g>
    );
  };

  const commitPins = (dragged: { kind: "pin" | "bend"; index: number }, to: Pt) => {
    const pins = [...data.pins];
    if (dragged.kind === "pin") pins[dragged.index] = to;
    else {
      const s = project(points, data.bends[dragged.index]);
      const order = pins.map((p) => project(points, p));
      const at = order.findIndex((o) => o > s);
      pins.splice(at < 0 ? pins.length : at, 0, to);
    }
    data.onPins(link.linkId, pins);
  };

  const waypoint = (p: Pt, kind: "pin" | "bend", index: number) => {
    const live = drag && drag.kind === kind && drag.index === index ? drag.at : p;
    return (
      <g
        key={`${kind}${index}`}
        className="nodrag nopan"
        style={{ cursor: "move", pointerEvents: "all" }}
        onPointerDown={(e) => {
          e.stopPropagation();
          const key = `${link.linkId}|${kind}${index}`;
          const now = performance.now();
          if (kind === "pin" && lastPress.current?.key === key && now - lastPress.current.t < 400) {
            lastPress.current = null;
            data.onPins(link.linkId, data.pins.filter((_, i) => i !== index));
            return;
          }
          lastPress.current = { key, t: now };
          (e.target as Element).setPointerCapture(e.pointerId);
          setDrag({ kind, index, at: p });
        }}
        onPointerMove={(e) => {
          if (drag && drag.kind === kind && drag.index === index) setDrag({ ...drag, at: snapPt(toFlow(e)) });
        }}
        onPointerUp={(e) => {
          if (!drag) return;
          const to = snapPt(toFlow(e));
          setDrag(null);
          if (Math.hypot(to[0] - p[0], to[1] - p[1]) >= 1) commitPins({ kind, index }, to);
        }}
      >
        <title>{kind === "pin" ? "Pinned waypoint: drag to move, double-click to release" : "Drag to pin a waypoint here"}</title>
        <circle cx={live[0]} cy={live[1]} r={9} fill="transparent" />
        {kind === "pin" ? (
          <rect x={live[0] - 4.5} y={live[1] - 4.5} width={9} height={9} rx={2} fill="var(--brand)" stroke="var(--canvas-bg)" strokeWidth={1.5} />
        ) : (
          <circle cx={live[0]} cy={live[1]} r={4.5} fill="var(--canvas-bg)" stroke="var(--text-muted)" strokeWidth={1.5} />
        )}
      </g>
    );
  };

  const anchor = geo.anchor;
  // label beside the toggles and parallel to the line (design D13): above a horizontal stretch;
  // right of a vertical one, turned to read bottom-to-top with its top towards the line
  const labelTf = anchor
    ? horizontal(anchor.d)
      ? `translate(${anchor.p[0]}px, ${Math.min(...geo.ends.map((q) => q[1])) - 4}px) translate(-50%, -100%)`
      : `translate(${Math.max(...geo.ends.map((q) => q[0])) + 4}px, ${anchor.p[1]}px) rotate(-90deg) translate(-50%, 0)`
    : undefined;
  const tabTf = (b: { x: number; y: number; side: "above" | "below" | "left" }) =>
    b.side === "left"
      ? `translate(${b.x}px, ${b.y}px) rotate(-90deg) translate(-100%, -100%)`
      : `translate(${b.x}px, ${b.y}px) translate(0, ${b.side === "below" ? "0" : "-100%"})`;

  return (
    <>
      {geo.region && (
        <path d={geo.region} fill="#ffffff0d" stroke="var(--text-muted)" strokeWidth={1.8} strokeDasharray="0 6" strokeLinecap="round" opacity={faded ? 0.3 : 1} />
      )}
      {selected && <path d={main} className="edge-glow" stroke={color} strokeWidth={geo.ribbonMode ? geo.conductors.length * RIBBON_PITCH + 6 : 8} />}
      {geo.ribbonMode && (
        <g opacity={0.15}>
          <path d={main} fill="none" stroke={color} strokeWidth={geo.conductors.length * RIBBON_PITCH + 4} strokeLinejoin="round" />
          {geo.band && <path d={geo.band} fill={color} stroke="none" />}
        </g>
      )}
      {geo.lines.length ? (
        geo.lines.map((l) => <path key={l.key} d={l.d} fill="none" stroke={l.color} strokeWidth={l.width} opacity={opacity} strokeLinecap="round" strokeLinejoin="round" />)
      ) : (
        <BaseEdge
          id={id}
          path={main}
          style={{
            stroke: color,
            strokeWidth: link.passThrough ? 1.4 : geo.expandable ? 3 : 2,
            opacity,
            strokeDasharray: link.passThrough ? "4 4" : undefined,
          }}
        />
      )}
      <path d={main} fill="none" stroke="transparent" strokeWidth={16} className="react-flow__edge-interaction" />

      {geo.ribbonMode && [handleAt(0.5, "h0"), handleAt(geo.L - 0.5, "h1")]}
      {geo.run && (geo.ribbonMode ? [handleAt(geo.run[0], "r0"), handleAt(geo.run[1], "r1")] : [endMark(geo.run[0], "m0"), endMark(geo.run[1], "m1")])}

      {anchor && geo.boxes.map(toggle)}

      {selected && !link.passThrough && (
        <g>
          {data.bends.map((p, i) => waypoint(p, "bend", i))}
          {data.pins.map((p, i) => waypoint(p, "pin", i))}
        </g>
      )}

      <EdgeLabelRenderer>
        {data.run?.length && link.run?.tab && geo.regionBox && (
          <div
            className={`harness-tab ${geo.regionBox.side}`}
            style={{ transform: tabTf(geo.regionBox), transformOrigin: "0 0", opacity: faded ? 0.3 : 1 }}
          >
            <Icon name={link.run.icon} size={10} color={color} />
            <span>{link.run.name}</span>
          </div>
        )}
        {geo.expanded &&
          geo.names.map((nm, i) => {
            const a = at(geo.P, nm.s);
            const nrm: Pt = [a.d[1], -a.d[0]];
            const [x, y] = [a.p[0] + nrm[0] * nm.o, a.p[1] + nrm[1] * nm.o];
            // along the lane, reading upright or bottom-to-top (design D13), running from the
            // start of the straight into it whichever way the link travels
            const rot = horizontal(a.d)
              ? a.d[0] < 0
                ? "translate(-100%, -50%)"
                : "translate(0, -50%)"
              : a.d[1] > 0
                ? "rotate(-90deg) translate(-100%, -50%)"
                : "rotate(-90deg) translate(0, -50%)";
            return (
              <div
                key={i}
                className="lane-name"
                style={{ transform: `translate(${x}px, ${y}px) ${rot}`, transformOrigin: "0 0", opacity: faded ? 0.3 : 1 }}
              >
                {nm.swatch && <span className="lane-swatch" style={{ background: nm.color }} />}
                {nm.text}
              </div>
            );
          })}
        {!link.passThrough && labelTf && (
          <div
            className={`link-label nodrag nopan${selected ? " selected" : ""}`}
            style={{ transform: labelTf, transformOrigin: "0 0", borderColor: color, color, opacity: faded ? 0.25 : 1, cursor: "grab" }}
            title="Drag along the link to move the label and its expansion"
            {...slider()}
          >
            {link.manual && <Icon name="lock" size={9} />}
            <span>{link.name.toUpperCase()}</span>
            {selected && data.pins.length > 0 && (
              <button
                className="link-reset"
                title="Release the pinned waypoints (automatic route)"
                onPointerDown={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  data.onPins(link.linkId, []);
                }}
              >
                <Icon name="rotate-ccw" size={9} />
              </button>
            )}
          </div>
        )}
      </EdgeLabelRenderer>
    </>
  );
}

export const edgeTypes = { link: LinkEdge };
