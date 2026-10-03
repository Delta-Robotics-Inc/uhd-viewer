/**
 * Callout labels for the 3D view (PB-775): screen-space cards with leader
 * lines to 3D anchors, laid out in two columns like a product manual's
 * exploded-view callouts. HTML stays upright and camera-facing by
 * construction; positions are recomputed every frame.
 */
import * as THREE from "three";

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
 * each column ordered by its anchors' screen y so leader lines do not cross,
 * and stacked so no two cards overlap. Sides are chosen by anchor x and then
 * balanced by height; a side taller than the view spills into a second,
 * outer column. Pure: re-solved every frame as the camera moves.
 */
export function solveLabels(items: LabelBox[], width: number, height: number, m: { top: number; bottom: number; left: number; right: number }): Map<string, SolvedLabel> {
  const out = new Map<string, SolvedLabel>();
  if (!items.length) return out;
  const minX = Math.min(...items.map((p) => p.x));
  const maxX = Math.max(...items.map((p) => p.x));
  const mid = (minX + maxX) / 2;
  const avail = Math.max(1, height - m.top - m.bottom);
  const side = new Map<string, -1 | 1>(items.map((p) => [p.id, p.x < mid || (p.x === mid && p.y < 0) ? -1 : 1]));
  const stack = (s: -1 | 1) => items.filter((p) => side.get(p.id) === s).reduce((t, p) => t + p.h + LABEL_GAP, 0);
  // balance by height: move the most central anchors across while that evens the columns
  for (let guard = 0; guard < items.length; guard++) {
    const from: -1 | 1 = stack(-1) > stack(1) ? -1 : 1;
    const cand = items.filter((p) => side.get(p.id) === from).sort((a, b) => Math.abs(a.x - mid) - Math.abs(b.x - mid) || a.id.localeCompare(b.id))[0];
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
      col.forEach((p, i) => out.set(p.id, { x: s < 0 ? e - p.w : e, y: ys[i], side: s, column: ci }));
      edge = s < 0 ? e - wMax - COLUMN_GAP : e + wMax + COLUMN_GAP;
    });
  }
  return out;
}

export class LabelLayer {
  readonly root: HTMLDivElement;
  private svg: SVGSVGElement;
  private cards = new Map<string, { el: HTMLDivElement; path: SVGPathElement; dot: SVGCircleElement; y: number; side: string }>();
  /** Place the next frame's cards at their solved positions without easing (stills). */
  snap = false;
  private items: LabelItem[] = [];
  opacity = 0;
  target = 0;
  /** Screen margins kept clear (floating chrome). */
  margins = { top: 60, bottom: 64, left: 56, right: 16 };

  constructor(host: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "cad-labels";
    this.svg = document.createElementNS(SVGNS, "svg");
    this.svg.classList.add("cad-leaders");
    this.root.appendChild(this.svg);
    host.appendChild(this.root);
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
        c = { el, path, dot, y: NaN, side: "" };
        this.cards.set(item.id, c);
      }
      const tone = item.tone ? ` tone-${item.tone}` : "";
      c.el.className = `cad-label kind-${item.kind}${tone}`;
      c.el.innerHTML = `<span class="cad-label-title"></span>${item.sub ? '<span class="cad-label-sub"></span>' : ""}`;
      (c.el.querySelector(".cad-label-title") as HTMLElement).textContent = item.title;
      if (item.sub) (c.el.querySelector(".cad-label-sub") as HTMLElement).textContent = item.sub;
      c.el.onclick = item.onClick ?? null;
      c.path.setAttribute("class", `kind-${item.kind}${tone}`);
      c.dot.setAttribute("class", `kind-${item.kind}${tone}`);
    }
  }

  /** Lay out and draw; call every frame. */
  update(camera: THREE.Camera, width: number, height: number, dt = 1 / 60) {
    const k = 1 - Math.exp(-dt * 8);
    this.opacity += (this.target - this.opacity) * k;
    if (Math.abs(this.target - this.opacity) < 0.002) this.opacity = this.target;
    this.root.style.opacity = String(this.opacity);
    this.root.style.display = this.opacity < 0.01 ? "none" : "block";
    if (this.opacity < 0.01) return;
    this.svg.setAttribute("width", String(width));
    this.svg.setAttribute("height", String(height));

    const placed: (LabelBox & { item: LabelItem })[] = [];
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
      placed.push({ item, id: item.id, x: ((v.x + 1) / 2) * width, y: ((1 - v.y) / 2) * height, w: c.el.offsetWidth, h: c.el.offsetHeight });
    }
    if (!placed.length) return;

    const solved = solveLabels(placed, width, height, this.margins);
    // ease towards the solution, then keep each column's order and gaps so cards never overlap while moving
    const ease = this.snap ? 1 : Math.min(1, k * 2.5);
    this.snap = false;
    const columns = new Map<string, { p: LabelBox & { item: LabelItem }; s: SolvedLabel }[]>();
    for (const p of placed) {
      const sv = solved.get(p.id)!;
      const key = `${sv.side}:${sv.column}`;
      columns.set(key, [...(columns.get(key) ?? []), { p, s: sv }]);
    }
    for (const col of columns.values()) {
      col.sort((a, b) => a.s.y - b.s.y);
      let floor = -Infinity;
      for (const { p, s: sv } of col) {
        const c = this.cards.get(p.id)!;
        let y = Number.isNaN(c.y) || c.side !== `${sv.side}:${sv.column}` ? sv.y : c.y + (sv.y - c.y) * ease;
        y = Math.max(y, floor);
        c.y = y;
        c.side = `${sv.side}:${sv.column}`;
        floor = y + p.h + LABEL_GAP;
        const ly = y + p.h / 2;
        // the leader meets the card's inner edge: a short horizontal run, then straight to the anchor
        const lx = sv.side < 0 ? sv.x + p.w : sv.x;
        const ex = sv.side < 0 ? lx + 16 : lx - 16;
        c.el.style.transform = `translate(${sv.x.toFixed(1)}px, ${y.toFixed(1)}px)`;
        c.path.setAttribute("d", `M${p.x.toFixed(1)},${p.y.toFixed(1)} L${ex.toFixed(1)},${ly.toFixed(1)} L${lx.toFixed(1)},${ly.toFixed(1)}`);
        c.dot.setAttribute("cx", p.x.toFixed(1));
        c.dot.setAttribute("cy", p.y.toFixed(1));
      }
    }
  }

  dispose() {
    this.root.remove();
  }
}
