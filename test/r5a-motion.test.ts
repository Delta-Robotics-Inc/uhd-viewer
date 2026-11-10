/**
 * Wave R5-A (2026-11-02): one motion model for Explode and Assemble, the player's speed and direction, no autostart
 * on a switch, the independent toggles and the motion controller.
 *
 * Kevin: "Make the assembly use the same explode as the explode. Then the difference is that it assembles in order."
 * "I want a speed adjustment for assemblies/explodes." "If you switch mid animation, the assembly does not autostart;
 * you have to click play to continue." "You should be able to select direction of assembly." "The explode and
 * assembly buttons are individual on and off toggles, not one or the other."
 *
 * Fixtures: the core sequence test's plate + motor (two screws under, two nuts on top) + hub on its shaft, resolved
 * from its mates, with a radial plan beside it (each part's path, as CadView's resolveForCad makes one: the plate is
 * the base, a cable no step names), and R3-A's board plan (a board drawn as an assembly).
 */
import { describe, expect, it } from "vitest";
import type { Assembly, Mat4 } from "@uhd/system/geometry.js";
import type { ModuleDef } from "@uhd/types/index.js";
import { planBoard, withBoard, type BoardPartInput } from "../src/cad/assembly";
import { radialEase, type RadialMove } from "../src/cad/explode";
import { EXPLODE_TRAVEL_S, MotionController, SPEEDS, SequencePlayer, generateSequence, hardwareKeys, resolveSequence, type Mat, type ResolvedWithRadial, type SequenceCommand } from "../src/cad/sequence";

const T = (x: number, y: number, z: number): Mat4 => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
const def = (id: string, extra: Partial<ModuleDef> = {}): ModuleDef => ({ id, name: id, interfaces: [], ...extra }) as unknown as ModuleDef;
const bolt = (role: "structure" | "component") => ({ id: "mount", domain: "mechanical", protocols: [{ type: "bolt_pattern", roles: [role] }] });
const shaft = (role: "output" | "input") => ({ id: role === "output" ? "shaft" : "bore", domain: "mechanical", protocols: [{ type: "shaft", roles: [role] }] });

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

/** The fixture resolved from its mates with a radial plan beside it: every part a path, some unlike its step's own. */
function resolved(): ResolvedWithRadial {
  const asm = fixture();
  const r = resolveSequence({ assembly: asm, gap: 10 }, generateSequence(asm, { root: ["plate"] }), "generated") as ResolvedWithRadial;
  const moves = new Map<string, RadialMove>([
    ["plate", { dir: [0, 0, -1], distance: 30, from: "up" }],
    ["unit/motor", { dir: [1, 0, 0], distance: 40, from: "face" }],
    ["unit/hub", { dir: [0, 0, 1], distance: 50, from: "sequence" }],
    // a part no step names (a cable tie, say): it goes in a final step
    ["tie", { dir: [0, 1, 0], distance: 20, from: "centre" }],
  ]);
  hardwareKeys(asm.hardware).forEach((k, i) => moves.set(k!, { dir: i < 2 ? [0, 0, -1] : [0, 0, 1], distance: 25 + i, from: "face" }));
  r.radial = { moves, centre: [0, 0, 10], radius: 60, ms: 0 };
  r.baseParts = ["plate"];
  return r;
}

const at = (m: Mat | undefined): [number, number, number] => (m ? [m[12], m[13], m[14]] : [0, 0, 0]);
const close = (a: readonly number[], b: readonly number[], d = 6) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], d));
const same = (p: Map<string, Mat>, q: Map<string, Mat>, keys: Iterable<string>) => {
  for (const k of keys) close(at(p.get(k)), at(q.get(k)));
};
/** Tick until nothing moves (or `max` seconds); returns the seconds it took. */
const run = (p: SequencePlayer, dt = 1 / 120, max = 60) => {
  let s = 0;
  while (p.tick(dt) && s < max) s += dt;
  return s;
};

describe("one motion model: Assemble moves the parts along Explode's paths", () => {
  it("puts the base in a first step and a part no step names in a final one (DEFAULT)", () => {
    const p = new SequencePlayer(resolved());
    const ids = p.resolved.steps.map((s) => s.id);
    expect(ids[0]).toBe("place:base");
    expect(ids.at(-1)).toBe("fit:rest");
    expect(p.resolved.steps[0].members.map((m) => m.ref)).toEqual(["plate"]);
    expect(p.resolved.steps.at(-1)!.members.map((m) => m.ref)).toEqual(["tie"]);
    expect(p.resolved.windows.length).toBe(ids.length);
    // the base comes off last (its window ends the explode), the final step first
    expect(p.resolved.windows[0][1]).toBeCloseTo(1, 9);
    expect(p.resolved.windows.at(-1)![0]).toBeCloseTo(0, 9);
  });

  it("assemble fully out is explode at t = 1, for every part", () => {
    const r = resolved();
    const ex = new SequencePlayer(r);
    const as = new SequencePlayer(r);
    as.setMode("sequence", { instant: true });
    ex.set({ t: 1 });
    as.set({ t: 1 });
    const keys = [...r.radial!.moves.keys()];
    expect(keys.length).toBe(8);
    const a = as.pose();
    const e = ex.pose();
    same(a, e, keys);
    for (const k of keys) {
      const m = r.radial!.moves.get(k)!;
      close(at(e.get(k)), m.dir.map((x) => x * m.distance));
    }
    // and both ends of a play give the same pose in either mode
    same(ex.endPose("apart"), as.endPose("apart"), keys);
    same(ex.endPose("together"), as.endPose("together"), keys);
  });

  it("mid-way, Assemble has the later steps out and the first ones home, each part on its own path only", () => {
    const r = resolved();
    const p = new SequencePlayer(r);
    p.setMode("sequence", { instant: true });
    p.set({ t: 0.5 });
    const pose = p.pose();
    // the tie (last on) is all the way out; the plate (the base, first on) is home
    close(at(pose.get("tie")), [0, 20, 0]);
    expect(pose.has("plate")).toBe(false);
    for (const [k, m] of pose) {
      const mv = r.radial!.moves.get(k)!;
      const v = at(m);
      const len = Math.hypot(...v);
      // along its path: the offset is its direction times a share of its distance
      close(v, mv.dir.map((x) => x * len));
      expect(len).toBeLessThanOrEqual(mv.distance + 1e-9);
    }
  });

  it("the Explode mode is every part at once on one ease, as before", () => {
    const r = resolved();
    const p = new SequencePlayer(r);
    p.set({ t: 0.3 });
    for (const [k, m] of r.radial!.moves) close(at(p.pose().get(k)), m.dir.map((x) => x * m.distance * radialEase(0.3)));
    expect(p.reach()).toBe(50);
    p.setMode("sequence", { instant: true });
    expect(p.reach()).toBe(50);
  });

  it("a board drawn as an assembly: the steps follow the board plan's paths too", () => {
    const part = (key: string, side: "top" | "bottom", height: number, x = 0): BoardPartInput => ({ key, side, height, box: [[x, 0, side === "top" ? 1.6 : -height], [x + 1, 1, side === "top" ? 1.6 + height : 0]] });
    const empty: ResolvedWithRadial = { steps: [], parents: new Map(), joints: [], defaults: { durationS: 1.2, maxTurns: 3, unscrewShare: 0.45 }, source: "planner", unknown: [], windows: [] };
    const plan = planBoard([part("power/r21", "top", 0.5), part("usb/usbc", "top", 3.2, 5), part("power/j1", "bottom", 11, 9)], [{ prefix: "power", title: "Power" }, { prefix: "usb", title: "USB" }], [0, 0, 1], 100);
    const merged = withBoard(empty, plan, "");
    const ex = new SequencePlayer(merged);
    const as = new SequencePlayer(merged);
    as.setMode("sequence", { instant: true });
    ex.set({ t: 1 });
    as.set({ t: 1 });
    same(as.pose(), ex.pose(), merged.radial!.moves.keys());
  });

  it("without a radial plan the steps keep their own offsets (a bare resolution)", () => {
    const asm = fixture();
    const bare = resolveSequence({ assembly: asm, gap: 10 }, generateSequence(asm, { root: ["plate"] }));
    const p = new SequencePlayer(bare);
    expect(p.paths()).toBeUndefined();
    expect(p.resolved).toBe(bare);
  });
});

describe("speed", () => {
  it("scales an explode (1x is 1.4 s) and the steps (1x is their durations)", () => {
    for (const x of SPEEDS) {
      const p = new SequencePlayer(resolved());
      p.setSpeed(x);
      p.setExplode(true);
      expect(p.playing).toBe("explode");
      expect(run(p, 1 / 240)).toBeCloseTo(EXPLODE_TRAVEL_S / x, 1);
      expect(p.t).toBe(1);
    }
    const p = new SequencePlayer(resolved());
    const steps = p.durationS;
    expect(steps).toBeCloseTo(1.2 * p.resolved.steps.filter((s) => !s.still).length, 9);
    for (const x of [0.5, 4]) {
      const q = new SequencePlayer(resolved());
      q.setSpeed(x);
      q.setAssemble(true);
      expect(run(q, 1 / 240)).toBeCloseTo(steps / x, 1);
    }
  });
  it("is held between its bounds; an agent's bad speed is refused", () => {
    const p = new SequencePlayer(resolved());
    expect(p.setSpeed(1000)).toBe(16);
    expect(p.setSpeed(0.001)).toBe(0.05);
    expect(p.run({ action: "speed", x: -1 }).ok).toBe(false);
    expect(p.run({ action: "speed", x: 2 }).ok).toBe(true);
    expect(p.snapshot().motion.speed).toBe(2);
  });
  it("changes a running play's pace without stopping it", () => {
    const p = new SequencePlayer(resolved());
    p.setExplode(true);
    p.tick(0.2);
    const t0 = p.t;
    p.setSpeed(2);
    expect(p.playing).toBe("explode");
    p.tick(0.1);
    expect(p.t - t0).toBeCloseTo((0.1 * 2) / EXPLODE_TRAVEL_S, 9);
  });
});

describe("direction", () => {
  it("assemble together comes together in step order; apart goes out in the reverse order", () => {
    const p = new SequencePlayer(resolved());
    p.setMode("sequence", { instant: true });
    p.set({ t: 1 });
    p.setDirection("together");
    p.resume();
    // the first thing to go on is the base (first step), last the tie
    p.tick(0.6);
    const early = p.pose();
    expect(Math.hypot(...at(early.get("plate")))).toBeLessThan(30);
    close(at(early.get("tie")), [0, 20, 0]);
    run(p);
    expect(p.t).toBe(0);
    // apart: the last step (the tie) leaves first, the base last
    p.setDirection("apart");
    p.resume();
    p.tick(0.6);
    const out = p.pose();
    expect(Math.hypot(...at(out.get("tie")))).toBeGreaterThan(0);
    expect(out.has("plate")).toBe(false);
  });

  it("reversing mid-play pauses where the parts are; Play goes back the other way from there", () => {
    const p = new SequencePlayer(resolved());
    p.setAssemble(true); // from assembled: takes the parts apart in the reverse order
    expect(p.direction).toBe("apart");
    p.tick(1.5);
    const t = p.t;
    const pose = p.pose();
    p.setDirection("together");
    expect(p.playing).toBeUndefined();
    expect(p.tick(0.5)).toBe(false);
    expect(p.t).toBe(t);
    same(p.pose(), pose, pose.keys());
    p.resume();
    p.tick(0.1);
    expect(p.t).toBeLessThan(t);
    run(p);
    expect(p.t).toBe(0);
  });

  it("explode's direction: apart explodes, together collapses; Play at the end turns round (no jump)", () => {
    const p = new SequencePlayer(resolved());
    p.setExplode(true);
    run(p);
    expect(p.t).toBe(1);
    p.run({ action: "direction", to: "together" });
    p.run({ action: "resume" });
    expect(p.playing).toBe("assemble");
    run(p);
    expect(p.t).toBe(0);
    // wave R5 gate: at the end Play flips the direction and plays back from where the parts are (it jumped to t = 1)
    p.run({ action: "resume" });
    expect(p.t).toBe(0);
    expect(p.direction).toBe("apart");
    expect(p.playing).toBe("explode");
    run(p);
    expect(p.t).toBe(1);
    expect(p.run({ action: "direction", to: "sideways" as never }).ok).toBe(false);
  });
});

describe("a switch mid-animation keeps the pose and waits for Play", () => {
  it("Explode playing, Assemble turned on: paused where every part is; Play goes on from there in step order", () => {
    const p = new SequencePlayer(resolved());
    p.setExplode(true);
    p.tick(0.5);
    const was = p.pose();
    const keys = [...was.keys()];
    p.setAssemble(true);
    expect(p.explodeMode).toBe("sequence");
    expect(p.playing).toBeUndefined();
    expect(p.anchored).toBe(true);
    expect(p.direction).toBe("together");
    same(p.pose(), was, keys);
    // nothing autostarts
    expect(p.tick(0.5)).toBe(false);
    same(p.pose(), was, keys);
    // Play: from where the parts are, no jump, then all together
    p.resume();
    expect(p.playing).toBe("assemble");
    p.tick(1 / 120);
    for (const k of keys) expect(Math.hypot(...at(p.pose().get(k)).map((v, i) => v - at(was.get(k))[i]))).toBeLessThan(1);
    // every part only comes in (never further out than it was)
    for (let i = 0; i < 40; i++) {
      p.tick(0.1);
      for (const k of keys) expect(Math.hypot(...at(p.pose().get(k)))).toBeLessThanOrEqual(Math.hypot(...at(was.get(k))) + 1e-6);
    }
    run(p);
    expect(p.t).toBe(0);
    expect(p.anchored).toBe(false);
    for (const k of keys) close(at(p.pose().get(k)), [0, 0, 0]);
  });

  it("Assemble playing, Assemble turned off with Explode on: paused; Play goes on all at once", () => {
    const p = new SequencePlayer(resolved());
    p.setExplode(true);
    run(p);
    p.setAssemble(true); // from fully out at rest: assembles once
    expect(p.playing).toBe("assemble");
    p.tick(1.0);
    const was = p.pose();
    p.setAssemble(false);
    expect(p.explodeMode).toBe("radial");
    expect(p.playing).toBeUndefined();
    same(p.pose(), was, was.keys());
    expect(p.tick(0.3)).toBe(false);
    p.resume();
    run(p);
    expect(p.t).toBe(0);
  });

  it("a host's mode change (the view state's explode.mode) also keeps the pose, paused", () => {
    const p = new SequencePlayer(resolved());
    p.setExplode(true);
    p.tick(0.4);
    const was = p.pose();
    expect(p.run({ action: "mode", mode: "sequence" }).ok).toBe(true);
    expect(p.playing).toBeUndefined();
    expect(p.assembleOn).toBe(true);
    same(p.pose(), was, was.keys());
  });

  it("a scrub drops the kept pose (the timeline jumps to the mode's own pose at t)", () => {
    const p = new SequencePlayer(resolved());
    p.setExplode(true);
    p.tick(0.5);
    p.setAssemble(true);
    expect(p.anchored).toBe(true);
    p.set({ t: 1 });
    expect(p.anchored).toBe(false);
    close(at(p.pose().get("tie")), [0, 20, 0]);
  });
});

describe("the two toggles", () => {
  it("are independent; turned on from rest each plays once", () => {
    const p = new SequencePlayer(resolved());
    p.run({ action: "toggle", explode: true });
    expect(p.snapshot().motion).toMatchObject({ explode: true, assemble: false, direction: "apart", playing: true });
    run(p);
    // both on: Assemble drives (the steps), Explode is its fully-out pose; from rest at fully out it assembles
    p.run({ action: "toggle", assemble: true });
    expect(p.snapshot().motion).toMatchObject({ explode: true, assemble: true, direction: "together", playing: true });
    expect(p.explodeMode).toBe("sequence");
    run(p);
    // Explode off while Assemble is on: nothing moves
    p.run({ action: "toggle", explode: false });
    expect(p.playing).toBeUndefined();
    expect(p.snapshot().motion).toMatchObject({ explode: false, assemble: true });
  });

  it("Assemble on from assembled takes the parts apart in the reverse order (somewhere to go)", () => {
    const p = new SequencePlayer(resolved());
    p.setAssemble(true);
    expect(p.direction).toBe("apart");
    expect(p.playing).toBe("explode");
  });

  it("both off: the parts go home all at once from where they are", () => {
    const p = new SequencePlayer(resolved());
    p.setAssemble(true);
    p.tick(2);
    p.setAssemble(false);
    expect(p.explodeMode).toBe("radial");
    expect(p.direction).toBe("together");
    expect(p.playing).toBe("assemble");
    run(p);
    expect(p.t).toBe(0);
    for (const m of p.pose().values()) close([m[12], m[13], m[14]], [0, 0, 0]);
  });

  it("an explode amount set with both off (an agent's explode t, a URL) turns the mode in force on", () => {
    const p = new SequencePlayer(resolved());
    p.set({ t: 1 });
    expect(p.explodeOn).toBe(true);
    // without a radial plan the mode is the steps: Assemble comes on
    const asm = fixture();
    const q = new SequencePlayer(resolveSequence({ assembly: asm, gap: 10 }, generateSequence(asm, { root: ["plate"] })));
    q.set({ t: 0.4 });
    expect(q.assembleOn).toBe(true);
    expect(q.explodeOn).toBe(false);
  });

  it("a toggle command turning one on and the other off never sends the parts home in between", () => {
    const p = new SequencePlayer(resolved());
    p.setExplode(true);
    run(p);
    p.run({ action: "toggle", explode: false, assemble: true });
    expect(p.snapshot().motion).toMatchObject({ explode: false, assemble: true, direction: "together" });
    expect(p.playing).toBe("assemble");
    expect(p.run({ action: "toggle", explode: "yes" as never }).ok).toBe(false);
  });
});

describe("the motion controller (CadView's, the toolbar's and the timeline's)", () => {
  it("drives the player through the command runner, writes the view state and tells its listeners", () => {
    const p = new SequencePlayer(resolved());
    const cmds: SequenceCommand[] = [];
    const writes: { ops: unknown[]; label: string }[] = [];
    const m = new MotionController({ player: () => p, run: (c) => (cmds.push(c), p.run(c)), write: (ops, label) => writes.push({ ops, label }) });
    let heard = 0;
    const off = m.subscribe(() => heard++);
    expect(m.state()).toMatchObject({ ready: true, explode: false, assemble: false, playing: false });
    m.setExplode(true);
    expect(cmds.at(-1)).toEqual({ action: "toggle", explode: true });
    expect(m.state()).toMatchObject({ explode: true, playing: true, mode: "radial" });
    expect(writes.at(-1)).toEqual({ ops: [{ op: "explode", t: 0, mode: "radial", step: null, on: true, assemble: false }], label: "explode on" });
    p.tick(0.3);
    m.toggleAssemble();
    expect(m.state()).toMatchObject({ explode: true, assemble: true, mode: "sequence", playing: false, anchored: true });
    m.togglePlay();
    expect(m.state().playing).toBe(true);
    m.pause();
    expect(m.state().playing).toBe(false);
    m.setSpeed(4);
    m.stepSpeed(-1);
    expect(m.state().speed).toBe(2);
    m.flipDirection();
    expect(m.state().direction).toBe("apart");
    expect(heard).toBeGreaterThanOrEqual(7);
    p.tick(0.1);
    off();
  });

  it("reports everything off until the player exists", () => {
    const m = new MotionController({ player: () => null, run: () => ({ ok: false, error: "the model is still loading" }) });
    expect(m.state()).toMatchObject({ ready: false, explode: false, assemble: false });
    expect(m.setExplode(true).ok).toBe(false);
  });
});
