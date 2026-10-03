import { describe, expect, it } from "vitest";
import { graphLayout } from "../src/layout/graph-layout";
import { computeLayout } from "../src/layout/layout";
import { buildView } from "../src/model/from-uhd";
import { IMU_BOARD, lookupBoardModule } from "../../uhd/test/fixtures/imu-board";

const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("layout of a level with nets", () => {
  it("is deterministic and keeps cards apart", () => {
    const nodes = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, w: i % 3 ? 64 : 170, h: i % 3 ? 32 : 100 }));
    const edges = nodes.slice(1).map((n, i) => [nodes[i % 4].id, n.id] as [string, string]);
    const a = graphLayout(nodes, edges);
    expect(graphLayout(nodes, edges)).toEqual(a);
    const boxes = nodes.map((n) => ({ ...a[n.id], w: n.w, h: n.h }));
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j])).toBe(false);
  });

  it("places every component and junction of the fixture board without overlaps, and routes its lines", () => {
    const vm = buildView(IMU_BOARD, lookupBoardModule, [], { expanded: new Set() });
    const layout = computeLayout(vm, undefined, {}, false);
    const boxes = vm.nodes.map((n) => layout.boxes[n.id]);
    expect(boxes.every(Boolean)).toBe(true);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j]), `${vm.nodes[i].id} / ${vm.nodes[j].id}`).toBe(false);
    // every line that is not a ground symbol is routed
    for (const l of vm.links.filter((l) => !l.ground)) expect(layout.routes[l.id], l.id).toBeDefined();
  });
});
