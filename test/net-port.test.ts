/**
 * UHD 0.3.0 net ports (`exports: [{ id, from: { self: true, interfaceId } }]`) and the board marker
 * (`kind: "board"`): the tolerant source keeps a net port, and the diagram draws a module that has one
 * at every level without a pass-through line to a child that is not there.
 */
import { describe, expect, it } from "vitest";
import type { ModuleDef } from "@uhd/types/index.js";
import { tolerantSystem } from "../src/source/tolerant";
import { buildView } from "../src/model/from-uhd";

const pin = (id: string, role: string, n: number) => ({ id, name: id, domain: "electrical", exposed: true, pin: n, protocols: [{ type: "power", roles: [role] }] });
const net = (id: string) => ({ id, name: id.toUpperCase(), domain: "electrical", exposed: false, protocols: [{ type: "net", roles: ["net"] }] });

const cap = { id: "cap", name: "Cap", interfaces: [pin("p1", "input", 1), pin("p2", "ground", 2)] } as unknown as ModuleDef;
const ldo = { id: "ldo", name: "LDO", interfaces: [pin("vout", "output", 1), pin("gnd", "ground", 2)] } as unknown as ModuleDef;
/** A sub-circuit that ports its own supply net. */
const stage = {
  id: "stage",
  name: "Stage",
  interfaces: [net("vdd")],
  children: [{ id: "c1", moduleDefId: "cap" }],
  exports: [{ id: "vdd", from: { self: true, interfaceId: "vdd" } }],
  links: [{ id: "vdd.c1.p1", a: { interfaceId: "vdd" }, b: { child: "c1", interfaceId: "p1" } }],
} as unknown as ModuleDef;
const board = {
  id: "board",
  name: "Board",
  kind: "board",
  interfaces: [net("v3")],
  children: [
    { id: "u1", moduleDefId: "ldo" },
    { id: "s1", moduleDefId: "stage" },
  ],
  links: [
    { id: "v3.u1.vout", a: { interfaceId: "v3" }, b: { child: "u1", interfaceId: "vout" } },
    { id: "v3.s1.vdd", a: { interfaceId: "v3" }, b: { child: "s1", interfaceId: "vdd" } },
  ],
} as unknown as ModuleDef;
const defs = new Map([board, stage, cap, ldo].map((d) => [d.id, d]));
const lookup = (id: string) => defs.get(id);

describe("net ports and the board marker (UHD 0.3.0)", () => {
  it("keeps a net port in the tolerant source", () => {
    const t = tolerantSystem(board, lookup);
    expect(t.leftOut).toEqual([]);
    expect(t.lookup("stage")!.exports).toEqual(stage.exports);
  });

  it("draws the board, its sub-circuit's port and the sub-circuit drilled into", () => {
    const top = buildView(board, lookup, [], { expanded: new Set() });
    const s1 = top.nodes.find((n) => n.id === "s1")!;
    expect(s1.ports.some((p) => p.id === "vdd" && !p.exported)).toBe(true);
    const inner = buildView(board, lookup, ["s1"], { expanded: new Set() });
    const sheet = inner.nodes.find((n) => n.id === "@vdd");
    expect(sheet?.sheetPort).toBe(true);
    expect(inner.links.some((l) => l.id.startsWith("@vdd->"))).toBe(false);
  });

  it("marks a node for a board-kind module", () => {
    const sys = { id: "sys", name: "Sys", interfaces: [], children: [{ id: "main", moduleDefId: "board" }] } as unknown as ModuleDef;
    const all = new Map([...defs, ["sys", sys]]);
    const vm = buildView(sys, (id) => all.get(id), [], { expanded: new Set() });
    expect(vm.nodes.find((n) => n.id === "main")!.kind).toBe("board");
  });
});
