/**
 * One link on the canvas (PB-803, design board 09 · D12, D13).
 *
 * Basic mode: one line at each module. Ribbon mode: every conductor end to
 * end at a tight pitch in its own colour over a soft band. Expanding a link
 * is one breakout: its lanes leave the line together. A lane that itself has
 * children stays one line (or one sub-ribbon) with its own toggle; opening it
 * is a second breakout a level further in, so each level of the hierarchy is
 * its own step along the line. A link that runs through a harness gets a
 * tight dotted region along the harness's span that grows around whatever is
 * drawn inside it, with the harness ends marked.
 *
 * The expansion sits on one straight stretch of the route; its length follows
 * the stretch between a minimum (room for every level's names) and a maximum.
 * The toggles of every level overlap at one point and the label sits beside
 * them; dragging the label or a toggle moves the whole expansion along the
 * route, and dragging the label across the line moves it to the other side.
 * The harness tab behaves the same way. Handles and toggles never sit in a bend.
 *
 * When the link is selected its waypoints show: automatic bends hollow,
 * pinned ones solid. Dragging a bend pins it; double-clicking a pin releases it.
 */
import { useMemo } from "react";
import { BaseEdge, EdgeLabelRenderer, useReactFlow, type Edge, type EdgeProps } from "@xyflow/react";
import type { ViewConductor, ViewLane, ViewLink } from "../model/types";
import { colorFor, conductorColor, type Classification } from "../model/classification";
import { filletPath, offsetPolyline, type Pt } from "./routing";
import {
  LANE_PITCH,
  RIBBON_PITCH,
  RUN,
  at,
  clearOfBends,
  densify,
  easeJogs,
  offsets,
  project,
  regionOutline,
  ribbon,
  ribbonRadius,
  stepped,
  straights,
  type Plateau,
  stretchAt,
  subpath,
  totalLength,
} from "./geometry";
import { Icon } from "./Icon";
import type { LinkLayout } from "../layout/layout";
import type { Live } from "../App";
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
  /** Where the user put the label and harness tab (and which side of the line). */
  edit?: LinkLayout;
  onLayout: (linkId: string, patch: LinkLayout) => void;
  onPins: (linkId: string, pins: Pt[]) => void;
  onLive: (live: Live | null) => void;
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

/** The offset sign (left of travel is positive) that points above a horizontal stretch or right of a vertical one. */
function defaultSign(d: Pt): number {
  const nrm: Pt = [d[1], -d[0]];
  return (horizontal(d) ? -nrm[1] : nrm[0]) >= 0 ? 1 : -1;
}

/**
 * Text beside a line, parallel to it (design D13): upright on a horizontal
 * stretch (above, or below when not on the default side); on a vertical one
 * turned to read bottom to top (right, or left). `at` is the edge nearest the
 * line; `cls` is "below" where the flat edge of a tab faces up (or left).
 */
function placeText(d: Pt, [x, y]: Pt, onDefault: boolean): { tf: string; cls: string } {
  if (horizontal(d)) return onDefault ? { tf: `translate(${x}px, ${y}px) translate(-50%, -100%)`, cls: "" } : { tf: `translate(${x}px, ${y}px) translate(-50%, 0)`, cls: "below" };
  return onDefault
    ? { tf: `translate(${x}px, ${y}px) rotate(-90deg) translate(-50%, 0)`, cls: "below" }
    : { tf: `translate(${x}px, ${y}px) rotate(-90deg) translate(-50%, -100%)`, cls: "" };
}

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
    const isOpen = (it: Item) => bundle(it) && data.openLanes.has(it.id);
    const vis = visibleItems(items, data.openLanes);
    const tight = offsets(n, RIBBON_PITCH);

    // final offsets, where every open level has broken out: one per visible item; in ribbon
    // mode an item keeps its conductors at the ribbon pitch
    const wide: number[] = new Array(n).fill(0);
    const finalOff = new Map<Item, number>();
    if (ribbonMode) {
      let x = 0;
      const raw = vis.map(({ item }, k) => {
        if (k > 0) x += LANE_PITCH;
        const start = x;
        item.conductors.forEach((ci, j) => (wide[ci] = start + j * RIBBON_PITCH));
        x += (item.conductors.length - 1) * RIBBON_PITCH;
        return (start + x) / 2;
      });
      vis.forEach(({ item }, k) => finalOff.set(item, raw[k] - x / 2));
      for (let i = 0; i < n; i++) wide[i] -= x / 2;
    } else offsets(vis.length, LANE_PITCH).forEach((o, k) => finalOff.set(vis[k].item, o));
    /** What an item finally spreads across (its visible descendants, or its conductors). */
    const spanOf = (it: Item): [number, number] => {
      const os = ribbonMode ? it.conductors.map((ci) => wide[ci]) : vis.filter((v) => v.item === it || v.parents.includes(it)).map((v) => finalOff.get(v.item)!);
      return [Math.min(...os), Math.max(...os)];
    };
    /** An item's own line (or sub-ribbon) runs at the middle of what it breaks out into. */
    const centreOf = (it: Item) => {
      const [a, b] = spanOf(it);
      return (a + b) / 2;
    };

    // levels (design D12): level 1 is the link's own breakout; a child that itself has children
    // breaks out again, one level further in. Siblings always break out together.
    const levels: Item[][] = [];
    for (let cur = items; cur.length; cur = cur.filter(isOpen).flatMap((it) => it.children)) levels.push(cur);
    const D = levels.length;
    /** A conductor's offset at level d (0: the tight ribbon). */
    const conductorAt = (ci: number, d: number): number => {
      if (d === 0) return tight[ci];
      const x = levels[d - 1].find((it) => it.conductors.includes(ci));
      if (!x) return conductorAt(ci, d - 1);
      if (x.conductors.length === 1) return wide[ci];
      return centreOf(x) + (x.conductors.indexOf(ci) - (x.conductors.length - 1) / 2) * RIBBON_PITCH;
    };
    const fans = levels.map((_, i) =>
      ribbonMode ? Math.max(RUN, Math.min(40, Math.max(...tight.map((_, ci) => Math.abs(conductorAt(ci, i + 1) - conductorAt(ci, i)))) * 0.7)) : RUN,
    );
    const nameRoom = levels.map((lv) => 6 + Math.max(...lv.map((it) => it.name.length)) * NAME_CHAR + (ribbonMode ? 9 : 0) + 8 + 6);
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    const fanTotal = 2 * sum(fans);
    // names then toggle: centred needs every level's names on both sides; tight puts the toggle after the names
    const tightNeed = fanTotal + sum(nameRoom) + 4 * D + TOGGLE + 8;
    const centredNeed = fanTotal + 2 * sum(nameRoom) + TOGGLE + 8;

    // the expansion point: on a straight stretch, clear of the bends
    const clear = R + TOGGLE / 2 + 4;
    let c = clearOfBends(P, data.labelAt !== undefined ? onP(data.labelAt) : L / 2, clear, 12);
    const expanded = open && expandable;
    let win: [number, number] | undefined;
    let A: number[] = [];
    let B: number[] = [];
    let F = fans;
    let showNames = true;
    if (expanded) {
      if (!data.labelFixed) {
        // placed automatically: move to the nearest stretch the expansion fits on (or the longest)
        const iv = straights(P, R + (data.run ? 14 : 0), 12);
        const fit = iv.filter(([a, b]) => b - a >= tightNeed);
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
      // on a short stretch the fans steepen first, then the names drop (only where the user forces it)
      const k = avail >= tightNeed ? 1 : Math.max(0.4, Math.min(1, (avail - (tightNeed - fanTotal)) / fanTotal));
      F = fans.map((f) => f * k);
      showNames = avail >= tightNeed - fanTotal * (1 - k) - 0.5;
      const room = showNames ? nameRoom : nameRoom.map(() => 8);
      const centred = showNames && avail >= centredNeed;
      const base = 2 * sum(F) + (centred ? 2 * sum(room) : sum(room) + 4 * D) + TOGGLE + 8;
      const W = base + Math.max(0, Math.min(MAX_EXTRA, avail - base));
      const w0 = W <= avail ? Math.max(a, Math.min(b - W, c - W / 2)) : Math.max(2, Math.min(L - W - 2, c - W / 2));
      win = [w0, w0 + W];
      A = [w0];
      B = [w0 + W];
      for (let d = 1; d < D; d++) {
        A.push(A[d - 1] + F[d - 1] + room[d - 1]);
        B.push(B[d - 1] - F[d - 1] - (centred ? room[d - 1] : 4));
      }
      c = centred ? w0 + W / 2 : B[D - 1] - F[D - 1] - TOGGLE / 2 - 4;
    }

    // what gets drawn
    const lines: { d: string; color: string; width: number; key: string }[] = [];
    const samples: Pt[] = [];
    const names: { s: number; o: number; text: string; color: string; swatch?: boolean }[] = [];
    let band: string | undefined;
    const laneColor = (l?: ViewLane) => (data.mode === "domain" || !l ? data.color : colorFor(l, data.mode));
    const draw = (plateaus: Plateau[], color: string, width: number, key: string) => {
      const sh = stepped(P, plateaus, R);
      lines.push({ d: sh.d, color, width, key });
      samples.push(...sh.samples);
    };

    if (win) {
      // names: every item at the start of its own level's straight, on its own line
      levels.forEach((lv, i) =>
        lv.forEach((it) => {
          const single = ribbonMode && it.conductors.length === 1;
          names.push({
            s: A[i] + F[i] + 6,
            o: centreOf(it),
            text: it.name,
            color: single ? tint(conductors[it.conductors[0]]) : ribbonMode ? data.color : laneColor(it.lane),
            swatch: single,
          });
        }),
      );
    }

    if (ribbonMode) {
      if (win) {
        // every conductor steps out level by level and back
        for (let ci = 0; ci < n; ci++) {
          const pl: Plateau[] = [{ o: tight[ci], a: 0, b: A[0] }];
          for (let d = 1; d <= D; d++) pl.push({ o: conductorAt(ci, d), a: A[d - 1] + F[d - 1], b: d < D ? A[d] : B[D - 1] - F[D - 1] });
          for (let d = D - 1; d >= 1; d--) pl.push({ o: conductorAt(ci, d), a: B[d], b: B[d - 1] - F[d - 1] });
          pl.push({ o: tight[ci], a: B[0], b: L });
          draw(pl, tint(conductors[ci]), 2.4, conductors[ci].id);
        }
        const inWin = (p: Pt) => {
          const q = project(P, p);
          return q > win[0] - 4 && q < win[1] + 4;
        };
        band = regionOutline(samples.filter(inWin), 5);
      } else {
        ribbon(P, n, R).forEach((r, i) => {
          lines.push({ d: r.d, color: tint(conductors[i]), width: 2.4, key: conductors[i].id });
          samples.push(...r.samples);
        });
      }
    } else if (win) {
      // the link's own line up to its breakout and from its rejoin
      draw([{ o: 0, a: 0, b: A[0] }], data.color, 2, "near");
      draw([{ o: 0, a: B[0], b: L }], data.color, 2, "far");
      // each item leaves its parent's line with its siblings, and an open one breaks out again a level in
      const walk = (list: Item[], d: number, parent: number) => {
        for (const it of list) {
          const o = centreOf(it);
          const color = laneColor(it.lane);
          if (isOpen(it)) {
            draw([{ o: parent, a: A[d], b: A[d] }, { o, a: A[d] + F[d], b: A[d + 1] }], color, 3, `${it.id}<`);
            draw([{ o, a: B[d + 1], b: B[d] - F[d] }, { o: parent, a: B[d], b: B[d] }], color, 3, `${it.id}>`);
            walk(it.children, d + 1, o);
          } else draw([{ o: parent, a: A[d], b: A[d] }, { o, a: A[d] + F[d], b: B[d] - F[d] }, { o: parent, a: B[d], b: B[d] }], color, bundle(it) ? 3 : 2, it.id);
        }
      };
      walk(items.length === levels[0].length ? items : levels[0], 0, 0);
    } else {
      samples.push(...densify(P));
    }

    // toggles: every level at the same point, inner ones on top of the ones that contain them
    const boxes: ToggleBox[] = [];
    const at0 = at(P, c);
    const nrm: Pt = [at0.d[1], -at0.d[0]];
    // the label's side as an offset sign: above a horizontal stretch or right of a vertical one, unless flipped
    const labelOnDefault = !data.edit?.labelFlip;
    const labelSign = defaultSign(at0.d) * (labelOnDefault ? 1 : -1);
    // caps go on the label's side, clear of the harness tab
    const capHi = labelSign > 0;
    const withGlyph = (key: string, lo: number, hi: number, open: boolean, depth: number, onClick: () => void, inner: ToggleBox[]) => {
      const mid = (lo + hi) / 2;
      const covered = inner.some((b) => b.depth === depth + 1 && mid > b.lo - 5 && mid < b.hi + 5);
      if (!covered) return boxes.push({ key, lo, hi, glyph: mid, open, depth, onClick });
      return capHi
        ? boxes.push({ key, lo, hi: hi + 14, glyph: hi + 7, open, depth, onClick })
        : boxes.push({ key, lo: lo - 14, hi, glyph: lo - 7, open, depth, onClick });
    };
    if (expandable) {
      if (!expanded) {
        const half = ribbonMode ? (n * RIBBON_PITCH) / 2 + 2 : 10;
        withGlyph("main", -half, half, false, 0, () => data.onToggle(link.linkId), []);
      } else {
        const pad = ribbonMode ? RIBBON_PITCH / 2 + 2 : 8;
        // nested bundles first (deepest first), so a parent knows whether its centre is covered
        const nested = levels.flatMap((lv, i) => lv.filter(bundle).map((it) => ({ it, depth: i + 1 })));
        nested.sort((x, y) => y.depth - x.depth);
        for (const { it, depth } of nested) {
          const [lo, hi] = isOpen(it) ? spanOf(it) : [centreOf(it), centreOf(it)];
          const half = isOpen(it) || !ribbonMode ? pad : (it.conductors.length * RIBBON_PITCH) / 2 + 2;
          withGlyph(`n${it.id}`, lo - (isOpen(it) ? pad : half), hi + (isOpen(it) ? pad : half), isOpen(it), depth, () => data.onToggleLane(it.id), isOpen(it) ? [...boxes] : []);
        }
        const all = [...finalOff.values(), ...(ribbonMode ? wide : [])];
        withGlyph("main", Math.min(...all) - pad - 2, Math.max(...all) + pad + 2, true, 0, () => data.onToggle(link.linkId), [...boxes]);
      }
      boxes.sort((x, y) => x.depth - y.depth);
    }

    // harness region: tight to what runs inside the harness span (grown to take in the expansion)
    let region: string | undefined;
    let tab: { tf: string; cls: string } | undefined;
    let run = data.run ? ([onP(data.run[0]), onP(data.run[1])] as [number, number]) : undefined;
    if (run && win) {
      // grown to take in the expansion, with its ends (connector handles) still on straight stretches
      const iv = straights(P, R + 6, 8);
      const before = (s: number) => Math.max(6, ...iv.filter(([a]) => a <= s).map(([a, b]) => Math.min(b, s)));
      const after = (s: number) => Math.min(L - 6, ...iv.filter(([, b]) => b >= s).map(([a, b]) => Math.max(a, s)));
      run = [run[0] < win[0] - 8 ? run[0] : before(win[0] - 8), run[1] > win[1] + 8 ? run[1] : after(win[1] + 8)];
    }
    let tabAt: number | undefined;
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
      if (link.run?.tab) {
        // the name tab works like the link label (design D13): parallel to the line, on a straight
        // stretch (by default the long one nearest the harness's middle), outside the region, on
        // the side away from the link label unless flipped; drag it along or across
        const tabLen = link.run.name.length * 5.6 + 30;
        const mid = (r0 + r1) / 2;
        const iv = straights(P, R + 4, 8)
          .map(([a, b]) => [Math.max(a, r0 + 4), Math.min(b, r1 - 4)] as [number, number])
          .filter(([a, b]) => b > a);
        let s = data.edit?.tabT !== undefined ? onP(data.edit.tabT * totalLength(data.points)) : undefined;
        if (s === undefined) {
          const fit = iv.filter(([a, b]) => b - a >= tabLen);
          const pool = fit.length ? fit : iv.length ? [iv.reduce((x, y) => (y[1] - y[0] > x[1] - x[0] ? y : x))] : [];
          let best = mid;
          let dist = Infinity;
          for (const [a, b] of pool) {
            const lo = Math.min(a + tabLen / 2, (a + b) / 2);
            const hi = Math.max(b - tabLen / 2, (a + b) / 2);
            const q = Math.max(lo, Math.min(hi, mid));
            if (Math.abs(q - mid) < dist) [best, dist] = [q, Math.abs(q - mid)];
          }
          s = best;
        } else s = clearOfBends(P, s, R + 4, 8);
        tabAt = s;
        const ta = at(P, s);
        const tn: Pt = [ta.d[1], -ta.d[0]];
        // opposite the label by default
        const tabOnDefault = labelOnDefault === Boolean(data.edit?.tabFlip);
        const sign = defaultSign(ta.d) * (tabOnDefault ? 1 : -1);
        // how far the region reaches on that side around the tab
        const near = inner.filter((q) => Math.abs(project(P, q) - s!) <= tabLen / 2 + 8);
        const reach = Math.max(4, ...near.map((q) => sign * ((q[0] - ta.p[0]) * tn[0] + (q[1] - ta.p[1]) * tn[1]))) + 10;
        const [x, y] = [ta.p[0] + tn[0] * sign * reach, ta.p[1] + tn[1] * sign * reach];
        tab = placeText(ta.d, [x, y], tabOnDefault);
      }
    }

    // label: beside the toggles, on its side
    const extent = boxes.length ? boxes.reduce((e, b) => [Math.min(e[0], b.lo), Math.max(e[1], b.hi)], [Infinity, -Infinity]) : [-4, 4];
    const edge = labelSign > 0 ? extent[1] + 4 : extent[0] - 4;
    const label = placeText(at0.d, [at0.p[0] + nrm[0] * edge, at0.p[1] + nrm[1] * edge], labelOnDefault);

    return {
      P,
      L,
      R,
      lines,
      samples,
      names: showNames ? names : [],
      band,
      region,
      tab,
      tabAt,
      run,
      anchor: data.labelAt !== undefined ? at0 : undefined,
      nrm,
      label,
      labelOnDefault,
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

  /**
   * Drag the label (or a toggle, or the harness tab) along the route; dragging
   * it across the line moves it to the other side. A press without a drag is a
   * click. The drag listens on the window: the edge remounts as the layout
   * updates, which ends any pointer capture on its elements.
   */
  const slider = (what: "label" | "tab", onClick?: () => void) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.stopPropagation();
      if (e.button !== 0) return;
      const P = geo.P;
      const L0 = totalLength(points);
      const start = { x: e.clientX, y: e.clientY };
      let moved = false;
      let onDefault = what === "label" ? geo.labelOnDefault : geo.labelOnDefault === Boolean(data.edit?.tabFlip);
      const labelOnDefault = geo.labelOnDefault;
      const move = (ev: PointerEvent) => {
        if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
        moved = true;
        const f = flow.screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
        const q: Pt = [f.x, f.y];
        const t = project(points, q) / L0;
        // which side of the line the pointer is on (only once it is clearly across)
        const a = at(P, project(P, q));
        const across = ((q[0] - a.p[0]) * a.d[1] - (q[1] - a.p[1]) * a.d[0]) * defaultSign(a.d);
        if (Math.abs(across) > 14) onDefault = across > 0;
        if (what === "label") data.onLayout(link.linkId, { labelT: t, labelFlip: !onDefault });
        else data.onLayout(link.linkId, { tabT: t, tabFlip: labelOnDefault === onDefault });
      };
      // capture phase: the window sees these before any element can stop them
      const up = () => {
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", up, true);
        if (!moved) onClick?.();
      };
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", up, true);
    },
    onPointerUp: (e: React.PointerEvent) => e.stopPropagation(),
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
      <g key={b.key} className="link-toggle-box nodrag nopan" style={{ cursor: "pointer", pointerEvents: "all" }} {...slider("label", b.onClick)}>
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

  /**
   * Drag a waypoint: the link reroutes live through it as it moves (only this
   * link, around the others), and everything reroutes once it is dropped.
   * Dragging an automatic bend pins it. Tracked on the window like the label.
   */
  const waypoint = (p: Pt, kind: "pin" | "bend", index: number) => (
    <g
      key={`${kind}${index}`}
      className="nodrag nopan"
      style={{ cursor: "move", pointerEvents: "all" }}
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.button !== 0) return;
        const key = `${link.linkId}|${kind}${index}`;
        const now = performance.now();
        if (kind === "pin" && lastPress.current?.key === key && now - lastPress.current.t < 400) {
          lastPress.current = null;
          data.onPins(link.linkId, data.pins.filter((_, i) => i !== index));
          return;
        }
        lastPress.current = { key, t: now };
        const pins = [...data.pins];
        let at = kind === "pin" ? index : -1;
        let last = p;
        data.onLive({ links: new Set([link.linkId]) });
        const move = (ev: PointerEvent) => {
          const f = flow.screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
          const to = snapPt([f.x, f.y]);
          if (to[0] === last[0] && to[1] === last[1]) return;
          last = to;
          if (at < 0) {
            // an automatic bend becomes a pin, in route order among the existing pins
            const s = project(points, p);
            const k = pins.findIndex((q) => project(points, q) > s);
            at = k < 0 ? pins.length : k;
            pins.splice(at, 0, to);
          } else pins[at] = to;
          data.onPins(link.linkId, [...pins]);
        };
        const up = () => {
          window.removeEventListener("pointermove", move, true);
          window.removeEventListener("pointerup", up, true);
          data.onLive(null);
        };
        window.addEventListener("pointermove", move, true);
        window.addEventListener("pointerup", up, true);
      }}
    >
      <title>{kind === "pin" ? "Pinned waypoint: drag to move, double-click to release" : "Drag to pin a waypoint here"}</title>
      <circle cx={p[0]} cy={p[1]} r={9} fill="transparent" />
      {kind === "pin" ? (
        <rect x={p[0] - 4.5} y={p[1] - 4.5} width={9} height={9} rx={2} fill="var(--brand)" stroke="var(--canvas-bg)" strokeWidth={1.5} />
      ) : (
        <circle cx={p[0]} cy={p[1]} r={4.5} fill="var(--canvas-bg)" stroke="var(--text-muted)" strokeWidth={1.5} />
      )}
    </g>
  );

  const anchor = geo.anchor;
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
        {link.run?.tab && geo.tab && (
          <div
            className={`harness-tab nodrag nopan ${geo.tab.cls}`}
            style={{ transform: geo.tab.tf, transformOrigin: "0 0", opacity: faded ? 0.3 : 1 }}
            title="Drag along the harness, or across it to the other side"
            {...slider("tab")}
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
        {!link.passThrough && geo.anchor && (
          <div
            className={`link-label nodrag nopan${selected ? " selected" : ""}`}
            style={{ transform: geo.label.tf, transformOrigin: "0 0", borderColor: color, color, opacity: faded ? 0.25 : 1, cursor: "grab" }}
            title="Drag along the link to move the label and its expansion, or across it to the other side"
            {...slider("label")}
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
