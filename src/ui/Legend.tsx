/**
 * Legend primitives: a floating card with a title and swatches. A swatch is
 * a short line (links) or a dot (states). An item given `onSelect` is a
 * button: the legend then isolates what it stands for.
 */
import type { ReactNode } from "react";
import { cx } from "./cx";

export function Legend({ title, children, className }: { title?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cx("uhd-legend flex min-w-[150px] flex-col gap-1.5 rounded-panel border border-line bg-surface px-3 py-2.5 shadow-panel outline outline-1 -outline-offset-1 outline-contrast", className)}>
      {title && <div className="mb-0.5 font-label text-[10px] tracking-[0.8px] text-fg-muted uppercase">{title}</div>}
      {children}
    </div>
  );
}

export interface LegendItemProps {
  color: string;
  label: ReactNode;
  shape?: "line" | "dot" | "dash";
  /** Given: the item is a button. `add` says a modifier key was held (add to, or take from, the ones held). */
  onSelect?: (add: boolean) => void;
  /** The item is the one (or one of those) isolated. */
  pressed?: boolean;
  /** Another item is isolated: this one steps back. */
  dimmed?: boolean;
  /** Nothing here is of this kind: the button is disabled and says so. */
  absent?: boolean;
  /** The button's tooltip. */
  hint?: string;
  /** A second line of the tooltip (how to hold several). */
  hintShortcut?: string;
}

export function LegendItem({ color, label, shape = "line", onSelect, pressed, dimmed, absent, hint, hintShortcut }: LegendItemProps) {
  const swatch = (
    <span
      aria-hidden
      className={cx("shrink-0", shape === "dot" ? "size-2 rounded-full" : "h-[3px] w-4 rounded-sm")}
      style={shape === "dash" ? { background: `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 7px)` } : { background: color }}
    />
  );
  if (!onSelect) {
    return (
      <div className="flex items-center gap-2 text-[9.5px] text-fg-muted">
        {swatch}
        <span>{label}</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      aria-pressed={pressed ?? false}
      aria-disabled={absent || undefined}
      data-tooltip={hint}
      data-tooltip-shortcut={hintShortcut}
      data-tooltip-side="right"
      onClick={(e) => !absent && onSelect(e.shiftKey || e.ctrlKey || e.metaKey)}
      className={cx(
        "uhd-legend-item -mx-1.5 -my-0.5 flex min-h-[18px] items-center gap-2 rounded-sm border-0 bg-transparent px-1.5 py-0.5 text-left font-ui text-[9.5px] text-fg-muted transition-[opacity,background-color]",
        "focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-focus",
        absent ? "cursor-default opacity-40" : "cursor-pointer hover:bg-hover hover:text-fg",
        pressed && "bg-accent-tint text-fg outline outline-1 -outline-offset-1 outline-contrast-active",
        dimmed && !absent && "opacity-55",
      )}
    >
      {swatch}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}
