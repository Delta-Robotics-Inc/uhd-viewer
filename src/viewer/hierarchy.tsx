/**
 * The hierarchy panel (PB-1042): the module tree of the viewer's system,
 * docked at the left of the view, beside the canvas. It belongs to one viewer
 * (one tab) and follows it: a click on a row selects the module on the level
 * that holds it, a double-click (or Enter on the selected row) drills into it,
 * a selection on the canvas opens and highlights its row, and the level the
 * diagram shows is marked. It folds to a thin rail, is resized by its edge,
 * filters as you type, and is a tree to the keyboard and to screen readers.
 *
 * Its look is the viewer's tokens only (a floating card: radius, border,
 * shadow, faces of the theme), so a host's theme decides it. What a host keeps
 * per tab (open, width, open rows) comes in as `state` and goes out through
 * `onStateChange`.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Icon } from "../canvas/Icon";
import { NodeMenu, type NodeMenuItem } from "../chrome/Chrome";
import { isPlaceholder } from "../source/tolerant";
import { ScrollArea } from "../ui/ScrollArea";
import { IconButton } from "../ui/Toolbar";
import { cx } from "../ui/cx";
import {
  KIND_LABEL,
  buildHierarchy,
  clampWidth,
  drillInto,
  filterHierarchy,
  hierarchyIndex,
  panelState,
  revealPaths,
  rowTarget,
  selectedPath,
  treeKey,
  visibleRows,
  HIERARCHY_WIDTH,
  type HierarchyNode,
  type HierarchyPanelState,
  type HierarchyRow,
} from "../model/hierarchy";
import { fullId } from "../host/targets";
import { useViewer } from "./controller";

/** What a host asks of the panel: show a module's row, put the keyboard in the filter, open or fold it. */
export interface HierarchyCommand {
  type: "reveal" | "filter" | "open" | "close" | "toggle";
  /** For `reveal`: the module's instance path. */
  path?: string;
  /** A new number for every command (the same command twice is two). */
  seq: number;
}

export interface ViewerHierarchyProps {
  /** What the host kept for this tab (`onStateChange` gave it); anything malformed is ignored. */
  state?: unknown;
  /** The panel's state changed (open, width, open rows): a host keeps it per tab. */
  onStateChange?: (state: HierarchyPanelState) => void;
  command?: HierarchyCommand;
  /** Attributes a host puts on every row (`data-*`), e.g. for its own context menu. */
  rowAttributes?: (node: HierarchyNode) => Record<`data-${string}`, string>;
  /** Show the panel's own context menu (default). A host with a menu of its own passes false: a right-click then only selects the row. */
  ownMenu?: boolean;
  /** Below this width of the window the panel starts folded when nothing was kept (default 640). */
  narrow?: number;
  className?: string;
}

/** The folded panel's width. */
export const RAIL_WIDTH = 36;

const ROW_INDENT = 12;

const SEVERITY_TEXT = { error: "text-error", warning: "text-warning", info: "text-info" } as const;

/** Text a row says to a screen reader after its name: kind, quantity, status, findings. */
function describe(n: HierarchyNode): string {
  const own = n.findings.error + n.findings.warning;
  return [
    n.defName ?? "",
    KIND_LABEL[n.kind],
    n.quantity ? `${n.quantity} units` : "",
    n.mark?.label ?? "",
    n.missing ? "not in the bundle" : "",
    own ? `${n.findings.error} errors, ${n.findings.warning} warnings` : n.worst && n.worst !== "info" ? `findings below (${n.worst})` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

function useKept(given: unknown, narrow: number): [HierarchyPanelState, (patch: Partial<HierarchyPanelState>) => void] {
  const [state, setState] = useState<HierarchyPanelState>(() => panelState(given, typeof window === "undefined" || window.innerWidth >= narrow));
  const set = useCallback((patch: Partial<HierarchyPanelState>) => setState((s) => ({ ...s, ...patch })), []);
  return [state, set];
}

/** The panel, docked at the left of the view (render it first inside the shell's workspace row). */
export function ViewerHierarchy({ state: given, onStateChange, command, rowAttributes, ownMenu = true, narrow = 640, className }: ViewerHierarchyProps) {
  const c = useViewer();
  const [kept, setKept] = useKept(given, narrow);
  const expanded = useMemo(() => new Set(kept.expanded), [kept.expanded]);
  const setExpanded = useCallback((next: ReadonlySet<string>) => setKept({ expanded: [...next] }), [setKept]);

  // the host keeps what changed, once things settle (not on every pixel of a resize)
  const handler = useRef(onStateChange);
  handler.current = onStateChange;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => handler.current?.(kept), 200);
    return () => clearTimeout(t);
  }, [kept]);

  const tree = useMemo(
    () =>
      buildHierarchy(c.system, c.scenario.lookup, {
        marks: c.options.nodeMarks,
        diagnostics: c.diagnostics,
        hostDiagnostics: c.hostDiagnostics,
        isMissing: isPlaceholder,
      }),
    [c.system, c.scenario, c.options.nodeMarks, c.diagnostics, c.hostDiagnostics],
  );
  const index = useMemo(() => hierarchyIndex(tree), [tree]);
  const [filter, setFilter] = useState("");
  const filtered = useMemo(() => filterHierarchy(tree, filter), [tree, filter]);
  // rows the filter opens, less those closed while it stays
  const [shut, setShut] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => setShut(new Set()), [filter]);
  const open = useMemo(() => (filter.trim() ? new Set([...expanded, ...[...filtered.expanded].filter((p) => !shut.has(p))]) : expanded), [expanded, filter, filtered, shut]);
  const rows = useMemo(() => visibleRows(filtered.nodes, open), [filtered, open]);

  const level = c.drill.join("/");
  const selected = selectedPath(c.drill, c.selection);
  const [focus, setFocus] = useState<string>(selected ?? level);
  const treeRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const rowEl = (path: string) => treeRef.current?.querySelector<HTMLElement>(`[data-hierarchy-path="${CSS.escape(path)}"]`) ?? null;

  // the canvas's selection and level show in the tree: their rows open, highlighted and scrolled to
  const pendingScroll = useRef<string | null>(null);
  useEffect(() => {
    const target = selected ?? level;
    const withLevel = revealPaths(revealPaths(expanded, target), level || undefined);
    const next = level !== "" && index.get(level)?.drillable && !withLevel.has(level) ? new Set([...withLevel, level]) : withLevel;
    if (next !== expanded) setExpanded(next);
    setFocus(target);
    pendingScroll.current = target;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, level]);
  useLayoutEffect(() => {
    const p = pendingScroll.current;
    if (p === null) return;
    const el = rowEl(p);
    if (el) {
      el.scrollIntoView({ block: "nearest" });
      pendingScroll.current = null;
    }
  });

  // what the host asks
  const lastCommand = useRef(0);
  useEffect(() => {
    if (!command || command.seq === lastCommand.current) return;
    lastCommand.current = command.seq;
    if (command.type === "open") setKept({ open: true });
    else if (command.type === "close") setKept({ open: false });
    else if (command.type === "toggle") setKept({ open: !kept.open });
    else if (command.type === "filter") {
      setKept({ open: true });
      requestAnimationFrame(() => filterRef.current?.focus());
    } else if (command.type === "reveal" && command.path !== undefined) {
      setKept({ open: true, expanded: [...revealPaths(expanded, command.path)] });
      setFilter("");
      setFocus(command.path);
      pendingScroll.current = command.path;
      requestAnimationFrame(() => rowEl(command.path!)?.focus({ preventScroll: true }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command]);

  const inPlace = useMemo(() => new Set(c.vm.nodes.filter((n) => n.expanded).map((n) => n.id)), [c.vm]);
  const select = useCallback(
    (path: string) => {
      setFocus(path);
      c.onGoto(rowTarget(c.system, c.scenario.lookup, path, { drill: c.drill, expanded: inPlace }));
    },
    [c, inPlace],
  );
  const drill = useCallback(
    (node: HierarchyNode) => {
      setFocus(node.path);
      if (node.drillable) c.onGoto(drillInto(node));
      else select(node.path);
    },
    [c, select],
  );
  const toggle = useCallback(
    (path: string) => {
      const next = new Set(expanded);
      if (open.has(path)) {
        next.delete(path);
        // a row the filter opened closes like any other, for as long as the filter stays
        if (filtered.expanded.has(path)) setShut((s) => new Set(s).add(path));
      } else {
        next.add(path);
        setShut((s) => (s.has(path) ? new Set([...s].filter((p) => p !== path)) : s));
      }
      setExpanded(next);
    },
    [expanded, open, filtered, setExpanded],
  );

  const onTreeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const r = treeKey(rows, focus, e.key, open, selected);
    if (r) {
      e.preventDefault();
      e.stopPropagation();
      // what the key opened or closed, applied to the rows the user keeps open (the filter's open ones are its own)
      const added = [...r.expanded].filter((p) => !open.has(p));
      const removed = [...open].filter((p) => !r.expanded.has(p));
      if (added.length || removed.length) setExpanded(new Set([...expanded, ...added].filter((p) => !removed.includes(p))));
      if (removed.some((p) => filtered.expanded.has(p))) setShut((s) => new Set([...s, ...removed]));
      setFocus(r.focus);
      requestAnimationFrame(() => {
        const el = rowEl(r.focus);
        el?.focus({ preventScroll: true });
        el?.scrollIntoView({ block: "nearest" });
      });
      const node = index.get(r.focus);
      if (r.action === "select" && node) select(node.path);
      if (r.action === "drill" && node) drill(node);
      return;
    }
    // type to filter: a printable key goes to the filter
    if (e.key.length === 1 && e.key !== " ") {
      e.preventDefault();
      e.stopPropagation();
      setFilter((f) => f + e.key);
      filterRef.current?.focus();
    } else if (e.key === "Escape" && filter) {
      e.preventDefault();
      e.stopPropagation();
      setFilter("");
    }
  };

  const onFilterKey = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      if (filter) setFilter("");
      else focusTree();
    } else if (e.key === "ArrowDown" || e.key === "Enter") {
      e.preventDefault();
      const target = rows.find((r) => filtered.matches.has(r.node.path)) ?? rows[0];
      if (!target) return;
      setFocus(target.node.path);
      requestAnimationFrame(() => rowEl(target.node.path)?.focus());
      if (e.key === "Enter") select(target.node.path);
    }
  };
  const focusTree = () => {
    const path = rows.some((r) => r.node.path === focus) ? focus : rows[0]?.node.path;
    if (path !== undefined) requestAnimationFrame(() => rowEl(path)?.focus());
  };

  // the panel's own menu (a host with a menu of its own reads the rows' attributes instead)
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const menuNode = menu ? index.get(menu.path) : undefined;
  const menuItems: NodeMenuItem[] = [];
  if (menuNode) {
    const node = menuNode;
    menuItems.push({ label: "SELECT", run: () => select(node.path) });
    if (node.drillable) menuItems.push({ label: "OPEN AS CANVAS", run: () => drill(node) });
    if (node.drillable && node.path && c.hostActions.openModule) menuItems.push({ label: "OPEN IN NEW TAB", run: () => c.hostActions.openModule!(node.path) });
    if (c.hostActions.openSource) menuItems.push({ label: "OPEN SOURCE", run: () => c.hostActions.openSource!(node.defId, node.path || undefined) });
    if (node.path && c.hostActions.inspect) menuItems.push({ label: "INSPECT", run: () => c.hostActions.inspect!(node.path, node.defId) });
    if (node.children.length) {
      const below = [...hierarchyIndex([node]).values()].filter((n) => n.children.length).map((n) => n.path);
      const allOpen = below.every((p) => expanded.has(p));
      menuItems.push(
        allOpen
          ? { label: "COLLAPSE ALL BELOW", run: () => setExpanded(new Set([...expanded].filter((p) => !below.includes(p)))) }
          : { label: "EXPAND ALL BELOW", run: () => setExpanded(new Set([...expanded, ...below])) },
      );
    }
    if (typeof navigator !== "undefined" && navigator.clipboard) menuItems.push({ label: "COPY PATH", run: () => void navigator.clipboard.writeText(node.path || node.defId).catch(() => undefined) });
  }
  const onRowContext = (e: React.MouseEvent, node: HierarchyNode) => {
    // the row the menu is about is selected first, so the menu acts on what is shown
    setFocus(node.path);
    if (selected !== node.path) select(node.path);
    if (!ownMenu) return;
    e.preventDefault();
    setMenu({ path: node.path, x: e.clientX, y: e.clientY });
  };

  // resizing by the edge: a drag, or the arrow keys on the handle
  const dock = useRef<HTMLDivElement>(null);
  const room = () => Math.max(HIERARCHY_WIDTH.min, (dock.current?.parentElement?.clientWidth ?? window.innerWidth) * 0.6);
  const onResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = kept.width;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setKept({ width: clampWidth(w0 + ev.clientX - x0, room()) });
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  const onResizeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      setKept({ width: clampWidth(kept.width + (e.key === "ArrowRight" ? step : -step), room()) });
    } else if (e.key === "Home") {
      e.preventDefault();
      setKept({ width: HIERARCHY_WIDTH.default });
    }
  };

  const count = index.size;
  const rootLabel = tree[0]?.label ?? "System";

  if (!kept.open) {
    return (
      <div ref={dock} className={cx("uhd-hierarchy-dock relative z-30 flex shrink-0 flex-col pt-[calc(var(--uhd-inset-top,0px)+4px)] pb-1 pl-1", className)} style={{ width: RAIL_WIDTH + 4 }} data-hierarchy="folded">
        <div className="flex min-h-0 flex-1 flex-col items-center gap-1 rounded-panel border border-line bg-surface py-1 shadow-panel outline outline-1 -outline-offset-1 outline-contrast">
          <IconButton icon="panel-left-open" size="sm" label="Show the hierarchy" tooltipSide="right" aria-expanded={false} aria-controls="uhd-hierarchy" onClick={() => setKept({ open: true })} />
          <button
            type="button"
            onClick={() => setKept({ open: true })}
            className="mt-1 cursor-pointer border-0 bg-transparent p-0 font-label text-[10px] tracking-[0.12em] text-fg-muted uppercase [writing-mode:vertical-rl] hover:text-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-focus"
            tabIndex={-1}
            aria-hidden
          >
            Hierarchy
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={dock}
      className={cx("uhd-hierarchy-dock relative z-30 flex shrink-0 flex-col pt-[calc(var(--uhd-inset-top,0px)+4px)] pb-1 pl-1", className)}
      style={{ width: kept.width + 4 } as CSSProperties}
      data-hierarchy="open"
    >
      <section
        id="uhd-hierarchy"
        aria-label="Hierarchy"
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-panel border border-line bg-surface font-ui text-fg shadow-panel outline outline-1 -outline-offset-1 outline-contrast"
      >
        <header className="flex h-9 shrink-0 items-center gap-1 border-b border-line pr-1 pl-2.5">
          <Icon name="list-tree" size={14} strokeWidth={1.75} className="shrink-0 text-fg-muted" aria-hidden />
          <span className="min-w-0 flex-1 truncate font-label text-[11px] tracking-[0.08em] text-fg uppercase">
            Hierarchy<span className="text-fg-faint"> · {count}</span>
          </span>
          <IconButton icon="chevrons-down-up" size="sm" label="Collapse all" onClick={() => setExpanded(new Set([""]))} />
          <IconButton icon="panel-left-close" size="sm" label="Fold the hierarchy" aria-expanded aria-controls="uhd-hierarchy" onClick={() => setKept({ open: false })} />
        </header>
        <div className="shrink-0 border-b border-line-subtle px-1.5 py-1.5">
          <label className="flex h-7 items-center gap-1.5 rounded-md border border-line bg-sunken px-2 focus-within:outline focus-within:outline-1 focus-within:-outline-offset-1 focus-within:outline-focus">
            <Icon name="search" size={12} strokeWidth={1.75} className="shrink-0 text-fg-faint" aria-hidden />
            <input
              ref={filterRef}
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={onFilterKey}
              placeholder="Filter"
              aria-label="Filter the hierarchy"
              aria-controls="uhd-hierarchy-tree"
              spellCheck={false}
              className="min-w-0 flex-1 border-0 bg-transparent p-0 font-ui text-[12px] text-fg outline-none placeholder:text-fg-faint"
            />
            {filter && (
              <button type="button" aria-label="Clear the filter" data-tooltip="Clear the filter" onClick={() => (setFilter(""), filterRef.current?.focus())} className="grid size-5 cursor-pointer place-items-center rounded border-0 bg-transparent p-0 text-fg-muted hover:bg-hover hover:text-fg">
                <Icon name="x" size={12} aria-hidden />
              </button>
            )}
          </label>
        </div>
        <ScrollArea className="min-h-0 flex-1" axis="vertical">
          <div
            ref={treeRef}
            id="uhd-hierarchy-tree"
            role="tree"
            aria-label={`Hierarchy of ${rootLabel}`}
            onKeyDown={onTreeKey}
            className="py-1"
          >
            {rows.map((r) => (
              <Row
                key={r.node.path}
                row={r}
                focus={focus === r.node.path}
                selected={selected === r.node.path}
                current={level === r.node.path}
                match={filtered.matches.has(r.node.path)}
                attributes={rowAttributes?.(r.node)}
                onSelect={select}
                onDrill={drill}
                onToggle={toggle}
                onContext={onRowContext}
              />
            ))}
            {!rows.length && (
              <p role="status" className="m-0 px-3 py-2 text-[12px] text-fg-muted">
                Nothing matches “{filter}”.
              </p>
            )}
          </div>
        </ScrollArea>
        {selected !== undefined && (
          <footer className="flex h-7 shrink-0 items-center gap-1.5 border-t border-line-subtle px-2.5 font-code text-[10.5px] text-fg-faint" aria-live="polite">
            <span className="min-w-0 truncate" title={fullId([], selected)}>
              {selected || "(root)"}
            </span>
          </footer>
        )}
      </section>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the hierarchy"
        aria-valuemin={HIERARCHY_WIDTH.min}
        aria-valuemax={HIERARCHY_WIDTH.max}
        aria-valuenow={kept.width}
        aria-controls="uhd-hierarchy"
        tabIndex={0}
        onPointerDown={onResizeStart}
        onKeyDown={onResizeKey}
        onDoubleClick={() => setKept({ width: HIERARCHY_WIDTH.default })}
        className="group absolute top-[calc(var(--uhd-inset-top,0px)+12px)] -right-1 bottom-2 z-10 w-2 cursor-col-resize touch-none focus-visible:outline-none"
      >
        <span aria-hidden className="absolute inset-y-0 left-[3px] w-0.5 rounded-full bg-transparent transition-colors group-hover:bg-focus group-focus-visible:bg-focus group-active:bg-focus" />
      </div>
      {menuNode && ownMenu && <NodeMenu x={menu!.x} y={menu!.y} items={menuItems} onClose={closeMenu} />}
    </div>
  );
}

interface RowProps {
  row: HierarchyRow;
  focus: boolean;
  selected: boolean;
  current: boolean;
  match: boolean;
  attributes?: Record<string, string>;
  onSelect: (path: string) => void;
  onDrill: (node: HierarchyNode) => void;
  onToggle: (path: string) => void;
  onContext: (e: React.MouseEvent, node: HierarchyNode) => void;
}

const Row = memo(function Row({ row, focus, selected, current, match, attributes, onSelect, onDrill, onToggle, onContext }: RowProps) {
  const n = row.node;
  const own = n.findings.error + n.findings.warning;
  const tone = n.worst && n.worst !== "info" ? SEVERITY_TEXT[n.worst] : undefined;
  const desc = describe(n);
  return (
    <div
      role="treeitem"
      aria-level={row.level}
      aria-setsize={row.size}
      aria-posinset={row.pos}
      aria-expanded={row.branch ? row.open : undefined}
      aria-selected={selected}
      aria-current={current ? "location" : undefined}
      aria-label={n.label}
      aria-description={desc || undefined}
      tabIndex={focus ? 0 : -1}
      data-hierarchy-path={n.path}
      data-kind={n.kind}
      {...attributes}
      onClick={() => onSelect(n.path)}
      onDoubleClick={() => onDrill(n)}
      onContextMenu={(e) => onContext(e, n)}
      className={cx(
        "uhd-tree-row group relative mx-1 flex h-[26px] cursor-pointer items-center gap-1.5 rounded-md pr-1.5 text-[12px] leading-none outline-none select-none",
        selected ? "bg-accent-tint text-fg outline outline-1 -outline-offset-1 outline-contrast-active" : "text-fg-muted hover:bg-hover hover:text-fg",
        "focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-focus",
        match && "text-fg",
        n.missing && "italic",
      )}
      style={{ paddingLeft: 4 + (row.level - 1) * ROW_INDENT }}
    >
      {current && <span aria-hidden className="absolute top-1 bottom-1 left-0 w-0.5 rounded-full bg-accent" />}
      <span
        aria-hidden
        onClick={(e) => {
          if (!row.branch) return;
          e.stopPropagation();
          onToggle(n.path);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        className={cx("grid size-4 shrink-0 place-items-center rounded text-fg-faint", row.branch && "hover:bg-hover hover:text-fg")}
      >
        {row.branch && <Icon name="chevron-right" size={12} strokeWidth={2} className={cx("transition-transform duration-100", row.open && "rotate-90")} />}
      </span>
      <Icon name={n.icon} size={14} strokeWidth={1.75} className={cx("shrink-0", tone ?? (selected || current ? "text-accent" : undefined))} aria-hidden />
      <span className={cx("min-w-0 flex-1 truncate", (selected || current) && "text-fg")} data-tooltip={desc ? `${n.label} · ${desc}` : n.label} data-tooltip-side="right">
        {n.label}
      </span>
      {n.quantity && <span className="shrink-0 font-code text-[10.5px] text-fg-faint">×{n.quantity}</span>}
      {own > 0 ? (
        <span aria-hidden className={cx("shrink-0 rounded px-1 font-code text-[10px] leading-[14px]", n.findings.error ? "bg-error/15 text-error" : "bg-warning/15 text-warning")}>
          {Math.min(own, 99)}
        </span>
      ) : n.worst && n.worst !== "info" ? (
        <span aria-hidden className={cx("size-1.5 shrink-0 rounded-full", n.worst === "error" ? "bg-error" : "bg-warning")} />
      ) : null}
      {n.mark && <span aria-hidden className="uhd-tree-mark shrink-0" data-tone={n.mark.tone} data-shape={n.mark.shape === "ring" ? "ring" : undefined} />}
    </div>
  );
});
