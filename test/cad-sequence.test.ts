/**
 * Assembly sequence in the viewer (PB-1183): poseAt at t = 0, mid, 1 and
 * backwards; screws backing out at their pitch; parts riding on their parent;
 * joint limits as hard stops; isolate; the player's goto, play, loop and URL
 * state; motion clips of joint values; and the stack-planner fallback giving
 * today's result on the bottle and quad-motor fixtures.
 */
import { describe, expect, it } from "vitest";
import type { Assembly, Mat4 } from "@uhd/system/geometry.js";
import type { ModuleDef } from "@uhd/types/index.js";
import { boxGrid, planStack, type StackPart } from "../src/cad/explode";
import {
  ClipRecorder,
  SequencePlayer,
  applyPatches,
  applyPoint,
  applyUrlState,
  generateSequence,
  isSequenceFile,
  jointOnMate,
  poseAt,
  resolveSequence,
  sampleClip,
  sequenceForModel,
  sequenceFromPlan,
  sequenceUrlState,
  tAfter,
  tBefore,
  type Mat,
  type SequenceFile,
} from "../src/cad/sequence";

const T = (x: number, y: number, z: number): Mat4 => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
const def = (id: string, extra: Partial<ModuleDef> = {}): ModuleDef => ({ id, name: id, interfaces: [], ...extra }) as unknown as ModuleDef;
const bolt = (role: "structure" | "component") => ({ id: "mount", domain: "mechanical", protocols: [{ type: "bolt_pattern", roles: [role] }] });
const shaft = (role: "output" | "input") => ({ id: role === "output" ? "shaft" : "bore", domain: "mechanical", protocols: [{ type: "shaft", roles: [role] }] });

/** The core test's fixture: a plate, a motor bolted on (two screws under, two nuts on top), a hub on its shaft. */
function fixture(): Assembly {
  const screw = def("m3x10", { tags: ["fastener", "screw"], traits: [{ type: "performance", params: { thread: "M3 x 0.5" } }] } as Partial<ModuleDef>);
  const nut = def("m3-nut", { tags: ["fastener", "nut"], traits: [{ type: "performance", params: { thread: "M3 x 0.5" } }] } as Partial<ModuleDef>);
  const motor = def("motor");
  return {
    instances: [],
    placements: [
      { key: "plate", path: ["plate"], matrix: T(0, 0, 0) },
      { key: "unit/motor", path: ["unit", "motor"], matrix: T(0, 0, 2), via: "motor_mount" },
      { key: "unit/hub", path: ["unit", "hub"], matrix: T(0, 0, 22), via: "unit/hub_on_shaft" },
    ],
    mates: [
      { linkId: "motor_mount", harness: "motor_hw", a: { path: ["unit", "motor"], def: motor, iface: bolt("component"), frame: { origin: [0, 0, 0], normal: [0, 0, -1] } }, b: { path: ["plate"], def: def("plate"), iface: bolt("structure"), frame: { origin: [0, 0, 2], normal: [0, 0, 1] } } },
      { linkId: "unit/hub_on_shaft", a: { path: ["unit", "motor"], def: motor, iface: shaft("output"), frame: { origin: [0, 0, 20], normal: [0, 0, 1] } }, b: { path: ["unit", "hub"], def: def("hub"), iface: shaft("input"), frame: { origin: [0, 0, 0], normal: [0, 0, -1] } } },
    ],
    routes: [],
    hardware: [
      { harness: "motor_hw", child: "screws", def: screw, linkId: "motor_mount", matrix: T(-5, 0, -1), structure: "plate", mounted: "unit/motor", atMm: -3, direction: 1 },
      { harness: "motor_hw", child: "screws", def: screw, linkId: "motor_mount", matrix: T(5, 0, -1), structure: "plate", mounted: "unit/motor", atMm: -3, direction: 1 },
      { harness: "motor_hw", child: "nuts", def: nut, linkId: "motor_mount", matrix: T(-5, 0, 8), structure: "plate", mounted: "unit/motor", atMm: 6, direction: 1 },
      { harness: "motor_hw", child: "nuts", def: nut, linkId: "motor_mount", matrix: T(5, 0, 8), structure: "plate", mounted: "unit/motor", atMm: 6, direction: 1 },
    ],
    harnesses: [],
    unrouted: [],
    issues: [],
  } as unknown as Assembly;
}

const GAP = 10;
const file = generateSequence(fixture(), { root: ["plate"] });
const resolved = resolveSequence({ assembly: fixture(), gap: GAP }, file);
const at = (m: Mat | undefined, p: [number, number, number] = [0, 0, 0]) => (m ? applyPoint(m, p) : p);
const near = (a: number[], b: number[]) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 6));

describe("sequence resolve and poseAt", () => {
  it("flattens the sub-assembly first, and windows the steps backwards in explode time", () => {
    expect(resolved.steps.map((s) => s.id)).toEqual(["fit:unit/hub_on_shaft", "fit:motor_mount", "fasten:motor_mount"]);
    // the last assembled step comes out first
    expect(resolved.windows[2][0]).toBe(0);
    expect(resolved.windows[0][1]).toBeCloseTo(1);
    expect(resolved.unknown).toEqual([]);
  });

  it("is the assembled model at t = 0", () => {
    expect(poseAt(resolved, { t: 0 }).size).toBe(0);
  });

  it("is fully apart at t = 1: ranks times the gap along the joint, parts riding on their parent", () => {
    const pose = poseAt(resolved, { t: 1 });
    // motor: rank 1 along the plate's +Z
    near(at(pose.get("unit/motor")), [0, 0, GAP]);
    // the hub slides 1.6 gaps up its shaft (an insert), on top of the motor's own travel
    near(at(pose.get("unit/hub")), [0, 0, GAP + 1.6 * GAP]);
    // screws under the plate leave downward one gap; nuts on top two gaps up; both ride on the plate (which stays)
    near(at(pose.get("motor_hw/screws#1"), [-5, 0, -1]), [-5, 0, -1 - GAP]);
    near(at(pose.get("motor_hw/nuts#2"), [5, 0, 8]), [5, 0, 8 + 2 * GAP]);
  });

  it("explodes backwards: mid-way the fasteners are out and the hub is still on", () => {
    const [a, b] = resolved.windows[2]; // fasten: first out
    const pose = poseAt(resolved, { t: b });
    near(at(pose.get("motor_hw/nuts#1"), [-5, 0, 8]), [-5, 0, 8 + 2 * GAP]);
    expect(pose.has("unit/motor")).toBe(false);
    expect(pose.has("unit/hub")).toBe(false);
    expect(a).toBe(0);
    // half-way through the motor's own step
    const [c, d] = resolved.windows[1];
    const half = poseAt(resolved, { t: (c + d) / 2 });
    near(at(half.get("unit/motor")), [0, 0, GAP / 2]);
    // the hub rides along with it, not yet off its shaft
    near(at(half.get("unit/hub")), [0, 0, GAP / 2]);
  });

  it("backs a screw out at its pitch while it turns, then lifts it", () => {
    const step = resolved.steps[2];
    const screw = step.members.find((m) => m.ref === "motor_hw/screws#2")!;
    expect(screw.turns).toBe(3);
    expect(screw.pitchMm).toBe(0.5);
    // isolate the fasten step and stop at the end of the unscrew phase (no stagger lag on the last member? it has one)
    const share = resolved.defaults.unscrewShare;
    const pose = poseAt({ ...resolved, steps: [{ ...step, members: [{ ...screw, delay: 0 }], ease: "linear" }], windows: [[0, 1]] }, { t: share });
    // travelled exactly turns × pitch = 1.5 mm down its axis (it leaves along -Z), turned 3 whole turns
    near(at(pose.get("motor_hw/screws#2"), [5, 0, -1]), [5, 0, -1 - 1.5]);
    // a point off the screw's axis comes back where it was after whole turns, less the travel
    near(at(pose.get("motor_hw/screws#2"), [6, 0, -1]), [6, 0, -2.5]);
    // a quarter of the way through unscrewing: 3/4 turn about -Z (loosening, right-hand), seen from below the head
    const q = poseAt({ ...resolved, steps: [{ ...step, members: [{ ...screw, delay: 0 }], ease: "linear" }], windows: [[0, 1]] }, { t: share / 4 });
    const p = at(q.get("motor_hw/screws#2"), [6, 0, -1]);
    // 0.75 turn = 270° about -Z: (1,0) → (0,1) relative to the axis
    near([p[0] - 5, p[1], p[2]], [0, 1, -1 - 0.375]);
  });

  it("isolates one step", () => {
    const pose = poseAt(resolved, { t: 1, isolate: "fit:motor_mount" });
    near(at(pose.get("unit/motor")), [0, 0, GAP]);
    expect(pose.has("motor_hw/nuts#1")).toBe(false);
  });

  it("drives a joint within its hard stops, and the rest rides along", () => {
    const patched = applyPatches(file, [{ sequence: "unit", edits: [{ joint: { id: "spin", type: "revolute", part: "unit/hub", along: { mate: "unit/hub_on_shaft", end: "parent" }, min: -45, max: 90 } }] }]).file;
    const r = resolveSequence({ assembly: fixture(), gap: GAP }, patched);
    expect(r.joints).toHaveLength(1);
    const player = new SequencePlayer(r);
    expect(player.driveJoint("spin", 400)).toBe(90);
    expect(player.driveJoint("spin", -400)).toBe(-45);
    player.driveJoint("spin", 90);
    const pose = player.pose();
    // a point 1 mm off the shaft turns 90° about +Z (the shaft frame's normal)
    near(at(pose.get("unit/hub"), [1, 0, 22]), [0, 1, 22]);
    // the joint pose holds while exploding: the hub keeps its angle and travels up
    player.set({ t: 1 });
    near(at(player.pose().get("unit/hub"), [1, 0, 22]), [0, 1, 22 + GAP + 1.6 * GAP]);
    // an ad-hoc joint on a mate has no stops
    const slide = jointOnMate(fixture(), "motor_mount", "slider")!;
    expect([slide.min, slide.max, slide.part]).toEqual([undefined, undefined, "unit/motor"]);
    player.addJoint(slide);
    expect(player.driveJoint("motor_mount", 1000)).toBe(1000);
  });
});

describe("sequence player", () => {
  it("goes to the state before and after a step", () => {
    const p = new SequencePlayer(resolved);
    expect(p.goto("fit:motor_mount")).toBe(true);
    expect(p.t).toBeCloseTo(tBefore(resolved, "fit:motor_mount")!);
    expect(p.goto("nope")).toBe(false);
    expect(p.run({ action: "goto", step: "nope" })).toMatchObject({ ok: false });
  });

  it("plays a step going on, then stops; loops ping-pong", () => {
    const p = new SequencePlayer(resolved);
    expect(p.run({ action: "play", mode: "assemble", from: "fit:motor_mount", to: "fasten:motor_mount" }).ok).toBe(true);
    expect(p.t).toBeCloseTo(tBefore(resolved, "fit:motor_mount")!);
    let frames = 0;
    while (p.tick(1 / 60) && frames < 10_000) frames++;
    expect(p.t).toBeCloseTo(tAfter(resolved, "fasten:motor_mount")!);
    expect(p.playing).toBeUndefined();
    // about two steps' time at 60 fps
    expect(frames).toBeGreaterThan(60);
    p.loop(true, "explode");
    for (let i = 0; i < 2000; i++) p.tick(1 / 60);
    expect(p.snapshot().loop).toBe(true);
    expect(p.playing).toBeDefined();
  });

  it("reads the URL: ?step=…&play=assemble starts with the step out and plays it on", () => {
    const url = sequenceUrlState("?step=fit:motor_mount&play=assemble&loop=0&levels=one");
    expect(url).toEqual({ step: "fit:motor_mount", play: "assemble", loop: false, levels: "one", t: undefined });
    const p = new SequencePlayer(resolved);
    expect(applyUrlState(p, url).ok).toBe(true);
    expect(p.playing).toBe("assemble");
    expect(p.t).toBeCloseTo(tBefore(resolved, "fit:motor_mount")!);
    const snap = p.snapshot();
    expect(snap.steps).toHaveLength(3);
    expect(snap.source).toBe("file");
  });

  it("records joint values, not matrices, and replays them", () => {
    const rec = new ClipRecorder(["spin"]);
    rec.sample(10, { spin: 0 }, 0);
    rec.sample(11, { spin: 90 }, 0.5);
    rec.sample(12, { spin: 0 }, 1);
    const clip = rec.finish(true);
    expect(clip.samples.map((s) => s.t)).toEqual([0, 1, 2]);
    expect(JSON.stringify(clip).length).toBeLessThan(200);
    expect(sampleClip(clip, 0.5).joints.spin).toBeCloseTo(45);
    expect(sampleClip(clip, 0.5).x).toBeCloseTo(0.25);
    // looped: wraps
    expect(sampleClip(clip, 2.5).joints.spin).toBeCloseTo(45);
    expect(sampleClip({ ...clip, loop: false }, 5)).toMatchObject({ done: true });
  });
});

describe("where the sequence comes from", () => {
  it("generates from the model's mates when the bundle has no built file", () => {
    expect(sequenceForModel(fixture(), ["plate"])?.sequences[0].steps.map((s) => s.id)).toEqual(["fit:motor_mount", "fasten:motor_mount"]);
    expect(sequenceForModel({ ...fixture(), mates: [] } as Assembly, [])).toBeUndefined();
    expect(isSequenceFile(file)).toBe(true);
    expect(isSequenceFile({ schema: "x" })).toBe(false);
  });

  it("leaves members the model lacks out and says so", () => {
    const stale: SequenceFile = JSON.parse(JSON.stringify(file));
    stale.sequences[0].steps[1].members.push({ ref: "gone#1" });
    expect(resolveSequence({ assembly: fixture(), gap: GAP }, stale).unknown).toEqual(["gone#1"]);
  });
});

// ---- the stack planner fallback: the bottle and quad-motor fixtures of explode.test.ts --------------------
type Box = { u: [number, number]; v: [number, number]; z: [number, number] };
function part(key: string, boxes: Box[]): StackPart {
  const outline: [number, number, number, number] = [Math.min(...boxes.map((b) => b.u[0])), Math.max(...boxes.map((b) => b.u[1])), Math.min(...boxes.map((b) => b.v[0])), Math.max(...boxes.map((b) => b.v[1]))];
  const lo = Math.min(...boxes.map((b) => b.z[0]));
  const hi = Math.max(...boxes.map((b) => b.z[1]));
  return { key, lo, hi, mid: (lo + hi) / 2, outline, grid: boxGrid(outline, boxes, 24) };
}
const square = (r: number, z: [number, number]): Box => ({ u: [-r, r], v: [-r, r], z });
const walls = (r: number, t: number, z: [number, number]): Box[] => [
  { u: [-r, -r + t], v: [-r, r], z },
  { u: [r - t, r], v: [-r, r], z },
  { u: [-r, r], v: [-r, -r + t], z },
  { u: [-r, r], v: [r - t, r], z },
];
const surrounds = (holder: StackPart, p: StackPart) => holder.outline[0] < p.outline[0] - 0.5 && holder.outline[1] > p.outline[1] + 0.5 && holder.outline[2] < p.outline[2] - 0.5 && holder.outline[3] > p.outline[3] + 0.5;
const empty = { instances: [], placements: [], mates: [], routes: [], hardware: [], harnesses: [], unrouted: [], issues: [] } as unknown as Assembly;

describe("stack planner fallback (no mates)", () => {
  const cases: [string, StackPart[]][] = [
    [
      "bottle",
      [
        part("bottle", [square(40, [0, 2]), ...walls(40, 2, [0, 220]), ...walls(28, 3, [220, 250])]),
        part("lip_seal", walls(26, 3, [245, 250])),
        part("cap", [...walls(32, 3, [230, 262]), square(32, [258, 262]), ...walls(42, 3, [262, 290]), square(42, [260, 262])]),
        part("cell", [square(20, [263, 275])]),
        part("board", [square(35, [278, 280])]),
        part("lid", [square(42, [290, 295])]),
        part("probe", [square(3, [100, 270])]),
      ],
    ],
    [
      "quad motors",
      [
        part("frame", [{ u: [-100, 100], v: [-5, 5], z: [0, 4] }, { u: [-5, 5], v: [-100, 100], z: [0, 4] }, square(20, [0, 30])]),
        part("motor_a", [{ u: [85, 100], v: [-7, 7], z: [4, 20] }]),
        part("motor_b", [{ u: [-100, -85], v: [-7, 7], z: [4, 20] }]),
      ],
    ],
  ];
  for (const [name, parts] of cases) {
    it(`fully exploded is the planner's rise for every part (${name})`, () => {
      const rise = planStack(parts, { gap: 10, surrounds });
      const r = resolveSequence({ assembly: empty, gap: 10, planned: rise }, sequenceFromPlan(rise), "planner");
      const pose = poseAt(r, { t: 1 });
      for (const p of parts) near(at(pose.get(p.key)), [0, 0, rise.get(p.key)!]);
      // assembly order is the planner's, lowest first; parts that rise 0 take no time
      const order = r.steps.map((s) => s.members[0].ref);
      const rises = order.map((k) => rise.get(k)!);
      expect([...rises].sort((a, b) => a - b)).toEqual(rises);
      expect(r.steps.filter((s) => s.still).map((s) => s.members[0].ref).sort()).toEqual(parts.filter((p) => rise.get(p.key) === 0).map((p) => p.key).sort());
      // and exploding takes the top part off first
      const top = order.at(-1)!;
      const early = poseAt(r, { t: 0.05 });
      expect(early.has(top)).toBe(true);
      expect(early.has(order[0])).toBe(false);
    });
  }
});

describe("planner sampling on BVHs (explodeSample)", () => {
  it("samples a part's top and bottom, instanced copies included, and the stack plan over them", async () => {
    const THREE = await import("three");
    const { planStackRises, sampleStackPart } = await import("../src/cad/explodeSample");
    const box = (w: number, h: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, w, h), new THREE.MeshStandardMaterial());
      m.position.set(0, 0, z + h / 2);
      m.updateMatrixWorld(true);
      return m;
    };
    const base = box(40, 4, 0);
    const lid = box(30, 2, 4);
    const up = new THREE.Vector3(0, 0, 1);
    const s = sampleStackPart("lid", [lid], new Set(), up, 6)!;
    expect(s.lo).toBeCloseTo(4);
    expect(s.hi).toBeCloseTo(6);
    expect(Math.max(...[...s.grid.top].filter((x) => !Number.isNaN(x)))).toBeCloseTo(6, 3);
    expect(Math.min(...[...s.grid.bottom].filter((x) => !Number.isNaN(x)))).toBeCloseTo(4, 3);
    // an instanced copy far off to the side is sampled too
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial(), 2);
    inst.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 0, 1));
    inst.setMatrixAt(1, new THREE.Matrix4().makeTranslation(10, 0, 1));
    inst.updateMatrixWorld(true);
    const pegs = sampleStackPart("pegs", [inst], new Set(), up, 12)!;
    expect(pegs.grid.top.filter((x) => !Number.isNaN(x)).length).toBeGreaterThan(1);
    const rise = planStackRises([{ key: "base", objects: [base], skip: new Set() }, { key: "lid", objects: [lid], skip: new Set() }], up, 5);
    expect(rise.get("base")).toBe(0);
    expect(rise.get("lid")).toBeCloseTo(5);
  });
});
