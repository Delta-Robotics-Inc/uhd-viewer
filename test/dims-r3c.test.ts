/**
 * R3-C (wave R3, 2026-11-02): dimensions and angles as records and in the scene, the Measure tool, explode path
 * lines, and the callout card brought closer to the concepts (author pill, VALUE row, tier chips, LOOK AT / DETAILS /
 * previous-next). Runs on the stand-in DOM (no jsdom).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { parseRecord, recordsOf } from "../src/cad/annot/record";
import { AnnotLayer, authorPill, cardRows, type AnnotHost } from "../src/cad/annot/layer";
import { DEFAULT_SHOWN, drcMarkers } from "../src/cad/annot/drc";
import { findingText, findingsAnchors } from "../src/cad/annot/plain";
import {
  DimsLayer,
  ExplodePaths,
  MeasureTool,
  angleTicks,
  arcSpan,
  dimRecordsOf,
  dimensionFromPicks,
  dimensionOffset,
  formatDeg,
  formatMm,
  parseDimRecord,
  pathMovers,
  restDirection,
  tierOf,
  valueFromDelta,
  type DimJoint,
  type DimsHost,
  type MeasurePick,
} from "../src/cad/dims";
import type { PartHit } from "../src/cad/annot/resolve";
import { FakeEl, installFakeDom } from "./labels-fakedom";

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

describe("dimension and angle records (additive kinds of uhd-viewer.annotation/v0)", () => {
  const dim = { id: "d1", kind: "dimension", ref: "arm_fl/motor", to: "arm_fr/motor", author: "agent:claude" };
  it("parse through the shared parser; recordsOf keeps callouts only, dimRecordsOf the two new kinds", () => {
    const p = parseRecord(dim);
    expect(p).toMatchObject({ record: { id: "d1", kind: "dimension", to: "arm_fr/motor" } });
    expect(parseRecord({ id: "a1", kind: "angle", ref: "gps_mount", author: "user", joint: "gps_fold" })).toMatchObject({ record: { kind: "angle", joint: "gps_fold" } });
    const list = [dim, { id: "c1", kind: "callout", ref: "x", author: "user" }, { id: "a1", kind: "angle", ref: "gps_mount", author: "user" }];
    expect(recordsOf(list).records.map((r) => r.id)).toEqual(["c1"]);
    expect(recordsOf(list).rejected).toEqual([]);
    expect(dimRecordsOf(list).map((r) => r.id)).toEqual(["d1", "a1"]);
  });
  it("rejects what it cannot draw, with a reason; text is capped and control characters dropped", () => {
    expect(parseRecord({ ...dim, to: undefined })).toMatchObject({ error: expect.stringMatching(/to/) });
    expect(parseRecord({ ...dim, tier: "guess" })).toMatchObject({ error: expect.stringMatching(/tier/) });
    expect(parseRecord({ ...dim, valueMm: -1 })).toMatchObject({ error: expect.stringMatching(/valueMm/) });
    expect(parseRecord({ ...dim, point: [1, 2] })).toMatchObject({ error: expect.stringMatching(/point/) });
    expect(parseRecord({ ...dim, kind: "ruler" })).toMatchObject({ error: expect.stringMatching(/dimension, angle/) });
    const t = parseDimRecord({ ...dim, title: "a\u0000b‮c", tier: "EXACT", valueMm: 158.37, toleranceMm: 0.2 });
    expect(t).toMatchObject({ record: { title: "abc", tier: "exact", valueMm: 158.37, toleranceMm: 0.2 } });
  });
  it("tier: the record's, else MESH for two picked points, else NOMINAL (design frames)", () => {
    const r = parseDimRecord(dim);
    if (!("record" in r) || r.record.kind !== "dimension") throw new Error("parse");
    expect(tierOf(r.record)).toBe("nominal");
    expect(tierOf({ ...r.record, point: [0, 0, 0], toPoint: [1, 0, 0] })).toBe("mesh");
    expect(tierOf({ ...r.record, tier: "measured" })).toBe("measured");
  });
});

describe("the shapes (pure)", () => {
  it("a dimension line sits below its points (away from up), 15 % of their distance, at least 6 mm (DEFAULT)", () => {
    const off = dimensionOffset(V(-79.2, 0, 0), V(79.2, 0, 0), V(0, 0, 1));
    expect(off.x).toBeCloseTo(0, 6);
    expect(off.z).toBeCloseTo(-0.15 * 158.4, 6);
    expect(dimensionOffset(V(0, 0, 0), V(10, 0, 0), V(0, 0, 1)).z).toBeCloseTo(-6, 6);
    // a vertical measurement is offset sideways
    const side = dimensionOffset(V(0, 0, 0), V(0, 0, 50), V(0, 0, 1));
    expect(Math.abs(side.z)).toBeLessThan(1e-9);
    expect(side.length()).toBeCloseTo(7.5, 6);
    expect(dimensionOffset(V(0, 0, 0), V(1, 0, 0), V(0, 0, 1), V(0, 3, 0)).toArray()).toEqual([0, 3, 0]);
  });
  it("labels: mm and degrees as the concepts write them", () => {
    expect(formatMm(158.4)).toBe("158.4 mm");
    expect(formatMm(158.37, 0.2)).toBe("158.4 mm ±0.2");
    expect(formatMm(3.1)).toBe("3.10 mm");
    expect(formatDeg(62)).toBe("62°");
    expect(formatDeg(61.98)).toBe("62°");
    expect(formatDeg(12.5)).toBe("12.5°");
    expect(angleTicks({ rest: 90, min: 0, max: 95 }, 62).map((t) => t.label)).toEqual(["NOW 62°", "HARD STOP 95°", "REST 90°", "0°"]);
    expect(angleTicks({ rest: 0, min: -10 }, 5).map((t) => t.kind)).toEqual(["now", "stop", "rest", "zero"]);
    expect(arcSpan({ rest: 90, min: 0, max: 95 }, 62)).toEqual([0, 95]);
  });
  it("the joint value from a pose: rest plus the turn about the axis; a translation adds nothing", () => {
    const axis = V(0, 1, 0);
    const { dir, arm } = restDirection(V(0, 0, 10), axis, V(1, 3, 30));
    expect(arm).toBeCloseTo(Math.hypot(1, 20), 6);
    const restDir = V(0, 0, 1);
    const turn = new THREE.Matrix4().makeRotationAxis(axis, (-28 * Math.PI) / 180);
    expect(valueFromDelta({ axis, restDir, rest: 90 }, turn)).toBeCloseTo(62, 6);
    const moved = new THREE.Matrix4().makeTranslation(5, 40, -3).multiply(turn);
    expect(valueFromDelta({ axis, restDir, rest: 90 }, moved)).toBeCloseTo(62, 6);
    expect(dir.y).toBeCloseTo(0, 6);
  });
});

/** A body: a group placed by `matrix` holding a box mesh (`size`, centred at `centre` in the body's frame). */
function body(name: string, matrix: THREE.Matrix4, size: [number, number, number], centre: [number, number, number] = [0, 0, 0]) {
  const g = new THREE.Group();
  g.name = name;
  g.matrixAutoUpdate = false;
  g.matrix.copy(matrix);
  g.matrixWorldNeedsUpdate = true;
  const m = new THREE.Mesh(new THREE.BoxGeometry(...size));
  m.position.set(...centre);
  g.add(m);
  return { g, base: matrix.clone() };
}

describe("the dims layer in a page (stand-in DOM)", () => {
  let dom: ReturnType<typeof installFakeDom>;
  beforeEach(() => {
    dom = installFakeDom();
  });
  afterEach(() => dom.restore());

  const scene = () => {
    const root = new THREE.Group();
    const m1 = body("arm_fl/motor", new THREE.Matrix4().makeTranslation(-79.2, 0, 0), [28, 28, 20], [0, 0, 10]);
    const m2 = body("arm_fr/motor", new THREE.Matrix4().makeTranslation(79.2, 0, 0), [28, 28, 20], [0, 0, 10]);
    // the GPS mast: turns about Y through (0, 0, 10); assembled upright (rest 90)
    const mast = body("gps", new THREE.Matrix4().makeTranslation(0, 40, 0), [4, 4, 40], [0, 0, 30]);
    root.add(m1.g, m2.g, mast.g);
    root.updateMatrixWorld(true);
    const bodies = new Map([
      ["arm_fl/motor", m1],
      ["arm_fr/motor", m2],
      ["gps", mast],
    ]);
    const joints: DimJoint[] = [{ id: "gps_fold", type: "revolute", part: "gps", origin: [0, 40, 10], axis: [0, 1, 0], rest: 90, min: 0, max: 95 }];
    const host: DimsHost = {
      resolve: (ref) => {
        const b = bodies.get(ref);
        if (!b) return null;
        b.g.updateWorldMatrix(true, true);
        return { objects: [b.g], box: new THREE.Box3().setFromObject(b.g), frame: b.g.matrixWorld.clone(), body: ref } satisfies PartHit;
      },
      bodyRest: (key) => {
        const b = bodies.get(key);
        return b?.g.parent ? b.g.parent.matrixWorld.clone().multiply(b.base) : undefined;
      },
      joints: () => joints,
    };
    const camera = new THREE.PerspectiveCamera(40, 1440 / 900, 1, 5000);
    camera.position.set(0, -420, 260);
    camera.up.set(0, 0, 1);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const layer = new DimsLayer(dom.host as unknown as HTMLElement, host);
    return { root, bodies, host, camera, layer };
  };

  it("a nominal dimension between two motors: 158.4 mm NOMINAL; the number holds while the model is apart", () => {
    const { bodies, camera, layer } = scene();
    layer.setRecords(dimRecordsOf([{ id: "d1", kind: "dimension", ref: "arm_fl/motor", to: "arm_fr/motor", author: "agent:claude" }]));
    layer.update(camera, 1440, 900);
    const [s] = layer.report();
    expect(s).toMatchObject({ id: "d1", status: "placed", tier: "nominal", label: "158.4 mm", value: 158.4 });
    const root = layer.root as unknown as FakeEl;
    const chip = root.find("dim-chip")[0];
    expect(chip.text()).toContain("158.4 mm");
    expect(chip.find("dim-tier")[0].textContent).toBe("NOMINAL");
    // one solid line (the dimension line), two dashed (extension lines), four dots; 4 draws in all (solid, its ghost,
    // dashed, dots)
    expect(layer.drawStats()).toMatchObject({ segments: 1, dashed: 2, dots: 4, draws: 4 });
    // the dimension line sits below the motors' origins
    const seg = layer.segment("solid", 0);
    expect(seg.a[2]).toBeLessThan(-20);
    // exploded: the second motor lifts 30 mm; the line follows it, the number does not change
    const m2 = bodies.get("arm_fr/motor")!;
    m2.g.matrix.copy(new THREE.Matrix4().makeTranslation(0, 0, 30).multiply(m2.base));
    m2.g.matrixWorldNeedsUpdate = true;
    layer.update(camera, 1440, 900);
    expect(layer.report()[0]).toMatchObject({ value: 158.4, label: "158.4 mm" });
    expect(layer.segment("solid", 0).b[2]).toBeGreaterThan(seg.b[2] + 29);
    layer.dispose();
  });

  it("picked points (MESH) and an author's value (EXACT) with its tolerance; an orphan and a hidden record", () => {
    const { camera, layer } = scene();
    layer.setRecords(
      dimRecordsOf([
        { id: "d2", kind: "dimension", ref: "arm_fl/motor", point: [0, 0, 20], to: "arm_fr/motor", toPoint: [0, 0, 20], author: "user" },
        { id: "d3", kind: "dimension", ref: "arm_fl/motor", to: "arm_fr/motor", author: "host:cli", tier: "exact", valueMm: 158.37, toleranceMm: 0.02 },
        { id: "d4", kind: "dimension", ref: "nope", to: "arm_fr/motor", author: "user" },
        { id: "d5", kind: "dimension", ref: "arm_fl/motor", to: "arm_fr/motor", author: "user", visibility: "off" },
      ]),
    );
    layer.update(camera, 1440, 900);
    const r = Object.fromEntries(layer.report().map((s) => [s.id, s]));
    expect(r.d2).toMatchObject({ status: "placed", tier: "mesh", value: 158.4 });
    expect(r.d3).toMatchObject({ tier: "exact", label: "158.4 mm ±0.02", value: 158.37 });
    expect(r.d4.status).toBe("orphan");
    expect(r.d5.status).toBe("hidden");
    layer.dispose();
  });

  it("an angle about the GPS mast's fold: NOW from the pose (62°), REST 90°, HARD STOP 95°, 0°; follows the joint live", () => {
    const { bodies, camera, layer } = scene();
    const mast = bodies.get("gps")!;
    const pose = (deg: number) => {
      // the joint's turn about Y through (0, 40, 10), on top of the assembled placement (as applyCadPose does)
      const turn = new THREE.Matrix4().makeTranslation(0, 40, 10).multiply(new THREE.Matrix4().makeRotationY(((deg - 90) * Math.PI) / 180)).multiply(new THREE.Matrix4().makeTranslation(0, -40, -10));
      mast.g.matrix.copy(turn.multiply(mast.base));
      mast.g.matrixWorldNeedsUpdate = true;
    };
    pose(62);
    layer.setRecords(dimRecordsOf([{ id: "a1", kind: "angle", ref: "gps_fold", author: "agent:claude" }]));
    layer.update(camera, 1440, 900);
    expect(layer.report()[0]).toMatchObject({ id: "a1", kind: "angle", status: "placed", label: "NOW 62°" });
    expect(layer.report()[0].value).toBeCloseTo(62, 3);
    const labels = (layer.root as unknown as FakeEl).find("dim-ang").map((e) => `${e.className}:${e.textContent}`);
    expect(labels).toEqual(["dim-ang now:NOW 62°", "dim-ang stop:HARD STOP 95°", "dim-ang rest:REST 90°", "dim-ang zero:0°"]);
    // during Assemble the joint moves: the next frame reads the new pose
    pose(80);
    layer.update(camera, 1440, 900);
    expect(layer.report()[0].value).toBeCloseTo(80, 3);
    // by the part's path too; a slider joint is listed, not drawn
    layer.setRecords(dimRecordsOf([{ id: "a2", kind: "angle", ref: "gps", author: "user" }, { id: "a3", kind: "angle", ref: "nothing", author: "user" }]));
    layer.update(camera, 1440, 900);
    expect(layer.report().map((s) => s.status)).toEqual(["placed", "orphan"]);
    layer.dispose();
  });

  it("the measure tool: two clicks, a MESH record with each point in its body's frame; the first pick shows as a dot", () => {
    const { host, camera, layer } = scene();
    const tool = new MeasureTool();
    tool.layer = layer;
    const committed: unknown[] = [];
    const picks: MeasurePick[] = [
      { ref: "arm_fl/motor", point: V(-79.2, 5, 20), hit: host.resolve("arm_fl/motor")! },
      { ref: "arm_fr/motor", point: V(79.2, -5, 20), hit: host.resolve("arm_fr/motor")! },
    ];
    tool.host = { pickAt: () => picks.shift(), commit: (r) => committed.push(r) };
    expect(tool.click(10, 10)).toBe(false);
    tool.setActive(true);
    expect(tool.click(10, 10)).toBe(true);
    layer.update(camera, 1440, 900);
    expect(layer.drawStats().dots).toBe(1);
    expect((layer.root as unknown as FakeEl).find("dim-hint")[0].textContent).toMatch(/second point/);
    tool.click(20, 20);
    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({ kind: "dimension", ref: "arm_fl/motor", to: "arm_fr/motor", point: [0, 5, 20], toPoint: [0, -5, 20], tier: "mesh", author: "user" });
    expect(parseRecord(committed[0])).toHaveProperty("record");
    tool.setActive(false);
    layer.update(camera, 1440, 900);
    expect((layer.root as unknown as FakeEl).find("dim-hint")).toHaveLength(0);
    expect(dimensionFromPicks(picks[0] ?? { ref: "a", point: V(0, 0, 0), hit: host.resolve("gps")! }, { ref: "b", point: V(1, 0, 0), hit: host.resolve("gps")! }, "x").tier).toBe("mesh");
    layer.dispose();
  });
});

describe("explode path lines", () => {
  it("one dashed line per moved part, from its assembled place to where it is; none assembled; one draw", () => {
    const root = new THREE.Group();
    const a = body("a", new THREE.Matrix4().makeTranslation(10, 0, 0), [10, 10, 10]);
    const b = body("b", new THREE.Matrix4().makeTranslation(-10, 0, 0), [10, 10, 10]);
    root.add(a.g, b.g);
    const camera = new THREE.PerspectiveCamera(40, 1.6, 1, 5000);
    camera.position.set(0, -200, 120);
    camera.lookAt(0, 0, 0);
    const paths = new ExplodePaths();
    const movers = () => pathMovers([a, b].map((x) => ({ obj: x.g, base: x.base })));
    expect(paths.update(movers(), camera, 900, 0)).toBe(0);
    expect(paths.group.visible).toBe(false);
    a.g.matrix.copy(new THREE.Matrix4().makeTranslation(0, 0, 40).multiply(a.base));
    a.g.matrixWorldNeedsUpdate = true;
    expect(paths.update(movers(), camera, 900, 0.6)).toBe(1);
    expect(paths.segment(0)).toMatchObject({ a: [10, 0, 0], b: [10, 0, 40] });
    expect(paths.group.visible).toBe(true);
    expect(paths.group.children).toHaveLength(1);
    expect(((paths.group.children[0] as THREE.LineSegments).material as THREE.LineDashedMaterial).isLineDashedMaterial).toBe(true);
    // a tiny move (under 0.5 mm) draws nothing
    a.g.matrix.copy(new THREE.Matrix4().makeTranslation(0, 0, 0.2).multiply(a.base));
    a.g.matrixWorldNeedsUpdate = true;
    expect(paths.update(movers(), camera, 900, 0.6)).toBe(0);
    // a named body moved by position inside its body
    const lid = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 1));
    b.g.add(lid);
    lid.position.set(0, 0, 25);
    const n = paths.update(pathMovers([{ obj: b.g, base: b.base, parts: [{ obj: lid, base: V(0, 0, 5) }] }]), camera, 900, 0.6);
    expect(n).toBe(1);
    expect(paths.segment(0)).toMatchObject({ a: [-10, 0, 5], b: [-10, 0, 25] });
    paths.dispose();
  });
});

describe("the callout card, closer to the concepts (concept A)", () => {
  let dom: ReturnType<typeof installFakeDom>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    dom = installFakeDom();
  });
  afterEach(() => {
    dom.restore();
    vi.useRealTimers();
  });

  it("rows: VALUE and TIER come out as the value row and tier chips; the author's pill", () => {
    expect(cardRows([["VALUE", "3.1 mm ±0.2"], ["tier", "MESH"], ["MPN", "X1"]])).toEqual({ rows: [["MPN", "X1"]], value: "3.1 mm ±0.2", tier: "mesh" });
    expect(cardRows([["TIER", "guess"]])).toEqual({ rows: [["TIER", "guess"]] });
    expect(authorPill("agent:claude")).toEqual({ kind: "agent", text: "AGENT" });
    expect(authorPill("user")).toBeUndefined();
    expect(authorPill("check:drc")?.text).toBe("CHECK");
    expect(findingText({ value: "3.1 mm ±0.2", tier: "MESH" })).toEqual({ value: "3.1 mm ±0.2", tier: "mesh" });
    expect(findingText({ value: 3.1, tier: "nope" })).toEqual({ value: "3.1" });
  });

  const setup = (parts: number, extra: Record<string, unknown>) => {
    const meshes = Array.from({ length: parts }, (_, i) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 4));
      m.position.set(i * 40 - parts * 20, 0, 2);
      m.updateMatrixWorld(true);
      return m;
    });
    const hits = meshes.map((m, i) => ({ objects: [m], box: new THREE.Box3().setFromObject(m), frame: new THREE.Matrix4(), body: `p${i}` }));
    const calls: string[] = [];
    const host: AnnotHost = {
      resolve: (ref) => hits[Number(ref.slice(1))] ?? null,
      pickOn: (ray, roots) => new THREE.Raycaster(ray.origin, ray.direction).intersectObjects(roots, true)[0]?.point,
      firstHit: () => undefined,
      onFinding: (id, a) => calls.push(`${a}:${id}`),
      onInspect: (id, ref) => calls.push(`inspect:${id}:${ref}`),
      onLookAt: (ref) => calls.push(`look:${ref}`),
    };
    const fs = findingsAnchors(meshes.map((_, i) => ({ code: "PROP_SWEEP_CLEARANCE", severity: "warning", risk: true, message: `Prop P${i} passes 3.1 mm from the camera hood.`, entity: { kind: "instance", id: `p${i}` }, ...extra })) as never, hits.map((h) => ({ key: h.body })));
    const markers = drcMarkers(fs, new Set(DEFAULT_SHOWN));
    const layer = new AnnotLayer(dom.host as unknown as HTMLElement, host);
    const camera = new THREE.PerspectiveCamera(40, 1440 / 900, 1, 2000);
    camera.position.set(0, -160, 200);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    return { layer, markers, camera, calls, fs };
  };

  it("a pinned finding: RISK · title, VALUE row, tier chips, LOOK AT / DETAILS / P N; N pins the next one", () => {
    const { layer, markers, camera, calls, fs } = setup(2, { title: "Prop close to the camera hood", summary: "Prop P2 passes 3.1 mm from the hood at full sweep.", value: "3.1 mm ±0.2", tier: "mesh" });
    const open = new Set([fs[0].id]);
    layer.setInput({ records: [], markers, open, presence: [], ghosts: true, motion: false });
    while (layer.update(camera, 1440, 900));
    const root = layer.root as unknown as FakeEl;
    const card = root.find("annot-sheet").find((e) => !e.classList.contains("closed"))!;
    expect(card.find("annot-sev-word")[0].textContent).toBe("Risk ·");
    expect(card.find("annot-title-text")[0].textContent).toBe("Prop close to the camera hood");
    expect(card.find("annot-value-v")[0].textContent).toBe("3.1 mm ±0.2");
    const tiers = card.find("annot-tier");
    expect(tiers.map((t) => t.textContent)).toEqual(["NOMINAL", "MESH", "EXACT", "MEASURED"]);
    expect(tiers.filter((t) => t.classList.contains("on")).map((t) => t.textContent)).toEqual(["MESH"]);
    expect(card.classList.contains("has-actions")).toBe(true);
    const buttons = card.find("annot-btn");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Look at the part", "Show the raw diagnostic", "Previous finding (P)", "Next finding (N)"]);
    // the Details disclosure is still there (closed), opened by the DETAILS button
    const det = card.find("annot-details")[0] as unknown as { open?: boolean };
    buttons[1].dispatchEvent(new Event("click"));
    expect(det.open).toBe(true);
    buttons[0].dispatchEvent(new Event("click"));
    expect(calls).toContain(`look:${markers.find((m) => m.findings[0].id === fs[0].id)!.anchor.body}`);
    buttons[3].dispatchEvent(new Event("click"));
    const other = fs.find((f) => f.id !== fs[0].id)!;
    expect(calls).toContain(`close:${fs[0].id}`);
    expect(calls).toContain(`open:${other.id}`);
    layer.dispose();
  });

  it("an agent's callout: the AGENT pill before its title, no 'by' line; VALUE and TIER rows drawn as on a finding card", () => {
    const { layer, camera } = setup(1, {});
    const rec = parseRecord({ id: "c1", kind: "callout", ref: "p0", author: "agent:claude", title: "U3 · PIN 1", rows: [["VALUE", "3.1 mm"], ["TIER", "exact"], ["MPN", "ICM-42688"]] });
    if (!("record" in rec) || rec.record.kind !== "callout") throw new Error("parse");
    layer.setInput({ records: [rec.record], markers: [], open: new Set(), presence: [], ghosts: true, motion: false });
    while (layer.update(camera, 1440, 900));
    const card = (layer.root as unknown as FakeEl).find("annot-sheet")[0];
    const pill = card.find("annot-pill")[0];
    expect(pill.text()).toContain("AGENT");
    expect(pill.title).toBe("claude (agent)");
    expect(card.find("annot-by")).toHaveLength(0);
    expect(card.find("annot-value-v")[0].textContent).toBe("3.1 mm");
    expect(card.find("annot-tier").filter((t) => t.classList.contains("on"))[0].textContent).toBe("EXACT");
    expect(card.find("annot-k").map((k) => k.textContent)).toEqual(["MPN", "VALUE"]);
    expect(card.find("annot-actions")).toHaveLength(0);
    layer.dispose();
  });
});
