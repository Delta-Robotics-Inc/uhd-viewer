/**
 * How much of the diagram's legend fits beside the bottom toolbar. The legend
 * stays where it is (bottom right) and gives way as the toolbar comes near:
 * the full card, then a compact one (swatches without their labels), then,
 * at its smallest, a button in the toolbar that opens it. Folded, it is a
 * narrow tab at the right edge, which gives way to the button the same way.
 * A short canvas folds it (`legendShort`). No DOM here: the legend measures,
 * this decides.
 */

export type LegendStage = "full" | "compact" | "button";

/** Space kept between the legend and the toolbar (px). */
export const LEGEND_GAP = 8;
/** A larger form comes back only with this much room to spare (px), so a width at the edge does not flicker between two. */
export const LEGEND_HYSTERESIS = 6;
/** Below this canvas height (px) the legend folds by itself: open, it would cover much of the drawing. */
export const LEGEND_SHORT = 500;

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface LegendMeasure {
  /** Where the legend's right edge is (the same for every form). */
  right: number;
  /** Each form's box, as it would sit (bottom right). */
  full: Box;
  compact: Box;
  /** The folded tab's box, as it would sit (at the right edge). */
  tab?: Box;
  /** The toolbar's box, or none (no toolbar, or hidden). */
  toolbar?: Box | null;
  /** The legend's button in the toolbar takes this much of it (its width and gap), when it is there: the toolbar is measured as if it were not. */
  slot?: number;
}

/**
 * The room the legend has before the toolbar (px): from the toolbar's right
 * edge to the legend's, less the gap. The toolbar is centred, so its button
 * for the legend moves its right edge by half the button: that half is taken
 * back, and the room is the same whether or not the button is in it.
 */
export function legendRoom(m: Pick<LegendMeasure, "right" | "toolbar" | "slot">): number {
  if (!m.toolbar) return Infinity;
  return m.right - (m.toolbar.right - (m.slot ?? 0) / 2) - LEGEND_GAP;
}

const overlapsY = (a: Box, b: Box) => a.top < b.bottom && b.top < a.bottom;

/**
 * The largest form that does not run into the toolbar. A form fits when it is
 * clear of the toolbar's height, or narrower than the room. Moving up to a
 * larger form than `current` takes `LEGEND_HYSTERESIS` more. Folded
 * (`folded`), the tab is the only form: "full" while it fits, else "button".
 */
export function legendStage(m: LegendMeasure, current: LegendStage = "full", folded = false): LegendStage {
  const room = legendRoom(m);
  const order: LegendStage[] = ["full", "compact", "button"];
  const at = order.indexOf(current);
  const fits = (box: Box, stage: LegendStage) => {
    if (!m.toolbar || !overlapsY(box, m.toolbar)) return true;
    const spare = order.indexOf(stage) < at ? LEGEND_HYSTERESIS : 0;
    return box.right - box.left + spare <= room;
  };
  if (folded) return !m.tab || fits(m.tab, "full") ? "full" : "button";
  if (fits(m.full, "full")) return "full";
  if (fits(m.compact, "compact")) return "compact";
  return "button";
}

/**
 * Whether the legend shows folded: the user folded it, or the canvas is
 * shorter than `LEGEND_SHORT` and the user has not opened it since it became
 * so (`peek`).
 */
export function legendFolded(open: boolean, canvasHeight: number, peek: boolean): boolean {
  if (!open) return true;
  return canvasHeight > 0 && canvasHeight < LEGEND_SHORT && !peek;
}
