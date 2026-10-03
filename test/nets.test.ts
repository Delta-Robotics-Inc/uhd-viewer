import { describe, expect, it } from "vitest";
import { buildView } from "../src/model/from-uhd";
import { pinsLabel } from "../src/model/nets";
import { rebase, systemDiagnostics } from "../src/model/diagnostics";
import { IMU_BOARD, lookupBoardModule } from "../../uhd/test/fixtures/imu-board";
import { buildFixtures, sdaOnInterrupt } from "../fixtures/src/imu-pod";

const view = (root = IMU_BOARD, drill: string[] = [], grounds = false, lookup = lookupBoardModule) =>
  buildView(root, lookup, drill, { expanded: new Set(), diagnostics: systemDiagnostics(root, lookup), grounds });

describe("board nets in the diagram", () => {
  it("draws each net as a junction node, ground nets only with GND wires on", () => {
    const vm = view();
    const nets = vm.nodes.filter((n) => n.kind === "net").map((n) => n.id);
    expect(nets).toEqual([":vin", ":v3v3", ":v1v1", ":fb", ":sw1", ":sw2", ":sda", ":scl", ":imu_int1"]);
    expect(view(IMU_BOARD, [], true).nodes.some((n) => n.id === ":gnd")).toBe(true);
    const v3v3 = vm.nodes.find((n) => n.id === ":v3v3")!;
    expect(v3v3.net).toMatchObject({ name: "3V3", signal: "power", voltage: "3.3 V", ground: false, pins: 17 });
    // one port per component on the net, not per pin
    expect(v3v3.ports.map((p) => p.id)).toEqual(["u3", "r1", "u1", "u2", "r3", "r4"]);
  });

  it("groups membership links: one line per component and net, its pins as children", () => {
    const vm = view();
    expect(vm.links.some((l) => l.id === "v3v3.u1.pin_1")).toBe(false);
    const u1 = vm.links.find((l) => l.id === "v3v3.u1")!;
    expect(u1.source).toEqual({ node: "u1", port: "net:v3v3" });
    expect(u1.target).toEqual({ node: ":v3v3", port: "u1" });
    expect(u1.children.map((c) => c.aPin)).toEqual(["1", "10", "22", "33", "42", "49", "43", "44", "48"]);
    expect(u1.alsoIds).toContain("v3v3.u1.pin_49");
    expect(u1.lanes).toHaveLength(9);
    expect(u1.name).toBe("IOVDD +3");
    // the component's port for the net carries the same pins, with designators
    const port = vm.nodes.find((n) => n.id === "u1")!.ports.find((p) => p.id === "net:v3v3")!;
    expect(port.children.map((c) => c.pin)).toEqual(["1", "10", "22", "33", "42", "49", "43", "44", "48"]);
    // a ground net's lines are ground symbols at the pins
    expect(vm.links.find((l) => l.id === "gnd.u2")).toMatchObject({ ground: true, net: { id: "gnd", name: "GND" } });
  });

  it("names the links derived over nets and lets the lines they run over carry them", () => {
    const vm = view();
    const i2c = vm.derived.find((d) => d.protocol === "i2c")!;
    expect(i2c.name).toBe("I2C 0 ↔ Primary I2C (target)");
    expect(i2c.id.length).toBeGreaterThan(40); // the id names every membership it runs over
    expect(i2c.a.node).toBe("u1");
    expect(i2c.b.node).toBe("u2");
    expect(i2c.nets.sort()).toEqual([":scl", ":sda"]);
    expect(i2c.via.sort()).toEqual(["scl.u1", "scl.u2", "sda.u1", "sda.u2"]);
    expect(i2c.state).toBe("configured");
  });

  it("shows bus_incomplete on the lines of the incomplete bus, like harness_wiring on a cable", () => {
    const vm = view(sdaOnInterrupt(IMU_BOARD));
    const i2c = vm.derived.find((d) => d.protocol === "i2c")!;
    expect(i2c.state).toBe("incompatible");
    expect(i2c.diagnostics.join(" ")).toMatch(/i2c sda: .* not wired to each other/);
    for (const id of i2c.via) {
      const line = vm.links.find((l) => l.id === id)!;
      expect(line.state).toBe("incompatible");
      expect(line.diagnostics.some((m) => /not wired to each other/.test(m))).toBe(true);
    }
    // the pins of both ends are marked wherever they landed: the MCU's SDA, and the IMU's SDx on the INT1 net
    expect(i2c.via.sort()).toEqual(["imu_int1.u2", "scl.u1", "scl.u2", "sda.u1"]);
    // lines the bus does not run over keep their own state
    expect(vm.links.find((l) => l.id === "v1v1.u1")!.state).toBe("configured");
  });

  it("labels grouped lines by pin name", () => {
    expect(pinsLabel(["SDx"])).toBe("SDx");
    expect(pinsLabel(["VDD", "VDDIO"])).toBe("VDD/VDDIO");
    expect(pinsLabel(["IOVDD", "IOVDD", "ADC_AVDD", "VREG_VIN"])).toBe("IOVDD +2");
  });
});

describe("boards inside a system", () => {
  const fx = buildFixtures();
  const lookup = (id: string) => fx.definitions.find((d) => d.id === id);

  it("checks each board on its own and re-bases its findings onto the root", () => {
    expect(rebase("link:sda.u1.pin_2", "board")).toBe("link:board/sda.u1.pin_2");
    expect(rebase("u2:pin_14", "board")).toBe("board/u2:pin_14");
    expect(rebase(":sda", "board")).toBe("board:sda");
    const broken = { ...fx.pod };
    const lookupBroken = (id: string) => (id === fx.board.id ? sdaOnInterrupt(fx.board) : lookup(id));
    const found = systemDiagnostics(broken, lookupBroken).filter((d) => d.scope === "board" && d.severity === "error");
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((d) => d.refs.every((r) => r.startsWith("link:board/") || r.startsWith("board")))).toBe(true);
  });

  it("drills into a board like any module, with its nets and its edge", () => {
    const top = view(fx.pod, [], false, lookup);
    expect(top.nodes.find((n) => n.id === "board")).toMatchObject({ childCount: 8, kind: "module" });
    const vm = view(fx.pod, ["board"], false, lookup);
    expect(vm.path.map((p) => p.label)).toEqual(["IMU pod (sample)", "IMU board"]);
    expect(vm.nodes.filter((n) => n.sheetPort).map((n) => n.id)).toEqual(["@mount", "@power_in", "@power_gnd", "@swd"]);
    expect(vm.nodes.some((n) => n.id === ":sda")).toBe(true);
  });

  it("overlays a board's findings when that board is drilled into", () => {
    const lookupBroken = (id: string) => (id === fx.board.id ? sdaOnInterrupt(fx.board) : lookup(id));
    const diagnostics = systemDiagnostics(fx.pod, lookupBroken);
    const vm = buildView(fx.pod, lookupBroken, ["board"], { expanded: new Set(), diagnostics });
    const i2c = vm.derived.find((d) => d.protocol === "i2c")!;
    expect(i2c.diagnostics.some((m) => /^I2C 0 ↔ Primary I2C \(target\): incompatible/.test(m))).toBe(true);
  });
});
