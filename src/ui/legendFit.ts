/**
 * How much of the diagram's legend fits beside the bottom toolbar. The legend
 * stays where it is (bottom left) and gives way as the toolbar comes near:
 * the full card, then a compact one (swatches without their labels), then,
 * at its smallest, a button in the toolbar that opens it. No DOM here: the
 * legend measures, this decides.
 */

export type LegendStage = "full" | "compact" | "button";

/** Space kept between the legend and the toolbar (px). */
export const LEGEND_GAP = 8;
/** A larger form comes back only with this much room to spare (px), so a width at the edge does not flicker between two. */
export const LEGEND_HYSTERESIS = 6;

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface LegendMeasure {
  /** Where the legend's left edge is (the same for every form). */
  left: number;
  /** Each form's box, as it would sit (bottom left). */
  full: Box;
  compact: Box;
  /** The toolbar's box, or none (no toolbar, or hidden). */
  toolbar?: Box | null;
  /** The legend's button in the toolbar takes this much of it (its width and gap), when it is there: the toolbar is measured as if it were not. */
  slot?: number;
}

/**
 * The room the legend has before the toolbar (px): from its left edge to
 * the toolbar's, less the gap. The toolbar is centred, so its button for the
 * legend moves its left edge by half the button: that half is given back,
 * and the room is the same whether or not the button is in it.
 */
export function legendRoom(m: Pick<LegendMeasure, "left" | "toolbar" | "slot">): number {
  if (!m.toolbar) return Infinity;
  return m.toolbar.left + (m.slot ?? 0) / 2 - m.left - LEGEND_GAP;
}

const overlapsY = (a: Box, b: Box) => a.top < b.bottom && b.top < a.bottom;

/**
 * The largest form that does not run into the toolbar. A form fits when it is
 * clear of the toolbar's height, or narrower than the room. Moving up to a
 * larger form than `current` takes `LEGEND_HYSTERESIS` more.
 */
export function legendStage(m: LegendMeasure, current: LegendStage = "full"): LegendStage {
  const room = legendRoom(m);
  const order: LegendStage[] = ["full", "compact", "button"];
  const at = order.indexOf(current);
  const fits = (stage: "full" | "compact") => {
    const box = m[stage];
    if (!m.toolbar || !overlapsY(box, m.toolbar)) return true;
    const spare = order.indexOf(stage) < at ? LEGEND_HYSTERESIS : 0;
    return box.right - box.left + spare <= room;
  };
  if (fits("full")) return "full";
  if (fits("compact")) return "compact";
  return "button";
}
