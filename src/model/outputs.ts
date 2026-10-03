/**
 * Standard outputs (PB-823): the files a capability provider exports for a
 * custom module, which the viewer reads as ordinary artifacts. It finds them
 * by their fixed file names (protoboard-cli docs/specs/tool-integrations.md
 * §8) and never by the tool that wrote them:
 *
 *   circuit  board.glb, board.manifest.json, bom.csv, pnp.csv, netlist.json,
 *            and the drawings schematic.svg, pcb-top.svg, pcb-bottom.svg
 *   cad      body.glb, body.manifest.json, and print/cut exports (.stl, .3mf, .dxf)
 *
 * PCB drawings are in board millimetres: one SVG user unit is 1 mm, the top
 * view draws board (x, y) at (x, −y), and the bottom view, seen from below,
 * at (−x, −y), with (x, y) as in pnp.csv and the geometry manifest. That is
 * what lets the viewer mark a component on them from its pick-and-place row.
 * A drawing whose viewBox does not hold the placed components is shown
 * without marks.
 */
import type { ArtifactDef, ModuleDef } from "@uhd/types/index.js";
import type { GeometryManifest } from "@uhd/system/geometry.js";
import type { ModuleLookup } from "@uhd/system/index.js";
import { partPackage } from "@uhd/protocols/package.js";

const base = (a: ArtifactDef) => (a.filePath ?? a.url ?? "").split(/[?#]/)[0].split("/").pop() ?? "";

export interface CircuitOutputs {
  glb?: ArtifactDef;
  manifest?: ArtifactDef;
  bom?: ArtifactDef;
  pnp?: ArtifactDef;
  netlist?: ArtifactDef;
  schematic?: ArtifactDef;
  top?: ArtifactDef;
  bottom?: ArtifactDef;
}

export interface CadOutputs {
  glb?: ArtifactDef;
  manifest?: ArtifactDef;
  /** Manufacturing exports: STL, 3MF, DXF. */
  exports: ArtifactDef[];
}

/** A module's circuit standard outputs, by file name; undefined when it has none of them. */
export function circuitOutputs(def: ModuleDef | undefined): CircuitOutputs | undefined {
  const by = (name: string) => def?.artifacts?.find((a) => base(a) === name);
  const out: CircuitOutputs = {
    glb: by("board.glb"),
    manifest: by("board.manifest.json"),
    bom: by("bom.csv"),
    pnp: by("pnp.csv"),
    netlist: by("netlist.json"),
    schematic: by("schematic.svg"),
    top: by("pcb-top.svg"),
    bottom: by("pcb-bottom.svg"),
  };
  return Object.values(out).some(Boolean) ? out : undefined;
}

/** A module's cad standard outputs, by file name; undefined when it has none of them. */
export function cadOutputs(def: ModuleDef | undefined): CadOutputs | undefined {
  const glb = def?.artifacts?.find((a) => base(a) === "body.glb");
  const manifest = def?.artifacts?.find((a) => base(a) === "body.manifest.json");
  const exports = (def?.artifacts ?? []).filter((a) => /\.(stl|3mf|dxf)$/i.test(base(a)));
  return glb || manifest || exports.length ? { glb, manifest, exports } : undefined;
}

/** Standard output drawings are views of the board, not pictures of the part: never its thumbnail. */
export const isBoardDrawing = (a: ArtifactDef) => ["schematic.svg", "pcb-top.svg", "pcb-bottom.svg"].includes(base(a));

/** RFC 4180 CSV with a header row, as rows of named fields. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [head, ...body] = rows.filter((r) => r.some((x) => x !== ""));
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

export interface PnpRow {
  instance: string;
  x: number;
  y: number;
  rotation: number;
  side: "top" | "bottom";
}

/** Pick-and-place rows (`instance`, `x_mm`, `y_mm`, `rotation_deg`, `side`); rows that do not parse are left out. */
export function parsePnp(text: string): PnpRow[] {
  return parseCsv(text)
    .map((r) => ({ instance: r.instance, x: Number(r.x_mm), y: Number(r.y_mm), rotation: Number(r.rotation_deg || 0), side: r.side === "bottom" ? ("bottom" as const) : ("top" as const) }))
    .filter((r) => r.instance && Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.rotation));
}

/** Where a component sits on the board: a rectangle in board millimetres. */
export interface Footprint {
  instance: string;
  side: "top" | "bottom";
  /** Centre (board mm). */
  x: number;
  y: number;
  /** Size along board x and y, after rotation. */
  w: number;
  h: number;
  /** Where the size came from: the part's package facts, or the manifest feature's area. */
  size: "package" | "manifest" | "unknown";
}

/**
 * Every placed component's rectangle: its pick-and-place position, sized by
 * the part's package (length × width, turned by the row's rotation), else by
 * the manifest feature named by its instance path (a square of its area),
 * else a 1 mm square.
 */
export function footprints(board: ModuleDef, lookup: ModuleLookup, pnp: PnpRow[], manifest?: GeometryManifest): Footprint[] {
  return pnp.map((row) => {
    const ref = board.children?.find((c) => c.id === row.instance);
    const def = ref ? lookup(ref.moduleDefId) : undefined;
    const size = def ? partPackage(def)?.size_mm : undefined;
    const turned = Math.round(row.rotation / 90) % 2 !== 0;
    if (size?.length && size.width) {
      const [w, h] = turned ? [size.width, size.length] : [size.length, size.width];
      return { instance: row.instance, side: row.side, x: row.x, y: row.y, w, h, size: "package" as const };
    }
    const area = manifest?.features[row.instance]?.area_mm2;
    const s = area ? Math.sqrt(area) : 1;
    return { instance: row.instance, side: row.side, x: row.x, y: row.y, w: s, h: s, size: area ? ("manifest" as const) : ("unknown" as const) };
  });
}

/** Board millimetres → drawing units for one side (the convention above). */
export const toDrawing = (side: "top" | "bottom", x: number, y: number): [number, number] => [side === "top" ? x : -x, -y];

/** Whether a drawing's viewBox holds every component placed on its side (else its marks would be wrong). */
export function drawingFits(viewBox: [number, number, number, number], side: "top" | "bottom", fps: Footprint[]): boolean {
  const [vx, vy, vw, vh] = viewBox;
  const mine = fps.filter((f) => f.side === side);
  return mine.length > 0 && mine.every((f) => {
    const [x, y] = toDrawing(side, f.x, f.y);
    return x >= vx && x <= vx + vw && y >= vy && y <= vy + vh;
  });
}

/** The component under a point of a drawing, smallest first (a resistor under a chip's corner wins). */
export function footprintAt(side: "top" | "bottom", fps: Footprint[], dx: number, dy: number, slack = 0.4): Footprint | undefined {
  const x = side === "top" ? dx : -dx;
  const y = -dy;
  return fps
    .filter((f) => f.side === side && Math.abs(x - f.x) <= f.w / 2 + slack && Math.abs(y - f.y) <= f.h / 2 + slack)
    .sort((a, b) => a.w * a.h - b.w * b.h)[0];
}
