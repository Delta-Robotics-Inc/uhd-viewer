import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import type { ChildLink } from "@uhd/types/index.js";
import type { UhdBundleDiagnostic } from "@uhd/types/bundle.js";
import { checkSystem } from "@uhd/system/checks.js";
import { buildView, withOverrides } from "./model/from-uhd";
import type { Classification } from "./model/classification";
import type { ViewLink } from "./model/types";
import { computeLayout, type ComputedLayout, type LevelLayout, type LinkLayout } from "./layout/layout";
import type { Pt } from "./canvas/routing";
import { loadBundle, sourceFromBundle, type LoadedSource } from "./source/source";
import type { ViewerLayout, ViewerOptions } from "./api";
import { sameLayout } from "./options";
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

/** Save once things settle, not on every frame of a drag. */
function useSaved(key: string, value: unknown, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const t = setTimeout(() => save(key, value), 250);
    return () => clearTimeout(t);
  }, [key, value, enabled]);
}

/**
 * Layout edits when a host owns them: edits go to `onChange`, debounced like
 * local saves, and a different layout the host passes later replaces them.
 * Nothing is sent that the host already has (on mount, or its own layout back).
 */
function useHostLayout(layout: ViewerLayout, host: ViewerLayout | undefined, apply: (layout: ViewerLayout) => void, onChange?: (layout: ViewerLayout) => void) {
  const handler = useRef(onChange);
  handler.current = onChange;
  // the layout the host has: what it passed in, or what it was last sent
  const known = useRef(host);
  const current = useRef(layout);
  current.current = layout;
  useEffect(() => {
    if (!handler.current || sameLayout(host, known.current)) return;
    known.current = host;
    if (!sameLayout(host, current.current)) apply(host ?? { positions: {}, links: {} });
  }, [host, apply]);
  useEffect(() => {
    if (!handler.current || sameLayout(layout, known.current)) return;
    const t = setTimeout(() => {
      known.current = layout;
      handler.current?.(layout);
    }, 250);
    return () => clearTimeout(t);
  }, [layout]);
}

/** Findings the viewer computes itself for every scenario: left out of the producer's list. */
const ownChecks = (d: UhdBundleDiagnostic) => d.validator === "uhd/checkSystem";

/** What is being dragged right now (see LiveLayout). */
export interface Live {
  nodes?: Set<string>;
  links?: Set<string>;
}

/** Initial view state from the URL: ?scenario=o4-on-vbat&mode=drc&detail=conductors&drill=stack&open=gnss_i2c&panel=checks */
const params = new URLSearchParams(window.location.search);
const list = (key: string) => params.get(key)?.split(",").filter(Boolean);

export interface AppProps extends ViewerOptions {
  /** Development only: absolute artifact bases are served through Vite's /@fs route. */
  fsRoute?: boolean;
}

/** Loads the UHD bundle (the viewer's only input), then shows it. */
export default function App(props: AppProps) {
  const { bundle, bundleUrl, resolveArtifact, fsRoute } = props;
  const [source, setSource] = useState<LoadedSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const options = { fsRoute, resolveArtifact };
    let cancelled = false;
    const loaded = (s: LoadedSource) => !cancelled && (setSource(s), setError(null));
    const failed = (e: Error) => !cancelled && setError(e.message);
    if (bundle) {
      try {
        loaded(sourceFromBundle(bundle, bundleUrl ?? window.location.href, options));
      } catch (e) {
        failed(e as Error);
      }
    } else if (bundleUrl) loadBundle(bundleUrl, options).then(loaded, failed);
    return () => {
      cancelled = true;
    };
  }, [bundle, bundleUrl, resolveArtifact, fsRoute]);
  if (error) return <div className="load-state error">{error}</div>;
  if (!bundle && !bundleUrl)
    return (
      <div className="load-state">
        No UHD bundle. Open this page with ?bundle=&lt;url&gt;, or serve one with uhd-viewer serve &lt;bundle.json&gt;.
      </div>
    );
  if (!source) return <div className="load-state">Loading UHD bundle…</div>;
  return <Viewer source={source} options={props} />;
}

function Viewer({ source, options }: { source: LoadedSource; options: ViewerOptions }) {
  const hosted = Boolean(options.onLayoutChange);
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
  // layout edits: local storage by default, the host's when it takes them (onLayoutChange)
  const [positions, setPositions] = useState<Positions>(() => (hosted ? options.layout?.positions ?? {} : load("uhd-viewer:positions", {})));
  const [overrides, setOverrides] = useState<Overrides>(() => load("uhd-viewer:overrides", {}));
  const [linkEdits, setLinkEdits] = useState<LinkEdits>(() => (hosted ? options.layout?.links ?? {} : load("uhd-viewer:links", {})));

  const scenario = SCENARIOS.find((s) => s.id === scenarioId) ?? SCENARIOS[0];
  const system = useMemo(() => withOverrides(scenario.system, overrides), [scenario, overrides]);
  const diagnostics = useMemo(() => checkSystem(system, scenario.lookup).diagnostics, [system, scenario]);

  const levelKey = drill.join("/");
  const vm = useMemo(
    () => buildView(system, scenario.lookup, drill, { expanded, overrides, diagnostics }),
    [system, scenario, drill, expanded, overrides, diagnostics],
  );
  const hand = HAND_LAYOUTS[levelKey];
  // while something is dragged only the links it touches are rerouted; all of them once it is dropped
  const [live, setLive] = useState<Live | null>(null);
  const previous = useRef<ComputedLayout | null>(null);
  const layout = useMemo(() => {
    const prev = previous.current;
    const next = computeLayout(vm, hand, positions[levelKey] ?? {}, showGrounds, linkEdits[levelKey], live && prev ? { previous: prev, ...live } : undefined);
    previous.current = next;
    return next;
  }, [vm, hand, positions, levelKey, showGrounds, linkEdits, live]);

  useSaved("uhd-viewer:positions", positions, !hosted);
  useSaved("uhd-viewer:overrides", overrides);
  useSaved("uhd-viewer:links", linkEdits, !hosted);
  const applyHostLayout = useCallback((l: ViewerLayout) => {
    setPositions(l.positions);
    setLinkEdits(l.links);
  }, []);
  useHostLayout(useMemo(() => ({ positions, links: linkEdits }), [positions, linkEdits]), options.layout, applyHostLayout, options.onLayoutChange);
  const editLink = useCallback(
    (linkId: string, patch: LinkLayout) =>
      setLinkEdits((e) => ({ ...e, [levelKey]: { ...(e[levelKey] ?? {}), [linkId]: { ...(e[levelKey]?.[linkId] ?? {}), ...patch } } })),
    [levelKey],
  );
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

  // stable callbacks and props, so the memoised chrome skips canvas-drag frames
  const onNavigate = useCallback((depth: number) => {
    setDrill((d) => d.slice(0, depth));
    setSelection(null);
  }, []);
  const scenarioList = useMemo(() => SCENARIOS.map((s) => ({ id: s.id, label: s.label })), [SCENARIOS]);
  const onScenario = useCallback((id: string) => {
    setScenarioId(id);
    setSelection(null);
    setDrill([]);
  }, []);
  const onReset = useCallback(() => {
    setPositions((p) => ({ ...p, [levelKey]: {} }));
    setLinkEdits((e) => ({ ...e, [levelKey]: {} }));
  }, [levelKey]);
  const defFor = useCallback((id?: string) => (id ? scenario.lookup(id) : undefined), [scenario]);
  const onPair = useCallback((l: ViewLink) => setPairLink(l.linkId), []);

  // the producer's and the host's findings describe the nominal build
  const hostDiagnostics = useMemo(
    () => (scenario.id === "nominal" ? [...source.hostDiagnostics, ...(options.diagnostics ?? [])].filter((d) => !ownChecks(d)) : []),
    [scenario, source, options.diagnostics],
  );
  const errors = diagnostics.filter((d) => d.severity === "error").length + hostDiagnostics.filter((d) => d.severity === "error").length;
  const pair = pairLink ? vm.links.find((l) => l.linkId === pairLink) : undefined;

  return (
    <ReactFlowProvider>
      <div className="app">
        <Header
          vm={vm}
          onNavigate={onNavigate}
          scenarios={scenarioList}
          scenario={scenario.id}
          onScenario={onScenario}
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
              onLayout={editLink}
              onLive={setLive}
              onPins={onPins}
            />
            <Toolbar
              onReset={onReset}
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
              hostDiagnostics={hostDiagnostics}
              defFor={defFor}
              resolveArtifact={source.resolveArtifact}
              appearance={source.display.spatial?.appearance}
              bSlotsFor={bSlotsFor}
              overrides={overrides}
              onOverride={onOverride}
              onSelect={setSelection}
              onDrill={onDrill}
              onToggleLink={onToggleLink}
              onToggleExpand={onToggleExpand}
              onPair={onPair}
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
