/**
 * Base inspector primitives: a panel with a header and a scrolling body,
 * titled sections, key/value rows, badges and status dots. Shells build their
 * inspectors (and hosts their native-looking side views) from these.
 */
import type { ReactNode } from "react";
import { ScrollArea } from "./ScrollArea";
import { cx } from "./cx";

export interface InspectorPanelProps {
  /** The header's title ("Inspector", a module's name). */
  title?: ReactNode;
  /** Icon buttons or tabs at the header's right. */
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** Classes of the scrolled content. */
  bodyClassName?: string;
}

/** A panel: header, then a body that scrolls with the themed scrollbar. */
export function InspectorPanel({ title, actions, children, className, bodyClassName }: InspectorPanelProps) {
  return (
    <aside className={cx("uhd-inspector-panel flex min-h-0 flex-col overflow-hidden rounded-panel border border-line bg-surface shadow-panel outline outline-1 -outline-offset-1 outline-contrast", className)}>
      {(title || actions) && (
        <header className="flex min-h-11 shrink-0 items-center justify-between gap-2 border-b border-line px-3 py-1.5">
          <span className="truncate font-label text-[13px] tracking-[0.04em] text-fg uppercase">{title}</span>
          {actions && <span className="flex shrink-0 items-center gap-1">{actions}</span>}
        </header>
      )}
      <ScrollArea className="min-h-0 flex-1" contentClassName={cx("px-3 pt-1 pb-4", bodyClassName)}>
        {children}
      </ScrollArea>
    </aside>
  );
}

export function Section({ title, count, actions, children }: { title: ReactNode; count?: number; actions?: ReactNode; children?: ReactNode }) {
  return (
    <section className="mt-3">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h4 className="m-0 font-label text-[11px] font-normal tracking-[0.08em] text-fg-muted uppercase">
          {title}
          {count !== undefined && <span className="text-fg-faint"> · {count}</span>}
        </h4>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** A key and its value on one line (nothing when the value is empty). */
export function PropertyRow({ name, value, mono }: { name: ReactNode; value?: ReactNode; mono?: boolean }) {
  if (value === undefined || value === null || value === "") return null;
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5 text-[11px]">
      <span className="shrink-0 text-fg-muted">{name}</span>
      <span className={cx("min-w-0 truncate text-right text-fg", mono && "font-code")}>{value}</span>
    </div>
  );
}

export type Tone = "neutral" | "accent" | "ok" | "warning" | "error" | "info";

const TONE: Record<Tone, string> = {
  neutral: "border-line text-fg-muted",
  accent: "border-accent text-accent",
  ok: "border-ok/60 text-ok",
  warning: "border-warning/60 text-warning",
  error: "border-error/60 text-error",
  info: "border-info/60 text-info",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children?: ReactNode }) {
  return <span className={cx("inline-flex h-4 items-center rounded-sm border px-1 text-[9px] tracking-[0.06em] uppercase", TONE[tone])}>{children}</span>;
}

const DOT: Record<Tone, string> = { neutral: "bg-fg-faint", accent: "bg-accent", ok: "bg-ok", warning: "bg-warning", error: "bg-error", info: "bg-info" };

export function StatusDot({ tone = "neutral", label }: { tone?: Tone; label?: string }) {
  return <span role={label ? "img" : undefined} aria-label={label} className={cx("inline-block size-2 shrink-0 rounded-full", DOT[tone])} />;
}

/** A quiet message where a panel has nothing to show yet. */
export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center text-fg-muted">
      {icon && <span className="text-fg-faint">{icon}</span>}
      <div className="font-label text-[12px] tracking-[0.06em] text-fg uppercase">{title}</div>
      {children && <p className="m-0 max-w-[280px] text-[11px] leading-relaxed">{children}</p>}
    </div>
  );
}
