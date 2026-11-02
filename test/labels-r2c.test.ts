/**
 * R2-C (wave R2, 2026-11-02): crowded label columns (walkthrough D5, the R1 gate's "cards overlap in a crowded column"),
 * the distance-scaled ease, the edge pin for an anchor out of the view, and the refdes / MPN label kinds.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  CHIP_W,
  COMPACT_H,
  COMPACT_RELEASE,
  EASE_MAX_MS,
  LABEL_GAP,
  LabelLayer,
  MIN_PITCH,
  SLOT_EASE_MS,
  easeLeft,
  easeMs,
  edgePin,
  layoutLabels,
  type LabelBox,
  type LabelItem,
  type LabelLayout,
} from "../src/cad/labels";
import { FakeEl, installFakeDom } from "./labels-fakedom";

const W = 1440;
const H = 900;
const M = { top: 60, bottom: 64, left: 56, right: 16 };
const AVAIL = H - M.top - M.bottom;

/** n labels whose anchors sit in a tight cluster left of a few right-side anchors (one crowded left column). */
function crowd(n: number, x = 520, opts: { importance?: (i: number) => number; depth?: (i: number) => number } = {}): LabelBox[] {
  const left = Array.from({ length: n }, (_, i) => ({ id: `c${i}`, x: x + (i % 5) * 3, y: 200 + ((i * 37) % 500), w: 150, h: 36, importance: opts.importance?.(i) ?? 0, depth: opts.depth?.(i) ?? i }));
  return left;
}

/** Every placed card and chip as a box; none overlap, all inside the view. */
function noOverlap(items: LabelBox[], out: LabelLayout) {
  const boxes = [
    ...[...out.placed].map(([id, p]) => ({ id, x: p.x, y: p.y, w: p.w, h: p.h, compact: p.compact })),
    ...out.chips.map((c, i) => ({ id: `chip${i}`, x: c.x, y: c.y, w: c.w, h: c.h, compact: true })),
  ];
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i];
    expect(a.x, a.id).toBeGreaterThanOrEqual(M.left - 0.01);
    expect(a.x + a.w, a.id).toBeLessThanOrEqual(W - M.right + 0.01);
    expect(a.y, a.id).toBeGreaterThanOrEqual(M.top - 0.01);
    expect(a.y + a.h, a.id).toBeLessThanOrEqual(H - M.bottom + 0.01);
    for (let j = i + 1; j < boxes.length; j++) {
      const b = boxes[j];
      const hit = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      expect(hit, `${a.id} / ${b.id}`).toBe(false);
    }
  }
  // every label is either placed or in a chip
  expect(out.placed.size + out.chips.reduce((t, c) => t + c.ids.length, 0)).toBe(items.length);
  return boxes;
}

const fixedLeft = (items: LabelBox[]) => new Map<string, -1 | 1>(items.map((p) => [p.id, -1 as const]));

describe("crowded columns (D5, R2-C)", () => {
  it("a column that fits stays full size at LABEL_GAP", () => {
    const items = crowd(8);
    const out = layoutLabels(items, W, H, M, fixedLeft(items));
    expect(out.compact.left).toBe(false);
    expect(out.chips).toHaveLength(0);
    for (const p of out.placed.values()) expect(p.h).toBe(36);
    noOverlap(items, out);
  });

  it("too tall for the view: compact cards at MIN_PITCH, no overlap", () => {
    // 30 full cards need 30 x 42 = 1260 px of 776
    const items = crowd(30);
    const out = layoutLabels(items, W, H, M, fixedLeft(items));
    expect(out.compact.left).toBe(true);
    for (const p of out.placed.values()) {
      expect(p.compact).toBe(true);
      expect(p.h).toBe(COMPACT_H);
      expect(p.column).toBe(0);
    }
    noOverlap(items, out);
  });

  it("more than one compact column holds: a second column one label width out, no overlap", () => {
    const cap = Math.floor((AVAIL + (MIN_PITCH - COMPACT_H)) / MIN_PITCH);
    const items = crowd(cap + 10, 700);
    const out = layoutLabels(items, W, H, M, fixedLeft(items));
    const cols = new Set([...out.placed.values()].map((p) => p.column));
    expect(cols).toEqual(new Set([0, 1]));
    expect(out.chips).toHaveLength(0);
    const xs = (c: number) => [...out.placed.values()].filter((p) => p.column === c);
    // the second column is further out (left of the first), and the two never share x
    expect(Math.max(...xs(1).map((p) => p.x + p.w))).toBeLessThanOrEqual(Math.min(...xs(0).map((p) => p.x)));
    noOverlap(items, out);
  });

  it("still too many: the least important, then the farthest, collapse into a +N chip at the column's end", () => {
    const cap = Math.floor((AVAIL + (MIN_PITCH - COMPACT_H)) / MIN_PITCH);
    const n = cap * 2 + 25;
    // the first ten are errors (importance 2); depth grows with i, so the last ones are the farthest
    const items = crowd(n, 700, { importance: (i) => (i < 10 ? 2 : 0) });
    const out = layoutLabels(items, W, H, M, fixedLeft(items));
    expect(out.chips).toHaveLength(1);
    const chip = out.chips[0];
    // one slot of the outer column is the chip
    expect(chip.ids).toHaveLength(n - (cap * 2 - 1));
    expect(chip.column).toBe(1);
    expect(chip.w).toBe(CHIP_W);
    // the errors stay; the collapsed are the farthest of the rest
    for (let i = 0; i < 10; i++) expect(out.placed.has(`c${i}`)).toBe(true);
    const collapsedIdx = chip.ids.map((id) => Number(id.slice(1)));
    expect(Math.min(...collapsedIdx)).toBeGreaterThan(Math.max(...[...out.placed.keys()].map((id) => Number(id.slice(1)))) - 1);
    // the chip is at the column's end (below every card of its column)
    for (const p of out.placed.values()) if (p.column === chip.column) expect(p.y).toBeLessThan(chip.y);
    noOverlap(items, out);
  });

  it("a model against the view's left edge: both columns would share the edge strip, so the labels go to the side with room", () => {
    const items = crowd(12, 70);
    const out = layoutLabels(items, W, H, M);
    for (const p of out.placed.values()) expect(p.side).toBe(1);
    noOverlap(items, out);
    // labels held on the left (hysteresis) with nothing on the right: they stay, clamped to the margin, apart
    noOverlap(items, layoutLabels(items, W, H, M, fixedLeft(items)));
  });

  it("no room further out on either side (the model fills the view): the second column goes inward, never over the other side", () => {
    const cap = Math.floor((AVAIL + (MIN_PITCH - COMPACT_H)) / MIN_PITCH);
    const left = crowd(cap + 12, 70);
    const right = crowd(cap + 12, 1360).map((p) => ({ ...p, id: `r${p.id}` }));
    const items = [...left, ...right];
    const fixed = new Map<string, -1 | 1>([...left.map((p) => [p.id, -1] as [string, -1]), ...right.map((p) => [p.id, 1] as [string, 1])]);
    const out = layoutLabels(items, W, H, M, fixed);
    const col = (s: -1 | 1, c: number) => [...out.placed.values()].filter((p) => p.side === s && p.column === c);
    expect(col(-1, 1).length).toBeGreaterThan(0);
    expect(col(1, 1).length).toBeGreaterThan(0);
    // left: the second column right of the first; right: left of its first
    expect(Math.min(...col(-1, 1).map((p) => p.x))).toBeGreaterThanOrEqual(Math.max(...col(-1, 0).map((p) => p.x + p.w)));
    expect(Math.max(...col(1, 1).map((p) => p.x + p.w))).toBeLessThanOrEqual(Math.min(...col(1, 0).map((p) => p.x)));
    noOverlap(items, out);
  });

  it("goes back to full cards only with room to spare (no flicker at the line)", () => {
    // full need just under the view: (n x 42) - 6 between COMPACT_RELEASE x avail and avail
    const n = Math.floor((AVAIL + LABEL_GAP) / (36 + LABEL_GAP));
    const items = crowd(n);
    const need = n * (36 + LABEL_GAP) - LABEL_GAP;
    expect(need).toBeLessThanOrEqual(AVAIL);
    expect(need).toBeGreaterThan(AVAIL * COMPACT_RELEASE);
    expect(layoutLabels(items, W, H, M, fixedLeft(items)).compact.left).toBe(false);
    expect(layoutLabels(items, W, H, M, fixedLeft(items), { left: true }).compact.left).toBe(true);
    const fewer = crowd(Math.floor(n * 0.8));
    expect(layoutLabels(fewer, W, H, M, fixedLeft(fewer), { left: true }).compact.left).toBe(false);
  });

  it("every crowd size and anchor spread: never an overlap, every label accounted for", () => {
    for (const n of [5, 20, 45, 60, 90, 130]) for (const x of [70, 300, 700, 1300]) {
      const items = crowd(n, x);
      noOverlap(items, layoutLabels(items, W, H, M, fixedLeft(items)));
      // free sides too
      noOverlap(items, layoutLabels(items, W, H, M));
    }
  });
});

describe("long moves ease longer (R2-C)", () => {
  it("120 ms plus 0.25 ms a pixel, at most 400 ms", () => {
    expect(easeMs(0)).toBe(SLOT_EASE_MS);
    expect(easeMs(690)).toBeCloseTo(120 + 0.25 * 690, 6);
    expect(easeMs(5000)).toBe(EASE_MAX_MS);
    // the R1 gate's 690 px crossing: its first 8 ms frame moves under 10 % of the way (it was 19 %)
    expect(1 - easeLeft(8, easeMs(690))).toBeLessThan(0.1);
    expect(1 - easeLeft(8, SLOT_EASE_MS)).toBeGreaterThan(0.18);
  });
});

describe("an anchor out of the view: an edge pin pointing at it (R2-C)", () => {
  it("lands on the edge toward the anchor, and flips for an anchor behind the camera", () => {
    const right = edgePin(3000, 450 + (M.top - M.bottom) / 2, W, H, M);
    expect(right.x).toBeCloseTo(W - M.right, 3);
    expect(right.angle).toBeCloseTo(0, 3);
    const up = edgePin(700, -500, W, H, M);
    expect(up.y).toBeCloseTo(M.top, 3);
    expect(up.angle).toBeLessThan(0);
    const behind = edgePin(3000, 450 + (M.top - M.bottom) / 2, W, H, M, true);
    expect(behind.x).toBeCloseTo(M.left, 3);
  });
});

describe("the label layer with a crowded column (stand-in DOM)", () => {
  let dom: ReturnType<typeof installFakeDom>;
  beforeEach(() => {
    dom = installFakeDom();
  });
  afterEach(() => dom.restore());
  const camera = () => {
    const c = new THREE.PerspectiveCamera(32, W / H, 1, 5000);
    c.up.set(0, 0, 1);
    c.position.set(0, -400, 200);
    c.lookAt(0, 0, 0);
    c.updateMatrixWorld();
    return c;
  };
  const kids = (layer: LabelLayer, cls: string) => (layer.root as unknown as FakeEl).children.filter((e) => e.className.split(" ").includes(cls));

  it("compact cards, a +N chip whose hover lists the collapsed labels, edge pins for anchors out of the view", () => {
    const layer = new LabelLayer(dom.host as unknown as HTMLElement);
    layer.target = layer.opacity = 1;
    // 240 board parts in a small patch of the model (a board seen from afar), plus one far outside the view
    const items: LabelItem[] = Array.from({ length: 240 }, (_, i) => ({ id: `refdes:p${i}`, kind: "refdes" as const, title: `C${i}`, anchor: () => new THREE.Vector3(-30 + (i % 12) * 5, 0, (i % 7) * 4) }));
    items.push({ id: "far", kind: "module", title: "Far away", anchor: () => new THREE.Vector3(5000, 0, 0) });
    layer.setItems(items);
    layer.update(camera(), W, H, 1 / 60, 0);
    const shown = layer.layout();
    expect(shown.length).toBeGreaterThan(40);
    expect(shown.every((l) => l.compact)).toBe(true);
    for (const c of kids(layer, "cad-label").filter((e) => e.style.display !== "none")) expect(c.classList.contains("compact")).toBe(true);
    const chips = layer.chipsDrawn();
    expect(chips.length).toBeGreaterThan(0);
    const held = chips.reduce((t, c) => t + c.ids.length, 0);
    expect(shown.length + held).toBe(240);
    const chipEl = kids(layer, "cad-label-more")[0];
    expect(chipEl.textContent).toBe(`+${chips[0].ids.length}`);
    // hover: the list opens with one entry per collapsed label
    chipEl.dispatchEvent(new Event("pointerenter"));
    const list = kids(layer, "cad-label-more-list")[0];
    expect(list.classList.contains("open")).toBe(true);
    expect(list.children).toHaveLength(chips[0].ids.length);
    // the far anchor: no card, an edge pin
    expect(layer.edgePins()).toEqual(["far"]);
    expect(kids(layer, "cad-label-edge")[0].style.display).toBe("");
    layer.dispose();
  });
});

describe("second columns never cross (R2-C, found on the cube shell at 1000 x 340)", () => {
  it("both sides crowded, the model filling a small view: no column over another", () => {
    const m = { top: 60, bottom: 64, left: 56, right: 380 };
    let second = 0;
    let chips = 0;
    for (const [w, h] of [[1000, 340], [1440, 420], [800, 300]] as const)
      for (const n of [13, 20, 30]) {
        const left = Array.from({ length: n }, (_, i) => ({ id: `l${i}`, x: 150 + (i % 4) * 20, y: 80 + ((i * 29) % (h - 140)), w: 160, h: 36 }));
        const right = Array.from({ length: n + 1 }, (_, i) => ({ id: `r${i}`, x: w - m.right - 260 + (i % 4) * 20, y: 80 + ((i * 31) % (h - 140)), w: 160, h: 36 }));
        const items = [...left, ...right];
        const out = layoutLabels(items, w, h, m);
        const boxes = [...[...out.placed.values()], ...out.chips];
        for (let i = 0; i < boxes.length; i++)
          for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i];
            const b = boxes[j];
            expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h, `${w}x${h} n=${n} ${i}/${j}`).toBe(false);
          }
        expect(out.placed.size + out.chips.reduce((t, c) => t + c.ids.length, 0)).toBe(items.length);
        second += [...out.placed.values()].filter((p) => p.column > 0).length;
        chips += out.chips.length;
      }
    // the cases exercise second columns and chips
    expect(second).toBeGreaterThan(0);
    expect(chips).toBeGreaterThan(0);
  });
});
