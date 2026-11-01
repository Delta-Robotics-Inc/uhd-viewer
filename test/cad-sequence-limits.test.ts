/**
 * Joint limits as hard stops in the viewer's sequence (PB-1185): a rest beyond
 * a stop held and flagged, step keyframes held at the stops and surfaced on
 * the step API (snapshot steps' `limits`), keyframes played through poseAt in
 * assembly order, a drive beyond a stop held and reported by `run`, a mate's
 * world line (`{ at, axis }`) as a frame, and currentStep()/onStepChange()
 * behaving as before.
 */
import { describe, expect, it } from "vitest";
import type { Assembly, Mat4 } from "@uhd/system/geometry.js";
import type { ModuleDef } from "@uhd/types/index.js";
import { SequencePlayer, applyPoint, generateSequence, poseAt, resolveFrame, resolveSequence, type SequenceFile } from "../src/cad/sequence";
// not in the sequence index (that file is not W4-E's this wave): from resolve.ts itself
import { jointKeyframesAt } from "../src/cad/sequence/resolve";

const T = (x: number, y: number, z: number): Mat4 => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
const def = (id: string): ModuleDef => ({ id, name: id, interfaces: [] }) as unknown as ModuleDef;
const bolt = (role: "structure" | "component") => ({ id: "mount", domain: "mechanical", protocols: [{ type: "bolt_pattern", roles: [role] }] });

/** A case with a lid bolted on top (one link). */
function fixture(): Assembly {
  return {
    instances: [],
    placements: [
      { key: "case", path: ["case"], matrix: T(0, 0, 0) },
      { key: "lid", path: ["lid"], matrix: T(0, 0, 20), via: "lid_mount" },
    ],
    mates: [{ linkId: "lid_mount", a: { path: ["lid"], def: def("lid"), iface: bolt("component"), frame: { origin: [0, 0, 0], normal: [0, 0, -1] } }, b: { path: ["case"], def: def("case"), iface: bolt("structure"), frame: { origin: [0, 0, 20], normal: [0, 0, 1] } } }],
    routes: [],
    hardware: [],
    harnesses: [],
    unrouted: [],
    issues: [],
  } as unknown as Assembly;
}

/** The generated sequence plus a hinge joint (as the mates module writes it: a world line) and an "open" keyframe step. */
function withHinge(rest = 0, open = 135): SequenceFile {
  const f = generateSequence(fixture(), { root: ["case"] });
  f.sequences[0].joints = [{ id: "hinge", type: "revolute", part: "lid", along: { at: [0, 30, 20], axis: [1, 0, 0] }, min: 0, max: 90, rest, limitsFrom: "mate:trait" }];
  f.sequences[0].steps.push({ id: "open", title: "Open the lid", kind: "action", members: [], joints: { hinge: open }, source: "authored" });
  return f;
}
const resolved = (f: SequenceFile) => resolveSequence({ assembly: fixture(), gap: 10 }, f);

describe("joint limits in resolve and poseAt", () => {
  it("resolves a mate's world line as a frame", () => {
    expect(resolveFrame(fixture(), { at: [0, 30, 20], axis: [2, 0, 0] }, [0, 0, 1])).toEqual({ origin: [0, 30, 20], axis: [1, 0, 0] });
  });
  it("holds a rest beyond a stop at the stop and flags the joint", () => {
    const j = resolved(withHinge(-15)).joints[0];
    expect(j.rest).toBe(0);
    expect(j.limited).toEqual({ joint: "hinge", asked: -15, held: 0, stop: "min" });
  });
  it("holds a keyframe beyond a stop and flags it on the step; the step is not still", () => {
    const r = resolved(withHinge());
    const open = r.steps.find((s) => s.id === "open")!;
    expect(open.joints).toEqual({ hinge: 90 });
    expect(open.limits).toEqual([{ joint: "hinge", asked: 135, held: 90, stop: "max" }]);
    expect(open.still).toBe(false);
  });
  it("plays keyframes in assembly order: assembled shows the last one (held), apart shows rest", () => {
    const r = resolved(withHinge());
    expect(jointKeyframesAt(r, 0)!.hinge).toBeCloseTo(90, 9);
    expect(jointKeyframesAt(r, 1)!.hinge).toBeCloseTo(0, 9);
    // the lid's far edge (0, 0, 20) swings 90 degrees about +x through (0, 30, 20): to (0, 30, -10)
    const lid = poseAt(r, { t: 0 }).get("lid")!;
    const p = applyPoint(lid, [0, 0, 20]);
    expect(p[1]).toBeCloseTo(30, 6);
    expect(p[2]).toBeCloseTo(-10, 6);
    // a driven value wins over the keyframe, and is held at the stop too
    const driven = applyPoint(poseAt(r, { t: 0, joints: { hinge: 400 } }).get("lid")!, [0, 0, 20]);
    expect(driven[2]).toBeCloseTo(-10, 6);
    // a file without keyframes costs nothing extra: no keyframe values at all
    expect(jointKeyframesAt(resolved(generateSequence(fixture(), { root: ["case"] })), 0)).toBeUndefined();
  });
});

describe("the player surfaces the stops", () => {
  it("reports a drive held at a stop through run() and the snapshot, and the step's flag in snapshot steps", () => {
    const player = new SequencePlayer(resolved(withHinge()));
    const r = player.run({ action: "joint", id: "hinge", value: 120 });
    expect(r).toEqual({ ok: true, held: { joint: "hinge", asked: 120, held: 90, stop: "max" } });
    const snap = player.snapshot();
    expect(snap.joints.hinge).toMatchObject({ value: 90, held: { asked: 120, stop: "max" } });
    expect(snap.steps.find((s) => s.id === "open")!.limits).toEqual([{ joint: "hinge", asked: 135, held: 90, stop: "max" }]);
    expect(snap.steps.find((s) => s.id === "fit:lid_mount")!.limits).toBeUndefined();
    // within the stops: no flag
    expect(player.run({ action: "joint", id: "hinge", value: 45 })).toEqual({ ok: true });
    expect(player.snapshot().joints.hinge.held).toBeUndefined();
  });
  it("keeps currentStep() and onStepChange() as they were", () => {
    const player = new SequencePlayer(resolved(withHinge()));
    const seen: (string | null)[] = [];
    const off = player.onStepChange((s) => seen.push(s));
    player.run({ action: "goto", step: "open" });
    expect(player.currentStep()).toBe("open");
    player.run({ action: "joint", id: "hinge", value: 200 });
    expect(player.currentStep()).toBe("open");
    off();
    expect(seen).toEqual(["open"]);
  });
});
