/**
 * Callout labels for the 3D view (PB-775): screen-space cards with leader
 * lines to 3D anchors, laid out in two columns like a product manual's
 * exploded-view callouts. HTML stays upright and camera-facing by
 * construction; positions are recomputed every frame.
 *
 * R1-C (Kevin's walkthrough, D5 and M12): the coloured end bar sits on the
 * side the leader enters; a label changes column only after its anchor has
 * stayed well across the midline for a moment (hysteresis), and a slot change
 * eases instead of jumping, while ordinary motion follows the anchor in the
 * same frame; labels whose anchor is behind the model's centre are drawn
 * faded; no internal wording in subtitles.
 *
 * R2-C (D5 continued): a crowded side goes compact (one line a label), then a second column, then a "+N" chip for
 * the least important; a long move eases longer; a label whose anchor leaves the view is a pin on the view's edge
 * pointing at it; the `refdes` and `mpn` kinds (a board's parts).
 */
import * as THREE from "three";
import { attachWheelForward, canvasIn } from "./annot/wheel";
import { cadDebugEnabled } from "./scene";

/**
 * Kinds of label. `refdes` and `mpn` (R2-A's schema and items, R2-C's look): one label per placed component drawn
 * inside a body (a board's parts), titled by its reference designator or its manufacturer part number.
 */
export type LabelKind = "module" | "harness" | "interface" | "finding" | "refdes" | "mpn";

export interface LabelItem {
  id: string;
  kind: LabelKind;
  title: string;
  sub?: string;
  /** A second class for the card, leader and dot (a finding's severity: "error", "warning"). */
  tone?: string;
  /** Which labels stay when a side is crowded (R2-C): higher stays. Default: 2 for tone error, 1 for warning, else 0. */
  importance?: number;
  /** World-space anchor (read every frame, so it follows explode and animation). */
  anchor: () => THREE.Vector3 | null;
  onClick?: () => void;
}

const SVGNS = "http://www.w3.org/2000/svg";

/** Vertical gap between cards in a column, and the clearance between the model's anchors and a column. */
export const LABEL_GAP = 6;
const COLUMN_OFFSET = 56;
const COLUMN_GAP = 16;
/** The leader's short level run into a card's inner edge. */
export const LEADER_RUN = 16;

/**
 * Column hysteresis (walkthrough D5: "snappy, chunky, pushing the other elements aside ... looks buggy"): a label
 * moves to the other column only when its anchor has been past the anchors' midline, on that side, by more than
 * this share of the view's width, for SWITCH_HOLD_MS. DEFAULT 8 % and 150 ms (R1-C).
 */
export const SWITCH_MARGIN = 0.08;
export const SWITCH_HOLD_MS = 150;
/** A slot change (another column, a reorder, a spill) eases over this long, ease-out. DEFAULT 120 ms (R1-C). */
export const SLOT_EASE_MS = 120;
/** A target that moves more than this in one frame is a slot change (eased); less is motion (followed at once). DEFAULT 12 px. */
export const JUMP_PX = 12;
/**
 * Labels whose anchor is behind the model's centre (depth from the camera) are drawn at this opacity (walkthrough
 * D5 z-order, done here as it was cheap). DEFAULT 0.6 (R1-C); the model's centre is the anchors' centroid unless
 * the host sets `LabelLayer.centre`.
 */
export const BEHIND_OPACITY = 0.6;

/**
 * Wording that is about how the viewer placed a part, not about the part (walkthrough M12: "placed by a display
 * hint" showed as a subtitle). Such a subtitle is dropped: a label's subtitle is the part's refdes or MPN, or nothing.
 */
const INTERNAL_WORDING = /\b(placed by|display hint|placeholder|provenance|auto-?placed|layout hint)\b/i;

/** The subtitle a label shows (walkthrough M12): the text given, unless it is internal wording; trimmed. */
export function labelSubtitle(sub: string | undefined): string | undefined {
  const t = sub?.trim();
  if (!t || INTERNAL_WORDING.test(t)) return undefined;
  return t;
}

/** A label's subtitle from a part's facts (M12): its refdes, else its MPN, else nothing. */
export function partSubtitle(facts: { refdes?: string | undefined; mpn?: string | undefined } | undefined): string | undefined {
  return labelSubtitle(facts?.refdes) ?? labelSubtitle(facts?.mpn);
}

/**
 * Which side each label keeps (pure; the column hysteresis of walkthrough D5). `prev` is last frame's side, `since`
 * when the anchor was first seen past the switch line on the other side. A label with no side yet gets none here
 * (the solver chooses it).
 */
export function holdSides(
  items: { id: string; x: number }[],
  prev: Map<string, { side: -1 | 1; since?: number }>,
  width: number,
  now: number,
  margin = SWITCH_MARGIN,
  hold = SWITCH_HOLD_MS,
): Map<string, { side: -1 | 1; since?: number }> {
  const out = new Map<string, { side: -1 | 1; since?: number }>();
  if (!items.length) return out;
  const xs = items.map((p) => p.x);
  const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
  const line = margin * width;
  for (const p of items) {
    const was = prev.get(p.id);
    if (!was) continue;
    const across = was.side < 0 ? p.x > mid + line : p.x < mid - line;
    if (!across) out.set(p.id, { side: was.side });
    else {
      const since = was.since ?? now;
      out.set(p.id, now - since >= hold ? { side: (was.side * -1) as -1 | 1 } : { side: was.side, since });
    }
  }
  return out;
}

/** Ease-out (cubic): the share of a slot change still to go at `t` of `ms` (1 at the start, 0 at the end). */
export const easeLeft = (t: number, ms = SLOT_EASE_MS): number => {
  const p = Math.min(1, Math.max(0, t / ms));
  return Math.pow(1 - p, 3);
};

/** Whether segments p1–p2 and q1–q2 cross (touching at an end does not count). */
export function segmentsCross(p1: [number, number], p2: [number, number], q1: [number, number], q2: [number, number]): boolean {
  const d = (a: [number, number], b: [number, number], c: [number, number]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(q1, q2, p1);
  const d2 = d(q1, q2, p2);
  const d3 = d(p1, p2, q1);
  const d4 = d(p1, p2, q2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** A card to place: its anchor on screen (x, y) and its size. */
export interface LabelBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Which labels stay when a side has more than its slots (R2-C, D5): higher stays (a finding's severity). Default 0. */
  importance?: number;
  /** The anchor's depth from the camera: among equals, the farthest collapse first. Default 0. */
  depth?: number;
}

/** Where a card goes: its top-left corner, the side of the model, which column on that side (0 nearest), its size. */
export interface SolvedLabel {
  x: number;
  y: number;
  side: -1 | 1;
  column: number;
  /** Drawn compact (one line, title only) because its side is crowded (R2-C, D5). */
  compact: boolean;
  w: number;
  h: number;
}

/** A "+N" chip at a crowded column's end: the labels collapsed into it (R2-C, D5). */
export interface LabelChip {
  side: -1 | 1;
  column: number;
  x: number;
  y: number;
  w: number;
  h: number;
  ids: string[];
}

export interface LabelLayout {
  placed: Map<string, SolvedLabel>;
  chips: LabelChip[];
  /** Which sides are compact this frame (fed back next frame: the switch back has hysteresis). */
  compact: { left: boolean; right: boolean };
}

/**
 * Crowded columns (R2-C, walkthrough D5 and the R1 gate's finding: "in a crowded left column near the top edge cards
 * overlap"). A side whose cards do not fit the view's height at LABEL_GAP is drawn compact: one line, title only,
 * COMPACT_H tall, at a MIN_PITCH spacing (DEFAULT 18 px). Still too many: a second column one label width further out
 * (or further in, when the first is against the view's edge). Still too many: the least important labels (lowest
 * severity, then farthest from the camera) collapse into a "+N" chip at the outer column's end, which lists them on
 * hover. A side goes back to full cards only when they fit with COMPACT_RELEASE to spare (no flicker at the line).
 * DEFAULTs (R2-C): MIN_PITCH 18, COMPACT_H 16, COMPACT_MAX_W 160, MAX_COLUMNS 2, CHIP_W 40, COMPACT_RELEASE 0.9.
 */
export const MIN_PITCH = 18;
export const COMPACT_H = 16;
export const COMPACT_MAX_W = 160;
export const MAX_COLUMNS = 2;
export const CHIP_W = 40;
export const COMPACT_RELEASE = 0.9;

const sideKey = (s: -1 | 1) => (s < 0 ? "left" : "right") as "left" | "right";
const CHIP = "\u0000chip";

/**
 * Callout placement (PB-873): cards in columns either side of the model,
 * each column ordered by its anchors' screen y (then untangled, where two
 * anchors at much the same height would still cross) so leader lines do not
 * cross, and stacked so no two cards overlap. Sides are chosen by anchor x and then
 * balanced by height; a side taller than the view goes compact, then spills into a second column, then collapses its
 * least important labels into a "+N" chip (R2-C). Pure: re-solved every frame as the camera moves.
 */
export function layoutLabels(
  items: LabelBox[],
  width: number,
  height: number,
  m: { top: number; bottom: number; left: number; right: number },
  fixed?: Map<string, -1 | 1>,
  prevCompact?: { left?: boolean; right?: boolean },
): LabelLayout {
  const out: LabelLayout = { placed: new Map(), chips: [], compact: { left: false, right: false } };
  if (!items.length) return out;
  const minX = Math.min(...items.map((p) => p.x));
  const maxX = Math.max(...items.map((p) => p.x));
  const mid = (minX + maxX) / 2;
  const avail = Math.max(1, height - m.top - m.bottom);
  // a label that already has a side keeps it (the caller's hysteresis, holdSides); the rest by their anchor's x
  const side = new Map<string, -1 | 1>(items.map((p) => [p.id, fixed?.get(p.id) ?? (p.x < mid || (p.x === mid && p.y < 0) ? -1 : 1)]));
  // labels held on the side across from their anchor (hysteresis, waiting to switch): their long leaders cross the
  // others, and untangling them would shuffle the column for a few frames before they switch anyway (R1-C)
  const across = new Set(items.filter((p) => fixed?.has(p.id) && (p.x < mid ? -1 : 1) !== fixed.get(p.id)).map((p) => p.id));
  const stack = (s: -1 | 1) => items.filter((p) => side.get(p.id) === s).reduce((t, p) => t + p.h + LABEL_GAP, 0);
  // balance by height: move the most central anchors across while that evens the columns
  for (let guard = 0; guard < items.length; guard++) {
    const from: -1 | 1 = stack(-1) > stack(1) ? -1 : 1;
    const cand = items.filter((p) => side.get(p.id) === from && !fixed?.has(p.id)).sort((a, b) => Math.abs(a.x - mid) - Math.abs(b.x - mid) || a.id.localeCompare(b.id))[0];
    if (!cand) break;
    const before = Math.abs(stack(-1) - stack(1));
    side.set(cand.id, (from * -1) as -1 | 1);
    if (Math.abs(stack(-1) - stack(1)) >= before) {
      side.set(cand.id, from);
      break;
    }
  }
  /** Per side: compact or not, the first column's inner edge and its widest card. */
  const plan = new Map<-1 | 1, { all: LabelBox[]; compact: boolean; e0: number; wAll: number }>();
  const makePlan = () => {
    plan.clear();
    for (const s of [-1, 1] as const) {
      const all = items.filter((p) => side.get(p.id) === s).sort((a, b) => a.y - b.y || a.id.localeCompare(b.id));
      if (!all.length) continue;
      // compact when the full cards do not fit one column (and stays so until they fit with room to spare)
      const need = all.reduce((t, p) => t + p.h + LABEL_GAP, 0) - LABEL_GAP;
      const compact = prevCompact?.[sideKey(s)] ? need > avail * COMPACT_RELEASE : need > avail;
      const wAll = Math.max(...all.map((p) => (compact ? Math.min(p.w, COMPACT_MAX_W) : p.w)));
      // the first column's inner edge, beside the anchors, kept on screen
      const edge = s < 0 ? minX - COLUMN_OFFSET : maxX + COLUMN_OFFSET;
      const e0 = s < 0 ? Math.max(m.left + wAll, Math.min(edge, width - m.right)) : Math.min(width - m.right - wAll, Math.max(edge, m.left));
      plan.set(s, { all, compact, e0, wAll });
    }
  };
  makePlan();
  // the model against an edge of the view (R2-C, D5): both columns clamped into the same strip would overlap, so the
  // side with less room beside its anchors sends its labels to the other side
  const l = plan.get(-1);
  const r = plan.get(1);
  if (l && r && l.e0 + COLUMN_GAP > r.e0) {
    const roomL = minX - COLUMN_OFFSET - m.left - l.wAll;
    const roomR = width - m.right - (maxX + COLUMN_OFFSET) - r.wAll;
    const from: -1 | 1 = roomL < roomR ? -1 : 1;
    for (const p of items) if (side.get(p.id) === from) side.set(p.id, (from * -1) as -1 | 1);
    across.clear();
    makePlan();
  }
  // the x ranges taken by columns so far (both first columns, then each second one as it is placed): a second column
  // never crosses another (R2-C: the model filling the view sent both sides' second columns inward, over each other)
  const taken: [number, number][] = [...plan].map(([s, p]) => (s < 0 ? [p.e0 - p.wAll, p.e0] : [p.e0, p.e0 + p.wAll]));
  const free = (x0: number, x1: number) => x0 >= m.left - 0.01 && x1 <= width - m.right + 0.01 && taken.every(([a, b]) => x1 + COLUMN_GAP <= a + 0.01 || x0 >= b + COLUMN_GAP - 0.01);
  for (const s of [-1, 1] as const) {
    const pl = plan.get(s);
    if (!pl) continue;
    const { all, compact, e0, wAll } = pl;
    out.compact[sideKey(s)] = compact;
    const gap = compact ? MIN_PITCH - COMPACT_H : LABEL_GAP;
    const size = (p: LabelBox) => (compact ? { w: Math.min(p.w, COMPACT_MAX_W), h: COMPACT_H } : { w: p.w, h: p.h });
    // columns: one; compact and too tall, a second one label width out (in, when the first is against the edge)
    const cap = compact ? Math.max(1, Math.floor((avail + gap) / MIN_PITCH)) : all.length;
    const edges = [e0];
    if (compact && all.length > cap && MAX_COLUMNS > 1) {
      // a column's inner edge and its x range: further out, else further in (over the model), where nothing else is
      const outer = s < 0 ? e0 - wAll - COLUMN_GAP : e0 + wAll + COLUMN_GAP;
      const inner = s < 0 ? e0 + COLUMN_GAP + wAll : e0 - COLUMN_GAP - wAll;
      const range = (e: number): [number, number] => (s < 0 ? [e - wAll, e] : [e, e + wAll]);
      const pick = [outer, inner].find((e) => free(...range(e)));
      if (pick !== undefined) {
        edges.push(pick);
        taken.push(range(pick));
      }
    }
    const slots = cap * edges.length;
    // too many still: the least important collapse into a chip (one slot of the last column)
    let kept = all;
    let collapsed: LabelBox[] = [];
    if (all.length > slots) {
      const rank = [...all].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0) || (a.depth ?? 0) - (b.depth ?? 0) || a.id.localeCompare(b.id));
      const keep = new Set(rank.slice(0, Math.max(0, slots - 1)).map((p) => p.id));
      kept = all.filter((p) => keep.has(p.id));
      collapsed = all.filter((p) => !keep.has(p.id));
    }
    // contiguous runs in y per column (the first column the upper run): the leaders of the next column's cards pass
    // the first column below its last card
    const cols: LabelBox[][] = edges.map(() => []);
    const per = Math.max(1, Math.ceil((kept.length + (collapsed.length ? 1 : 0)) / edges.length));
    kept.forEach((p, i) => cols[Math.min(edges.length - 1, Math.floor(i / per))].push(p));
    if (collapsed.length) cols[edges.length - 1].push({ id: CHIP, x: s < 0 ? 0 : width, y: Infinity, w: CHIP_W, h: compact ? COMPACT_H : 20 });
    cols.forEach((col, ci) => {
      if (!col.length) return;
      const e = edges[ci];
      const sz = col.map((p) => (p.id === CHIP ? { w: p.w, h: p.h } : size(p)));
      const stackYs = () => {
        const ys = col.map((p, i) => (Number.isFinite(p.y) ? p.y - sz[i].h / 2 : height - m.bottom - sz[i].h));
        for (let i = 1; i < ys.length; i++) ys[i] = Math.max(ys[i], ys[i - 1] + sz[i - 1].h + gap);
        const overflow = ys[ys.length - 1] + sz[col.length - 1].h - (height - m.bottom);
        if (overflow > 0) for (let i = 0; i < ys.length; i++) ys[i] -= overflow;
        for (let i = ys.length - 2; i >= 0; i--) ys[i] = Math.min(ys[i], ys[i + 1] - sz[i].h - gap);
        if (ys[0] < m.top) {
          // taller than the view (only with cards taller than COMPACT_H in a full column): from the top, no overlap
          ys[0] = m.top;
          for (let i = 1; i < ys.length; i++) ys[i] = Math.max(ys[i], ys[i - 1] + sz[i - 1].h + gap);
        }
        return ys;
      };
      // leaders run from the anchor to an elbow beside the column (labels' LabelLayer draws the same):
      // where two in a column cross (anchors at much the same height, one far from the column), swap
      // their cards and stack again, until none cross
      const elbowX = s < 0 ? e + LEADER_RUN : e - LEADER_RUN;
      let ys = stackYs();
      for (let pass = 0; pass < col.length * col.length; pass++) {
        let swapped = false;
        for (let i = 0; i + 1 < col.length; i++) {
          const a = col[i];
          const b = col[i + 1];
          if (a.id === CHIP || b.id === CHIP || across.has(a.id) || across.has(b.id)) continue;
          if (!segmentsCross([a.x, a.y], [elbowX, ys[i] + sz[i].h / 2], [b.x, b.y], [elbowX, ys[i + 1] + sz[i + 1].h / 2])) continue;
          [col[i], col[i + 1]] = [b, a];
          [sz[i], sz[i + 1]] = [sz[i + 1], sz[i]];
          const next = stackYs();
          // keep the swap only if it uncrosses this pair
          if (segmentsCross([b.x, b.y], [elbowX, next[i] + sz[i].h / 2], [a.x, a.y], [elbowX, next[i + 1] + sz[i + 1].h / 2])) {
            [col[i], col[i + 1]] = [a, b];
            [sz[i], sz[i + 1]] = [sz[i + 1], sz[i]];
            continue;
          }
          ys = next;
          swapped = true;
        }
        if (!swapped) break;
      }
      col.forEach((p, i) => {
        const x = s < 0 ? e - sz[i].w : e;
        if (p.id === CHIP) out.chips.push({ side: s, column: ci, x, y: ys[i], w: sz[i].w, h: sz[i].h, ids: collapsed.map((c) => c.id) });
        else out.placed.set(p.id, { x, y: ys[i], side: s, column: ci, compact, w: sz[i].w, h: sz[i].h });
      });
    });
  }
  return out;
}

/** `layoutLabels`' placed cards only (the solver as it was called before R2-C). */
export function solveLabels(items: LabelBox[], width: number, height: number, m: { top: number; bottom: number; left: number; right: number }, fixed?: Map<string, -1 | 1>): Map<string, SolvedLabel> {
  return layoutLabels(items, width, height, m, fixed).placed;
}

/**
 * A long move eases longer (the R1 gate saw a 690 px column crossing done in 120 ms, 100 px in its first frame):
 * SLOT_EASE_MS plus EASE_MS_PER_PX for each pixel of the move, at most EASE_MAX_MS. DEFAULT 120 ms + 0.25 ms/px,
 * capped at 400 ms (R2-C).
 */
export const EASE_MS_PER_PX = 0.25;
export const EASE_MAX_MS = 400;
export const easeMs = (distancePx: number): number => Math.min(EASE_MAX_MS, SLOT_EASE_MS + EASE_MS_PER_PX * Math.max(0, distancePx));

/**
 * Where a label whose anchor left the view goes (R2-C): a pin on the view's edge (inside `inset`), on the line from
 * the view's centre toward the anchor, pointing at it. `behind`: the anchor is behind the camera (its projection is
 * mirrored, so the direction is flipped). Returns the pin's point and its angle (radians, 0 = pointing right, y down).
 */
export function edgePin(x: number, y: number, width: number, height: number, inset: { top: number; bottom: number; left: number; right: number }, behind = false): { x: number; y: number; angle: number } {
  const cx = (inset.left + width - inset.right) / 2;
  const cy = (inset.top + height - inset.bottom) / 2;
  let dx = x - cx;
  let dy = y - cy;
  if (behind) {
    dx = -dx;
    dy = -dy;
  }
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) dy = 1;
  const hw = Math.max(1, (width - inset.left - inset.right) / 2);
  const hh = Math.max(1, (height - inset.top - inset.bottom) / 2);
  const k = Math.min(Math.abs(dx) > 1e-9 ? hw / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-9 ? hh / Math.abs(dy) : Infinity);
  return { x: cx + dx * k, y: cy + dy * k, angle: Math.atan2(dy, dx) };
}

interface Card {
  el: HTMLDivElement;
  path: SVGPathElement;
  dot: SVGCircleElement;
  /** The edge pin shown while the anchor is out of the view (R2-C), made on first use. */
  pin?: HTMLButtonElement;
  /** Last frame's target (solver) and drawn top-left corners; the column key. */
  tx: number;
  ty: number;
  x: number;
  y: number;
  col: string;
  /** A slot change in progress: the offset from the target when it began, when, and how long it eases. */
  ox: number;
  oy: number;
  t0: number;
  ms: number;
  behind: boolean;
  /** Drawn compact (one line) this frame; the full card's size, read while it is not compact. */
  compact: boolean;
  fullW: number;
  fullH: number;
  /** Collapsed into its column's "+N" chip this frame. */
  collapsed: boolean;
}

const LABEL_CSS = `
/* R1-C (walkthrough D5): the coloured end bar on the side the leader enters (a left column's inner edge is its
   right edge); a faded label behind the model's centre; the fade eases */
.cad-labels .cad-label { transition: opacity 120ms ease-out; }
.cad-labels .cad-leaders path, .cad-labels .cad-leaders circle { transition: opacity 120ms ease-out; }
.cad-labels .cad-label.side-l { border-left-width: 1px; border-left-color: var(--uhd-border); border-right-width: 3px; }
.cad-labels .cad-label.side-l.kind-module { border-right-color: var(--uhd-node-border-hover); }
.cad-labels .cad-label.side-l.kind-harness { border-right-color: var(--uhd-accent); }
.cad-labels .cad-label.side-l.kind-interface { border-right-color: var(--uhd-highlight); }
.cad-labels .cad-label.side-l.kind-finding { border-right-color: var(--uhd-drc-incompatible); }
.cad-labels .cad-label.side-l.tone-error { border-right-color: var(--uhd-drc-incompatible); }
.cad-labels .cad-label.side-l.tone-warning { border-right-color: var(--uhd-drc-partial); }
.cad-labels .behind { opacity: ${BEHIND_OPACITY}; }
/* R2-C: refdes and MPN labels (a board's parts: many, so quiet): the id in the label font, a muted bar */
.cad-labels .cad-label.kind-refdes, .cad-labels .cad-label.kind-mpn { border-left-color: var(--uhd-text-muted); }
.cad-labels .cad-label.side-l.kind-refdes, .cad-labels .cad-label.side-l.kind-mpn { border-left-color: var(--uhd-border); border-right-color: var(--uhd-text-muted); }
.cad-labels .cad-label.kind-mpn { border-left-style: double; }
.cad-labels .cad-label.side-l.kind-mpn { border-left-style: solid; border-right-style: double; }
.cad-labels .cad-label.kind-refdes .cad-label-title, .cad-labels .cad-label.kind-mpn .cad-label-title { font-family: var(--uhd-font-label, ui-monospace, monospace); letter-spacing: 0.04em; }
.cad-labels .cad-leaders path.kind-refdes, .cad-labels .cad-leaders path.kind-mpn { stroke: color-mix(in oklab, var(--uhd-text-muted) 80%, transparent); }
.cad-labels .cad-leaders circle.kind-refdes, .cad-labels .cad-leaders circle.kind-mpn, .cad-kind-dot.kind-refdes, .cad-kind-dot.kind-mpn { fill: var(--uhd-text-muted); background: var(--uhd-text-muted); }
/* R2-C (D5, crowded columns): a compact card is one line, title only, ${COMPACT_H} px tall, at most ${COMPACT_MAX_W} px wide */
.cad-labels .cad-label.compact { box-sizing: border-box; height: ${COMPACT_H}px; max-width: ${COMPACT_MAX_W}px; padding: 0 6px 0 7px; justify-content: center; border-radius: 4px; box-shadow: none; overflow: hidden; }
.cad-labels .cad-label.compact .cad-label-sub { display: none; }
.cad-labels .cad-label.compact .cad-label-title { font-size: 10.5px; line-height: 13px; overflow: hidden; text-overflow: ellipsis; }
/* the "+N" chip at a crowded column's end, and the list it opens on hover */
.cad-labels .cad-label-more { position: absolute; left: 0; top: 0; box-sizing: border-box; height: ${COMPACT_H}px; min-width: ${CHIP_W}px; padding: 0 6px; border-radius: 8px; border: 1px dashed var(--uhd-border-strong, var(--uhd-border)); background: color-mix(in oklab, var(--uhd-surface) 92%, transparent); color: var(--uhd-text); font: 600 10.5px/14px var(--uhd-font-label, ui-monospace, monospace); pointer-events: auto; cursor: default; will-change: transform; }
.cad-labels .cad-label-more:focus-visible { outline: 1.5px solid var(--uhd-focus-ring, var(--uhd-accent)); outline-offset: 1px; }
.cad-labels .cad-label-more-list { position: absolute; left: 0; top: 0; display: none; flex-direction: column; gap: 1px; max-height: 50vh; overflow: auto; padding: 4px; border-radius: 6px; border: 1px solid var(--uhd-border); background: var(--uhd-surface); box-shadow: var(--uhd-shadow-md); pointer-events: auto; z-index: 1; }
.cad-labels .cad-label-more-list.open { display: flex; }
.cad-labels .cad-label-more-list button { all: unset; cursor: pointer; padding: 1px 6px; border-radius: 4px; font: 10.5px/16px var(--uhd-font-label, ui-monospace, monospace); color: var(--uhd-text); white-space: nowrap; }
.cad-labels .cad-label-more-list button:hover, .cad-labels .cad-label-more-list button:focus-visible { background: var(--uhd-hover, rgba(127,127,127,.12)); }
/* R2-C: a label whose anchor left the view is a pin on the view's edge pointing at it */
.cad-labels .cad-label-edge { position: absolute; left: 0; top: 0; width: 16px; height: 16px; margin: -8px 0 0 -8px; padding: 0; border: 0; border-radius: 50%; background: color-mix(in oklab, var(--uhd-surface) 92%, transparent); box-shadow: 0 0 0 1px var(--uhd-border); pointer-events: auto; cursor: pointer; will-change: transform; }
.cad-labels .cad-label-edge::after { content: ""; position: absolute; left: 6px; top: 4px; border: 4px solid transparent; border-left: 5px solid var(--uhd-node-border-hover); border-right-width: 0; }
.cad-labels .cad-label-edge.kind-harness::after { border-left-color: var(--uhd-accent); }
.cad-labels .cad-label-edge.kind-interface::after { border-left-color: var(--uhd-highlight); }
.cad-labels .cad-label-edge.kind-refdes::after, .cad-labels .cad-label-edge.kind-mpn::after { border-left-color: var(--uhd-text-muted); }
.cad-labels .cad-label-edge.tone-error::after { border-left-color: var(--uhd-drc-incompatible); }
.cad-labels .cad-label-edge.tone-warning::after { border-left-color: var(--uhd-drc-partial); }
@media (prefers-reduced-motion: reduce) { .cad-labels .cad-label, .cad-labels .cad-leaders path, .cad-labels .cad-leaders circle { transition: none; } }
`;

function ensureLabelStyles(doc: Document) {
  const had = doc.getElementById("uhd-labels-css");
  if (had) {
    // a hot reload with new rules (dev): replace them
    if (had.textContent !== LABEL_CSS) had.textContent = LABEL_CSS;
    return;
  }
  const el = doc.createElement("style");
  el.id = "uhd-labels-css";
  el.textContent = LABEL_CSS;
  doc.head.appendChild(el);
}

/** A label's importance for the crowded-column collapse (R2-C): its own, else its severity tone. */
const importanceOf = (item: LabelItem) => item.importance ?? (item.tone === "error" ? 2 : item.tone === "warning" ? 1 : 0);

/** DEFAULT (R2-C): the edge pins sit this far inside the view's margins. */
const EDGE_INSET = 14;
/** DEFAULT (R2-C): the chip's list stays open this long after the pointer leaves it. */
const MORE_CLOSE_MS = 220;

export class LabelLayer {
  readonly root: HTMLDivElement;
  private svg: SVGSVGElement;
  private cards = new Map<string, Card>();
  /** Each label's column side, kept with hysteresis (holdSides). */
  private sides = new Map<string, { side: -1 | 1; since?: number }>();
  /** Which sides were compact last frame (the crowded-column hysteresis, R2-C). */
  private compactSides: { left: boolean; right: boolean } = { left: false, right: false };
  /** The "+N" chips by side, and the list one opens. */
  private chips = new Map<string, { el: HTMLButtonElement; ids: string[]; x: number; y: number }>();
  private moreList: HTMLDivElement | undefined;
  private moreFor: string | undefined;
  private moreTimer: ReturnType<typeof setTimeout> | undefined;
  /** Place the next frame's cards at their solved positions without easing (stills). */
  snap = false;
  private items: LabelItem[] = [];
  opacity = 0;
  target = 0;
  /** Screen margins kept clear (floating chrome). */
  margins = { top: 60, bottom: 64, left: 56, right: 16 };
  /** The model's centre for the behind-the-model fade (DEFAULT: the anchors' centroid when unset). */
  centre: (() => THREE.Vector3 | null) | undefined;
  /** Where wheel events over labels go (the renderer's canvas; found in the host when unset). */
  wheelTarget: EventTarget | undefined;
  private wheelOff: () => void;

  constructor(host: HTMLElement) {
    ensureLabelStyles(host.ownerDocument ?? document);
    this.root = document.createElement("div");
    this.root.className = "cad-labels";
    this.svg = document.createElementNS(SVGNS, "svg");
    this.svg.classList.add("cad-leaders");
    this.root.appendChild(this.svg);
    host.appendChild(this.root);
    // a wheel over a label zooms the view (walkthrough D2): the labels take clicks, so the wheel is forwarded
    this.wheelOff = attachWheelForward(this.root, () => this.wheelTarget ?? canvasIn(host));
    // measuring scripts (`cadDebug=1`) read the layout, chips and pins of the live layers
    if (cadDebugEnabled()) {
      const g = globalThis as { __cadLabels?: Set<LabelLayer> };
      (g.__cadLabels ??= new Set()).add(this);
    }
  }

  setItems(items: LabelItem[]) {
    this.items = items;
    const keep = new Set(items.map((i) => i.id));
    for (const [id, c] of this.cards) {
      if (!keep.has(id)) {
        c.el.remove();
        c.path.remove();
        c.dot.remove();
        c.pin?.remove();
        this.cards.delete(id);
        this.sides.delete(id);
      }
    }
    for (const item of items) {
      let c = this.cards.get(item.id);
      if (!c) {
        const el = document.createElement("div");
        const path = document.createElementNS(SVGNS, "path");
        const dot = document.createElementNS(SVGNS, "circle");
        dot.setAttribute("r", "3");
        this.svg.append(path, dot);
        this.root.appendChild(el);
        c = { el, path, dot, tx: NaN, ty: NaN, x: NaN, y: NaN, col: "", ox: 0, oy: 0, t0: -Infinity, ms: SLOT_EASE_MS, behind: false, compact: false, fullW: NaN, fullH: NaN, collapsed: false };
        this.cards.set(item.id, c);
      }
      const tone = item.tone ? ` tone-${item.tone}` : "";
      const side = c.col.startsWith("-1") ? " side-l" : c.col ? " side-r" : "";
      const sub = labelSubtitle(item.sub);
      c.el.className = `cad-label kind-${item.kind}${tone}${side}${c.behind ? " behind" : ""}`;
      c.el.innerHTML = `<span class="cad-label-title"></span>${sub ? '<span class="cad-label-sub"></span>' : ""}`;
      (c.el.querySelector(".cad-label-title") as HTMLElement).textContent = item.title;
      if (sub) (c.el.querySelector(".cad-label-sub") as HTMLElement).textContent = sub;
      c.el.title = item.title + (sub ? ` · ${sub}` : "");
      c.el.onclick = item.onClick ?? null;
      c.path.setAttribute("class", `kind-${item.kind}${tone}${c.behind ? " behind" : ""}`);
      c.dot.setAttribute("class", `kind-${item.kind}${tone}${c.behind ? " behind" : ""}`);
      if (c.pin) c.pin.className = `cad-label-edge kind-${item.kind}${tone}`;
      // new content: its full size is read again (compact cards are measured without the class)
      c.compact = false;
      c.fullW = c.fullH = NaN;
    }
  }

  /** The full card's size (not compact): read while it is drawn full, else kept from when it was. */
  private fullSize(c: Card): { w: number; h: number } {
    if (!c.compact || Number.isNaN(c.fullW)) {
      if (c.compact) c.el.classList.remove("compact");
      c.fullW = c.el.offsetWidth;
      c.fullH = c.el.offsetHeight;
      if (c.compact) c.el.classList.add("compact");
    }
    return { w: c.fullW, h: c.fullH };
  }

  private hideCard(c: Card) {
    c.el.style.display = "none";
    c.path.style.display = c.dot.style.display = "none";
  }

  private edgePinFor(item: LabelItem, c: Card, x: number, y: number, width: number, height: number, behind: boolean) {
    if (!c.pin) {
      const b = document.createElement("button") as HTMLButtonElement;
      b.type = "button";
      b.className = `cad-label-edge kind-${item.kind}${item.tone ? ` tone-${item.tone}` : ""}`;
      this.root.appendChild(b);
      c.pin = b;
    }
    const m = this.margins;
    const at = edgePin(x, y, width, height, { top: m.top + EDGE_INSET, bottom: m.bottom + EDGE_INSET, left: m.left + EDGE_INSET, right: m.right + EDGE_INSET }, behind);
    c.pin.title = `${item.title} (outside the view)`;
    c.pin.setAttribute("aria-label", `${item.title}, outside the view`);
    c.pin.onclick = item.onClick ?? null;
    c.pin.style.display = "";
    c.pin.style.transform = `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px) rotate(${((at.angle * 180) / Math.PI).toFixed(1)}deg)`;
  }

  /**
   * Lay out and draw; call every frame that is drawn. Returns true while the
   * cards are still fading or easing towards their places (the view keeps
   * drawing frames until they settle, then goes idle: PB-1175).
   */
  update(camera: THREE.Camera, width: number, height: number, dt = 1 / 60, now = performance.now()): boolean {
    const k = 1 - Math.exp(-dt * 8);
    this.opacity += (this.target - this.opacity) * k;
    if (Math.abs(this.target - this.opacity) < 0.002) this.opacity = this.target;
    this.root.style.opacity = String(this.opacity);
    this.root.style.display = this.opacity < 0.01 ? "none" : "block";
    const fading = this.opacity !== this.target;
    if (this.opacity < 0.01) return fading;
    this.svg.setAttribute("width", String(width));
    this.svg.setAttribute("height", String(height));
    // the controls moved the camera this frame, before the scene's matrices are brought up to date: project with
    // this frame's camera, so the leader's base sits on its part now, not where it was a frame ago (walkthrough D5c)
    camera.updateMatrixWorld();
    const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    const depth = (w: THREE.Vector3) => w.clone().sub(camPos).dot(fwd);
    const near = (camera as THREE.PerspectiveCamera).near ?? 0;

    const placed: (LabelBox & { item: LabelItem; world: THREE.Vector3 })[] = [];
    for (const item of this.items) {
      const c = this.cards.get(item.id)!;
      const a = item.anchor();
      const v = a?.clone().project(camera);
      if (!a || !v || ![v.x, v.y].every(Number.isFinite)) {
        this.hideCard(c);
        if (c.pin) c.pin.style.display = "none";
        continue;
      }
      const x = ((v.x + 1) / 2) * width;
      const y = ((1 - v.y) / 2) * height;
      // R2-C: an anchor out of the view (off its edges, or behind the camera) retracts its label to an edge pin
      const behindCam = depth(a) <= near;
      if (behindCam || x < 0 || x > width || y < 0 || y > height) {
        this.hideCard(c);
        this.edgePinFor(item, c, x, y, width, height, behindCam);
        c.x = c.tx = NaN;
        continue;
      }
      if (c.pin) c.pin.style.display = "none";
      c.el.style.display = "";
      c.path.style.display = c.dot.style.display = "";
      const full = this.fullSize(c);
      placed.push({ item, world: a, id: item.id, x, y, w: full.w, h: full.h, importance: importanceOf(item), depth: depth(a) });
    }
    if (!placed.length) {
      this.layoutChips([]);
      return fading;
    }

    // sides with hysteresis (a still re-solves from scratch), then the solver
    const snap = this.snap;
    this.snap = false;
    const held = snap ? new Map<string, { side: -1 | 1; since?: number }>() : holdSides(placed, this.sides, width, now);
    const fixed = new Map<string, -1 | 1>([...held].map(([id, h]) => [id, h.side]));
    const solved = layoutLabels(placed, width, height, this.margins, fixed, snap ? undefined : this.compactSides);
    this.compactSides = solved.compact;
    let easing = false;
    for (const p of held.values()) if (p.since !== undefined) easing = true;

    // behind the model's centre: depth along the camera's view direction (walkthrough D5 z-order)
    const centre = this.centre?.() ?? placed.reduce((t, p) => t.add(p.world), new THREE.Vector3()).divideScalar(placed.length);
    const dc = depth(centre);
    const ds = placed.map((p) => p.depth ?? depth(p.world));
    // DEFAULT 4 % of the anchors' depth range: the band around the centre where a label keeps its faded state
    const band = Math.max(1e-6, (Math.max(...ds) - Math.min(...ds)) * 0.04);

    const nextSides = new Map<string, { side: -1 | 1; since?: number }>();
    placed.forEach((p, i) => {
      const c = this.cards.get(p.id)!;
      const sv = solved.placed.get(p.id);
      if (!sv) {
        // collapsed into its column's "+N" chip (R2-C): no card, no leader; it comes back eased from the chip
        c.collapsed = true;
        this.hideCard(c);
        const h = held.get(p.id);
        if (h) nextSides.set(p.id, { side: h.side });
        return;
      }
      if (c.collapsed) {
        c.collapsed = false;
        c.el.style.display = "";
        c.path.style.display = c.dot.style.display = "";
      }
      const h = held.get(p.id);
      nextSides.set(p.id, h && h.side === sv.side ? h : { side: sv.side });
      if (sv.compact !== c.compact) {
        c.compact = sv.compact;
        c.el.classList.toggle("compact", sv.compact);
      }
      const col = `${sv.side}:${sv.column}`;
      // a slot change (another column, or the target jumping): ease from where the card is drawn now, ease-out, for
      // longer the farther it goes (R2-C); ordinary motion moves the target a little each frame and the card follows
      // it in the same frame
      if (Number.isNaN(c.x) || snap) {
        c.ox = c.oy = 0;
        c.t0 = -Infinity;
      } else if (col !== c.col || Math.abs(sv.x - c.tx) > JUMP_PX || Math.abs(sv.y - c.ty) > JUMP_PX) {
        c.ox = c.x - sv.x;
        c.oy = c.y - sv.y;
        c.t0 = now;
        c.ms = easeMs(Math.hypot(c.ox, c.oy));
      }
      const left = easeLeft(now - c.t0, c.ms);
      if (left > 0.002) easing = true;
      // clamp to the view, never pushing a neighbour (walkthrough D5: neighbours were pushed off screen)
      const x = Math.min(width - this.margins.right - sv.w, Math.max(this.margins.left, sv.x + c.ox * left));
      const y = Math.min(height - this.margins.bottom - sv.h, Math.max(this.margins.top, sv.y + c.oy * left));
      c.tx = sv.x;
      c.ty = sv.y;
      c.x = x;
      c.y = y;
      if (c.col !== col) {
        c.col = col;
        c.el.classList.toggle("side-l", sv.side < 0);
        c.el.classList.toggle("side-r", sv.side > 0);
      }
      // behind the centre, with a small band so a label on the line does not flicker
      const behind = c.behind ? ds[i] > dc - band : ds[i] > dc + band;
      if (behind !== c.behind) {
        c.behind = behind;
        for (const e of [c.el, c.path, c.dot]) e.classList.toggle("behind", behind);
      }
      const ly = y + sv.h / 2;
      // the leader meets the card's inner edge (where its coloured bar is): a short level run, then straight to the
      // anchor, whose dot is the anchor's position this frame
      const lx = sv.side < 0 ? x + sv.w : x;
      const ex = sv.side < 0 ? lx + LEADER_RUN : lx - LEADER_RUN;
      c.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      c.path.setAttribute("d", `M${p.x.toFixed(1)},${p.y.toFixed(1)} L${ex.toFixed(1)},${ly.toFixed(1)} L${lx.toFixed(1)},${ly.toFixed(1)}`);
      c.dot.setAttribute("cx", p.x.toFixed(1));
      c.dot.setAttribute("cy", p.y.toFixed(1));
    });
    this.sides = nextSides;
    this.layoutChips(solved.chips);
    return fading || easing;
  }

  /** The "+N" chips at crowded columns' ends (R2-C): made, moved, removed; hovering one lists its labels. */
  private layoutChips(chips: LabelChip[]) {
    const keep = new Set<string>();
    for (const ch of chips) {
      const key = `${ch.side}:${ch.column}`;
      keep.add(key);
      let c = this.chips.get(key);
      if (!c) {
        const el = document.createElement("button") as HTMLButtonElement;
        el.type = "button";
        el.className = "cad-label-more";
        el.addEventListener("pointerenter", () => this.openMore(key));
        el.addEventListener("focus", () => this.openMore(key));
        el.addEventListener("pointerleave", () => this.closeMoreSoon());
        el.addEventListener("blur", () => this.closeMoreSoon());
        this.root.appendChild(el);
        c = { el, ids: [], x: 0, y: 0 };
        this.chips.set(key, c);
      }
      c.ids = ch.ids;
      c.x = ch.x;
      c.y = ch.y;
      c.el.textContent = `+${ch.ids.length}`;
      const titles = ch.ids.map((id) => this.items.find((i) => i.id === id)?.title ?? id);
      c.el.setAttribute("aria-label", `${ch.ids.length} more labels: ${titles.join(", ")}`);
      c.el.style.transform = `translate(${ch.x.toFixed(1)}px, ${ch.y.toFixed(1)}px)`;
      if (this.moreFor === key) this.fillMore(key);
    }
    for (const [key, c] of this.chips)
      if (!keep.has(key)) {
        c.el.remove();
        this.chips.delete(key);
        if (this.moreFor === key) this.closeMore();
      }
  }

  private openMore(key: string) {
    if (this.moreTimer) clearTimeout(this.moreTimer);
    this.moreTimer = undefined;
    if (!this.moreList) {
      const l = document.createElement("div");
      l.className = "cad-label-more-list";
      l.setAttribute("role", "list");
      l.addEventListener("pointerenter", () => {
        if (this.moreTimer) clearTimeout(this.moreTimer);
        this.moreTimer = undefined;
      });
      l.addEventListener("pointerleave", () => this.closeMoreSoon());
      this.root.appendChild(l);
      this.moreList = l;
    }
    this.moreFor = key;
    this.fillMore(key);
    this.moreList.classList.add("open");
  }

  private fillMore(key: string) {
    const c = this.chips.get(key);
    const l = this.moreList;
    if (!c || !l) return;
    l.replaceChildren();
    for (const id of c.ids) {
      const item = this.items.find((i) => i.id === id);
      if (!item) continue;
      const b = document.createElement("button") as HTMLButtonElement;
      b.type = "button";
      b.setAttribute("role", "listitem");
      b.textContent = item.title;
      b.onclick = item.onClick ?? null;
      l.appendChild(b);
    }
    // beside the chip, on the inner side of a left column (it opens toward the model), above its end
    const side = key.startsWith("-1") ? -1 : 1;
    const w = l.offsetWidth || 160;
    const h = l.offsetHeight || 18 * c.ids.length;
    const x = side < 0 ? c.x : c.x + (c.el.offsetWidth || CHIP_W) - w;
    const y = Math.max(this.margins.top, c.y - h - 4);
    l.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  }

  private closeMoreSoon() {
    if (this.moreTimer) clearTimeout(this.moreTimer);
    this.moreTimer = setTimeout(() => this.closeMore(), MORE_CLOSE_MS);
  }

  private closeMore() {
    if (this.moreTimer) clearTimeout(this.moreTimer);
    this.moreTimer = undefined;
    this.moreFor = undefined;
    this.moreList?.classList.remove("open");
  }

  /** Each drawn label's side, column, target and drawn corner (tests, the critic, `__cad.labels()`). */
  layout(): { id: string; side: -1 | 1; column: number; target: [number, number]; at: [number, number]; behind: boolean; compact: boolean }[] {
    return [...this.cards]
      .filter(([, c]) => c.el.style.display !== "none" && c.col)
      .map(([id, c]) => {
        const [sd, col] = c.col.split(":").map(Number);
        return { id, side: (sd < 0 ? -1 : 1) as -1 | 1, column: col, target: [c.tx, c.ty] as [number, number], at: [c.x, c.y] as [number, number], behind: c.behind, compact: c.compact };
      });
  }

  /** The "+N" chips drawn now: where, and which labels each holds (tests, `__cad.labels()`). */
  chipsDrawn(): { side: -1 | 1; column: number; at: [number, number]; ids: string[] }[] {
    return [...this.chips].map(([key, c]) => {
      const [sd, col] = key.split(":").map(Number);
      return { side: (sd < 0 ? -1 : 1) as -1 | 1, column: col, at: [c.x, c.y] as [number, number], ids: [...c.ids] };
    });
  }

  /** Labels drawn as edge pins now (their anchor is out of the view). */
  edgePins(): string[] {
    return [...this.cards].filter(([, c]) => c.pin && c.pin.style.display !== "none").map(([id]) => id);
  }

  /** The cards drawn now, with their page rectangles (W3-D's critic reads them through `__cad.labels()`). */
  boxes(): { id: string; rect: DOMRect }[] {
    if (this.opacity < 0.01) return [];
    return [...this.cards].filter(([, c]) => c.el.style.display !== "none").map(([id, c]) => ({ id, rect: c.el.getBoundingClientRect() }));
  }

  dispose() {
    (globalThis as { __cadLabels?: Set<LabelLayer> }).__cadLabels?.delete(this);
    if (this.moreTimer) clearTimeout(this.moreTimer);
    this.wheelOff();
    this.root.remove();
  }
}
