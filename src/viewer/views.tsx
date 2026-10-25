/**
 * The library's views of a loaded model, each reading the viewer's state
 * (`useViewer`): the diagram canvas with its toolbar and legend, the 3D
 * scene, the inspector panels and a module's context menu. Shells place them;
 * none of them is app chrome.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Canvas } from "../canvas/Canvas";
import { TOOL_OPTIONS, type CanvasTool } from "../canvas/interaction";
import { Icon } from "../canvas/Icon";
import { PairView } from "../chrome/PairView";
import { Inspector, NodeMenu } from "../chrome/Chrome";
import { CadView } from "../cad/CadView";
import { CLASSIFICATIONS, legendFor, type Classification } from "../model/classification";
import { IconButton, ToggleGroup, Toolbar, ToolbarSeparator } from "../ui/Toolbar";
import { Legend, LegendItem, LegendSwatches } from "../ui/Legend";
import { legendStage, type LegendStage } from "../ui/legendFit";
import { cx } from "../ui/cx";
import { useViewer } from "./controller";

export interface DiagramCanvasProps {
  /** Draw the floating toolbar (fit, zoom, reset layout). Default true. */
  toolbar?: boolean;
  /** Draw the classification's legend. Default true. */
  legend?: boolean;
  /** A panel floats over the canvas's right side: fitting leaves room for it. Default: the inspector panel is open. */
  coveredRight?: boolean;
  /** What the shell adds to the notice about definitions the bundle does not hold (how its producer gets them). */
  missingHint?: ReactNode;
  className?: string;
}

/** The diagram of the current level: modules, interfaces, links and harnesses. */
export function DiagramCanvas({ toolbar = true, legend = true, coveredRight, missingHint, className }: DiagramCanvasProps) {
  const c = useViewer();
  const covered = coveredRight ?? Boolean(c.panel);
  return (
    <main className={cx("canvas", className)}>
      <ScenarioBanner />
      <MissingNotice hint={missingHint} />
      <Canvas
        key={`${c.scenario.id}/${c.levelKey}/${c.viewportsSeq}`}
        vm={c.drawn}
        inspector={covered}
        layout={c.layout}
        hand={c.hand}
        mode={c.mode}
        detail={c.conductors ? "ribbon" : "basic"}
        showGrounds={c.showGrounds}
        openLinks={c.openLinks}
        selection={c.selection}
        onSelect={c.setSelection}
        onToggleLink={c.onToggleLink}
        onToggleExpand={c.onToggleExpand}
        onOpenNode={c.onOpenNode}
        onMove={c.onMove}
        onLayout={c.editLink}
        onLive={c.setLive}
        onPins={c.onPins}
        centre={c.centre}
        reveal={c.reveal}
        onNodeContext={c.onNodeContext}
        onPaneContext={c.onPaneContext}
        marks={c.options.nodeMarks}
        isolation={c.isolation}
        group={c.group}
        onSelectChanges={c.onSelectChanges}
        onSelectAll={c.onSelectAll}
        onEscape={c.onEscape}
        interaction={c.interaction}
        onInteraction={c.onInteraction}
        command={c.viewCommand}
        viewport={c.viewport}
        onViewport={c.onViewport}
      />
      {c.drawn.nodes.length === 0 && (
        <div className={cx("canvas-empty", covered && "covered-right")} role="status">
          <div className="canvas-empty-title">{c.levelDef.name} has no modules yet</div>
          <p>Add child modules to its definition to see them here.</p>
        </div>
      )}
      {toolbar && <DiagramToolbar coveredRight={covered} />}
      {legend && <DiagramLegend />}
      {c.pair && <PairView vm={c.vm} link={c.pair} mode={c.mode} onClose={() => c.setPairLink(null)} />}
    </main>
  );
}

/** The scenario being shown, when it is not the nominal build. */
export function ScenarioBanner() {
  const c = useViewer();
  if (c.scenario.id === "nominal") return null;
  return (
    <div className={`scenario-banner${c.errors ? " error" : ""}`}>
      <b>SCENARIO · {c.scenario.label.toUpperCase()}</b>
      <span>{c.scenario.description}</span>
      <span>
        {c.errors} error{c.errors === 1 ? "" : "s"} found by the system checks
      </span>
    </div>
  );
}

/**
 * Definitions the bundle names and does not hold (source/tolerant.ts): they are
 * drawn as placeholders, and this says which. It can be put away; a bundle
 * that lacks something else brings it back.
 */
export function MissingNotice({ hint, className }: { hint?: ReactNode; className?: string }) {
  const c = useViewer();
  const { missing, leftOut } = c.scenario;
  const key = `${missing.map((m) => m.id).join(",")}|${leftOut.length}`;
  const [dismissed, setDismissed] = useState<string | null>(null);
  if ((!missing.length && !leftOut.length) || dismissed === key) return null;
  const SHOWN = 4;
  const ids = missing.map((m) => m.id);
  const lines = leftOut.filter((l) => l.kind === "link").length;
  const exports = leftOut.length - lines;
  const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  return (
    <div className={cx("missing-notice", c.scenario.id !== "nominal" && "below-banner", className)} role="status" data-missing={ids.length} data-left-out={leftOut.length}>
      <Icon name="triangle-alert" size={14} strokeWidth={1.8} className="missing-notice-icon" aria-hidden />
      <div className="missing-notice-text">
        {ids.length > 0 && (
          <div>
            <b>{count(ids.length, "definition")} not in this bundle</b>, drawn as {ids.length === 1 ? "a placeholder" : "placeholders"}:{" "}
            <span className="missing-notice-ids" title={ids.join("\n")}>
              {ids.slice(0, SHOWN).join(", ")}
              {ids.length > SHOWN ? ` and ${ids.length - SHOWN} more` : ""}
            </span>
          </div>
        )}
        {leftOut.length > 0 && (
          <div title={leftOut.map((l) => `${l.on} · ${l.kind} ${l.id}: ${l.why}`).join("\n")}>
            {[lines ? count(lines, "link") : "", exports ? count(exports, "export") : ""].filter(Boolean).join(" and ")} could not be resolved and {leftOut.length === 1 ? "is" : "are"} not drawn.
          </div>
        )}
        {hint ? <div className="missing-notice-hint">{hint}</div> : null}
      </div>
      <IconButton icon="x" size="sm" tooltipSide="bottom" label="Hide this notice" onClick={() => setDismissed(key)} className="size-6 shrink-0" />
    </div>
  );
}

/** The diagram's view controls as icon toggles (each with a tooltip). */
export const CLASSIFICATION_OPTIONS = [
  { id: "domain", icon: "layers", label: "Colour by domain" },
  { id: "drc", icon: "shield-check", label: "Colour by DRC health" },
  { id: "signal", icon: "activity", label: "Colour by signal type" },
] as const satisfies readonly { id: Classification; icon: string; label: string }[];

export const DETAIL_OPTIONS = [
  { id: "bundled", icon: "minus", label: "Basic: one line per link" },
  { id: "conductors", icon: "rows-3", label: "Ribbon: every conductor" },
] as const;

/**
 * The pointer's tool: select (a drag on the empty canvas draws a selection
 * box) or pan (a drag moves the view). For a shell's own toolbar.
 */
export function ToolToggle({ tooltipSide = "top", size }: { tooltipSide?: "top" | "bottom" | "left" | "right"; size?: "sm" | "md" }) {
  const c = useViewer();
  return <ToolToggleView tool={c.tool} onTool={c.setTool} tooltipSide={tooltipSide} size={size} />;
}

function ToolToggleView({ tool, onTool, tooltipSide, size }: { tool: CanvasTool; onTool: (t: CanvasTool) => void; tooltipSide?: "top" | "bottom" | "left" | "right"; size?: "sm" | "md" }) {
  return (
    <div role="group" aria-label="Pointer" className="flex items-center gap-0.5">
      {TOOL_OPTIONS.map((o) => (
        <IconButton key={o.id} icon={o.icon} label={o.label} shortcut={o.shortcut} pressed={o.id === tool} tooltipSide={tooltipSide} size={size} onClick={() => onTool(o.id)} />
      ))}
    </div>
  );
}

/** Fit and zoom, as the canvas does them (a fit asked for here is also what the level opens on next time). */
export function ViewButtons({ tooltipSide = "top" }: { tooltipSide?: "top" | "bottom" | "left" | "right" }) {
  const c = useViewer();
  return <ViewButtonsView onFit={c.fitView} onZoomIn={c.zoomIn} onZoomOut={c.zoomOut} tooltipSide={tooltipSide} />;
}

function ViewButtonsView({ onFit, onZoomIn, onZoomOut, tooltipSide }: { onFit: () => void; onZoomIn: () => void; onZoomOut: () => void; tooltipSide?: "top" | "bottom" | "left" | "right" }) {
  return (
    <>
      <IconButton icon="maximize" label="Fit view" shortcut="F" tooltipSide={tooltipSide} onClick={onFit} />
      <IconButton icon="zoom-in" label="Zoom in" shortcut="+" tooltipSide={tooltipSide} onClick={onZoomIn} />
      <IconButton icon="zoom-out" label="Zoom out" shortcut="-" tooltipSide={tooltipSide} onClick={onZoomOut} />
    </>
  );
}

interface DiagramToolbarViewProps {
  tool: CanvasTool;
  onTool: (t: CanvasTool) => void;
  onFit: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  coveredRight: boolean;
  className?: string;
  controls: boolean;
  mode: Classification;
  onMode: (m: Classification) => void;
  conductors: boolean;
  onConductors: (c: boolean) => void;
  showGrounds: boolean;
  onGrounds: (g: boolean) => void;
  /** The legend's button, when the legend has no room beside the toolbar. */
  legend?: ReactNode;
}

const DiagramToolbarView = memo(function DiagramToolbarView(p: DiagramToolbarViewProps) {
  return (
    <Toolbar label="Diagram tools" className={cx("toolbar", p.coveredRight && "covered-right", p.className)}>
      {p.legend}
      <ToolToggleView tool={p.tool} onTool={p.onTool} tooltipSide="top" />
      <ToolbarSeparator />
      {p.controls && (
        <>
          <ToggleGroup label="Classification" tooltipSide="top" options={CLASSIFICATION_OPTIONS} value={p.mode} onChange={p.onMode} />
          <ToolbarSeparator />
          <ToggleGroup label="Detail" tooltipSide="top" options={DETAIL_OPTIONS} value={p.conductors ? "conductors" : "bundled"} onChange={(v) => p.onConductors(v === "conductors")} />
          <IconButton icon="arrow-down-to-line" tooltipSide="top" label={p.showGrounds ? "Draw grounds as symbols" : "Draw grounds as wires"} pressed={p.showGrounds} onClick={() => p.onGrounds(!p.showGrounds)} />
          <ToolbarSeparator />
        </>
      )}
      <ViewButtonsView onFit={p.onFit} onZoomIn={p.onZoomIn} onZoomOut={p.onZoomOut} tooltipSide="top" />
      <ToolbarSeparator />
      <IconButton icon="rotate-ccw" label="Reset layout of this level" tooltipSide="top" onClick={p.onReset} />
    </Toolbar>
  );
});

/**
 * The diagram's controls (classification, detail, grounds; `controls={false}` leaves them out), then fit, zoom and reset.
 * When the legend has no room beside it, it starts with the legend's button (`legend`: what that opens; default the
 * viewer's legend).
 */
export function DiagramToolbar({ coveredRight, className, controls = true, legend }: { coveredRight?: boolean; className?: string; controls?: boolean; legend?: ReactNode }) {
  const c = useViewer();
  // (kept: the toolbar is memoised, and a canvas drag re-renders the viewer every frame)
  const legendButton = useMemo(() => <LegendToolbarButton>{legend ?? <DiagramLegendBody form="full" />}</LegendToolbarButton>, [legend]);
  return (
    <DiagramToolbarView
      legend={legendButton}
      tool={c.tool}
      onTool={c.setTool}
      onFit={c.fitView}
      onZoomIn={c.zoomIn}
      onZoomOut={c.zoomOut}
      onReset={c.onReset}
      coveredRight={coveredRight ?? Boolean(c.panel)}
      className={className}
      controls={controls}
      mode={c.mode}
      onMode={c.setMode}
      conductors={c.conductors}
      onConductors={c.setConductors}
      showGrounds={c.showGrounds}
      onGrounds={c.setShowGrounds}
    />
  );
}

interface LegendItemsProps {
  mode: Classification;
  present: ReadonlySet<string>;
  isolated: ReadonlySet<string>;
  onIsolate: (key: string, add?: boolean) => void;
  compact?: boolean;
}

const LegendItemsView = memo(function LegendItemsView({ mode, present, isolated, onIsolate, compact }: LegendItemsProps) {
  const what = mode === "signal" ? "signal type" : mode === "domain" ? "domain" : "state";
  return (
    <>
      {legendFor(mode, present).map((item) => {
        const pressed = isolated.has(item.key);
        const absent = !present.has(item.key) && !pressed;
        return (
          <LegendItem
            key={item.key}
            color={item.color}
            label={item.label}
            onSelect={(add) => onIsolate(item.key, add)}
            pressed={pressed}
            dimmed={isolated.size > 0 && !pressed}
            absent={absent}
            hint={absent ? `Nothing on this level is of this ${what}` : pressed ? (isolated.size > 1 ? "Stop isolating this one" : "Show everything again") : `Isolate: fade everything that is not of this ${what}`}
            hintShortcut={absent ? undefined : pressed && isolated.size === 1 ? "Esc" : "Shift+click: hold several"}
            compact={compact}
          />
        );
      })}
    </>
  );
});

/**
 * The entries of the current classification's legend, as buttons: a click
 * isolates one (its links stay, with the interfaces and modules they touch;
 * the rest of the level fades), a click on it again shows everything, a
 * click on another switches, and Shift, Ctrl or Cmd holds several. For a
 * shell that draws its own legend card.
 */
export function DiagramLegendItems({ compact, columns = 3 }: { compact?: boolean; columns?: number } = {}) {
  const c = useViewer();
  const items = <LegendItemsView mode={c.mode} present={c.present} isolated={c.isolated} onIsolate={c.onIsolate} compact={compact} />;
  if (!compact) return items;
  return (
    <LegendSwatches columns={columns} label={CLASSIFICATIONS.find((x) => x.id === c.mode)?.label}>
      {items}
    </LegendSwatches>
  );
}

/** The way back from an isolated legend entry to everything (shown only while something is isolated). */
export function IsolationClear({ className }: { className?: string }) {
  const c = useViewer();
  if (!c.isolated.size) return null;
  return <IconButton icon="x" size="sm" tooltipSide="top" label="Show everything again" shortcut="Esc" onClick={c.clearIsolated} className={cx("size-6", className)} />;
}

/**
 * What the legend shows in a form: `full` the title and the entries with their
 * labels; `compact` the classification's icon and the swatches alone (each
 * named by its label).
 */
export function DiagramLegendBody({ form }: { form: "full" | "compact" }) {
  const c = useViewer();
  const title = CLASSIFICATIONS.find((x) => x.id === c.mode)?.label;
  if (form === "compact") {
    const icon = CLASSIFICATION_OPTIONS.find((o) => o.id === c.mode)?.icon ?? "layers";
    return (
      <>
        <div className="flex min-h-6 items-center justify-between gap-1">
          <Icon name={icon} size={13} strokeWidth={1.75} className="text-fg-muted" aria-label={title} role="img" />
          <IsolationClear className="-my-1 -mr-1.5" />
        </div>
        <DiagramLegendItems compact columns={3} />
      </>
    );
  }
  return (
    <>
      <div className="mb-0.5 flex min-h-6 items-center justify-between gap-2">
        <span className="font-label text-[10px] tracking-[0.8px] text-fg-muted uppercase">{title}</span>
        <IsolationClear className="-my-1 -mr-1.5" />
      </div>
      <DiagramLegendItems />
    </>
  );
}

/** What the link colours mean in the current classification; a click on an entry isolates it. It gives way to the toolbar as the canvas narrows (`FittedLegend`). */
export function DiagramLegend({ className }: { className?: string }) {
  return <FittedLegend label="Legend" className={className} render={(form) => <DiagramLegendBody form={form} />} />;
}

/**
 * A legend card at the canvas's bottom left that stays there and gives way
 * to the bottom toolbar (ui/legendFit.ts): the full form while it fits beside
 * the toolbar, then the compact one, and at its smallest none, the toolbar
 * then offering it behind a button (`LegendToolbarButton`). It measures the
 * room it has (a `ResizeObserver` on the canvas, the toolbar and both forms)
 * from hidden copies of the two forms, so it never overlaps the toolbar.
 * `render` draws a form; the card is a sibling of the toolbar (`.toolbar`).
 */
export function FittedLegend({ label, render, className }: { label: string; render: (form: "full" | "compact") => ReactNode; className?: string }) {
  const { legendStage: stage, setLegendStage, panel } = useViewer();
  const full = useRef<HTMLDivElement>(null);
  const compact = useRef<HTMLDivElement>(null);
  const current = useRef<LegendStage>(stage);
  current.current = stage;
  const measure = useCallback(() => {
    const f = full.current;
    const k = compact.current;
    const host = f?.parentElement;
    if (!f || !k || !host) return;
    const toolbar = host.querySelector<HTMLElement>(":scope > .toolbar");
    // a toolbar not drawn (display: none) is not in the way
    const box = toolbar && toolbar.getClientRects().length ? toolbar.getBoundingClientRect() : null;
    const slotEl = toolbar?.querySelector<HTMLElement>("[data-legend-slot]");
    const slot = slotEl ? slotEl.getBoundingClientRect().width + (parseFloat(getComputedStyle(toolbar!).columnGap) || 0) : 0;
    const fr = f.getBoundingClientRect();
    const next = legendStage({ left: fr.left, full: fr, compact: k.getBoundingClientRect(), toolbar: box, slot }, current.current);
    if (next !== current.current) {
      current.current = next;
      setLegendStage(next);
    }
  }, [setLegendStage]);
  // when a size changes (the canvas, the toolbar, either form: what the legend lists, a fold), and when the
  // inspector opens or closes (it moves the toolbar without resizing it); not on every render, as a drag re-renders
  useLayoutEffect(measure, [measure, panel, stage]);
  useEffect(() => {
    const host = full.current?.parentElement;
    if (!host || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    if (full.current) ro.observe(full.current);
    if (compact.current) ro.observe(compact.current);
    const toolbar = host.querySelector(":scope > .toolbar");
    if (toolbar) ro.observe(toolbar);
    return () => ro.disconnect();
  }, [measure]);
  // a legend no longer drawn leaves the toolbar as it was
  useEffect(() => () => setLegendStage("full"), [setLegendStage]);
  return (
    <>
      {stage !== "button" && (
        <Legend role="group" aria-label={label} compact={stage === "compact"} className={cx("legend", className)} data-legend-stage={stage}>
          {render(stage)}
        </Legend>
      )}
      {/* the measuring copies: never seen, never focused, after the card (a query for the legend finds the card) */}
      <Legend ref={full} aria-hidden inert className={cx("legend-measure", className)}>
        {render("full")}
      </Legend>
      <Legend ref={compact} aria-hidden inert compact className={cx("legend-measure", className)}>
        {render("compact")}
      </Legend>
    </>
  );
}

/**
 * The legend's button in the toolbar, shown only when the legend has no room
 * beside it (`FittedLegend`): it opens the legend (`children`) as a popover
 * above the toolbar. Escape, a click elsewhere or the button closes it, and
 * the keyboard goes back to the button.
 */
export function LegendToolbarButton({ children, label = "Legend" }: { children: ReactNode; label?: string }) {
  const c = useViewer();
  const shown = c.legendStage === "button";
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ host: HTMLElement; left: number; bottom: number } | null>(null);
  useEffect(() => {
    if (!shown) setOpen(false);
  }, [shown]);
  // placed in the canvas (the toolbar scrolls sideways when narrow, and would clip it), above the toolbar, from the button's left
  useLayoutEffect(() => {
    if (!open) return setAt(null);
    const b = button.current;
    const toolbar = b?.closest<HTMLElement>(".toolbar");
    const host = toolbar?.parentElement;
    if (!b || !toolbar || !host) return;
    const place = () => {
      const h = host.getBoundingClientRect();
      const t = toolbar.getBoundingClientRect();
      const r = b.getBoundingClientRect();
      setAt({ host, left: Math.max(8, r.left - h.left), bottom: h.bottom - t.top + 8 });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(host);
    return () => ro.disconnect();
  }, [open]);
  // the keyboard goes into the legend; a click elsewhere closes it
  useEffect(() => {
    if (!open || !at) return;
    pop.current?.querySelector<HTMLElement>("button:not([aria-disabled='true']), [href], [tabindex]:not([tabindex='-1'])")?.focus();
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, [open, at]);
  if (!shown) return null;
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  return (
    <span data-legend-slot className="flex shrink-0 items-center gap-1">
      <IconButton ref={button} icon="swatch-book" label={label} tooltipSide="top" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)} className={cx(open && "bg-active text-fg")} />
      <ToolbarSeparator />
      {open &&
        at &&
        createPortal(
          <Legend
            ref={pop}
            role="dialog"
            aria-label={label}
            className="legend-popover"
            style={{ left: at.left, bottom: at.bottom }}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              e.stopPropagation();
              close();
            }}
            onBlur={(e) => {
              // the keyboard left the legend (Tab past its last entry): it closes
              const to = e.relatedTarget as Node | null;
              if (to && !pop.current?.contains(to) && !button.current?.contains(to)) setOpen(false);
            }}
          >
            {children}
          </Legend>,
          at.host,
        )}
    </span>
  );
}

export interface Scene3DProps {
  /** Show the 3D view's own inspector card. Default: the inspector panel is open. */
  inspector?: boolean;
  /**
   * The module to show, by instance path from the root. Default: the level
   * the viewer is on (`drill`), so the root shows the whole assembly and a
   * module shows that module alone. A shell whose tab is on a module with no
   * level of its own (a part) passes that module's path.
   */
  scope?: string[];
  /** What the shell adds where a module has nothing to draw (how its 3D model is made). */
  emptyHint?: ReactNode;
}

/**
 * The 3D model of what is being viewed: the whole assembly at the root, one
 * module alone (in its own coordinates) on that module's level. With its own
 * toolbar and (optionally) its inspector.
 */
export function Scene3D({ inspector, scope, emptyHint }: Scene3DProps) {
  const c = useViewer();
  const shown = scope ?? c.drill;
  return (
    <CadView
      key={`${c.scenario.id}|${shown.join("/")}`}
      system={c.system}
      lookup={c.scenario.lookup}
      source={c.source}
      diagnostics={c.diagnostics}
      hostDiagnostics={c.hostDiagnostics}
      focusOn={c.cadFocus}
      onSelect={c.onCadSelect}
      inspector={inspector ?? Boolean(c.panel)}
      scope={shown}
      emptyHint={emptyHint}
    />
  );
}

/**
 * The inspector of the current level: the selected module or link, else the
 * hierarchy or the system checks (`panel`). Hidden while no panel is open.
 */
export function ViewerInspector({ className }: { className?: string }) {
  const c = useViewer();
  if (!c.panel) return null;
  return (
    <Inspector
      className={className}
      vm={c.vm}
      panel={c.panel}
      onPanel={c.setPanel}
      selection={c.selection}
      mode={c.mode}
      openLinks={c.openLinks}
      diagnostics={c.diagnostics}
      hostDiagnostics={c.hostDiagnostics}
      defFor={c.defFor}
      resolveArtifact={c.source.resolveArtifact}
      appearance={c.source.display.spatial?.appearance}
      bSlotsFor={c.bSlotsFor}
      overrides={c.overrides}
      onOverride={c.onOverride}
      onSelect={c.setSelection}
      onDrill={c.onDrill}
      onToggleLink={c.onToggleLink}
      onToggleExpand={c.onToggleExpand}
      onPair={c.onPair}
      topLevel={c.topLevel}
      levelDef={c.levelDef}
      drill={c.drill}
      onGoto={c.onGoto}
      onNodeContext={c.onNodeContext}
    />
  );
}

/** A module's context menu, where the pointer opened it. */
export function ViewerNodeMenu() {
  const c = useViewer();
  if (!c.menu) return null;
  return <NodeMenu x={c.menu.x} y={c.menu.y} items={c.menuItems} onClose={c.closeMenu} />;
}
