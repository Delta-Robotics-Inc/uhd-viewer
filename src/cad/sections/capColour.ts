/**
 * The cap's tones from the cut part's own colour (R4-C, 2026-11-02; Kevin: "The color of the cross-section hatch
 * system should match the color of the actual 3D model").
 *
 * A cut part's cap is filled with a tone of the colour its surface shows (base colour plus its glow, so a selected
 * part's cap takes the selection's accent and a highlighted one its glow), pulled a little toward the theme's
 * background in lightness so the cut reads as a section and not as the outer surface; the hatch lines are a darker
 * tone of the same hue, at least 3:1 against the fill (WCAG contrast). Where a darker tone cannot reach 3:1 (a fill
 * near black: the drone's carbon, the boards' dark green), the lines are a lighter tone of the same hue instead.
 *
 * The same rule runs twice: here in TypeScript (the CPU caps of open meshes, tests, docs) and in GLSL
 * (`CAP_TONES_GLSL`, the live stencil caps, which read the colour per instance on the GPU). The two follow the same
 * steps in the same order; change both together.
 *
 * Lightness is HSL lightness of the sRGB colour; changing it keeps hue and saturation (the channels move about their
 * mid-point, scaled by the change in chroma), except that chroma never grows (DEFAULT: paper's warm lit tone #f4f4f1 would
 * otherwise give olive lines). Contrast is computed on linear light.
 */
import * as THREE from "three";
import { DARK_SCENE_TOKENS, PAPER_SCENE_TOKENS } from "../../theme/themes";
import { NEUTRAL_FALLBACK } from "../render/toon";

/** Share of the way the fill's lightness moves toward the background's (DEFAULT 0.12, the R4-C brief). */
export const CAP_SHIFT_TO_GROUND = 0.12;
/** The lines' lightness below the fill's, dark theme (DEFAULT 0.45: 45 % darker, the R4-C brief). */
export const CAP_LINE_DARKEN_DARK = 0.45;
/** The same on paper (DEFAULT 0.35). */
export const CAP_LINE_DARKEN_PAPER = 0.35;
/** Least contrast between the fill and its lines (the R4-C brief: at least 3:1). */
export const CAP_MIN_CONTRAST = 3;
/** Where a pair falls short, the lines are moved to this contrast (DEFAULT 3.2: margin for 8-bit rounding). */
export const CAP_CONTRAST_AIM = 3.2;
/** How much of the line tone a hatch line takes over the fill (DEFAULT 1: the lines are exactly the derived tone). */
export const CAP_LINE_SHARE = 1;

export type Rgb = [number, number, number];

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** sRGB channel to linear light (the exact piecewise curve, as three's ColorManagement). */
export const toLinear = (c: number) => (c < 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
/** Linear light to an sRGB channel. */
export const toSrgb = (c: number) => (c < 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
/** WCAG relative luminance of a linear colour. */
export const lumLinear = (c: Rgb) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
/** WCAG contrast of two linear colours. */
export const contrastLinear = (a: Rgb, b: Rgb) => {
  const x = lumLinear(a);
  const y = lumLinear(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/** HSL lightness of an sRGB colour. */
export const lightness = (c: Rgb) => (Math.max(...c) + Math.min(...c)) / 2;

/** The sRGB colour with HSL lightness `l2`, hue kept, saturation kept unless that would raise the chroma. */
export function withLightness(c: Rgb, l2: number): Rgb {
  const l = lightness(c);
  const den = 1 - Math.abs(2 * l - 1);
  // saturation kept, but chroma never grows: a near-white part (paper's lit tone) does not turn into a tinted mid-tone
  const s = den > 1e-6 ? Math.min(1, (1 - Math.abs(2 * l2 - 1)) / den) : 0;
  return c.map((v) => clamp01(l2 + (v - l) * s)) as Rgb;
}

const hexToSrgb = (hex: string): Rgb => {
  const c = new THREE.Color(hex);
  const s = c.getRGB(new THREE.Color(), THREE.SRGBColorSpace);
  return [s.r, s.g, s.b];
};
const srgbToHex = (c: Rgb) => `#${c.map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, "0")).join("")}`;
const lin = (c: Rgb): Rgb => c.map(toLinear) as Rgb;
const srgb = (c: Rgb): Rgb => c.map(toSrgb) as Rgb;

/** Whether a background is a dark one (HSL lightness under one half). */
export const isDarkGround = (ground: string): boolean => lightness(hexToSrgb(ground)) < 0.5;

/** The scene's tones a cap is derived against: the background and the theme's lit tone (what a neutral part shows). */
export interface CapScene {
  background: string;
  neutral: string;
}

/** The defaults until the scene hands its own: the two themes' scene tokens, chosen by the section ink. */
export const DARK_CAP_SCENE: CapScene = { background: DARK_SCENE_TOKENS.sceneBackground, neutral: DARK_SCENE_TOKENS.modelToneLit };
export const PAPER_CAP_SCENE: CapScene = { background: PAPER_SCENE_TOKENS.sceneBackground, neutral: PAPER_SCENE_TOKENS.modelToneLit };

/** Uniform-ready numbers for a scene (the shader's inputs). */
export function capSceneParams(scene: CapScene): { groundL: number; darken: number; neutral: THREE.Color } {
  const dark = isDarkGround(scene.background);
  return { groundL: lightness(hexToSrgb(scene.background)), darken: dark ? CAP_LINE_DARKEN_DARK : CAP_LINE_DARKEN_PAPER, neutral: new THREE.Color(scene.neutral) };
}

/** Fill and line tones as linear colours, from the surface colour (linear). */
export function capTonesLinear(surfaceLinear: Rgb, scene: { groundL: number; darken: number }): { fill: Rgb; line: Rgb } {
  const s = srgb(surfaceLinear.map(clamp01) as Rgb);
  const l = lightness(s);
  const fillS = withLightness(s, l + CAP_SHIFT_TO_GROUND * (scene.groundL - l));
  const lineS = withLightness(fillS, lightness(fillS) * (1 - scene.darken));
  const fill = lin(fillS);
  let line = lin(lineS);
  const lf = lumLinear(fill);
  const ll = lumLinear(line);
  if ((Math.max(lf, ll) + 0.05) / (Math.min(lf, ll) + 0.05) < CAP_MIN_CONTRAST) {
    const darker = (lf + 0.05) / CAP_CONTRAST_AIM - 0.05;
    if (darker >= 0) {
      // scale the line's linear light: hue and chromaticity kept, luminance exactly the target
      const k = ll > 1e-9 ? darker / ll : 0;
      line = line.map((v) => v * k) as Rgb;
    } else {
      // the fill is too dark for a darker line at 3:1: a lighter line of the same hue (the fill's linear light
      // scaled up, chromaticity kept; what a channel cannot take past 1 is made up toward white)
      const lighter = CAP_CONTRAST_AIM * (lf + 0.05) - 0.05;
      line = lf > 1e-6 ? (fill.map((v) => Math.min(1, (v * lighter) / lf)) as Rgb) : [0, 0, 0];
      const lu = lumLinear(line);
      const t = lu < lighter ? (lighter - lu) / (1 - lu) : 0;
      line = line.map((v) => v + (1 - v) * t) as Rgb;
    }
  }
  return { fill, line };
}

/**
 * The cap's fill and line (sRGB hex) for a part's surface colour (sRGB hex) in a scene. The neutral fallback grey
 * (a part with no colour of its own) is read as the scene's lit tone first, as the toon look does.
 */
export function capTones(surface: string, scene: CapScene): { fill: string; line: string; contrast: number } {
  const base = surface.toLowerCase() === NEUTRAL_FALLBACK ? scene.neutral : surface;
  const { fill, line } = capTonesLinear(lin(hexToSrgb(base)), capSceneParams(scene));
  const fillHex = srgbToHex(srgb(fill));
  const lineHex = srgbToHex(srgb(line));
  return { fill: fillHex, line: lineHex, contrast: contrastLinear(lin(hexToSrgb(fillHex)), lin(hexToSrgb(lineHex))) };
}

const _c = new THREE.Color();
const _e = new THREE.Color();

/**
 * The colour a mesh's surface shows, linear (what its cap is derived from): its material's base colour plus its
 * glow (`userData.emissive` when set, else the material's emissive times intensity), each channel at most 1. The
 * neutral fallback grey is the scene's lit tone. `material` picks one of a multi-material mesh's materials.
 */
export function surfaceColour(mesh: THREE.Object3D, neutral: THREE.Color, out = new THREE.Color(), material?: THREE.Material): THREE.Color {
  const m = (material ?? (mesh as THREE.Mesh).material) as THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[] | undefined;
  const mat = Array.isArray(m) ? m[0] : m;
  out.setRGB(1, 1, 1);
  if (mat?.color) out.copy(mat.color);
  if (out.equals(_c.set(NEUTRAL_FALLBACK))) out.copy(neutral);
  const e = mesh.userData.emissive;
  if (typeof e === "number") _e.setHex(e);
  else if (mat?.emissive) _e.copy(mat.emissive).multiplyScalar(mat.emissiveIntensity ?? 1);
  else _e.setRGB(0, 0, 0);
  return out.setRGB(clamp01(out.r + _e.r), clamp01(out.g + _e.g), clamp01(out.b + _e.b));
}

/**
 * GLSL of the same rule (ASCII only). `uhdCapTones(surfaceLinear, groundL, darken, fill, line)` writes linear fill
 * and line colours. Constants are baked in from the TypeScript ones above.
 */
export const CAP_TONES_GLSL = /* glsl */ `
float uhdLight( vec3 c ) { return 0.5 * ( max( c.r, max( c.g, c.b ) ) + min( c.r, min( c.g, c.b ) ) ); }
vec3 uhdWithLight( vec3 c, float l2 ) {
  float l = uhdLight( c );
  float den = 1.0 - abs( 2.0 * l - 1.0 );
  float s = den > 1e-6 ? min( 1.0, ( 1.0 - abs( 2.0 * l2 - 1.0 ) ) / den ) : 0.0;
  return clamp( vec3( l2 ) + ( c - vec3( l ) ) * s, 0.0, 1.0 );
}
vec3 uhdToSrgb( vec3 c ) { return mix( c * 12.92, 1.055 * pow( max( c, vec3( 0.0 ) ), vec3( 1.0 / 2.4 ) ) - 0.055, step( vec3( 0.0031308 ), c ) ); }
vec3 uhdToLinear( vec3 c ) { return mix( c / 12.92, pow( ( max( c, vec3( 0.0 ) ) + 0.055 ) / 1.055, vec3( 2.4 ) ), step( vec3( 0.04045 ), c ) ); }
float uhdLum( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
void uhdCapTones( vec3 surface, float groundL, float darken, out vec3 fill, out vec3 line ) {
  vec3 s = uhdToSrgb( clamp( surface, 0.0, 1.0 ) );
  float l = uhdLight( s );
  vec3 fillS = uhdWithLight( s, l + ${CAP_SHIFT_TO_GROUND.toFixed(4)} * ( groundL - l ) );
  vec3 lineS = uhdWithLight( fillS, uhdLight( fillS ) * ( 1.0 - darken ) );
  fill = uhdToLinear( fillS );
  line = uhdToLinear( lineS );
  float lf = uhdLum( fill );
  float ll = uhdLum( line );
  if ( ( max( lf, ll ) + 0.05 ) / ( min( lf, ll ) + 0.05 ) < ${CAP_MIN_CONTRAST.toFixed(4)} ) {
    float darker = ( lf + 0.05 ) / ${CAP_CONTRAST_AIM.toFixed(4)} - 0.05;
    if ( darker >= 0.0 ) {
      line *= ll > 1e-9 ? darker / ll : 0.0;
    } else {
      float lighter = ${CAP_CONTRAST_AIM.toFixed(4)} * ( lf + 0.05 ) - 0.05;
      float t = lf < 1.0 ? ( lighter - lf ) / ( 1.0 - lf ) : 0.0;
      line = fill + ( vec3( 1.0 ) - fill ) * t;
    }
  }
}
`;
