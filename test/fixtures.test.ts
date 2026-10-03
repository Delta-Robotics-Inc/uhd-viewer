import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkSystem } from "@uhd/system/checks.js";
import { bundleSystem } from "@uhd/system/bundle.js";
import { applyMat4 } from "@uhd/system/geometry.js";
import type { GeometryManifest } from "@uhd/system/geometry.js";
import { buildFixtures } from "../fixtures/src/imu-pod";
import { sourceFromBundle } from "../src/source/source";
import { cadOutputs, circuitOutputs, drawingFits, footprintAt, footprints, parseCsv, parsePnp } from "../src/model/outputs";
import { buildCadModel } from "../src/cad/model";
import { anchorOf, findingAnchors } from "../src/cad/findings";
import { systemDiagnostics } from "../src/model/diagnostics";

const dir = new URL("../fixtures/imu-pod/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, dir));
const text = (path: string) => read(path).toString("utf8");
const fx = buildFixtures();
const lookup = (id: string) => fx.definitions.find((d) => d.id === id);
const boardManifest = JSON.parse(text("board/out/board.manifest.json")) as GeometryManifest;
const enclosureManifest = JSON.parse(text("enclosure/out/body.manifest.json")) as GeometryManifest;
const viewBox = (svg: string) => svg.match(/viewBox="([^"]+)"/)![1].split(" ").map(Number) as [number, number, number, number];

describe("sample fixtures", () => {
  it("are what fixtures/src generates (run node scripts/build-fixtures.mjs after changing it)", () => {
    for (const [path, content] of Object.entries(fx.files)) {
      expect(Buffer.compare(read(path), Buffer.from(content)), path).toBe(0);
    }
  });

  it("load as bundles, check clean, and break as the scenario says", () => {
    const source = sourceFromBundle(fx.bundles.pod, "http://x/uhd-bundle.json");
    expect(source.scenarios.map((s) => s.id)).toEqual(["nominal", "imu-sdx-int1-swapped"]);
    const nominal = systemDiagnostics(source.scenarios[0].system, source.scenarios[0].lookup);
    expect(nominal.filter((d) => d.severity === "error")).toEqual([]);
    const broken = systemDiagnostics(source.scenarios[1].system, source.scenarios[1].lookup);
    expect(broken.some((d) => d.scope === "board" && /not wired to each other/.test(d.message))).toBe(true);
    const board = bundleSystem(fx.bundles.board, "imu-sdx-int1-swapped");
    const i2c = checkSystem(board.root, board.lookup).links.find((r) => r.protocol === "i2c")!;
    expect(i2c.diagnostics.map((d) => d.code)).toContain("bus_incomplete");
  });

  it("key the circuit outputs by the board's instance paths", () => {
    const children = new Set(fx.board.children!.map((c) => c.id));
    const bom = parseCsv(text("board/out/bom.csv"));
    expect(new Set(bom.map((r) => r.instance))).toEqual(children);
    const pnp = parsePnp(text("board/out/pnp.csv"));
    expect(new Set(pnp.map((r) => r.instance))).toEqual(children);
    const netlist = JSON.parse(text("board/out/netlist.json"));
    expect(netlist.schema).toBe("protoboard.netlist/v0");
    for (const net of netlist.nets) {
      expect(fx.board.interfaces.some((i) => i.id === net.id)).toBe(true);
      for (const pin of net.pins) {
        const [child, iface] = pin.split(":");
        const def = lookup(fx.board.children!.find((c) => c.id === child)!.moduleDefId)!;
        expect(def.interfaces.some((i) => i.id === iface), pin).toBe(true);
      }
    }
    expect(Object.keys(boardManifest.features)).toEqual(expect.arrayContaining(["outline", "mount", "power_in", "swd", ...children]));
  });

  it("write valid GLB and STL files", () => {
    for (const path of ["board/out/board.glb", "enclosure/out/body.glb"]) {
      const b = read(path);
      expect(b.readUInt32LE(0)).toBe(0x46546c67);
      expect(b.readUInt32LE(4)).toBe(2);
      expect(b.readUInt32LE(8)).toBe(b.length);
      const json = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString("utf8"));
      expect(json.asset.version).toBe("2.0");
      if (path.startsWith("board")) expect(json.nodes.map((n: { name: string }) => n.name)).toEqual(expect.arrayContaining(["substrate", "u1", "r4"]));
      else expect(json.nodes.map((n: { name: string }) => n.name)).toEqual(expect.arrayContaining(["back", "lid", "board_mount", "swd_window"]));
    }
    for (const path of ["enclosure/out/back.stl", "enclosure/out/lid.stl"]) {
      const b = read(path);
      expect(b.length).toBe(84 + 50 * b.readUInt32LE(80));
    }
    expect(Object.keys(enclosureManifest.bodies!)).toEqual(["back", "lid"]);
  });
});

describe("standard outputs in the viewer", () => {
  it("are found by their file names", () => {
    const c = circuitOutputs(fx.board)!;
    expect([c.glb, c.manifest, c.bom, c.pnp, c.netlist, c.schematic, c.top, c.bottom].map((a) => a?.id)).toEqual([
      "board_glb", "board_manifest", "bom", "pnp", "netlist", "schematic", "pcb_top", "pcb_bottom",
    ]);
    expect(cadOutputs(fx.enclosure)!.exports.map((a) => a.id)).toEqual(["back_stl", "lid_stl"]);
    expect(circuitOutputs(fx.enclosure)).toBeUndefined();
  });

  it("size each component from its package, else the manifest", () => {
    const fps = footprints(fx.board, lookup, parsePnp(text("board/out/pnp.csv")), boardManifest);
    const u2 = fps.find((f) => f.instance === "u2")!;
    // BMI270: 3.0 × 2.5 mm, turned 90°
    expect([u2.w, u2.h, u2.size]).toEqual([2.5, 3, "package"]);
    const r1 = fps.find((f) => f.instance === "r1")!;
    expect([r1.side, r1.size]).toEqual(["bottom", "manifest"]);
    expect(r1.w).toBeCloseTo(Math.sqrt(0.5));
  });

  it("mark components on PCB drawings in board millimetres, top and bottom", () => {
    const fps = footprints(fx.board, lookup, parsePnp(text("board/out/pnp.csv")), boardManifest);
    expect(drawingFits(viewBox(text("board/out/pcb-top.svg")), "top", fps)).toBe(true);
    expect(drawingFits(viewBox(text("board/out/pcb-bottom.svg")), "bottom", fps)).toBe(true);
    // a drawing in other units holds none of them
    expect(drawingFits([0, 0, 800, 600], "top", fps)).toBe(false);
    expect(footprintAt("top", fps, 9.5, -9)?.instance).toBe("u1");
    expect(footprintAt("top", fps, 14.5, -14)?.instance).toBe("r3");
    // seen from below, x is mirrored
    expect(footprintAt("bottom", fps, -16.5, -8.8)?.instance).toBe("r1");
    expect(footprintAt("top", fps, -16.5, -8.8)).toBeUndefined();
  });
});

describe("boards and enclosures in 3D", () => {
  const manifests = new Map([
    [`${fx.board.id}:board_glb`, boardManifest],
    [`${fx.enclosure.id}:enclosure_glb`, enclosureManifest],
  ]);

  it("places the board's own body by its mounting holes, and its components inside it", () => {
    const model = buildCadModel(fx.pod, lookup, manifests);
    const board = model.bodies.find((b) => b.key === "board")!;
    expect(board.glb?.id).toBe("board_glb");
    expect(applyMat4(board.matrix, [0, 0, 0])).toEqual([3, 3, 4.6]);
    expect(model.within.get("board/u1")).toBe("board");
    expect(model.bodies.find((b) => b.key === "enclosure")?.via).toBeUndefined();
  });

  it("places a board that is the bundle's root at the origin", () => {
    const model = buildCadModel(fx.board, lookup, manifests);
    expect(model.bodies.map((b) => [b.key, b.glb?.id])).toEqual([["", "board_glb"]]);
  });

  it("pins findings to interfaces, components and bodies", () => {
    const model = buildCadModel(fx.pod, lookup, manifests);
    expect(anchorOf(model, "enclosure:swd_window")).toMatchObject({ body: "enclosure", local: [13.3, 4.4, 11.6], select: { body: "enclosure", iface: "swd_window" } });
    expect(anchorOf(model, "board/l1")).toMatchObject({ body: "board", local: boardManifest.features.l1.centroid, select: { component: "l1" } });
    expect(anchorOf(model, "board:power_in")?.local).toEqual(boardManifest.features.power_in.centroid);
    expect(anchorOf(model, "nowhere")).toBeUndefined();
    const all = findingAnchors(model, [], fx.bundles.pod.diagnostics!);
    expect(all.map((f) => f.body)).toEqual(["enclosure", "board", "board"]);
  });
});
