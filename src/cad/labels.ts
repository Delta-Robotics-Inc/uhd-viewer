/**
 * Callout labels for the 3D view (PB-775): screen-space cards with leader
 * lines to 3D anchors, laid out in two columns like a product manual's
 * exploded-view callouts. HTML stays upright and camera-facing by
 * construction; positions are recomputed every frame.
 */
import * as THREE from "three";

export type LabelKind = "module" | "harness" | "interface";

export interface LabelItem {
  id: string;
  kind: LabelKind;
  title: string;
  sub?: string;
  /** World-space anchor (read every frame, so it follows explode and animation). */
  anchor: () => THREE.Vector3 | null;
  onClick?: () => void;
}

const SVGNS = "http://www.w3.org/2000/svg";

export class LabelLayer {
  readonly root: HTMLDivElement;
  private svg: SVGSVGElement;
  private cards = new Map<string, { el: HTMLDivElement; path: SVGPathElement; dot: SVGCircleElement; y: number }>();
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
        c = { el, path, dot, y: NaN };
        this.cards.set(item.id, c);
      }
      c.el.className = `cad-label kind-${item.kind}`;
      c.el.innerHTML = `<span class="cad-label-title"></span>${item.sub ? '<span class="cad-label-sub"></span>' : ""}`;
      (c.el.querySelector(".cad-label-title") as HTMLElement).textContent = item.title;
      if (item.sub) (c.el.querySelector(".cad-label-sub") as HTMLElement).textContent = item.sub;
      c.el.onclick = item.onClick ?? null;
      c.path.setAttribute("class", `kind-${item.kind}`);
      c.dot.setAttribute("class", `kind-${item.kind}`);
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

    const m = this.margins;
    type P = { item: LabelItem; x: number; y: number; w: number; h: number; side: -1 | 1 };
    const placed: P[] = [];
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
      const x = ((v.x + 1) / 2) * width;
      const y = ((1 - v.y) / 2) * height;
      placed.push({ item, x, y, w: c.el.offsetWidth, h: c.el.offsetHeight, side: 1 });
    }
    if (!placed.length) return;

    // columns hug the model: just outside the anchors' screen bounds
    const minX = Math.min(...placed.map((p) => p.x));
    const maxX = Math.max(...placed.map((p) => p.x));
    const mid = (minX + maxX) / 2;
    // side by anchor x, then balance the columns by moving the most central anchors
    for (const p of placed) p.side = p.x < mid ? -1 : 1;
    const count = (s: -1 | 1) => placed.filter((p) => p.side === s).length;
    while (Math.abs(count(-1) - count(1)) > 1) {
      const from: -1 | 1 = count(-1) > count(1) ? -1 : 1;
      const cand = placed.filter((p) => p.side === from).sort((a, b) => Math.abs(a.x - mid) - Math.abs(b.x - mid))[0];
      cand.side = (from * -1) as -1 | 1;
    }

    const gap = 6;
    for (const side of [-1, 1] as const) {
      const col = placed.filter((p) => p.side === side).sort((a, b) => a.y - b.y);
      if (!col.length) continue;
      const ys = col.map((p) => p.y - p.h / 2);
      for (let i = 1; i < ys.length; i++) ys[i] = Math.max(ys[i], ys[i - 1] + col[i - 1].h + gap);
      const overflow = ys[ys.length - 1] + col[col.length - 1].h - (height - m.bottom);
      if (overflow > 0) for (let i = 0; i < ys.length; i++) ys[i] -= overflow;
      for (let i = ys.length - 2; i >= 0; i--) ys[i] = Math.min(ys[i], ys[i + 1] - col[i].h - gap);
      if (ys[0] < m.top) {
        const shift = m.top - ys[0];
        for (let i = 0; i < ys.length; i++) ys[i] += shift;
      }
      const wMax = Math.max(...col.map((p) => p.w));
      // left column: right-aligned cards ending 56px left of the leftmost anchor
      const colEdge = side < 0 ? Math.max(m.left + wMax, minX - 56) : Math.min(width - m.right - wMax, maxX + 56);
      col.forEach((p, i) => {
        const c = this.cards.get(p.item.id)!;
        c.y = Number.isNaN(c.y) ? ys[i] : c.y + (ys[i] - c.y) * Math.min(1, k * 2.5);
        const colX = side < 0 ? colEdge - p.w : colEdge;
        const lx = side < 0 ? colEdge : colEdge;
        const ly = c.y + p.h / 2;
        c.el.style.transform = `translate(${colX.toFixed(1)}px, ${c.y.toFixed(1)}px)`;
        const ex = side < 0 ? lx + 16 : lx - 16;
        c.path.setAttribute("d", `M${p.x.toFixed(1)},${p.y.toFixed(1)} L${ex.toFixed(1)},${ly.toFixed(1)} L${lx.toFixed(1)},${ly.toFixed(1)}`);
        c.dot.setAttribute("cx", p.x.toFixed(1));
        c.dot.setAttribute("cy", p.y.toFixed(1));
      });
    }
  }

  dispose() {
    this.root.remove();
  }
}
