import { describe, expect, it } from "vitest";
import { boardLayout, freeSpot, functionGroup, hits, pack, type BoardNode } from "../src/layout/board-layout";
import { tapRails } from "../src/layout/taps";
import { at } from "../src/canvas/geometry";
import { computeLayout } from "../src/layout/layout";
import { buildView } from "../src/model/from-uhd";
import { IMU_BOARD, lookupBoardModule } from "../../uhd/test/fixtures/imu-board";
import type { ModuleDef } from "@uhd/types/index.js";

type R = { x: number; y: number; w: number; h: number };
const overlap = (a: R, b: R) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const noOverlaps = (boxes: R[], names: string[]) => {
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j]), `${names[i]} / ${names[j]}`).toBe(false);
};
const centre = (b: R) => [b.x + b.w / 2, b.y + b.h / 2];

/** A small board: a regulator, a processor, a sensor, a connector, their passives and nets. */
function board(): { nodes: BoardNode[]; edges: [string, string][] } {
  const card = (id: string, category: string, label: string, h = 100): BoardNode => ({ id, w: 176, h, category, label });
  const net = (id: string): BoardNode => ({ id: `:${id}`, w: 80, h: 32, net: true, label: id.toUpperCase() });
  const nodes = [
    card("j1", "connector.usb", "USB-C receptacle"),
    card("u1", "microcontroller.module", "BLE module", 300),
    card("u2", "sensor.motion", "IMU"),
    card("u3", "power.regulator", "3V0 LDO"),
    card("c1", "component.passive.capacitor", "U3 input"),
    card("c2", "component.passive.capacitor", "U3 output"),
    card("c3", "component.passive.capacitor", "U2 VDD"),
    card("r1", "component.passive.resistor", "SDA pull-up"),
    card("sw1", "component.switch", "Button"),
    ...["vbus", "v3v0", "sda", "scl", "int1", "btn"].map(net),
  ];
  const on = (n: string, ...members: string[]) => members.map((m) => [m, `:${n}`] as [string, string]);
  const edges = [
    ...on("vbus", "j1", "u3", "c1"),
    ...on("v3v0", "u3", "c2", "u1", "u2", "c3", "r1"),
    ...on("sda", "u1", "u2", "r1"),
    ...on("scl", "u1", "u2"),
    ...on("int1", "u1", "u2"),
    ...on("btn", "u1", "sw1"),
  ];
  return { nodes, edges };
}

describe("board layout (a level with nets)", () => {
  it("groups by function, from the taxonomy category", () => {
    expect(functionGroup("power.regulator")).toBe("power");
    expect(functionGroup("microcontroller.module")).toBe("mcu");
    expect(functionGroup("sensor.biometric")).toBe("sensor");
    expect(functionGroup("connector.usb")).toBe("io");
    expect(functionGroup("actuator.haptic")).toBe("output");
    expect(functionGroup(undefined)).toBe("other");
  });

  it("is deterministic, keeps every box apart, and puts the columns in function order", () => {
    const { nodes, edges } = board();
    const at = boardLayout(nodes, edges);
    expect(boardLayout(nodes, edges)).toEqual(at);
    const boxes = nodes.map((n) => ({ ...at[n.id], w: n.w, h: n.h }));
    noOverlaps(boxes, nodes.map((n) => n.id));
    // power (the regulator) left of the processor, the processor left of the sensor
    expect(at.u3.x).toBeLessThan(at.u1.x);
    expect(at.u1.x).toBeLessThan(at.u2.x);
  });

  it("keeps a passive with the part it serves and a dedicated switch with what it drives", () => {
    const { nodes, edges } = board();
    const at = boardLayout(nodes, edges);
    const box = (id: string) => ({ ...at[id], ...nodes.find((n) => n.id === id)! });
    const dist = (a: string, b: string) => Math.hypot(centre(box(a))[0] - centre(box(b))[0], centre(box(a))[1] - centre(box(b))[1]);
    // "U3 input" sits under U3, not under the processor it shares the 3V0 rail with
    expect(dist("c1", "u3")).toBeLessThan(dist("c1", "u1"));
    expect(Math.abs(centre(box("c3"))[0] - centre(box("u2"))[0])).toBeLessThan(300);
    // the button's only specific net goes to the processor: it is drawn in the processor's column
    expect(Math.abs(centre(box("sw1"))[0] - centre(box("u1"))[0])).toBeLessThan(400);
  });

  it("places each junction between the parts it joins", () => {
    const { nodes, edges } = board();
    const at = boardLayout(nodes, edges);
    const box = (id: string) => ({ ...at[id], ...nodes.find((n) => n.id === id)! });
    // a two-member net sits between its members, not at the sheet's edge
    for (const net of [":scl", ":int1"]) {
      const [x] = centre(box(net));
      expect(x).toBeGreaterThan(centre(box("u1"))[0]);
      expect(x).toBeLessThan(centre(box("u2"))[0]);
    }
  });

  it("finds the nearest free spot", () => {
    const at = freeSpot([100, 100], 64, 32, [{ x: 0, y: 0, w: 200, h: 200 }], { x: 10, y: 10 });
    expect(overlap({ ...at, w: 64, h: 32 }, { x: -10, y: -10, w: 220, h: 220 })).toBe(false);
  });

  it("places every component and junction of the fixture board without overlaps, and routes its lines", () => {
    const vm = buildView(IMU_BOARD, lookupBoardModule, [], { expanded: new Set() });
    const layout = computeLayout(vm, undefined, {}, false);
    const boxes = vm.nodes.map((n) => layout.boxes[n.id]);
    expect(boxes.every(Boolean)).toBe(true);
    noOverlaps(boxes, vm.nodes.map((n) => n.id));
    // every line that is not a ground symbol is routed
    for (const l of vm.links.filter((l) => !l.ground)) expect(layout.routes[l.id], l.id).toBeDefined();
  });

  it("lays out what a hand layout leaves out next to what it is linked to, not at the origin", () => {
    const vm = buildView(IMU_BOARD, lookupBoardModule, [], { expanded: new Set() });
    const auto = computeLayout(vm, undefined, {}, false);
    // a saved layout that names only the components (the junctions came later)
    const comps = vm.nodes.filter((n) => n.kind !== "net" && !n.parent);
    const hand = { nodes: Object.fromEntries(comps.map((n) => [n.id, { x: auto.boxes[n.id].x, y: auto.boxes[n.id].y }])) };
    const layout = computeLayout(vm, hand, {}, false);
    const top = vm.nodes.filter((n) => !n.parent);
    noOverlaps(top.map((n) => layout.boxes[n.id]), top.map((n) => n.id));
    for (const n of top.filter((n) => n.kind === "net")) {
      const b = layout.boxes[n.id];
      expect(b.x !== 0 || b.y !== 0, n.id).toBe(true);
      // near a member: within a few cards of the nearest component it joins
      const members = vm.links.filter((l) => l.target.node === n.id || l.source.node === n.id).map((l) => (l.target.node === n.id ? l.source.node : l.target.node));
      const d = Math.min(...members.map((m) => Math.hypot(centre(b)[0] - centre(layout.boxes[m])[0], centre(b)[1] - centre(layout.boxes[m])[1])));
      expect(d, n.id).toBeLessThan(900);
    }
  });

  it("packs boxes in order, as near their ideal tops as the gaps allow", () => {
    expect(pack([0, 0, 0], [32, 32, 32], 16)).toEqual([-48, 0, 48]);
    expect(pack([0, 400], [32, 32], 16)).toEqual([0, 400]);
  });

  it("puts junctions in the channels between columns, a grid track clear of every card", () => {
    const { nodes, edges } = board();
    const at = boardLayout(nodes, edges);
    const box = (n: BoardNode) => ({ ...at[n.id], w: n.w, h: n.h });
    for (const hub of nodes.filter((n) => n.net))
      for (const card of nodes.filter((n) => !n.net)) expect(hits(box(hub), box(card), 32), `${hub.id} / ${card.id}`).toBe(false);
  });

  it("stacks a part's passives on the side their junctions are, so their lines do not cross the other stack", () => {
    const card = (id: string, category: string, label: string): BoardNode => ({ id, w: 176, h: 96, category, label });
    const net = (id: string): BoardNode => ({ id: `:${id}`, w: 80, h: 32, net: true, label: id });
    const nodes = [
      card("u3", "power.regulator", "LDO"),
      card("u1", "microcontroller.module", "MCU"),
      card("u2", "sensor.motion", "IMU"),
      card("c1", "component.passive.capacitor", "U1 VDD"),
      card("r1", "component.passive.resistor", "U1 INT pull-up"),
      net("vdd"),
      net("int"),
    ];
    const on = (n: string, ...m: string[]) => m.map((x) => [x, `:${n}`] as [string, string]);
    const at = boardLayout(nodes, [...on("vdd", "u3", "u1", "c1"), ...on("int", "u1", "u2", "r1")]);
    // the supply comes from the left (the regulator), the interrupt goes right (the sensor)
    expect(at.c1.x).toBeLessThan(at.r1.x);
    expect(at[":vdd"].x).toBeLessThan(at.u1.x);
    expect(at[":int"].x).toBeGreaterThan(at.u1.x);
    // both under their part
    expect(at.c1.y).toBeGreaterThan(at.u1.y);
    expect(at.r1.y).toBeGreaterThan(at.u1.y);
  });

  it("draws the parts a peripheral drives one column further out, their junctions in one lane level with them", () => {
    const card = (id: string, category: string, label: string, h = 96): BoardNode => ({ id, w: 176, h, category, label });
    const net = (id: string): BoardNode => ({ id: `:${id}`, w: 96, h: 32, net: true, label: id });
    const leds = ["d1", "d2", "d3", "d4"];
    const nodes = [
      card("u1", "microcontroller.module", "MCU"),
      card("u3", "component.ic", "LED driver", 400),
      ...leds.map((d) => card(d, "component.led", `RGB ${d}`)),
      net("en"),
      ...leds.flatMap((d) => ["r", "g", "b"].map((c) => net(`${d}_${c}`))),
    ];
    const edges: [string, string][] = [
      ["u1", ":en"],
      ["u3", ":en"],
      ...leds.flatMap((d) => ["r", "g", "b"].flatMap((c) => [[d, `:${d}_${c}`], ["u3", `:${d}_${c}`]] as [string, string][])),
    ];
    const pos = boardLayout(nodes, edges);
    for (const d of leds) expect(pos[d].x, d).toBeGreaterThan(pos.u3.x + 176);
    const ledHubs = leds.flatMap((d) => ["r", "g", "b"].map((c) => `:${d}_${c}`));
    expect(new Set(ledHubs.map((h) => pos[h].x)).size).toBe(1);
    // each LED's junctions within reach of its own height, not piled at the driver's middle
    for (const d of leds) for (const c of ["r", "g", "b"]) expect(Math.abs(pos[`:${d}_${c}`].y - pos[d].y), `${d}_${c}`).toBeLessThan(200);
  });

  it("routes every line round the cards it does not end at, and keeps labels off the cards", () => {
    const vm = tapRails(buildView(IMU_BOARD, lookupBoardModule, [], { expanded: new Set() }));
    const layout = computeLayout(vm, undefined, {}, false);
    const top = vm.nodes.filter((n) => !n.parent);
    for (const l of vm.links) {
      const r = layout.routes[l.id];
      if (!r) continue;
      for (let i = 1; i < r.length; i++)
        for (const n of top) {
          if (n.id === l.source.node || n.id === l.target.node) continue;
          const b = layout.boxes[n.id];
          const [x0, x1] = [Math.min(r[i - 1][0], r[i][0]), Math.max(r[i - 1][0], r[i][0])];
          const [y0, y1] = [Math.min(r[i - 1][1], r[i][1]), Math.max(r[i - 1][1], r[i][1])];
          expect(x1 > b.x + 1 && x0 < b.x + b.w - 1 && y1 > b.y + 1 && y0 < b.y + b.h - 1, `${l.id} through ${n.id}`).toBe(false);
        }
    }
    for (const [id, s] of Object.entries(layout.labelAt)) {
      const link = vm.links.find((l) => l.id === id)!;
      const w = link.name.length * 5.6 + (link.children.length > 1 ? 44 : 16);
      const { p, d } = at(layout.routes[id], s);
      const rect = Math.abs(d[1]) > Math.abs(d[0]) ? { x: p[0] + 2, y: p[1] - w / 2, w: 22, h: w } : { x: p[0] - w / 2, y: p[1] - 22, w, h: 20 };
      const opens = (link.lanes?.length ?? 0) > 1 || link.children.length > 1;
      if (opens) continue; // a link that opens keeps its label (its toggle) wherever it fits best
      for (const n of top) expect(overlap(rect, layout.boxes[n.id]), `label ${id} on ${n.id}`).toBe(false);
    }
  });
});

describe("a level with nothing on it (a new system with no modules yet)", () => {
  it("lays out without failing: no boxes, no routes", () => {
    const empty: ModuleDef = { id: "new", name: "New", kind: "module", interfaces: [], children: [], links: [] } as unknown as ModuleDef;
    const vm = buildView(empty, () => undefined, [], { expanded: new Set() });
    expect(vm.nodes).toEqual([]);
    const layout = computeLayout(vm, undefined, {}, false);
    expect(layout.boxes).toEqual({});
    expect(layout.routes).toEqual({});
  });
});
