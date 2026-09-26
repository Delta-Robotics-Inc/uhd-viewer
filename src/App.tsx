import { useCallback, useEffect, useMemo, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import type { ChildLink } from "@uhd/types/index.js";
import { checkSystem } from "@uhd/system/checks.js";
import { SCENARIOS } from "@uhd-library/systems/quadcopter-5in/scenarios.js";
import { buildView, withOverrides } from "./model/from-uhd";
import type { Classification } from "./model/classification";
import type { ViewLink } from "./model/types";
import { computeLayout, type LevelLayout } from "./layout/layout";
import { QUADCOPTER_TOP } from "./layout/quadcopter";
import { Canvas, type Selection } from "./canvas/Canvas";
import { ActivityBar, Header, Inspector, Legend, Toolbar, type Panel } from "./chrome/Chrome";
import { PairView } from "./chrome/PairView";

/** Hand layouts per level, keyed by drill path. */
const HAND_LAYOUTS: Record<string, LevelLayout> = { "": QUADCOPTER_TOP };

/** Children drawn expanded in place by default (design D8). */
const DEFAULT_EXPANDED = ["arm_fl", "arm_fr", "arm_rl", "arm_rr"];

type Positions = Record<string, Record<string, { x: number; y: number }>>;
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

export default function App() {
  const [scenarioId, setScenarioId] = useState(params.get("scenario") ?? "nominal");
  const [drill, setDrill] = useState<string[]>(list("drill") ?? []);
  const [mode, setMode] = useState<Classification>((params.get("mode") as Classification) ?? "domain");
  const [conductors, setConductors] = useState(params.get("detail") === "conductors");
  const [showGrounds, setShowGrounds] = useState(params.get("grounds") === "1");
  const [expanded, setExpanded] = useState<Set<string>>(new Set([...DEFAULT_EXPANDED, ...(list("expand") ?? [])]));
  const [openLinks, setOpenLinks] = useState<Set<string>>(new Set(list("open") ?? ["gnss_i2c"]));
  const [selection, setSelection] = useState<Selection>(
    params.get("select") ? { kind: params.get("select")!.startsWith("link:") ? "link" : "node", id: params.get("select")!.replace(/^(link|node):/, "") } : null,
  );
  const [panel, setPanel] = useState<Panel | null>((params.get("panel") as Panel) ?? "hierarchy");
  const [pairLink, setPairLink] = useState<string | null>(params.get("pair"));
  const [positions, setPositions] = useState<Positions>(() => load("uhd-viewer:positions", {}));
  const [overrides, setOverrides] = useState<Overrides>(() => load("uhd-viewer:overrides", {}));

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
    () => computeLayout(vm, hand, positions[levelKey] ?? {}, showGrounds),
    [vm, hand, positions, levelKey, showGrounds],
  );

  useEffect(() => save("uhd-viewer:positions", positions), [positions]);
  useEffect(() => save("uhd-viewer:overrides", overrides), [overrides]);

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
        />
        <div className="workspace">
          <ActivityBar panel={panel} onPanel={setPanel} errors={errors} />
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
              conductors={conductors}
              showGrounds={showGrounds}
              openLinks={openLinks}
              selection={selection}
              onSelect={setSelection}
              onToggleLink={onToggleLink}
              onToggleExpand={onToggleExpand}
              onMove={onMove}
            />
            <Toolbar onReset={() => setPositions((p) => ({ ...p, [levelKey]: {} }))} />
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
        </div>
      </div>
    </ReactFlowProvider>
  );
}
