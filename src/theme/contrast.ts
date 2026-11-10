/**
 * WCAG 2 contrast (PB-1189): the relative luminance of an sRGB colour and the ratio between two, used by the
 * token tests to hold the DRC set and the ink at their thresholds on each theme's grounds.
 */

/** `#rgb` or `#rrggbb` (alpha ignored) as 0..1 sRGB channels; undefined for anything else. */
export function parseHex(hex: string): [number, number, number] | undefined {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(hex.trim());
  if (!m) return undefined;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
}

/** WCAG relative luminance (0 black ... 1 white) of an sRGB colour. */
export function luminance([r, g, b]: [number, number, number]): number {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** The WCAG contrast ratio of two hex colours (1 ... 21). */
export function contrastRatio(a: string, b: string): number {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) throw new Error(`not a hex colour: ${ca ? b : a}`);
  const la = luminance(ca);
  const lb = luminance(cb);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** WCAG thresholds: text (AA) and graphical objects such as markers and ink (1.4.11). */
export const CONTRAST_TEXT = 4.5;
export const CONTRAST_GRAPHIC = 3;
