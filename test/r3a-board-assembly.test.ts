/**
 * R3-A (2026-11-02): a board opened on its own level is an assembly. Its GLB's component nodes are wrapped, its
 * GPU instances become meshes of their own (sharing geometry), each lands where it was drawn; components come off
 * along the board's normal (top side up, bottom side down), staggered by height tier; Assemble steps follow the UHD
 * groups; a component's double-click opens its own model, or nothing when it has none.
 */
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { ModuleDef } from "@uhd/types/index.js";
import { applyBoardPose, boardGroups, boardMoves, boardNormal, boardSteps, componentModel, componentTarget, countComponents, groupOf, liftDistances, liftGap, measureBoard, planBoard, shortName, sideOf, splitBoard, tierOf, windowsFor, withBoard, type BoardPartInput } from "../src/cad/assembly";
import { idsAt, instanceIdOf } from "../src/cad/render/ids";
import { SequencePlayer, type ResolvedWithRadial } from "../src/cad/sequence";
import { cadWrapper } from "../src/cad/scene";

const geo = (x: number, y: number, z: number) => new THREE.BoxGeometry(x, y, z);
const mat = () => new THREE.MeshStandardMaterial();
const near = (a: ArrayLike<number>, b: ArrayLike<number>, d = 5) => Array.from(b).forEach((x, i) => expect(a[i]).toBeCloseTo(x, d));

/**
 * A board as the view-model writes it, in glTF space (metres, Y up): a 100 x 1.6 x 80 mm sheet (`""`), a module on
 * top (one node), three resistors instanced (two named, one test pad the export could not match), a connector under
 * the board. The root node turns it as EasyEDA's export does (-90 degrees about X).
 */
function board() {
  const top = new THREE.Group();
  top.name = "EasyEDA_PCB_Model";
  top.rotation.x = -Math.PI / 2; // the source frame (Z up) in glTF (Y up)
  top.userData.protoboard = { partInstanceId: "", partKind: "board" };
  // in the root node's own frame (the source's: Z up, metres): the sheet from z 0 to 1.6 mm
  const sheet = new THREE.Mesh(geo(0.1, 0.08, 0.0016), mat());
  sheet.position.set(0.05, 0.04, 0.0008);
  sheet.userData.protoboard = { partInstanceId: "" };
  top.add(sheet);
  const esp = new THREE.Mesh(geo(0.018, 0.025, 0.0031), mat());
  esp.name = "ESP32-S3~WIRELM";
  esp.position.set(0.07, 0.06, 0.0016 + 0.00155);
  esp.userData.protoboard = { partInstanceId: "controller/mcu/esp32_s3", refdes: "ESP32-S3", definition: "espressif-esp32-s3" };
  top.add(esp);
  const r = new THREE.InstancedMesh(geo(0.0016, 0.0008, 0.0005), mat(), 3);
  r.name = "uniroyal-0603waf";
  const spots: [number, number, number][] = [
    [0.01, 0.01, 0.0016 + 0.00025],
    [0.02, 0.01, 0.0016 + 0.00025],
    [0.03, 0.01, 0.0016 + 0.00025],
  ];
  spots.forEach((p, i) => r.setMatrixAt(i, new THREE.Matrix4().makeTranslation(...p)));
  r.userData.protoboard = { instanced: true, instances: [{ partInstanceId: "power/rail_5v_ext/r23", refdes: "R23" }, { partInstanceId: "", refdes: "5V_INT", unmatched: true }, { partInstanceId: "power/power_in/r21", refdes: "R21" }] };
  r.userData.protoboardFaces = "hash#6#0";
  top.add(r);
  const jack = new THREE.Mesh(geo(0.009, 0.014, 0.011), mat());
  jack.name = "12V_DCJ";
  jack.position.set(0.05, 0.075, -0.0055);
  jack.userData.protoboard = { partInstanceId: "power/power_in/n12v_dcj", refdes: "12V_DCJ" };
  top.add(jack);
  const scene = new THREE.Group();
  scene.add(top);
  return { scene, top, sheet, esp, r, jack, spots };
}

describe("splitting a board's GLB into components", () => {
  it("counts components by node ids and instance lists (objects or strings)", () => {
    const { top } = board();
    expect(countComponents(top)).toBe(4);
    expect(instanceIdOf({ partInstanceId: "a/b" })).toBe("a/b");
    expect(instanceIdOf("a/b")).toBe("a/b");
    expect(instanceIdOf({ partInstanceId: "" })).toBeUndefined();
    expect(instanceIdOf(3)).toBeUndefined();
  });

  it("leaves a body with fewer components than the minimum untouched", () => {
    const { top } = board();
    const before = top.children.length;
    expect(splitBoard(top, 99)).toBeUndefined();
    expect(top.children.length).toBe(before);
  });

  it("wraps placed components, de-instances instanced ones in place, keeps the sheets and unmatched pads as the board", () => {
    const { scene, top, sheet, esp, r, jack, spots } = board();
    scene.updateMatrixWorld(true);
    const wantR23 = new THREE.Vector3(...spots[0]).applyMatrix4(top.matrixWorld);
    const asm = splitBoard(top)!;
    expect(asm).toBeDefined();
    expect(asm.components.map((c) => c.id).sort()).toEqual(["controller/mcu/esp32_s3", "power/power_in/n12v_dcj", "power/power_in/r21", "power/rail_5v_ext/r23"]);
    expect(asm.stats).toMatchObject({ wrapped: 2, deinstanced: 3, instancedNodes: 1, unmatched: 1 });
    // the wrapper carries the id (pickers, glow and the annotation layer find it by name or partInstanceId)
    const w = asm.byId.get("controller/mcu/esp32_s3")!;
    expect(w.obj.name).toBe("controller/mcu/esp32_s3");
    expect(w.obj.children[0]).toBe(esp);
    expect(w.obj.userData.protoboard.partInstanceId).toBe("controller/mcu/esp32_s3");
    // the instanced node is gone; each instance is a plain mesh sharing its geometry and material
    expect(top.children.includes(r)).toBe(false);
    const r23 = asm.byId.get("power/rail_5v_ext/r23")!.obj.children[0] as THREE.Mesh;
    expect((r23 as THREE.InstancedMesh).isInstancedMesh).toBeFalsy();
    expect(r23.geometry).toBe(r.geometry);
    expect(r23.material).toBe(r.material);
    expect(r23.userData.protoboardFaces).toBe("hash#6#0");
    scene.updateMatrixWorld(true);
    near(new THREE.Vector3().setFromMatrixPosition(r23.matrixWorld).toArray(), wantR23.toArray());
    // the sheets and the unmatched pad are the board
    expect(asm.substrate).toContain(sheet);
    expect(asm.substrate.find((o) => o.name === "unmatched")?.children.length).toBe(1);
    expect(asm.byId.has("power/power_in/n12v_dcj")).toBe(true);
    expect(asm.byId.get("power/power_in/n12v_dcj")!.obj.children[0]).toBe(jack);
  });

  it("measures sides and heights in the CAD frame (mm, Z up) and finds the board normal", () => {
    const { scene, top } = board();
    const asm = splitBoard(top)!;
    const w = cadWrapper(scene);
    measureBoard(asm, w, top);
    near(asm.normal.toArray(), [0, 0, 1]);
    near(asm.substrateBox.min.toArray(), [0, 0, 0], 3);
    near(asm.substrateBox.max.toArray(), [100, 80, 1.6], 3);
    const esp = asm.byId.get("controller/mcu/esp32_s3")!;
    expect(esp.side).toBe("top");
    expect(esp.height).toBeCloseTo(3.1, 3);
    const r23 = asm.byId.get("power/rail_5v_ext/r23")!;
    expect(r23.side).toBe("top");
    expect(r23.height).toBeCloseTo(0.5, 3);
    const jack = asm.byId.get("power/power_in/n12v_dcj")!;
    expect(jack.side).toBe("bottom");
    expect(jack.height).toBeCloseTo(11, 3);
  });

  it("puts a component where a pose's translation (level mm) says, and back", () => {
    const { scene, top } = board();
    const asm = splitBoard(top)!;
    const w = cadWrapper(scene);
    measureBoard(asm, w, top);
    const body = new THREE.Group();
    body.add(w);
    body.updateMatrixWorld(true);
    const esp = asm.byId.get("controller/mcu/esp32_s3")!;
    const p0 = new THREE.Vector3().setFromMatrixPosition(esp.obj.children[0].matrixWorld);
    const delta = new THREE.Matrix4().makeTranslation(0, 0, 20).elements;
    applyBoardPose(asm, new Map([["controller/mcu/esp32_s3", delta]]), new THREE.Matrix4(), (c) => c.id);
    body.updateMatrixWorld(true);
    const p1 = new THREE.Vector3().setFromMatrixPosition(esp.obj.children[0].matrixWorld);
    near(p1.clone().sub(p0).toArray(), [0, 0, 20], 4);
    near(esp.travel.toArray(), [0, 0, 20]);
    // a body placed turned (a board on its side in the level): the level's delta is taken back into the body's frame
    const turned = new THREE.Matrix4().makeRotationY(Math.PI / 2);
    body.matrixAutoUpdate = false;
    body.matrix.copy(turned);
    applyBoardPose(asm, new Map([["controller/mcu/esp32_s3", new THREE.Matrix4().makeTranslation(15, 0, 0).elements]]), turned, (c) => c.id);
    body.updateMatrixWorld(true);
    const base = new THREE.Vector3().copy(p0).applyMatrix4(turned);
    near(new THREE.Vector3().setFromMatrixPosition(esp.obj.children[0].matrixWorld).sub(base).toArray(), [15, 0, 0], 4);
    applyBoardPose(asm, new Map(), turned, (c) => c.id);
    body.updateMatrixWorld(true);
    near(new THREE.Vector3().setFromMatrixPosition(esp.obj.children[0].matrixWorld).toArray(), base.toArray(), 4);
  });

  it("finds a board's normal along its thinnest axis, else up", () => {
    near(boardNormal(new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1.6, 100, 80))).toArray(), [1, 0, 0]);
    near(boardNormal(new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(30, 40, 50))).toArray(), [0, 0, 1]);
    const s = sideOf(new THREE.Box3(new THREE.Vector3(0, 0, -5), new THREE.Vector3(1, 1, 0)), new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 10, 1.6)), new THREE.Vector3(0, 0, 1));
    expect(s).toEqual({ side: "bottom", height: 5 });
  });

  it("a picked instance of a node whose ids are objects names its part (view-model extras)", () => {
    const im = new THREE.InstancedMesh(geo(1, 1, 1), mat(), 2);
    im.userData.protoboard = { instances: [{ partInstanceId: "a/r1" }, { partInstanceId: "a/r2" }] };
    expect(idsAt(im, undefined, undefined, 1).partInstanceId).toBe("a/r2");
  });
});

const part = (key: string, side: "top" | "bottom", height: number, x = 0): BoardPartInput => ({ key, side, height, box: [[x, 0, side === "top" ? 1.6 : -height], [x + 1, 1, side === "top" ? 1.6 + height : 0]] });

describe("how a board's components come apart", () => {
  it("tiers by height and lifts each tier past the tallest of the tiers below it", () => {
    expect([0.4, 1, 1.1, 2.5, 3, 7, 12].map((h) => tierOf(h))).toEqual([0, 0, 1, 1, 2, 3, 4]);
    expect(liftGap(100)).toBe(6);
    expect(liftGap(10)).toBe(2);
    expect(liftGap(50)).toBe(3);
    const parts = [part("r1", "top", 0.5), part("r2", "top", 0.8), part("u1", "top", 3.1), part("j1", "top", 9), part("c1", "bottom", 0.5), part("j2", "bottom", 11)];
    const d = liftDistances(parts, 4);
    expect(d.get("r1")).toBe(4);
    expect(d.get("r2")).toBe(4);
    // tier 2 (u1) lifts past tier 0's tallest (0.8) plus a gap; tier 3 (j1) past tier 2's (3.1) too
    expect(d.get("u1")).toBeCloseTo(4 + 0.8 + 4);
    expect(d.get("j1")).toBeCloseTo(4 + 0.8 + 4 + 3.1 + 4);
    // tall parts end clear of short ones: each tier's lowest face above every lower tier's highest face
    expect(d.get("u1")!).toBeGreaterThan(d.get("r2")! + 0.8);
    expect(d.get("j1")!).toBeGreaterThan(d.get("u1")! + 3.1);
    // the bottom side is tiered on its own
    expect(d.get("c1")).toBe(4);
    expect(d.get("j2")).toBeCloseTo(4 + 0.5 + 4);
  });

  it("top-side parts go along the board normal, bottom-side parts against it", () => {
    const m = boardMoves([part("u1", "top", 3), part("j2", "bottom", 11)], [0, 0, 2], 100);
    expect(m.get("u1")!.dir).toEqual([0, 0, 1]);
    expect(m.get("j2")!.dir).toEqual([-0, -0, -1]);
    expect(m.get("u1")!.from).toBe("sequence");
  });

  it("Assemble: one step per UHD group in the board's order, the section's own parts after its groups, the rest last", () => {
    const groups = [
      { prefix: "power/power_in", title: "Power input", section: "Power" },
      { prefix: "power", title: "Power", section: "Power" },
      { prefix: "controller/usb", title: "USB", section: "Controller" },
      { prefix: "controller", title: "Controller", section: "Controller" },
    ];
    expect(groupOf("power/power_in/r21", groups)?.prefix).toBe("power/power_in");
    expect(groupOf("power/c9", groups)?.prefix).toBe("power");
    expect(groupOf("misc/x", groups)).toBeUndefined();
    const parts = [part("controller/usb/usbc", "top", 3.2), part("power/power_in/r21", "top", 0.5), part("power/c9", "top", 0.5), part("misc/x", "top", 0.5)];
    const moves = boardMoves(parts, [0, 0, 1], 100);
    const steps = boardSteps(parts, groups, moves);
    expect(steps.map((s) => s.id)).toEqual(["board:power/power_in", "board:power", "board:controller/usb", "board:other"]);
    expect(steps[0].members[0]).toMatchObject({ ref: "power/power_in/r21", dir: [0, 0, 1], distance: 6 });
    expect(steps[0].callout).toBe("Power: 1 part");
    // exploding plays the last assembled step first
    const w = windowsFor(steps);
    expect(w[steps.length - 1][0]).toBe(0);
    expect(w[0][1]).toBe(1);
  });

  it("merged into the model's sequence: the board stays, every component comes off (Explode all at once; Assemble in steps)", () => {
    const parts = [part("power/power_in/r21", "top", 0.5), part("controller/usb/usbc", "top", 3.2), part("power/power_in/n12v_dcj", "bottom", 11)];
    const plan = planBoard(parts, [{ prefix: "power/power_in", title: "Power input" }, { prefix: "controller/usb", title: "USB" }], [0, 0, 1], 100);
    const generic: ResolvedWithRadial = {
      steps: [{ id: "place:", title: "Place the board", kind: "place", sequence: "main", depth: 0, members: [{ ref: "", dir: [0, 0, 1], distance: 30, pivot: [0, 0, 0], turns: 0, pitchMm: 0, delay: 0 }], durationS: 1.2, ease: "cubic", links: [], still: false, planned: true }],
      parents: new Map(),
      joints: [],
      defaults: { durationS: 1.2, maxTurns: 3, unscrewShare: 0.45 },
      source: "planner",
      unknown: [],
      windows: [[0, 1]],
      radial: { moves: new Map([["", { dir: [0, 0, 1], distance: 50, from: "up" }]]), centre: [50, 40, 1], radius: 60, ms: 1, parts: [{ key: "", centre: [50, 40, 1], facings: [] }], up: [0, 0, 1] },
    };
    const merged = withBoard(generic, plan, "");
    expect(merged.steps.map((s) => s.id)).toEqual(["board:power/power_in", "board:controller/usb"]);
    expect(merged.radial!.moves.get("")!.distance).toBe(0);
    const player = new SequencePlayer(merged);
    expect(player.explodeMode).toBe("radial");
    player.set({ t: 1 });
    const pose = player.pose();
    // the board stays put (no move, or a zero one)
    if (pose.has("")) near(pose.get("")!.slice(12, 15), [0, 0, 0]);
    expect(pose.get("power/power_in/r21")![14]).toBeCloseTo(6);
    expect(pose.get("controller/usb/usbc")![14]).toBeCloseTo(6 + 0.5 + 6);
    expect(pose.get("power/power_in/n12v_dcj")![14]).toBeCloseTo(-6);
    // half way, every part is moving at once (radial: one ease for all)
    player.set({ t: 0.5 });
    const half = player.pose();
    expect(half.get("power/power_in/r21")![14]).toBeGreaterThan(0);
    expect(half.get("controller/usb/usbc")![14]).toBeGreaterThan(0);
    // Assemble: the steps one after another (the last assembled, USB, comes off first)
    player.setMode("sequence", { instant: true });
    player.set({ t: 0.5 });
    const steps = player.pose();
    expect(steps.get("controller/usb/usbc")![14]).toBeCloseTo(6 + 0.5 + 6);
    expect(steps.has("power/power_in/r21")).toBe(false);
    // a scoped explode of one group moves only it (the board's overrides keep each part's own move)
    player.setMode("radial", { instant: true });
    player.setScope("controller", { instant: true });
    player.set({ t: 1 });
    const scoped = player.pose();
    expect(scoped.get("controller/usb/usbc")![14]).toBeCloseTo(6 + 0.5 + 6);
    expect(scoped.has("power/power_in/r21")).toBe(false);
  });
});

describe("the player for the assembly timeline (R3-B's handoffs, applied by R3-A)", () => {
  const parts = [part("power/power_in/r21", "top", 0.5), part("controller/usb/usbc", "top", 3.2)];
  const plan = planBoard(parts, [{ prefix: "power/power_in", title: "Power input" }, { prefix: "controller/usb", title: "USB" }], [0, 0, 1], 100);
  const empty: ResolvedWithRadial = { steps: [], parents: new Map(), joints: [], defaults: { durationS: 1.2, maxTurns: 3, unscrewShare: 0.45 }, source: "planner", unknown: [], windows: [] };
  it("a play with keep stays in the radial mode; without it, the steps", () => {
    const p = new SequencePlayer(withBoard(empty, plan, ""));
    expect(p.run({ action: "play", mode: "explode", keep: true }).ok).toBe(true);
    expect(p.explodeMode).toBe("radial");
    p.run({ action: "play", mode: "explode" });
    expect(p.explodeMode).toBe("sequence");
  });
  it("onChange fires after a command and after a tick that moved, not after an idle tick", () => {
    const p = new SequencePlayer(withBoard(empty, plan, ""));
    let n = 0;
    const off = p.onChange(() => n++);
    p.run({ action: "set", t: 0 });
    expect(n).toBe(1);
    p.run({ action: "play", mode: "explode", keep: true });
    const after = n;
    p.tick(0.1);
    expect(n).toBe(after + 1);
    p.tick(10);
    const done = n;
    p.tick(0.1);
    expect(n).toBe(done);
    off();
    p.run({ action: "set", t: 0 });
    expect(n).toBe(done);
  });
});

describe("a board's UHD groups and what a component opens", () => {
  const defs: Record<string, ModuleDef> = {
    board: { id: "board", name: "Board", interfaces: [], children: [{ id: "power", moduleDefId: "sec-power" }, { id: "controller", moduleDefId: "sec-ctl", name: "Controller (ESP32-S3)" }] } as unknown as ModuleDef,
    "sec-power": { id: "sec-power", name: "Power (12 V input, rails)", interfaces: [], children: [{ id: "power_in", moduleDefId: "grp-in" }, { id: "c9", moduleDefId: "cap" }] } as unknown as ModuleDef,
    "grp-in": { id: "grp-in", name: "Power input (12 V jack / terminal)", interfaces: [], children: [{ id: "r21", moduleDefId: "res" }] } as unknown as ModuleDef,
    "sec-ctl": { id: "sec-ctl", name: "Controller", interfaces: [], children: [{ id: "usb", moduleDefId: "grp-usb" }] } as unknown as ModuleDef,
    "grp-usb": { id: "grp-usb", name: "USB", interfaces: [], children: [{ id: "usbc", moduleDefId: "usbc" }] } as unknown as ModuleDef,
    cap: { id: "cap", name: "Cap", interfaces: [], artifacts: [{ id: "cad_step", name: "s", type: "cad", role: "body", format: "step", filePath: "artifacts/cad/c.step" }, { id: "cad_glb", name: "g", type: "cad", role: "body", format: "glb", filePath: "artifacts/cad/c.glb" }] } as unknown as ModuleDef,
    res: { id: "res", name: "Res", interfaces: [], artifacts: [{ id: "cad_step", name: "s", type: "cad", role: "body", format: "step", filePath: "parts/local/res/out/body.step" }] } as unknown as ModuleDef,
    usbc: { id: "usbc", name: "USB-C", interfaces: [], artifacts: [{ id: "art_spec", name: "spec", type: "datasheet", filePath: "parts/evidence/usbc.pdf" }] } as unknown as ModuleDef,
    adapter: { id: "adapter", name: "Adapter", interfaces: [], artifacts: [{ id: "resolved_glb", name: "Adapter (placeholder)", type: "3d_model", role: "body", format: "glb", filePath: ".protoboard/build/placeholders/adapter.glb" }] } as unknown as ModuleDef,
  };
  const lookup = (id: string) => defs[id];

  it("groups in the board's order, with short titles", () => {
    expect(shortName("Power input (12 V jack / terminal)", "x")).toBe("Power input");
    expect(boardGroups(defs.board, lookup)).toEqual([
      { prefix: "power/power_in", title: "Power input", section: "Power" },
      { prefix: "power", title: "Power", section: "Power" },
      { prefix: "controller/usb", title: "USB", section: "Controller" },
      { prefix: "controller", title: "Controller", section: "Controller" },
    ]);
    expect(boardGroups(defs.board, lookup, "pcb")[0].prefix).toBe("pcb/power/power_in");
  });

  it("a component opens its own model file (GLB first), none when it has only the board's shape or a placeholder", () => {
    expect(componentModel(defs.cap)?.id).toBe("cad_glb");
    expect(componentTarget(defs.cap, "power/c9")).toEqual({ model: { defId: "cap", artifactId: "cad_glb", path: "power/c9" } });
    expect(componentTarget(defs.res, "power/power_in/r21")).toEqual({ model: { defId: "res", artifactId: "cad_step", path: "power/power_in/r21" } });
    expect(componentTarget(defs.usbc, "controller/usb/usbc")).toBeUndefined();
    expect(componentTarget(defs.adapter, "x")).toBeUndefined();
    // a sub-assembly opens as a module
    expect(componentTarget(defs["grp-usb"], "controller/usb")).toEqual({ module: "controller/usb" });
  });
});
