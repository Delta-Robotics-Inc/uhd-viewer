/**
 * The floor grid's scale label (R4-B, 2026-11-02): a small "10 mm" / "1 in" in the view's bottom-left corner naming
 * the major line spacing at the orbit target, updated when the zoom crosses a rung or the units change, hidden with
 * the grid. Plain DOM in the view's container (theme tokens through CSS variables), so captures of the canvas do not
 * carry it.
 */
import { formatLength, type GridLevels } from "./levels";

/** What the label reads from the grid (the `GroundGrid` interface's members). */
export interface LabelledGrid {
  readonly visible: boolean;
  levels(): GridLevels | undefined;
  onLevels(cb: (l: GridLevels) => void): () => void;
}

/** DEFAULT (R4-B): the label's place, CSS px from the container's bottom-left corner. */
export const GRID_LABEL_INSET = { left: 12, bottom: 12 } as const;

/** The label's words and tooltip for some levels. */
export function gridLabelText(l: GridLevels): { text: string; tooltip: string } {
  const major = formatLength(l.majorMm, l.units);
  const minor = formatLength(l.minorMm, l.units);
  return {
    text: major,
    tooltip: l.majorMm === l.minorMm ? `Floor grid: lines every ${major}` : `Floor grid: major lines every ${major}, minor every ${minor}`,
  };
}

/** Mount the label in `container` (positioned: CadView's view host). Returns unmount. */
export function mountGridLabel(container: HTMLElement, grid: LabelledGrid): () => void {
  if (typeof document === "undefined") return () => undefined;
  const el = document.createElement("div");
  el.className = "cad-grid-scale";
  el.dataset.chrome = "grid-scale";
  el.setAttribute("role", "note");
  Object.assign(el.style, {
    position: "absolute",
    left: `${GRID_LABEL_INSET.left}px`,
    bottom: `${GRID_LABEL_INSET.bottom}px`,
    zIndex: "5",
    padding: "1px 6px",
    borderRadius: "3px",
    font: "500 11px/16px var(--uhd-font-mono, ui-monospace, monospace)",
    color: "var(--uhd-text-muted, #8a8a8f)",
    background: "color-mix(in oklab, var(--uhd-scene-background, #131313) 70%, transparent)",
    pointerEvents: "auto",
    userSelect: "none",
    display: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  container.appendChild(el);
  const show = () => {
    const l = grid.levels();
    if (!l || !grid.visible) {
      el.style.display = "none";
      return;
    }
    const { text, tooltip } = gridLabelText(l);
    if (el.textContent !== text) el.textContent = text;
    el.dataset.tooltip = tooltip;
    el.setAttribute("aria-label", tooltip);
    el.style.display = "block";
  };
  const off = grid.onLevels(show);
  show();
  return () => {
    off();
    el.remove();
  };
}
