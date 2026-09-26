import { useCallback, useEffect, useMemo, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { QUADCOPTER_5IN, lookupQuadcopterModule } from "@uhd-library/systems/quadcopter-5in/index.js";
import { buildView } from "./model/from-uhd";
import type { Classification } from "./model/classification";
import { computeLayout, type LevelLayout } from "./layout/layout";
import { QUADCOPTER_TOP } from "./layout/quadcopter";
import { Canvas, type Selection } from "./canvas/Canvas";
import { ActivityBar, Header, Inspector, Legend, Toolbar } from "./chrome/Chrome";

/** Hand layouts per level, keyed by drill path. */
const HAND_LAYOUTS: Record<string, LevelLayout> = { "": QUADCOPTER_TOP };

/** Children drawn expanded in place by default (design D8). */
const DEFAULT_EXPANDED = ["arm_fl", "arm_fr", "arm_rl", "arm_rr"];

type Positions = Record<string, Record<string, { x: number; y: number }>>;

function loadPositions(): Positions {
  try {
    return JSON.parse(localStorage.getItem("uhd-viewer:positions") ?? "{}") as Positions;
  } catch {
    return {};
  }
}

/** Initial view state from the URL: ?mode=drc&detail=conductors&drill=stack&open=gnss_i2c,m1_phases&expand=stack */
const params = new URLSearchParams(window.location.search);
const list = (key: string) => params.get(key)?.split(",").filter(Boolean);

export default function App() {
  const [drill, setDrill] = useState<string[]>(list("drill") ?? []);
  const [mode, setMode] = useState<Classification>((params.get("mode") as Classification) ?? "domain");
  const [conductors, setConductors] = useState(params.get("detail") === "conductors");
  const [showGrounds, setShowGrounds] = useState(params.get("grounds") === "1");
  const [expanded, setExpanded] = useState<Set<string>>(new Set([...DEFAULT_EXPANDED, ...(list("expand") ?? [])]));
  const [openLinks, setOpenLinks] = useState<Set<string>>(new Set(list("open") ?? ["gnss_i2c"]));
  const [selection, setSelection] = useState<Selection>(null);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [positions, setPositions] = useState<Positions>(loadPositions);

  const levelKey = drill.join("/");
  const vm = useMemo(
    () => buildView(QUADCOPTER_5IN, lookupQuadcopterModule, drill, { expanded }),
    [drill, expanded],
  );
  const hand = HAND_LAYOUTS[levelKey];
  const layout = useMemo(
    () => computeLayout(vm, hand, positions[levelKey] ?? {}, showGrounds),
    [vm, hand, positions, levelKey, showGrounds],
  );

  useEffect(() => {
    try {
      localStorage.setItem("uhd-viewer:positions", JSON.stringify(positions));
    } catch {
      /* storage unavailable: layout stays in memory */
    }
  }, [positions]);

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
  const onDrill = useCallback(
    (id: string) => {
      setDrill((d) => [...d, ...id.split("/")]);
      setSelection(null);
    },
    [],
  );

  return (
    <ReactFlowProvider>
      <div className="app">
        <Header
          vm={vm}
          onNavigate={(depth) => {
            setDrill((d) => d.slice(0, depth));
            setSelection(null);
          }}
          mode={mode}
          onMode={setMode}
          conductors={conductors}
          onConductors={setConductors}
          showGrounds={showGrounds}
          onGrounds={setShowGrounds}
        />
        <div className="workspace">
          <ActivityBar inspectorOpen={inspectorOpen} onInspector={() => setInspectorOpen((o) => !o)} />
          <main className="canvas">
            <Canvas
              key={levelKey}
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
          </main>
          {inspectorOpen && (
            <Inspector
              vm={vm}
              selection={selection}
              mode={mode}
              openLinks={openLinks}
              onSelect={setSelection}
              onDrill={onDrill}
              onToggleLink={onToggleLink}
              onToggleExpand={onToggleExpand}
            />
          )}
        </div>
      </div>
    </ReactFlowProvider>
  );
}
