/**
 * SAMPLE, HAND-MADE circuit standard outputs for the UHD fixture board
 * (names per protoboard-cli docs/specs/tool-integrations.md §8, plus the
 * schematic and PCB drawings): board.glb, board.manifest.json, bom.csv,
 * pnp.csv, netlist.json, schematic.svg, pcb-top.svg, pcb-bottom.svg.
 *
 * Everything is computed from the UHD board and the hand-chosen placement in
 * placement.ts. Nothing was routed: the PCB drawings show bodies, pads at the
 * board edge and a ratsnest (straight lines joining each net's components),
 * and say so on the drawing.
 */
import type { ModuleDef } from "@uhd/types/index.js";
import type { GeometryManifest } from "@uhd/system/geometry.js";
import { partPackage } from "@uhd/protocols/package.js";
import { isNet } from "@uhd/protocols/net.js";
import { BOARD, EDGE_PADS, HOLES, HOLE_RADIUS, PLACEMENT, type Placed } from "./placement";
import { box, cylinder, merge, writeGlb, type GlbNode, type Rgba } from "./glb";

type Lookup = (id: string) => ModuleDef | undefined;

const r2 = (n: number) => Math.round(n * 1000) / 1000;

/** Body size of a placed component: its package facts, else the sample's assumed body. */
export function bodyOf(p: Placed, board: ModuleDef, lookup: Lookup): { length: number; width: number; height: number } {
  const ref = board.children?.find((c) => c.id === p.instance);
  const def = ref ? lookup(ref.moduleDefId) : undefined;
  const size = def ? partPackage(def)?.size_mm : undefined;
  if (size?.length && size.width && size.height) return { length: size.length, width: size.width, height: size.height };
  if (p.body) return p.body;
  throw new Error(`${p.instance}: no package size and no sample body`);
}

/** Footprint of a body at its placement: [x0, y0, x1, y1] (board mm). */
function extent(p: Placed, size: { length: number; width: number }): [number, number, number, number] {
  const turned = Math.round(p.rotation / 90) % 2 !== 0;
  const [l, w] = turned ? [size.width, size.length] : [size.length, size.width];
  return [p.x - l / 2, p.y - w / 2, p.x + l / 2, p.y + w / 2];
}

/** Pins of each net: `<instance>:<interface>`, from the board's membership links. */
export function netPins(board: ModuleDef): Map<string, string[]> {
  const nets = new Map(board.interfaces.filter(isNet).map((n) => [n.id, [] as string[]]));
  for (const link of board.links ?? []) {
    const [pin, net] = "self" in link.b ? [link.a, link.b] : [link.b, link.a];
    if (!("child" in pin) || !nets.has(net.interfaceId)) continue;
    nets.get(net.interfaceId)!.push(`${pin.child}:${pin.interfaceId}`);
  }
  return nets;
}

const FR4: Rgba = [0.07, 0.26, 0.15, 1];
const IC: Rgba = [0.06, 0.06, 0.07, 1];
const PASSIVE: Rgba = [0.55, 0.47, 0.36, 1];
const COPPER: Rgba = [0.83, 0.65, 0.3, 1];

export interface BoardOutputs {
  files: Record<string, string | Uint8Array>;
  manifest: GeometryManifest;
}

export function boardOutputs(board: ModuleDef, lookup: Lookup): BoardOutputs {
  const T = BOARD.thickness;
  const placed = PLACEMENT.map((p) => ({ p, size: bodyOf(p, board, lookup) }));

  // ---- board.glb: substrate, components (named by instance path), edge pads, hole rims
  const nodes: GlbNode[] = [{ name: "substrate", solid: box([0, 0, 0], [BOARD.length, BOARD.width, T]), color: FR4, roughness: 0.7 }];
  for (const { p, size } of placed) {
    const [x0, y0, x1, y1] = extent(p, size);
    const [z0, z1] = p.side === "top" ? [T, T + size.height] : [-size.height, 0];
    const passive = /^[rl]\d/.test(p.instance);
    nodes.push({ name: p.instance, solid: box([x0, y0, z0], [x1, y1, z1]), color: passive ? PASSIVE : IC, roughness: passive ? 0.5 : 0.35 });
  }
  for (const pad of EDGE_PADS) {
    const n = pad.count ?? 1;
    const solids = Array.from({ length: n }, (_, i) => {
      const cx = pad.x + (i - (n - 1) / 2) * (pad.pitch ?? 0);
      return box([cx - pad.w / 2, pad.y - pad.h / 2, T], [cx + pad.w / 2, pad.y + pad.h / 2, T + 0.04]);
    });
    nodes.push({ name: `pad_${pad.id}`, solid: merge(...solids), color: COPPER, metallic: 0.9, roughness: 0.3 });
  }
  nodes.push({
    name: "hole_rims",
    solid: merge(...HOLES.map(([x, y]) => cylinder([x, y, -0.02], HOLE_RADIUS + 0.6, T + 0.04))),
    color: COPPER,
    metallic: 0.9,
    roughness: 0.3,
  });
  nodes.push({ name: "holes", solid: merge(...HOLES.map(([x, y]) => cylinder([x, y, -0.05], HOLE_RADIUS, T + 0.1))), color: [0.02, 0.02, 0.02, 1] });
  const glb = writeGlb("board", nodes);

  // ---- board.manifest.json: outline, every component by instance path, the mount and the edge
  const features: GeometryManifest["features"] = {
    outline: { area_mm2: BOARD.length * BOARD.width, centroid: [BOARD.length / 2, BOARD.width / 2, T], normal: [0, 0, 1], faces: 1 },
  };
  for (const { p, size } of placed) {
    const [x0, y0, x1, y1] = extent(p, size);
    features[p.instance] = {
      area_mm2: r2((x1 - x0) * (y1 - y0)),
      centroid: [p.x, p.y, r2(p.side === "top" ? T + size.height : -size.height)],
      normal: p.side === "top" ? [0, 0, 1] : [0, 0, -1],
      faces: 1,
    };
  }
  const rim = Math.PI * ((HOLE_RADIUS + 0.6) ** 2 - HOLE_RADIUS ** 2);
  features.mount = {
    area_mm2: r2(HOLES.length * rim),
    centroid: [(HOLES[0][0] + HOLES[1][0]) / 2, (HOLES[0][1] + HOLES[1][1]) / 2, 0],
    normal: [0, 0, -1],
    faces: HOLES.length,
  };
  for (const pad of EDGE_PADS) {
    features[pad.id] = { area_mm2: r2(pad.w * pad.h * (pad.count ?? 1)), centroid: [pad.x, pad.y, T], normal: [0, 0, 1], faces: pad.count ?? 1 };
  }
  const manifest: GeometryManifest = { artifact: "board_glb", units: "mm", features };

  // ---- bom.csv and pnp.csv, keyed by instance path
  const refOf = (id: string) => board.children!.find((c) => c.id === id)!;
  const csv = (rows: (string | number)[][]) =>
    rows.map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(",")).join("\n") + "\n";
  const bom = csv([
    ["instance", "name", "definition", "manufacturer", "part_number", "package", "quantity"],
    ...PLACEMENT.map((p) => {
      const ref = refOf(p.instance);
      const def = lookup(ref.moduleDefId)!;
      return [p.instance, ref.name ?? def.name, def.id, def.manufacturer ?? "", def.part_number ?? "", partPackage(def)?.name ?? "", 1];
    }),
  ]);
  const pnp = csv([["instance", "x_mm", "y_mm", "rotation_deg", "side"], ...PLACEMENT.map((p) => [p.instance, p.x, p.y, p.rotation, p.side])]);

  // ---- netlist.json (protoboard.netlist/v0): pins as <instance>:<interface>
  const pins = netPins(board);
  const netlist = { schema: "protoboard.netlist/v0", nets: [...pins].map(([id, list]) => ({ id, pins: list })) };

  return {
    files: {
      "board.glb": glb,
      "board.manifest.json": JSON.stringify(manifest, null, 2) + "\n",
      "bom.csv": bom,
      "pnp.csv": pnp,
      "netlist.json": JSON.stringify(netlist, null, 2) + "\n",
      "pcb-top.svg": pcbSvg(board, placed, "top"),
      "pcb-bottom.svg": pcbSvg(board, placed, "bottom"),
      "schematic.svg": schematicSvg(board, lookup),
    },
    manifest,
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * A PCB drawing in board millimetres: one SVG user unit is 1 mm, the top
 * view draws board (x, y) at (x, −y) and the bottom view, seen from below,
 * at (−x, −y). This is the convention the viewer's highlights rely on.
 */
function pcbSvg(board: ModuleDef, placed: { p: Placed; size: { length: number; width: number; height: number } }[], side: "top" | "bottom"): string {
  const sx = side === "top" ? 1 : -1;
  const X = (x: number) => r2(sx * x);
  const Y = (y: number) => r2(-y);
  const m = 1.5;
  const vb = side === "top" ? [-m, -BOARD.width - m, BOARD.length + 2 * m, BOARD.width + 2 * m] : [-BOARD.length - m, -BOARD.width - m, BOARD.length + 2 * m, BOARD.width + 2 * m];
  const rect = (x0: number, y0: number, x1: number, y1: number) => {
    const [a, b] = [X(x0), X(x1)].sort((p, q) => p - q);
    return `x="${a}" y="${Y(y1)}" width="${r2(b - a)}" height="${r2(y1 - y0)}"`;
  };
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(" ")}" width="${vb[2] * 10}" height="${vb[3] * 10}" font-family="monospace">`);
  out.push(`<title>${esc(board.name)}: PCB ${side} (SAMPLE, hand-made placement, not routed)</title>`);
  out.push(`<rect ${rect(0, 0, BOARD.length, BOARD.width)} rx="0.6" fill="#0f3a22" stroke="#d4b25a" stroke-width="0.15"/>`);
  for (const [x, y] of HOLES) out.push(`<circle cx="${X(x)}" cy="${Y(y)}" r="${HOLE_RADIUS + 0.6}" fill="#c9a24a"/><circle cx="${X(x)}" cy="${Y(y)}" r="${HOLE_RADIUS}" fill="#111"/>`);
  if (side === "top") {
    for (const pad of EDGE_PADS) {
      const n = pad.count ?? 1;
      for (let i = 0; i < n; i++) {
        const cx = pad.x + (i - (n - 1) / 2) * (pad.pitch ?? 0);
        out.push(`<rect ${rect(cx - pad.w / 2, pad.y - pad.h / 2, cx + pad.w / 2, pad.y + pad.h / 2)} fill="#d4b25a"/>`);
      }
      const label = pad.id === "power_in" ? "VIN" : pad.id === "power_gnd" ? "GND" : pad.id.toUpperCase();
      const lx = pad.count ? pad.x : pad.x + pad.w / 2 + 0.5;
      const ly = pad.count ? pad.y + pad.h / 2 + 0.9 : pad.y - 0.35;
      out.push(`<text x="${X(lx)}" y="${Y(ly)}" font-size="0.9" fill="#e7e5e4" text-anchor="${pad.count ? "middle" : "start"}">${label}</text>`);
    }
  }
  // ratsnest: each net's components joined in order of x, centre to centre (what a layout must connect, not copper)
  const onSide = placed.filter(({ p }) => p.side === side);
  const centre = new Map(placed.map(({ p }) => [p.instance, p]));
  for (const [, list] of netPins(board)) {
    const comps = [...new Set(list.map((pin) => pin.split(":")[0]))].map((c) => centre.get(c)!).filter(Boolean).sort((a, b) => a.x - b.x);
    for (let i = 1; i < comps.length; i++) {
      const [a, b] = [comps[i - 1], comps[i]];
      if (a.side !== side && b.side !== side) continue;
      out.push(`<line x1="${X(a.x)}" y1="${Y(a.y)}" x2="${X(b.x)}" y2="${Y(b.y)}" stroke="#9ca3af" stroke-width="0.08" stroke-dasharray="0.4 0.3" opacity="0.7"/>`);
    }
  }
  for (const { p, size } of onSide) {
    const [x0, y0, x1, y1] = extent(p, size);
    out.push(`<rect ${rect(x0, y0, x1, y1)} fill="#18181b" stroke="#e7e5e4" stroke-width="0.1"/>`);
    const fs = Math.min(1.1, Math.max(0.55, (x1 - x0) * 0.32));
    out.push(`<text x="${X(p.x)}" y="${Y(y1 + 0.25)}" font-size="${r2(fs)}" fill="#e7e5e4" text-anchor="middle">${p.instance.toUpperCase()}</text>`);
  }
  out.push(`<text x="${X(BOARD.length / 2)}" y="${Y(-0.45)}" font-size="0.8" fill="#ff5c00" text-anchor="middle">SAMPLE · ${side.toUpperCase()} · hand-made placement, ratsnest only</text>`);
  out.push(`</svg>`);
  return out.join("\n") + "\n";
}

/**
 * A schematic drawn with net labels: one block per component, a stub per
 * pin on a net with the net's name at its end. The SVG is in its own units;
 * nothing relies on its coordinates.
 */
function schematicSvg(board: ModuleDef, lookup: Lookup): string {
  const nets = board.interfaces.filter(isNet);
  const netOf = new Map<string, string>();
  for (const [id, list] of netPins(board)) for (const pin of list) netOf.set(pin, nets.find((n) => n.id === id)?.name ?? id);
  const blocks = (board.children ?? []).map((ref) => {
    const def = lookup(ref.moduleDefId)!;
    const pins = def.interfaces.filter((i) => netOf.has(`${ref.id}:${i.id}`));
    return { ref, def, pins };
  });
  const colW = 300;
  const out: string[] = [];
  let x = 20;
  let y = 60;
  let rowH = 0;
  const body: string[] = [];
  for (const b of blocks) {
    const half = Math.ceil(b.pins.length / 2);
    const h = Math.max(60, 30 + half * 18);
    if (x + colW > 20 + colW * 3) {
      x = 20;
      y += rowH + 40;
      rowH = 0;
    }
    rowH = Math.max(rowH, h);
    const bx = x + 90;
    const bw = 120;
    body.push(`<rect x="${bx}" y="${y}" width="${bw}" height="${h}" fill="#1f1f1f" stroke="#e7e5e4" stroke-width="1.5"/>`);
    body.push(`<text x="${bx + bw / 2}" y="${y - 6}" font-size="12" fill="#ff5c00" text-anchor="middle">${b.ref.id.toUpperCase()} · ${esc(b.ref.name ?? b.def.name)}</text>`);
    b.pins.forEach((pin, i) => {
      const left = i < half;
      const py = y + 24 + (left ? i : i - half) * 18;
      const sx = left ? bx : bx + bw;
      const ex = left ? bx - 30 : bx + bw + 30;
      const net = netOf.get(`${b.ref.id}:${pin.id}`)!;
      body.push(`<line x1="${sx}" y1="${py}" x2="${ex}" y2="${py}" stroke="#a8a29e" stroke-width="1.2"/>`);
      body.push(`<text x="${left ? sx + 4 : sx - 4}" y="${py + 4}" font-size="9" fill="#d6d3d1" text-anchor="${left ? "start" : "end"}">${esc(`${pin.pin ?? ""} ${pin.name ?? pin.id}`.trim())}</text>`);
      body.push(`<text x="${left ? ex - 4 : ex + 4}" y="${py + 4}" font-size="10" fill="#f5a524" text-anchor="${left ? "end" : "start"}">${esc(net)}</text>`);
    });
    x += colW;
  }
  const height = y + rowH + 50;
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${20 + colW * 3} ${height}" width="${20 + colW * 3}" height="${height}" font-family="monospace">`);
  out.push(`<title>${esc(board.name)}: schematic (SAMPLE, drawn from the UHD nets with net labels)</title>`);
  out.push(`<rect width="100%" height="100%" fill="#161616"/>`);
  out.push(`<text x="20" y="28" font-size="14" fill="#e7e5e4">${esc(board.name.toUpperCase())}</text>`);
  out.push(`<text x="20" y="44" font-size="10" fill="#ff5c00">SAMPLE · drawn from the UHD nets (net labels, no wires) · not a provider's schematic</text>`);
  out.push(...body);
  out.push(`</svg>`);
  return out.join("\n") + "\n";
}
