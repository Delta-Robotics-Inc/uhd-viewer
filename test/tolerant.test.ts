import { describe, expect, it } from "vitest";
import type { ModuleDef } from "@uhd/types/index.js";
import type { UhdBundle } from "@uhd/types/bundle.js";
import { validateLinks } from "@uhd/system/index.js";
import { checkSystem } from "@uhd/system/checks.js";
import { isPlaceholder, tolerantSystem } from "../src/source/tolerant";
import { sourceFromBundle } from "../src/source/source";
import { buildView } from "../src/model/from-uhd";
import { systemDiagnostics } from "../src/model/diagnostics";
import { tapRails } from "../src/layout/taps";
import { computeLayout } from "../src/layout/layout";

const power = (id: string, role: string) => ({ id, name: id, domain: "electrical", exposed: true, protocols: [{ type: "power", roles: [role] }] });

const cell = { id: "cell", name: "Cell", interfaces: [power("out", "source")] } as unknown as ModuleDef;
/** A board whose connector and regulator were never fetched. */
const board = {
  id: "board",
  name: "Board",
  interfaces: [],
  children: [
    { id: "j1", moduleDefId: "usb-c-receptacle", name: "USB-C" },
    { id: "u1", moduleDefId: "regulator" },
    { id: "bt", moduleDefId: "cell" },
  ],
  exports: [
    { id: "usb", from: { child: "j1", interfaceId: "receptacle" } },
    { id: "nothing", from: { child: "gone", interfaceId: "x" } },
  ],
  links: [
    { id: "vbus", a: { child: "j1", interfaceId: "vbus" }, b: { child: "u1", interfaceId: "vin" } },
    { id: "bat", a: { child: "bt", interfaceId: "out" }, b: { child: "u1", interfaceId: "vbat" } },
    { id: "deep", a: { child: "bt", interfaceId: "out" }, b: { child: "u1", interfaceId: "pads", compose: { p1: "inner:pad" } } },
    { id: "typo", a: { child: "bt", interfaceId: "outt" }, b: { child: "u1", interfaceId: "vin" } },
  ],
} as unknown as ModuleDef;
const sys = {
  id: "sys",
  name: "System",
  interfaces: [],
  children: [{ id: "main", moduleDefId: "board" }],
  links: [],
} as unknown as ModuleDef;

const defs = new Map([sys, board, cell].map((d) => [d.id, d]));
const lookup = (id: string) => defs.get(id);

describe("a bundle that names what it does not hold", () => {
  it("is what UHD's resolvers throw on", () => {
    expect(() => validateLinks(board, lookup)).toThrow(/references unknown module "usb-c-receptacle"/);
  });

  it("gets placeholders with the interfaces the links and exports name", () => {
    const t = tolerantSystem(sys, lookup);
    expect(t.missing.map((m) => m.id).sort()).toEqual(["regulator", "usb-c-receptacle"]);
    expect(t.missing.find((m) => m.id === "usb-c-receptacle")!.usedBy).toEqual([{ parent: "board", child: "j1", name: "USB-C" }]);
    const j1 = t.lookup("usb-c-receptacle")!;
    expect(isPlaceholder(j1)).toBe(true);
    expect(j1.name).toBe("USB-C");
    expect(j1.interfaces.map((i) => i.id).sort()).toEqual(["receptacle", "vbus"]);
    expect(t.lookup("regulator")!.interfaces.map((i) => i.id).sort()).toEqual(["vbat", "vin"]);
    expect(isPlaceholder(t.lookup("cell"))).toBe(false);
    expect(isPlaceholder(undefined)).toBe(false);
  });

  it("leaves out only what still cannot be resolved, and says why", () => {
    const t = tolerantSystem(sys, lookup);
    const b = t.lookup("board")!;
    expect(b.links!.map((l) => l.id)).toEqual(["vbus", "bat"]);
    expect(b.exports!.map((e) => e.id)).toEqual(["usb"]);
    expect(t.leftOut.map((l) => `${l.kind}:${l.on}:${l.id}`).sort()).toEqual(["export:board:nothing", "link:board:deep", "link:board:typo"]);
    expect(t.leftOut.every((l) => l.why.length > 0)).toBe(true);
    // the definitions given are not changed
    expect(board.links).toHaveLength(4);
  });

  it("then resolves, checks, builds and lays out at every level", () => {
    const t = tolerantSystem(sys, lookup);
    expect(() => validateLinks(t.lookup("board")!, t.lookup)).not.toThrow();
    expect(() => checkSystem(t.root, t.lookup)).not.toThrow();
    const diagnostics = systemDiagnostics(t.root, t.lookup);
    for (const [drill, expanded] of [[[], []], [[], ["main"]], [["main"], []]] as [string[], string[]][]) {
      const vm = buildView(t.root, t.lookup, drill, { expanded: new Set(expanded), overrides: {}, diagnostics, grounds: false });
      expect(() => computeLayout(tapRails(vm), undefined, {}, false)).not.toThrow();
      if (drill.length) {
        expect(vm.nodes.filter((n) => n.missing).map((n) => n.id).sort()).toEqual(["j1", "u1"]);
        expect(vm.nodes.find((n) => n.id === "bt")!.missing).toBeUndefined();
        expect(vm.links.some((l) => l.linkId === "vbus")).toBe(true);
      }
    }
  });

  it("changes nothing in a bundle that holds everything", () => {
    const whole = { ...board, children: [{ id: "bt", moduleDefId: "cell" }], exports: [], links: [] } as ModuleDef;
    const all = new Map([whole, cell].map((d) => [d.id, d]));
    const t = tolerantSystem(whole, (id) => all.get(id));
    expect(t.root).toBe(whole);
    expect(t.lookup("cell")).toBe(cell);
    expect(t.missing).toEqual([]);
    expect(t.leftOut).toEqual([]);
  });

  it("does not follow a definition that holds itself for ever", () => {
    const loop = { id: "loop", name: "Loop", interfaces: [], children: [{ id: "again", moduleDefId: "loop" }] } as unknown as ModuleDef;
    expect(tolerantSystem(loop, (id) => (id === "loop" ? loop : undefined)).missing).toEqual([]);
  });

  it("is what a loaded source carries for each scenario", () => {
    const bundle = { schema: "uhd.bundle/v0", root: "sys", definitions: [sys, board, cell] } as unknown as UhdBundle;
    const s = sourceFromBundle(bundle, "http://x/b.json");
    expect(s.scenarios[0].missing).toHaveLength(2);
    expect(s.scenarios[0].leftOut).toHaveLength(3);
    expect(isPlaceholder(s.scenarios[0].lookup("regulator"))).toBe(true);
  });
});
