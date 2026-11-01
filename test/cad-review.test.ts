/**
 * The view critic (PB-1188): a deliberately bad view gives the findings an
 * agent must fix before sending a capture; a good one passes. Pure, over an
 * observation shaped like `__cad.observe()` plus the view state.
 */
import { describe, expect, it } from "vitest";
import { projectBounds, reviewPasses, reviewProbes, reviewView, type ReviewObservation } from "../src/cad/review";

const node = (id: string, min: [number, number, number], max: [number, number, number], kind = "body") => ({ id, instancePath: id, kind, bounds: [min, max] as [[number, number, number], [number, number, number]], visible: true });

/** A drone-ish scene: frame at the bottom, the FC stack in the middle, a top plate over it. */
const NODES = [
  node("frame", [-92, -92, 0], [92, 92, 5]),
  node("stack/fc", [-18, -18, 12], [18, 18, 20]),
  node("stack/fc/u3", [-3, -3, 20], [3, 3, 21.5], "component"),
  node("top_plate", [-40, -40, 30], [40, 40, 32]),
  node("battery", [-20, -40, 32], [20, 40, 60]),
];

const good: ReviewObservation = {
  nodes: NODES,
  camera: { position: [80, -80, 90], target: [0, 0, 16], up: [0, 0, 1], fov: 40 },
  selection: { body: "stack/fc" },
  canvas: { width: 1440, height: 900 },
  state: { highlight: [], isolation: null, sections: [], explode: { t: 0, step: null }, visibility: { hidden: [] } },
  labels: [{ id: "fc", rect: [700, 300, 120, 28], target: "stack/fc" }],
  picks: [{ subject: "stack/fc", at: [0.5, 0.5], hit: { instancePath: "stack/fc" } }],
};

describe("reviewView", () => {
  it("passes a good view (only infos at most)", () => {
    const f = reviewView(good, { subject: "stack/fc" });
    expect(reviewPasses(f)).toBe(true);
  });

  it("finds every fault in a deliberately bad view", () => {
    const bad: ReviewObservation = {
      ...good,
      // camera far away and looking past the subject, from the side, so the top plate stands in front of the stack
      camera: { position: [4000, -60, 16], target: [2000, 5000, 16], up: [0, 0, 1], fov: 40 },
      selection: {},
      state: { highlight: [], isolation: ["frame", "top_plate", "battery", "a", "b", "c", "d"], sections: [{ axis: 2, at: 0.9, flip: true }], explode: { t: 0.7, step: null }, visibility: { hidden: [] } },
      labels: [
        { id: "a", rect: [100, 100, 200, 30] },
        { id: "b", rect: [180, 110, 200, 30] },
        { id: "c", rect: [1400, 880, 120, 40] },
        { id: "d", rect: [-300, 20, 100, 20] },
      ],
      picks: [],
    };
    const codes = reviewView(bad, { subject: ["stack/fc", "battery"], measuring: true }).map((f) => f.code);
    // stack/fc is outside the isolation (an error that stops further checks on it)
    expect(codes).toContain("SUBJECT_NOT_ISOLATED");
    // the battery is isolated but out of frame
    expect(codes).toContain("SUBJECT_NOT_IN_FRAME");
    expect(codes).toContain("NOTHING_SELECTED");
    expect(codes).toContain("TOO_MANY_ISOLATED");
    expect(codes).toContain("EXPLODED_WHILE_MEASURING");
    expect(codes).toContain("LABEL_OVERLAP");
    expect(codes).toContain("LABEL_OFF_CANVAS");
    const sev = reviewView(bad, { subject: "battery", measuring: true });
    expect(sev[0].severity).toBe("error");
    expect(reviewPasses(sev)).toBe(false);
  });

  it("finds a subject too small, occluded, cut away by a section, and hidden", () => {
    const far = { ...good, camera: { position: [3000, -3000, 2500] as [number, number, number], target: [0, 0, 16] as [number, number, number], up: [0, 0, 1] as [number, number, number], fov: 40 } };
    expect(reviewView(far, { subject: "stack/fc/u3" }).map((f) => f.code)).toContain("SUBJECT_TOO_SMALL");
    const blocked = { ...good, picks: [{ subject: "stack/fc", at: [0.5, 0.5] as [number, number], hit: { instancePath: "top_plate" } }] };
    const occ = reviewView(blocked, { subject: "stack/fc" }).find((f) => f.code === "SUBJECT_OCCLUDED")!;
    expect(occ.data).toEqual({ by: "top_plate" });
    // a hit on the subject's own component is not occlusion
    expect(reviewView({ ...good, picks: [{ subject: "stack/fc", at: [0.5, 0.5], hit: { instancePath: "stack/fc/u3" } }] }, { subject: "stack/fc" }).map((f) => f.code)).not.toContain("SUBJECT_OCCLUDED");
    // keep the + side above z 45: the stack (12..20) is gone
    const cut = { ...good, state: { ...good.state, sections: [{ axis: 2 as const, at: 0.75, flip: true }] } };
    expect(reviewView(cut, { subject: "stack/fc" }).map((f) => f.code)).toContain("SECTION_HIDES_SUBJECT");
    const through = { ...good, state: { ...good.state, sections: [{ axis: 2 as const, at: 0.27, flip: true }] } };
    expect(reviewView(through, { subject: "stack/fc" }).map((f) => f.code)).toContain("SECTION_CUTS_SUBJECT");
    const hidden = { ...good, state: { ...good.state, visibility: { hidden: ["stack"] } } };
    expect(reviewView(hidden, { subject: "stack/fc" }).map((f) => f.code)).toEqual(["SUBJECT_HIDDEN"]);
    expect(reviewView(good, { subject: "nope" })[0].code).toBe("SUBJECT_NOT_FOUND");
  });

  it("says where to pick for occlusion, and projects bounds like the view", () => {
    const probes = reviewProbes(good, { subject: ["stack/fc", "battery"] });
    expect(probes).toHaveLength(2);
    for (const p of probes) for (const v of p.at) expect(v).toBeGreaterThan(0);
    // the target projects to the canvas centre
    const pr = projectBounds(good.camera, good.canvas!, [good.camera.target, good.camera.target]);
    expect(pr.centre![0]).toBeCloseTo(0.5, 9);
    expect(pr.centre![1]).toBeCloseTo(0.5, 9);
    // behind the camera: no rect
    expect(projectBounds(good.camera, good.canvas!, [[200, -200, 200], [210, -210, 210]]).rect).toBeNull();
  });
});
