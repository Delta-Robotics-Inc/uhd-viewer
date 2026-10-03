/**
 * SAMPLE, HAND-MADE: where the components of the UHD fixture board sit on a
 * 28 × 18 mm board, and where the enclosure puts the board. A stand-in for
 * what a circuit provider's layout and a cad provider's enclosure would
 * report, so the viewer's board and enclosure views can be built and tested
 * before the real providers exist (PB-823). Not a layout: nothing here was
 * routed, checked for assembly or derived from footprints.
 *
 * Board coordinates: mm, origin at the board's bottom-left corner on its
 * bottom face, x right, y up, z out of the top face (as in pnp.csv and the
 * geometry manifest).
 */

export const BOARD = { length: 28, width: 18, thickness: 1.6 } as const;

/** Mounting holes (M2 clearance), on the board's long axis. */
export const HOLES: [number, number][] = [
  [2.5, 9],
  [25.5, 9],
];
export const HOLE_RADIUS = 1.1;

export interface Placed {
  instance: string;
  x: number;
  y: number;
  rotation: number;
  side: "top" | "bottom";
  /** Body size used for the sample GLB when the part states no package size (an assumption, listed in the README). */
  body?: { length: number; width: number; height: number };
}

/** One row per component of the fixture board, the pick-and-place data. */
export const PLACEMENT: Placed[] = [
  { instance: "u1", x: 9.5, y: 9, rotation: 0, side: "top" },
  { instance: "u2", x: 19, y: 13, rotation: 90, side: "top" },
  { instance: "u3", x: 19.5, y: 5, rotation: 0, side: "top" },
  // the fixture's inductor states no package: a 2.5 × 2.0 × 1.2 mm body is assumed for the sample
  { instance: "l1", x: 24, y: 5, rotation: 90, side: "top", body: { length: 2.5, width: 2, height: 1.2 } },
  // the fixture's 0402 resistors state the package name only: 1.0 × 0.5 × 0.35 mm is the common 0402 body, assumed
  { instance: "r1", x: 16.5, y: 8.8, rotation: 0, side: "bottom", body: { length: 1, width: 0.5, height: 0.35 } },
  { instance: "r2", x: 18, y: 8.8, rotation: 0, side: "bottom", body: { length: 1, width: 0.5, height: 0.35 } },
  { instance: "r3", x: 14.5, y: 14, rotation: 90, side: "top", body: { length: 1, width: 0.5, height: 0.35 } },
  { instance: "r4", x: 15.5, y: 14, rotation: 90, side: "top", body: { length: 1, width: 0.5, height: 0.35 } },
];

/** Edge pads by the board export they carry (the board edge, docs/boards-and-nets.md in UHD). */
export const EDGE_PADS: { id: string; x: number; y: number; w: number; h: number; count?: number; pitch?: number }[] = [
  { id: "power_in", x: 1.6, y: 15.5, w: 1.6, h: 1.2 },
  { id: "power_gnd", x: 1.6, y: 13.5, w: 1.6, h: 1.2 },
  { id: "swd", x: 9.5, y: 1.4, w: 1, h: 1.6, count: 3, pitch: 1.27 },
];

/**
 * The enclosure (enclosure coordinates: mm, origin at the back shell's outer
 * bottom-left corner, z up). The board sits on two bosses; mating the board's
 * `mount` frame to the enclosure's `board_mount` frame puts the board's
 * origin at BOARD_IN_ENCLOSURE.
 */
export const ENCLOSURE = { length: 34, width: 24, backHeight: 10, wall: 1.6, floor: 1.6, lid: 1.6, bossHeight: 3, bossRadius: 2 } as const;
export const BOARD_IN_ENCLOSURE: [number, number, number] = [3, 3, ENCLOSURE.floor + ENCLOSURE.bossHeight];

/**
 * The SWD window in the lid is deliberately 0.8 mm off the board's SWD pads
 * along x, so the sample fit finding has something real to report.
 */
export const SWD_WINDOW = { x: 9.5 + BOARD_IN_ENCLOSURE[0] + 0.8, y: 1.4 + BOARD_IN_ENCLOSURE[1], w: 5, h: 2.4 } as const;

/** The opening in the left wall for the battery lead, level with the VIN pads. */
export const CABLE_ENTRY = { y: 15.5 + BOARD_IN_ENCLOSURE[1], z: 6.5, size: 3 } as const;
