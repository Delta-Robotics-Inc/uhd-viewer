import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import type { ChildLink } from "@uhd/types/index.js";
import type { UhdBundleDiagnostic } from "@uhd/types/bundle.js";
import { buildView, levelModule, withOverrides } from "../model/from-uhd";
import { systemDiagnostics } from "../model/diagnostics";
import type { Classification } from "../model/classification";
import { isolate, presentKeys, toggleIsolated } from "../model/isolate";
import type { ViewLink } from "../model/types";
import { computeLayout, type ComputedLayout, type LevelLayout, type LinkLayout } from "../layout/layout";
import { tapRails } from "../layout/taps";
import type { Pt } from "../canvas/routing";
import { loadBundle, sourceFromBundle, type LoadedSource } from "../source/source";
import type { ViewerEvent, ViewerLayout, ViewerOptions, ViewerSelection } from "../api";
import { sameLayout } from "../options";
import type { Selection } from "../canvas/Canvas";
import type { Goto, NodeMenuItem, Panel } from "../chrome/Chrome";
import type { CadSelection } from "../cad/CadView";
import { defAt } from "../cad/model";
import type { CommandBus } from "../host/channel";
import { HostContext, type HostActions } from "../host/context";
import { pairEnds } from "../chrome/PairView";
import { cadHostSelection, cadSelectTarget, drillTarget, focusTarget, fullId, hostSelection, selectTarget, selectionKey } from "../host/targets";


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

/** Below this width the panel starts closed: open, it would cover most of the view. */
const NARROW = 760;

/** Initial view state from the URL: ?scenario=o4-on-vbat&mode=drc&detail=conductors&drill=stack&open=gnss_i2c&panel=checks */
const urlParams = () => new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);

export interface AppProps extends ViewerOptions {
  /** Development only: absolute artifact bases are served through Vite's /@fs route. */
  fsRoute?: boolean;
  /** The host channel (mount.tsx): its messages, where events go, and which open actions the host takes. */
  host?: HostLink;
}

export interface HostLink {
  bus: CommandBus;
  emit: (event: ViewerEvent) => void;
  /** The host opens sources (the viewer offers OPEN SOURCE). */
  source: boolean;
  /** The host opens artifact files (instead of a new tab). */
  artifact: boolean;
  /** The host opens modules on their own (double-click), `onOpenModule`. */
  module?: boolean;
  /** The host shows the pair view (instead of the viewer's own over the diagram). */
  pair?: boolean;
}

/** Loads the UHD bundle (the viewer's only input): the source once loaded, or why not. */
export function useViewerSource(props: Pick<AppProps, "bundle" | "bundleUrl" | "resolveArtifact" | "fsRoute">): { source: LoadedSource | null; error: string | null; empty: boolean } {
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
  return { source, error, empty: !bundle && !bundleUrl };
}

/**
 * The viewer's state and behaviour for one loaded bundle: what is drawn, what
 * is selected, the drill level, the classification, layout edits, the host
 * channel. Shells read it through `useViewer()` inside `UhdViewer`; the
 * canvases, inspector panels, toolbar and legend are views of it.
 */
export function useViewerController(source: LoadedSource, options: ViewerOptions, host?: HostLink) {
  const [params] = useState(urlParams);
  const list = (key: string) => params.get(key)?.split(",").filter(Boolean);
  const hosted = Boolean(options.onLayoutChange);
  const SCENARIOS = source.scenarios;
  const HAND_LAYOUTS: Record<string, LevelLayout> = source.display.diagram?.layouts ?? {};
  const DEFAULT_EXPANDED = source.display.diagram?.expanded ?? [];
  const [scenarioId, setScenarioId] = useState(params.get("scenario") ?? "nominal");
  const [drill, setDrill] = useState<string[]>(list("drill") ?? []);
  const [mode, setModeState] = useState<Classification>((params.get("mode") as Classification) ?? "domain");
  // legend entries isolated in the current classification (?isolate=power,uart): the rest of the level fades
  const [isolated, setIsolated] = useState<ReadonlySet<string>>(() => new Set(list("isolate") ?? []));
  // another classification has other entries: nothing of the old one stays isolated
  const setMode = useCallback((m: Classification) => {
    setModeState((was) => {
      if (was !== m) setIsolated(new Set());
      return m;
    });
  }, []);
  const onIsolate = useCallback((key: string, add = false) => setIsolated((cur) => toggleIsolated(cur, key, add)), []);
  const clearIsolated = useCallback(() => setIsolated((cur) => (cur.size ? new Set() : cur)), []);
  const [conductors, setConductors] = useState(params.get("detail") === "conductors");
  const [showGrounds, setShowGrounds] = useState(params.get("grounds") === "1");
  const [expanded, setExpanded] = useState<Set<string>>(new Set([...DEFAULT_EXPANDED, ...(list("expand") ?? [])]));
  const [openLinks, setOpenLinks] = useState<Set<string>>(new Set(list("open") ?? source.display.diagram?.openLinks ?? []));
  const [selection, setSelection] = useState<Selection>(
    params.get("select") ? { kind: params.get("select")!.startsWith("link:") ? "link" : "node", id: params.get("select")!.replace(/^(link|node):/, "") } : null,
  );
  // a narrow host (a VS Code panel beside an editor) starts with the view, not the panel over it (PB-861)
  const [panel, setPanel] = useState<Panel | null>((params.get("panel") as Panel) ?? (typeof window !== "undefined" && window.innerWidth < NARROW ? null : "hierarchy"));
  const [pairLink, setPairLink] = useState<string | null>(params.get("pair"));
  const [view, setView] = useState<"diagram" | "3d">(params.get("view") === "3d" ? "3d" : "diagram");
  // layout edits: local storage by default, the host's when it takes them (onLayoutChange)
  const [positions, setPositions] = useState<Positions>(() => (hosted ? options.layout?.positions ?? {} : load("uhd-viewer:positions", {})));
  const [overrides, setOverrides] = useState<Overrides>(() => load("uhd-viewer:overrides", {}));
  const [linkEdits, setLinkEdits] = useState<LinkEdits>(() => (hosted ? options.layout?.links ?? {} : load("uhd-viewer:links", {})));

  const scenario = SCENARIOS.find((s) => s.id === scenarioId) ?? SCENARIOS[0];
  const system = useMemo(() => withOverrides(scenario.system, overrides), [scenario, overrides]);
  // the root's checks, and each board's on its own (model/diagnostics.ts)
  const diagnostics = useMemo(() => systemDiagnostics(system, scenario.lookup), [system, scenario]);

  const levelKey = drill.join("/");
  const vm = useMemo(
    () => buildView(system, scenario.lookup, drill, { expanded, overrides, diagnostics, grounds: showGrounds }),
    [system, scenario, drill, expanded, overrides, diagnostics, showGrounds],
  );
  // what the canvas draws: the level, with each supply rail as taps beside the parts it feeds
  const drawn = useMemo(() => tapRails(vm), [vm]);
  // what the legend lists as on this level, and what stays while entries of it are isolated
  const present = useMemo(() => presentKeys(drawn, mode), [drawn, mode]);
  const isolation = useMemo(() => isolate(drawn, mode, isolated), [drawn, mode, isolated]);
  // Escape shows everything again (unless it is typed into a field, or something else took it)
  useEffect(() => {
    if (!isolated.size || typeof window === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input, textarea, select, [contenteditable='true']")) return;
      clearIsolated();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isolated, clearIsolated]);
  const hand = HAND_LAYOUTS[levelKey];
  // while something is dragged only the links it touches are rerouted; all of them once it is dropped
  const [live, setLive] = useState<Live | null>(null);
  const previous = useRef<ComputedLayout | null>(null);
  const layout = useMemo(() => {
    const prev = previous.current;
    const next = computeLayout(drawn, hand, positions[levelKey] ?? {}, showGrounds, linkEdits[levelKey], live && prev ? { previous: prev, ...live } : undefined);
    previous.current = next;
    return next;
  }, [drawn, hand, positions, levelKey, showGrounds, linkEdits, live]);

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
  const onPair = useCallback(
    (l: ViewLink) => {
      if (!host?.pair) return setPairLink(l.linkId);
      const ends = pairEnds(vm, l);
      host.emit({ type: "uhd-viewer:openPair", linkId: fullId(drill, l.linkId), a: fullId(drill, ends.a.node), b: fullId(drill, ends.b.node) });
    },
    [host, vm, drill],
  );
  // a finding or a board drawing can lead to another level: open it, then select there
  const onGoto = useCallback((g: Goto) => {
    setDrill((d) => (d.join("/") === g.drill.join("/") ? d : g.drill));
    setSelection(g.selection);
  }, []);
  const levelDef = useMemo(() => levelModule(system, drill, scenario.lookup).def, [system, drill, scenario]);

  // the producer's and the host's findings describe the nominal build
  const hostDiagnostics = useMemo(
    () => (scenario.id === "nominal" ? [...source.hostDiagnostics, ...(options.diagnostics ?? [])].filter((d) => !ownChecks(d)) : []),
    [scenario, source, options.diagnostics],
  );
  const errors = diagnostics.filter((d) => d.severity === "error").length + hostDiagnostics.filter((d) => d.severity === "error").length;
  const pair = pairLink ? vm.links.find((l) => l.linkId === pairLink) : undefined;

  // ---- the host channel: messages in, events out (README, "Host messages")
  const [centre, setCentre] = useState<{ id: string; seq: number }>();
  // a host's select brings what it selected into view (unless it says not to)
  const [reveal, setReveal] = useState<{ selection: NonNullable<Selection>; seq: number }>();
  const [cadFocus, setCadFocus] = useState<{ path: string; seq: number; kind?: "node" | "link" | "none"; look?: boolean }>();
  const [cadSelection, setCadSelection] = useState<ViewerSelection | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const seq = useRef(0);
  // what a message applies to: the state of the latest render
  const latest = useRef({ system, lookup: scenario.lookup, drill, expanded, vm, view });
  latest.current = { system, lookup: scenario.lookup, drill, expanded, vm, view };
  useEffect(() => {
    if (!host) return;
    return host.bus.subscribe((m) => {
      const { system: sys, lookup, drill: d, expanded: ex, vm: v, view: shownView } = latest.current;
      const sameDrill = (next: string[]) => (cur: string[]) => (cur.join("/") === next.join("/") ? cur : next);
      setMenu(null);
      switch (m.type) {
        case "uhd-viewer:focus": {
          const t = focusTarget(sys, lookup, m.path, { drill: d, expanded: ex });
          setDrill(sameDrill(t.drill));
          setSelection(t.selection);
          setPairLink(null);
          // the inspector shows the focused module
          setPanel((p) => p ?? "hierarchy");
          if (t.selection) {
            const n = ++seq.current;
            setCentre({ id: t.selection.id, seq: n });
            setCadFocus({ path: fullId(t.drill, t.selection.id), seq: n });
          }
          return;
        }
        case "uhd-viewer:select": {
          const sel = selectTarget(v, d, m.ids);
          if (sel !== undefined) setSelection(sel);
          if (sel && m.reveal !== false && shownView !== "3d") setReveal({ selection: sel, seq: ++seq.current });
          // the 3D view selects too (a module's body or a mate), without moving the camera
          if (shownView === "3d") {
            const t = cadSelectTarget(sys, lookup, d, sel, m.ids);
            if (t) setCadFocus({ ...t, seq: ++seq.current, look: false });
          }
          return;
        }
        // the level: the diagram's, and the module the 3D view shows (the root: the whole assembly)
        case "uhd-viewer:drill":
          setDrill(sameDrill(drillTarget(sys, lookup, m.path)));
          setSelection(null);
          setPairLink(null);
          return;
        case "uhd-viewer:setView":
          setView(m.view);
          return;
      }
    });
  }, [host]);
  const readySent = useRef(false);
  useEffect(() => {
    if (!host || readySent.current) return;
    readySent.current = true;
    host.emit({ type: "uhd-viewer:ready" });
  }, [host]);
  // every selection change, in the view on screen, once
  const diagramSelection = useMemo(() => hostSelection(vm, drill, selection, levelDef.id), [vm, drill, selection, levelDef]);
  const shown = view === "3d" ? cadSelection : diagramSelection;
  const sentSelection = useRef("");
  useEffect(() => {
    const key = selectionKey(shown);
    if (!host || key === sentSelection.current) return;
    sentSelection.current = key;
    host.emit({ type: "uhd-viewer:selectionChanged", selection: shown });
  }, [host, shown]);
  const onCadSelect = useCallback(
    (s: CadSelection) => setCadSelection(cadHostSelection(s, (path) => defAt(system, scenario.lookup, path))),
    [system, scenario],
  );
  const hostActions = useMemo<HostActions>(
    () => ({
      openSource: host?.source ? (defId, instancePath) => host.emit({ type: "uhd-viewer:openSource", defId, ...(instancePath ? { instancePath } : {}) }) : undefined,
      openArtifact: host?.artifact ? (defId, artifactId) => host.emit({ type: "uhd-viewer:openArtifact", defId, artifactId }) : undefined,
      openModule: host?.module ? (path) => host.emit({ type: "uhd-viewer:openModule", path }) : undefined,
    }),
    [host?.source, host?.artifact, host?.module, host?.emit],
  );
  /**
   * Double-click on a node: a module opens on its own when the host takes it
   * (its new tab); otherwise, or for a net's junction, it expands in place.
   */
  const onOpenNode = useCallback(
    (id: string) => {
      const node = vm.nodes.find((n) => n.id === id);
      if (hostActions.openModule && node?.defId && !node.net && !node.tapOf && !node.sheetPort) hostActions.openModule(fullId(drill, id));
      else onToggleExpand(id);
    },
    [vm, drill, hostActions, onToggleExpand],
  );
  const onNodeContext = useCallback((id: string, x: number, y: number) => setMenu({ id, x, y }), []);
  const menuNode = menu ? vm.nodes.find((n) => n.id === menu.id) : undefined;
  const menuItems: NodeMenuItem[] = [];
  if (menuNode?.defId && hostActions.openModule && !menuNode.net) {
    const path = fullId(drill, menuNode.id);
    menuItems.push({ label: "OPEN IN NEW TAB", run: () => hostActions.openModule!(path) });
  }
  if (menuNode?.defId && hostActions.openSource) {
    const { defId } = menuNode;
    menuItems.push({ label: "OPEN SOURCE", run: () => hostActions.openSource!(defId, fullId(drill, menuNode.id)) });
  }
  if (menuNode?.childCount) {
    menuItems.push({ label: menuNode.expanded ? "COLLAPSE" : "EXPAND IN PLACE", run: () => onToggleExpand(menuNode.id) });
    menuItems.push({ label: "OPEN AS CANVAS", run: () => onDrill(menuNode.id) });
  }
  const closeMenu = useCallback(() => setMenu(null), []);


  return {
    source,
    options,
    // the model on screen
    scenario,
    scenarios: scenarioList,
    onScenario,
    system,
    vm,
    drawn,
    layout,
    hand,
    levelKey,
    levelDef,
    drill,
    topLevel: drill.length === 0,
    diagnostics,
    hostDiagnostics,
    errors,
    defFor,
    bSlotsFor,
    // what the user chose
    view,
    setView,
    mode,
    setMode,
    conductors,
    setConductors,
    showGrounds,
    setShowGrounds,
    // legend entries isolated (the rest fades): the keys held, what stays on this level, what the level has
    isolated,
    isolation,
    present,
    onIsolate,
    clearIsolated,
    panel,
    setPanel,
    selection,
    setSelection,
    openLinks,
    overrides,
    pair,
    setPairLink,
    // actions
    onNavigate,
    onDrill,
    onGoto,
    onPair,
    onReset,
    onToggleLink,
    onToggleExpand,
    onMove,
    onOverride,
    editLink,
    onPins,
    setLive,
    // the host channel and what follows from it
    centre,
    reveal,
    cadFocus,
    onCadSelect,
    hostActions,
    onOpenNode,
    onNodeContext: hostActions.openSource || hostActions.openModule ? onNodeContext : undefined,
    menu,
    menuItems,
    closeMenu,
  };
}

/** Everything a view of the loaded model reads (see useViewerController). */
export type ViewerController = ReturnType<typeof useViewerController>;

const ViewerContext = createContext<ViewerController | null>(null);

/** The viewer's state, inside `UhdViewer` (or `ViewerProvider`). */
export function useViewer(): ViewerController {
  const c = useContext(ViewerContext);
  if (!c) throw new Error("useViewer: render inside <UhdViewer>");
  return c;
}

/** The viewer's state for a loaded source, for the components inside. */
export function ViewerProvider({ source, options, host, children }: { source: LoadedSource; options: ViewerOptions; host?: HostLink; children?: ReactNode }) {
  const c = useViewerController(source, options, host);
  return (
    <HostContext.Provider value={c.hostActions}>
      <ReactFlowProvider>
        <ViewerContext.Provider value={c}>{children}</ViewerContext.Provider>
      </ReactFlowProvider>
    </HostContext.Provider>
  );
}

export interface UhdViewerProps extends AppProps {
  /** The views of the model: canvases, panels, the shell's own chrome. */
  children?: ReactNode;
}

/**
 * Loads the bundle, then provides the viewer's state to `children`. While
 * loading, or when the bundle cannot be read, it says so in place.
 */
export function UhdViewer({ children, ...props }: UhdViewerProps) {
  const { source, error, empty } = useViewerSource(props);
  if (error) return <div className="load-state error">{error}</div>;
  if (empty)
    return (
      <div className="load-state">
        No UHD bundle. Open this page with ?bundle=&lt;url&gt;, or serve one with uhd-viewer serve &lt;bundle.json&gt;.
      </div>
    );
  if (!source) return <div className="load-state">Loading UHD bundle…</div>;
  return (
    <ViewerProvider source={source} options={props} host={props.host}>
      {children}
    </ViewerProvider>
  );
}
