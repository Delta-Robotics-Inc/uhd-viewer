/**
 * The floor grid's spacing levels and units (R4-B, 2026-11-02). Pure: no three.js scene, no DOM.
 *
 * Kevin: "The floor grid should be infinite but render with scale/zoom." "The floor needs a dynamic grid too in mm
 * or in." The grid draws lines at a ladder of spacings (scene units: mm). Which rungs show depends on how many screen
 * pixels one rung spans: a rung closer than `MIN_LINE_PX` apart is not drawn, the next one fades in as it opens up,
 * and the rung after it reads as the major lines. The shader does this per fragment (so the far floor fades by
 * itself); the CPU does it once at the orbit target for the scale label and the tests.
 */

/** Length units of the floor grid, the cube for scale and their labels (`viewer.units`; DEFAULT mm). */
export type Units = "mm" | "in";
export const DEFAULT_UNITS: Units = "mm";

/** One inch in mm (exact). */
export const MM_PER_IN = 25.4;

/**
 * The spacings the grid steps through, in mm, finest first. DEFAULT (R4-B): metric 0.1 mm to 10 m in tens (Kevin's
 * 1, 10, 100, 1000 mm, plus 0.1 mm for a board's 0402 parts and 10 m for a large frame); imperial 1/16 in, 1 in,
 * 1 ft, 10 ft (Kevin's 1/16, 1, 12 in, plus 10 ft).
 */
export const LADDERS: Readonly<Record<Units, readonly number[]>> = Object.freeze({
  mm: [0.1, 1, 10, 100, 1000, 10000],
  in: [MM_PER_IN / 16, MM_PER_IN, 12 * MM_PER_IN, 120 * MM_PER_IN],
});

/** DEFAULT (R4-B): a rung closer than this many CSS pixels is not drawn; it fades in up to 4x this. */
export const MIN_LINE_PX = 8;
/** DEFAULT (R4-B): a rung reads as "major" (the major tone) from 4x to 30x `MIN_LINE_PX` apart. */
export const MAJOR_FROM_PX = 4 * MIN_LINE_PX;
export const MAJOR_FULL_PX = 30 * MIN_LINE_PX;

export const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** A rung's opacity (fades in as its lines open up past `MIN_LINE_PX`), the same curve as the shader's. */
export const rungAlpha = (px: number, minPx = MIN_LINE_PX): number => smoothstep(minPx, 4 * minPx, px);
/** A rung's tone from minor (0) to major (1), the same curve as the shader's. */
export const rungWeight = (px: number, minPx = MIN_LINE_PX): number => smoothstep(4 * minPx, 30 * minPx, px);

export interface GridLevels {
  units: Units;
  /** Index into `LADDERS[units]` of the finest rung drawn. */
  index: number;
  /** The finest rung drawn (mm) and its opacity now. */
  minorMm: number;
  minorAlpha: number;
  /** The rung above it (mm): the major lines, and the scale label's value. */
  majorMm: number;
  /** Screen pixels per mm where this was judged (the orbit target). */
  pxPerMm: number;
}

/**
 * The rungs drawn where one mm spans `pxPerMm` CSS pixels: the finest rung at least `minPx` apart, and the one above
 * it. Zoomed out past the ladder's top, the top rung is both (the label still names it); zoomed in past its bottom,
 * the finest rung is the minor one.
 */
export function gridLevels(pxPerMm: number, units: Units = DEFAULT_UNITS, minPx = MIN_LINE_PX): GridLevels {
  const ladder = LADDERS[units];
  const p = Number.isFinite(pxPerMm) && pxPerMm > 0 ? pxPerMm : 1;
  let index = ladder.findIndex((s) => s * p >= minPx);
  if (index < 0) index = ladder.length - 1;
  const minorMm = ladder[index];
  const majorMm = ladder[Math.min(index + 1, ladder.length - 1)];
  return { units, index, minorMm, minorAlpha: rungAlpha(minorMm * p, minPx), majorMm, pxPerMm: p };
}

/**
 * CSS pixels per mm at `distanceMm` from a perspective camera with a vertical field of view `fovDeg` drawn
 * `viewportHeightPx` CSS pixels tall (on a plane facing the camera; the floor seen at an angle is finer, which the
 * shader handles per fragment).
 */
export function pxPerMmAt(distanceMm: number, fovDeg: number, viewportHeightPx: number): number {
  const d = Math.max(1e-6, distanceMm);
  return viewportHeightPx / (2 * d * Math.tan((fovDeg * Math.PI) / 360));
}

const FRACTIONS: [number, string][] = [
  [1 / 64, "1/64"],
  [1 / 32, "1/32"],
  [1 / 16, "1/16"],
  [1 / 8, "1/8"],
  [1 / 4, "1/4"],
  [1 / 2, "1/2"],
];

/** Trim a number to at most `digits` decimals, without trailing zeros. */
const trim = (v: number, digits = 2) => String(Math.round(v * 10 ** digits) / 10 ** digits);

/**
 * A length (mm) as the label words it: "0.1 mm", "10 mm", "1 m" (DEFAULT: 1000 mm and up in metres); "1/16 in",
 * "1 in", "1 ft", "10 ft" (DEFAULT: whole feet from 12 in).
 */
export function formatLength(mm: number, units: Units = DEFAULT_UNITS): string {
  if (units === "mm") return mm >= 1000 ? `${trim(mm / 1000)} m` : `${trim(mm)} mm`;
  const inches = mm / MM_PER_IN;
  if (inches >= 12 - 1e-6 && Math.abs(inches / 12 - Math.round(inches / 12)) < 1e-6) return `${Math.round(inches / 12)} ft`;
  const f = FRACTIONS.find(([v]) => Math.abs(inches - v) < 1e-6);
  if (f) return `${f[1]} in`;
  return `${trim(inches, 3)} in`;
}

/** `viewer.units` as a host may send it: "mm" or "in", anything else the DEFAULT. */
export const readUnits = (v: unknown): Units => (v === "in" || v === "mm" ? v : DEFAULT_UNITS);
