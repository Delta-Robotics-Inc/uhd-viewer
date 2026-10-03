/** Node icons and shapes from UHD taxonomy categories (PB-849). */
import type { ModuleDef } from "@uhd/types/index.js";
import { describe, expect, it } from "vitest";
import { buildView } from "../src/model/from-uhd";

const part = (id: string, name: string, categories: string[], tags: string[] = []): ModuleDef => ({ id, name, kind: "module", categories, tags, interfaces: [] });
const parts = [
  part("esc", "AM32 60A 4-in-1 ESC", ["actuator.motor_controller", "robotics.drone"], ["esc"]),
  part("motor", "2207 brushless motor", ["actuator.motor.brushless", "robotics.drone"]),
  part("prop", "5-inch tri-blade", ["mechanical.propeller"]),
  part("strap", "Kevlar battery strap", ["mechanical.mounting", "robotics.drone"], ["battery strap"]),
  part("fc", "F405 board", ["microcontroller.flight_controller"]),
];
const root: ModuleDef = { id: "root", name: "Root", kind: "module", interfaces: [], children: parts.map((p) => ({ id: p.id, moduleDefId: p.id })) };
const lookup = (id: string) => parts.find((p) => p.id === id);

describe("icons and shapes from taxonomy categories", () => {
  it("files a motor controller apart from motors, by whole path segments", () => {
    const vm = buildView(root, lookup, [], { expanded: new Set() });
    const node = (id: string) => vm.nodes.find((n) => n.id === id)!;
    expect([node("esc").icon, node("esc").shape]).toEqual(["zap", "rect"]);
    expect([node("motor").icon, node("motor").shape]).toEqual(["rotate-cw", "circle"]);
    expect([node("prop").icon, node("prop").shape]).toEqual(["fan", "circle"]);
    expect(node("strap").icon).toBe("link");
    expect(node("fc").icon).toBe("cpu");
  });
});
