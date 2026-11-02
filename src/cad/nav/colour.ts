/**
 * Hover and selection colours (R2-A, walkthrough A3, 2026-11-02). Kevin: "the hover color should be an expression
 * of the original color and theme-aware"; "the default is orange, and if something is the exact same orange colour,
 * change the color when you select it"; "the agent should have full access and control to change colors".
 *
 * - Hover: the part's own colour mixed toward the accent (DEFAULT 25 %), then lifted on a dark ground and deepened
 *   on paper (DEFAULT 0.12 of OKLab lightness), so a black chip on a dark board still reads as hovered and a white
 *   panel on paper does too.
 * - Selection: the accent, unless the part's own colour is within DEFAULT delta E 12 (CIE76, Lab D65) of it; then
 *   the secondary accent (the theme's `highlight` token, DEFAULT).
 * - Highlight: the theme's glow, or the colour the agent gave the `highlight` op (a token name or a hex colour).
 *
 * Colours are three.js hex numbers in sRGB (as `THREE.Color.getHex()` gives them).
 */

/** DEFAULT (R2-A, A3): the hover colour is the part's own colour mixed this far toward the accent. */
export const HOVER_MIX = 0.25;
/** DEFAULT (R2-A, A3): and lifted (dark ground) or deepened (paper) by this much OKLab lightness. */
export const HOVER_LIGHTNESS = 0.12;
/** DEFAULT (R2-A, A3; Kevin's brief): a part this close to the accent (CIE76 delta E) is selected in the secondary accent. */
export const SELECT_DELTA_E = 12;

type Rgb = [number, number, number];

const rgbOf = (hex: number): Rgb => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
const hexOf = ([r, g, b]: Rgb): number => {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return (c(r) << 16) | (c(g) << 8) | c(b);
};
const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055);

/** CIE Lab (D65) of an sRGB hex colour. */
export function labOf(hex: number): Rgb {
  const [r, g, b] = rgbOf(hex).map(toLinear) as Rgb;
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 colour difference of two sRGB hex colours (about 2.3 is just noticeable). */
export function deltaE(a: number, b: number): number {
  const [l1, a1, b1] = labOf(a);
  const [l2, a2, b2] = labOf(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** OKLab of an sRGB hex colour (perceptual lightness for the hover lift). */
function oklabOf(hex: number): Rgb {
  const [r, g, b] = rgbOf(hex).map(toLinear) as Rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function hexOfOklab([L, A, B]: Rgb): number {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const b = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return hexOf([toSrgb(r), toSrgb(g), toSrgb(b)].map((v) => Math.max(0, Math.min(1, v))) as Rgb);
}

/** `a` mixed `t` of the way to `b`, in OKLab (no muddy midpoints). */
export function mixColour(a: number, b: number, t: number): number {
  const x = oklabOf(a);
  const y = oklabOf(b);
  return hexOfOklab([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

/** Whether a ground colour is dark (relative luminance under 0.5 of white, as the scene's own test). */
export function isDarkGround(hex: number): boolean {
  const [r, g, b] = rgbOf(hex);
  return r * 0.2126 + g * 0.7152 + b * 0.0722 < 0.5;
}

/**
 * The hover colour of a part (R2-A, A3): its own colour mixed `mix` toward the accent, then lifted on a dark ground
 * or deepened on paper by `lift` of OKLab lightness (pushed the other way when the end would clip, so a white part
 * on a dark ground still changes).
 */
export function hoverColour(own: number, accent: number, dark: boolean, mix = HOVER_MIX, lift = HOVER_LIGHTNESS): number {
  const m = oklabOf(mixColour(own, accent, mix));
  let L = m[0] + (dark ? lift : -lift);
  if (L > 0.97) L = m[0] - lift;
  if (L < 0.03) L = m[0] + lift;
  return hexOfOklab([Math.max(0, Math.min(1, L)), m[1], m[2]]);
}

/**
 * The selection colour for a part (R2-A, A3): the accent, or `secondary` when the part's own colour is within
 * `threshold` delta E of the accent (an orange part selected in orange would vanish). A part with no known colour
 * gets the accent.
 */
export function selectionColour(own: number | undefined, accent: number, secondary: number, threshold = SELECT_DELTA_E): number {
  return own !== undefined && deltaE(own, accent) < threshold ? secondary : accent;
}

/**
 * The highlight colour an agent asked for (the view state's `highlightColor`): a hex colour as is, a token name
 * through `token` (the theme's value), undefined when there is none or it does not resolve.
 */
export function resolveHighlightColour(value: string | undefined, token: (name: string) => string | undefined): number | undefined {
  if (!value) return undefined;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value) ? value : token(value);
  if (!hex) return undefined;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!m) return undefined;
  const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  return parseInt(h, 16);
}
