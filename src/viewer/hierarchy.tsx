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
  groupWiring,
  markLegend,
  hierarchyIndex,
  panelState,
  revealPaths,
  selectedPath,
  treeKey,
  visibleRows,
  HIERARCHY_WIDTH,
  WIRING_PATH,
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
  /** The panel opened or folded (at once; a host's toggle button shows it). */
  onOpenChange?: (open: boolean) => void;
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

/**
 * The panel's look, in one place (PB-1042; the Pencil iterations, 2026-10-21):
 * docked flush at the left of the canvas, below the floating header, with a
 * border at its edge; rows highlighted in the theme's selection colour. Only
 * the viewer's tokens, so a host's theme decides the colours (orange only
 * under the Protoboard theme). Swap these to restyle it.
 */
export const HIERARCHY_LOOK = {
  dock: "uhd-hierarchy-dock absolute inset-y-0 left-0 z-30 flex flex-col pt-[var(--uhd-inset-top,0px)]",
  panel: "relative flex min-h-0 flex-1 flex-col overflow-hidden border-t border-r border-line bg-surface font-ui text-fg",
  rail: "flex min-h-0 flex-1 flex-col items-center gap-1 border-t border-r border-line bg-surface py-1",
  header: "flex h-8 shrink-0 items-center gap-0.5 pr-1 pl-3",
  title: "min-w-0 flex-1 truncate font-label text-[11px] tracking-[0.08em] text-fg-muted uppercase",
  filterBox: "mx-2 mb-1.5 flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line bg-sunken px-2 focus-within:outline focus-within:outline-1 focus-within:-outline-offset-1 focus-within:outline-focus",
  row: "uhd-tree-row group relative flex h-[26px] cursor-pointer items-center gap-1.5 pr-3 text-[12.5px] leading-none outline-none select-none",
  rowSelected: "bg-selection text-selection-fg outline outline-1 -outline-offset-1 outline-focus",
  rowIdle: "text-fg hover:bg-hover",
  /** Filtering: a row that only leads to what matches. */
  rowDim: "text-fg-faint hover:bg-hover hover:text-fg",
  rowFocus: "focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-focus",
  groupRow: "mt-1 border-t border-line-subtle text-fg-muted",
  badge: "shrink-0 rounded border border-line px-1.5 font-code text-[10px] leading-[16px] text-fg-muted",
  legend: "flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line-subtle px-3 py-1.5 text-[10.5px] text-fg-muted",
} as const;

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

/** The panel, docked at the left of the view: render it beside the shell's `.workspace` (its sibling, before it), which then starts after it. */
export function ViewerHierarchy({ state: given, onStateChange, onOpenChange, command, rowAttributes, ownMenu = true, narrow = 640, className }: ViewerHierarchyProps) {
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
  const openHandler = useRef(onOpenChange);
  openHandler.current = onOpenChange;
  useEffect(() => openHandler.current?.(kept.open), [kept.open]);

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
  // the structure first; harnesses, cables and fastener stacks folded into one group at the bottom
  const shown = useMemo(() => groupWiring(tree), [tree]);
  const index = useMemo(() => hierarchyIndex(shown), [shown]);
  const wiring = useMemo(() => new Set(index.get(WIRING_PATH)?.children.map((n) => n.path) ?? []), [index]);
  const legend = useMemo(() => markLegend(tree), [tree]);
  const [filter, setFilter] = useState("");
  const filtered = useMemo(() => filterHierarchy(shown, filter), [shown, filter]);
  // rows the filter opens, less those closed while it stays
  const [shut, setShut] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => setShut(new Set()), [filter]);
  const open = useMemo(() => (filter.trim() ? new Set([...expanded, ...[...filtered.expanded].filter((p) => !shut.has(p))]) : expanded), [expanded, filter, filtered, shut]);
  const rows = useMemo(() => visibleRows(filtered.nodes, open), [filtered, open]);

  const level = c.drill.join("/");
  // the selection of the view on screen: the diagram's, or the 3D view's (a body, a part on a board)
  const selected = c.view === "3d" ? (c.cadSelection?.kind === "node" && !c.cadSelection.id.includes("#") ? c.cadSelection.id : undefined) : selectedPath(c.drill, c.selection);
  // modules selected together on the diagram (a box, Shift-click): every row of them is highlighted
  const together = useMemo(() => new Set(c.view === "3d" ? [] : c.group.map((g) => fullId(c.drill, g))), [c.view, c.group, c.drill]);
  const [focus, setFocus] = useState<string>(selected ?? level);
  const treeRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  /** The rows to open so that `path` shows: its modules, and the wiring group for a harness. */
  const reveal = (set: ReadonlySet<string>, path: string | undefined) => {
    const next = revealPaths(set, path);
    return path !== undefined && wiring.has(path) && !next.has(WIRING_PATH) ? new Set([...next, WIRING_PATH]) : next;
  };
  const rowEl = (path: string) => treeRef.current?.querySelector<HTMLElement>(`[data-hierarchy-path="${CSS.escape(path)}"]`) ?? null;

  // the canvas's selection and level show in the tree: their rows open, highlighted and scrolled to
  const pendingScroll = useRef<string | null>(null);
  useEffect(() => {
    const target = selected ?? level;
    const withLevel = revealPaths(reveal(expanded, target), level || undefined);
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
      setKept({ open: true, expanded: [...reveal(expanded, command.path)] });
      setFilter("");
      setFocus(command.path);
      pendingScroll.current = command.path;
      requestAnimationFrame(() => rowEl(command.path!)?.focus({ preventScroll: true }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command]);

  const select = useCallback(
    (path: string) => {
      setFocus(path);
      if (path === WIRING_PATH) return toggleRef.current(path);
      c.focusPath(path);
    },
    [c],
  );
  const drill = useCallback(
    (node: HierarchyNode) => {
      setFocus(node.path);
      if (node.drillable) c.onGoto(drillInto(node));
      else select(node.path);
    },
    [c, select],
  );
  const toggleRef = useRef<(path: string) => void>(() => undefined);
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
  toggleRef.current = toggle;

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
  if (menuNode && !menuNode.group) {
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
    if (node.group) return e.preventDefault();
    // the row the menu is about is selected first, so the menu acts on what is shown
    setFocus(node.path);
    if (selected !== node.path) select(node.path);
    if (!ownMenu) return;
    e.preventDefault();
    setMenu({ path: node.path, x: e.clientX, y: e.clientY });
  };

  // resizing by the edge: a drag, or the arrow keys on the handle
  const dock = useRef<HTMLDivElement>(null);
  // the workspace beside it starts after it (`.workspace` reads the width: app.css)
  const docked = kept.open ? kept.width : RAIL_WIDTH;
  useLayoutEffect(() => {
    const parent = dock.current?.parentElement;
    if (!parent) return;
    parent.style.setProperty("--uhd-dock-left", `${docked}px`);
    return () => void parent.style.removeProperty("--uhd-dock-left");
  }, [docked]);
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

  const count = hierarchyIndex(tree).size;
  const rootLabel = tree[0]?.label ?? "System";
  const L = HIERARCHY_LOOK;

  if (!kept.open) {
    return (
      <div ref={dock} className={cx(L.dock, className)} style={{ width: RAIL_WIDTH }} data-hierarchy="folded">
        <div className={L.rail}>
          <IconButton icon="panel-left-open" size="sm" label="Show the hierarchy" tooltipSide="right" aria-expanded={false} aria-controls="uhd-hierarchy" onClick={() => setKept({ open: true })} />
          <button
            type="button"
            onClick={() => setKept({ open: true })}
            className="mt-1 cursor-pointer border-0 bg-transparent p-0 font-label text-[10px] tracking-[0.12em] text-fg-muted uppercase [writing-mode:vertical-rl] hover:text-fg"
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
    <div ref={dock} className={cx(L.dock, className)} style={{ width: kept.width } as CSSProperties} data-hierarchy="open">
      <section id="uhd-hierarchy" aria-label="Hierarchy" className={L.panel}>
        <header className={L.header}>
          <span className={L.title}>
            Hierarchy<span className="text-fg-faint"> · {count}</span>
          </span>
          <IconButton icon="list-filter" size="sm" label="Filter modules" pressed={Boolean(filter)} onClick={() => filterRef.current?.focus()} />
          <IconButton icon="chevrons-down-up" size="sm" label="Collapse all" onClick={() => setExpanded(new Set([""]))} />
          <IconButton icon="panel-left-close" size="sm" label="Fold the hierarchy" aria-expanded aria-controls="uhd-hierarchy" onClick={() => setKept({ open: false })} />
        </header>
        <label className={L.filterBox}>
          <Icon name="search" size={12} strokeWidth={1.75} className="shrink-0 text-fg-faint" aria-hidden />
          <input
            ref={filterRef}
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={onFilterKey}
            placeholder="Filter modules"
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
        <ScrollArea className="min-h-0 flex-1" axis="vertical">
          <div ref={treeRef} id="uhd-hierarchy-tree" role="tree" aria-label={`Hierarchy of ${rootLabel}`} onKeyDown={onTreeKey} className="pb-1">
            {rows.map((r) => (
              <Row
                key={r.node.path}
                row={r}
                focus={focus === r.node.path}
                selected={selected === r.node.path || together.has(r.node.path)}
                current={level === r.node.path}
                match={filtered.matches.has(r.node.path)}
                dim={filtered.matches.size > 0 && !filtered.matches.has(r.node.path) && !r.node.group}
                attributes={r.node.group ? undefined : rowAttributes?.(r.node)}
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
        {legend.length > 0 && (
          <footer className={L.legend} aria-label="Part status">
            {legend.map((l) => (
              <span key={l.tone} className="flex items-center gap-1.5">
                <span aria-hidden className="uhd-tree-mark" data-tone={l.tone} />
                {l.label}
              </span>
            ))}
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
        className="group absolute top-[var(--uhd-inset-top,0px)] -right-1 bottom-0 z-10 w-2 cursor-col-resize touch-none focus-visible:outline-none"
      >
        <span aria-hidden className="absolute inset-y-0 left-[3px] w-0.5 bg-transparent transition-colors group-hover:bg-focus group-focus-visible:bg-focus group-active:bg-focus" />
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
  /** Filtering, and this row only leads to what matches. */
  dim?: boolean;
  attributes?: Record<string, string>;
  onSelect: (path: string) => void;
  onDrill: (node: HierarchyNode) => void;
  onToggle: (path: string) => void;
  onContext: (e: React.MouseEvent, node: HierarchyNode) => void;
}

const Row = memo(function Row({ row, focus, selected, current, match, dim, attributes, onSelect, onDrill, onToggle, onContext }: RowProps) {
  const n = row.node;
  const L = HIERARCHY_LOOK;
  const own = n.findings.error + n.findings.warning;
  const tone = n.worst && n.worst !== "info" ? SEVERITY_TEXT[n.worst] : undefined;
  const desc = n.group ? `${n.children.length} harnesses, cables and fastener stacks` : [describe(n), n.where ? `in ${n.where}` : ""].filter(Boolean).join(", ");
  return (
    <div
      role="treeitem"
      aria-level={row.level}
      aria-setsize={row.size}
      aria-posinset={row.pos}
      aria-expanded={row.branch ? row.open : undefined}
      aria-selected={n.group ? undefined : selected}
      aria-current={current ? "location" : undefined}
      aria-label={n.label}
      aria-description={desc || undefined}
      tabIndex={focus ? 0 : -1}
      data-hierarchy-path={n.path}
      data-kind={n.group ? "group" : n.kind}
      {...attributes}
      onClick={() => (n.group ? onToggle(n.path) : onSelect(n.path))}
      onDoubleClick={() => !n.group && onDrill(n)}
      onContextMenu={(e) => onContext(e, n)}
      className={cx(L.row, selected ? L.rowSelected : dim ? L.rowDim : L.rowIdle, L.rowFocus, n.group && L.groupRow, n.missing && "italic")}
      style={{ paddingLeft: 6 + (row.level - 1) * ROW_INDENT }}
    >
      {current && !selected && <span aria-hidden className="absolute top-1 bottom-1 left-0 w-0.5 rounded-full bg-accent" />}
      <span
        aria-hidden
        onClick={(e) => {
          if (!row.branch) return;
          e.stopPropagation();
          onToggle(n.path);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        className={cx("grid size-4 shrink-0 place-items-center rounded", selected ? "text-selection-fg" : "text-fg-faint", row.branch && "hover:bg-hover")}
      >
        {row.branch && <Icon name="chevron-right" size={12} strokeWidth={2} className={cx("transition-transform duration-100", row.open && "rotate-90")} />}
      </span>
      <Icon name={n.icon} size={14} strokeWidth={1.75} className={cx("shrink-0", tone ?? (selected ? undefined : "text-fg-muted"))} aria-hidden />
      <span className="min-w-0 flex-1 truncate" data-tooltip={desc ? `${n.label} · ${desc}` : n.label} data-tooltip-side="right">
        {n.label}
        {n.kind === "system" && <span className={cx("ml-1.5 text-[10.5px]", selected ? "opacity-80" : "text-fg-faint")}>system</span>}
        {n.where && <span className={cx("ml-1.5 text-[10.5px]", selected ? "opacity-80" : "text-fg-faint")}>{n.where}</span>}
      </span>
      {n.quantity && <span className={cx("shrink-0 font-code text-[10.5px]", selected ? "opacity-80" : "text-fg-faint")}>×{n.quantity}</span>}
      {n.group ? (
        <span aria-hidden className={L.badge}>
          {n.children.length}
        </span>
      ) : own > 0 ? (
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

/** The toolbar's Hierarchy button (left of a shell's view tabs): it opens and folds the panel. */
export function HierarchyToggle({ open, onClick, disabled, className }: { open: boolean; onClick: () => void; disabled?: boolean; className?: string }) {
  return (
    <button
      type="button"
      aria-pressed={open}
      aria-controls="uhd-hierarchy"
      disabled={disabled}
      data-tooltip={open ? "Fold the hierarchy" : "Show the hierarchy"}
      onClick={onClick}
      className={cx(
        "flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 font-ui text-[12px] tracking-[-0.01em] transition-colors disabled:cursor-default disabled:opacity-50",
        open ? "border-line bg-accent-tint text-fg outline outline-1 -outline-offset-1 outline-contrast-active" : "border-transparent text-fg-muted hover:bg-hover hover:text-fg",
        "focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-focus",
        className,
      )}
    >
      <Icon name="panel-left" size={15} strokeWidth={1.75} className={open ? "text-accent" : undefined} aria-hidden />
      <span className="max-[640px]:hidden">Hierarchy</span>
    </button>
  );
}
