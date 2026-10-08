/**
 * A module expanded in place (PB-897): its children are laid out inside it,
 * it wraps them, and the links between them never leave it. On the IMU pod
 * fixture (the board expanded at the top level) and the IMU board of UHD's
 * own tests.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ModuleDef } from "@uhd/types/index.js";
import { buildView } from "../src/model/from-uhd";
import { systemDiagnostics } from "../src/model/diagnostics";
import { computeLayout, type Box, type LevelLayout } from "../src/layout/layout";
import { GridRouter, GRID } from "../src/layout/router";
import bundle from "../fixtures/imu-pod/uhd-bundle.json";

const defs = new Map((bundle.definitions as unknown as ModuleDef[]).map((d) => [d.id, d]));
const lookup = (id: string) => defs.get(id);
const root = defs.get(bundle.root)!;
const view = (expanded: string[]) => buildView(root, lookup, [], { expanded: new Set(expanded), diagnostics: systemDiagnostics(root, lookup) });

const inside = (b: Box, [x, y]: [number, number], slack = 0.5) => x >= b.x - slack && x <= b.x + b.w + slack && y >= b.y - slack && y <= b.y + b.h + slack;
const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function check(hand?: LevelLayout, overrides: Record<string, { x: number; y: number }> = {}) {
  const vm = view(["board"]);
  const layout = computeLayout(vm, hand, overrides, false);
  const box = layout.boxes.board;
  const kids = vm.nodes.filter((n) => n.parent === "board");
  expect(kids.length).toBeGreaterThan(5);
  // the container holds every one of its modules, whole
  for (const k of kids) {
    const b = layout.boxes[k.id];
    expect(inside(box, [b.x, b.y]) && inside(box, [b.x + b.w, b.y + b.h]), `${k.id} inside the container`).toBe(true);
  }
  // every link between two of them (and from the container's boundary inward) stays inside it
  const held = new Set(["board", ...kids.map((k) => k.id)]);
  const within = (id: string) => held.has(id);
  const inner = vm.links.filter((l) => within(l.source.node) && within(l.target.node) && layout.routes[l.id]);
  expect(inner.length).toBeGreaterThan(5);
  for (const l of inner) for (const p of layout.routes[l.id]) expect(inside(box, p), `${l.id} at ${p}`).toBe(true);
  return { vm, layout, kids, box };
}

describe("a module expanded in place", () => {
  it("lays its children out inside it (not in a pile), wraps them, and keeps their links inside", () => {
    const { layout, kids, box } = check();
    // no two modules on top of each other
    for (let i = 0; i < kids.length; i++) {
      for (let j = i + 1; j < kids.length; j++) expect(overlap(layout.boxes[kids[i].id], layout.boxes[kids[j].id]), `${kids[i].id} over ${kids[j].id}`).toBe(false);
    }
    // room for the label above them, and for the links around them
    const top = Math.min(...kids.map((k) => layout.boxes[k.id].y));
    const right = Math.max(...kids.map((k) => layout.boxes[k.id].x + layout.boxes[k.id].w));
    expect(top - box.y).toBeGreaterThanOrEqual(2 * GRID);
    expect(box.x + box.w - right).toBeGreaterThanOrEqual(GRID);
  });

  it("makes room among the other cards of the level: none is left under it", () => {
    const { vm, layout, box } = check();
    for (const n of vm.nodes.filter((x) => !x.parent && x.id !== "board")) expect(overlap(layout.boxes[n.id], box), n.id).toBe(false);
  });

  it("with a hand layout of the level, the cards beside and below it move by what it grew", () => {
    const collapsed = computeLayout(view([]), undefined, {}, false);
    const hand: LevelLayout = { nodes: Object.fromEntries(Object.entries(collapsed.boxes).map(([id, b]) => [id, { x: b.x, y: b.y }])) };
    const { vm, layout, box } = check(hand);
    for (const n of vm.nodes.filter((x) => !x.parent && x.id !== "board")) expect(overlap(layout.boxes[n.id], box), n.id).toBe(false);
    // a card the user dragged stays where it was put
    const other = vm.nodes.find((x) => !x.parent && x.id !== "board")!;
    const dragged = computeLayout(vm, hand, { [other.id]: { x: 4000, y: 4000 } }, false);
    expect(dragged.boxes[other.id]).toMatchObject({ x: 4000, y: 4000 });
  });

  it("keeps a child the user drags out to the left or above inside it", () => {
    const first = check();
    const kid = first.kids[0];
    const { layout, box } = check(undefined, { [kid.id]: { x: first.box.x - 400, y: first.box.y - 400 } });
    expect(layout.boxes[kid.id].x).toBeGreaterThanOrEqual(box.x);
    expect(layout.boxes[kid.id].y).toBeGreaterThanOrEqual(box.y);
  });

  it("leaves a level with nothing expanded as it was laid out", () => {
    const vm = view([]);
    const a = computeLayout(vm, undefined, {}, false);
    expect(Object.keys(a.boxes).length).toBe(vm.nodes.length);
    expect(vm.nodes.some((n) => n.expanded)).toBe(false);
  });
});

describe("the router's limit", () => {
  it("keeps a route inside a rectangle when it can, and routes without the limit when it cannot", () => {
    // a wall between the two ports: the short way round is outside the rectangle, the long way inside it
    const wall = { x: 96, y: -64, w: 32, h: 160 };
    const from: [number, number] = [0, 0];
    const to: [number, number] = [224, 0];
    const free = new GridRouter([wall], [from, to]).route(from, "right", to, "left");
    expect(Math.min(...free.map((p) => p[1]))).toBeLessThan(-64);
    const region = { x: -32, y: -32, w: 288, h: 200 };
    const kept = new GridRouter([wall], [from, to]).route(from, "right", to, "left", [], region);
    for (const [x, y] of kept) {
      expect(x).toBeGreaterThanOrEqual(region.x);
      expect(x).toBeLessThanOrEqual(region.x + region.w);
      expect(y).toBeGreaterThanOrEqual(region.y);
      expect(y).toBeLessThanOrEqual(region.y + region.h);
    }
    expect(Math.max(...kept.map((p) => p[1]))).toBeGreaterThan(96);
    // a rectangle the wall cuts in two: no way inside it, so the route is found without it
    const cut = { x: -32, y: -32, w: 288, h: 64 };
    const out = new GridRouter([wall], [from, to]).route(from, "right", to, "left", [], cut);
    expect(out[0]).toEqual(from);
    expect(out[out.length - 1]).toEqual(to);
    expect(out.length).toBeGreaterThan(2);
  });
});

describe("class names", () => {
  it("the container's class is not a Tailwind utility's (`container` has a max-width per breakpoint, `group` is a marker)", () => {
    const nodes = readFileSync(new URL("../src/canvas/nodes.tsx", import.meta.url), "utf8");
    const css = readFileSync(new URL("../src/styles/app.css", import.meta.url), "utf8");
    expect(nodes).not.toMatch(/className=\{`container\b/);
    expect(nodes).toMatch(/className=\{`module-container\b/);
    expect(css).not.toMatch(/^\.container[ .{]/m);
    expect(css).toMatch(/^\.module-container \{/m);
  });
});
