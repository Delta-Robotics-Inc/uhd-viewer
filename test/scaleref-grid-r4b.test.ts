/**
 * R4-B (2026-11-02): the infinite floor grid's levels and units, and the scale references (banana, cube, Benchy):
 * placement outside the visible assembly's box (assembled and exploded), the cube's edge, the settings, the assets'
 * true size.
 */
import { BANANA_GLB_BASE64 } from "../src/cad/scaleref/assets/bananaGlb";
import { BENCHY_GLB_BASE64 } from "../src/cad/scaleref/assets/benchyGlb";
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { LADDERS, MM_PER_IN, formatLength, gridLevels, pxPerMmAt, readUnits, rungAlpha, rungWeight, MIN_LINE_PX } from "../src/cad/grid/levels";
import { awayFrom, floorAxes, lowAlong } from "../src/cad/grid";
import { gridLabelText } from "../src/cad/grid/label";
import { GRID_LINES_GLSL, MAX_RUNGS, gridUniforms, setLadder } from "../src/cad/grid/shader";
import { cubeEdgeFor, CUBE_EDGES } from "../src/cad/scaleref/cube";
import { cameraLeft, floorExtent, placeBeside, sideToward, standHeight, GAP_MIN_MM, type Footprint, type Side } from "../src/cad/scaleref/place";
import { DEFAULT_SCALE_KIND, readScaleKind, readScaleSettings, rememberScaleSetting, scaleButtonLabel, SCALE_STORAGE_KEY } from "../src/cad/scaleref/kinds";

const Z = new THREE.Vector3(0, 0, 1);
const box = (min: number[], max: number[]) => new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max));
const BANANA: Footprint = { length: 182.2, width: 85.3, height: 41.8 };
const BENCHY: Footprint = { length: 60, width: 31, height: 48 };

describe("floor grid levels", () => {
  it("picks the finest rung at least MIN_LINE_PX apart, and the one above it as major (mm)", () => {
    // 3 px per mm (a 300 mm model across ~900 px): 1 mm lines are 3 px apart (hidden), 10 mm lines 30 px
    let l = gridLevels(3, "mm");
    expect([l.minorMm, l.majorMm]).toEqual([10, 100]);
    // zoomed in 10x: 1 mm lines 30 px apart
    l = gridLevels(30, "mm");
    expect([l.minorMm, l.majorMm]).toEqual([1, 10]);
    // very close: 0.1 mm lines
    expect(gridLevels(200, "mm").minorMm).toBe(0.1);
    // zoomed far out: 1 m and 10 m
    expect([gridLevels(0.01, "mm").minorMm, gridLevels(0.01, "mm").majorMm]).toEqual([1000, 10000]);
    // past the ladder's top: the top rung is both
    const top = gridLevels(1e-6, "mm");
    expect([top.minorMm, top.majorMm]).toEqual([10000, 10000]);
  });

  it("steps through 1/16 in, 1 in, 1 ft in inches", () => {
    expect(LADDERS.in).toEqual([MM_PER_IN / 16, MM_PER_IN, 12 * MM_PER_IN, 120 * MM_PER_IN]);
    expect(gridLevels(10, "in").minorMm).toBeCloseTo(MM_PER_IN / 16); // 1/16 in = 15.9 px
    expect(gridLevels(10, "in").majorMm).toBeCloseTo(MM_PER_IN);
    expect(gridLevels(1, "in").minorMm).toBeCloseTo(MM_PER_IN); // 1/16 in = 1.6 px: hidden
    expect(gridLevels(0.1, "in").minorMm).toBeCloseTo(12 * MM_PER_IN);
  });

  it("changes level smoothly: the rung that drops out is invisible, the one taking over keeps its look", () => {
    // just above the threshold, the minor rung is (nearly) transparent
    expect(rungAlpha(MIN_LINE_PX * 1.0001)).toBeLessThan(1e-3);
    // after the step the new minor rung (the old major, 10x apart) is fully opaque and was so before too
    expect(rungAlpha(10 * MIN_LINE_PX)).toBe(1);
    // its tone is a function of its own spacing only, so it does not jump at the step
    const before = rungWeight(10 * MIN_LINE_PX * 1.0001);
    const after = rungWeight(10 * MIN_LINE_PX * 0.9999);
    expect(Math.abs(before - after)).toBeLessThan(1e-3);
    // the label names the major rung
    expect(gridLabelText(gridLevels(3, "mm")).text).toBe("100 mm");
    expect(gridLabelText(gridLevels(30, "mm")).tooltip).toBe("Floor grid: major lines every 10 mm, minor every 1 mm");
  });

  it("measures pixels per mm from the camera", () => {
    // 32 degree field of view, 900 px tall, 800 mm away: about 3.9 px per mm
    expect(pxPerMmAt(800, 32, 900)).toBeCloseTo(900 / (2 * 800 * Math.tan((16 * Math.PI) / 180)), 6);
    expect(pxPerMmAt(400, 32, 900)).toBeCloseTo(2 * pxPerMmAt(800, 32, 900), 6);
  });

  it("words lengths in mm, m, inches and feet", () => {
    expect(formatLength(0.1, "mm")).toBe("0.1 mm");
    expect(formatLength(10, "mm")).toBe("10 mm");
    expect(formatLength(1000, "mm")).toBe("1 m");
    expect(formatLength(MM_PER_IN / 16, "in")).toBe("1/16 in");
    expect(formatLength(MM_PER_IN, "in")).toBe("1 in");
    expect(formatLength(12 * MM_PER_IN, "in")).toBe("1 ft");
    expect(formatLength(120 * MM_PER_IN, "in")).toBe("10 ft");
    expect(readUnits("in")).toBe("in");
    expect(readUnits("cm")).toBe("mm");
  });

  it("feeds the shader the same ladder and curves", () => {
    const u = gridUniforms("in");
    expect(u.uRungs.value).toBe(4);
    expect(u.uLadder.value.length).toBe(MAX_RUNGS);
    expect(u.uLadder.value[1]).toBeCloseTo(MM_PER_IN);
    setLadder(u, "mm");
    expect(u.uRungs.value).toBe(6);
    expect(u.uLadder.value.slice(0, 6)).toEqual([...LADDERS.mm]);
    // the GLSL fades with the same thresholds as rungAlpha / rungWeight
    expect(GRID_LINES_GLSL).toContain("smoothstep(uMinPx, 4.0 * uMinPx, px)");
    expect(GRID_LINES_GLSL).toContain("smoothstep(4.0 * uMinPx, 30.0 * uMinPx, px)");
  });

  it("pushes the theme's line colours away from the ground (dark and paper), clamped", () => {
    const hex = (a: string, b: string) => awayFrom(new THREE.Color(a), new THREE.Color(b)).getHexString();
    expect(hex("#2a2a2a", "#131313")).toBe("414141");
    expect(hex("#e0e0dc", "#fbfbfa")).toBe("c5c5be");
    expect(hex("#ffffff", "#000000")).toBe("ffffff");
  });

  it("lays the floor across the up axis", () => {
    const z = floorAxes(Z);
    expect(z.keys).toEqual(["x", "y"]);
    expect(z.u.toArray()).toEqual([1, 0, 0]);
    const y = floorAxes(new THREE.Vector3(0, 1, 0));
    expect(y.keys).toEqual(["x", "z"]);
    expect(Math.abs(y.u.dot(new THREE.Vector3(0, 1, 0)))).toBeLessThan(1e-12);
    expect(Math.abs(y.v.dot(new THREE.Vector3(0, 1, 0)))).toBeLessThan(1e-12);
    expect(lowAlong(box([-5, -5, 3], [5, 5, 9]), Z)).toBe(3);
  });
});

describe("scale reference placement", () => {
  const assembled = box([-120, -100, 0], [120, 100, 60]);
  // the drone exploded: the box grows outwards and upwards
  const exploded = box([-260, -230, -40], [260, 230, 300]);
  const sides: Side[] = ["+u", "-u", "+v", "-v"];

  for (const [name, fp] of [["banana", BANANA], ["benchy", BENCHY], ["cube 100 mm", { length: 100, width: 100, height: 100 }]] as const)
    it(`puts the ${name} outside the box on every side, assembled and exploded`, () => {
      for (const b of [assembled, exploded])
        for (const side of sides) {
          const p = placeBeside(b, Z, fp, side);
          expect(p.box.intersectsBox(b)).toBe(false);
          // a gap of 10 % of the larger floor extent
          const e = floorExtent(b, Z);
          const size = Math.max(e.u[1] - e.u[0], e.v[1] - e.v[0]);
          const gap = side === "+u" ? p.box.min.x - b.max.x : side === "-u" ? b.min.x - p.box.max.x : side === "+v" ? p.box.min.y - b.max.y : b.min.y - p.box.max.y;
          expect(gap).toBeCloseTo(Math.max(GAP_MIN_MM, 0.1 * size), 6);
          // on the floor where the model stands, at its true size
          expect(p.box.min.z).toBeCloseTo(b.min.z, 6);
          expect(p.box.max.z - p.box.min.z).toBeCloseTo(fp.height, 6);
          // the long axis runs along the side
          const sizeX = p.box.max.x - p.box.min.x;
          expect(sizeX).toBeCloseTo(side === "+u" || side === "-u" ? fp.width : fp.length, 6);
        }
    });

  it("moves outward when the explode grows the box, and back when it shrinks", () => {
    const a = placeBeside(assembled, Z, BANANA, "-u");
    const x = placeBeside(exploded, Z, BANANA, "-u");
    expect(x.position.x).toBeLessThan(a.position.x - 100);
    expect(placeBeside(assembled, Z, BANANA, "-u").position.distanceTo(a.position)).toBe(0);
  });

  it("stands on the grid's floor when there is one", () => {
    const p = placeBeside(assembled, Z, BANANA, "+v", standHeight(assembled, Z, -10.5));
    expect(p.box.min.z).toBeCloseTo(-10, 6);
    expect(p.box.intersectsBox(assembled)).toBe(false);
  });

  it("takes the side toward the camera's left", () => {
    // the camera in front of the model (at -y), looking at +y: its left is -x
    const cam = { position: new THREE.Vector3(0, -800, 300) };
    expect(sideToward(cameraLeft(cam, new THREE.Vector3(0, 0, 0), Z), Z)).toBe("-u");
    // looking from +x toward -x: its left is -y
    expect(sideToward(cameraLeft({ position: new THREE.Vector3(800, 0, 300) }, new THREE.Vector3(), Z), Z)).toBe("-v");
  });

  it("works with Y up", () => {
    const up = new THREE.Vector3(0, 1, 0);
    const b = box([-50, 0, -40], [50, 80, 40]);
    for (const side of ["+u", "-u", "+v", "-v"] as Side[]) {
      const p = placeBeside(b, up, BENCHY, side);
      expect(p.box.intersectsBox(b)).toBe(false);
      expect(p.box.min.y).toBeCloseTo(0, 6);
      expect(p.box.max.y).toBeCloseTo(48, 6);
    }
  });
});

describe("the cube for scale", () => {
  it("snaps its edge to the rung just below the model's size, mm", () => {
    expect(CUBE_EDGES.mm).toEqual([1, 10, 100, 1000]);
    expect(cubeEdgeFor(250, "mm")).toBe(100);
    expect(cubeEdgeFor(100, "mm")).toBe(100);
    expect(cubeEdgeFor(99.9, "mm")).toBe(10);
    expect(cubeEdgeFor(60, "mm")).toBe(10);
    expect(cubeEdgeFor(5, "mm")).toBe(1);
    expect(cubeEdgeFor(0.4, "mm")).toBe(1);
    expect(cubeEdgeFor(4200, "mm")).toBe(1000);
    expect(cubeEdgeFor(NaN, "mm")).toBe(1);
  });

  it("snaps to 1/16 in, 1 in or 1 ft in inches, and says so", () => {
    expect(cubeEdgeFor(250, "in")).toBeCloseTo(MM_PER_IN); // 9.8 in: a 1 in cube
    expect(cubeEdgeFor(400, "in")).toBeCloseTo(12 * MM_PER_IN); // 15.7 in: a 1 ft cube
    expect(cubeEdgeFor(10, "in")).toBeCloseTo(MM_PER_IN / 16);
    expect(formatLength(cubeEdgeFor(400, "in"), "in")).toBe("1 ft");
    expect(formatLength(cubeEdgeFor(60, "mm"), "mm")).toBe("10 mm");
  });
});

describe("scale reference settings", () => {
  const kv = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };

  it("defaults to the banana and mm", () => {
    expect(readScaleSettings(undefined, undefined)).toEqual({ units: "mm", scaleReference: "banana" });
    expect(DEFAULT_SCALE_KIND).toBe("banana");
    expect(readScaleKind("teapot")).toBe("banana");
  });

  it("takes the host's values first, then this browser's, and remembers a choice both ways", () => {
    const s = kv();
    const saved: [string, unknown][] = [];
    rememberScaleSetting("scaleReference", "benchy", (k, v) => saved.push([k, v]), s);
    rememberScaleSetting("units", "in", (k, v) => saved.push([k, v]), s);
    expect(saved).toEqual([["viewer.scaleReference", "benchy"], ["viewer.units", "in"]]);
    expect(JSON.parse(s.m.get(SCALE_STORAGE_KEY)!)).toEqual({ scaleReference: "benchy", units: "in" });
    expect(readScaleSettings({}, s)).toEqual({ units: "in", scaleReference: "benchy" });
    expect(readScaleSettings({ units: "mm", scaleReference: "cube" }, s)).toEqual({ units: "mm", scaleReference: "cube" });
    // a broken store is no store
    expect(readScaleSettings({}, { getItem: () => "{nope", setItem: () => undefined })).toEqual({ units: "mm", scaleReference: "banana" });
  });

  it("names the choice in the tooltip", () => {
    expect(scaleButtonLabel("banana", false)).toBe("Banana for scale");
    expect(scaleButtonLabel("cube", true)).toBe("Cube for scale: on");
    expect(scaleButtonLabel("benchy", false)).toBe("Benchy for scale");
  });
});

describe("the shipped assets are at true size", () => {
  /** The GLB's POSITION bounds, glTF metres Y-up, turned to mm Z-up as ./assets.ts does: (x, -z, y) x 1000. */
  const sizeMm = (b64: string) => {
    const b = Buffer.from(b64, "base64");
    expect(b.readUInt32LE(0)).toBe(0x46546c67);
    const len = b.readUInt32LE(12);
    const json = JSON.parse(b.subarray(20, 20 + len).toString("utf8")) as { accessors: { min: number[]; max: number[] }[]; meshes: { primitives: { attributes: { POSITION: number } }[] }[] };
    const a = json.accessors[json.meshes[0].primitives[0].attributes.POSITION];
    const [x, y, z] = [0, 1, 2].map((k) => (a.max[k] - a.min[k]) * 1000);
    return { x, y: z, z: y, minUp: a.min[1] * 1000, bytes: b.length };
  };

  it("the banana: Kevin's scan, 182 x 85 x 42 mm, its base at 0", () => {
    const s = sizeMm(BANANA_GLB_BASE64);
    expect(s.x).toBeCloseTo(182.2, 0);
    expect(s.y).toBeCloseTo(85.3, 0);
    expect(s.z).toBeCloseTo(41.8, 0);
    expect(s.minUp).toBeCloseTo(0, 6);
    expect(s.bytes).toBeLessThan(300 * 1024);
  });

  it("the Benchy: 60 x 31 x 48 mm", () => {
    const s = sizeMm(BENCHY_GLB_BASE64);
    expect(s.x).toBeCloseTo(60, 1);
    expect(s.y).toBeCloseTo(31, 1);
    expect(s.z).toBeCloseTo(48, 1);
    expect(s.bytes).toBeLessThan(400 * 1024);
  });
});
