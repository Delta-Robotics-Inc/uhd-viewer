/**
 * SAMPLE, HAND-MADE cad standard outputs for the sample enclosure (names per
 * protoboard-cli docs/specs/tool-integrations.md §8): body.glb with two named
 * bodies (`back`, `lid`) and the features that carry the enclosure's
 * interfaces, body.manifest.json, and the print exports back.stl and lid.stl.
 * Boxes and cylinders only; a stand-in until a cad provider writes them.
 */
import type { GeometryManifest } from "@uhd/system/geometry.js";
import { CABLE_ENTRY, ENCLOSURE, HOLES, SWD_WINDOW, BOARD_IN_ENCLOSURE } from "./placement";
import { box, cylinder, merge, writeGlb, writeStl, type Rgba, type Solid } from "./glb";

const PLA: Rgba = [0.86, 0.85, 0.82, 1];
const FEATURE: Rgba = [1, 0.36, 0, 1];
const r2 = (n: number) => Math.round(n * 1000) / 1000;

/** Enclosure-frame positions of the bosses: under the board's mounting holes. */
export const BOSSES: [number, number][] = HOLES.map(([x, y]) => [x + BOARD_IN_ENCLOSURE[0], y + BOARD_IN_ENCLOSURE[1]]);

export interface EnclosureOutputs {
  files: Record<string, string | Uint8Array>;
  manifest: GeometryManifest;
}

const volume = (solids: Solid[]) => {
  // boxes and cylinders only: sum of the closed solids' signed volumes
  let v = 0;
  for (const s of solids) {
    for (let i = 0; i < s.indices.length; i += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => s.indices[i + k] * 3).map((j) => [s.positions[j], s.positions[j + 1], s.positions[j + 2]]);
      v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    }
  }
  return Math.round(Math.abs(v));
};

export function enclosureOutputs(): EnclosureOutputs {
  const { length: L, width: W, backHeight: H, wall: t, floor: f, lid: lt, bossHeight, bossRadius } = ENCLOSURE;
  const e = CABLE_ENTRY;
  const half = e.size / 2;

  // back shell: floor, three plain walls, the left wall around the cable entry, two bosses
  const back: Solid[] = [
    box([0, 0, 0], [L, W, f]),
    box([L - t, 0, f], [L, W, H]),
    box([t, 0, f], [L - t, t, H]),
    box([t, W - t, f], [L - t, W, H]),
    box([0, 0, f], [t, W, e.z - half]),
    box([0, 0, e.z + half], [t, W, H]),
    box([0, 0, e.z - half], [t, e.y - half, e.z + half]),
    box([0, e.y + half, e.z - half], [t, W, e.z + half]),
    ...BOSSES.map(([x, y]) => cylinder([x, y, f], bossRadius, bossHeight)),
  ];
  // lid: a plate around the SWD window, with a locating lip inside the walls
  const s = SWD_WINDOW;
  const [wx0, wx1, wy0, wy1] = [s.x - s.w / 2, s.x + s.w / 2, s.y - s.h / 2, s.y + s.h / 2];
  const lip = 0.8;
  const lid: Solid[] = [
    box([0, 0, H], [wx0, W, H + lt]),
    box([wx1, 0, H], [L, W, H + lt]),
    box([wx0, 0, H], [wx1, wy0, H + lt]),
    box([wx0, wy1, H], [wx1, W, H + lt]),
    box([t + 0.2, t + 0.2, H - 1], [t + 0.2 + lip, W - t - 0.2, H]),
    box([L - t - 0.2 - lip, t + 0.2, H - 1], [L - t - 0.2, W - t - 0.2, H]),
    box([t + 0.2 + lip, t + 0.2, H - 1], [L - t - 0.2 - lip, t + 0.2 + lip, H]),
    box([t + 0.2 + lip, W - t - 0.2 - lip, H - 1], [L - t - 0.2 - lip, W - t - 0.2, H]),
  ];

  // features that carry the enclosure's interfaces: thin pads on the faces, shown when selected
  const top = f + bossHeight;
  const features = {
    board_mount: merge(...BOSSES.map(([x, y]) => cylinder([x, y, top - 0.05], bossRadius, 0.1))),
    cable_entry: box([-0.05, e.y - half, e.z - half], [0.05, e.y + half, e.z + half]),
    swd_window: box([wx0, wy0, H + lt - 0.05], [wx1, wy1, H + lt + 0.05]),
  };

  const glb = writeGlb("enclosure", [
    { name: "back", solid: merge(...back), color: PLA, roughness: 0.75 },
    { name: "lid", solid: merge(...lid), color: PLA, roughness: 0.75 },
    ...Object.entries(features).map(([name, solid]) => ({ name, solid, color: FEATURE })),
  ]);

  const manifest: GeometryManifest = {
    artifact: "enclosure_glb",
    units: "mm",
    volume_mm3: volume([...back, ...lid]),
    bodies: { back: volume(back), lid: volume(lid) },
    features: {
      board_mount: { area_mm2: r2(BOSSES.length * Math.PI * bossRadius ** 2), centroid: [(BOSSES[0][0] + BOSSES[1][0]) / 2, BOSSES[0][1], top], normal: [0, 0, 1], faces: 2 },
      cable_entry: { area_mm2: e.size * e.size, centroid: [0, e.y, e.z], normal: [-1, 0, 0], faces: 1 },
      swd_window: { area_mm2: r2(s.w * s.h), centroid: [r2(s.x), r2(s.y), H + lt], normal: [0, 0, 1], faces: 1 },
    },
  };

  return {
    files: {
      "body.glb": glb,
      "body.manifest.json": JSON.stringify(manifest, null, 2) + "\n",
      "back.stl": writeStl("back", back),
      "lid.stl": writeStl("lid", lid),
    },
    manifest,
  };
}
