/**
 * The library's views of a loaded model, each reading the viewer's state
 * (`useViewer`): the diagram canvas with its toolbar and legend, the 3D
 * scene, the inspector panels and a module's context menu. Shells place them;
 * none of them is app chrome.
 */
import { memo } from "react";
import { useReactFlow } from "@xyflow/react";
import { Canvas, fitPadding } from "../canvas/Canvas";
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
  className?: string;
}

/** The diagram of the current level: modules, interfaces, links and harnesses. */
export function DiagramCanvas({ toolbar = true, legend = true, coveredRight, className }: DiagramCanvasProps) {
  const c = useViewer();
  const covered = coveredRight ?? Boolean(c.panel);
  return (
    <main className={cx("canvas", className)}>
      <ScenarioBanner />
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
        marks={c.options.nodeMarks}
        isolation={c.isolation}
      />
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

interface DiagramToolbarViewProps {
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
  const flow = useReactFlow();
  return (
    <Toolbar label="Diagram tools" className={cx("toolbar", p.coveredRight && "covered-right", p.className)}>
      {p.controls && (
        <>
          <ToggleGroup label="Classification" tooltipSide="top" options={CLASSIFICATION_OPTIONS} value={p.mode} onChange={p.onMode} />
          <ToolbarSeparator />
          <ToggleGroup label="Detail" tooltipSide="top" options={DETAIL_OPTIONS} value={p.conductors ? "conductors" : "bundled"} onChange={(v) => p.onConductors(v === "conductors")} />
          <IconButton icon="arrow-down-to-line" tooltipSide="top" label={p.showGrounds ? "Draw grounds as symbols" : "Draw grounds as wires"} pressed={p.showGrounds} onClick={() => p.onGrounds(!p.showGrounds)} />
          <ToolbarSeparator />
        </>
      )}
      <IconButton icon="maximize" label="Fit view" tooltipSide="top" onClick={() => flow.fitView({ padding: fitPadding(p.coveredRight), maxZoom: 1.25, duration: 300 })} />
      <IconButton icon="zoom-in" label="Zoom in" tooltipSide="top" onClick={() => flow.zoomIn({ duration: 200 })} />
      <IconButton icon="zoom-out" label="Zoom out" tooltipSide="top" onClick={() => flow.zoomOut({ duration: 200 })} />
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

const DiagramLegendView = memo(function DiagramLegendView({ mode, className }: { mode: Classification; className?: string }) {
  return (
    <Legend title={CLASSIFICATIONS.find((x) => x.id === mode)?.label} className={cx("legend", className)}>
      {legendFor(mode).map((item) => (
        <LegendItem key={item.label} color={item.color} label={item.label} />
      ))}
    </Legend>
  );
});

/** What the link colours mean in the current classification. */
export function DiagramLegend({ className }: { className?: string }) {
  const c = useViewer();
  return <DiagramLegendView mode={c.mode} className={className} />;
}

/** The assembled 3D model of the whole system, with its own toolbar and (optionally) its inspector. */
export function Scene3D({ inspector }: { inspector?: boolean }) {
  const c = useViewer();
  return (
    <CadView
      key={c.scenario.id}
      system={c.system}
      lookup={c.scenario.lookup}
      source={c.source}
      diagnostics={c.diagnostics}
      hostDiagnostics={c.hostDiagnostics}
      focusOn={c.cadFocus}
      onSelect={c.onCadSelect}
      inspector={inspector ?? Boolean(c.panel)}
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
