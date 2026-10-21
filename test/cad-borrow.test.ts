/**
 * A module's 3D view when the module has no assembly of its own (PB-1040):
 * its parts are drawn where the nearest assembly above places them, cut down
 * to the module; with no placement anywhere, side by side, and the view says
 * they are unplaced. On a small drone: a frame, and a flight stack (a flight
 * controller and an ESC) that is mated to the frame only at the top level,
 * as on the quadcopter example.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { ModuleDef } from "@uhd/types/index.js";
import { defAt } from "../src/cad/model";
import { ancestorsOf, borrowModel, scopedModel, shownSummary } from "../src/cad/scope";
import { buildCadModel } from "../src/cad/model";
import { layOutRow } from "../src/cad/row";

const frame = (z: number) => ({ origin: [0, 0, z] as [number, number, number], normal: [0, 0, 1] as [number, number, number], xAxis: [1, 0, 0] as [number, number, number] });
const mount = (id: string, z: number) => ({ id, name: id, domain: "mechanical", protocols: [], exposed: true, geometry: { frame: frame(z) } });
const body = (id: string) => [{ id: `${id}_glb`, role: "body", format: "glb", filePath: `${id}.glb` }];

const DEFS = [
  { id: "drone", name: "Drone", interfaces: [], children: [{ id: "frame", moduleDefId: "frame" }, { id: "stack", moduleDefId: "stack" }, { id: "battery", moduleDefId: "battery" }], links: [
    { id: "fc_mount", a: { child: "stack", interfaceId: "fc_mount" }, b: { child: "frame", interfaceId: "fc_seat" } },
    { id: "esc_mount", a: { child: "stack", interfaceId: "esc_mount" }, b: { child: "frame", interfaceId: "esc_seat" } },
  ] },
  { id: "frame", name: "Frame", interfaces: [mount("fc_seat", 20), mount("esc_seat", 10)], artifacts: body("frame") },
  // the stack exports its parts' mounts; nothing inside it joins the two boards
  { id: "stack", name: "FC + ESC stack", interfaces: [], exports: [
    { id: "fc_mount", name: "FC mount", from: { child: "fc", interfaceId: "mount" } },
    { id: "esc_mount", name: "ESC mount", from: { child: "esc", interfaceId: "mount" } },
  ], children: [{ id: "fc", moduleDefId: "fc" }, { id: "esc", moduleDefId: "esc" }] },
  { id: "fc", name: "Flight controller", interfaces: [mount("mount", 0)], artifacts: body("fc") },
  { id: "esc", name: "ESC", interfaces: [mount("mount", 0)], artifacts: body("esc") },
  { id: "battery", name: "Battery", interfaces: [], artifacts: body("battery") },
] as unknown as ModuleDef[];

function bundle(defs: ModuleDef[]) {
  const map = new Map(defs.map((d) => [d.id, d]));
  return { lookup: (id: string) => map.get(id), root: map.get("drone")! };
}

describe("a module with no assembly of its own", () => {
  const { lookup, root } = bundle(DEFS);
  const stack = defAt(root, lookup, ["stack"])!;

  it("on its own, nothing places its parts: one part alone is not the module", () => {
    const own = buildCadModel(stack, lookup, new Map());
    const s = shownSummary(own, stack, lookup);
    expect(s.loose).toBe(true);
    expect(s.placed.length).toBeLessThanOrEqual(1);
  });

  it("lists its ancestors nearest first", () => {
    expect(ancestorsOf("a/b/c")).toEqual(["a/b", "a", ""]);
    expect(ancestorsOf("stack")).toEqual([""]);
    expect(ancestorsOf("")).toEqual([]);
  });

  it("shows its parts where the parent's assembly places them, and nothing else of the parent", () => {
    const m = scopedModel(root, lookup, new Map(), {}, "stack");
    expect(m.placedBy).toEqual({ kind: "ancestor", from: "" });
    expect(m.bodies.map((b) => b.key).sort()).toEqual(["esc", "fc"]);
    // where the frame's seats put them: the FC 10 mm above the ESC
    const z = (k: string) => (m.bodies.find((b) => b.key === k)!.matrix as unknown as number[])[11];
    expect(z("fc")).toBeCloseTo(20);
    expect(z("esc")).toBeCloseTo(10);
    // the mates that place them are the parent's, to the frame: not the module's
    expect(m.assembly.mates).toEqual([]);
    const s = shownSummary(m, stack, lookup);
    expect(s.loose).toBe(false);
    expect(s.unplaced).toEqual([]);
    expect(s.inRow).toEqual([]);
    expect(s.placed.map((p) => p.id).sort()).toEqual(["esc", "fc"]);
  });

  it("cuts a model down to a module and keys it from there", () => {
    const whole = buildCadModel(root, lookup, new Map(), [], ["frame"]);
    const cut = borrowModel(whole, ["stack"], "");
    expect(cut.bodies.every((b) => b.path.length === 1)).toBe(true);
    expect([...cut.defs.keys()].sort()).toEqual(["esc", "fc"]);
    expect(cut.assembly.instances.map((i) => i.path.join("/")).sort()).toEqual(["esc", "fc"]);
  });

  it("with no placement anywhere, shows its models side by side and says they are unplaced", () => {
    // the same drone without the mounts: nothing places the stack's parts at any level
    const bare = DEFS.map((d) => (d.id === "drone" ? { ...d, links: [] } : d)) as ModuleDef[];
    const b = bundle(bare);
    const m = scopedModel(b.root, b.lookup, new Map(), {}, "stack");
    expect(m.placedBy?.kind).toBe("row");
    const s = shownSummary(m, defAt(b.root, b.lookup, ["stack"])!, b.lookup);
    // every part that has a model is drawn: none left out
    expect(s.unplaced).toEqual([]);
    expect(s.placed.length).toBe(2);
    expect(s.loose).toBe(false);
    // one of them is the assembly's root (at the origin); the other is beside it, unplaced
    expect(s.inRow.length).toBeGreaterThanOrEqual(1);
  });

  it("keeps a module's own assembly when it has one", () => {
    // the stack with its own standoff mate between the boards
    const own = DEFS.map((d) =>
      d.id === "stack" ? { ...d, links: [{ id: "standoffs", a: { child: "fc", interfaceId: "mount" }, b: { child: "esc", interfaceId: "mount" } }] } : d,
    ) as ModuleDef[];
    const b = bundle(own);
    const m = scopedModel(b.root, b.lookup, new Map(), {}, "stack");
    expect(m.placedBy).toBeUndefined();
    expect(m.bodies.map((x) => x.key).sort()).toEqual(["esc", "fc"]);
  });

  it("the root's view is its own assembly, as before", () => {
    const m = scopedModel(root, lookup, new Map(), { root: "frame" }, "");
    expect(m.placedBy).toBeUndefined();
    expect(m.bodies.some((x) => x.row)).toBe(false);
  });
});

describe("the row of unplaced models", () => {
  const rec = (row: boolean, min: [number, number, number], max: [number, number, number]) => ({
    body: { row },
    base: new THREE.Matrix4(),
    obj: new THREE.Group(),
    box: new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max)),
  });

  it("lays them out along x after what is placed, without overlapping", () => {
    const placed = rec(false, [0, 0, 0], [40, 40, 5]);
    const a = rec(true, [-10, -10, -2], [10, 10, 2]);
    const b = rec(true, [0, 0, 0], [30, 5, 5]);
    layOutRow([placed, a, b]);
    const world = (r: typeof a) => r.box.clone().applyMatrix4(r.base);
    const wa = world(a);
    const wb = world(b);
    expect(wa.min.x).toBeGreaterThan(40);
    expect(wb.min.x).toBeGreaterThan(wa.max.x);
    // resting where the placed ones rest, centred on them across
    expect(wa.min.z).toBeCloseTo(0);
    expect(wa.getCenter(new THREE.Vector3()).y).toBeCloseTo(20);
    expect(placed.base.equals(new THREE.Matrix4())).toBe(true);
  });

  it("starts at the origin when nothing is placed", () => {
    const a = rec(true, [5, 5, 5], [15, 15, 15]);
    layOutRow([a]);
    expect(a.box.clone().applyMatrix4(a.base).min.x).toBeCloseTo(0);
  });
});
