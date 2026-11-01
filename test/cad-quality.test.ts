/**
 * The interaction quality curve, attention foveation and the view lifecycle
 * (PB-1176), in node: the controller as a pure function of frame-time
 * sequences (degrade and recover timings, hysteresis, flip lock, floor and
 * hard threshold, bottleneck), the foveation set, the coarse tier pairing,
 * the merge, the batcher's policy, the GPU timer, the snapshot callback and
 * suspend/resume, the live-view budget.
 */
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import {
  DEFAULT_QUALITY,
  LADDER,
  QualityController,
  bottleneckOf,
  dprFor,
  frameTimeOf,
  knobUseful,
  restoreTimes,
  simulate,
  type Availability,
  type SimEvent,
} from "../src/cad/render/quality/controller";
import { Attention, focusRect, focusedBoxes, isLit, keyCovers } from "../src/cad/render/quality/attention";
import { CoarseTier, coarseUrl, pairCoarse, triangleCount } from "../src/cad/render/quality/coarse";
import { MERGE_MAX_TRIANGLES, buildMerged, mergeable } from "../src/cad/render/quality/merge";
import { GpuTimer, type TimerGl } from "../src/cad/render/quality/gpuTimer";
import { ViewLifecycle, type LifecycleDeps } from "../src/cad/render/quality/lifecycle";
import { budgetFromPeriod, liveViewsFor, viewsToSuspend } from "../src/cad/render/quality/benchmark";
import { Batcher, LOGICAL_LAYER } from "../src/cad/render/batch";
import { setMeshLook } from "../src/cad/render/looks";
import { normaliseSidecar } from "../src/cad/render/sidecar";
import { createFrameLoop, type FrameInfo } from "../src/cad/render/loop";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { LoadedModel } from "../src/cad/render/glbCache";

const B60 = 1000 / 60;
const ALL: Availability = { effects: true, baseDpr: 2, coarse: true, merge: true };
const DPR1: Availability = { effects: false, baseDpr: 1, coarse: true, merge: true };
/** Scripts with fixed frame costs: a knob cannot show a gain there, so trials are off (they have tests of their own). */
const STATIC = { trialFrames: 0 };

/**
 * Drive a gesture whose frame cost answers the engaged knobs (cost(knobs)), with the settle timer, as the
 * scene does. Returns the knobs after each frame and the final step.
 */
function drive(c: QualityController, o: { frames: number; period: number; cost: (knobs: string[]) => { cpuMs: number; gpuMs?: number } }) {
  const trace: { t: number; knobs: string[] }[] = [];
  c.pointer(true, 0);
  let t = 0;
  for (let i = 0; i < o.frames; i++) {
    t += o.period;
    c.frame({ t, ...o.cost(c.knobs), active: true });
    trace.push({ t, knobs: c.knobs });
  }
  c.pointer(false, t);
  for (let guard = 0; guard < 100 && c.state !== "idle"; guard++) {
    const w = c.nextWakeAt();
    if (w === undefined) break;
    c.tick(w);
    trace.push({ t: w, knobs: c.knobs });
  }
  return trace;
}

/** A gesture: pointer down at `start`, frames every `period` ms with these costs, pointer up after the last. */
function gesture(start: number, frames: number, cost: { cpuMs: number; gpuMs?: number }, period = B60): SimEvent[] {
  const out: SimEvent[] = [{ at: start, pointer: true }];
  for (let i = 0; i < frames; i++) out.push({ at: start + (i + 1) * period, frame: { ...cost, active: true } });
  out.push({ at: start + (frames + 1) * period, pointer: false });
  return out;
}

const knobsAt = (steps: ReturnType<typeof simulate>, t: number) => [...steps].reverse().find((s) => s.at <= t)?.knobs ?? [];

// ---------------------------------------------------------------------------
// the controller
// ---------------------------------------------------------------------------

describe("quality curve: a small model never looks worse", () => {
  it("the drone at 10 ms and ClientX at 14.7 ms engage no knob at a 16.7 ms budget", () => {
    for (const ms of [10.0, 11.3, 14.7, 16.9]) {
      const c = new QualityController({ ...STATIC, budgetMs: B60 }, ALL);
      // GPU-timed (cpu small, gpu the rest) and interval-timed (no timer: the frame interval is the display period)
      const timed = simulate(c, gesture(0, 240, { cpuMs: 1.6, gpuMs: ms - 1.6 }));
      expect(timed.filter((s) => s.knobs.length)).toEqual([]);
      const c2 = new QualityController({ ...STATIC, budgetMs: B60 }, ALL);
      const evs: SimEvent[] = [{ at: 0, pointer: true }, ...Array.from({ length: 240 }, (_, i) => ({ at: (i + 1) * B60, frame: { cpuMs: 0.7, intervalMs: B60, active: true } }))];
      expect(simulate(c2, evs).filter((s) => s.knobs.length)).toEqual([]);
    }
  });

  it("a single slow frame (a GC pause) does not degrade, nor does one frame over the hard threshold", () => {
    const c = new QualityController({ ...STATIC, budgetMs: B60 }, ALL);
    const evs = gesture(0, 60, { cpuMs: 1, gpuMs: 9 });
    // frame 30 takes 70 ms
    const f = evs.find((e, i) => i === 30 && "frame" in e) as { at: number; frame: { cpuMs: number; gpuMs?: number } };
    f.frame.gpuMs = 69;
    expect(simulate(c, evs).filter((s) => s.knobs.length)).toEqual([]);
  });

  it("idle draws nothing: a one-off redraw is not an interaction", () => {
    const c = new QualityController({ ...STATIC, budgetMs: B60 }, ALL);
    const steps = simulate(c, [{ at: 0, frame: { cpuMs: 40, gpuMs: 40, active: false } }, { at: 20, frame: { cpuMs: 40, gpuMs: 40, active: false } }]);
    expect(steps).toEqual([]);
    expect(c.state).toBe("idle");
    expect(c.nextWakeAt()).toBeUndefined();
  });
});

describe("quality curve: degrade", () => {
  it("degrades at 1.15 x budget held 3 frames, then one rung per 250 ms dwell, cheapest loss first", () => {
    const c = new QualityController({ ...STATIC, budgetMs: B60 }, ALL);
    // GPU-bound 25 ms frames (over 1.15 x 16.7 = 19.2)
    const steps = simulate(c, gesture(0, 120, { cpuMs: 2, gpuMs: 23 }, 25));
    const changes = steps.filter((s) => !s.final);
    // the first 200 ms of a gesture are warm-up, then 3 frames over: t = 200, 225, 250
    expect(changes[0]).toMatchObject({ at: 250, knobs: ["effects"] });
    // later rungs at least 250 ms apart
    for (let i = 1; i < changes.length && changes[i].knobs.length > changes[i - 1].knobs.length; i++) expect(changes[i].at - changes[i - 1].at).toBeGreaterThanOrEqual(250);
    // the order: effects, DPR 1.5, DPR 1.0, coarse, merge, DPR 0.75 (the floor)
    const max = changes.reduce((a, s) => (s.knobs.length > a.length ? s.knobs : a), [] as string[]);
    expect(max).toEqual([...LADDER]);
  });

  it("is bottleneck aware: a CPU-bound frame coarsens and merges, never lowers resolution", () => {
    const c = new QualityController({ ...STATIC, budgetMs: B60 }, ALL);
    const steps = simulate(c, gesture(0, 120, { cpuMs: 28, gpuMs: 2 }, 30));
    const seen = new Set(steps.flatMap((s) => s.knobs));
    expect([...seen].sort()).toEqual(["coarse", "merge"]);
    expect(steps.find((s) => s.knobs.length)!.knobs).toEqual(["coarse"]);
  });

  it("without a GPU timer, a long frame interval with little CPU time is fill-bound", () => {
    expect(bottleneckOf({ t: 0, cpuMs: 1, intervalMs: 33, active: true })).toBe("gpu");
    expect(bottleneckOf({ t: 0, cpuMs: 30, intervalMs: 33, active: true })).toBe("cpu");
    expect(bottleneckOf({ t: 0, cpuMs: 5, gpuMs: 20, active: true })).toBe("gpu");
    expect(bottleneckOf({ t: 0, cpuMs: 20, gpuMs: 5, active: true })).toBe("cpu");
    expect(bottleneckOf({ t: 0, cpuMs: 3, active: true })).toBe("unknown");
    expect(frameTimeOf({ t: 0, cpuMs: 3, gpuMs: 9, active: true })).toBe(12);
    expect(frameTimeOf({ t: 0, cpuMs: 3, intervalMs: 33, active: true })).toBe(33);
  });

  it("skips knobs that cannot help: no effects registered, DPR already at 1", () => {
    expect(knobUseful("effects", DPR1, "gpu")).toBe(false);
    expect(knobUseful("dpr1.5", DPR1, "gpu")).toBe(false);
    expect(knobUseful("dpr1", DPR1, "gpu")).toBe(false);
    expect(knobUseful("dpr0.75", DPR1, "gpu")).toBe(true);
    expect(knobUseful("dpr0.75", DPR1, "cpu")).toBe(false);
    const c = new QualityController({ ...STATIC, budgetMs: 8 }, DPR1);
    // ClientX at 14.7 ms under a forced 8 ms budget (the measurement case): coarse, merge, then the floor
    const steps = simulate(c, gesture(0, 90, { cpuMs: 0.7, gpuMs: 14 }, 16.7));
    const during = steps.filter((s) => s.at <= 90 * 16.7);
    expect(during.map((s) => s.knobs.join("+"))).toEqual(["coarse", "coarse+merge", "coarse+merge+dpr0.75"]);
    // and after release they come back in reverse order: the floor first, coarse last, then the final render
    expect(steps.filter((s) => s.at > 90 * 16.7).map((s) => s.knobs.join("+") + (s.final ? " final" : ""))).toEqual(["coarse+merge", "coarse", " final"]);
    expect(dprFor(["coarse", "dpr0.75"], 1)).toBe(0.75);
    expect(dprFor(["dpr1.5", "dpr1"], 2)).toBe(1);
  });

  it("holds the floor below the hard threshold; the emergency rung only after 3 frames over 50 ms there", () => {
    const c = new QualityController({ ...STATIC, budgetMs: B60 }, DPR1);
    // 40 ms frames: down to the floor, never past it
    const s1 = simulate(c, gesture(0, 120, { cpuMs: 2, gpuMs: 38 }, 40));
    expect(s1.some((s) => s.knobs.includes("dpr0.5"))).toBe(false);
    expect(s1.some((s) => s.knobs.includes("dpr0.75"))).toBe(true);
    // 60 ms frames: the floor, then the emergency rung
    const c2 = new QualityController({ ...STATIC, budgetMs: B60 }, DPR1);
    const s2 = simulate(c2, gesture(0, 60, { cpuMs: 2, gpuMs: 58 }, 60));
    expect(s2.some((s) => s.knobs.includes("dpr0.5"))).toBe(true);
    const firstEmergency = s2.find((s) => s.knobs.includes("dpr0.5"))!;
    expect(knobsAt(s2, firstEmergency.at - 1)).toContain("dpr0.75");
  });

  it("panics on two frames over 50 ms: two rungs at once, without waiting for the dwell", () => {
    const c = new QualityController({ ...STATIC, budgetMs: B60 }, ALL);
    const steps = simulate(c, gesture(0, 6, { cpuMs: 2, gpuMs: 70 }, 70));
    // frames at 70 and 140 ms are warm-up, frames at 210 and 280 ms over 50 ms: two rungs in one step at 280 ms
    expect(steps[0]).toMatchObject({ at: 280, knobs: ["effects", "dpr1.5"] });
  });
});

describe("quality curve: a knob that does not help is released", () => {
  it("a lower pixel ratio on a vertex-bound frame is tried, released and skipped; merging, which helps, stays", () => {
    const c = new QualityController({ budgetMs: B60 }, ALL);
    // 25 ms frames that only merging makes cheaper (12 ms): the pixel knobs and the coarse tier change nothing
    const trace = drive(c, { frames: 240, period: 25, cost: (k) => ({ cpuMs: 2, gpuMs: k.includes("merge") ? 10 : 23 }) });
    const seen = new Set(trace.flatMap((x) => x.knobs));
    expect(seen.has("effects")).toBe(true); // tried first
    const atEnd = trace.filter((x) => x.t <= 240 * 25).at(-1)!.knobs;
    expect(atEnd).toEqual(["merge"]);
    expect(c.skipped.sort()).toEqual(["coarse", "dpr1", "dpr1.5", "effects"].sort());
    // the next gesture does not try them again
    const again = drive(c, { frames: 120, period: 25, cost: (k) => ({ cpuMs: 2, gpuMs: k.includes("merge") ? 10 : 23 }) });
    expect(new Set(again.flatMap((x) => x.knobs))).toEqual(new Set(["merge"]));
    // a change of availability (a new scene) forgets the verdicts
    c.setAvailability({ ...ALL, merge: false });
    expect(c.skipped).toEqual([]);
  });

  it("a knob that helps is kept: frames that get cheaper pass the trial", () => {
    const c = new QualityController({ budgetMs: B60 }, ALL);
    const trace = drive(c, { frames: 120, period: 25, cost: (k) => ({ cpuMs: 2, gpuMs: Math.max(4, 23 - 3 * k.length) }) });
    expect(c.skipped).toEqual([]);
    expect(trace.filter((x) => x.t <= 120 * 25).at(-1)!.knobs.length).toBeGreaterThan(1);
    // and after release everything comes back
    expect(trace.at(-1)!.knobs).toEqual([]);
  });
});

describe("quality curve: hysteresis and the flip lock", () => {
  it("upgrades during a gesture only after 20 frames under 0.70 x budget", () => {
    const c = new QualityController({ ...STATIC, budgetMs: B60 }, ALL);
    const evs: SimEvent[] = [{ at: 0, pointer: true }];
    let t = 0;
    // heavy for 10 frames, then light
    for (let i = 0; i < 10; i++) evs.push({ at: (t += 25), frame: { cpuMs: 2, gpuMs: 23, active: true } });
    const lightFrom = t;
    for (let i = 0; i < 60; i++) evs.push({ at: (t += B60), frame: { cpuMs: 1, gpuMs: 5, active: true } });
    const steps = simulate(c, evs, t);
    const up = steps.find((s) => s.at > lightFrom && s.knobs.length === 0)!;
    expect(up).toBeDefined();
    // the average falls under 11.7 ms after a few frames; then 20 frames are needed (plus the dwell)
    expect(up.at - lightFrom).toBeGreaterThanOrEqual(20 * B60);
  });

  it("does not upgrade between 0.70 and 1.15 x budget (the dead band)", () => {
    const c = new QualityController({ ...STATIC, budgetMs: B60 }, ALL);
    const evs: SimEvent[] = [{ at: 0, pointer: true }];
    let t = 0;
    for (let i = 0; i < 10; i++) evs.push({ at: (t += 25), frame: { cpuMs: 2, gpuMs: 23, active: true } });
    for (let i = 0; i < 120; i++) evs.push({ at: (t += B60), frame: { cpuMs: 1, gpuMs: 14, active: true } });
    const steps = simulate(c, evs, t);
    const last = steps[steps.length - 1];
    expect(last.knobs.length).toBeGreaterThan(0);
  });

  it("locks the rung after more than 3 reversals in 2 s", () => {
    const c = new QualityController({ ...STATIC, budgetMs: B60, degradeFrames: 1, upgradeFrames: 1, dwellMs: 0, settleFrames: 0, warmupMs: 0, emaAlpha: 1 }, ALL);
    const evs: SimEvent[] = [{ at: 0, pointer: true }];
    let t = 0;
    for (let i = 0; i < 40; i++) evs.push({ at: (t += 20), frame: { cpuMs: 1, gpuMs: i % 2 ? 4 : 30, active: true } });
    const steps = simulate(c, evs, t);
    expect(c.status().locked).toBe(true);
    // the reversals stop once locked: at most 3 + 1 direction changes, then nothing
    expect(steps.length).toBeLessThanOrEqual(6);
  });
});

describe("quality curve: release and recovery", () => {
  it("restore times follow q(t) = 1 - (1 - q_release) exp(-t / 200 ms): 27, 58, 94, 139, 196, 277, 416, 600 ms from 8", () => {
    expect(restoreTimes(8, 200).map(Math.round)).toEqual([27, 58, 94, 139, 196, 277, 416, 600]);
    expect(restoreTimes(1, 200)).toEqual([600]);
    expect(restoreTimes(0, 200)).toEqual([]);
  });

  it("settles 120 ms after the pointer is up and the camera still, restores in reverse ladder order, ends with one full-quality render by 3 tau", () => {
    const c = new QualityController({ ...STATIC, budgetMs: B60 }, ALL);
    const evs = gesture(0, 120, { cpuMs: 2, gpuMs: 38 }, 40);
    const lastFrame = Math.max(...evs.filter((e) => "frame" in e).map((e) => e.at));
    const steps = simulate(c, evs);
    const held = knobsAt(steps, lastFrame);
    expect(held.length).toBeGreaterThan(2);
    const after = steps.filter((s) => s.at > lastFrame);
    // nothing changes before the 120 ms quiet
    expect(after[0].at).toBeGreaterThanOrEqual(lastFrame + 120);
    const settleStart = lastFrame + 120;
    // each restore drops the highest rung first
    for (let i = 1; i < after.length; i++) {
      const prev = i === 1 ? held : after[i - 1].knobs;
      const dropped = prev.filter((k) => !after[i].knobs.includes(k));
      for (const k of dropped) expect(LADDER.indexOf(k as never)).toBeGreaterThanOrEqual(Math.max(...after[i].knobs.map((x) => LADDER.indexOf(x as never)), -1));
    }
    const final = after.find((s) => s.final)!;
    expect(final.knobs).toEqual([]);
    expect(final.at - settleStart).toBeLessThanOrEqual(3 * 200 + 1e-6);
    expect(c.state).toBe("idle");
    expect(c.nextWakeAt()).toBeUndefined();
  });

  it("does not settle while the pointer is held, however still the camera is", () => {
    const c = new QualityController({ ...STATIC, budgetMs: B60 }, ALL);
    const evs: SimEvent[] = [{ at: 0, pointer: true }, ...Array.from({ length: 30 }, (_, i) => ({ at: (i + 1) * 40, frame: { cpuMs: 2, gpuMs: 38, active: true } }))];
    simulate(c, evs, 5000);
    expect(c.state).toBe("interacting");
    expect(c.knobs.length).toBeGreaterThan(0);
  });

  it("a re-grab while settling keeps the current knobs (no full-quality frame in between)", () => {
    const c = new QualityController({ ...STATIC, budgetMs: B60 }, ALL);
    const first = gesture(0, 120, { cpuMs: 2, gpuMs: 38 }, 40);
    const lastFrame = Math.max(...first.filter((e) => "frame" in e).map((e) => e.at));
    simulate(c, first, lastFrame + 150);
    expect(c.state).toBe("settling");
    const had = c.knobs;
    c.pointer(true, lastFrame + 160);
    expect(c.state).toBe("interacting");
    expect(c.knobs).toEqual(had);
  });

  it("tau 0 snaps straight back", () => {
    const c = new QualityController({ ...STATIC, budgetMs: B60, tauMs: 0 }, ALL);
    const evs = gesture(0, 60, { cpuMs: 2, gpuMs: 38 }, 40);
    const lastFrame = Math.max(...evs.filter((e) => "frame" in e).map((e) => e.at));
    const steps = simulate(c, evs);
    const after = steps.filter((s) => s.at > lastFrame);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ final: true, knobs: [] });
  });

  it("a scene whose full-quality frame is over budget starts its next gesture one rung below what it needed", () => {
    const c = new QualityController({ ...STATIC, budgetMs: B60 }, ALL);
    simulate(c, gesture(0, 120, { cpuMs: 2, gpuMs: 38 }, 40));
    const needed = c.status();
    expect(needed.state).toBe("idle");
    // a full-quality redraw (not an interaction) measured over budget
    c.frame({ t: 10000, cpuMs: 2, gpuMs: 38, active: false });
    const d = c.pointer(true, 10010);
    expect(d.changed).toBe(true);
    expect(c.knobs.length).toBe(LADDER.length - 1);
    // a light one starts at full quality
    const light = new QualityController({ ...STATIC, budgetMs: B60 }, ALL);
    simulate(light, gesture(0, 120, { cpuMs: 2, gpuMs: 38 }, 40));
    light.frame({ t: 10000, cpuMs: 2, gpuMs: 6, active: false });
    expect(light.pointer(true, 10010).changed).toBe(false);
  });

  it("reset drops every knob (a capture is never a degraded frame)", () => {
    const c = new QualityController({ ...STATIC, budgetMs: B60 }, ALL);
    simulate(c, [{ at: 0, pointer: true }, ...Array.from({ length: 30 }, (_, i) => ({ at: (i + 1) * 40, frame: { cpuMs: 2, gpuMs: 38, active: true } }))], 1200);
    expect(c.knobs.length).toBeGreaterThan(0);
    expect(c.reset()).toMatchObject({ changed: true });
    expect(c.knobs).toEqual([]);
    expect(c.state).toBe("idle");
  });

  it("releases knobs that can no longer help when availability changes", () => {
    const c = new QualityController({ ...STATIC, budgetMs: B60 }, ALL);
    simulate(c, [{ at: 0, pointer: true }, ...Array.from({ length: 60 }, (_, i) => ({ at: (i + 1) * 40, frame: { cpuMs: 2, gpuMs: 38, active: true } }))], 2400);
    expect(c.knobs).toContain("coarse");
    expect(c.setAvailability({ ...ALL, coarse: false }).changed).toBe(true);
    expect(c.knobs).not.toContain("coarse");
  });

  it("disabled: never engages", () => {
    const c = new QualityController({ ...STATIC, budgetMs: B60, enabled: false }, ALL);
    expect(simulate(c, gesture(0, 60, { cpuMs: 2, gpuMs: 70 }, 70)).filter((s) => s.knobs.length)).toEqual([]);
  });

  it("defaults are the research numbers", () => {
    expect(DEFAULT_QUALITY.warmupMs).toBe(200);
    expect(DEFAULT_QUALITY).toMatchObject({ degradeAt: 1.15, degradeFrames: 3, upgradeAt: 0.7, upgradeFrames: 20, dwellMs: 250, flipLimit: 3, flipWindowMs: 2000, hardMs: 50, quietMs: 120, tauMs: 200 });
  });
});

// ---------------------------------------------------------------------------
// attention foveation
// ---------------------------------------------------------------------------

describe("attention foveation", () => {
  it("a key covers its body, the bodies under it and the body holding it", () => {
    expect(keyCovers("drone/fc", "drone/fc")).toBe(true);
    expect(keyCovers("drone/fc", "drone/fc#2")).toBe(true);
    expect(keyCovers("drone", "drone/fc")).toBe(true); // an assembly selected as its parts
    expect(keyCovers("board/U3", "board")).toBe(true); // a component inside a board
    expect(keyCovers("drone/fc", "drone/esc")).toBe(false);
    expect(keyCovers("drone/f", "drone/fc")).toBe(false);
  });

  it("selected, agent-focused and hovered parts are focused; lit meshes count as selected until a host says", () => {
    const a = new Attention();
    const m = (key: string) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
      mesh.userData.bodyKey = key;
      return mesh;
    };
    const fc = m("drone/fc");
    const esc = m("drone/esc");
    const motor = m("drone/motor1");
    expect(a.empty).toBe(true);
    expect(a.focused(fc)).toBe(false);
    const v0 = a.version;
    expect(a.set("agent", ["drone/fc"])).toBe(true);
    expect(a.set("agent", ["drone/fc"])).toBe(false); // unchanged: no version bump
    expect(a.version).toBe(v0 + 1);
    a.set("hovered", ["drone/esc"]);
    expect(a.focused(fc)).toBe(true);
    expect(a.focused(esc)).toBe(true);
    expect(a.focused(motor)).toBe(false);
    setMeshLook(motor, { emissive: 0x112233 });
    expect(isLit(motor)).toBe(true);
    expect(a.focused(motor)).toBe(true);
    setMeshLook(motor, { emissive: undefined });
    expect(a.focused(motor)).toBe(false);
    a.set("hovered", []);
    expect(a.focused(esc)).toBe(false);
    expect(a.snapshot()).toEqual({ selected: [], agent: ["drone/fc"], hovered: [] });
    const harness = new THREE.Mesh();
    harness.userData.harness = "h1";
    a.set("selected", ["h1"]);
    expect(a.focused(harness)).toBe(true);
  });

  it("the foveal inset rectangle covers the focused parts on screen", () => {
    const camera = new THREE.PerspectiveCamera(45, 2, 0.1, 100);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const r = focusRect([new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1))], camera, 800, 400, 0)!;
    // centred, symmetric, inside the view
    expect(r.x + r.w / 2).toBeCloseTo(400, 0);
    expect(r.y + r.h / 2).toBeCloseTo(200, 0);
    expect(r.w).toBeLessThan(800);
    expect(focusRect([], camera, 800, 400)).toBeUndefined();
    // off screen
    expect(focusRect([new THREE.Box3(new THREE.Vector3(50, 0, -1), new THREE.Vector3(52, 1, 1))], camera, 800, 400)).toBeUndefined();
    // world boxes of the focused meshes only
    const a = new Attention();
    const root = new THREE.Group();
    const one = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial());
    one.userData.bodyKey = "a";
    one.position.set(5, 0, 0);
    const two = one.clone();
    two.userData = { bodyKey: "b" };
    root.add(one, two);
    root.updateMatrixWorld(true);
    a.set("selected", ["a"]);
    const boxes = focusedBoxes([root], a);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].min.x).toBeCloseTo(4);
  });
});

// ---------------------------------------------------------------------------
// coarse tier, merge, batcher policy
// ---------------------------------------------------------------------------

function tiered() {
  const mat = new THREE.MeshStandardMaterial();
  const fine = new THREE.Group();
  const fineMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), mat);
  fineMesh.name = "body";
  fine.add(fineMesh);
  const coarse = new THREE.Group();
  const coarseMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 4), mat);
  coarseMesh.name = "body";
  coarse.add(coarseMesh);
  return { fine, coarse, fineMesh, coarseMesh };
}

describe("coarse tier", () => {
  it("reads tiers.coarse from the sidecar; none when the coarse tier is the fine file or not a plain file name", () => {
    const base = { tiers: { fine: { file: "x.view.glb", sha256: "sha256:aaaaaaaaaaaa", triangles: 1000 } }, nodes: [] };
    expect(normaliseSidecar({ ...base, tiers: { ...base.tiers, coarse: { file: "x.view.coarse.glb", triangles: 300, sha256: "sha256:bb" } } })!.coarse).toEqual({ file: "x.view.coarse.glb", sha256: "sha256:bb", triangles: 300, fineTriangles: 1000 });
    expect(normaliseSidecar({ ...base, tiers: { ...base.tiers, coarse: { file: "x.view.glb", method: "same-as-fine" } } })!.coarse).toBeUndefined();
    expect(normaliseSidecar({ ...base, tiers: { ...base.tiers, coarse: { file: "../evil.glb" } } })!.coarse).toBeUndefined();
    expect(normaliseSidecar({ ...base, tiers: { ...base.tiers, coarse: { file: "sub/x.glb" } } })!.coarse).toBeUndefined();
  });

  it("the coarse file sits beside X.view.glb", () => {
    const model = { path: "/artifacts/p/out/body.view.glb?v=2", sidecar: { hash: "h", nodes: [], features: new Map(), coarse: { file: "body.view.coarse.glb" } } } as unknown as LoadedModel;
    expect(coarseUrl(model)).toBe("/artifacts/p/out/body.view.coarse.glb?v=2");
    expect(coarseUrl({ path: "/a/b.view.glb" } as LoadedModel)).toBeUndefined();
  });

  it("pairs fine and coarse meshes by structure; a different structure pairs nothing", () => {
    const { fine, coarse, fineMesh, coarseMesh } = tiered();
    const { pairs, mismatches } = pairCoarse(fine, coarse);
    expect(mismatches).toBe(0);
    expect(pairs.get(fineMesh.geometry)).toBe(coarseMesh.geometry);
    expect(triangleCount(coarseMesh.geometry)).toBeLessThan(triangleCount(fineMesh.geometry));
    coarse.add(new THREE.Group());
    expect(pairCoarse(fine, coarse).mismatches).toBe(1);
  });

  it("bakes a coarse mesh into the fine node's frame when quantisation gave its node another transform", () => {
    const { fine, coarse, fineMesh, coarseMesh } = tiered();
    // the coarse node is scaled x2 and its geometry halved: the same shape in the file
    coarseMesh.scale.setScalar(2);
    coarseMesh.geometry.scale(0.5, 0.5, 0.5);
    const { pairs } = pairCoarse(fine, coarse);
    const g = pairs.get(fineMesh.geometry)!;
    expect(g).not.toBe(coarseMesh.geometry);
    g.computeBoundingBox();
    expect(g.boundingBox!.max.x).toBeCloseTo(1, 5);
  });

  it("loads each coarse file once and answers per fine geometry", async () => {
    const { fine, coarse, fineMesh, coarseMesh } = tiered();
    const load = vi.fn(async () => ({ scene: coarse }) as unknown as GLTF);
    const tier = new CoarseTier({ load });
    const model = { hash: "h1", path: "/a/x.view.glb", gltf: { scene: fine }, sidecar: { hash: "h1", nodes: [], features: new Map(), coarse: { file: "x.view.coarse.glb" } } } as unknown as LoadedModel;
    expect(tier.available).toBe(false);
    const s = await tier.prepare([model, model]);
    await tier.prepare([model]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(s).toMatchObject({ files: 1, loaded: 1, mapped: 1 });
    expect(tier.available).toBe(true);
    expect(tier.geometryFor(fineMesh.geometry)).toBe(coarseMesh.geometry);
    // a clone (what CadView builds per placement) shares the geometry, so it gets the same stand-in
    expect(tier.geometryFor((fineMesh.clone() as THREE.Mesh).geometry)).toBe(coarseMesh.geometry);
    const failing = new CoarseTier({ load: async () => null });
    expect((await failing.prepare([model])).failed).toBe(1);
  });
});

function partsScene(n: number) {
  const geometry = new THREE.BoxGeometry(2, 2, 2);
  const grey = new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 0.5 });
  const red = new THREE.MeshStandardMaterial({ color: 0xff0000, roughness: 0.5 });
  const root = new THREE.Group();
  const meshes: THREE.Mesh[] = [];
  for (let i = 0; i < n; i++) {
    const body = new THREE.Group();
    body.position.set(i * 10, 0, 0);
    const mesh = new THREE.Mesh(geometry, i % 2 ? red : grey);
    mesh.userData.bodyKey = `p${i}`;
    body.add(mesh);
    root.add(body);
    meshes.push(mesh);
  }
  root.updateMatrixWorld(true);
  return { root, meshes, geometry };
}

describe("merge (draw-call foveation)", () => {
  it("merges many parts of one look into one mesh in world space, colours per vertex", () => {
    const { meshes } = partsScene(6);
    const r = buildMerged(meshes.map((mesh) => ({ mesh, geometry: mesh.geometry })))!;
    expect(r.meshes).toHaveLength(1);
    expect(r.members.size).toBe(6);
    expect(r.triangles).toBe(6 * 12);
    const g = r.meshes[0].geometry;
    g.computeBoundingBox();
    expect(g.boundingBox!.min.x).toBeCloseTo(-1);
    expect(g.boundingBox!.max.x).toBeCloseTo(51);
    const col = g.getAttribute("color");
    // part 1 is red: its first vertex (24 vertices per box)
    expect([col.getX(24), col.getY(24), col.getZ(24)]).toEqual([1, 0, 0]);
    expect((r.meshes[0].material as THREE.MeshStandardMaterial).vertexColors).toBe(true);
  });

  it("keeps a mirrored placement's faces facing out", () => {
    const { meshes } = partsScene(1);
    meshes[0].parent!.scale.set(-1, 1, 1);
    meshes[0].parent!.updateMatrixWorld(true);
    const r = buildMerged([{ mesh: meshes[0], geometry: meshes[0].geometry }])!;
    const g = r.meshes[0].geometry;
    const idx = g.index!;
    const p = g.getAttribute("position");
    const n = g.getAttribute("normal");
    const v = (i: number) => new THREE.Vector3().fromBufferAttribute(p, idx.getX(i));
    // the face normal from the winding agrees with the vertex normal
    const fn = new THREE.Vector3().crossVectors(v(1).sub(v(0)), v(2).sub(v(0))).normalize();
    expect(fn.dot(new THREE.Vector3().fromBufferAttribute(n, idx.getX(0)))).toBeGreaterThan(0.9);
  });

  it("never merges highlighted or see-through parts; gives up past the triangle cap", () => {
    const { meshes } = partsScene(3);
    setMeshLook(meshes[0], { emissive: 0x334455 });
    setMeshLook(meshes[1], { xray: true });
    expect(mergeable(meshes[0])).toBe(false);
    expect(mergeable(meshes[1])).toBe(false);
    expect(mergeable(meshes[2])).toBe(true);
    expect(buildMerged([{ mesh: meshes[2], geometry: meshes[2].geometry }], 5)).toBeUndefined();
    expect(MERGE_MAX_TRIANGLES).toBeGreaterThan(1_000_000);
  });

  it("the batcher leaves merged meshes out and draws a stand-in geometry where the policy says", () => {
    const { root, meshes, geometry } = partsScene(6);
    const b = new Batcher();
    expect(b.sync([root]).instances).toBe(6);
    const merged = new Set([meshes[0], meshes[1], meshes[2]]);
    const s = b.sync([root], { exclude: (m) => merged.has(m) });
    expect(s.instances).toBe(3);
    // excluded meshes stay on the logical layer (the camera does not draw them twice) and the subtree counts as covered
    expect(meshes[0].layers.mask).toBe((1 << LOGICAL_LAYER) >>> 0);
    expect(b.pure).toContain(meshes[0].parent);
    // a stand-in: groups by the coarse geometry, the logical mesh keeps its own
    const coarse = new THREE.BoxGeometry(2, 2, 2, 1, 1, 1);
    const s2 = b.sync([root], { geometryOf: (m) => (m.userData.bodyKey === "p5" || m.userData.bodyKey === "p4" ? coarse : undefined) });
    expect(s2.groups).toBe(2);
    expect(meshes[5].geometry).toBe(geometry);
    const sources = b.root.children.map((c) => ((c as THREE.Mesh).geometry.userData.shares as THREE.BufferGeometry).id);
    expect(sources).toContain(coarse.id);
  });

  it("lists the meshes drawn as themselves (their geometry is swapped only for the draw)", () => {
    const { root, meshes } = partsScene(3);
    setMeshLook(meshes[0], { xray: true });
    const b = new Batcher();
    b.sync([root]);
    expect(b.singles).toEqual([meshes[0]]);
  });
});

// ---------------------------------------------------------------------------
// GPU timer
// ---------------------------------------------------------------------------

function fakeTimerGl(opts: { ext?: boolean } = {}) {
  let next = 1;
  const results = new Map<unknown, { avail: boolean; ns: number }>();
  let disjoint = false;
  const gl = {
    QUERY_RESULT_AVAILABLE: 1,
    QUERY_RESULT: 2,
    getExtension: (n: string) => (opts.ext !== false && n === "EXT_disjoint_timer_query_webgl2" ? {} : null),
    createQuery: () => ({ id: next++ }) as unknown as WebGLQuery,
    deleteQuery: () => undefined,
    beginQuery: () => undefined,
    endQuery: () => undefined,
    getQueryParameter: (q: WebGLQuery, p: number) => (p === 1 ? (results.get(q)?.avail ?? false) : results.get(q)?.ns),
    getParameter: () => {
      const d = disjoint;
      disjoint = false;
      return d;
    },
  } satisfies TimerGl;
  return {
    gl,
    finish: (q: unknown, ms: number) => results.set(q, { avail: true, ns: ms * 1e6 }),
    disjoint: () => (disjoint = true),
  };
}

describe("GPU timer", () => {
  it("says whether EXT_disjoint_timer_query_webgl2 is there", () => {
    expect(new GpuTimer(fakeTimerGl().gl).available).toBe(true);
    expect(new GpuTimer(fakeTimerGl({ ext: false }).gl).available).toBe(false);
    expect(new GpuTimer(null).available).toBe(false);
    const none = new GpuTimer(null);
    none.begin();
    none.end();
    expect(none.poll()).toBeUndefined();
  });

  it("returns the newest finished frame's time, a frame or more late; a disjoint event drops the queries in flight", () => {
    const f = fakeTimerGl();
    const t = new GpuTimer(f.gl);
    const created: unknown[] = [];
    const create = f.gl.createQuery;
    f.gl.createQuery = () => {
      const q = create();
      created.push(q);
      return q;
    };
    t.begin();
    t.end();
    expect(t.poll()).toBeUndefined();
    f.finish(created[0], 7.5);
    expect(t.poll()).toBe(7.5);
    t.begin();
    t.end();
    f.disjoint();
    expect(t.poll()).toBe(7.5);
    expect(t.disjoint).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// snapshot, suspend, resume
// ---------------------------------------------------------------------------

function fakeView() {
  let frames = 0;
  let paused = false;
  let lost = false;
  let now = 0;
  const calls: string[] = [];
  const deps: LifecycleDeps = {
    renderFull: () => {
      if (lost) throw new Error("drawing on a lost context");
      frames++;
      calls.push("render");
    },
    read: async () => {
      calls.push("read");
      return new Blob(["png"], { type: "image/png" });
    },
    size: () => ({ width: 1440, height: 900 }),
    frames: () => frames,
    pause: (on) => {
      paused = on;
      calls.push(on ? "pause" : "unpause");
    },
    loseContext: () => {
      lost = true;
      calls.push("lose");
      return true;
    },
    restoreContext: async () => {
      lost = false;
      calls.push("restore");
      return true;
    },
    warm: async () => void calls.push("warm"),
    contextLost: () => lost,
    now: () => (now += 1),
  };
  return { deps, calls, get paused() { return paused; }, get lost() { return lost; }, drawn: () => frames++ };
}

describe("snapshot when settled, suspend when hidden", () => {
  it("hands a PNG to the host's callback, read in the same task as a full-quality render", async () => {
    const v = fakeView();
    const life = new ViewLifecycle(v.deps);
    const got: unknown[] = [];
    expect(life.wantsSnapshots).toBe(false);
    const stop = life.onSnapshot((s) => got.push(s));
    expect(life.wantsSnapshots).toBe(true);
    const s = (await life.snapshot("settle"))!;
    expect(v.calls).toEqual(["render", "read"]);
    expect(s).toMatchObject({ width: 1440, height: 900, reason: "settle", frame: 1 });
    expect(s.blob.type).toBe("image/png");
    expect(got).toEqual([s]);
    // nothing new drawn: a settle snapshot is not taken again
    expect(await life.snapshot("settle")).toBe(s);
    expect(v.calls).toEqual(["render", "read"]);
    // a frame later, it is
    v.drawn();
    await life.snapshot("settle");
    expect(v.calls.filter((c) => c === "read")).toHaveLength(2);
    stop();
    expect(life.wantsSnapshots).toBe(false);
  });

  it("suspend stops drawing after a snapshot and gives the GPU back; resume restores, compiles, draws one frame", async () => {
    const v = fakeView();
    const life = new ViewLifecycle(v.deps, { freeGpuWhenHidden: true });
    const states: unknown[] = [];
    life.onState((s) => states.push(s));
    const r = await life.suspend({ reason: "hidden" });
    expect(r.freedGpu).toBe(true);
    expect(r.snapshot).toBeDefined();
    expect(v.paused).toBe(true);
    expect(v.lost).toBe(true);
    expect(life.state).toMatchObject({ suspended: true, reason: "hidden", freedGpu: true });
    // nothing is drawn while suspended
    expect(await life.snapshot("request")).toBe(r.snapshot);
    const res = (await life.resume({ reason: "hidden" }))!;
    expect(res.restored).toBe(true);
    expect(v.calls.slice(-5)).toEqual(["pause", "lose", "restore", "warm", "unpause", "render"].slice(-5));
    expect(v.paused).toBe(false);
    expect(life.state).toEqual({ suspended: false });
    expect(states).toHaveLength(2);
    expect(res.ms).toBeGreaterThanOrEqual(res.restoreMs);
  });

  it("without freeGpu (the browser dev viewer) the context stays; a host suspend is not undone by visibility", async () => {
    const v = fakeView();
    const life = new ViewLifecycle(v.deps, { freeGpuWhenHidden: false });
    await life.suspend({ reason: "hidden" });
    expect(v.lost).toBe(false);
    expect(life.state).toMatchObject({ suspended: true, freedGpu: false });
    await life.resume({ reason: "hidden" });
    expect(life.state.suspended).toBe(false);
    // the host's budget suspends it (and frees the GPU); the page becoming visible does not bring it back
    await life.suspend({ reason: "host", freeGpu: true });
    expect(v.lost).toBe(true);
    expect(await life.resume({ reason: "hidden" })).toBeUndefined();
    expect(life.state.suspended).toBe(true);
    expect((await life.resume({ reason: "host" }))!.restored).toBe(true);
  });

  it("suspend and resume run one at a time, in call order", async () => {
    const v = fakeView();
    const life = new ViewLifecycle(v.deps, { freeGpuWhenHidden: true });
    const a = life.suspend();
    const b = life.resume();
    const c = life.suspend();
    await Promise.all([a, b, c]);
    expect(life.state.suspended).toBe(true);
    expect(v.calls.filter((x) => x === "lose")).toHaveLength(2);
    expect(v.calls.filter((x) => x === "restore")).toHaveLength(1);
  });
});

describe("live-view budget", () => {
  it("1 on software or slow, 2 on integrated, 4 on discrete-class times", () => {
    expect(liveViewsFor(3)).toBe(4);
    expect(liveViewsFor(6.2)).toBe(2); // the phase-1 Intel UHD
    expect(liveViewsFor(9)).toBe(2);
    expect(liveViewsFor(40)).toBe(1);
    expect(liveViewsFor(3, "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)")).toBe(1);
    expect(liveViewsFor(Infinity)).toBe(1);
  });

  it("budgets no tighter than 60 Hz and no looser than 30 Hz (DEFAULT)", () => {
    expect(budgetFromPeriod(1000 / 120)).toBeCloseTo(1000 / 60);
    expect(budgetFromPeriod(5.9)).toBeCloseTo(1000 / 60); // headless Chrome's unthrottled frames
    expect(budgetFromPeriod(20)).toBe(20);
    expect(budgetFromPeriod(80)).toBeCloseTo(1000 / 30);
    expect(budgetFromPeriod(NaN)).toBeCloseTo(1000 / 60);
  });

  it("drops the least recently used live views past the budget", () => {
    const views = [
      { id: "a", lastUsed: 5 },
      { id: "b", lastUsed: 9 },
      { id: "c", lastUsed: 1 },
      { id: "d", lastUsed: 7, suspended: true },
    ];
    expect(viewsToSuspend(views, 2).map((v) => v.id)).toEqual(["c"]);
    expect(viewsToSuspend(views, 1).map((v) => v.id)).toEqual(["a", "c"]);
    expect(viewsToSuspend(views, 4)).toEqual([]);
  });
});

describe("frame loop: what the quality curve measures", () => {
  it("says which frames a capture drew and the interval between frames of one motion", () => {
    let t = 0;
    const queue: ((t: number) => void)[] = [];
    const infos: FrameInfo[] = [];
    let left = 3;
    const loop = createFrameLoop({ frame: (i) => (infos.push(i), --left > 0), raf: (cb) => queue.push(cb), caf: () => undefined, now: () => t });
    loop.invalidate("view");
    for (let i = 0; i < 4; i++) {
      t += 16;
      const due = queue.splice(0);
      for (const cb of due) cb(t);
    }
    expect(infos.map((i) => i.interval)).toEqual([undefined, 16, 16]);
    loop.flush();
    expect(infos.at(-1)!.flush).toBe(true);
    // after a long idle the gap is not an interval
    t += 5000;
    loop.invalidate("view");
    left = 1;
    queue.splice(0).forEach((cb) => cb(t));
    expect(infos.at(-1)!.interval).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// W2-C's requests: placements only, the coarse tier on load, boxes from the index
// ---------------------------------------------------------------------------

describe("placements only (invalidate pose)", () => {
  it("the loop says a frame is a pose change, and a scene change outranks it", () => {
    let t = 0;
    const queue: ((t: number) => void)[] = [];
    const infos: FrameInfo[] = [];
    const loop = createFrameLoop({ frame: (i) => void infos.push(i), raf: (cb) => queue.push(cb), caf: () => undefined, now: () => t });
    const step = () => {
      t += 16;
      queue.splice(0).forEach((cb) => cb(t));
    };
    step(); // nothing asked
    loop.invalidate("scene");
    step();
    loop.invalidate("pose");
    step();
    loop.invalidate("pose");
    loop.invalidate("scene");
    step();
    loop.invalidate("view");
    step();
    expect(infos.map((i) => `${i.scene ? "scene" : i.pose ? "pose" : "view"}`)).toEqual(["scene", "pose", "scene", "view"]);
  });

  it("the batcher rewrites instance matrices without regrouping", () => {
    const { root, meshes } = partsScene(4);
    const b = new Batcher();
    b.sync([root]);
    const batch = b.root.children[0] as THREE.InstancedMesh;
    meshes[1].parent!.position.x += 5;
    root.updateMatrixWorld(true);
    expect(b.refreshMatrices()).toBe(4);
    expect(b.root.children[0]).toBe(batch);
    const m = new THREE.Matrix4();
    // members are grouped by look: find the moved mesh's slot
    const slot = [0, 1, 2, 3].find((i) => b.memberAt(batch, i) === meshes[1]);
    if (slot !== undefined) {
      batch.getMatrixAt(slot, m);
      expect(new THREE.Vector3().setFromMatrixPosition(m).x).toBe(15);
    }
  });
});

describe("loading at the coarse tier, and boxes", () => {
  const files = async () => {
    const { makeGlb, BOARD, BOARD_VIEW, boardSidecar } = await import("../src/cad/__fixtures__/glb");
    const glb = makeGlb(BOARD);
    const view = makeGlb(BOARD_VIEW);
    const sidecar = boardSidecar("sha256:view-fine", glb.byteLength);
    const withCoarse = { ...sidecar, tiers: { ...sidecar.tiers, coarse: { file: "body.view.coarse.glb", sha256: "sha256:view-coarse", triangles: 20 } } };
    return { glb, view, sidecar, withCoarse };
  };
  const fetcher = (map: Map<string, ArrayBuffer | string>, log: string[]) => async (url: string, init?: { method?: string }) => {
    log.push(`${init?.method ?? "GET"} ${url}`);
    const body = map.get(url);
    const bytes = body === undefined ? undefined : typeof body === "string" ? new TextEncoder().encode(body).buffer : body;
    return {
      ok: bytes !== undefined,
      status: bytes ? 200 : 404,
      headers: { get: (n: string) => (n.toLowerCase() === "content-length" && bytes ? String(bytes.byteLength) : null) },
      arrayBuffer: async () => bytes!.slice(0),
      text: async () => new TextDecoder().decode(bytes!),
    };
  };

  it("loads tiers.coarse.file first when asked, and the fine tier on a later plain load (a different hash: a hot swap)", async () => {
    const { createGlbCache } = await import("../src/cad/render/glbCache");
    const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
    const loader = new GLTFLoader();
    const { glb, view, withCoarse } = await files();
    const log: string[] = [];
    const cache = createGlbCache({
      fetch: fetcher(new Map<string, ArrayBuffer | string>([["/m/body.glb", glb], ["/m/body.view.glb", view], ["/m/body.view.coarse.glb", view], ["/m/body.view.json", JSON.stringify(withCoarse)]]), log),
      parse: (d, p) => loader.parseAsync(d, p),
    });
    const c = (await cache.load("/m/body.glb", { tier: "coarse" }))!;
    expect(c.tier).toBe("coarse");
    // W3-C (the wave 2 gate): the coarse tier's cache key is the hash of the bytes read, not the name or the
    // sidecar's declared value (here the fixture's coarse bytes are the fine view's)
    const { contentHash } = await import("../src/cad/render/glbCache");
    expect(c.hash).toBe(await contentHash(view));
    expect(c.path).toBe("/m/body.view.coarse.glb");
    expect(log).not.toContain("GET /m/body.view.glb");
    // ids are there; the fine tier's face tables are not applied to coarse triangles
    let faces = 0;
    c.gltf.scene.traverse((o) => o.userData.protoboardFaces && faces++);
    expect(faces).toBe(0);
    expect(c.gltf.scene.getObjectByName("U3")!.userData.protoboard).toMatchObject({ partInstanceId: "U3" });
    const f = (await cache.load("/m/body.glb"))!;
    expect(f.tier).toBeUndefined();
    expect(f.hash).toBe("sha256:view-fine");
    expect(f.hash).not.toBe(c.hash);
  });

  it("falls back to the fine tier when there is no coarse file of its own", async () => {
    const { createGlbCache } = await import("../src/cad/render/glbCache");
    const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
    const loader = new GLTFLoader();
    const { glb, view, sidecar, withCoarse } = await files();
    const noCoarse = createGlbCache({ fetch: fetcher(new Map<string, ArrayBuffer | string>([["/m/body.glb", glb], ["/m/body.view.glb", view], ["/m/body.view.json", JSON.stringify(sidecar)]]), []), parse: (d, p) => loader.parseAsync(d, p) });
    expect((await noCoarse.load("/m/body.glb", { tier: "coarse" }))!.hash).toBe("sha256:view-fine");
    // listed but missing on disk
    const missing = createGlbCache({ fetch: fetcher(new Map<string, ArrayBuffer | string>([["/m/body.glb", glb], ["/m/body.view.glb", view], ["/m/body.view.json", JSON.stringify(withCoarse)]]), []), parse: (d, p) => loader.parseAsync(d, p) });
    expect((await missing.load("/m/body.glb", { tier: "coarse" }))!.hash).toBe("sha256:view-fine");
    // the cache lists what the generation loaded
    expect(missing.loaded().map((m) => m.hash)).toEqual(["sha256:view-fine"]);
  });

  it("draws a box per indexed node at its bounds, with its ids", async () => {
    const { boxesFromSidecar } = await import("../src/cad/render/boxes");
    const { sidecar } = await files();
    const g = boxesFromSidecar(normaliseSidecar(sidecar)!);
    // three entries with bounds: the plate, U3, and the instanced resistors' node (one entry per node)
    expect(g.children.length).toBeGreaterThanOrEqual(2);
    const u3 = g.children.find((c) => c.userData.protoboard?.partInstanceId === "U3")!;
    expect(u3.userData.box).toBe(true);
    expect(u3.position.x).toBeCloseTo(0.005);
    expect(u3.scale.x).toBeCloseTo(0.005);
  });
});
