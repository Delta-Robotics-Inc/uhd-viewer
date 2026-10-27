/**
 * The inspector's sections (PB-1042, design A "Linear-tight", 2026-10-21):
 * one column, no boxes. Each section is a 28 px header row (chevron, title,
 * count, and a summary on the right) over its body, separated from the next
 * by a 1 px divider. Secondary sections start collapsed and say what they
 * hold in the header. The look is in one place (`SECTION_LOOK`), from the
 * viewer's tokens only, so a host's theme decides the colours.
 *
 * Keyboard: a section header and an interface card are stops of one list
 * (`data-nav`); Arrow Up and Down move between them, Home and End go to the
 * first and the last, Enter and Space open and close (they are buttons).
 */
import { createContext, useCallback, useContext, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { Icon } from "../canvas/Icon";
import { cx } from "../ui/cx";

/** The sections' look, in one place: swap these to restyle them. */
export const SECTION_LOOK = {
  root: "uhd-sections font-ui text-fg",
  section: "uhd-section border-b border-line-subtle",
  header: "flex h-7 min-w-0 items-center gap-1.5 pr-3 pl-2.5",
  toggle:
    "group/sec -my-px flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-[3px] text-left outline-none focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-focus",
  chevron: "shrink-0 text-fg-muted transition-transform duration-100",
  title: "shrink-0 text-[11px] leading-none font-bold text-fg",
  count: "shrink-0 text-[11px] leading-none text-fg-faint tabular-nums",
  summary: "ml-auto min-w-0 shrink truncate text-right text-[11px] leading-none text-fg-muted",
  body: "px-3 pt-0.5 pb-2.5",
  /** A key and its value, as the Parameters rows. */
  kv: "flex min-h-[22px] items-baseline gap-2 py-[3px] text-[11px] leading-[1.35]",
  key: "w-[92px] shrink-0 truncate text-fg-faint",
  value: "min-w-0 flex-1 text-fg [overflow-wrap:anywhere]",
  /** A small heading inside a section (an expanded card's groups). */
  label: "text-[10px] leading-none text-fg-faint",
  /** A quiet text action at the right of a header ("Show all 21"). */
  aside: "ml-auto shrink-0 cursor-pointer text-[11px] leading-none text-fg-muted hover:text-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-focus",
} as const;

// ---- what stays open while the page is open

type Listener = () => void;

/**
 * Which sections are open and which interface cards are expanded, kept for
 * as long as the page lives (a tab's webview, the viewer's page): sections by
 * their id, cards per selection, so going back to a module shows it as it was.
 */
class KeptState {
  private sections = new Map<string, boolean>();
  private cards = new Map<string, ReadonlySet<string>>();
  private listeners = new Set<Listener>();
  private version = 0;
  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
  snapshot = () => this.version;
  private changed() {
    this.version++;
    for (const l of this.listeners) l();
  }
  section(id: string, fallback: boolean): boolean {
    return this.sections.get(id) ?? fallback;
  }
  setSection(id: string, open: boolean) {
    this.sections.set(id, open);
    this.changed();
  }
  expanded(selection: string): ReadonlySet<string> {
    return this.cards.get(selection) ?? EMPTY;
  }
  setExpanded(selection: string, ids: ReadonlySet<string>) {
    this.cards.set(selection, ids);
    this.changed();
  }
  /** For tests and a host that resets its page. */
  clear() {
    this.sections.clear();
    this.cards.clear();
    this.changed();
  }
}

const EMPTY: ReadonlySet<string> = new Set();

/** The page's kept state (one per page). */
export const keptInspectorState = new KeptState();

/** The selection the cards below belong to: their expanded set is kept under it. */
export const SelectionKey = createContext<string>("");

function useKept() {
  useSyncExternalStore(keptInspectorState.subscribe, keptInspectorState.snapshot, keptInspectorState.snapshot);
  return keptInspectorState;
}

/** Whether a section is open (kept while the page lives), and its setter. */
export function useSectionOpen(id: string, defaultOpen: boolean): [boolean, (open: boolean) => void] {
  const kept = useKept();
  return [kept.section(id, defaultOpen), useCallback((open: boolean) => kept.setSection(id, open), [kept, id])];
}

/** The interface cards expanded for the current selection, and a toggle. Several may be open at once. */
export function useExpandedCards(): [ReadonlySet<string>, (id: string) => void] {
  const kept = useKept();
  const selection = useContext(SelectionKey);
  const open = kept.expanded(selection);
  const toggle = useCallback(
    (id: string) => {
      const next = new Set(kept.expanded(selection));
      if (next.has(id)) next.delete(id);
      else next.add(id);
      kept.setExpanded(selection, next);
    },
    [kept, selection],
  );
  return [open, toggle];
}

// ---- keyboard: one list of stops

/** Where a key moves focus in a list of `count` stops from `index`; undefined: the key is not a move. */
export function navTarget(key: string, index: number, count: number): number | undefined {
  if (!count) return undefined;
  switch (key) {
    case "ArrowDown":
      return Math.min(count - 1, index + 1);
    case "ArrowUp":
      return Math.max(0, index - 1);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return undefined;
  }
}

/** Arrow keys on a stop (`data-nav`) move to the next one within the sections (`data-nav-root`). */
export function onNavKey(e: KeyboardEvent<HTMLElement>) {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const el = e.currentTarget;
  const root = el.closest("[data-nav-root]");
  if (!root) return;
  const stops = [...root.querySelectorAll<HTMLElement>("[data-nav]")].filter((s) => s.offsetParent !== null || s === el);
  const to = navTarget(e.key, stops.indexOf(el), stops.length);
  if (to === undefined) return;
  e.preventDefault();
  stops[to]?.focus();
}

// ---- the components

const Nested = createContext(false);

/**
 * The column the sections are in: its stops are one keyboard list. Inside
 * another (a host's inspector around the viewer's details) it is part of the
 * outer one, so the arrows go through both.
 */
export function Sections({ children, className, label }: { children?: ReactNode; className?: string; label?: string }) {
  const nested = useContext(Nested);
  if (nested) return <div className={cx(SECTION_LOOK.root, className)}>{children}</div>;
  return (
    <Nested.Provider value={true}>
      <div data-nav-root="" role="group" aria-label={label} className={cx(SECTION_LOOK.root, className)}>
        {children}
      </div>
    </Nested.Provider>
  );
}

export interface DetailsSectionProps {
  /** Kept open or closed by this id while the page lives. */
  id: string;
  title: string;
  count?: number;
  /** What it holds, said in the header (shown open or closed): "6 linked · 1 open", "DolphinRC · $69.99". */
  summary?: ReactNode;
  /** A text action at the header's right instead of the summary ("Show all 21"). */
  aside?: ReactNode;
  /** Open at first (secondary sections start closed). */
  defaultOpen?: boolean;
  children?: ReactNode;
  className?: string;
}

/** A section: its header row (a disclosure button) and its body. */
export function DetailsSection({ id, title, count, summary, aside, defaultOpen = true, children, className }: DetailsSectionProps) {
  const [open, setOpen] = useSectionOpen(id, defaultOpen);
  const body = useId();
  return (
    <section className={cx(SECTION_LOOK.section, className)} data-section={id}>
      <h3 className={cx(SECTION_LOOK.header, "m-0 font-normal")}>
        <button type="button" data-nav="" aria-expanded={open} aria-controls={body} onClick={() => setOpen(!open)} onKeyDown={onNavKey} className={SECTION_LOOK.toggle}>
          <Icon name="chevron-right" size={13} strokeWidth={1.75} aria-hidden className={cx(SECTION_LOOK.chevron, open && "rotate-90")} />
          <span className={SECTION_LOOK.title}>{title}</span>
          {count !== undefined && <span className={SECTION_LOOK.count}>{count}</span>}
          {summary !== undefined && summary !== null && summary !== "" && !(open && aside) && (
            <span className={SECTION_LOOK.summary} data-tooltip={typeof summary === "string" ? summary : undefined}>
              {summary}
            </span>
          )}
        </button>
        {open && aside}
      </h3>
      <div id={body} hidden={!open} className={SECTION_LOOK.body}>
        {open ? children : null}
      </div>
    </section>
  );
}

/** Rows of keys and values; past `limit` the rest wait behind "Show all N" (the header's aside, `ShowAll`). */
export function KeyValues({ rows, limit }: { rows: { key: string; value: ReactNode; title?: string }[]; limit?: number }) {
  const shown = limit !== undefined ? rows.slice(0, limit) : rows;
  return (
    <div>
      {shown.map((r, i) => (
        <div key={`${r.key}-${i}`} className={SECTION_LOOK.kv}>
          <span className={SECTION_LOOK.key} data-tooltip={r.key.length > 14 ? r.key : undefined}>
            {r.key}
          </span>
          <span className={SECTION_LOOK.value} data-tooltip={r.title}>
            {r.value}
          </span>
        </div>
      ))}
    </div>
  );
}

/** How many rows of a long list are shown at first, and how many more each "Show more" adds (PB-1088). */
export const LIST_STEP = 10;

const MORE_LOOK = {
  row: "flex min-h-6 items-center gap-3 pt-1",
  button: "inline-flex h-6 cursor-pointer items-center gap-1 rounded-[3px] px-1 -mx-1 text-[11px] leading-none text-fg-muted hover:text-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-focus",
} as const;

/**
 * A long list shown `step` rows at a time (PB-1088): "Show 10 more" under the
 * rows adds the next ones, "Show fewer" goes back to the first `step`.
 * `keep`: rows that must stay shown (an expanded card), counted from the top.
 */
export function useLoadMore(total: number, step: number = LIST_STEP, keep = 0): { limit: number; footer: ReactNode } {
  const [shown, setShown] = useState(step);
  const limit = Math.min(total, Math.max(shown, keep));
  if (total <= step) return { limit: total, footer: null };
  const next = Math.min(step, total - limit);
  return {
    limit,
    footer: (
      <div className={MORE_LOOK.row} data-load-more="">
        {next > 0 && (
          <button type="button" data-nav="" onKeyDown={onNavKey} className={MORE_LOOK.button} onClick={() => setShown(limit + next)}>
            <Icon name="chevron-down" size={12} strokeWidth={1.75} aria-hidden className="shrink-0" />
            Show {next} more
          </button>
        )}
        {limit > step && (
          <button type="button" data-nav="" onKeyDown={onNavKey} className={cx(MORE_LOOK.button, next > 0 && "ml-auto")} onClick={() => setShown(step)}>
            <Icon name="chevron-up" size={12} strokeWidth={1.75} aria-hidden className="shrink-0" />
            Show fewer
          </button>
        )}
      </div>
    ),
  };
}

/**
 * A long free text (a module's description) cut to `lines` lines, with "More"
 * to read it all and "Less" to cut it again (PB-1088). The toggle shows only
 * when the text is cut.
 */
export function ClampedText({ text, lines = 5, className }: { text: string; lines?: number; className?: string }) {
  const [open, setOpen] = useState(false);
  // before it is laid out (and where it never is: a server render), a long text is taken as cut
  const [cut, setCut] = useState(() => text.length > lines * 60);
  const ref = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const measure = () => {
      // laid out: cut when the text is taller than its box; not laid out (a test, a hidden page): by its length
      setCut(el.clientHeight > 0 ? el.scrollHeight > el.clientHeight + 1 : text.length > lines * 60);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, lines, open]);
  const id = useId();
  return (
    <div className="pb-1.5">
      <p ref={ref} id={id} data-clamped={!open && cut ? "" : undefined} className={cx("m-0 [overflow-wrap:anywhere] whitespace-pre-line", className)} style={open ? undefined : { display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: lines, overflow: "hidden" }}>
        {text}
      </p>
      {(cut || open) && (
        <button type="button" aria-expanded={open} aria-controls={id} className={cx(MORE_LOOK.button, "mt-0.5")} onClick={() => setOpen(!open)}>
          <Icon name={open ? "chevron-up" : "chevron-down"} size={12} strokeWidth={1.75} aria-hidden className="shrink-0" />
          {open ? "Less" : "More"}
        </button>
      )}
    </div>
  );
}

/** A section's rows shown in part, and the header action that shows them all. Lists use `useLoadMore` (PB-1088). */
export function useShowAll(total: number, limit: number): { limit: number | undefined; aside: ReactNode } {
  const [all, setAll] = useState(false);
  if (total <= limit) return { limit: undefined, aside: null };
  return {
    limit: all ? undefined : limit,
    aside: (
      <button type="button" className={SECTION_LOOK.aside} onClick={() => setAll(!all)}>
        {all ? "Show fewer" : `Show all ${total}`}
      </button>
    ),
  };
}
