/**
 * The library's views of a loaded model, each reading the viewer's state
 * (`useViewer`): the diagram canvas with its toolbar and legend, the 3D
 * scene, the inspector panels and a module's context menu. Shells place them;
 * none of them is app chrome.
 */
import { memo, useState, type ReactNode } from "react";
import { Canvas } from "../canvas/Canvas";
import { TOOL_OPTIONS, type CanvasTool } from "../canvas/interaction";
import { Icon } from "../canvas/Icon";
import { PairView } from "../chrome/PairView";
import { Inspector, NodeMenu } from "../chrome/Chrome";
import { CadView } from "../cad/CadView";
import { CLASSIFICATIONS, legendFor, type Classification } from "../model/classification";
import { IconButton, ToggleGroup, Toolbar, ToolbarSeparator } from "../ui/Toolbar";
import { Legend, LegendItem } from "../ui/Legend";
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
        key={`${c.scenario.id}/${c.levelKey}`}
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
          <p>Modules appear here as children are added to its definition, and links as they are joined.</p>
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
}

const DiagramToolbarView = memo(function DiagramToolbarView(p: DiagramToolbarViewProps) {
  return (
    <Toolbar label="Diagram tools" className={cx("toolbar", p.coveredRight && "covered-right", p.className)}>
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

/** The diagram's controls (classification, detail, grounds; `controls={false}` leaves them out), then fit, zoom and reset. */
export function DiagramToolbar({ coveredRight, className, controls = true }: { coveredRight?: boolean; className?: string; controls?: boolean }) {
  const c = useViewer();
  return (
    <DiagramToolbarView
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
}

const LegendItemsView = memo(function LegendItemsView({ mode, present, isolated, onIsolate }: LegendItemsProps) {
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
export function DiagramLegendItems() {
  const c = useViewer();
  return <LegendItemsView mode={c.mode} present={c.present} isolated={c.isolated} onIsolate={c.onIsolate} />;
}

/** The way back from an isolated legend entry to everything (shown only while something is isolated). */
export function IsolationClear({ className }: { className?: string }) {
  const c = useViewer();
  if (!c.isolated.size) return null;
  return <IconButton icon="x" size="sm" tooltipSide="top" label="Show everything again" shortcut="Esc" onClick={c.clearIsolated} className={cx("size-6", className)} />;
}

/** What the link colours mean in the current classification; a click on an entry isolates it. */
export function DiagramLegend({ className }: { className?: string }) {
  const c = useViewer();
  return (
    <Legend className={cx("legend", className)}>
      <div className="mb-0.5 flex min-h-6 items-center justify-between gap-2">
        <span className="font-label text-[10px] tracking-[0.8px] text-fg-muted uppercase">{CLASSIFICATIONS.find((x) => x.id === c.mode)?.label}</span>
        <IsolationClear className="-my-1 -mr-1.5" />
      </div>
      <DiagramLegendItems />
    </Legend>
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
