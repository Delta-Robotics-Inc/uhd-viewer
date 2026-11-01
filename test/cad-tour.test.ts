/**
 * Tours (PB-1188): a pure function of time over keyframes (camera, explode,
 * sequence steps, sections, what is shown, callouts), easing, the explode
 * track sampled as a sequence-player motion clip, authoring from view-state
 * snapshots, validation of a tour handed over as data, the view-state writes
 * per frame, live playback with the 25 s hand-back; and the sequence
 * player's step write-back hook (the wave 2 gate's item).
 */
import { describe, expect, it } from "vitest";
import type { Assembly } from "@uhd/system/geometry.js";
import type { CameraState } from "../src/api";
import { SequencePlayer, resolveSequence, sequenceFromPlan } from "../src/cad/sequence";
import { TOUR_SCHEMA, TourPlayback, cameraBetween, ease, parseTour, serializeTour, tourAt, tourFromSnapshots, tourOps, tourSampleTimes, type Tour } from "../src/cad/tour";

const cam = (position: [number, number, number], target: [number, number, number] = [0, 0, 0]): CameraState => ({ position, target, up: [0, 0, 1], fov: 40 });
const steps = [
  { id: "place:battery", window: [0.6, 1] as [number, number] },
  { id: "fit:arm_fl", window: [0.3, 0.6] as [number, number] },
  { id: "fasten:stack", window: [0, 0.3] as [number, number] },
];

/** The exit-test tour shape: frame, explode, three steps, return, over 20 s. */
const TOUR: Tour = {
  schema: TOUR_SCHEMA,
  id: "drone-stack",
  title: "How the stack goes together",
  keyframes: [
    { t: 0, camera: cam([400, -400, 300]), explode: 0, caption: "The drone" },
    { t: 3, camera: cam([120, -120, 90], [0, 0, 30]), explode: 0, highlight: ["stack"], caption: "The flight stack" },
    { t: 7, explode: 1, ease: "in-out" },
    { t: 10, step: { id: "place:battery" } },
    { t: 13, step: { id: "fit:arm_fl" } },
    { t: 16, step: { id: "fasten:stack", where: "after" }, sections: [{ axis: 0, at: 0.5 }] },
    { t: 20, camera: cam([400, -400, 300]), explode: 0, highlight: [], sections: [], callouts: [{ id: "c1", target: "stack/fc", text: "FC" }] },
  ],
};

describe("tourAt: a pure function of time", () => {
  it("gives the same frame for the same t, and the keyframes' values at their times", () => {
    expect(tourAt(TOUR, 8.4, { steps })).toEqual(tourAt(TOUR, 8.4, { steps }));
    const f0 = tourAt(TOUR, 0, { steps });
    expect(f0.camera).toEqual(cam([400, -400, 300]));
    expect(f0.explode).toBe(0);
    expect(f0.caption).toBe("The drone");
    const f3 = tourAt(TOUR, 3, { steps });
    expect(f3.camera!.position).toEqual([120, -120, 90]);
    expect(f3.highlight).toEqual(["stack"]);
    expect(f3.explode).toBe(0);
    expect(tourAt(TOUR, 7, { steps }).explode).toBe(1);
    // steps resolve through the player's windows: before = apart (window end), after = on (window start)
    expect(tourAt(TOUR, 10, { steps }).explode).toBe(1);
    expect(tourAt(TOUR, 10, { steps }).step).toBe("place:battery");
    expect(tourAt(TOUR, 13, { steps }).explode).toBe(0.6);
    expect(tourAt(TOUR, 16, { steps }).explode).toBe(0);
    expect(tourAt(TOUR, 16, { steps }).step).toBe("fasten:stack");
    const end = tourAt(TOUR, 25, { steps });
    expect(end.done).toBe(true);
    expect(end.t).toBe(20);
    expect(end.callouts).toEqual([{ id: "c1", target: "stack/fc", text: "FC" }]);
    expect(end.step).toBeNull();
  });

  it("eases numbers between keyframes and switches sets at them", () => {
    const mid = tourAt(TOUR, 5, { steps });
    expect(mid.explode).toBeCloseTo(ease("in-out", 0.5), 6);
    expect(tourAt(TOUR, 4, { steps }).explode!).toBeLessThan(0.5 * (1 / 4));
    expect(tourAt(TOUR, 2.9, { steps }).highlight).toBeUndefined();
    // sections slide when the planes match, else switch at the keyframe
    expect(tourAt(TOUR, 17, { steps }).sections).toEqual([{ axis: 0, at: 0.5 }]);
    expect(tourAt(TOUR, 20, { steps }).sections).toEqual([]);
    expect(ease("hold", 0.99)).toBe(0);
    expect(ease("linear", 0.25)).toBe(0.25);
  });

  it("swings the camera round the target rather than through the model", () => {
    const a = cam([100, 0, 0]);
    const b = cam([0, 100, 0]);
    const m = cameraBetween(a, b, 0.5);
    expect(Math.hypot(...m.position)).toBeCloseTo(100, 3);
    expect(m.position[0]).toBeCloseTo(70.7107, 3);
    const far = cameraBetween(cam([10, 0, 0]), cam([1000, 0, 0]), 0.5);
    expect(far.position[0]).toBeCloseTo(100, 3); // geometric
  });

  it("loops by wrapping time, and samples evenly for stills", () => {
    const loop = { ...TOUR, loop: true };
    expect(tourAt(loop, 23, { steps })).toEqual({ ...tourAt(loop, 3, { steps }) });
    expect(tourAt(loop, 23, { steps }).done).toBe(false);
    expect(tourSampleTimes(TOUR, 3)).toEqual([0, 10, 20]);
  });

  it("without the player's windows, a step keyframe still names the step (the view's player resolves it)", () => {
    const f = tourAt(TOUR, 11);
    expect(f.step).toBe("place:battery");
    // the explode track runs between the keyframes that give an amount (7 s: 1, 20 s: 0)
    expect(f.explode).toBeGreaterThan(0.5);
    expect(f.explode).toBeLessThan(1);
  });

  it("writes the view state through typed set ops", () => {
    const ops = tourOps(tourAt(TOUR, 16, { steps }));
    const byKey = Object.fromEntries(ops.map((o) => [o.path.join("."), o.value]));
    expect(byKey.explode).toEqual({ t: 0, step: "fasten:stack" });
    expect(byKey.highlight).toEqual(["stack"]);
    expect(byKey.sections).toEqual([{ axis: 0, at: 0.5 }]);
    expect(byKey.camera).toBeDefined();
    expect(ops.every((o) => o.op === "set")).toBe(true);
  });
});

describe("authoring and handing over a tour", () => {
  it("builds a tour from view-state snapshots (move, then hold)", () => {
    const t = tourFromSnapshots("snap", [
      { state: { camera: cam([100, 0, 0]), explode: { t: 0, step: null } }, caption: "start" },
      { state: { camera: cam([0, 100, 0]), explode: { t: 1, step: "place:battery" }, isolation: ["battery"] }, moveS: 2, holdS: 1 },
    ]);
    expect(t.keyframes.map((k) => k.t)).toEqual([0, 1.5, 3.5, 4.5]);
    expect(tourAt(t, 1.5).camera!.position).toEqual([100, 0, 0]);
    expect(tourAt(t, 3.5).isolation).toEqual(["battery"]);
    expect(tourAt(t, 3.5).step).toBe("place:battery");
    expect(tourAt(t, 4).caption).toBe("start");
  });

  it("round-trips as JSON and refuses what it cannot play", () => {
    const back = parseTour(JSON.parse(serializeTour(TOUR)));
    expect(back).toEqual(TOUR);
    expect(parseTour({ ...TOUR, keyframes: [TOUR.keyframes[2], TOUR.keyframes[0]] }).keyframes[0].t).toBe(0);
    expect(() => parseTour({ ...TOUR, schema: "x" })).toThrow(/schema/);
    expect(() => parseTour({ ...TOUR, keyframes: [] })).toThrow(/keyframes/);
    expect(() => parseTour({ ...TOUR, keyframes: [{ t: -1 }] })).toThrow(/t must/);
    expect(() => parseTour({ ...TOUR, keyframes: [{ t: 0, explode: 2 }] })).toThrow(/explode/);
    expect(() => parseTour({ ...TOUR, keyframes: [{ t: 0, caption: "x".repeat(600) }] })).toThrow(/caption/);
    expect(() => parseTour({ ...TOUR, keyframes: Array.from({ length: 300 }, (_, i) => ({ t: i })) })).toThrow(/keyframes/);
  });
});

describe("live playback with hand-back", () => {
  it("pauses on the person's input and takes the view back after 25 s of quiet", () => {
    const p = new TourPlayback(TOUR, { steps });
    expect(p.tick(1)!.t).toBe(1);
    p.userInput();
    expect(p.tick(10)).toBeUndefined();
    expect(p.state().driver).toBe("user");
    expect(p.tick(14.9)).toBeUndefined();
    const back = p.tick(0.2)!;
    expect(back.t).toBeCloseTo(1.2, 6);
    expect(p.state().driver).toBe("tour");
    // never resumes on its own when the person turned that off
    const q = new TourPlayback(TOUR, {}, { resumeAfterS: null });
    q.userInput();
    expect(q.tick(1000)).toBeUndefined();
    q.resume();
    expect(q.tick(1)).toBeDefined();
    // ends
    const r = new TourPlayback(TOUR);
    expect(r.tick(30)!.done).toBe(true);
    expect(r.tick(1)).toBeUndefined();
  });
});

describe("the sequence player's step write-back (wave 2 gate)", () => {
  const empty = { instances: [], placements: [], mates: [], routes: [], hardware: [], harnesses: [], unrouted: [], issues: [] } as unknown as Assembly;
  const rise = new Map([
    ["a", 10],
    ["b", 20],
  ]);
  it("tells the view the current step after goto, set and play", () => {
    const p = new SequencePlayer(resolveSequence({ assembly: empty, gap: 10, planned: rise }, sequenceFromPlan(rise), "planner"));
    const seen: (string | null)[] = [];
    const off = p.onStepChange((s) => seen.push(s));
    const ids = p.snapshot().steps.map((s) => s.id);
    expect(p.run({ action: "goto", step: ids[1] }).ok).toBe(true);
    expect(p.currentStep()).toBe(ids[1]);
    p.run({ action: "set", t: 0 });
    p.run({ action: "play", mode: "explode" });
    for (let i = 0; i < 200 && p.tick(0.05); i++);
    expect(seen[0]).toBe(ids[1]);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.at(-1)).toBe(p.currentStep());
    off();
    const n = seen.length;
    p.run({ action: "goto", step: ids[0] });
    expect(seen.length).toBe(n);
  });
});
