/**
 * R4-A (2026-11-02): the Onshape-like zoom with hard stops, the intentional orbit pivot and the void menu.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MAX_FILL,
  MIN_DISTANCE_FLOOR_MM,
  MIN_DISTANCE_SHARE,
  PIVOT_EASE_MS,
  WheelNotches,
  ZOOM_STEP,
  attachCameraPolicy,
  clampToMax,
  movePivot,
  pivotChange,
  pivotOf,
  planeAnchor,
  radiusOf,
  zoomLimits,
  zoomStep,
  type CameraHost,
} from "../src/cad/camera";
import { VOID_MENU_TITLE, voidMenuFor, type VoidMenuInput } from "../src/cad/nav/void";
import { menuFor } from "../src/cad/nav/target";
import { PartMenu } from "../src/cad/nav/ui";

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const pose = (p: THREE.Vector3, t: THREE.Vector3) => ({ position: p.clone(), target: t.clone() });

describe("R4-A zoom stops", () => {
  it("the closest stop is 2 % of the radius in view, never under 0.5 mm", () => {
    expect(MIN_DISTANCE_SHARE).toBe(0.02);
    expect(MIN_DISTANCE_FLOOR_MM).toBe(0.5);
    expect(zoomLimits({ focusRadius: 100, assemblyRadius: 100, fovDeg: 32, aspect: 1.6 }).min).toBeCloseTo(2, 9);
    // a 0402 capacitor (radius ~0.6 mm): the floor
    expect(zoomLimits({ focusRadius: 0.6, assemblyRadius: 0.6, fovDeg: 32, aspect: 1.6 }).min).toBe(0.5);
  });
  it("the farthest stop is where the visible assembly's sphere fills half the view's height (about 2x a fit)", () => {
    const fov = 32;
    const l = zoomLimits({ focusRadius: 10, assemblyRadius: 150, fovDeg: fov, aspect: 1.6 });
    const half = (fov * Math.PI) / 360;
    // the sphere's angular diameter at the far stop is MAX_FILL of the field of view
    expect((2 * Math.asin(150 / l.max)) / (2 * half)).toBeCloseTo(MAX_FILL, 9);
    // a fit makes the sphere fill the view: R / sin(fov / 2); the far stop is about twice that
    const fit = 150 / Math.sin(half);
    expect(l.max / fit).toBeGreaterThan(1.9);
    expect(l.max / fit).toBeLessThan(2.1);
    // a view taller than wide: its narrower horizontal field decides
    const tall = zoomLimits({ focusRadius: 10, assemblyRadius: 150, fovDeg: fov, aspect: 0.5 });
    expect(tall.max).toBeGreaterThan(l.max);
  });
  it("one notch is one constant factor, the same in and out, so zooming back out returns along the same path", () => {
    const limits = { min: 1, max: 1e6 };
    const start = pose(v(300, -300, 200), v(0, 0, 0));
    const anchor = v(20, 10, 5);
    let p = start;
    const d0 = p.position.distanceTo(p.target);
    const trail: THREE.Vector3[] = [];
    for (let i = 0; i < 5; i++) {
      const n = zoomStep(p, { anchor, notches: -1, limits })!;
      expect(n.distance).toBeCloseTo(p.position.distanceTo(p.target) / ZOOM_STEP, 9);
      trail.push(p.position.clone());
      p = n;
    }
    expect(p.position.distanceTo(p.target)).toBeCloseTo(d0 / ZOOM_STEP ** 5, 6);
    for (let i = 4; i >= 0; i--) {
      p = zoomStep(p, { anchor, notches: 1, limits })!;
      expect(p.position.distanceTo(trail[i])).toBeLessThan(1e-6);
    }
    expect(p.target.distanceTo(start.target)).toBeLessThan(1e-6);
  });
  it("keeps the point under the cursor where it is on screen (camera and target scaled about it)", () => {
    const start = pose(v(0, -400, 0), v(0, 0, 0));
    const anchor = v(40, 0, 25);
    const n = zoomStep(start, { anchor, notches: -3, limits: { min: 1, max: 1e6 } })!;
    const before = anchor.clone().sub(start.position).normalize();
    const after = anchor.clone().sub(n.position).normalize();
    expect(before.distanceTo(after)).toBeLessThan(1e-9);
    // the view's direction is unchanged (no swing)
    expect(n.target.clone().sub(n.position).normalize().distanceTo(start.target.clone().sub(start.position).normalize())).toBeLessThan(1e-9);
  });
  it("stops hard at the closest distance: exactly there, then the wheel does nothing (no creep, no spring)", () => {
    const limits = { min: 2, max: 1e6 };
    let p = pose(v(0, -100, 0), v(0, 0, 0));
    let steps = 0;
    for (;;) {
      const n = zoomStep(p, { anchor: p.target.clone(), notches: -1, limits });
      if (!n) break;
      p = n;
      if (++steps > 100) throw new Error("no stop");
    }
    expect(p.position.distanceTo(p.target)).toBeCloseTo(2, 9);
    // 100 / 1.15^n reaches 2 within 28 notches: a hard stop, not an approach that slows toward it
    expect(steps).toBeLessThanOrEqual(Math.ceil(Math.log(100 / 2) / Math.log(ZOOM_STEP)));
    // and one notch out leaves it at once
    const out = zoomStep(p, { anchor: p.target.clone(), notches: 1, limits })!;
    expect(out.distance).toBeCloseTo(2 * ZOOM_STEP, 9);
  });
  it("stops hard at the farthest distance, and never pulls in a camera already beyond it", () => {
    const limits = { min: 1, max: 500 };
    const p = pose(v(0, -480, 0), v(0, 0, 0));
    const n = zoomStep(p, { anchor: p.target.clone(), notches: 1, limits })!;
    expect(n.distance).toBe(500);
    expect(n.atStop).toBe(true);
    expect(zoomStep(n, { anchor: n.target.clone(), notches: 1, limits })).toBeNull();
    // past the stop (an isolation shrank what is drawn): out does nothing, in still works
    const far = pose(v(0, -900, 0), v(0, 0, 0));
    expect(zoomStep(far, { anchor: far.target.clone(), notches: 2, limits })).toBeNull();
    expect(zoomStep(far, { anchor: far.target.clone(), notches: -1, limits })!.distance).toBeCloseTo(900 / ZOOM_STEP, 9);
  });
  it("keeps the pivot on the model: a target pushed out of the drawn box is held at its edge", () => {
    const box = new THREE.Box3(v(-10, -10, -10), v(10, 10, 10));
    const p = pose(v(0, -100, 0), v(9, 0, 0));
    // zooming out about a point on the left pushes the target right, off the model
    const n = zoomStep(p, { anchor: v(-9, 0, 0), notches: 4, limits: { min: 1, max: 1e6 }, keepIn: box })!;
    expect(box.containsPoint(n.target)).toBe(true);
    expect(n.position.distanceTo(n.target)).toBeCloseTo(p.position.distanceTo(p.target) * ZOOM_STEP ** 4, 6);
  });
  it("reads wheel events as notches: a mouse notch of any size is one, Firefox's 3 lines are one, a pinch follows the fingers", () => {
    const w = new WheelNotches();
    expect(w.read({ deltaY: 125, deltaMode: 0 })).toBe(1);
    expect(w.read({ deltaY: -125, deltaMode: 0 })).toBe(-1);
    expect(w.read({ deltaY: 250, deltaMode: 0 })).toBe(2);
    expect(new WheelNotches().read({ deltaY: -100, deltaMode: 0 })).toBe(-1);
    expect(new WheelNotches().read({ deltaY: 3, deltaMode: 1 })).toBe(1);
    // a trackpad scroll: a fraction of a notch
    expect(new WheelNotches().read({ deltaY: 10, deltaMode: 0 })).toBeCloseTo(0.1, 9);
    // a pinch: distance factor e^(dy / 100), the pinch's own scale
    const n = new WheelNotches().read({ deltaY: -20, deltaMode: 0, ctrlKey: true });
    expect(ZOOM_STEP ** n).toBeCloseTo(Math.exp(-0.2), 9);
    expect(new WheelNotches().read({ deltaY: 5000, deltaMode: 0 })).toBe(1);
    expect(new WheelNotches().read({ deltaY: 0, deltaMode: 0 })).toBe(0);
  });
  it("anchors on the plane through the target when nothing is under the cursor", () => {
    const p = pose(v(0, -100, 0), v(0, 0, 0));
    const ray = new THREE.Ray(p.position.clone(), v(0.1, 1, 0).normalize());
    const a = planeAnchor(ray, p);
    expect(a.y).toBeCloseTo(0, 9);
    expect(a.x).toBeCloseTo(10, 9);
  });
  it("clamps an agent's explicit camera to the farthest stop along its own line, and leaves a near one alone", () => {
    const far = pose(v(0, -2000, 0), v(5, 0, 0));
    const c = clampToMax(far, 600);
    expect(c.position.distanceTo(c.target)).toBeCloseTo(600, 9);
    expect(c.target.equals(far.target)).toBe(true);
    const near = pose(v(0, -0.2, 0), v(0, 0, 0));
    expect(clampToMax(near, 600)).toBe(near);
  });
});

describe("R4-A orbit pivot", () => {
  it("is the centre of what is drawn (assembled, exploded, or the isolated set)", () => {
    expect(pivotOf(new THREE.Box3(v(0, 0, 0), v(10, 20, 30)))!.toArray()).toEqual([5, 10, 15]);
    expect(pivotOf(new THREE.Box3())).toBeUndefined();
    expect(radiusOf(new THREE.Box3(v(0, 0, 0), v(3, 4, 0)))).toBe(2.5);
  });
  it("moving it carries the camera along (a pan): direction and distance kept; nothing when it is already there", () => {
    const p = pose(v(100, -100, 50), v(0, 0, 0));
    const to = movePivot(p, v(10, 5, 0), 50)!;
    expect(to.target.toArray()).toEqual([10, 5, 0]);
    expect(to.position.clone().sub(to.target).distanceTo(p.position.clone().sub(p.target))).toBeLessThan(1e-9);
    expect(movePivot(p, v(0.01, 0, 0), 50)).toBeNull();
    expect(PIVOT_EASE_MS).toBe(200);
  });
  it("is asked for again by an isolation or a hidden change, never by a selection or a change that brings its own camera", () => {
    const cam = { position: [1, 2, 3], target: [0, 0, 0] };
    expect(pivotChange({ isolation: null, hidden: [], camera: cam }, { isolation: ["pcb"], hidden: [], camera: cam })).toBe(true);
    expect(pivotChange({ isolation: ["pcb"], hidden: [], camera: cam }, { isolation: null, hidden: [], camera: cam })).toBe(true);
    expect(pivotChange({ isolation: null, hidden: [], camera: cam }, { isolation: null, hidden: ["arm_fl"], camera: cam })).toBe(true);
    // a selection changes neither
    expect(pivotChange({ isolation: null, hidden: [], camera: cam }, { isolation: null, hidden: [], camera: cam })).toBe(false);
    // Back restores a place's isolation and its camera in one write: its camera stands
    expect(pivotChange({ isolation: ["pcb"], hidden: [], camera: cam }, { isolation: null, hidden: [], camera: { ...cam, target: [5, 5, 5] } })).toBe(false);
  });
});

/** A stand-in canvas, holder and OrbitControls (no DOM in the test environment). */
function fakeHost() {
  const listeners = new Map<string, (e: unknown) => void>();
  const holder = { addEventListener: (t: string, f: (e: unknown) => void) => listeners.set(t, f), removeEventListener: (t: string) => listeners.delete(t) };
  const canvas = { parentElement: holder, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }), clientWidth: 800, clientHeight: 600, offsetLeft: 0, offsetTop: 0 } as unknown as HTMLCanvasElement;
  const camera = new THREE.PerspectiveCamera(32, 800 / 600, 1, 1e6);
  camera.up.set(0, 0, 1);
  camera.position.set(0, -400, 0);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const controls = Object.assign(new THREE.EventDispatcher(), { target: new THREE.Vector3(), enabled: true, enableZoom: true, state: -1, minDistance: 0, maxDistance: Infinity, zoomToCursor: true });
  const events: string[] = [];
  for (const t of ["start", "change", "end"]) controls.addEventListener(t as never, () => events.push(t));
  const host = { camera, controls, renderer: { domElement: canvas }, invalidate: () => undefined } as unknown as CameraHost;
  return { host, listeners, canvas, camera, controls, events };
}

describe("R4-A camera policy on a view", () => {
  const box = new THREE.Box3(v(-50, -50, -50), v(50, 50, 50));
  it("takes the wheel before OrbitControls, steps once per notch, and stops hard at both ends", () => {
    const f = fakeHost();
    const policy = attachCameraPolicy(f.host, { drawn: () => box, cursor: () => true });
    expect((f.controls as unknown as { zoomToCursor: boolean }).zoomToCursor).toBe(false);
    const wheel = f.listeners.get("wheel")!;
    let stopped = 0;
    const ev = (deltaY: number) => ({ target: f.canvas, deltaY, deltaMode: 0, clientX: 400, clientY: 300, preventDefault: () => undefined, stopPropagation: () => void stopped++ });
    const d0 = f.camera.position.distanceTo(f.controls.target);
    wheel(ev(-100));
    expect(stopped).toBe(1);
    expect(f.camera.position.distanceTo(f.controls.target)).toBeCloseTo(d0 / ZOOM_STEP, 6);
    expect(f.events).toEqual(["start", "change", "end"]);
    const lim = policy.limits();
    // wave R4 gate: the stop also clears twice the scene's 1 mm near plane (this 86.6 mm sphere's 2 % is 1.73 mm)
    expect(lim.min).toBeCloseTo(Math.max(2, 0.02 * radiusOf(box)), 9);
    for (let i = 0; i < 200; i++) wheel(ev(-100));
    expect(f.camera.position.distanceTo(f.controls.target)).toBeCloseTo(lim.min, 6);
    for (let i = 0; i < 200; i++) wheel(ev(100));
    expect(f.camera.position.distanceTo(f.controls.target)).toBeCloseTo(lim.max, 6);
    // the pivot never left the model
    expect(box.containsPoint(f.controls.target)).toBe(true);
    // a wheel over the toolbar or a chip is not ours
    let other = 0;
    wheel({ target: {}, deltaY: -100, deltaMode: 0, preventDefault: () => void other++, stopPropagation: () => void other++ });
    expect(other).toBe(0);
    policy.dispose();
    expect(f.listeners.has("wheel")).toBe(false);
  });
  it("holds the middle-button dolly and a touch pinch to the same stops for the gesture only", () => {
    const f = fakeHost();
    const policy = attachCameraPolicy(f.host, { drawn: () => box, cursor: () => true });
    f.controls.dispatchEvent({ type: "start" } as never);
    expect(f.controls.minDistance).toBeCloseTo(policy.limits().min, 9);
    expect(f.controls.maxDistance).toBeCloseTo(policy.limits().max, 9);
    f.controls.dispatchEvent({ type: "end" } as never);
    // released after: a fit or an agent's camera is never snapped by them
    expect(f.controls.minDistance).toBe(0);
    expect(f.controls.maxDistance).toBe(Infinity);
    policy.dispose();
  });
  it("zooms straight at the pivot when zoom to cursor is off", () => {
    const f = fakeHost();
    const policy = attachCameraPolicy(f.host, { drawn: () => box, cursor: () => false });
    policy.zoomAt(-2, 700, 100);
    expect(f.controls.target.length()).toBeLessThan(1e-9);
    policy.dispose();
  });
});

describe("R4-A void menu", () => {
  const base: VoidMenuInput = { hidden: 0, isolated: false, exploded: false, mode: "radial", section: false, capture: true };
  const ids = (o: Partial<VoidMenuInput>) => voidMenuFor({ ...base, ...o }).map((i) => i.id);
  it("lists universal items only, none of the part menu's", () => {
    const partOnly = new Set(menuFor({ target: undefined, component: false, canExplode: true, canOpenTab: true, isolated: false }).map((i) => i.id).filter((id) => id !== "explode"));
    const all = ids({ hidden: 2, isolated: true, exploded: true, section: true, grid: { on: true }, scaleRef: { on: false, choice: "banana" } });
    expect(all).toEqual(["showAll", "unisolate", "fit", "reset", "explode", "assemble", "sectionOff", "grid", "scaleRef", "capture"]);
    for (const id of all) expect(partOnly.has(id as never)).toBe(false);
    expect(VOID_MENU_TITLE).toBe("View");
  });
  it("shows Unisolate only while isolated and Section view off only while a section is on", () => {
    expect(ids({})).toEqual(["showAll", "fit", "reset", "explode", "assemble", "capture"]);
    expect(ids({ isolated: true })).toContain("unisolate");
    expect(ids({ section: true })).toContain("sectionOff");
  });
  it("Show all is disabled with nothing hidden or isolated, and says why", () => {
    expect(voidMenuFor(base)[0]).toMatchObject({ id: "showAll", disabled: "Nothing is hidden or isolated" });
    expect(voidMenuFor({ ...base, hidden: 1 })[0].disabled).toBeUndefined();
    expect(voidMenuFor({ ...base, isolated: true })[0].disabled).toBeUndefined();
  });
  it("mirrors the toolbar's Explode and Assemble (R5-B: two checkbox items, one per toggle)", () => {
    const at = (o: Partial<VoidMenuInput>, id: string) => voidMenuFor({ ...base, ...o }).find((i) => i.id === id)!;
    expect(at({}, "explode")).toMatchObject({ label: "Explode", checked: false });
    expect(at({ exploded: true, mode: "radial" }, "explode")).toMatchObject({ label: "Explode", checked: true });
    expect(at({}, "assemble")).toMatchObject({ label: "Assemble", checked: false });
    expect(at({ exploded: true, mode: "sequence" }, "assemble")).toMatchObject({ label: "Assemble", checked: true });
  });
  it("names the grid and the scale reference's current choice; leaves them out when R4-B reports none", () => {
    const m = voidMenuFor({ ...base, grid: { on: false }, scaleRef: { on: true, choice: "Benchy" } });
    // wave R5 gate: checkbox items are named by what they show; the check mark says on or off
    expect(m.find((i) => i.id === "grid")!).toMatchObject({ label: "Grid", checked: false });
    expect(m.find((i) => i.id === "scaleRef")!).toMatchObject({ label: "Scale reference (Benchy)", checked: true });
    expect(ids({})).not.toContain("grid");
  });
  it("disables Capture image with a reason when the view cannot be captured", () => {
    expect(voidMenuFor({ ...base, capture: "No view to capture yet" }).at(-1)).toMatchObject({ id: "capture", disabled: "No view to capture yet" });
  });
  it("renders in the part menu's styling, marked as the view's menu, with its rules and pressed items", () => {
    const html = renderToStaticMarkup(createElement(PartMenu, { kind: "void", x: 10, y: 10, title: VOID_MENU_TITLE, items: voidMenuFor({ ...base, exploded: true, grid: { on: true } }), onRun: () => undefined, onClose: () => undefined }));
    expect(html).toContain('class="context-menu cad-part-menu"');
    expect(html).toContain('data-menu="void"');
    expect(html).toContain('aria-label="View actions"');
    expect(html).toContain('role="menuitemcheckbox"');
    expect((html.match(/role="separator"/g) ?? []).length).toBeGreaterThanOrEqual(3);
    // the part menu keeps its own two rules
    const part = renderToStaticMarkup(createElement(PartMenu, { x: 0, y: 0, title: "Motor", items: menuFor({ target: undefined, component: false, canExplode: true, canOpenTab: true, isolated: false }), onRun: () => undefined, onClose: () => undefined }));
    expect((part.match(/role="separator"/g) ?? []).length).toBe(2);
    expect(part).toContain('data-menu="part"');
  });
});
