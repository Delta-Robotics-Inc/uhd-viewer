/**
 * The diagram the agent builds (PB-1007): the default layout of a level of
 * modules (a grid shaped like a screen, the hub in the middle, never one long
 * row), the layout metrics an agent checks before it signs off, and the
 * headless entry `protoboard layout` uses.
 */
import { describe, expect, it } from "vitest";
import type { UhdBundle } from "@uhd/types/bundle.js";
import { gridLayout, type GridNode } from "../src/layout/module-layout";
import { layoutFindings, measureLayout, LAYOUT_LIMITS } from "../src/layout/metrics";
import type { ComputedLayout } from "../src/layout/layout";
import type { ViewLink, ViewModel, ViewNode } from "../src/model/types";
import { diagramLevels, measureLevel, proposeLevel, reads } from "../src/headless";
import pod from "../fixtures/imu-pod/uhd-bundle.json";

const node = (id: string, extra: Partial<ViewNode> = {}): ViewNode => ({ id, label: id.toUpperCase(), icon: "box", kind: "module", ports: [], shape: "rect", status: "configured", childCount: 0, ...extra });
const link = (id: string, a: string, b: string): ViewLink =>
  ({ id, linkId: id, source: { node: a, port: "p" }, target: { node: b, port: "p" }, name: id, domain: "electrical", protocol: "x", state: "configured", children: [], diagnostics: [] }) as ViewLink;
/** A computed layout with only what the metrics read: boxes and routes. */
const drawn = (boxes: ComputedLayout["boxes"], routes: ComputedLayout["routes"]) => ({ boxes, routes }) as ComputedLayout;

type R = { x: number; y: number; w: number; h: number };
const overlap = (a: R, b: R) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("layout metrics", () => {
  it("counts crossings, overlaps, the strip, links under cards and the aspect ratio", () => {
    const vm: ViewModel = { path: [], derived: [], nodes: ["a", "b", "c", "d", "e"].map((id) => node(id)), links: [link("ab", "a", "b"), link("cd", "c", "d"), link("ae", "a", "e")] };
    const boxes = {
      a: { x: 0, y: 0, w: 100, h: 100 },
      b: { x: 400, y: 0, w: 100, h: 100 },
      c: { x: 200, y: -200, w: 100, h: 50 },
      d: { x: 200, y: 300, w: 100, h: 50 },
      // overlaps d
      e: { x: 250, y: 320, w: 100, h: 50 },
    };
    const routes: ComputedLayout["routes"] = {
      // a → b straight across; c → d straight down crosses it once
      ab: [[100, 50], [400, 50]],
      cd: [[250, -150], [250, 300]],
      // a → e runs under b's neighbour c? no: under d
      ae: [[50, 100], [50, 340], [250, 340]],
    };
    const m = measureLayout(vm, drawn(boxes, routes));
    expect(m.cards).toBe(5);
    expect(m.links).toBe(3);
    expect(m.crossings).toBe(1);
    expect(m.overlaps).toBe(1);
    expect(m.detail.overlaps).toEqual([["d", "e"]]);
    expect(m.underCards).toBe(1);
    expect(m.detail.underCards).toEqual([{ link: "ae", card: "d" }]);
    // a and b in one row (with nothing else across): 2; c, d (and e under d) down the middle: 3
    expect(m.strip).toBe(3);
    expect(m.stripAxis).toBe("column");
    expect(m.width).toBe(500);
    expect(m.height).toBe(570);
    expect(m.aspect).toBeCloseTo(500 / 570, 2);
  });

  it("flags a long row as a strip, and a level as tall as a column too", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `m${i}`);
    const vm: ViewModel = { path: [], derived: [], nodes: ids.map((id) => node(id)), links: [] };
    const row = Object.fromEntries(ids.map((id, i) => [id, { x: i * 400, y: 0, w: 200, h: 100 }]));
    const m = measureLayout(vm, drawn(row, {}));
    expect(m.strip).toBe(10);
    const codes = layoutFindings(m).map((f) => f.code);
    expect(codes).toContain("strip");
    expect(codes).toContain("aspect");
    // the same cards in a 4 × 3 block: nothing to fix
    const block = Object.fromEntries(ids.map((id, i) => [id, { x: (i % 4) * 400, y: Math.floor(i / 4) * 250, w: 200, h: 100 }]));
    const b = measureLayout(vm, drawn(block, {}));
    expect(b.strip).toBe(4);
    expect(layoutFindings(b)).toEqual([]);
  });

  it("allows longer rows on bigger levels, and a few crossings", () => {
    expect(LAYOUT_LIMITS.strip(10)).toBe(6);
    expect(LAYOUT_LIMITS.strip(64)).toBe(12);
    expect(LAYOUT_LIMITS.crossings(10)).toBe(3);
    expect(LAYOUT_LIMITS.crossings(80)).toBe(10);
  });
});

/** A hub (a processor) with peripherals around it, two of them chained, and a power stage. */
function star(n = 12): { nodes: GridNode[]; edges: [string, string][] } {
  const nodes: GridNode[] = [
    { id: "mcu", w: 240, h: 200, category: "microcontroller.module" },
    { id: "power", w: 176, h: 100, category: "power.regulator" },
    { id: "usb", w: 176, h: 84, category: "connector.usb" },
    ...Array.from({ length: n - 3 }, (_, i) => ({ id: `p${i}`, w: 176, h: 84 + (i % 3) * 22, category: i % 2 ? "sensor.motion" : "actuator.haptic" })),
  ];
  const edges: [string, string][] = [
    ["usb", "power"],
    ["power", "mcu"],
    ["power", "mcu"],
    ...nodes.slice(3).map((x) => ["mcu", x.id] as [string, string]),
    ["p0", "p2"],
  ];
  return { nodes, edges };
}

describe("module-level default layout (gridLayout)", () => {
  it("is deterministic, whatever order the cards and links come in", () => {
    const { nodes, edges } = star();
    const a = gridLayout(nodes, edges);
    expect(gridLayout(nodes, edges)).toEqual(a);
    expect(gridLayout(nodes.slice().reverse(), edges.slice().reverse())).toEqual(a);
  });

  it("puts the cards in a block shaped like a screen, the hub in the middle, nothing overlapping", () => {
    const { nodes, edges } = star(16);
    const at = gridLayout(nodes, edges);
    const boxes = nodes.map((n) => ({ id: n.id, ...at[n.id], w: n.w, h: n.h }));
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j]), `${boxes[i].id} / ${boxes[j].id}`).toBe(false);
    const vm: ViewModel = { path: [], derived: [], nodes: nodes.map((n) => node(n.id)), links: [] };
    const m = measureLayout(vm, drawn(Object.fromEntries(boxes.map((b) => [b.id, b])), {}));
    expect(m.strip).toBeLessThanOrEqual(LAYOUT_LIMITS.strip(m.cards));
    expect(m.aspect).toBeGreaterThan(1);
    expect(m.aspect).toBeLessThan(2.6);
    // the hub is neither in the first nor the last column or row
    const xs = [...new Set(boxes.map((b) => b.x + b.w / 2))].sort((p, q) => p - q);
    const hub = boxes.find((b) => b.id === "mcu")!;
    expect(hub.x + hub.w / 2).toBeGreaterThan(xs[0]);
    expect(hub.x + hub.w / 2).toBeLessThan(xs[xs.length - 1]);
    // the power stage feeds the processor from its left; a chained peripheral sits next to its partner
    expect(at.power.x).toBeLessThan(at.mcu.x);
    const d = (p: string, q: string) => Math.abs(at[p].x - at[q].x) + Math.abs(at[p].y - at[q].y);
    expect(d("p0", "p2")).toBeLessThan(800);
  });

  it("lays two or three cards side by side", () => {
    const at = gridLayout(
      [
        { id: "a", w: 176, h: 84 },
        { id: "b", w: 176, h: 84 },
      ],
      [["a", "b"]],
    );
    expect(at.a.y).toBe(at.b.y);
  });

  it("keeps fixed cards where they are and moves the others clear of them", () => {
    const { nodes, edges } = star();
    const fixed = { mcu: { x: 1000, y: 1000 }, p3: { x: 0, y: 0 } };
    const at = gridLayout(nodes, edges, { fixed });
    expect(at.mcu).toEqual(fixed.mcu);
    expect(at.p3).toEqual(fixed.p3);
    const boxes = nodes.map((n) => ({ id: n.id, ...at[n.id], w: n.w, h: n.h }));
    for (const f of ["mcu", "p3"]) for (const b of boxes) if (b.id !== f) expect(overlap(b, boxes.find((x) => x.id === f)!), `${b.id} over ${f}`).toBe(false);
  });

  it("starts a tidy from the earlier arrangement: rows and order kept where nothing is wrong", () => {
    const nodes: GridNode[] = ["a", "b", "c", "d"].map((id) => ({ id, w: 176, h: 84 }));
    // a b on top, c d below, each linked to the one under it
    const seed = { a: { x: 0, y: 0 }, b: { x: 500, y: 0 }, c: { x: 0, y: 300 }, d: { x: 500, y: 300 } };
    const at = gridLayout(nodes, [["a", "c"], ["b", "d"]], { seed });
    expect(at.a.y).toBe(at.b.y);
    expect(at.c.y).toBeGreaterThan(at.a.y);
    expect(at.a.x).toBeLessThan(at.b.x);
    expect(at.a.x).toBe(at.c.x);
  });
});

describe("headless layout (the IMU pod fixture)", () => {
  const bundle = pod as unknown as UhdBundle;

  it("lists the levels: the top and the board inside", () => {
    const levels = diagramLevels(bundle);
    expect(levels[0].level).toBe("");
    expect(levels.some((l) => l.level === "board" && l.board)).toBe(true);
  });

  it("measures the top level drawn by default: no overlaps, no strip, and better than the old single row", () => {
    const now = measureLevel(bundle, "", { layout: null });
    const old = measureLevel(bundle, "", { layout: null, legacy: true });
    expect(now.saved).toBe(false);
    expect(now.metrics.overlaps).toBe(0);
    expect(now.findings.filter((f) => f.severity === "warning")).toEqual([]);
    expect(reads(now.metrics)).toBeLessThanOrEqual(reads(old.metrics));
    // the same model gives the same layout
    expect(measureLevel(bundle, "", { layout: null }).layout.boxes).toEqual(now.layout.boxes);
  });

  it("proposes a layout that draws as the default does, and keeps pinned cards", () => {
    const fresh = measureLevel(bundle, "", { layout: null });
    const p = proposeLevel(bundle, "", { layout: null });
    expect(p.after.saved).toBe(true);
    expect(p.after.metrics.crossings).toBe(fresh.metrics.crossings);
    expect(p.after.metrics.overlaps).toBe(0);
    const ids = Object.keys(p.layout.nodes).filter((id) => !id.includes("/"));
    const pin = ids[0];
    const saved = { nodes: { ...p.layout.nodes, [pin]: { x: 4000, y: 4000 } } };
    const tidy = proposeLevel(bundle, "", { layout: saved, mode: "tidy", pinned: [pin] });
    expect(tidy.layout.nodes[pin]).toMatchObject({ x: 4000, y: 4000 });
    expect(tidy.layout.pinned).toEqual([pin]);
    expect(tidy.after.metrics.overlaps).toBe(0);
  });

  it("refuses a level that is not there", () => {
    expect(() => measureLevel(bundle, "nope")).toThrow(/no level "nope"/);
  });
});

describe("comparing two layouts", () => {
  const m = (over: Partial<import("../src/layout/metrics").LayoutMetrics>) => ({ cards: 10, links: 10, crossings: 0, overlaps: 0, aspect: 1.5, width: 1500, height: 1000, strip: 4, stripAxis: "row" as const, stripCards: [], underCards: 0, length: 5000, detail: { overlaps: [], underCards: [] }, ...over });
  it("prefers fewer problems, and does not replace a clean layout for a little less line", async () => {
    const { readsBetter } = await import("../src/headless");
    expect(readsBetter(m({ crossings: 1 }), m({ crossings: 2 }))).toBe(true);
    expect(readsBetter(m({ crossings: 0, length: 9000 }), m({ overlaps: 1 }))).toBe(true);
    expect(readsBetter(m({ length: 4500 }), m({}))).toBe(false);
    expect(readsBetter(m({ length: 3000 }), m({}))).toBe(true);
  });
});
