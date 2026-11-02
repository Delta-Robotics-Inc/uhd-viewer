/**
 * R1-A (2026-11-01 walkthrough fixes): selection and highlight painting (A1, A2, M5), the selection the host hears
 * (M2), the camera across hot swaps (M1), the explode envelope (M11), "Look along normal" (E3) and zoom to the
 * pointer (E1).
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { focusSelection, freshFocus, glowPlan, holderOfPath } from "../src/cad/state/view";
import { paintComponent, swapMaterial } from "../src/cad/render/glow";
import { DEFAULT_ZOOM_TO_CURSOR, EXPLODE_STILL_MM, HIGHLIGHT_GLOW, REFIT_RATIO, cameraBetween, dominantNormal, explodeCamera, focusMaterial, lookAlong, needsRefit, sceneColors, triangleNormal } from "../src/cad/scene";
import { fromUrlParams } from "../src/cad/state/serialize";
import { cadHostSelection, selectionKey } from "../src/host/targets";

const box = (min: [number, number, number], max: [number, number, number]) => new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max));

describe("what glows (A1, A2, M5)", () => {
  const bodies = ["pcb", "shell", "stack/fc", "stack/esc"];
  const within = new Map([["pcb/controller/usb/usbc", "pcb"]]);

  it("a picked component lights itself, never its holder board (A2)", () => {
    const plan = glowPlan({ bodies, selection: { body: "pcb", component: "pcb/power/c25" }, highlight: [], within });
    expect([...plan.selected]).toEqual([]);
    expect(plan.component).toEqual({ holder: "pcb", path: "pcb/power/c25" });
  });

  it("a body picked on its own, or an assembly drawn by its parts, is selected", () => {
    expect([...glowPlan({ bodies, selection: { body: "shell" }, highlight: [] }).selected]).toEqual(["shell"]);
    expect([...glowPlan({ bodies, selection: { body: "stack" }, highlight: [] }).selected].sort()).toEqual(["stack/esc", "stack/fc"]);
    expect([...glowPlan({ bodies, selection: {}, highlight: [] }).selected]).toEqual([]);
  });

  it("a highlight below a body names a component inside it (A1)", () => {
    const plan = glowPlan({ bodies, selection: {}, highlight: ["pcb/controller/usb/usbc"], within });
    expect([...plan.highlighted]).toEqual([]);
    expect(plan.components).toEqual([{ holder: "pcb", path: "pcb/controller/usb/usbc" }]);
    // not listed in `within`: the nearest body above it holds it
    expect(glowPlan({ bodies, selection: {}, highlight: ["pcb/sensors/u7"] }).components).toEqual([{ holder: "pcb", path: "pcb/sensors/u7" }]);
  });

  it("a highlight on a body or an assembly glows those bodies; the selection wins", () => {
    const plan = glowPlan({ bodies, selection: { body: "shell" }, highlight: ["shell", "stack"] });
    expect([...plan.highlighted].sort()).toEqual(["stack/esc", "stack/fc"]);
    expect([...plan.selected]).toEqual(["shell"]);
    // the selected component is not also drawn as a highlight
    expect(glowPlan({ bodies, selection: { body: "pcb", component: "pcb/u1" }, highlight: ["pcb/u1"] }).components).toEqual([]);
    // a path nothing draws lights nothing
    expect(glowPlan({ bodies, selection: {}, highlight: ["nowhere/u1"] }).components).toEqual([]);
  });

  it("harnesses: highlighted unless selected", () => {
    const plan = glowPlan({ bodies, harnesses: ["wire_a", "wire_b"], selection: { harness: "wire_a" }, highlight: ["wire_a", "wire_b"] });
    expect([...plan.harnesses]).toEqual(["wire_b"]);
  });

  it("artifact bodies (`path#artifact`) hold their path's components", () => {
    expect(holderOfPath("board/u2", ["board#board_glb", "frame"])).toBe("board#board_glb");
    expect(holderOfPath("board", ["board#board_glb"])).toBeUndefined();
  });
});

describe("a host's focus (A2)", () => {
  const bodies = ["drone", "drone/stack/fc", "drone/stack/esc", "pcb"];
  it("selects the body, a component in its holder, or an assembly by its parts (before any body above it)", () => {
    expect(focusSelection("pcb", bodies)).toEqual({ body: "pcb" });
    expect(focusSelection("pcb/usb/usbc", bodies, new Map([["pcb/usb/usbc", "pcb"]]))).toEqual({ body: "pcb", component: "pcb/usb/usbc" });
    // not in the model's map: still the component inside the body above it, never that body alone
    expect(focusSelection("pcb/fuse/fh1", bodies)).toEqual({ body: "pcb", component: "pcb/fuse/fh1" });
    expect(focusSelection("drone/stack", bodies)).toEqual({ body: "drone/stack" });
    expect(focusSelection("elsewhere", bodies)).toBeUndefined();
  });
  it("is applied once per page: a remount does not select again what the person cleared", () => {
    const f = { path: "pcb/usb/usbc", seq: 4 };
    expect(freshFocus(f)).toBe(true);
    expect(freshFocus(f)).toBe(false);
    expect(freshFocus({ ...f })).toBe(true);
  });
});

describe("painting a component (A1, M5)", () => {
  const colors = sceneColors({ accent: "#f97316", highlight: "#22d3ee" });
  const board = () => {
    const obj = new THREE.Group();
    const base = new THREE.MeshStandardMaterial({ color: 0x111111 });
    const sub = new THREE.MeshStandardMaterial({ color: 0x222222 });
    const usb = new THREE.Group();
    usb.name = "usbc";
    usb.userData.protoboard = { partInstanceId: "controller/usb/usbc" };
    const m1 = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), sub);
    usb.add(m1);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 1), base);
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), base, 2);
    inst.userData.protoboard = { instances: ["controller/sop/u3", "controller/sop/u4"] };
    obj.add(plate, usb, inst);
    return { rec: { obj, body: { key: "pcb" } }, m1, plate, inst, sub };
  };

  it("select: the accent surface on the component's meshes only, undone by restore", () => {
    const { rec, m1, plate, sub } = board();
    const restore: (() => void)[] = [];
    expect(paintComponent(rec, "pcb/controller/usb/usbc", "select", colors, restore)).toBe(true);
    expect(m1.material).toBe(focusMaterial(colors.focus));
    expect(plate.material).not.toBe(focusMaterial(colors.focus));
    for (let i = restore.length - 1; i >= 0; i--) restore[i]();
    expect(m1.material).toBe(sub);
  });

  it("highlight: the glow (emissive) on the component, and a sub-module path lights what lies under it", () => {
    const { rec, m1 } = board();
    const restore: (() => void)[] = [];
    expect(paintComponent(rec, "pcb/controller/usb", "highlight", colors, restore)).toBe(true);
    expect((m1.material as THREE.MeshStandardMaterial).emissive.getHex()).toBe(colors.glowStrong);
    for (let i = restore.length - 1; i >= 0; i--) restore[i]();
    expect((m1.material as THREE.MeshStandardMaterial).emissive.getHex()).toBe(0);
  });

  it("an instance of a GPU-instanced node gets a twin over it, removed by restore", () => {
    const { rec, inst } = board();
    const restore: (() => void)[] = [];
    const before = rec.obj.children.length;
    expect(paintComponent(rec, "pcb/controller/sop/u4", "highlight", colors, restore)).toBe(true);
    expect(rec.obj.children.length).toBe(before + 1);
    const twin = rec.obj.children[rec.obj.children.length - 1] as THREE.Mesh;
    expect(twin.geometry).toBe(inst.geometry);
    expect((twin.material as THREE.MeshStandardMaterial).polygonOffset).toBe(true);
    restore.forEach((f) => f());
    expect(rec.obj.children.length).toBe(before);
    expect(paintComponent(rec, "pcb/nothing", "select", colors, [])).toBe(false);
  });

  it("swapMaterial leaves a material that changed meanwhile alone", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    const was = mesh.material;
    const restore: (() => void)[] = [];
    swapMaterial(mesh, focusMaterial(colors.focus), restore);
    const other = new THREE.MeshBasicMaterial();
    mesh.material = other;
    restore[0]();
    expect(mesh.material).toBe(other);
    expect(was).not.toBe(other);
  });

  it("the highlight glow is strong enough to see (DEFAULT 0.5 of the accent), the selection the accent itself", () => {
    expect(HIGHLIGHT_GLOW).toBe(0.5);
    expect(colors.focus).toBe(new THREE.Color("#f97316").getHex());
    expect(colors.glowStrong).toBe(new THREE.Color("#f97316").multiplyScalar(0.5).getHex());
  });
});

describe("the selection the host hears (M2)", () => {
  const defs: Record<string, string> = { pcb: "mainboard", "pcb/power/c25": "cap-100u" };
  const defAt = (p: string[]) => (defs[p.join("/")] ? ({ id: defs[p.join("/")] } as never) : undefined);
  it("carries the component and its holder; id and defId as before", () => {
    const s = cadHostSelection({ body: "pcb", component: "pcb/power/c25" }, defAt);
    expect(s).toEqual({ kind: "node", id: "pcb/power/c25", defId: "cap-100u", component: "pcb/power/c25", holder: "pcb", holderDefId: "mainboard" });
    expect(cadHostSelection({ body: "pcb" }, defAt)).toEqual({ kind: "node", id: "pcb", defId: "mainboard" });
    // the holder is part of what the host hears as a change
    expect(selectionKey(s)).toContain("|pcb");
  });
});

describe("the camera across hot swaps (M1)", () => {
  const b = box([0, 0, 0], [100, 100, 10]);
  it("a first load fits; a placed camera is kept unless the size changes by more than 2x (DEFAULT)", () => {
    expect(REFIT_RATIO).toBe(2);
    expect(needsRefit(undefined, b, false)).toBe(true);
    expect(needsRefit(undefined, b, true)).toBe(false);
    expect(needsRefit(b, box([0, 0, 0], [110, 100, 12]), true)).toBe(false);
    expect(needsRefit(b, box([0, 0, 0], [300, 300, 30]), true)).toBe(true);
    expect(needsRefit(b, box([0, 0, 0], [30, 30, 3]), true)).toBe(true);
    expect(needsRefit(b, new THREE.Box3(), true)).toBe(false);
  });
});

describe("the explode envelope (M11)", () => {
  const position = new THREE.Vector3(0, -200, 100);
  const target = new THREE.Vector3(0, 0, 0);
  const a = box([-50, -50, 0], [50, 50, 10]);
  it("nothing moves: the camera stays", () => {
    expect(EXPLODE_STILL_MM).toBe(0.5);
    expect(explodeCamera({ from: a, to: a, moved: 0, position, target })).toBeNull();
    expect(explodeCamera({ from: a, to: a, moved: 0.1, position, target })).toBeNull();
  });
  it("parts move: the view scales with the envelope, keeping its direction (not a fresh fit)", () => {
    const to = box([-50, -50, 0], [50, 50, 110]);
    const r = explodeCamera({ from: a, to, moved: 100, position, target })!;
    const k = to.getBoundingSphere(new THREE.Sphere()).radius / a.getBoundingSphere(new THREE.Sphere()).radius;
    expect(r.target.toArray()).toEqual([0, 0, 50]);
    expect(r.position.clone().sub(r.target).length()).toBeCloseTo(position.length() * k, 6);
    expect(r.position.clone().sub(r.target).normalize().dot(position.clone().normalize())).toBeCloseTo(1, 9);
    // assembling again comes back
    const back = explodeCamera({ from: to, to: a, moved: 100, position: r.position, target: r.target })!;
    expect(back.position.distanceTo(position)).toBeLessThan(1e-6);
  });
});

describe("look along normal (E3)", () => {
  it("the largest face of a part's own box, on the side facing the camera", () => {
    const flat = box([0, 0, 0], [40, 30, 2]);
    expect(dominantNormal(flat, new THREE.Matrix4(), new THREE.Vector3(1, 1, 5)).toArray()).toEqual([0, 0, 1]);
    expect(dominantNormal(flat, new THREE.Matrix4(), new THREE.Vector3(1, 1, -5)).toArray()).toEqual([-0, -0, -1]);
    // a tilted panel: its own frame turned 90 degrees about y, so its face normal is world x
    const turned = new THREE.Matrix4().makeRotationY(Math.PI / 2);
    const n = dominantNormal(flat, turned, new THREE.Vector3(5, 0, 0));
    expect(n.x).toBeCloseTo(1, 9);
  });
  it("keeps the distance, and never looks exactly along the up axis", () => {
    const target = new THREE.Vector3(10, 0, 0);
    const p = lookAlong(target, new THREE.Vector3(10, -100, 50), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 1));
    expect(p.distanceTo(target)).toBeCloseTo(Math.hypot(100, 50), 6);
    expect(p.clone().sub(target).normalize().z).toBeLessThan(0.9999);
    expect(p.clone().sub(target).normalize().z).toBeGreaterThan(0.999);
    const side = lookAlong(target, new THREE.Vector3(10, -100, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1));
    expect(side.toArray().map((x) => Math.round(x * 1e6) / 1e6)).toEqual([110, 0, 0]);
  });
  it("the turn is eased along the sphere and ends exactly where it should", () => {
    const from = { position: new THREE.Vector3(0, -100, 0), target: new THREE.Vector3() };
    const to = { position: new THREE.Vector3(100, 0, 0), target: new THREE.Vector3() };
    const mid = cameraBetween(from, to, 0.5);
    expect(mid.position.length()).toBeCloseTo(100, 6);
    expect(cameraBetween(from, to, 1).position.distanceTo(to.position)).toBeLessThan(1e-9);
    expect(cameraBetween(from, to, 0).position.distanceTo(from.position)).toBeLessThan(1e-9);
  });
  it("the face under a pick: a triangle's world normal, facing the camera", () => {
    const g = new THREE.PlaneGeometry(10, 10);
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
    mesh.rotation.x = Math.PI / 2;
    mesh.updateMatrixWorld(true);
    const n = triangleNormal(mesh, 0, new THREE.Vector3(0, -1, 0))!;
    expect(n.y).toBeCloseTo(-1, 9);
    expect(triangleNormal(mesh, 0, new THREE.Vector3(0, 1, 0))!.y).toBeCloseTo(1, 9);
    expect(triangleNormal(mesh, 99, new THREE.Vector3(0, 1, 0))).toBeUndefined();
  });
});

describe("zoom toward the pointer (E1)", () => {
  it("DEFAULT on; the view option turns it off", () => {
    expect(DEFAULT_ZOOM_TO_CURSOR).toBe(true);
    expect(fromUrlParams(new URLSearchParams("zoomToCursor=0")).opening.zoomToCursor).toBe(false);
    expect(fromUrlParams(new URLSearchParams("zoomToCursor=1")).opening.zoomToCursor).toBe(true);
    expect(fromUrlParams(new URLSearchParams("")).opening.zoomToCursor).toBeUndefined();
  });
});

describe("the near plane follows the model (R1-E's C1, z-fighting)", () => {
  it("half the gap to the model, between 1 mm and 5 % of the distance; 1 mm inside it", async () => {
    const { nearPlaneFor } = await import("../src/cad/scene");
    expect(nearPlaneFor(530, 600)).toBe(30);
    expect(nearPlaneFor(40, 600)).toBe(20);
    expect(nearPlaneFor(-10, 600)).toBe(1);
    expect(nearPlaneFor(1, 600)).toBe(1);
  });
});
