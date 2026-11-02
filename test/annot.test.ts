import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CHAMFER, legalAngles, routeLeader, segmentHitsBox, type Pt } from "../src/cad/annot/leader";
import { placeLabels, screenBox, type PlaceItem } from "../src/cad/annot/place";
import { LIMITS, authorLabel, parseRecord, recordsOf, removeRecords, upsertRecords, type AnnotRecord } from "../src/cad/annot/record";
import { factRows, instanceAt, lcscOf, partCallout, partFacts, refdesOf } from "../src/cad/annot/facts";
import { DEFAULT_SHOWN, drcMarkers, findingCard, isolationOf, severityCounts, stepFinding } from "../src/cad/annot/drc";
import { findingsAnchors, type FindingAnchors } from "../src/cad/annot/findings-anchors";
import { findingInputs, locationOf } from "../src/cad/annot/sources";
import { componentIn, surfacePoint } from "../src/cad/annot/resolve";
import { markerSvg, REVEAL_MS } from "../src/cad/annot/style";
import type { ModuleDef } from "@uhd/types/module.js";
import { afterEach, beforeEach, vi } from "vitest";
import { summarise, findingSummary, SUMMARY_MAX } from "../src/cad/annot/drc";
import { anchorOnPart, markerPx } from "../src/cad/annot/resolve";
import { ANNOT_CSS, CALLOUT_MAX_W, LEADER_PX, LONG_HOVER_MS } from "../src/cad/annot/style";
import { AnnotLayer, MARKER_MAX_PX, MARKER_PX, STEM_PX, breakable, type AnnotHost } from "../src/cad/annot/layer";
import { attachWheelForward, canvasIn, forwardWheel, wheelInit } from "../src/cad/annot/wheel";
import { contrastRatio, luminance, parseHex } from "../src/theme/contrast";
import { DARK_SCENE_TOKENS, PAPER_SCENE_TOKENS } from "../src/theme/themes";
import { FakeWheelEvent, installFakeDom, type FakeEl } from "./labels-fakedom";

describe("leaders, option A (PB-1184)", () => {
  it("routes a 45° leg then a shelf, a vertical leg with a 45° chamfer, or a flat run; never another angle", () => {
    const a: Pt = [100, 100];
    const d = routeLeader(a, [140, 60], 80, "diagonal")!;
    expect(d.points).toEqual([[100, 100], [140, 60], [220, 60]]);
    const longer = routeLeader(a, [160, 60], 80, "diagonal")!;
    expect(longer.points).toEqual([[100, 100], [140, 60], [160, 60], [240, 60]]);
    const v = routeLeader(a, [100 + CHAMFER, 40], -90, "vertical");
    // a left-running shelf cannot start right of the anchor
    expect(v).toBeUndefined();
    const v2 = routeLeader(a, [100 - CHAMFER, 40], -90, "vertical")!;
    expect(v2.points[1]).toEqual([100, 40 + CHAMFER]);
    expect(v2.points[2]).toEqual([100 - CHAMFER, 40]);
    expect(routeLeader(a, [140, 100], 50, "flat")!.points).toHaveLength(3);
    for (const l of [d, longer, v2]) expect(legalAngles(l.points)).toBe(true);
    // a 45° leg cannot climb more than it runs
    expect(routeLeader(a, [110, 40], 50, "diagonal")).toBeUndefined();
    expect(legalAngles([[0, 0], [10, 3]])).toBe(false);
  });

  it("knows when a segment passes through a box", () => {
    expect(segmentHitsBox([0, 0], [100, 100], { x: 40, y: 40, w: 10, h: 10 })).toBe(true);
    expect(segmentHitsBox([0, 0], [100, 0], { x: 40, y: 40, w: 10, h: 10 })).toBe(false);
  });
});

const W = 1440;
const H = 900;
const rnd = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

describe("label placement (PB-1184)", () => {
  it("keeps labels apart, off their part, inside the view, with legal leaders", () => {
    const r = rnd(7);
    const items: PlaceItem[] = Array.from({ length: 12 }, (_, i) => {
      const x = 300 + r() * 840;
      const y = 200 + r() * 500;
      return { id: `c${i}`, anchor: [x, y], w: 150, h: 46, part: { x: x - 20, y: y - 14, w: 40, h: 28 } };
    });
    const t0 = performance.now();
    const res = placeLabels(items, { width: W, height: H, margins: { top: 56, bottom: 60, left: 52, right: 16 } });
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(50);
    const boxes = [...res.placed.values()].map((p) => p.box);
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h, `${i} ${j}`).toBe(false);
      }
    for (const [id, p] of res.placed) {
      const it = items.find((x) => x.id === id)!;
      const part = it.part!;
      expect(p.box.x < part.x + part.w && part.x < p.box.x + p.box.w && p.box.y < part.y + part.h && part.y < p.box.y + p.box.h).toBe(false);
      expect(p.box.x).toBeGreaterThanOrEqual(52);
      expect(p.box.x + p.box.w).toBeLessThanOrEqual(W - 16);
      expect(legalAngles(p.leader.points)).toBe(true);
      // the leader starts at the anchor and the shelf runs under the label
      expect(p.leader.points[0]).toEqual(it.anchor);
      const shelf = p.leader.points.slice(-2);
      expect(shelf[0][1]).toBeCloseTo(p.box.y + p.box.h, 5);
    }
    expect(res.placed.size + res.pinned.length).toBe(12);
    expect(res.placed.size).toBeGreaterThanOrEqual(10);
  });

  it("keeps the slot a label had (no hopping while the camera moves) and pins what cannot fit", () => {
    const one: PlaceItem = { id: "a", anchor: [700, 450], w: 120, h: 40, part: { x: 680, y: 430, w: 40, h: 40 } };
    const first = placeLabels([one], { width: W, height: H }).placed.get("a")!;
    const moved = placeLabels([{ ...one, anchor: [705, 452], prev: first.slot }], { width: W, height: H }).placed.get("a")!;
    expect(moved.slot).toBe(first.slot);
    const tiny = placeLabels([{ id: "b", anchor: [50, 50], w: 400, h: 300 }], { width: 320, height: 240 });
    expect(tiny.pinned).toEqual(["b"]);
  });

  it("fits two labels in a 320 px wide tab (acceptance: legible at 320 px)", () => {
    const res = placeLabels(
      [
        { id: "a", anchor: [140, 150], w: 120, h: 44 },
        { id: "b", anchor: [180, 170], w: 120, h: 44 },
      ],
      { width: 320, height: 400, margins: { top: 8, bottom: 8, left: 8, right: 8 } },
    );
    expect(res.placed.size).toBe(2);
  });

  it("measures a screen box", () => {
    expect(screenBox([[1, 2], [5, -1], [3, 8]])).toEqual({ x: 1, y: -1, w: 4, h: 9 });
  });
});

describe("annotation records (PB-1184)", () => {
  const good = { id: "agent:claude:u3", kind: "callout", ref: "stack/fc", author: "agent:claude", title: "U3", rows: [["MPN", "F405"], ["LCSC", "C12345"]], text: "the flight controller", extra: "dropped" };
  it("parses a record, drops unknown fields, caps text, keeps author as data", () => {
    const r = parseRecord(good);
    expect("record" in r && r.record).toEqual({ id: "agent:claude:u3", kind: "callout", ref: "stack/fc", author: "agent:claude", title: "U3", rows: [["MPN", "F405"], ["LCSC", "C12345"]], text: "the flight controller" });
    const long = parseRecord({ ...good, text: "x".repeat(2000) });
    expect("record" in long && long.record.text!.length).toBe(LIMITS.text);
    const ctl = parseRecord({ ...good, title: "a\u0000b‮c" });
    expect("record" in ctl && ctl.record.title).toBe("abc");
  });

  it("refuses bad records with a reason", () => {
    expect(parseRecord({ ...good, kind: "script" })).toMatchObject({ error: expect.stringMatching(/kind/) });
    expect(parseRecord({ ...good, author: "" })).toMatchObject({ error: expect.stringMatching(/author/) });
    expect(parseRecord({ ...good, point: [1, 2] })).toMatchObject({ error: expect.stringMatching(/point/) });
    expect(parseRecord({ ...good, kind: "arrow" })).toMatchObject({ error: expect.stringMatching(/to/) });
    expect(parseRecord({ ...good, text: "y".repeat(5000) })).toMatchObject({ error: expect.stringMatching(/4096 bytes/) });
    expect(parseRecord("nope")).toMatchObject({ error: expect.any(String) });
  });

  it("lists records by id (a resend replaces), upserts and removes", () => {
    const a = { ...good };
    const b = { ...good, title: "U3 again" };
    const { records, rejected } = recordsOf([a, { bad: true }, b]);
    expect(records).toHaveLength(1);
    expect(records[0].title).toBe("U3 again");
    expect(rejected).toHaveLength(1);
    const ring: AnnotRecord = { id: "r", kind: "mark", ref: "stack/fc", author: "user", shape: "ring" };
    const list = upsertRecords([a], [ring, { ...(a as unknown as AnnotRecord), title: "new" }]);
    expect(list).toHaveLength(2);
    expect((list[0] as AnnotRecord).title).toBe("new");
    expect(removeRecords(list, ["r"])).toHaveLength(1);
    expect(authorLabel("agent:claude")).toBe("claude (agent)");
    expect(authorLabel("user")).toBe("you");
  });
});

describe("part facts for the label sheet (PB-1184)", () => {
  const tps = { id: "ti-tps54427ddar", name: "TPS54427", manufacturer: "Texas Instruments", part_number: "TPS54427DDAR", interfaces: [], artifacts: [{ id: "lcsc", name: "LCSC product page C472488", url: "https://www.lcsc.com/product-detail/C472488.html" }] } as unknown as ModuleDef;
  it("reads refdes, MPN and LCSC from the model only", () => {
    expect(lcscOf(tps)).toBe("C472488");
    expect(lcscOf({ artifacts: [{ name: "package c0603" }] } as unknown as ModuleDef)).toBeUndefined();
    expect(refdesOf("pcb/power/rail_5v_ext/u13")).toBe("U13");
    expect(refdesOf("stack/fc")).toBeUndefined();
    const f = partFacts("pcb/power/rail_5v_ext/u13", tps);
    expect(factRows(f)).toEqual([
      ["REF", "U13"],
      ["MPN", "TPS54427DDAR"],
      ["LCSC", "C472488"],
      ["MFR", "Texas Instruments"],
    ]);
    // a bought module with no LCSC number says so (DEFAULT)
    expect(factRows(partFacts("stack/fc", { ...tps, artifacts: [] } as ModuleDef))).toContainEqual(["LCSC", "none in the model"]);
    expect(factRows(partFacts("r1", tps, { overrides: { value: "10k" } }))).toContainEqual(["VALUE", "10k"]);
  });

  it("finds an instance and builds the person's callout and ring", () => {
    const pcb = { id: "pcb", name: "PCB", interfaces: [], children: [{ id: "u13", moduleDefId: "ti-tps54427ddar", name: "Buck" }] } as unknown as ModuleDef;
    const root = { id: "root", name: "Root", interfaces: [], children: [{ id: "pcb", moduleDefId: "pcb" }] } as unknown as ModuleDef;
    const lookup = (id: string) => ({ pcb, "ti-tps54427ddar": tps })[id as "pcb"];
    const inst = instanceAt(root, lookup, "pcb/u13")!;
    expect(inst.def.id).toBe("ti-tps54427ddar");
    expect(inst.child?.name).toBe("Buck");
    expect(instanceAt(root, lookup, "pcb/nope")).toBeUndefined();
    const { callout, ring } = partCallout("pcb/u13", partFacts("pcb/u13", inst.def, inst.child));
    expect(callout.id.startsWith("user:callout:pcb/u13:")).toBe(true);
    expect(callout).toMatchObject({ kind: "callout", author: "user", title: "U13 · Buck" });
    // a new id per press: the store never takes a removed id back (W3-A)
    expect(partCallout("pcb/u13", {}, "user", "b").callout.id).not.toBe(partCallout("pcb/u13", {}, "user", "c").callout.id);
    expect(partCallout("pcb/u13", { refdes: "U13", name: "U13 TPS54427" }).callout.title).toBe("U13 TPS54427");
    expect(ring).toMatchObject({ kind: "mark", shape: "ring" });
    expect("record" in parseRecord(callout)).toBe(true);
  });
});

describe("marker-first DRC (PB-1184)", () => {
  const bodies = [{ key: "pcb", definition: "pcb-def" }, { key: "battery" }];
  const findings: FindingAnchors[] = findingsAnchors(
    [
      { code: "A_FAIL", severity: "error", message: "x", entity: { kind: "instance", id: "battery" } },
      { code: "B_WARN", severity: "warning", message: "y", entity: { kind: "instance", id: "battery" } },
      { code: "C_WARN", severity: "warning", message: "z", entity: { kind: "definition", id: "pcb-def" }, location: { at: [1, 2] } },
      { code: "D_PROJECT", severity: "warning", message: "w", entity: { kind: "project", id: "parts/origins.json" } },
    ],
    bodies,
  );
  it("groups findings at one anchor into one marker in the worst severity, worst first", () => {
    const m = drcMarkers(findings, new Set(DEFAULT_SHOWN));
    expect(m).toHaveLength(2);
    expect(m[0].severity).toBe("fail");
    expect(m[0].findings.map((f) => f.code)).toEqual(["A_FAIL", "B_WARN"]);
    expect(drcMarkers(findings, new Set(["warn"]))).toHaveLength(2);
    expect(drcMarkers(findings, new Set())).toHaveLength(0);
  });

  it("counts, steps, isolates and writes cards", () => {
    expect(severityCounts(findings)).toMatchObject({ fail: 1, warn: 3 });
    expect(stepFinding(findings, undefined, 1)!.code).toBe("A_FAIL");
    expect(stepFinding(findings, findings[0].id, -1)!.code).toBe("C_WARN");
    expect(isolationOf(findings[0])).toEqual(["battery"]);
    expect(isolationOf(findings[3])).toBeNull();
    expect(findings[3].reason).toMatch(/project/);
    expect(findingCard(findings[0])).toEqual({ title: "A FAIL", text: "x", rows: [["AT", "battery"]] });
  });

  it("reads host diagnostics with a location, checked", () => {
    expect(locationOf({ at: [1, 2], points: [[1, 2], ["x", 3]], layer: "top", components: ["u1", 5], evil: "<script>" })).toEqual({ at: [1, 2], points: [[1, 2]], layer: "top", components: ["u1"] });
    expect(locationOf("no")).toBeUndefined();
    const inputs = findingInputs(
      [{ id: "1", rule: "prop_handedness", severity: "error", message: "m", refs: ["link:arm", "arm_fl/prop"], scope: "" } as never],
      [{ code: "X", severity: "warning", message: "n", entity: { kind: "definition", id: "pcb-def" }, location: { components: ["u1"] }, risk: true } as never],
    );
    expect(inputs[0]).toMatchObject({ code: "PROP_HANDEDNESS", entity: { kind: "instance", id: "arm_fl/prop" } });
    expect(inputs[1]).toMatchObject({ location: { components: ["u1"] }, risk: true });
    expect(findingsAnchors(inputs, bodies)[1].severity).toBe("risk");
  });

  it("draws severity by shape and glyph, with the sheet's reveal timings", () => {
    expect(markerSvg("fail")).toContain("M7 1h6l6 6v6l-6 6H7l-6-6V7z");
    expect(markerSvg("risk")).toContain("M10 0.8L19.2 10");
    expect(markerSvg("unknown")).toContain("stroke-dasharray");
    expect(REVEAL_MS).toEqual({ intent: 80, leader: 180, card: 120, retract: 120 });
  });
});

describe("refs to what is drawn (PB-1184)", () => {
  it("finds a component node, or one instance of a GPU-instanced node, inside a body", () => {
    const body = new THREE.Group();
    const u13 = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 1));
    u13.name = "U13~SOP-8";
    u13.userData.protoboard = { partInstanceId: "power/u13" };
    u13.position.set(10, 0, 0);
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), 2);
    inst.setMatrixAt(0, new THREE.Matrix4().makeTranslation(-5, 0, 0));
    inst.setMatrixAt(1, new THREE.Matrix4().makeTranslation(5, 5, 0));
    inst.userData.protoboard = { instances: ["r1", "r2"] };
    body.add(u13, inst);
    body.position.set(0, 0, 100);
    const u = componentIn(body, "power/u13", "pcb/power/u13")!;
    expect(u.objects).toEqual([u13]);
    expect(u.box.getCenter(new THREE.Vector3()).toArray()).toEqual([10, 0, 100]);
    const r2 = componentIn(body, "r2", "pcb/r2")!;
    expect(r2.box.getCenter(new THREE.Vector3()).toArray()).toEqual([5, 5, 100]);
    expect(componentIn(body, "nothing", "pcb/nothing")).toBeUndefined();
  });

  it("anchors on the part's visible surface toward the camera, else the top of its box", () => {
    const camera = new THREE.PerspectiveCamera(50, 1, 1, 1000);
    camera.position.set(0, 0, 100);
    camera.updateMatrixWorld();
    const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    const part = { objects: [], box, frame: new THREE.Matrix4(), body: "b" };
    expect(surfacePoint(camera, part, () => new THREE.Vector3(0, 0, 1)).toArray()).toEqual([0, 0, 1]);
    expect(surfacePoint(camera, part, () => undefined).toArray()).toEqual([0, 0, 1]);
  });
});

// ---- R1-C: Kevin's walkthrough 2026-11-01 (D1 to D4, M10) --------------------------------------------------------

describe("wheel over a callout zooms the view (D2)", () => {
  it("copies the wheel event to the canvas and stops the original", () => {
    const layer = new EventTarget();
    const canvas = new EventTarget();
    const got: FakeWheelEvent[] = [];
    canvas.addEventListener("wheel", (e) => got.push(e as FakeWheelEvent));
    const off = attachWheelForward(layer, () => canvas, FakeWheelEvent);
    const e = new FakeWheelEvent("wheel", { deltaY: 53, deltaMode: 1, clientX: 410, clientY: 222, shiftKey: true, bubbles: true, cancelable: true });
    layer.dispatchEvent(e);
    expect(got).toHaveLength(1);
    expect(got[0]).not.toBe(e);
    expect([got[0].deltaY, got[0].deltaMode, got[0].clientX, got[0].clientY, got[0].shiftKey]).toEqual([53, 1, 410, 222, true]);
    expect(e.defaultPrevented).toBe(true);
    // no target: nothing forwarded, the page keeps its own behaviour
    expect(forwardWheel(new FakeWheelEvent("wheel", { cancelable: true }) as unknown as WheelEvent, null, FakeWheelEvent)).toBe(false);
    off();
    layer.dispatchEvent(new FakeWheelEvent("wheel", { deltaY: 1 }));
    expect(got).toHaveLength(1);
    expect(wheelInit(e as unknown as WheelEvent)).toMatchObject({ deltaY: 53, bubbles: true, cancelable: true });
  });
});

describe("DRC markers attach to the part (D1)", () => {
  it("finds the part's surface under the top centre of its bounds, not the air above a tilted model", () => {
    // a tilted slab: its bounds' top centre is in the air (the ClientX USB-C case)
    const slab = new THREE.Mesh(new THREE.BoxGeometry(40, 10, 4));
    slab.rotation.y = 0.6;
    slab.position.set(0, 0, 10);
    slab.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(slab);
    const part = { objects: [slab], box, frame: new THREE.Matrix4(), body: "pcb" };
    const camera = new THREE.PerspectiveCamera(40, 1, 1, 2000);
    camera.position.set(0, -300, 200);
    camera.lookAt(0, 0, 10);
    camera.updateMatrixWorld();
    const pick = (ray: THREE.Ray, roots: THREE.Object3D[]) => new THREE.Raycaster(ray.origin, ray.direction).intersectObjects(roots, true)[0]?.point;
    const p = anchorOnPart(camera, part, pick);
    const top = new THREE.Vector3((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, box.max.z);
    // on the slab's surface (a hit on its meshes), below the bounds' top
    expect(p.z).toBeLessThan(top.z - 1);
    const down = new THREE.Raycaster(new THREE.Vector3(p.x, p.y, 100), new THREE.Vector3(0, 0, -1)).intersectObject(slab)[0];
    expect(down.point.distanceTo(p)).toBeLessThan(1e-6);
    // nothing to hit: the bounds' top centre as before
    expect(anchorOnPart(camera, { ...part, objects: [] }, () => undefined).toArray()).toEqual(top.toArray());
  });

  it("sizes markers from the part on screen, never under the minimum", () => {
    expect(markerPx(undefined, MARKER_PX, MARKER_MAX_PX)).toBe(16);
    expect(markerPx(10, MARKER_PX, MARKER_MAX_PX)).toBe(16);
    expect(markerPx(70, MARKER_PX, MARKER_MAX_PX)).toBe(21);
    expect(markerPx(900, MARKER_PX, MARKER_MAX_PX)).toBe(26);
    expect(MARKER_PX).toBe(16);
    expect(STEM_PX).toBeGreaterThan(0);
  });
});

describe("callout cards (D3, D4, M10)", () => {
  it("summarises a diagnostic in one clause, parentheticals dropped", () => {
    expect(summarise("controller/sensors/pspin_4 is linked 2 times (controller/sensors/i2c0_sda.ps.pin_4+i2c0_sda.controller.i2c0_sda) but supports 1.")).toBe(
      "controller/sensors/pspin_4 is linked 2 times but supports 1.",
    );
    expect(summarise("12 V DC output (plug centre) ↔ CENTER (+): incompatible – no compatible protocol/role between psu:dc_12v_out and pcb/power/power_in/n12v_dc:pin_1")).toBe("12 V DC output ↔ CENTER: incompatible");
    const long = summarise("word ".repeat(80));
    expect(long.length).toBeLessThanOrEqual(SUMMARY_MAX);
    expect(long.endsWith("…")).toBe(true);
    expect(findingSummary({ code: "A_B", message: "m (x).", severity: "warn", rows: [] } as never).description).toBe("m.");
  });

  it("breaks long tokens at their separators", () => {
    const b = breakable("pcb/controller/sensors/i2c0_sda.ps.pin_4");
    expect(b.replace(/​/g, "")).toBe("pcb/controller/sensors/i2c0_sda.ps.pin_4");
    expect(b.split("​")).toHaveLength(8);
    expect(breakable("a / b.")).toBe("a / b.");
  });

  it("styles the card: app radius, a 1 px outline in the tone, wrap at 320 px, line clamps, a thicker leader", () => {
    expect(LEADER_PX).toBe(1.75);
    expect(CALLOUT_MAX_W).toBe(320);
    expect(ANNOT_CSS).toMatch(/\.annot-sheet \{[^}]*border-radius: var\(--uhd-radius/);
    expect(ANNOT_CSS).toMatch(/\.annot-sheet \{[^}]*border: 1px solid var\(--uhd-callout-border/);
    expect(ANNOT_CSS).toMatch(/\.annot-sheet \{[^}]*max-width: 320px/);
    expect(ANNOT_CSS).toContain(".cad-annot .annot-sheet.tone-warn { border-color: var(--uhd-drc-warning");
    expect(ANNOT_CSS).toContain("-webkit-line-clamp: 4");
    expect(ANNOT_CSS).not.toMatch(/border-bottom: var\(--uhd-callout-leader-width/);
    for (const set of [PAPER_SCENE_TOKENS, DARK_SCENE_TOKENS]) {
      expect(set.calloutLeaderWidth).toBe("1.75px");
      // the card is a step off the void, and its outline reads on it
      const [card, ground] = [luminance(parseHex(set.calloutSurface)!), luminance(parseHex(set.sceneBackground)!)];
      expect(Math.abs(card - ground)).toBeGreaterThan(0.005);
      expect(contrastRatio(set.calloutSurface, set.sceneBackground)).toBeGreaterThan(1.05);
      expect(contrastRatio(set.calloutBorder, set.calloutSurface)).toBeGreaterThan(1.3);
    }
  });
});

describe("hover tiers on a marker, in a page (D3, stand-in DOM)", () => {
  let dom: ReturnType<typeof installFakeDom>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    dom = installFakeDom();
  });
  afterEach(() => {
    dom.restore();
    vi.useRealTimers();
  });

  it("short hover: the title; long hover: the description; click: pinned with the raw rows, and the Inspector asked", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(20, 20, 4));
    mesh.position.set(0, 0, 2);
    mesh.updateMatrixWorld(true);
    const part = { objects: [mesh], box: new THREE.Box3().setFromObject(mesh), frame: new THREE.Matrix4(), body: "pcb" };
    const calls: string[] = [];
    const host: AnnotHost = {
      resolve: (ref) => (ref === "pcb" ? part : null),
      pickOn: (ray, roots) => new THREE.Raycaster(ray.origin, ray.direction).intersectObjects(roots, true)[0]?.point,
      firstHit: () => undefined,
      onFinding: (id, a) => calls.push(`${a}:${id}`),
      onInspect: (id, ref) => calls.push(`inspect:${id}:${ref}`),
    };
    const [f] = findingsAnchors(
      [{ code: "UHD_INTERFACE_REUSE", severity: "error", message: "controller/sensors/pspin_4 is linked 2 times (a.b+c.d) but supports 1.", entity: { kind: "instance", id: "pcb" }, validator: "uhd-viewer/system" } as never],
      [{ key: "pcb" }],
    );
    const markers = drcMarkers([f], new Set(DEFAULT_SHOWN));
    expect(markers).toHaveLength(1);
    const layer = new AnnotLayer(dom.host as unknown as HTMLElement, host);
    const open = new Set<string>();
    layer.setInput({ records: [], markers, open, presence: [], ghosts: true, motion: false });
    const camera = new THREE.PerspectiveCamera(40, 1440 / 900, 1, 2000);
    camera.position.set(0, -120, 160);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    layer.update(camera, 1440, 900);
    const root = layer.root as unknown as FakeEl;
    const hit = root.find("annot-hit")[0];
    expect(hit).toBeDefined();
    // the marker's terminal dot sits on the part's top face (z 4): a sprite in the overlay group at the surface
    const dot = layer.group.children.find((o) => (o as THREE.Sprite).isSprite && Math.abs(o.position.z - 4) < 2);
    expect(dot).toBeDefined();
    const sheet = () => root.find("annot-sheet").find((e) => !e.classList.contains("closed"));
    hit.dispatchEvent(new Event("pointerenter"));
    vi.advanceTimersByTime(60);
    layer.update(camera, 1440, 900);
    expect(layer.hoverState()).toEqual({ key: markers[0].key, tier: "short" });
    expect(sheet()!.text()).toContain("UHD INTERFACE REUSE");
    expect(sheet()!.find("annot-desc")).toHaveLength(0);
    expect(sheet()!.find("annot-rows")).toHaveLength(0);
    vi.advanceTimersByTime(LONG_HOVER_MS);
    layer.update(camera, 1440, 900);
    expect(layer.hoverState().tier).toBe("long");
    const desc = sheet()!.find("annot-desc");
    expect(desc).toHaveLength(1);
    expect(desc[0].textContent.replace(/​/g, "")).toBe("controller/sensors/pspin_4 is linked 2 times but supports 1.");
    expect(sheet()!.find("annot-rows")).toHaveLength(0);
    // click: pinned and the host's Inspector asked
    hit.dispatchEvent(new Event("click"));
    expect(calls).toContain(`open:${f.id}`);
    expect(calls).toContain(`inspect:${f.id}:pcb`);
    open.add(f.id);
    hit.dispatchEvent(new Event("pointerleave"));
    layer.update(camera, 1440, 900);
    const pinned = sheet()!;
    expect(pinned.find("annot-rows")).toHaveLength(1);
    expect(pinned.text()).toContain("AT");
    expect(pinned.text()).toContain("BY");
    layer.dispose();
  });

  it("a wheel over the layer reaches the canvas", () => {
    const g = globalThis as { WheelEvent?: unknown };
    const had = g.WheelEvent;
    g.WheelEvent = FakeWheelEvent;
    try {
      const host: AnnotHost = { resolve: () => null, pickOn: () => undefined, firstHit: () => undefined };
      const layer = new AnnotLayer(dom.host as unknown as HTMLElement, host);
      const canvas = canvasIn(dom.host as unknown as Element) as unknown as FakeEl;
      expect(canvas.tagName).toBe("CANVAS");
      let n = 0;
      canvas.addEventListener("wheel", () => n++);
      // the stand-in has no bubbling from children, so the event starts on the root; the browser check is in progress.md
      (layer.root as unknown as FakeEl).dispatchEvent(new FakeWheelEvent("wheel", { deltaY: -100, cancelable: true }));
      expect(n).toBe(1);
      layer.dispose();
    } finally {
      g.WheelEvent = had;
    }
  });
});

describe("the Findings button's glyph and empty state (R1-D handoff, G4)", () => {
  it("every marker glyph carries the SVG namespace (without it the parsed <svg> draws nothing)", async () => {
    const { SVG_NS } = await import("../src/cad/annot/style");
    for (const s of ["fail", "risk", "warn", "info", "pass", "unknown"] as const) {
      const svg = markerSvg(s, 15);
      expect(svg.startsWith(`<svg xmlns="${SVG_NS}"`)).toBe(true);
      expect(SVG_NS).toBe("http://www.w3.org/2000/svg");
      // one root element, closed
      expect(svg.match(/<svg\b/g)).toHaveLength(1);
      expect(svg.endsWith("</svg>")).toBe(true);
    }
  });

  it("says when no finding is placed in this view", async () => {
    const { findingsPlacement } = await import("../src/cad/annot/drc");
    const none = findingsAnchors([{ code: "X", severity: "error", message: "m", entity: { kind: "project", id: "p" } } as never], [{ key: "pcb" }]);
    expect(findingsPlacement(none)).toEqual({ total: 1, placed: 0, empty: true, note: "No findings placed in this view" });
    const some = findingsAnchors([{ code: "X", severity: "error", message: "m", entity: { kind: "instance", id: "pcb" } } as never], [{ key: "pcb" }]);
    expect(findingsPlacement(some)).toMatchObject({ placed: 1, empty: false });
    // the layer's drawn count wins (anchored, but its part not drawn in this scope)
    expect(findingsPlacement(some, 0).empty).toBe(true);
    expect(findingsPlacement([]).empty).toBe(false);
  });
});
