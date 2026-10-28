/** A level is empty when it holds no modules, whatever ports and junctions it draws (model/level.ts). */
import { describe, expect, it } from "vitest";
import type { ModuleDef } from "@uhd/types/index.js";
import { buildView } from "../src/model/from-uhd";
import { levelModules } from "../src/model/level";
import bundle from "../fixtures/imu-pod/uhd-bundle.json";

const defs = new Map((bundle.definitions as unknown as ModuleDef[]).map((d) => [d.id, d]));
const root = defs.get(bundle.root)!;

describe("the modules of a level", () => {
  it("counts the modules on a level with modules", () => {
    const vm = buildView(root, (id) => defs.get(id), [], { expanded: new Set() });
    expect(levelModules(vm.nodes).length).toBe((root.children ?? []).length);
  });

  it("finds none in a module that has interfaces and no modules, though its ports are drawn", () => {
    // a part: interfaces of its own, no modules (its ports point at none of them)
    const withPorts = [...defs.values()].find((d) => (d.interfaces ?? []).length > 0 && !(d.children ?? []).length)!;
    const empty: ModuleDef = { ...withPorts, id: "empty-pod", children: [], links: [] };
    const outer: ModuleDef = { ...root, id: "outer", interfaces: [], children: [{ id: "pod", moduleDefId: "empty-pod" }], links: [] } as ModuleDef;
    const lookup = (id: string) => (id === "empty-pod" ? empty : defs.get(id));
    const vm = buildView(outer, lookup, ["pod"], { expanded: new Set() });
    expect((empty.interfaces ?? []).length).toBeGreaterThan(0);
    expect(vm.nodes.some((n) => n.sheetPort)).toBe(true);
    expect(levelModules(vm.nodes)).toEqual([]);
  });
});
