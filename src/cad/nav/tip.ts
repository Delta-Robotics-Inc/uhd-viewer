/**
 * The hover tooltip's timing and placement (R2-A, walkthrough A3, 2026-11-02). Kevin: "if I hover over something,
 * it does a small tooltip; if I long hover, that tooltip turns into a bigger tooltip with more information".
 */

import { LONG_HOVER_MS, REVEAL_MS } from "../annot/style";

/** DEFAULT (R2-A, A3): the short tooltip shows this long after the pointer comes to rest on a part (the callouts' intent delay, 80 ms). */
export const TIP_SHORT_MS: number = REVEAL_MS.intent;
/** DEFAULT (R2-A, A3; Kevin asked for the delay nudged up from 600 ms): the long tooltip after this long, R2-C's shared long hover (900 ms). */
export const TIP_LONG_MS: number = LONG_HOVER_MS;
/** DEFAULT: the gap between the part's screen box and the tooltip, in CSS px. */
export const TIP_GAP = 10;

export interface Box2 {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Where the tooltip goes so that it never covers the part (R2-A, A3): above the part's screen box when there is room,
 * else below it, else to its right, else to its left, centred on the pointer along that side and kept inside the
 * view. `part` is the part's projected box, `size` the tooltip's, `view` the canvas (all CSS px, the canvas's
 * frame). A part larger than the view leaves no free side: the tooltip then sits at the pointer's nearer top or
 * bottom edge of the view (it covers the least of what is under the pointer).
 */
export function placeTip(part: Box2, pointer: { x: number; y: number }, size: { width: number; height: number }, view: { width: number; height: number }, gap = TIP_GAP): { left: number; top: number; side: "above" | "below" | "right" | "left" | "edge" } {
  const clampX = (x: number) => Math.max(4, Math.min(view.width - size.width - 4, x));
  const clampY = (y: number) => Math.max(4, Math.min(view.height - size.height - 4, y));
  const centreX = clampX(pointer.x - size.width / 2);
  const centreY = clampY(pointer.y - size.height / 2);
  if (part.top - gap - size.height >= 4) return { left: centreX, top: part.top - gap - size.height, side: "above" };
  if (part.bottom + gap + size.height <= view.height - 4) return { left: centreX, top: part.bottom + gap, side: "below" };
  if (part.right + gap + size.width <= view.width - 4) return { left: part.right + gap, top: centreY, side: "right" };
  if (part.left - gap - size.width >= 4) return { left: part.left - gap - size.width, top: centreY, side: "left" };
  return { left: centreX, top: pointer.y < view.height / 2 ? view.height - size.height - 4 : 4, side: "edge" };
}

/**
 * The tooltip's stages for one hovered part: none until the pointer rests `shortMs` on it, then short, then long
 * after `longMs`. A pure clock so the tests can drive it.
 */
export function tipStage(restedMs: number, shortMs = TIP_SHORT_MS, longMs = TIP_LONG_MS): "none" | "short" | "long" {
  return restedMs >= longMs ? "long" : restedMs >= shortMs ? "short" : "none";
}
