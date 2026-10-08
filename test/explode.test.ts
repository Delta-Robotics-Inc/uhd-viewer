import { describe, expect, it } from "vitest";
import { boxGrid, clearance, exitOf, planStack, type StackPart } from "../src/cad/explode";

type Box = { u: [number, number]; v: [number, number]; z: [number, number] };

/** A part from boxes (z is the axis). */
function part(key: string, boxes: Box[]): StackPart {
  const outline: [number, number, number, number] = [
    Math.min(...boxes.map((b) => b.u[0])),
    Math.max(...boxes.map((b) => b.u[1])),
    Math.min(...boxes.map((b) => b.v[0])),
    Math.max(...boxes.map((b) => b.v[1])),
  ];
  const lo = Math.min(...boxes.map((b) => b.z[0]));
  const hi = Math.max(...boxes.map((b) => b.z[1]));
  return { key, lo, hi, mid: (lo + hi) / 2, outline, grid: boxGrid(outline, boxes, 24) };
}

const square = (r: number, z: [number, number]): Box => ({ u: [-r, r], v: [-r, r], z });
/** Four walls of a square tube from r - t to r, and an optional floor. */
const walls = (r: number, t: number, z: [number, number]): Box[] => [
  { u: [-r, -r + t], v: [-r, r], z },
  { u: [r - t, r], v: [-r, r], z },
  { u: [-r, r], v: [-r, -r + t], z },
  { u: [-r, r], v: [r - t, r], z },
];

/** Holders surround what lies well inside their outline. */
const surrounds = (holder: StackPart, p: StackPart) =>
  holder.outline[0] < p.outline[0] - 0.5 && holder.outline[1] > p.outline[1] + 0.5 && holder.outline[2] < p.outline[2] - 0.5 && holder.outline[3] > p.outline[3] + 0.5;

// a generic bottle with a screw cap: the cap's skirt reaches below the bottle's lip
const bottle = part("bottle", [square(40, [0, 2]), ...walls(40, 2, [0, 220]), ...walls(28, 3, [220, 250])]);
const lipSeal = part("lip_seal", walls(26, 3, [245, 250]));
// the skirt screws onto the neck; the electronics sit in the bay above the ceiling
const cap = part("cap", [...walls(32, 3, [230, 262]), square(32, [258, 262]), ...walls(42, 3, [262, 290]), square(42, [260, 262])]);
const cell = part("cell", [square(20, [263, 275])]);
const board = part("board", [square(35, [278, 280])]);
const lid = part("lid", [square(42, [290, 295])]);
const probe = part("probe", [square(3, [100, 270])]);

describe("exploded view by assembly order", () => {
  it("brings a held part out through the side its holder leaves open", () => {
    expect(exitOf(cap, cell)).toBe("up");
    // the seal sits under the cap's ceiling: it comes out below the cap
    expect(exitOf(cap, lipSeal)).toBe("down");
    expect(exitOf(bottle, probe)).toBe("up");
  });

  it("needs only the surface under a part to clear", () => {
    expect(clearance(cell, board)).toBeCloseTo(-3);
    // the cap's skirt (230) is below the bottle's lip (250)
    expect(clearance(bottle, cap)).toBeCloseTo(20);
    expect(clearance(lipSeal, probe)).toBeUndefined();
  });

  it("stacks the bottle in the order it goes together, not by lowest point", () => {
    const gap = 10;
    const rise = planStack([lid, board, cap, cell, probe, lipSeal, bottle], { gap, surrounds });
    const at = (p: StackPart) => ({ lo: p.lo + rise.get(p.key)!, hi: p.hi + rise.get(p.key)! });
    expect(rise.get("bottle")).toBe(0);
    const order = [bottle, lipSeal, probe, cap, cell, board, lid].map(at);
    // each part's exploded position is above the one before it, apart from the parts it was nested in
    expect(at(lipSeal).lo).toBeGreaterThanOrEqual(at(bottle).hi + gap - 1e-6);
    expect(at(probe).lo).toBeGreaterThanOrEqual(at(bottle).hi + gap - 1e-6);
    expect(at(cap).lo).toBeGreaterThanOrEqual(at(lipSeal).hi + gap - 1e-6);
    expect(at(cell).lo).toBeGreaterThanOrEqual(at(cap).hi + gap - 1e-6);
    expect(at(board).lo).toBeGreaterThan(at(cell).lo);
    expect(at(lid).lo).toBeGreaterThan(at(board).lo);
    // and in that order, bottom to top (the seal and the probe each sit on the bottle, side by side in the order)
    const mids = order.map((p) => (p.lo + p.hi) / 2);
    for (let i = 3; i < mids.length; i++) expect(mids[i], `part ${i}`).toBeGreaterThan(Math.max(...mids.slice(0, i)));
  });

  it("keeps separate columns apart: a motor lifts off its own arm only", () => {
    const frame = part("frame", [{ u: [-100, 100], v: [-5, 5], z: [0, 4] }, { u: [-5, 5], v: [-100, 100], z: [0, 4] }, square(20, [0, 30])]);
    const motorA = part("motor_a", [{ u: [85, 100], v: [-7, 7], z: [4, 20] }]);
    const motorB = part("motor_b", [{ u: [-100, -85], v: [-7, 7], z: [4, 20] }]);
    const rise = planStack([frame, motorA, motorB], { gap: 10, surrounds });
    expect(rise.get("frame")).toBe(0);
    // only the arm's 4 mm top is under it, not the 30 mm stack in the middle
    expect(rise.get("motor_a")).toBeCloseTo(10);
    expect(rise.get("motor_b")).toBeCloseTo(10);
  });

  it("leaves parts that lie over nothing where they are", () => {
    const a = part("a", [square(5, [0, 5])]);
    const b = part("b", [{ u: [50, 60], v: [0, 10], z: [0, 5] }]);
    const rise = planStack([a, b], { gap: 10 });
    expect([rise.get("a"), rise.get("b")]).toEqual([0, 0]);
  });
});

describe("a part through its holder", () => {
  it("comes out on the side it sticks out of further, and its seal follows it", () => {
    // a probe through a cap's floor gland: mostly below the floor, its cable end above it
    const housing = part("housing", [...walls(42, 3, [0, 40]), square(42, [10, 13])]);
    const stem = part("stem", [square(3, [-30, 20])]);
    const seal = part("seal", walls(5, 1.5, [8, 10]));
    const insideSurrounds = (holder: StackPart, p: StackPart) => holder.key === "stem" ? p.key === "seal" : surrounds(holder, p);
    expect(exitOf(housing, stem)).toBe("down");
    const rise = planStack([housing, stem, seal], { gap: 5, surrounds: insideSurrounds });
    expect(rise.get("stem")).toBe(0);
    expect(rise.get("seal")!).toBeGreaterThan(0);
    expect(rise.get("housing")!).toBeGreaterThan(rise.get("seal")!);
  });
});

describe("named bodies made as separate pieces", () => {
  const art = (id: string, file: string, format: string, from?: string) => ({ id, type: "file", format, filePath: `out/${file}`, ...(from ? { provenance: { generatedFrom: from } } : {}) });
  const def = (exports: string[]) =>
    ({
      id: "case",
      name: "Case",
      kind: "module",
      interfaces: [],
      artifacts: [art("cad_step", "body.step", "step"), art("cad_glb", "body.glb", "glb", "cad_step"), art("cad_manifest", "body.manifest.json", "json", "cad_step"), ...exports.map((f, i) => art(`x${i}`, f, f.split(".").pop()!, "cad_step"))],
    }) as unknown as import("@uhd/types/index.js").ModuleDef;
  const manifest = { bodies: { base: 40, lid: 15 }, features: {} } as unknown as import("@uhd/system/geometry.js").GeometryManifest;
  it("come apart when the module's exports make each body (an enclosure's base and lid)", async () => {
    const { explodeParts } = await import("../src/cad/model");
    const d = def(["base.stl", "lid.stl"]);
    expect(explodeParts(d, d.artifacts!.find((a) => a.id === "cad_glb"), manifest)).toEqual({ fixed: "base", moving: ["lid"] });
  });
  it("stay together when nothing makes them separately (a vendor part's bell and stator)", async () => {
    const { explodeParts } = await import("../src/cad/model");
    const d = def([]);
    expect(explodeParts(d, d.artifacts!.find((a) => a.id === "cad_glb"), manifest)).toBeUndefined();
  });
});
