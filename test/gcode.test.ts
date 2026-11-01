/**
 * The G-code tab's parser, draw and layer range (PB-1192, W4-B). Fixtures in
 * test/fixtures/gcode/ are hand-written (no slicer output is copied): one per
 * comment style (PrusaSlicer/Orca `;TYPE:`, Bambu `; FEATURE:`, Cura `;LAYER:`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FEATURE_COUNT,
  GCODE_FEATURES,
  GcodeParser,
  buildGcodeDraw,
  featureFromName,
  featureIndex,
  gcodeEntry,
  parseGcode,
  parseGcodeStream,
  rangeLayers,
  rebaseRange,
  segmentTemplate,
  setEnd,
  visibleLayers,
  visibleMask,
  type GcodeModel,
} from "../src/gcode";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", "gcode", name), "utf8");
const feat = (id: string) => featureIndex(id);
const totals = (m: GcodeModel, id: string) => m.features.find((f) => f.feature === feat(id));
const seg = (m: GcodeModel, store: "extrude" | "travel", i: number) => {
  const c = m[store];
  return { start: Array.from(c.start.subarray(i * 3, i * 3 + 3)), end: Array.from(c.end.subarray(i * 3, i * 3 + 3)), feature: c.feature[i], layer: c.layer[i], width: c.width[i], height: c.height[i], line: c.line[i] };
};

describe("feature names from every slicer's comments", () => {
  it("maps PrusaSlicer/Orca, Bambu and Cura names onto one set of ids", () => {
    const cases: [string, string][] = [
      ["External perimeter", "outer-wall"],
      ["Outer wall", "outer-wall"],
      ["WALL-OUTER", "outer-wall"],
      ["Perimeter", "inner-wall"],
      ["Inner wall", "inner-wall"],
      ["WALL-INNER", "inner-wall"],
      ["Overhang perimeter", "overhang-wall"],
      ["Overhang wall", "overhang-wall"],
      ["Internal infill", "sparse-infill"],
      ["Sparse infill", "sparse-infill"],
      ["FILL", "sparse-infill"],
      ["Solid infill", "solid-infill"],
      ["Internal solid infill", "solid-infill"],
      ["SKIN", "solid-infill"],
      ["Top solid infill", "top-surface"],
      ["Top surface", "top-surface"],
      ["Bottom surface", "bottom-surface"],
      ["Bridge infill", "bridge"],
      ["Internal Bridge", "bridge"],
      ["Support material", "support"],
      ["SUPPORT", "support"],
      ["Support material interface", "support-interface"],
      ["SUPPORT-INTERFACE", "support-interface"],
      ["Skirt/Brim", "skirt-brim"],
      ["SKIRT", "skirt-brim"],
      ["Brim", "skirt-brim"],
      ["Wipe tower", "prime-tower"],
      ["Prime tower", "prime-tower"],
      ["PRIME-TOWER", "prime-tower"],
      ["Ironing", "ironing"],
      ["Gap infill", "gap-fill"],
      ["Gap fill", "gap-fill"],
      ["Custom", "custom"],
      ["Something new", "custom"],
    ];
    for (const [name, id] of cases) expect(GCODE_FEATURES[featureFromName(name)].id, name).toBe(id);
    expect(FEATURE_COUNT).toBe(16);
    expect(new Set(GCODE_FEATURES.map((f) => f.color)).size).toBe(16);
  });
});

describe("PrusaSlicer-style file (;TYPE:, ;LAYER_CHANGE, relative E, arcs)", () => {
  const m = parseGcode(fixture("prusa-style.gcode"));

  it("finds three layers from the layer comments, with their Z and height", () => {
    expect(m.layerSource).toBe("markers");
    expect(m.layers.count).toBe(3);
    expect(Array.from(m.layers.z).map((z) => +z.toFixed(3))).toEqual([0.2, 0.4, 0.6]);
    expect(Array.from(m.layers.height).map((h) => +h.toFixed(3))).toEqual([0.2, 0.2, 0.2]);
  });

  it("splits extrusions from travel, and a retract or unretract is no segment", () => {
    // layer 0: skirt 4, external 4, perimeter 4, solid 2; layer 1: external 4, infill 1, overhang 1; layer 2: two quarter arcs
    const arcs = m.extrude.count - 20;
    expect(arcs).toBe(26);
    expect(m.travel.count).toBe(14);
    expect(totals(m, "skirt-brim")?.segments).toBe(4);
    expect(totals(m, "outer-wall")?.segments).toBe(8);
    expect(totals(m, "inner-wall")?.segments).toBe(4);
    expect(totals(m, "solid-infill")?.segments).toBe(2);
    expect(totals(m, "sparse-infill")?.segments).toBe(1);
    expect(totals(m, "overhang-wall")?.segments).toBe(1);
    expect(totals(m, "top-surface")?.segments).toBe(26);
    expect(totals(m, "custom")).toBeUndefined(); // ;TYPE:Custom has only travel and a retract
  });

  it("keeps the source line, the bead width from ;WIDTH: and the height from ;HEIGHT:", () => {
    const first = seg(m, "extrude", 0);
    expect(first.start).toEqual([5, 5, expect.closeTo(0.2, 5)]);
    expect(first.end).toEqual([17, 5, expect.closeTo(0.2, 5)]);
    expect(first.feature).toBe(feat("skirt-brim"));
    expect(first.width).toBe(45);
    expect(first.height).toBe(20);
    expect(first.line).toBe(20);
  });

  it("linearises arcs within the chord tolerance, both centre forms", () => {
    const top = feat("top-surface");
    const pts: { x: number; y: number }[][] = [[], []];
    let k = 0;
    for (let i = 0; i < m.extrude.count; i++) {
      if (m.extrude.feature[i] !== top) continue;
      const s = seg(m, "extrude", i);
      pts[k < 13 ? 0 : 1].push({ x: s.end[0], y: s.end[1] });
      k++;
    }
    // G3 with I/J: about (13, 13), radius 5, ending at (13, 18)
    for (const p of pts[0]) expect(Math.hypot(p.x - 13, p.y - 13)).toBeCloseTo(5, 4);
    expect(pts[0].at(-1)).toEqual({ x: 13, y: 18 });
    // G2 with R: the short clockwise arc about (8, 18), ending at (8, 13)
    for (const p of pts[1]) expect(Math.hypot(p.x - 8, p.y - 18)).toBeCloseTo(5, 4);
    expect(pts[1].at(-1)).toEqual({ x: 8, y: 13 });
    // clockwise: the first piece moves right of (13, 18) seen from the centre, i.e. x grows from 13 (angle 0 to -90)
    expect(pts[1][0].x).toBeGreaterThan(12.9);
  });

  it("reads the slicer's estimate and makes its own, and names the slicer", () => {
    expect(m.slicerTimeS).toBe(67);
    expect(m.timeS).toBeGreaterThan(5);
    expect(m.generatedBy).toMatch(/^PrusaSlicer 2\.8\.1/);
    expect(m.filamentMm).toBeCloseTo(0.45 * 4 + 0.37 * 8 + 0.34 * 4 + 0.31 * 2 + 0.42 + 0.15 + 0.29 * 2, 5);
    expect(m.bounds?.min).toEqual([5, 5, expect.closeTo(0.2, 5)]);
    expect(m.bounds?.max[2]).toBeCloseTo(0.6, 5);
    // the park move and the Z hop are travel, left out of the bounds
    expect(m.bounds?.max[1]).toBeLessThan(20);
  });

  it("puts the Z-hop travel in the layer it belongs to, never a layer of its own", () => {
    expect(Array.from(m.layers.types).map((t) => !!(t & 1))).toEqual([true, true, true]);
    expect(m.layers.extrudeFirst[1]).toBe(14);
    expect(m.layers.extrudeEnd[1]).toBe(20);
  });
});

describe("Bambu-style file (; FEATURE:, ; CHANGE_LAYER, absolute E, M73)", () => {
  const m = parseGcode(fixture("bambu-style.gcode"));
  it("reads features, layers, widths and the M73 total", () => {
    expect(m.layerSource).toBe("markers");
    expect(m.layers.count).toBe(2);
    expect(m.extrude.count).toBe(9);
    expect(totals(m, "outer-wall")?.segments).toBe(6);
    expect(totals(m, "sparse-infill")?.segments).toBe(1);
    expect(totals(m, "bridge")?.segments).toBe(1);
    expect(totals(m, "support")?.segments).toBe(1);
    expect(seg(m, "extrude", 0).width).toBe(42);
    expect(seg(m, "extrude", 4).width).toBe(45);
    expect(m.slicerTimeS).toBe(120);
    expect(m.generatedBy).toMatch(/^BambuStudio/);
    // the absolute-E retract and unretract made no segments; the second layer's extrusions start at E 1.8
    expect(m.filamentMm).toBeCloseTo(1.8 + (3.2 - 1.8), 5);
  });
});

describe("Cura-style file (;LAYER:n, ;TYPE:WALL-OUTER, G0, G91 lift)", () => {
  const m = parseGcode(fixture("cura-style.gcode"));
  it("reads Cura's names and layers, and relative moves after G91", () => {
    expect(m.layers.count).toBe(2);
    expect(totals(m, "outer-wall")?.segments).toBe(4);
    expect(totals(m, "inner-wall")?.segments).toBe(1);
    expect(totals(m, "solid-infill")?.segments).toBe(1);
    expect(totals(m, "sparse-infill")?.segments).toBe(1);
    expect(totals(m, "support-interface")?.segments).toBe(1);
    expect(m.slicerTimeS).toBe(95);
    expect(m.generatedBy).toMatch(/^Cura_SteamEngine/);
    const last = seg(m, "travel", m.travel.count - 1);
    expect(last.start[2]).toBeCloseTo(0.5, 5);
    expect(last.end[2]).toBeCloseTo(5.5, 5);
  });
});

describe("files with no layer comments, units and modes", () => {
  it("starts a layer at each extrusion with a new Z, and never for a Z hop", () => {
    const m = parseGcode(["G90", "G1 Z0.2", "G1 X10 E1", "G1 Z0.6", "G1 X0", "G1 Z0.2", "G1 Y10 E2", "G1 Z0.4", "G1 X10 E3", "G1 Y0 E4"].join("\n"));
    expect(m.layerSource).toBe("z");
    expect(m.layers.count).toBe(2);
    expect(Array.from(m.layers.z).map((z) => +z.toFixed(2))).toEqual([0.2, 0.4]);
    // Z to 0.2, the hop up, across, back down, and the move up to 0.4: all travel
    expect(m.travel.count).toBe(5);
    expect(m.extrude.count).toBe(4);
  });

  it("reads inches (G20), relative axes (G91), G92 and G28", () => {
    const m = parseGcode(["G20", "G90", "G1 X1 Y0 Z0.01 F60", "G91", "G1 X1 E0.01", "G90", "G92 X0 Y0", "G1 X1 E0.02", "G28", "G21", "G1 X5 E1"].join("\n"));
    const a = seg(m, "extrude", 0);
    expect(a.start[0]).toBeCloseTo(25.4, 4);
    expect(a.end[0]).toBeCloseTo(50.8, 4);
    const b = seg(m, "extrude", 1);
    expect(b.start[0]).toBeCloseTo(0, 6); // after G92 X0
    expect(b.end[0]).toBeCloseTo(25.4, 4);
    const c = seg(m, "extrude", 2);
    expect(c.start).toEqual([0, 0, 0]); // after G28
    expect(c.end[0]).toBe(5);
  });

  it("draws a full circle for a G2 that ends where it starts", () => {
    const m = parseGcode(["G1 X10 Y0 Z0.2", "G2 X10 Y0 I-10 J0 E5"].join("\n"));
    let sweep = 0;
    for (let i = 0; i < m.extrude.count; i++) {
      const s = seg(m, "extrude", i);
      const a0 = Math.atan2(s.start[1], s.start[0]);
      let d = Math.atan2(s.end[1], s.end[0]) - a0;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      sweep += d;
    }
    expect(sweep).toBeCloseTo(-2 * Math.PI, 3);
  });

  it("ignores checksums, line numbers, parenthesis comments and commands it does not draw", () => {
    const m = parseGcode(["N10 G1 X0 Y0 Z0.2*33", "N11 G1 X10 (a comment) E1*90", "M106 S255", "T1", "G4 P100", "G29.1"].join("\n"));
    expect(m.extrude.count).toBe(1);
    expect(seg(m, "extrude", 0).end[0]).toBe(10);
  });

  it("parses the same whatever the chunk boundaries (streaming)", async () => {
    const text = fixture("prusa-style.gcode");
    const whole = parseGcode(text);
    const parts = new GcodeParser();
    for (let i = 0; i < text.length; i += 7) parts.push(text.slice(i, i + 7));
    const chunked = parts.finish();
    expect(chunked.extrude.count).toBe(whole.extrude.count);
    expect(Array.from(chunked.extrude.end.subarray(0, whole.extrude.count * 3))).toEqual(Array.from(whole.extrude.end.subarray(0, whole.extrude.count * 3)));
    const bytes = new TextEncoder().encode(text);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += 13) c.enqueue(bytes.subarray(i, i + 13));
        c.close();
      },
    });
    const streamed = await parseGcodeStream(stream);
    expect(streamed.extrude.count).toBe(whole.extrude.count);
    expect(streamed.layers.count).toBe(whole.layers.count);
  });
});

/** A synthetic print: `layers` layers of `perLayer` 1 mm moves in a square spiral, a travel between layers. */
function synthetic(layers: number, perLayer: number): string {
  const out = ["G21", "G90", "M83"];
  for (let l = 0; l < layers; l++) {
    out.push(";LAYER_CHANGE", `G1 Z${(0.2 * (l + 1)).toFixed(2)} F600`, "G1 X0 Y0 F9000", ";TYPE:Outer wall");
    let x = 0;
    for (let i = 0; i < perLayer; i++) {
      x += 1;
      out.push(`G1 X${x} Y${i % 2} E0.03 F1800`);
    }
  }
  return out.join("\n");
}

describe("size caps: decimate past the cap, and say so", () => {
  it("joins contiguous moves past the segment cap and reports it", () => {
    const text = synthetic(4, 100);
    const full = parseGcode(text);
    expect(full.extrude.count).toBe(400);
    expect(full.decimation).toBeUndefined();
    const m = parseGcode(text, { maxSegments: 100 });
    expect(m.decimation?.reason).toMatch(/segment cap/);
    expect(m.decimation?.factor).toBeGreaterThanOrEqual(4);
    // 400 extrusions, 4 moves up to each layer and 3 travels back to the start (the first is already there)
    expect(m.decimation?.inputSegments).toBe(407);
    expect(m.extrude.count + m.travel.count).toBeLessThanOrEqual(100);
    // every layer is still there, and the path still ends where it ended
    expect(m.layers.count).toBe(4);
    for (let l = 0; l < 4; l++) expect(m.layers.extrudeEnd[l] - m.layers.extrudeFirst[l]).toBeGreaterThan(0);
    const lastFull = seg(full, "extrude", full.extrude.count - 1).end;
    expect(seg(m, "extrude", m.extrude.count - 1).end).toEqual(lastFull);
  });

  it("starts joining at once for a file over the byte cap", () => {
    const text = synthetic(2, 50);
    const m = parseGcode(text, { maxBytes: 1000 });
    expect(m.decimation?.reason).toMatch(/MB cap/);
    expect(m.decimation!.factor).toBeGreaterThan(1);
    expect(m.extrude.count).toBeLessThan(100);
  });
});

describe("bounded work on hostile files (wave 4 gate)", () => {
  it("skips a line over 64 kB, also when it spans chunks, and parses the next line", () => {
    const p = new GcodeParser();
    p.push("M83\nG1 X0 Y0 Z0.2 F1800\n;" + "x".repeat(40_000));
    p.push("y".repeat(40_000));
    p.push("z".repeat(10) + "\nG1 X10 Y0 E1\n");
    const m = p.finish();
    expect(m.extrude.count).toBe(1);
    expect(m.warnings.some((w) => w.includes("64 kB"))).toBe(true);
  });

  it("stops reading at four times the byte cap and says so", () => {
    const text = synthetic(20, 50);
    const m = parseGcode(text, { maxBytes: Math.floor(text.length / 8) });
    expect(m.decimation?.reason).toMatch(/reading stopped/);
    expect(m.layers.count).toBeLessThan(20);
  });

  it("ignores numbers that are not finite or absurdly large", () => {
    const m = parseGcode("M83\nG1 X0 Y0 Z0.2 F1800\nG1 X1e999 Y5 E1\nG1 X10 Y1e12 E1\n");
    expect(Number.isFinite(m.bounds!.max[0]) && Number.isFinite(m.bounds!.max[1])).toBe(true);
    expect(m.bounds!.max[0]).toBeLessThanOrEqual(10);
    expect(m.bounds!.max[1]).toBeLessThanOrEqual(5);
  });

  it("drops new rows instead of compacting forever when every layer holds one segment", () => {
    const lines = ["M83", "G1 X0 Y0 Z0.2 F1800"];
    for (let l = 0; l < 400; l++) lines.push(`;LAYER:${l}`, `G1 Z${(0.2 * (l + 1)).toFixed(2)}`, `G1 X${l % 2 ? 0 : 5} Y0 E0.1`);
    const t0 = Date.now();
    const m = parseGcode(lines.join("\n") + "\n", { maxSegments: 50 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(m.decimation?.dropped).toBeGreaterThan(0);
    expect(m.extrude.count + m.travel.count).toBeLessThanOrEqual(60);
  });

  it("opens ?gcode= only from the page's own origin, and names it without throwing on a stray %", () => {
    const base = "http://127.0.0.1:5178/?gcode=x";
    expect(gcodeEntry("/@fs/C:/prints/50%25 infill.gcode", base)).toEqual({ url: "http://127.0.0.1:5178/@fs/C:/prints/50%25%20infill.gcode", name: "50% infill.gcode" });
    expect(gcodeEntry("/f/50%.gcode", base)?.name).toBe("50%.gcode");
    expect(gcodeEntry("https://evil.example/a.gcode", base)).toBeUndefined();
    expect(gcodeEntry("//evil.example/a.gcode", base)).toBeUndefined();
    expect(gcodeEntry("javascript:alert(1)", base)).toBeUndefined();
    expect(gcodeEntry("file:///C:/a.gcode", base)).toBeUndefined();
    expect(gcodeEntry("blob:http://127.0.0.1:5178/1234", base)?.url).toBe("blob:http://127.0.0.1:5178/1234");
    expect(gcodeEntry("blob:http://evil.example/1234", base)).toBeUndefined();
    expect(gcodeEntry(null, base)).toBeUndefined();
  });

  it("reads only the first time on a Bambu line that carries two", () => {
    const m = parseGcode("; model printing time: 1h 39m 41s; total estimated time: 1h 46m 1s\nM83\nG1 X0 Y0 Z0.2\nG1 X1 Y0 E0.1\n");
    expect(m.slicerTimeS).toBe(3600 + 39 * 60 + 41);
  });
});

describe("the draw: one instanced draw, a second only for travel", () => {
  const m = parseGcode(fixture("prusa-style.gcode"));

  it("hands the parser's arrays to the GPU as instanced attributes, one draw for all extrusions", () => {
    const d = buildGcodeDraw(m);
    expect(d.group.children).toHaveLength(1);
    expect(d.drawCalls()).toBe(1);
    const g = d.extrusion.geometry;
    expect(g.instanceCount).toBe(m.extrude.count);
    expect((g.getAttribute("iStart").array as Float32Array).buffer).toBe(m.extrude.start.buffer);
    expect(g.getAttribute("iFeature").count).toBe(m.extrude.count);
    expect(d.extrusion.userData.noBatch).toBe(true);
    expect(d.extrusion.frustumCulled).toBe(false);
    d.setTravelVisible(true);
    expect(d.group.children).toHaveLength(2);
    expect(d.drawCalls()).toBe(2);
    expect(d.travel!.geometry.instanceCount).toBe(m.travel.count);
    d.setTravelVisible(false);
    expect(d.drawCalls()).toBe(1);
    d.dispose();
  });

  it("draws only the window of segments the layer range covers: attributes start at its first, count is its length", () => {
    const d = buildGcodeDraw(m);
    const g = d.extrusion.geometry;
    const start = () => g.getAttribute("iStart") as unknown as { offset: number; data: { array: Float32Array } };
    const buffer = start().data;
    d.setLayerRange(0, 1);
    expect(g.instanceCount).toBe(m.layers.extrudeEnd[1]);
    expect(start().offset).toBe(0);
    expect(d.extrusion.material.uniforms.uLayerMin.value).toBe(0);
    expect(d.extrusion.material.uniforms.uLayerMax.value).toBe(1);
    d.setLayerRange(2, 2);
    // the top layer alone: the window starts at its first segment; the same buffer, never a copy
    expect(g.instanceCount).toBe(m.layers.extrudeEnd[2] - m.layers.extrudeFirst[2]);
    expect(start().offset).toBe(m.layers.extrudeFirst[2] * 3);
    expect((g.getAttribute("iLayer") as unknown as { offset: number }).offset).toBe(m.layers.extrudeFirst[2]);
    expect(start().data).toBe(buffer);
    expect(start().data.array.buffer).toBe(m.extrude.start.buffer);
    expect(d.instances().extrusion).toBe(26);
    expect(d.extrusion.material.uniforms.uLayerMin.value).toBe(2);
    d.setLayerRange(1, 1);
    expect(g.instanceCount).toBe(6);
    expect(start().offset).toBe(14 * 3);
    const on = new Array(16).fill(true);
    on[feat("top-surface")] = false;
    d.setFeatureVisible(on);
    expect((d.extrusion.material.uniforms.uOn.value as number[])[feat("top-surface")]).toBe(0);
    d.dispose();
  });

  it("has a template of 8 shared corners and 8 triangles whose faces point outwards", () => {
    const t = segmentTemplate();
    expect(t.position.length / 3).toBe(8);
    expect(t.index.length / 3).toBe(8);
    // the prism's centre: x 0..1, y -0.5..0.5, z -1..0
    const centre = [0.5, 0, -0.5];
    for (let tri = 0; tri < 8; tri++) {
      const [a, b, c] = [t.index[tri * 3], t.index[tri * 3 + 1], t.index[tri * 3 + 2]].map((i) => Array.from(t.position.subarray(i * 3, i * 3 + 3)));
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const out = [0, 1, 2].map((k) => (a[k] + b[k] + c[k]) / 3 - centre[k]);
      expect(n[0] * out[0] + n[1] * out[1] + n[2] * out[2], `triangle ${tri}`).toBeGreaterThan(0);
    }
  });
});

describe("the layer slider runs over the layers that hold a visible segment", () => {
  const m = parseGcode(fixture("prusa-style.gcode"));
  it("drops layers with no shown type, and keeps the chosen layers when toggles change", () => {
    const all = new Array(16).fill(true);
    expect(visibleLayers(m, visibleMask(all, false))).toEqual([0, 1, 2]);
    const onlyTop = all.map((_, i) => i === feat("top-surface"));
    expect(visibleLayers(m, visibleMask(onlyTop, false))).toEqual([2]);
    const onlyWalls = all.map((_, i) => i === feat("outer-wall"));
    let r = rebaseRange(undefined, visibleLayers(m, visibleMask(onlyWalls, false)));
    expect(rangeLayers(r)).toEqual([0, 1]);
    r = setEnd(r, "hi", 0);
    expect(rangeLayers(r)).toEqual([0, 0]);
    // the other end follows when they would cross
    r = setEnd(r, "lo", 1);
    expect(rangeLayers(r)).toEqual([1, 1]);
    // show everything again: layer 1 stays the chosen one
    r = rebaseRange(r, visibleLayers(m, visibleMask(all, false)));
    expect(rangeLayers(r)).toEqual([1, 1]);
  });
});
