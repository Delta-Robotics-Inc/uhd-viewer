import { useCallback, useEffect, useMemo, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import type { ChildLink } from "@uhd/types/index.js";
import { checkSystem } from "@uhd/system/checks.js";
import { buildView, withOverrides } from "./model/from-uhd";
import type { Classification } from "./model/classification";
import type { ViewLink } from "./model/types";
import { computeLayout, type LevelLayout, type LinkLayout } from "./layout/layout";
import type { Pt } from "./canvas/routing";
import { bundleUrlFromLocation, loadBundle, type LoadedSource } from "./source/source";
import { Canvas, type Selection } from "./canvas/Canvas";
import { ActivityBar, Header, Inspector, Legend, Toolbar, type Panel } from "./chrome/Chrome";
import { PairView } from "./chrome/PairView";
import { CadView } from "./cad/CadView";


type Positions = Record<string, Record<string, { x: number; y: number }>>;
/** Per level: pinned waypoints and label positions the user set (PB-803). */
type LinkEdits = Record<string, Record<string, LinkLayout>>;
type Overrides = Record<string, ChildLink[]>;

function load<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: state stays in memory */
  }
}

/** Initial view state from the URL: ?scenario=o4-on-vbat&mode=drc&detail=conductors&drill=stack&open=gnss_i2c&panel=checks */
const params = new URLSearchParams(window.location.search);
const list = (key: string) => params.get(key)?.split(",").filter(Boolean);

/** Loads the UHD bundle (the viewer's only input), then shows it. */
export default function App() {
  const [source, setSource] = useState<LoadedSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    loadBundle(bundleUrlFromLocation()).then(setSource, (e: Error) => setError(e.message));
  }, []);
  if (error) return <div className="load-state error">{error}</div>;
  if (!source) return <div className="load-state">Loading UHD bundle…</div>;
  return <Viewer source={source} />;
}

function Viewer({ source }: { source: LoadedSource }) {
  const SCENARIOS = source.scenarios;
  const HAND_LAYOUTS: Record<string, LevelLayout> = source.display.diagram?.layouts ?? {};
  const DEFAULT_EXPANDED = source.display.diagram?.expanded ?? [];
  const [scenarioId, setScenarioId] = useState(params.get("scenario") ?? "nominal");
  const [drill, setDrill] = useState<string[]>(list("drill") ?? []);
  const [mode, setMode] = useState<Classification>((params.get("mode") as Classification) ?? "domain");
  const [conductors, setConductors] = useState(params.get("detail") === "conductors");
  const [showGrounds, setShowGrounds] = useState(params.get("grounds") === "1");
  const [expanded, setExpanded] = useState<Set<string>>(new Set([...DEFAULT_EXPANDED, ...(list("expand") ?? [])]));
  const [openLinks, setOpenLinks] = useState<Set<string>>(new Set(list("open") ?? source.display.diagram?.openLinks ?? []));
  const [selection, setSelection] = useState<Selection>(
    params.get("select") ? { kind: params.get("select")!.startsWith("link:") ? "link" : "node", id: params.get("select")!.replace(/^(link|node):/, "") } : null,
  );
  const [panel, setPanel] = useState<Panel | null>((params.get("panel") as Panel) ?? "hierarchy");
  const [pairLink, setPairLink] = useState<string | null>(params.get("pair"));
  const [view, setView] = useState<"diagram" | "3d">(params.get("view") === "3d" ? "3d" : "diagram");
  const [positions, setPositions] = useState<Positions>(() => load("uhd-viewer:positions", {}));
  const [overrides, setOverrides] = useState<Overrides>(() => load("uhd-viewer:overrides", {}));
  const [linkEdits, setLinkEdits] = useState<LinkEdits>(() => load("uhd-viewer:links", {}));

  const scenario = SCENARIOS.find((s) => s.id === scenarioId) ?? SCENARIOS[0];
  const system = useMemo(() => withOverrides(scenario.system, overrides), [scenario, overrides]);
  const diagnostics = useMemo(() => checkSystem(system, scenario.lookup).diagnostics, [system, scenario]);

  const levelKey = drill.join("/");
  const vm = useMemo(
    () => buildView(system, scenario.lookup, drill, { expanded, overrides, diagnostics }),
    [system, scenario, drill, expanded, overrides, diagnostics],
  );
  const hand = HAND_LAYOUTS[levelKey];
  const layout = useMemo(
    () => computeLayout(vm, hand, positions[levelKey] ?? {}, showGrounds, linkEdits[levelKey]),
    [vm, hand, positions, levelKey, showGrounds, linkEdits],
  );

  useEffect(() => save("uhd-viewer:positions", positions), [positions]);
  useEffect(() => save("uhd-viewer:overrides", overrides), [overrides]);
  useEffect(() => save("uhd-viewer:links", linkEdits), [linkEdits]);
  const editLink = useCallback(
    (linkId: string, patch: LinkLayout) =>
      setLinkEdits((e) => ({ ...e, [levelKey]: { ...(e[levelKey] ?? {}), [linkId]: { ...(e[levelKey]?.[linkId] ?? {}), ...patch } } })),
    [levelKey],
  );
  const onLabel = useCallback((linkId: string, t: number) => editLink(linkId, { labelT: t }), [editLink]);
  const onPins = useCallback((linkId: string, pins: Pt[]) => editLink(linkId, { waypoints: pins }), [editLink]);

  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  const onToggleLink = useCallback((id: string) => setOpenLinks((s) => toggle(s, id)), []);
  const onToggleExpand = useCallback(
    (id: string) => {
      if (!vm.nodes.find((n) => n.id === id)?.childCount) return;
      setExpanded((s) => toggle(s, id));
    },
    [vm],
  );
  const onMove = useCallback(
    (id: string, x: number, y: number) =>
      setPositions((p) => ({ ...p, [levelKey]: { ...(p[levelKey] ?? {}), [id]: { x, y } } })),
    [levelKey],
  );
  const onDrill = useCallback((id: string) => {
    setDrill((d) => [...d, ...id.split("/")]);
    setSelection(null);
  }, []);
  const onOverride = useCallback((linkId: string, childLinks: ChildLink[] | null) => {
    setOverrides((o) => {
      const next = { ...o };
      if (childLinks) next[linkId] = childLinks;
      else delete next[linkId];
      return next;
    });
  }, []);

  /** b-side child slots of a link, for the remap editor. */
  const bSlotsFor = useCallback(
    (link: ViewLink) => {
      const target = link.segment ? vm.links.find((l) => l.linkId === link.linkId && l.segment === "b")?.target : link.target;
      const port = vm.nodes.find((n) => n.id === target?.node)?.ports.find((p) => p.id === target?.port);
      return port?.children.map((c) => c.slotId) ?? [];
    },
    [vm],
  );

  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const pair = pairLink ? vm.links.find((l) => l.linkId === pairLink) : undefined;

  return (
    <ReactFlowProvider>
      <div className="app">
        <Header
          vm={vm}
          onNavigate={(depth) => {
            setDrill((d) => d.slice(0, depth));
            setSelection(null);
          }}
          scenarios={SCENARIOS.map((s) => ({ id: s.id, label: s.label }))}
          scenario={scenario.id}
          onScenario={(id) => {
            setScenarioId(id);
            setSelection(null);
            setDrill([]);
          }}
          mode={mode}
          onMode={setMode}
          conductors={conductors}
          onConductors={setConductors}
          showGrounds={showGrounds}
          onGrounds={setShowGrounds}
          view={view}
          onView={setView}
        />
        <div className="workspace">
          <ActivityBar panel={panel} onPanel={setPanel} errors={errors} />
          {view === "3d" ? (
            <CadView key={scenario.id} system={system} lookup={scenario.lookup} source={source} />
          ) : (
          <>
          <main className="canvas">
            {scenario.id !== "nominal" && (
              <div className={`scenario-banner${errors ? " error" : ""}`}>
                <b>SCENARIO · {scenario.label.toUpperCase()}</b>
                <span>{scenario.description}</span>
                <span>
                  {errors} error{errors === 1 ? "" : "s"} found by the system checks
                </span>
              </div>
            )}
            <Canvas
              key={`${scenario.id}/${levelKey}`}
              vm={vm}
              layout={layout}
              hand={hand}
              mode={mode}
              detail={conductors ? "ribbon" : "basic"}
              showGrounds={showGrounds}
              openLinks={openLinks}
              selection={selection}
              onSelect={setSelection}
              onToggleLink={onToggleLink}
              onToggleExpand={onToggleExpand}
              onMove={onMove}
              onLabel={onLabel}
              onPins={onPins}
            />
            <Toolbar
              onReset={() => {
                setPositions((p) => ({ ...p, [levelKey]: {} }));
                setLinkEdits((e) => ({ ...e, [levelKey]: {} }));
              }}
            />
            <Legend mode={mode} />
            {pair && <PairView vm={vm} link={pair} mode={mode} onClose={() => setPairLink(null)} />}
          </main>
          {panel && (
            <Inspector
              vm={vm}
              panel={panel}
              onPanel={setPanel}
              selection={selection}
              mode={mode}
              openLinks={openLinks}
              diagnostics={diagnostics}
              defFor={(id) => (id ? scenario.lookup(id) : undefined)}
              bSlotsFor={bSlotsFor}
              overrides={overrides}
              onOverride={onOverride}
              onSelect={setSelection}
              onDrill={onDrill}
              onToggleLink={onToggleLink}
              onToggleExpand={onToggleExpand}
              onPair={(l) => setPairLink(l.linkId)}
              topLevel={drill.length === 0}
            />
          )}
          </>
          )}
        </div>
      </div>
    </ReactFlowProvider>
  );
}
