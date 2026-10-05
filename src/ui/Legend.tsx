/**
 * Legend primitives: a floating card with a title and swatches. A swatch is
 * a short line (links) or a dot (states).
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

export function LegendItem({ color, label, shape = "line" }: { color: string; label: ReactNode; shape?: "line" | "dot" | "dash" }) {
  return (
    <div className="flex items-center gap-2 text-[9.5px] text-fg-muted">
      <span
        aria-hidden
        className={cx("shrink-0", shape === "dot" ? "size-2 rounded-full" : "h-[3px] w-4 rounded-sm")}
        style={shape === "dash" ? { background: `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 7px)` } : { background: color }}
      />
      <span>{label}</span>
    </div>
  );
}
