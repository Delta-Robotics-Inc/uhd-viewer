/**
 * The grid shader family (R4-B, 2026-11-02): line coverage on a plane from a ladder of spacings, chosen per fragment
 * from the screen footprint (`fwidth`), so lines fade in as they open up and fade out where they crowd (far away,
 * at a grazing angle). Used by the floor grid (./index.ts) and the cube for scale's faces (../scaleref/cube.ts).
 *
 * Coordinates are scene mm. The curves match ./levels.ts (`rungAlpha`, `rungWeight`), which the tests check.
 */
import * as THREE from "three";
import { LADDERS, MIN_LINE_PX, type Units } from "./levels";

/** The most rungs a ladder may have (the uniform array's size). */
export const MAX_RUNGS = 8;

/**
 * GLSL: `vec2 gridLines(vec2 c, float maxMm)`: the strongest line at `c` (mm): x its coverage times its rung's
 * opacity (0..1), y its tone from minor (0) to major (1). Rungs coarser than `maxMm` are not drawn.
 */
export const GRID_LINES_GLSL = /* glsl */ `
uniform float uLadder[${MAX_RUNGS}];
uniform int uRungs;
uniform float uMinPx;
uniform float uDpr;

vec2 gridLines(vec2 c, float maxMm) {
  vec2 fw = max(fwidth(c), vec2(1e-6));
  float fwMax = max(fw.x, fw.y);
  int first = uRungs - 1;
  for (int i = 0; i < ${MAX_RUNGS}; i++) {
    if (i >= uRungs) break;
    if (uLadder[i] / fwMax >= uMinPx) { first = i; break; }
  }
  float a = 0.0;
  float w = 0.0;
  for (int k = 0; k < 3; k++) {
    int i = first + k;
    if (i >= uRungs) break;
    float s = uLadder[i];
    if (s > maxMm * 1.0001) break;
    float px = s / fwMax;
    float la = smoothstep(uMinPx, 4.0 * uMinPx, px);
    float lw = smoothstep(4.0 * uMinPx, 30.0 * uMinPx, px);
    // device pixels to the nearest line of this rung, along each axis
    vec2 d = abs(fract(c / s + 0.5) - 0.5) * s / fw;
    float width = uDpr * mix(1.0, 1.5, lw);
    float cov = clamp(0.5 * width + 0.5 - min(d.x, d.y), 0.0, 1.0) * la;
    if (cov > 0.0) {
      w = mix(w, lw, cov);
      a = max(a, cov);
    }
  }
  return vec2(a, w);
}
`;

/** The uniforms `GRID_LINES_GLSL` reads. */
export function gridUniforms(units: Units): { uLadder: { value: number[] }; uRungs: { value: number }; uMinPx: { value: number }; uDpr: { value: number } } {
  const u = { uLadder: { value: new Array<number>(MAX_RUNGS).fill(1e9) }, uRungs: { value: 0 }, uMinPx: { value: MIN_LINE_PX }, uDpr: { value: 1 } };
  setLadder(u, units);
  return u;
}

/** Point the uniforms at a units' ladder (mm). */
export function setLadder(u: ReturnType<typeof gridUniforms>, units: Units): void {
  const ladder = LADDERS[units];
  for (let i = 0; i < MAX_RUNGS; i++) u.uLadder.value[i] = ladder[i] ?? 1e9;
  u.uRungs.value = Math.min(ladder.length, MAX_RUNGS);
}

/**
 * Device pixels per CSS pixel of what `renderer` draws into now: the canvas's ratio, or a render target's (the
 * quality curve draws into a smaller one), so `MIN_LINE_PX` and the line widths stay CSS pixels.
 */
export function devicePxPerCss(renderer: THREE.WebGLRenderer): number {
  const css = renderer.domElement.clientWidth || renderer.domElement.width || 1;
  const rt = renderer.getRenderTarget();
  const w = rt ? rt.width : renderer.domElement.width;
  return Math.max(0.25, w / css);
}
