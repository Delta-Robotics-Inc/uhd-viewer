/**
 * The G-code tab's layer slider (PB-1192): a two-ended range over the layers
 * that hold a VISIBLE segment. Hide every type but support and the slider
 * steps only through layers with support in them; nothing is ever a step
 * that draws nothing. The slider works in positions (0..n-1 over that list);
 * these helpers turn positions into layer indices and back.
 */
import { FEATURE_COUNT, TRAVEL } from "./features";
import type { GcodeModel } from "./parser";

/** The 16-bit mask of shown types (bit f: feature f; bit 0: travel). */
export function visibleMask(on: readonly boolean[], travel: boolean): number {
  let m = travel ? 1 << TRAVEL : 0;
  for (let f = 1; f < FEATURE_COUNT; f++) if (on[f] !== false) m |= 1 << f;
  return m;
}

/** Layer indices holding at least one segment of a shown type, ascending. */
export function visibleLayers(model: GcodeModel, mask: number): number[] {
  const out: number[] = [];
  const t = model.layers.types;
  for (let l = 0; l < model.layers.count; l++) if (t[l] & mask) out.push(l);
  return out;
}

export interface LayerRange {
  /** Positions in `layers` (inclusive). */
  lo: number;
  hi: number;
  /** The visible layers the positions index. */
  layers: number[];
}

/** A range kept over a new list of visible layers: the same layer indices where they still exist, else the nearest. */
export function rebaseRange(prev: LayerRange | undefined, layers: number[]): LayerRange {
  if (!layers.length) return { lo: 0, hi: 0, layers };
  if (!prev || !prev.layers.length) return { lo: 0, hi: layers.length - 1, layers };
  const atOrAfter = (layer: number) => {
    const i = layers.findIndex((l) => l >= layer);
    return i < 0 ? layers.length - 1 : i;
  };
  const atOrBefore = (layer: number) => {
    for (let i = layers.length - 1; i >= 0; i--) if (layers[i] <= layer) return i;
    return 0;
  };
  const wasAll = prev.lo === 0 && prev.hi === prev.layers.length - 1;
  if (wasAll) return { lo: 0, hi: layers.length - 1, layers };
  const lo = atOrAfter(prev.layers[prev.lo]);
  const hi = Math.max(lo, atOrBefore(prev.layers[prev.hi]));
  return { lo, hi, layers };
}

/** Move one end; the other follows when they would cross. */
export function setEnd(r: LayerRange, end: "lo" | "hi", pos: number): LayerRange {
  const p = Math.max(0, Math.min(r.layers.length - 1, Math.round(pos)));
  if (end === "lo") return { ...r, lo: p, hi: Math.max(p, r.hi) };
  return { ...r, hi: p, lo: Math.min(p, r.lo) };
}

/** The layer indices a range covers (for the draw's uniforms): first and last visible layer. */
export function rangeLayers(r: LayerRange): [number, number] {
  if (!r.layers.length) return [0, -1];
  return [r.layers[r.lo], r.layers[r.hi]];
}
