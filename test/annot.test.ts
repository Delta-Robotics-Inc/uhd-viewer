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
