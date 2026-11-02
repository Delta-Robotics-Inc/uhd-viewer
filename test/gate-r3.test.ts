/**
 * Wave R3 gate (2026-11-02): the gate's own fixes.
 * - `componentIn` finds a GPU-instanced component whose id list holds the view-model's objects (`{partInstanceId}`),
 *   with the list on the instanced mesh or on the node above it (R3-A's handoff; the cube root's framing of a board
 *   component, the R2 gate's first carry-forward).
 * - The player's `reach()`: the "nothing to explode" note is judged in the mode in force, not from a pose sampled
 *   while a mode change fades (the note showed while the drone was apart in Assemble).
 * - A board in the plan: the timeline names "along the board normal" and counts its components (not "radial · 194
 *   parts", the board itself included).
 */
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { componentIn } from "../src/cad/annot";
import { planBoard, withBoard, type BoardPartInput } from "../src/cad/assembly";
import { SequencePlayer, radialSummary, type ResolvedWithRadial } from "../src/cad/sequence/player";
import { chipText, headerText } from "../src/cad/timeline/model";

const part = (key: string, side: "top" | "bottom", height: number, x = 0): BoardPartInput => ({ key, side, height, box: [[x, 0, side === "top" ? 1.6 : -height], [x + 1, 1, side === "top" ? 1.6 + height : 0]] });
const empty: ResolvedWithRadial = { steps: [], parents: new Map(), joints: [], defaults: { durationS: 1.2, maxTurns: 3, unscrewShare: 0.45 }, source: "planner", unknown: [], windows: [] };

describe("componentIn with the view-model's instance objects", () => {
  const build = (onParent: boolean) => {
    const body = new THREE.Group();
    const node = new THREE.Group();
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), 3);
    for (let i = 0; i < 3; i++) mesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(i * 10, 0, 0));
    const list = [{ partInstanceId: "pcb/r1", refdes: "R1" }, { partInstanceId: "pcb/r2", refdes: "R2" }, "pcb/r3"];
    (onParent ? node : mesh).userData.protoboard = { instances: list };
    node.add(mesh);
    body.add(node);
    body.position.set(100, 0, 0);
    body.updateMatrixWorld(true);
    return body;
  };
  for (const onParent of [false, true]) {
    it(`finds an object entry and a string entry (list on the ${onParent ? "node" : "mesh"})`, () => {
      const body = build(onParent);
      const r2 = componentIn(body, "pcb/r2", "pcb/r2");
      expect(r2).toBeDefined();
      expect(r2!.box.getCenter(new THREE.Vector3()).x).toBeCloseTo(110, 5);
      const r3 = componentIn(body, "nope", "pcb/r3");
      expect(r3!.box.getCenter(new THREE.Vector3()).x).toBeCloseTo(120, 5);
      expect(componentIn(body, "pcb/r9", "pcb/r9")).toBeUndefined();
    });
  }
});

describe("reach: how far the parts come apart in the mode in force", () => {
  const parts = [part("power/r21", "top", 0.5), part("usb/usbc", "top", 3.2, 5)];
  const plan = planBoard(parts, [{ prefix: "power", title: "Power" }, { prefix: "usb", title: "USB" }], [0, 0, 1], 100);
  it("is the longest move in radial and in the steps, with a mode fade running", () => {
    const p = new SequencePlayer(withBoard(empty, plan, ""));
    let clock = 0;
    p.now = () => clock;
    expect(p.explodeMode).toBe("radial");
    const radial = p.reach();
    expect(radial).toBeGreaterThan(6);
    p.set({ t: 0.6 });
    // a mode change while apart fades from where the parts are: the pose stays put at first, the reach does not
    p.setMode("sequence");
    const before = p.pose();
    p.set({ t: 1 });
    const after = p.pose();
    expect(after.get("usb/usbc")![14]).toBeCloseTo(before.get("usb/usbc")![14], 6);
    expect(p.reach()).toBeCloseTo(radial, 6);
    clock = 10_000;
    expect(p.reach()).toBeCloseTo(radial, 6);
  });
  it("is 0 when nothing comes apart", () => {
    const p = new SequencePlayer(empty);
    expect(p.reach()).toBe(0);
  });
});

describe("the timeline names a board's explode along its normal", () => {
  const parts = [part("power/r21", "top", 0.5), part("usb/usbc", "top", 3.2, 5), part("power/j1", "bottom", 11, 9)];
  const plan = planBoard(parts, [{ prefix: "power", title: "Power" }, { prefix: "usb", title: "USB" }], [0, 0, 1], 100);
  it("counts the components that come off (the board stays) and says how", () => {
    const merged = withBoard({ ...empty, radial: { moves: new Map([["", { dir: [0, 0, 1], distance: 40, from: "up" }]]), centre: [0, 0, 0], radius: 50, ms: 1, parts: [], up: [0, 0, 1] } }, plan, "");
    expect(merged.radial!.board).toEqual({ holder: "", components: 3 });
    const sum = radialSummary(merged.radial!);
    expect(sum.parts).toBe(3);
    expect(sum.board).toEqual({ components: 3 });
    const h = headerText(undefined, { mode: "radial", t: 1, speed: 1, playing: false, radial: sum });
    expect(h.sub).toMatch(/^along the board normal · 3 components · [\d.]+ mm out · amount 1\.00$/);
    expect(chipText({ explodeMode: "radial", radial: sum, steps: [], source: "planner", joints: {} }, false)).toMatch(/^board normal · 3 components · /);
  });
  it("leaves a model without a board as before (radial, every move counted)", () => {
    const sum = radialSummary({ moves: new Map([["a", { dir: [1, 0, 0], distance: 10, from: "up" }], ["b", { dir: [0, 1, 0], distance: 0, from: "up" }]]), centre: [0, 0, 0], radius: 1, ms: 0 });
    expect(sum).toEqual({ parts: 2, distanceMm: 10, ms: 0, from: { up: 2 } });
    const h = headerText(undefined, { mode: "radial", t: 0.5, speed: 1, playing: false, radial: sum });
    expect(h.sub).toBe("radial · 2 parts · 5 mm out · amount 0.50");
  });
});

describe("the tooltip says a designator once", () => {
  it("drops the refdes before a name that starts with it", async () => {
    const { shortTip } = await import("../src/cad/nav/target");
    expect(shortTip({ key: "power/power_in/c25", findings: 0, open: "frame", refdes: "C25", name: "C25 100 uF electrolytic, 12VIN bulk" })).toBe("C25 100 uF electrolytic, 12VIN bulk");
    expect(shortTip({ key: "controller/usb/usbc", findings: 0, open: "frame", refdes: "USBC", name: "USB-C 16-pin receptacle" })).toBe("USBC USB-C 16-pin receptacle");
    expect(shortTip({ key: "a/c250", findings: 0, open: "frame", refdes: "C25", name: "C250 other" })).toBe("C25 C250 other");
  });
});
