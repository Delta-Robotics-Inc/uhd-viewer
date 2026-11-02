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
 */
import * as THREE from "three";
import { attachWheelForward, canvasIn } from "./annot/wheel";

export type LabelKind = "module" | "harness" | "interface" | "finding";

export interface LabelItem {
  id: string;
  kind: LabelKind;
  title: string;
  sub?: string;
  /** A second class for the card, leader and dot (a finding's severity: "error", "warning"). */
  tone?: string;
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
}

/** Where a card goes: its top-left corner, the side of the model, and which column on that side (0 nearest). */
export interface SolvedLabel {
  x: number;
  y: number;
  side: -1 | 1;
  column: number;
}

/**
 * Callout placement (PB-873): cards in columns either side of the model,
 * each column ordered by its anchors' screen y (then untangled, where two
 * anchors at much the same height would still cross) so leader lines do not
 * cross, and stacked so no two cards overlap. Sides are chosen by anchor x and then
 * balanced by height; a side taller than the view spills into a second,
 * outer column. Pure: re-solved every frame as the camera moves.
 */
export function solveLabels(items: LabelBox[], width: number, height: number, m: { top: number; bottom: number; left: number; right: number }, fixed?: Map<string, -1 | 1>): Map<string, SolvedLabel> {
  const out = new Map<string, SolvedLabel>();
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
  for (const s of [-1, 1] as const) {
    const all = items.filter((p) => side.get(p.id) === s).sort((a, b) => a.y - b.y || a.id.localeCompare(b.id));
    if (!all.length) continue;
    // as many columns as the height needs; cards dealt in y order so each column stays ordered
    const total = all.reduce((t, p) => t + p.h + LABEL_GAP, 0);
    const n = Math.max(1, Math.ceil(total / avail));
    const cols: LabelBox[][] = Array.from({ length: n }, () => []);
    all.forEach((p, i) => cols[n === 1 ? 0 : i % n].push(p));
    let edge = s < 0 ? minX - COLUMN_OFFSET : maxX + COLUMN_OFFSET;
    cols.forEach((col, ci) => {
      const wMax = Math.max(...col.map((p) => p.w));
      // keep the column on screen: a left column's right edge, a right column's left edge
      const e = s < 0 ? Math.max(m.left + wMax, Math.min(edge, width - m.right)) : Math.min(width - m.right - wMax, Math.max(edge, m.left));
      const stackYs = () => {
        const ys = col.map((p) => p.y - p.h / 2);
        for (let i = 1; i < ys.length; i++) ys[i] = Math.max(ys[i], ys[i - 1] + col[i - 1].h + LABEL_GAP);
        const overflow = ys[ys.length - 1] + col[col.length - 1].h - (height - m.bottom);
        if (overflow > 0) for (let i = 0; i < ys.length; i++) ys[i] -= overflow;
        for (let i = ys.length - 2; i >= 0; i--) ys[i] = Math.min(ys[i], ys[i + 1] - col[i].h - LABEL_GAP);
        if (ys[0] < m.top) {
          // taller than the view (a single column that cannot spill): stack from the top, never overlapping
          ys[0] = m.top;
          for (let i = 1; i < ys.length; i++) ys[i] = Math.max(ys[i], ys[i - 1] + col[i - 1].h + LABEL_GAP);
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
          if (across.has(a.id) || across.has(b.id)) continue;
          if (!segmentsCross([a.x, a.y], [elbowX, ys[i] + a.h / 2], [b.x, b.y], [elbowX, ys[i + 1] + b.h / 2])) continue;
          [col[i], col[i + 1]] = [b, a];
          const next = stackYs();
          // keep the swap only if it uncrosses this pair
          if (segmentsCross([b.x, b.y], [elbowX, next[i] + b.h / 2], [a.x, a.y], [elbowX, next[i + 1] + a.h / 2])) {
            [col[i], col[i + 1]] = [a, b];
            continue;
          }
          ys = next;
          swapped = true;
        }
        if (!swapped) break;
      }
      col.forEach((p, i) => out.set(p.id, { x: s < 0 ? e - p.w : e, y: ys[i], side: s, column: ci }));
      edge = s < 0 ? e - wMax - COLUMN_GAP : e + wMax + COLUMN_GAP;
    });
  }
  return out;
}

interface Card {
  el: HTMLDivElement;
  path: SVGPathElement;
  dot: SVGCircleElement;
  /** Last frame's target (solver) and drawn top-left corners; the column key. */
  tx: number;
  ty: number;
  x: number;
  y: number;
  col: string;
  /** A slot change in progress: the offset from the target when it began, and when. */
  ox: number;
  oy: number;
  t0: number;
  behind: boolean;
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
@media (prefers-reduced-motion: reduce) { .cad-labels .cad-label, .cad-labels .cad-leaders path, .cad-labels .cad-leaders circle { transition: none; } }
`;

function ensureLabelStyles(doc: Document) {
  if (doc.getElementById("uhd-labels-css")) return;
  const el = doc.createElement("style");
  el.id = "uhd-labels-css";
  el.textContent = LABEL_CSS;
  doc.head.appendChild(el);
}

export class LabelLayer {
  readonly root: HTMLDivElement;
  private svg: SVGSVGElement;
  private cards = new Map<string, Card>();
  /** Each label's column side, kept with hysteresis (holdSides). */
  private sides = new Map<string, { side: -1 | 1; since?: number }>();
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
  }

  setItems(items: LabelItem[]) {
    this.items = items;
    const keep = new Set(items.map((i) => i.id));
    for (const [id, c] of this.cards) {
      if (!keep.has(id)) {
        c.el.remove();
        c.path.remove();
        c.dot.remove();
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
        c = { el, path, dot, tx: NaN, ty: NaN, x: NaN, y: NaN, col: "", ox: 0, oy: 0, t0: -Infinity, behind: false };
        this.cards.set(item.id, c);
      }
      const tone = item.tone ? ` tone-${item.tone}` : "";
      const side = c.col.startsWith("-1") ? " side-l" : c.col ? " side-r" : "";
      const sub = labelSubtitle(item.sub);
      c.el.className = `cad-label kind-${item.kind}${tone}${side}${c.behind ? " behind" : ""}`;
      c.el.innerHTML = `<span class="cad-label-title"></span>${sub ? '<span class="cad-label-sub"></span>' : ""}`;
      (c.el.querySelector(".cad-label-title") as HTMLElement).textContent = item.title;
      if (sub) (c.el.querySelector(".cad-label-sub") as HTMLElement).textContent = sub;
      c.el.onclick = item.onClick ?? null;
      c.path.setAttribute("class", `kind-${item.kind}${tone}${c.behind ? " behind" : ""}`);
      c.dot.setAttribute("class", `kind-${item.kind}${tone}${c.behind ? " behind" : ""}`);
    }
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

    const placed: (LabelBox & { item: LabelItem; world: THREE.Vector3 })[] = [];
    for (const item of this.items) {
      const c = this.cards.get(item.id)!;
      const a = item.anchor();
      const v = a?.clone().project(camera);
      if (!a || !v || v.z > 1 || v.z < -1) {
        c.el.style.display = "none";
        c.path.style.display = c.dot.style.display = "none";
        continue;
      }
      c.el.style.display = "";
      c.path.style.display = c.dot.style.display = "";
      placed.push({ item, world: a, id: item.id, x: ((v.x + 1) / 2) * width, y: ((1 - v.y) / 2) * height, w: c.el.offsetWidth, h: c.el.offsetHeight });
    }
    if (!placed.length) return fading;

    // sides with hysteresis (a still re-solves from scratch), then the solver
    const snap = this.snap;
    this.snap = false;
    const held = snap ? new Map<string, { side: -1 | 1; since?: number }>() : holdSides(placed, this.sides, width, now);
    const fixed = new Map<string, -1 | 1>([...held].map(([id, h]) => [id, h.side]));
    const solved = solveLabels(placed, width, height, this.margins, fixed);
    let easing = false;
    for (const p of held.values()) if (p.since !== undefined) easing = true;

    // behind the model's centre: depth along the camera's view direction (walkthrough D5 z-order)
    const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    const depth = (w: THREE.Vector3) => w.clone().sub(camPos).dot(fwd);
    const centre = this.centre?.() ?? placed.reduce((t, p) => t.add(p.world), new THREE.Vector3()).divideScalar(placed.length);
    const dc = depth(centre);
    const ds = placed.map((p) => depth(p.world));
    const band = Math.max(1e-6, (Math.max(...ds) - Math.min(...ds)) * 0.04);

    const nextSides = new Map<string, { side: -1 | 1; since?: number }>();
    placed.forEach((p, i) => {
      const sv = solved.get(p.id)!;
      const c = this.cards.get(p.id)!;
      const h = held.get(p.id);
      nextSides.set(p.id, h && h.side === sv.side ? h : { side: sv.side });
      const col = `${sv.side}:${sv.column}`;
      // a slot change (another column, or the target jumping): ease from where the card is drawn now, ease-out;
      // ordinary motion moves the target a little each frame and the card follows it in the same frame
      if (Number.isNaN(c.x) || snap) {
        c.ox = c.oy = 0;
        c.t0 = -Infinity;
      } else if (col !== c.col || Math.abs(sv.x - c.tx) > JUMP_PX || Math.abs(sv.y - c.ty) > JUMP_PX) {
        c.ox = c.x - sv.x;
        c.oy = c.y - sv.y;
        c.t0 = now;
      }
      const left = easeLeft(now - c.t0);
      if (left > 0.002) easing = true;
      // clamp to the view, never pushing a neighbour (walkthrough D5: neighbours were pushed off screen)
      const x = Math.min(width - this.margins.right - p.w, Math.max(this.margins.left, sv.x + c.ox * left));
      const y = Math.min(height - this.margins.bottom - p.h, Math.max(this.margins.top, sv.y + c.oy * left));
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
      const ly = y + p.h / 2;
      // the leader meets the card's inner edge (where its coloured bar is): a short level run, then straight to the
      // anchor, whose dot is the anchor's position this frame
      const lx = sv.side < 0 ? x + p.w : x;
      const ex = sv.side < 0 ? lx + LEADER_RUN : lx - LEADER_RUN;
      c.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      c.path.setAttribute("d", `M${p.x.toFixed(1)},${p.y.toFixed(1)} L${ex.toFixed(1)},${ly.toFixed(1)} L${lx.toFixed(1)},${ly.toFixed(1)}`);
      c.dot.setAttribute("cx", p.x.toFixed(1));
      c.dot.setAttribute("cy", p.y.toFixed(1));
    });
    this.sides = nextSides;
    return fading || easing;
  }

  /** Each drawn label's side, column, target and drawn corner (tests, the critic, `__cad.labels()`). */
  layout(): { id: string; side: -1 | 1; column: number; target: [number, number]; at: [number, number]; behind: boolean }[] {
    return [...this.cards]
      .filter(([, c]) => c.el.style.display !== "none" && c.col)
      .map(([id, c]) => {
        const [sd, col] = c.col.split(":").map(Number);
        return { id, side: (sd < 0 ? -1 : 1) as -1 | 1, column: col, target: [c.tx, c.ty] as [number, number], at: [c.x, c.y] as [number, number], behind: c.behind };
      });
  }

  /** The cards drawn now, with their page rectangles (W3-D's critic reads them through `__cad.labels()`). */
  boxes(): { id: string; rect: DOMRect }[] {
    if (this.opacity < 0.01) return [];
    return [...this.cards].filter(([, c]) => c.el.style.display !== "none").map(([id, c]) => ({ id, rect: c.el.getBoundingClientRect() }));
  }

  dispose() {
    this.wheelOff();
    this.root.remove();
  }
}
