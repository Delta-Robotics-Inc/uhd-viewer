import { describe, expect, it } from "vitest";
import { LABEL_GAP, LEADER_RUN, segmentsCross, solveLabels, type LabelBox } from "../src/cad/labels";

const W = 1600;
const H = 1000;
const M = { top: 60, bottom: 64, left: 56, right: 16 };

/** A deterministic scatter of anchors, many near each other (a small assembly's labels). */
function scatter(n: number, seed = 7, spread = 260): LabelBox[] {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: n }, (_, i) => ({ id: `l${i}`, x: 800 + (rnd() - 0.5) * spread, y: 500 + (rnd() - 0.5) * spread, w: 120 + Math.round(rnd() * 140), h: rnd() > 0.3 ? 36 : 20 }));
}

function check(items: LabelBox[]) {
  const out = solveLabels(items, W, H, M);
  expect(out.size).toBe(items.length);
  const boxes = items.map((p) => ({ id: p.id, ...out.get(p.id)!, w: p.w, h: p.h, ay: p.y }));
  // no two cards overlap
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const hit = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h + LABEL_GAP - 0.01 && b.y < a.y + a.h + LABEL_GAP - 0.01;
      expect(hit, `${a.id} / ${b.id}`).toBe(false);
    }
  // no two leaders in a column cross (anchor to the elbow beside the card's inner edge)
  const cols = new Map<string, typeof boxes>();
  for (const b of boxes) cols.set(`${b.side}:${b.column}`, [...(cols.get(`${b.side}:${b.column}`) ?? []), b]);
  const leader = (b: (typeof boxes)[number]) => {
    const a = items.find((p) => p.id === b.id)!;
    const ex = b.side < 0 ? b.x + b.w + LEADER_RUN : b.x - LEADER_RUN;
    return [[a.x, a.y], [ex, b.y + b.h / 2]] as [[number, number], [number, number]];
  };
  for (const col of cols.values())
    for (let i = 0; i < col.length; i++)
      for (let j = i + 1; j < col.length; j++) {
        const [p1, p2] = leader(col[i]);
        const [q1, q2] = leader(col[j]);
        expect(segmentsCross(p1, p2, q1, q2), `${col[i].id} × ${col[j].id}`).toBe(false);
      }
  // cards stay inside the view horizontally
  for (const b of boxes) {
    expect(b.x).toBeGreaterThanOrEqual(M.left - 0.01);
    expect(b.x + b.w).toBeLessThanOrEqual(W - M.right + 0.01);
  }
  return { out, boxes };
}

describe("3D callout label solver", () => {
  it("never overlaps cards and keeps each column in anchor order", () => {
    for (const n of [1, 2, 5, 12, 18]) for (const seed of [3, 7, 11]) check(scatter(n, seed));
  });

  it("puts cards beside the model: left anchors on the left, right anchors on the right", () => {
    const items: LabelBox[] = [
      { id: "a", x: 600, y: 400, w: 150, h: 36 },
      { id: "b", x: 1000, y: 420, w: 150, h: 36 },
    ];
    const { out } = check(items);
    expect(out.get("a")!.side).toBe(-1);
    expect(out.get("b")!.side).toBe(1);
    expect(out.get("a")!.x + 150).toBeLessThanOrEqual(600);
    expect(out.get("b")!.x).toBeGreaterThanOrEqual(1000);
  });

  it("anchors at one point (a stack seen end-on) still get separate cards", () => {
    check(Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, x: 800, y: 500, w: 160, h: 36 })));
  });

  it("spills a side taller than the view into a second column", () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, x: 780 + (i % 2) * 40, y: 300 + i * 4, w: 140, h: 36 }));
    const { boxes } = check(items);
    expect(boxes.some((b) => b.column > 0)).toBe(true);
    for (const b of boxes) expect(b.y + b.h).toBeLessThanOrEqual(H - M.bottom + 0.01);
  });

  it("re-solves for a new camera: the same anchors moved give a valid layout again", () => {
    const a = scatter(12, 5);
    check(a);
    check(a.map((p) => ({ ...p, x: W - p.x, y: p.y * 0.7 + 120 })));
  });

  it("untangles leaders in crowded columns (ordering by anchor height alone crossed in most of these)", () => {
    for (let seed = 1; seed <= 20; seed++) for (const n of [8, 14, 22]) check(scatter(n, seed, 300));
  });

  it("finds crossing segments, and not ones that only touch", () => {
    expect(segmentsCross([0, 0], [10, 10], [0, 10], [10, 0])).toBe(true);
    expect(segmentsCross([0, 0], [10, 0], [0, 5], [10, 5])).toBe(false);
    expect(segmentsCross([0, 0], [10, 10], [10, 10], [20, 0])).toBe(false);
  });
});
