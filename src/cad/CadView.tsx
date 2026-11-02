/**
 * 3D view (PB-775): the quadcopter assembled from UHD links, with interface
 * geometry resolved through three binding directions, mounting hardware
 * placed from the harnesses' fastener stacks, wire harnesses drawn from their
 * own routed artifacts (placed by the parts they connect), and callout labels.
 *
 * What the view shows (camera, selection, visibility, sections, explode,
 * highlight, isolation, named views) is one view state (./state, PB-1178):
 * the URL, the host's messages, `window.__cad` and the live-tab bridge read
 * and write the same store, and the toolbar and the inspector are views of
 * it. The inspector card is ./CadInspector.tsx, the toolbar ./CadToolbar.tsx.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import type { ModuleDef } from "@uhd/types/index.js";
import type { ModuleLookup } from "@uhd/system/index.js";
import type { GeometryManifest, MateEdge } from "@uhd/system/geometry.js";
import type { UhdBundleDiagnostic } from "@uhd/types/bundle.js";
import type { LoadedSource } from "../source/source";
import type { ScopedDiagnostic } from "../model/diagnostics";
import { anchorOf, findingAnchors } from "./findings";
import { AnnotLayer, DEFAULT_SHOWN, FindingsControl, MAX_OPEN_FINDINGS, boundsOf, findingForHost, componentIn, drawn as drawnObj, drcMarkers, findingInputs, findingsAnchors, instanceAt, isolationOf, partCallout, partFacts, recordsOf, removeRecords, upsertRecords, type AnnotHost, type FindingAnchorPoint, type FindingAnchors, type FindingSeverity, type PartHit, type PresenceChip, type SceneNode } from "./annot";
import { DIRECTIONS, defAt, explodeParts, glbFor, interfaceRows, loadManifests, type CadBody, type CadModel, type Direction, type InterfaceRow } from "./model";
import { useTheme, tokenColor } from "../theme/ThemeProvider";
import { DEFAULT_SCENE_ACCENT, DEFAULT_SCENE_HIGHLIGHT, DEFAULT_ZOOM_TO_CURSOR, EXPLODE_STILL_MM, cadWrapper, cameraBetween, createScene, dominantNormal, explodeCamera, principalNormal, focusMaterial, frameGizmo, glbCache, loadGlb, loadModel, lookAlong, materialFor, needsRefit, proceduralGeometry, toMatrix4, triangleNormal, type AntialiasMode, type LoadedModel, type SceneColors, type SceneHandle } from "./scene";
import { buildAll, bvhStats, pick } from "./render/pick";
import { setMeshLook } from "./render/looks";
import { paintComponent, swapMaterial } from "./render/glow";
import { instancePathIn, isPlaceholder, partInstanceIdOf } from "./render/ids";
import { observeScene, type CadObservation, type LoadState } from "./render/observe";
import { attachSceneTelemetry } from "../telemetry";
import { LabelLayer, partSubtitle, type LabelItem, type LabelKind } from "./labels";
import { exactRequest, measureBounds, measureCylinder, measureFaceFace, measurePointFace, measurePointPoint, meshFace, objectFace, orientByFace, pickRef, placeOnFace, refFace, toMat4, toPartFrame, type FaceSource, type MeasureKind, type MeasureRef, type MeshFaceInput } from "./measure";
import { TourPlayback, parseTour, tourOps, type Tour } from "./tour";
import { LoadingScreen, attachLoadTracker, glbPlacements, useLoadTiers, type LoadSnapshot, type LoadTier } from "./loading";
import { resolvePlanes, type ScopedSectionPlane } from "./sections/planes";
import { SequencePlayer, applyCadPose, applyUrlState, fetchSequenceBeside, resolveForCad, sequenceUrlState, type PlayerSnapshot, type SequenceCommand, type SequenceFile } from "./sequence";
import { Icon } from "../canvas/Icon";
import { layOutRow } from "./row";
import { intoScope, outOfScope, scopeRef, scopedModel, scopedPlacements, shownSummary } from "./scope";
import { CadInspector } from "./CadInspector";
import { CadToolbar, toolbarAvailability } from "./CadToolbar";
import { GcodeView } from "./GcodeView";
import { gcodeEntry } from "../gcode/entry";
import { cableSummary, harnessMaterial, routeManifest } from "./harness";
import type { ViewerSnapshotMessage } from "../api";
import { HUMAN, SYSTEM, presentation, presentationFromDisplay, same, serializeViewState, useViewSlice, viewHub, type Actor, type Batch, type CameraState, type PlacementVerb, type SectionPlane, type ViewHub, type ViewSelection, type ViewState } from "./state";
import type { PlacementFacts, SetOp } from "../api";
import { focusSelection, freshFocus, glowPlan, holdsPath, matchesPath, placeholderSummary, shortRecordId, shownBy, viewUp, type GlowPlan, type PlaceholderSummary } from "./state/view";

/** Render knobs from the page URL (read when the view mounts, so importing the library touches no window). */
const urlParams = () => new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);

/** Explode distance (mm per mate level) at "exploded". */
const EXPLODE_MM = 26;
/** A camera drag reports its camera to the view state at most this often (ms); the host saves after 400 ms of quiet. */
const CAMERA_REPORT_MS = 200;
/** DEFAULT (R1-A, E3): "Look along normal" turns the camera in this long (ms), eased. */
const LOOK_ALONG_MS = 450;
/**
 * The model's drawn bounds when the camera was last fitted or kept, per system and scope (R1-A, M1): the view
 * remounts on a rebuild or a tab switch, and a model of about the same size keeps the camera the person left.
 */
const fittedBoxes = new Map<string, THREE.Box3>();
/** Pages opened with `?focus=1` frame the focus once per system and scope, not on every rebuild (R1-A, M1). */
const urlFocusDone = new Set<string>();

/** Instance display names: ChildModuleRef names by path ("arm_fl" → "Front-left arm", "arm_fl/motor" → "Motor"). */
function instanceNames(system: ModuleDef, lookup: ModuleLookup): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: ModuleDef, prefix: string) => {
    for (const c of d.children ?? []) {
      const path = prefix ? `${prefix}/${c.id}` : c.id;
      const def = lookup(c.moduleDefId);
      out.set(path, c.name ?? def?.name ?? c.id);
      if (def) walk(def, path);
    }
  };
  walk(system, "");
  return out;
}


/** A selection in the 3D view, by instance path (the view state's `selection`). */
export type CadSelection = ViewSelection;

interface BodyRec {
  body: CadBody;
  obj: THREE.Group;
  base: THREE.Matrix4;
  centre: THREE.Vector3; // local bbox centre (CAD coords)
  top: THREE.Vector3; // local bbox top centre
  offset: THREE.Vector3;
  /** Local bounds (CAD coords). */
  box: THREE.Box3;
  /**
   * Named bodies of a multi-body artifact (the manifest's `bodies`: an
   * enclosure's back and lid). Exploding moves each away from the largest
   * along the line between their centres (`dir`, in the node's own glTF space).
   */
  /**
   * Named bodies of one artifact that come apart: `clear` is how far (CAD
   * mm) one must go along `cadDir` before it is out of the fixed body's box.
   */
  parts: { obj: THREE.Object3D; base: THREE.Vector3; cadDir: THREE.Vector3; cadBox: THREE.Box3; clear: number; volume: number; travel: THREE.Vector3; toLocal?: THREE.Matrix3 }[];
  /** Content hash of the model drawn (PB-1175: a hot swap keeps a body whose hash and look are unchanged). */
  hash: string;
  /** The view sidecar's nodes (instance paths and bounds), when the body came from one: findings' anchors (PB-1184). */
  nodes?: SceneNode[];
  /** Definition, GLB and appearance hints it was drawn with. */
  look: string;
}

interface HardwareRec {
  obj: THREE.Group;
  base: THREE.Matrix4;
  harness: string;
  structure: string;
  mounted: string;
  normal: THREE.Vector3;
  atMm: number;
  direction: 1 | -1;
  offset: THREE.Vector3;
}

/** Host openFinding messages already pinned, for the page's lifetime (gate R1). */
const findingsPinned = new WeakSet<object>();

/** The actor for writes made through `window.__cad.set` (a script driving the page). */
const SCRIPT: Actor = { kind: "host", id: "__cad" };
/** The actor for the explode amount a sequence play leaves (W2-C's player). */
const SEQUENCE: Actor = { kind: "host", id: "sequence" };
/** The actor for the view a host's snapshot opens on (PB-1180). */
const SNAPSHOT: Actor = { kind: "host", id: "snapshot" };

/** A snapshot is this view's: the same level, on the 3D view. */
const snapshotFor = (m: ViewerSnapshotMessage, at: string) => m.level === at && (m.view === "3d" || m.view === "cad");

/** World points to CSS pixels on the canvas, and the depth along the view axis (negative behind). */
function projectPoints(h: SceneHandle, points: [number, number, number][]): [number, number, number][] {
  const el = h.renderer.domElement;
  const w = el.clientWidth;
  const hh = el.clientHeight;
  h.camera.updateMatrixWorld();
  const forward = new THREE.Vector3();
  h.camera.getWorldDirection(forward);
  return points.map((p) => {
    const v = new THREE.Vector3(...p);
    const depth = v.clone().sub(h.camera.position).dot(forward);
    v.project(h.camera);
    const r = (n: number) => Math.round(n * 100) / 100;
    return [r(((v.x + 1) / 2) * w), r(((1 - v.y) / 2) * hh), r(depth)];
  });
}

export function CadView({
  system,
  lookup,
  source,
  diagnostics = [],
  hostDiagnostics = [],
  focusOn,
  findingOn,
  onSelect,
  inspector = true,
  scope,
  emptyHint,
  onLoadState,
  onOpenModule,
  onInspect,
  hub: givenHub,
  sequence,
  onLoadTier,
  presence,
}: {
  /** The root system: every path a host gives or hears is from it. */
  system: ModuleDef;
  lookup: ModuleLookup;
  source: LoadedSource;
  /** The viewer's own checks (root and boards) and the host's findings, pinned to the model where they name something placed. */
  diagnostics?: ScopedDiagnostic[];
  hostDiagnostics?: UhdBundleDiagnostic[];
  /**
   * A host's focus or select, by instance path; `seq` tells repeats apart. A
   * node selects the module's body and (with `look`, the default) looks at it;
   * a link selects the mate of that path (`owner/link`); `none` clears.
   */
  focusOn?: { path: string; seq: number; kind?: "node" | "link" | "none"; look?: boolean };
  /**
   * A host's openFinding (gate R1, R1-E's D7): pin that finding's callout open, with the findings layer on and its
   * severity shown; `seq` tells repeats apart. Framing is the focus's job (the host sends one first).
   */
  findingOn?: { id: string; code: string; path?: string; seq: number };
  /** Show the inspector card (the app's panel toggle; closed by default on a narrow view, PB-861). */
  inspector?: boolean;
  /** Every selection change (for the host), by paths from the root. */
  onSelect?: (sel: CadSelection) => void;
  /**
   * The module to show, by instance path from the root (PB-897): that module
   * alone, in its own coordinates. Absent or empty: the whole assembly.
   */
  scope?: string[];
  /** What a host adds where a module has nothing to draw (how its model is made). */
  emptyHint?: ReactNode;
  /**
   * The model loads' progress (PB-1175; the loading screen is wave 2's): called as each model arrives, and
   * once more with `phase: "ready"`. The same state is `window.__cad.loading()`.
   */
  onLoadState?: (state: LoadState) => void;
  /**
   * Double-click on a part (PB-1072): open it on its own, by instance path from the root; `view: "3d"` for a
   * part with nothing inside (a bought part: its own model). Not given: the part is selected and framed.
   */
  onOpenModule?: (path: string, view?: "3d") => void;
  /** The view state to read and write (default: the page's, ./state/hub.ts). */
  hub?: ViewHub;
  /** A built `.protoboard/build/sequence.json` the host has (else it is fetched beside the bundle, PB-1183). */
  sequence?: SequenceFile;
  /** The person chose a lighter load on the loading screen ("coarse" or "boxes", PB-1177; W2-B's tiers). */
  onLoadTier?: (tier: LoadTier) => void;
  /**
   * Who is working where (PB-1184; W3-A's bridge replies): "claude is working on U3", a chip near the part.
   * Refs are instance paths from the root. Also settable with `window.__cad.presence(list)`.
   */
  presence?: PresenceChip[];
  /** Show a part in the host's own Inspector (`uhd-viewer:inspect`), by instance path from the root (R1-C's D3). */
  onInspect?: (path: string, defId?: string) => void;
}) {
  const display = source.display.spatial ?? {};
  const resolve = source.resolveArtifact;
  const appearanceOf = (defId: string) => display.appearance?.[defId];
  // the module shown: the root, or the one at `scope` (a path that names none shows the root)
  const scopeKey = (scope ?? []).join("/");
  const scoped = useMemo(() => (scopeKey ? defAt(system, lookup, scopeKey.split("/")) : undefined), [system, lookup, scopeKey]);
  const at = scoped ? scopeKey : "";
  const shown = scoped ?? system;
  const hints = useMemo(
    () => scopedPlacements(display.placements, at),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source, at],
  );
  // ---- the view state (PB-1178): one store for the URL, the host, __cad and the bridge ----
  const [hub] = useState(() => givenHub ?? viewHub());
  const store = hub.store;
  // this view shows `at`: its own camera, selection, sections and explode come back (CadView remounts per scope);
  // before paint and before the effects below read the camera, and not during a render (the store tells listeners)
  useLayoutEffect(() => store.enterScope(at), [store, at]);
  const sel = useViewSlice(store, (s) => s.selection);
  const direction = useViewSlice(store, (s) => s.direction) as Direction;
  const vis = useViewSlice(store, (s) => s.visibility);
  const sections = useViewSlice(store, (s) => s.sections);
  const explodeT = useViewSlice(store, (s) => s.explode.t);
  const explodeStep = useViewSlice(store, (s) => s.explode.step);
  const highlight = useViewSlice(store, (s) => s.highlight);
  const isolation = useViewSlice(store, (s) => s.isolation);
  /** The person's own writes (a click, a toggle): applied as they come, logged as the user's. */
  const write = (ops: unknown[], label?: string) => {
    const r = store.dispatch(ops, { actor: HUMAN, ...(label ? { label } : {}) });
    if (r && "error" in r) console.warn(`[cad] ${r.error}`);
  };
  const setSel = (s: CadSelection) => write([{ op: "select", selection: Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) }]);
  const setVis = (k: keyof ViewState["visibility"], v: unknown) => write([{ op: "set", path: ["visibility", k], value: v }]);
  const setDirection = (d: Direction) => write([{ op: "set", path: ["direction"], value: d }]);
  const showLabels = vis.labels;
  const labelKinds = useMemo(() => new Set<LabelKind>(vis.labelKinds), [vis.labelKinds]);
  const showFrames = vis.frames;
  const showWires = vis.wires;
  const showHardware = vis.hardware;
  // findings are pinned by default only when a host sent some that land on the model (D18); `findings=1|0` overrides
  const findingsChoice = vis.findings ?? undefined;
  const xray = vis.xray;
  const hidden = vis.hidden;
  const section: SectionPlane | null = sections[0] ?? null;
  const setSection = (s: SectionPlane | null) => write([{ op: "section", sections: s ? [s] : [] }]);
  const exploded = explodeT > 0.5;
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<SceneHandle | null>(null);
  const labelsRef = useRef<LabelLayer | null>(null);
  const bodies = useRef(new Map<string, BodyRec>());
  const hardware = useRef<HardwareRec[]>([]);
  const harnessGroup = useRef(new THREE.Group());
  const harnessObjs = useRef(new Map<string, THREE.Group>());
  const [params] = useState(urlParams);
  /** The G-code tab (PB-1192, W4-B; DEFAULT entry point `?gcode=<url>`): the G-code viewer instead of the model. */
  const gcodeRaw = params.get("gcode");
  // same origin or a blob: of this page only, the name decoded without throwing (wave 4 gate, src/gcode/entry.ts)
  const gcode = gcodeEntry(gcodeRaw, typeof location !== "undefined" ? location.href : "http://localhost/");
  const explode = useRef({ value: explodeT, target: explodeT });
  const [manifests, setManifests] = useState<Map<string, GeometryManifest> | null>(null);
  const [loaded, setLoaded] = useState(0);
  /** Every model load has finished (or failed). */
  const [settled, setSettled] = useState(false);
  /** The camera's move while the model comes apart or together: from where it was to a fit of where it ends. */
  const cameraTween = useRef<{ from: [THREE.Vector3, THREE.Vector3]; to: [THREE.Vector3, THREE.Vector3]; start: number } | null>(null);
  /** A timed camera move (R1-A, E3 "Look along normal"): eased from one pose to another over `ms`. */
  const viewTween = useRef<{ from: { position: THREE.Vector3; target: THREE.Vector3 }; to: { position: THREE.Vector3; target: THREE.Vector3 }; start: number; ms: number } | null>(null);
  /** The face under the person's last pick (world normal) and what that pick selected (R1-A, E3). */
  const lastPick = useRef<{ key: string; normal: THREE.Vector3 } | null>(null);
  /** The model info card's note after an explode that moved nothing (R1-A, M11). */
  const [explodeNote, setExplodeNote] = useState<string | null>(null);
  const [labelMenu, setLabelMenu] = useState(false);
  const [sectionMenu, setSectionMenu] = useState(false);
  const present = hub.opening.present;
  /** `?chrome=none` (W2-D's document mode, PB-1109): the model alone, no toolbar, caption, notes or inspector. */
  const noChrome = hub.opening.chrome === "none";
  const selRef = useRef(sel);
  selRef.current = sel;
  const [notes, setNotes] = useState<string[]>([]);
  const loadState = useRef<LoadState>({ phase: "loading", total: 0, done: 0, failed: 0, bytes: 0, swapped: 0, kept: 0, started: 0, ms: 0 });
  const loadListener = useRef(onLoadState);
  loadListener.current = onLoadState;
  /** `__cad.refresh()`: load every model again (the cache checks each one's content and keeps what is unchanged). */
  const [reload, setReload] = useState(0);
  const [caption, setCaption] = useState<[string, string] | null>(null);
  const openModuleRef = useRef(onOpenModule);
  openModuleRef.current = onOpenModule;
  const inspectHandler = useRef(onInspect);
  inspectHandler.current = onInspect;
  // the loading screen (W2-C, PB-1177): fed by every GLB load and by this view's counts, compiles and first frame
  const [loadSnap, setLoadSnap] = useState<LoadSnapshot | null>(null);
  const tracker = useRef<ReturnType<typeof attachLoadTracker> | null>(null);
  useEffect(() => {
    const t = attachLoadTracker();
    tracker.current = t;
    const off = t.tracker.subscribe(setLoadSnap);
    return () => {
      off();
      t.detach();
      tracker.current = null;
    };
  }, []);

  const allDefs = useMemo(() => {
    // the shown module itself too: a board drawn as its own body has a manifest of its own
    const out = new Map<string, ModuleDef>([[shown.id, shown]]);
    const walk = (d: ModuleDef) => {
      for (const c of d.children ?? []) {
        const def = lookup(c.moduleDefId);
        if (def && !out.has(def.id)) {
          out.set(def.id, def);
          walk(def);
        }
      }
    };
    walk(shown);
    return [...out.values()];
  }, [shown, lookup]);
  useEffect(() => {
    loadManifests(allDefs, resolve).then(setManifests);
  }, [allDefs]);

  // the module's own assembly; else its parts where the nearest assembly above places them; else side by side (PB-1040)
  const model: CadModel | null = useMemo(
    () => (manifests ? scopedModel(system, lookup, manifests, display, at) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [system, lookup, manifests, hints, at],
  );
  /** What the view shows of the module, and what nothing places (the caption, and the empty state). */
  const summary = useMemo(() => (model ? shownSummary(model, shown, lookup) : null), [model, shown, lookup]);
  // a module on its own whose parts nothing joins: one part alone is not a picture of it
  const nothing = !!summary && !!at && summary.loose;
  const tiers = useLoadTiers(model, () => (model ? glbPlacements(model.bodies.map((b) => (b.glb?.filePath ? resolve(b.def.id, b.glb.filePath) : undefined))) : undefined), () => tracker.current?.tracker);

  // findings name paths from the root: inside a module's view, the ones that lie in it
  const findings = useMemo(() => {
    if (!model) return [];
    if (!at) return findingAnchors(model, diagnostics, hostDiagnostics);
    const own = diagnostics.flatMap((d) => {
      const refs = d.refs.flatMap((r) => scopeRef(r, at) ?? []);
      return refs.length ? [{ ...d, refs }] : [];
    });
    const fromHost = hostDiagnostics.flatMap((d) => {
      if (!d.entity) return [];
      const id = d.entity.kind === "link" ? scopeRef(`link:${d.entity.id}`, at)?.slice(5) : scopeRef(d.entity.id, at);
      return id === undefined ? [] : [{ ...d, entity: { ...d.entity, id } }];
    });
    return findingAnchors(model, own, fromHost);
  }, [model, diagnostics, hostDiagnostics, at]);
  // ---- marker-first DRC (PB-1184): every finding mapped to 3D anchors (./annot/findings-anchors.ts) ----------
  const annotFindings: FindingAnchors[] = useMemo(() => {
    if (!model) return [];
    const own = at
      ? diagnostics.flatMap((d) => {
          const refs = d.refs.flatMap((r) => scopeRef(r, at) ?? []);
          return refs.length ? [{ ...d, refs }] : [];
        })
      : diagnostics;
    const fromHost = at
      ? hostDiagnostics.flatMap((d) => {
          if (!d.entity) return [d];
          const id = d.entity.kind === "link" ? scopeRef(`link:${d.entity.id}`, at)?.slice(5) : d.entity.kind === "instance" || d.entity.kind === "interface" ? scopeRef(d.entity.id, at) : d.entity.id;
          return id === undefined ? [] : [{ ...d, entity: { ...d.entity, id } }];
        })
      : hostDiagnostics;
    const scene = model.bodies.map((b) => {
      const nodes = bodies.current.get(b.key)?.nodes;
      return { key: b.key, definition: b.def.id, ...(nodes ? { nodes } : {}) };
    });
    const entityAnchor = (ref: string): FindingAnchorPoint | undefined => {
      const a = anchorOf(model, ref);
      if (!a) return undefined;
      const holder = a.body.split("#")[0];
      const comp = a.select.component;
      return { body: a.body, ...(a.local ? { local: [a.local[0], a.local[1], a.local[2]] as [number, number, number] } : {}), ...(comp ? { component: holder ? `${holder}/${comp}` : comp } : {}) };
    };
    return findingsAnchors(findingInputs(own, fromHost), scene, { entityAnchor });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, diagnostics, hostDiagnostics, at, loaded]);
  // DEFAULT (PB-1184, round-2 note D.3): markers on when a fail or risk finding lands on the model, or a host's does
  const showFindings = findingsChoice ?? (annotFindings.some((f) => f.anchors.length > 0 && (f.severity === "fail" || f.severity === "risk")) || findings.some((f) => f.host));
  const [shownSev, setShownSev] = useState<Set<FindingSeverity>>(() => new Set(DEFAULT_SHOWN));
  const [openFindings, setOpenFindings] = useState<Set<string>>(() => new Set());
  const [ghosts, setGhosts] = useState(true);
  const [findingsMenu, setFindingsMenu] = useState(false);
  const [currentFinding, setCurrentFinding] = useState<string | undefined>();
  const [isolatedFinding, setIsolatedFinding] = useState<string | undefined>();
  const [presenceSet, setPresenceSet] = useState<PresenceChip[]>([]);
  // W3-A's presence (PB-1196): the agents' live leases and recent writes, as "claude is working on U3" chips
  const [storeChips, setStoreChips] = useState<PresenceChip[]>([]);
  /** Agents holding a lease or the camera now (W4-D: the "Take over" button shows while there are any). */
  const [agentsHere, setAgentsHere] = useState(0);
  useEffect(() => {
    const read = () => {
      const p = (store as { presence?: () => { intents?: { actor: Actor; roots: string[]; label: string }[]; leases?: { holder: Actor }[]; control?: { holder: Actor | null } } }).presence?.();
      const chips = (p?.intents ?? []).filter((i) => i.actor.kind === "agent" && i.roots.length).map((i) => ({ who: i.actor.id, ref: i.roots[0], label: i.label }));
      setStoreChips((prev) => (same(prev, chips) ? prev : chips));
      const holders = new Set((p?.leases ?? []).filter((l) => l.holder.kind === "agent").map((l) => l.holder.id));
      if (p?.control?.holder?.kind === "agent") holders.add(p.control.holder.id);
      setAgentsHere(holders.size);
    };
    read();
    return store.subscribe((c) => {
      if (c.source === "presence" || c.entry?.actor.kind === "agent") read();
    });
  }, [store]);
  const annotations = useViewSlice(store, (s) => s.annotations);
  const annotRef = useRef<AnnotLayer | null>(null);
  const annotFindingsRef = useRef(annotFindings);
  annotFindingsRef.current = annotFindings;
  /** Whether the layer has anything to draw (it runs on frames while it has, and once after). */
  const annotActive = useRef(false);
  const annotWas = useRef(false);

  // ---- scene lifecycle -----------------------------------------------------
  useEffect(() => {
    if (!host.current) return;
    // knobs for measuring (PB-1175): ?aa=msaa|native|none, ?samples=<n>, ?batch=0
    const aa = params.get("aa");
    const h = createScene(host.current, {
      ...(aa === "msaa" || aa === "native" || aa === "none" ? { antialias: aa as AntialiasMode } : {}),
      ...(params.get("samples") ? { samples: Number(params.get("samples")) } : {}),
      ...(params.get("batch") === "0" ? { batching: false } : {}),
      // R1-A (E1): wheel zoom toward the pointer, DEFAULT on; a host's choice (hub.controls), else the URL's
      zoomToCursor: hub.controlOptions?.zoomToCursor ?? hub.opening.zoomToCursor ?? DEFAULT_ZOOM_TO_CURSOR,
    });
    handle.current = h;
    hub.controls = (o) => {
      if (typeof o?.zoomToCursor === "boolean") {
        hub.controlOptions = { ...hub.controlOptions, zoomToCursor: o.zoomToCursor };
        h.controls.zoomToCursor = o.zoomToCursor;
      }
      return { zoomToCursor: h.controls.zoomToCursor };
    };
    // local crash and performance records (PB-1181, W1-E): frames, loads, context loss of this scene
    const stopTelemetry = attachSceneTelemetry(h);
    h.scene.add(harnessGroup.current);
    labelsRef.current = new LabelLayer(host.current);
    // callouts, marks, arrows and DRC markers (PB-1184): sprites in the overlay group, labels on the page
    const annot = new AnnotLayer(host.current, {
      resolve: (ref) => annotHost.current.resolve(ref),
      pickOn: (ray, roots) => annotHost.current.pickOn(ray, roots),
      firstHit: (ray, max, exclude) => annotHost.current.firstHit(ray, max, exclude),
      prepare: () => annotHost.current.prepare?.(),
      onFinding: (id, action) => annotHost.current.onFinding?.(id, action),
      onLookAt: (ref) => annotHost.current.onLookAt?.(ref),
      onDismiss: (id) => annotHost.current.onDismiss?.(id),
      // R1-C handoff (D3): a click that pins a marker or a finding's card shows its part in the Inspector
      onInspect: (id, ref) => annotHost.current.onInspect?.(id, ref),
    });
    annot.onChange = () => h.invalidate("view");
    annot.onSceneChange = () => h.invalidate("scene");
    h.overlay.add(annot.group);
    annotRef.current = annot;
    return () => {
      annotRef.current?.dispose();
      annotRef.current = null;
      labelsRef.current?.dispose();
      stopTelemetry();
      hub.controls = undefined;
      h.dispose();
      handle.current = null;
    };
  }, []);

  // ---- the theme's background, grid and highlight colours --------------------
  const { theme } = useTheme();
  const [themed, setThemed] = useState(0);
  useEffect(() => {
    const h = handle.current;
    const el = host.current;
    if (!h || !el) return;
    h.setTheme({
      background: tokenColor(el, "sceneBackground"),
      grid: tokenColor(el, "sceneGrid", "#3a3a3a"),
      gridMinor: tokenColor(el, "sceneGridMinor", "#262626"),
      accent: tokenColor(el, "accent", DEFAULT_SCENE_ACCENT),
      highlight: tokenColor(el, "highlight", DEFAULT_SCENE_HIGHLIGHT),
    });
    // highlights already drawn pick up the new colours on the next selection pass
    setThemed((n) => n + 1);
    // the annotation layer's dot, ring and marker colours (selection blue, the DRC set) for this theme
    const ground = new THREE.Color(tokenColor(el, "sceneBackground"));
    annotRef.current?.refreshColours(ground.r * 0.2126 + ground.g * 0.7152 + ground.b * 0.0722 < 0.5);
    h.invalidate();
  }, [theme]);

  /** The name of the module whose assembly places the shown one's parts (PB-1040). */
  const placedByName = (from: string) => (from ? (defAt(system, lookup, from.split("/"))?.name ?? from) : system.name);

  /** A body's objects from its loaded model (in CAD coordinates, at `base`), not yet in the scene. */
  const buildBody = (body: CadBody, base: THREE.Matrix4, loadedModel: LoadedModel): BodyRec => {
    const obj = new THREE.Group();
    obj.matrixAutoUpdate = false;
    obj.userData.key = body.key;
    obj.matrix.copy(base);
    const rec: BodyRec = { body, obj, base, centre: new THREE.Vector3(), top: new THREE.Vector3(), offset: new THREE.Vector3(), box: new THREE.Box3(), parts: [], hash: loadedModel.hash, look: "" };
    if (loadedModel.sidecar) rec.nodes = loadedModel.sidecar.nodes.map((n) => ({ ...(n.instancePath !== undefined ? { instancePath: n.instancePath } : {}), ...(n.bounds ? { bounds: n.bounds } : {}) }));
    const gltf = loadedModel.gltf;
    const scene = gltf.scene.clone(true);
    const manifest = model!.manifests.get(`${body.def.id}:${body.bodyArtifact}`);
    const featureNames = new Set(Object.keys(manifest?.features ?? {}));
    // a board's manifest names its components by instance path: those are bodies, not feature pads
    const components = new Set((body.def.children ?? []).map((c) => c.id));
    // vendor models, and outputs that come with their own colours (a board), keep their materials
    // (a view sidecar always has materials of its own: what counts is whether the original GLB had any)
    const ownColours = (loadedModel.sidecar?.sourceMaterials ?? gltf.parser.json.materials?.length ?? 0) > 0 && !appearanceOf(body.def.id);
    const vendorModel = body.glb!.id.startsWith("cad_vendor");
    const vendor = vendorModel || ownColours;
    const top = scene.children.length === 1 ? scene.children[0] : scene;
    for (const part of top.children) {
      // feature pads show only while their interface is selected
      if (!vendorModel && featureNames.has(part.name) && !components.has(part.name)) {
        part.userData.feature = part.name;
        part.visible = false;
        continue;
      }
      const partId = (part.userData.protoboard as { partInstanceId?: unknown } | undefined)?.partInstanceId;
      part.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        // shared materials (PB-1175): the GLB's own (one per glTF material, shared by every clone) or one per look
        if (!vendor) mesh.material = materialFor(body.def, part.name, appearanceOf(body.def.id));
        mesh.userData.bodyKey = body.key;
        // R1-E's C1 handoff: a board's layer sheets (copper, mask/paste, silkscreen) are drawn in front of the one
        // below them by their rank (DEFAULT -rank / -2 rank), so coplanar layers do not z-fight
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          const rank = (m.userData?.protoboard as { layerRank?: unknown } | undefined)?.layerRank;
          if (typeof rank === "number" && rank > 0 && !m.polygonOffset) {
            m.polygonOffset = true;
            m.polygonOffsetFactor = -rank;
            m.polygonOffsetUnits = -2 * rank;
            m.needsUpdate = true;
          }
        }
        if (components.has(part.name)) mesh.userData.component = part.name;
        else if (typeof partId === "string" && partId) mesh.userData.component = partId;
      });
    }
    // every mesh belongs to the body, also a GLB that is one mesh node (a merged view sidecar, a lone STL-like body):
    // it is picked, selected and x-rayed like the rest (its material stays its own, as before)
    scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o.userData.bodyKey === undefined && !o.userData.feature) o.userData.bodyKey = body.key;
    });
    const w = cadWrapper(scene);
    w.name = "cad";
    // local bounds for label anchors (before parenting, so world = CAD coordinates)
    w.updateMatrixWorld(true);
    // precise bounds (every vertex, not the loose boxes of each mesh's own bounds): a body drawn from its view sidecar and
    // from its plain GLB gets the same box, so a hot swap between them moves no label, explode offset or observe() bound
    const box = new THREE.Box3().setFromObject(w, true);
    // a cad standard output's named bodies come apart when exploded: each moves away from the largest
    const parts = explodeParts(body.def, body.glb, manifest);
    const node = (n: string) => top.children.find((c) => c.name === n);
    if (parts && node(parts.fixed)) {
      const centreOf = (o: THREE.Object3D) => new THREE.Box3().setFromObject(o, true).getCenter(new THREE.Vector3());
      const c0 = centreOf(node(parts.fixed)!);
      const fixedBox = new THREE.Box3().setFromObject(node(parts.fixed)!, true);
      /** The extent of a box along a direction: [lowest, highest] projection of its corners. */
      const along = (b: THREE.Box3, d: THREE.Vector3) => {
        const xs = [b.min.x, b.max.x].map((x) => x * d.x);
        const ys = [b.min.y, b.max.y].map((y) => y * d.y);
        const zs = [b.min.z, b.max.z].map((z) => z * d.z);
        return [Math.min(...xs) + Math.min(...ys) + Math.min(...zs), Math.max(...xs) + Math.max(...ys) + Math.max(...zs)];
      };
      for (const n of parts.moving) {
        const part = node(n);
        if (!part) continue;
        const d = centreOf(part).sub(c0).normalize();
        const cadBox = new THREE.Box3().setFromObject(part, true);
        const sz = cadBox.getSize(new THREE.Vector3());
        const clear = Math.max(0, along(fixedBox, d)[1] - along(cadBox, d)[0]);
        rec.parts.push({ obj: part, base: part.position.clone(), cadDir: d, cadBox, clear, volume: sz.x * sz.y * sz.z, travel: new THREE.Vector3() });
      }
    }
    obj.add(w);
    rec.box.copy(box);
    rec.centre.copy(box.getCenter(new THREE.Vector3()));
    rec.top.set(rec.centre.x, rec.centre.y, box.max.z);
    return rec;
  };

  // ---- bodies and hardware ---------------------------------------------------
  // Loads go through the content-hash cache (PB-1175). The first load shows each body as it arrives. A later
  // model (a rebuilt bundle, `__cad.refresh()`) is a hot swap by instance path: a body whose content hash,
  // definition and look are unchanged keeps its objects; a changed one is built beside the old, its programs
  // compiled (compileAsync), then swapped in. Camera, selection, sections and explode state are untouched:
  // they are React state and refs keyed by instance path, and the explode is applied again to what changed.
  useEffect(() => {
    const h = handle.current;
    if (!h || !model || !tiers.ready) return;
    glbCache.beginGeneration();
    let cancelled = false;
    let count = 0;
    const loads: Promise<unknown>[] = [];
    const prev = new Map(bodies.current);
    const first = prev.size === 0;
    setSettled(false);
    const state = loadState.current;
    Object.assign(state, { phase: "loading", total: 0, done: 0, failed: 0, bytes: 0, swapped: 0, kept: 0, started: performance.now(), ms: 0 });
    const changed = () => {
      state.ms = performance.now() - state.started;
      loadListener.current?.({ ...state });
      // R1-B handoff (B1, B3): the model the load is for, so a rebuild of the same model is an update (no screen)
      tracker.current?.loadState({ ...state }, `${system.id}|${at}`);
    };
    let compiled = 0;
    const bump = () => {
        count++;
      state.done++;
      changed();
      h.invalidate();
      if (!cancelled) setLoaded(count);
    };
    const shownBodies = nothing ? [] : model.bodies;
    const keys = new Set(shownBodies.map((b) => b.key));
    // what the new model no longer has goes now; what it still has stays on screen until its replacement is ready
    for (const [key, rec] of prev)
      if (!keys.has(key)) {
        h.root.remove(rec.obj);
        bodies.current.delete(key);
      }
    /** A body's look: its definition, its GLB and its appearance hints (a change means new materials). */
    const lookKey = (body: CadBody) => `${body.def.id}|${body.glb?.id ?? ""}|${JSON.stringify(appearanceOf(body.def.id) ?? null)}`;
    for (const body of shownBodies) {
      const old = prev.get(body.key);
      const base = toMatrix4(body.matrix);
      const url = body.glb?.filePath ? resolve(body.def.id, body.glb.filePath) : undefined;
      if (!url) {
        // nothing to load: an empty placeholder group (labels and findings anchor to it)
        if (old) h.root.remove(old.obj);
        const obj = new THREE.Group();
        obj.matrixAutoUpdate = false;
        obj.userData.key = body.key;
        obj.matrix.copy(base);
        h.root.add(obj);
        bodies.current.set(body.key, { body, obj, base, centre: new THREE.Vector3(), top: new THREE.Vector3(), offset: new THREE.Vector3(), box: new THREE.Box3(), parts: [], hash: "", look: lookKey(body) });
        continue;
      }
      state.total++;
      loads.push(
        tiers.load(url)
          .then((m) => {
            // the view sidecar merges a body's nodes; the viewer still needs the ones its manifest names (feature pads
            // shown on selection, named bodies that come apart): without them, the original GLB (handoff to W1-A)
            if (!m || m.source !== "sidecar") return m;
            // a sidecar that keeps the original's named nodes lacks only names the original lacks too (the M9N's
            // `mount` and `component_side` features are face sets, not nodes): nothing to gain from X.glb
            if (m.sidecar?.keepsNamedNodes) return m;
            const manifest = model.manifests.get(`${body.def.id}:${body.bodyArtifact}`);
            const parts = explodeParts(body.def, body.glb, manifest);
            const needed = [...Object.keys(manifest?.features ?? {}), ...(parts ? [parts.fixed, ...parts.moving] : [])];
            const missing = needed.filter((n) => !m.gltf.scene.getObjectByName(n));
            if (!missing.length) return m;
            console.info(`[cad] ${url}: the view sidecar lacks node(s) ${missing.slice(0, 4).join(", ")}${missing.length > 4 ? "…" : ""}: using the GLB`);
            return loadModel(url, { sidecar: false });
          })
          .then(async (loadedModel) => {
          if (cancelled) return;
          if (!loadedModel) {
            state.failed++;
            changed();
            return;
          }
          state.bytes += loadedModel.bytes;
          // unchanged content and look: the same objects, moved to where the new model places them
          if (old && old.hash === loadedModel.hash && old.look === lookKey(body)) {
            old.body = body;
            old.base.copy(base);
            old.obj.matrix.copy(base);
            old.obj.matrixWorldNeedsUpdate = true;
            bodies.current.set(body.key, old);
            state.kept++;
            bump();
            return;
          }
          const rec = buildBody(body, base, loadedModel);
          rec.look = lookKey(body);
          // R1-A (M1): the selection and the highlight in force are painted on it now, so the swap shows no frame
          // without them (the glow effect paints it again on its next pass and undoes this with its own)
          const glow = glowNow.current;
          if (glow) paintBody(rec, glow.plan, h.colors, glow.restore);
          // programs before the swap: the next frame does not stall on a shader compile
          await h.compile([rec.obj]);
          tracker.current?.upload(++compiled, state.total);
          if (cancelled) return;
          if (old) {
            h.root.remove(old.obj);
            state.swapped++;
          }
          h.root.add(rec.obj);
          bodies.current.set(body.key, rec);
          bump();
        }),
      );
    }
    // routed wire harnesses and mounting hardware: built aside, then swapped in together (on a first load, as they arrive)
    const harnessNext = new THREE.Group();
    const harnessObjsNext = new Map<string, THREE.Group>();
    const harnessMaterialsNext: THREE.MeshStandardMaterial[] = [];
    if (first) {
      harnessGroup.current.clear();
      harnessObjs.current.clear();
      harnessMaterials.current = [];
    }
    const harnessHolder = first ? harnessGroup.current : harnessNext;
    const harnessMap = first ? harnessObjs.current : harnessObjsNext;
    const harnessMats = first ? harnessMaterials.current : harnessMaterialsNext;
    for (const hp of nothing ? [] : model.assembly.harnesses) {
      const obj = new THREE.Group();
      obj.matrixAutoUpdate = false;
      obj.matrix.copy(toMatrix4(hp.matrix));
      obj.userData.harness = hp.key;
      harnessHolder.add(obj);
      harnessMap.set(hp.key, obj);
      const glb = glbFor(hp.def)?.filePath; // one body rule with the stack resolver (model.ts glbFor)
      const url = glb && resolve(hp.def.id, glb);
      if (!url) continue;
      state.total++;
      loads.push(
        loadGlb(url).then((gltf) => {
          if (cancelled || !gltf) {
            if (!gltf) state.failed++;
            return;
          }
          const s = gltf.scene.clone(true);
          s.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh) return;
            mesh.material = harnessMaterial(mesh.material as THREE.MeshStandardMaterial, o.name);
            harnessMats.push(mesh.material as THREE.MeshStandardMaterial);
            mesh.userData.harness = hp.key;
            // cables fade as the model comes apart: their materials change every frame of the tween, so they are drawn as themselves
            mesh.userData.noBatch = true;
          });
          obj.add(cadWrapper(s));
          bump();
        }),
      );
    }
    const hardwareNext: HardwareRec[] = [];
    const hardwareHolder = new THREE.Group();
    hardwareHolder.name = "hardware";
    if (first) {
      for (const hw of hardware.current) hw.obj.parent?.remove(hw.obj);
      hardware.current = hardwareNext;
    }
    for (const hw of nothing ? [] : model.assembly.hardware) {
      const obj = new THREE.Group();
      obj.matrixAutoUpdate = false;
      const base = toMatrix4(hw.matrix);
      obj.matrix.copy(base);
      obj.userData.harness = hw.harness;
      if (first) h.root.add(obj);
      else hardwareHolder.add(obj);
      const zCol = new THREE.Vector3().setFromMatrixColumn(base, 2).normalize().multiplyScalar(hw.direction);
      hardwareNext.push({ obj, base, harness: hw.harness, structure: hw.structure, mounted: hw.mounted, normal: zCol, atMm: hw.atMm, direction: hw.direction, offset: new THREE.Vector3() });
      const file = glbFor(hw.def)?.filePath;
      const url = file && resolve(hw.def.id, file);
      if (!url) continue;
      state.total++;
      loads.push(
        // the original GLB: a fastener's thread and bore are nodes of their own, hidden here, which a sidecar would merge
        loadModel(url, { sidecar: false }).then((m) => {
          const gltf = m?.gltf;
          if (cancelled || !gltf) {
            if (!gltf) state.failed++;
            return;
          }
          const s = gltf.scene.clone(true);
          s.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (mesh.isMesh) {
              mesh.material = materialFor(hw.def, "", appearanceOf(hw.def.id));
              mesh.userData.bodyKey = hw.harness;
            }
            if (o.name === "thread" || o.name === "bore") o.visible = false;
          });
          obj.add(cadWrapper(s));
          state.done++;
          changed();
          h.invalidate();
        }),
      );
    }
    changed();
    // every model has loaded (or failed): what nothing places is laid out beside the rest, then the camera fits the whole once
    void Promise.allSettled(loads).then(async () => {
      if (cancelled) return;
      if (!first) {
        // the new harnesses and hardware, compiled, then in place of the old in one step
        await h.compile([harnessNext, hardwareHolder]);
        if (cancelled) return;
        harnessGroup.current.clear();
        for (const c of [...harnessNext.children]) harnessGroup.current.add(c);
        harnessObjs.current = harnessObjsNext;
        harnessMaterials.current = harnessMaterialsNext;
        for (const hw of hardware.current) hw.obj.parent?.remove(hw.obj);
        for (const hw of hardwareNext) h.root.add(hw.obj);
        hardware.current = hardwareNext;
      }
      layOutRow([...bodies.current.values()]);
      // parsed models nothing shows any more are dropped (and their GPU buffers freed)
      glbCache.prune();
      state.phase = "ready";
      changed();
      h.invalidate();
      // the loading screen goes once the first frame with everything in it is drawn
      const offFrame = h.onFrame(() => {
        offFrame();
        tracker.current?.frame();
      });
      setSettled(true);
    });
    return () => {
      cancelled = true;
    };
  }, [model, nothing, reload, tiers.ready, tiers.tier]);

  // ---- explode and the assembly sequence (PB-1183, W2-C's player in ./sequence) -----------------------
  // the view state's explode amount is where the parts ease to (a toggle, a host, an agent)
  useEffect(() => {
    explode.current.target = explodeT;
    // W3-C: the first explode resolves the sequence (lazily, see the settle effect below)
    if (explodeT > 0 && !player.current && settledRef.current) resolveSequence();
    handle.current?.invalidate("pose");
  }, [explodeT]);
  // the view state's sequence step (an agent's or a host's `explode {t, step}`) drives the player (gate 3); the
  // player's own write-back names the step it is at, so it does not come back here as a jump
  useEffect(() => {
    if (typeof explodeStep !== "string") return;
    if (!player.current && settledRef.current) resolveSequence();
    const p = player.current;
    if (!p || p.currentStep() === explodeStep) return;
    const r = runSequence({ action: "goto", step: explodeStep } as SequenceCommand);
    if (!r.ok) console.warn(`[uhd-viewer] sequence step ${explodeStep} not shown: ${r.error ?? "refused"}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [explodeStep]);

  /** Explode step at "exploded" (mm): a small assembly (a board in its enclosure) comes apart in proportion to its size. */
  const explodeScale = () => {
    const size = assembledBounds().getSize(new THREE.Vector3()).length();
    return EXPLODE_MM * (size > 0 && size < 120 ? Math.max(0.3, size / 120) : 1);
  };
  const upRef = useRef(new THREE.Vector3(0, 0, 1));
  /**
   * The assembly sequence (W2-C, PB-1183): the built `sequence.json` beside the bundle (or the host's), else the
   * model's own mates, else the stack planner. It replaces the stack plan this view kept: explode and assemble are
   * the player's t, and a step, a play or a joint is a player command.
   */
  const [seqFile, setSeqFile] = useState<SequenceFile | undefined>(sequence);
  useEffect(() => {
    if (sequence) {
      setSeqFile(sequence);
      return;
    }
    let off = false;
    void fetchSequenceBeside(source.bundleUrl).then((f) => {
      if (!off) setSeqFile(f);
    });
    return () => {
      off = true;
    };
  }, [source, sequence]);
  const player = useRef<SequencePlayer | null>(null);
  const stepOff = useRef<(() => void) | null>(null);
  useEffect(() => () => stepOff.current?.(), []);
  const seqUrl = useMemo(() => sequenceUrlState(typeof window === "undefined" ? "" : window.location.search), []);
  /** Put the model where the player says. */
  const poseNow = () => {
    if (player.current && model) applyCadPose(player.current.pose(), model, bodies.current, hardware.current);
  };
  const applyExplode = useMemo(() => {
    /**
     * `e` is the linear explode amount (each step of the sequence eases itself). `fromPlayer`: the player moved
     * itself (a play, a command), so its t is not set again (setting it would stop a play).
     */
    return (e: number, fromPlayer = false) => {
      if (!model) return;
      if (player.current) {
        if (!fromPlayer) player.current.set({ t: e });
        poseNow();
      }
      // the ground stays under the model as it comes apart
      handle.current?.setGround(currentBounds().union(assembledBounds()));
      // cables are routed for the assembled model: they fade out as it comes apart
      harnessGroup.current.visible = showWiresRef.current && e < 0.35;
      for (const m of harnessMaterials.current) {
        m.opacity = Math.max(0, 1 - e * 3);
        m.transparent = m.opacity < 1;
        m.depthWrite = m.opacity > 0.5;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);
  /** True while a player command runs (its step write-back carries the player's own t). */
  const seqDriving = useRef(false);
  /** Resolve the sequence for what is loaded now (the stack planner samples it: 125 ms drone, 369 ms ClientX). */
  const resolveSequence = () => {
    const h = handle.current;
    if (!h || !model) return;
    const resolved = resolveForCad({ model, bodies: bodies.current, hardware: hardware.current, file: seqFile, up: upRef.current, gap: explodeScale(), root: h.root, levels: seqUrl.levels });
    if (player.current) player.current.replace(resolved);
    else {
      player.current = new SequencePlayer(resolved);
      // W3-D (gate item 6): the player's step written back to the view state (a string step id or null)
      stepOff.current?.();
      // gate 3: while the view only eases toward the view state's explode amount (an agent's `explode t:0`), the
      // step written back keeps that amount; the player's own t is written only while it drives (a goto, a play).
      // Before, a step crossed on the way wrote the eased t as the new amount and the view stopped half exploded.
      stepOff.current = player.current.onStepChange((step, t) => {
        const p = player.current;
        const driving = seqDriving.current || Boolean(p?.playing);
        const amount = driving ? t : store.get().explode.t;
        store.dispatch([{ op: "explode", t: Math.min(1, Math.max(0, amount)), step }], { actor: SYSTEM, label: "sequence step", source: "view" });
      });
      player.current.set({ t: explode.current.value });
      if (seqUrl.step || seqUrl.play) applyUrlState(player.current, seqUrl);
    }
    applyExplode(player.current.t, true);
    h.invalidate();
  };
  // after the first frame with everything in it (W2-C: the planner never delays the first frame)
  useEffect(() => {
    const h = handle.current;
    if (!h || !model || !settled) return;
    // W3-C: lazily: now only when the view needs the player at once (a URL step or play, already exploded, a player
    // to replace); otherwise on the first explode or command (resolveForCad blocked the main thread 0.4-0.5 s here)
    if (!(seqUrl.step || seqUrl.play || explode.current.target > 0 || player.current)) return;
    let done = false;
    const off = h.onFrame(() => {
      off();
      setTimeout(() => {
        if (!done) resolveSequence();
      }, 0);
    });
    h.invalidate();
    return () => {
      done = true;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, settled, seqFile]);
  /** A player command (a host, an agent, `__cad.set`), drawn at once. */
  const runSequence = (cmd: SequenceCommand): { ok: boolean; error?: string; state?: PlayerSnapshot } => {
    if (!player.current && settledRef.current) resolveSequence();
    const p = player.current;
    if (!p) return { ok: false, error: "the model is still loading: no sequence yet" };
    seqDriving.current = true;
    let r: ReturnType<typeof p.run>;
    try {
      r = p.run(cmd);
    } finally {
      seqDriving.current = false;
    }
    if (r.ok) {
      // a jump (goto, an instant explode, set) moves the explode amount the view eases from
      explode.current.value = explode.current.target = p.t;
      applyExplode(p.t, true);
      handle.current?.invalidate("pose");
    }
    return { ...r, state: p.snapshot() };
  };
  const reportCameraRef = useRef<(actor: Actor) => void>(() => {});
  const showWiresRef = useRef(showWires);
  showWiresRef.current = showWires;
  const harnessMaterials = useRef<THREE.MeshStandardMaterial[]>([]);

  // per-frame: tween explode, play the sequence, lay out labels
  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    let playing = false;
    const f = (dt: number) => {
      const ex = explode.current;
      let moving = false;
      if (ex.value !== ex.target) {
        moving = true;
        // the parts move: their placements only (the batches rewrite matrices, nothing is regrouped)
        h.invalidate("pose");
        const step = dt / 1.4; // 1.4 s full travel
        ex.value = ex.target > ex.value ? Math.min(ex.target, ex.value + step) : Math.max(ex.target, ex.value - step);
        applyExplode(ex.value);
        const cam = cameraTween.current;
        if (cam) {
          // the camera's share of the way, eased
          const k = Math.abs(ex.target - cam.start) > 0 ? Math.min(1, Math.abs(ex.value - cam.start) / Math.abs(ex.target - cam.start)) : 1;
          const t = k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2;
          h.camera.position.lerpVectors(cam.from[0], cam.to[0], t);
          h.controls.target.lerpVectors(cam.from[1], cam.to[1], t);
          h.camera.lookAt(h.controls.target);
          if (ex.value === ex.target) {
            cameraTween.current = null;
            reportCameraRef.current(SYSTEM);
          }
        }
      }
      // "Look along normal" (R1-A, E3): the camera turns to the part's face, eased
      const vt = viewTween.current;
      let turning = false;
      if (vt) {
        const k = (performance.now() - vt.start) / vt.ms;
        const pose = cameraBetween(vt.from, vt.to, k);
        h.camera.position.copy(pose.position);
        h.controls.target.copy(pose.target);
        h.camera.lookAt(pose.target);
        h.invalidate("view");
        turning = k < 1;
        if (!turning) {
          viewTween.current = null;
          reportCameraRef.current(SYSTEM);
        }
      }
      // a sequence playing (a step, a loop, a clip): the player moves the parts
      const p = player.current;
      const seqMoving = !moving && p ? p.tick(dt) : false;
      if (seqMoving && p) {
        ex.value = ex.target = p.t;
        applyExplode(p.t, true);
        h.invalidate("pose");
      }
      if (playing && !seqMoving && p) {
        // a play ended: the view state's explode follows, so the toggle and the URL say where it stopped
        ex.value = ex.target = p.t;
        store.dispatch([{ op: "explode", t: Math.min(1, Math.max(0, p.t)) }], { actor: SEQUENCE, label: "the sequence play ended", source: "sequence" });
      }
      playing = seqMoving;
      const size = h.renderer.getSize(new THREE.Vector2());
      const easing = labelsRef.current?.update(h.camera, size.x, size.y, dt) ?? false;
      // callouts and markers (PB-1184): laid out on every frame drawn while there are any (and once after)
      let annotBusy = false;
      const annot = annotRef.current;
      if (annot && (annotActive.current || annotWas.current)) {
        h.scene.updateMatrixWorld();
        annotBusy = annot.update(h.camera, size.x, size.y);
        annotWas.current = annotActive.current;
      }
      // still moving: the next frame is drawn too; otherwise the view goes idle
      return moving || seqMoving || ex.value !== ex.target || easing || annotBusy || turning;
    };
    h.beforeRender.add(f);
    return () => {
      h.beforeRender.delete(f);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyExplode]);
  useEffect(() => {
    applyExplode(explode.current.value);
    handle.current?.invalidate();
  }, [applyExplode, loaded, showWires, settled]);

  useEffect(() => {
    harnessGroup.current.visible = showWires && explode.current.value < 0.35;
  }, [showWires, loaded]);

  useEffect(() => {
    for (const hw of hardware.current) hw.obj.visible = showHardware && shownBy(hw.harness, isolation, hidden);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHardware, loaded, settled]);

  // ---- labels ------------------------------------------------------------------
  useEffect(() => {
    const layer = labelsRef.current;
    if (!layer || !model) return;
    const items: LabelItem[] = [];
    const bodyAnchor = (key: string, where: "top" | "centre" = "top") => () => {
      const rec = bodies.current.get(key);
      if (!rec) return null;
      return (where === "top" ? rec.top : rec.centre).clone().applyMatrix4(rec.obj.matrix);
    };
    const hintsL = display.labels ?? {};
    const names = instanceNames(shown, lookup);
    const nameOf = (path: string) => names.get(path) ?? (path || shown.name);
    // display hints name instances by their paths from the root
    const full = (key: string) => (key.includes("#") ? `${outOfScope(key.split("#")[0], at)}#${key.split("#")[1]}` : outOfScope(key, at));
    // a name shared by several instances (four "Motor"s) is qualified by the parent's name
    const sameName = (path: string) => [...names.entries()].filter(([p, n]) => n === nameOf(path) && p !== path && model.bodies.some((b) => b.key === p)).length > 0;
    const rootKey = model.bodies.find((b) => !b.via && !b.hint)?.key;
    if (labelKinds.has("module")) {
      for (const b of model.bodies) {
        const h = hintsL.modules?.[full(b.key)];
        if (h?.hide) continue;
        const path = b.key.split("#")[0];
        const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        let title = h?.title ?? nameOf(path);
        if (!h?.title && b.key.includes("#")) title = `${title} · ${b.glb?.name?.replace(/ \(GLB\)$/, "") ?? b.key.split("#")[1]}`;
        else if (!h?.title && parent && sameName(path)) title = `${title} · ${nameOf(parent)}`;
        // R1-C handoff (M12): the subtitle is the part's refdes or MPN, never placement provenance
        const f = partFacts(b.key.split("#")[0], b.def);
        const sub = h?.sub ?? partSubtitle(f) ?? (b.def.name !== title ? b.def.name : undefined);
        items.push({ id: `m:${b.key}`, kind: "module", title, sub, anchor: bodyAnchor(b.key, b.key === rootKey ? "centre" : "top"), onClick: () => setSel({ body: b.key }) });
      }
    }
    if (labelKinds.has("harness")) {
      const hwAnchor = (harness: string) => () => {
        const list = hardware.current.filter((h) => h.harness === harness);
        if (!list.length || !showHardware) return null;
        const p = new THREE.Vector3();
        list.forEach((h) => p.add(new THREE.Vector3().setFromMatrixPosition(h.obj.matrix)));
        return p.divideScalar(list.length);
      };
      for (const harness of [...new Set(model.assembly.hardware.map((h) => h.harness))]) {
        const h = hintsL.harnesses?.[full(harness)];
        if (h?.hide) continue;
        const list = model.assembly.hardware.filter((x) => x.harness === harness);
        // short names from the harness's own child refs ("M2 x 12 screw", "5 mm spacer")
        const hdef = model.assembly.instances.find((i) => i.path.join("/") === harness)?.def;
        const counts = new Map<string, number>();
        for (const x of list) {
          const n = hdef?.children?.find((c) => c.id === x.child)?.name ?? x.def.name;
          counts.set(n, (counts.get(n) ?? 0) + 1);
        }
        const sub = h?.sub ?? [...counts].map(([n, c]) => `${c}× ${n.replace(/ x /g, "×")}`).join(" · ");
        items.push({ id: `h:${harness}`, kind: "harness", title: h?.title ?? nameOf(harness), sub, anchor: hwAnchor(harness), onClick: () => setSel({ mate: list[0].linkId }) });
      }
      for (const hp of model.assembly.harnesses) {
        const h = hintsL.harnesses?.[full(hp.key)];
        if (h?.hide) continue;
        const m = routeManifest(model, hp);
        items.push({
          id: `w:${hp.key}`,
          kind: "harness",
          title: h?.title ?? nameOf(hp.key),
          sub: h?.sub ?? cableSummary(hp, m),
          anchor: () => {
            if (!harnessGroup.current.visible || !m?.route?.length) return null;
            const p = m.route[Math.floor(m.route.length * 0.55)];
            return new THREE.Vector3(...p).applyMatrix4(toMatrix4(hp.matrix));
          },
          onClick: () => setSel({ harness: hp.key }),
        });
      }
    }
    if (labelKinds.has("interface")) {
      // one label per kind of joint: repeated instances (four motor mounts) share it
      const seen = new Set<string>();
      for (const m of model.assembly.mates) {
        const kindKey = `${m.a.def.id}:${m.a.iface.id}|${m.b.def.id}:${m.b.iface.id}`;
        if (seen.has(kindKey)) continue;
        seen.add(kindKey);
        const s = m.b;
        const key = s.path.join("/") + (s.frame.artifact ? `#${s.frame.artifact}` : "");
        items.push({
          id: `i:${m.linkId}`,
          kind: "interface",
          title: `${m.a.iface.id} ↔ ${m.b.iface.id}`,
          sub: m.linkId.replace(/_/g, " "),
          anchor: () => {
            const rec = bodies.current.get(key);
            return rec ? new THREE.Vector3(...s.frame.origin).applyMatrix4(rec.obj.matrix) : null;
          },
          onClick: () => setSel({ mate: m.linkId }),
        });
      }
    }
    // findings are markers now (PB-1184, ./annot): this layer carries the module, harness and interface labels
    // R1-C handoff (D5): labels behind the drawn model's centre fade
    layer.centre = () => {
      const b = drawnBox();
      return b.isEmpty() ? null : b.getCenter(new THREE.Vector3());
    };
    layer.setItems(showLabels ? items : []);
    layer.target = showLabels ? 1 : 0;
    // the inspector card covers the right of the view only while it is open
    layer.margins = { top: 60, bottom: 64, left: 56, right: present || !inspector ? 16 : 380 };
  }, [model, labelKinds, showLabels, loaded, showHardware, showWires, present, inspector]);

  // ---- section plane and x-ray (PB-823) ---------------------------------------
  /** Bounds of the assembled model (CAD coordinates of the root), from the loaded bodies. */
  const assembledBounds = () => {
    const box = new THREE.Box3();
    for (const rec of bodies.current.values()) if (!rec.box.isEmpty()) box.union(rec.box.clone().applyMatrix4(rec.base));
    return box;
  };
  /** Bounds of the model as drawn now (exploded or not). */
  const currentBounds = () => {
    const box = new THREE.Box3();
    for (const rec of bodies.current.values()) {
      if (rec.box.isEmpty()) continue;
      box.union(rec.box.clone().applyMatrix4(rec.obj.matrix));
      // its named bodies where they went (a lid lifted off)
      for (const part of rec.parts) if (!part.cadBox.isEmpty()) box.union(part.cadBox.clone().applyMatrix4(rec.obj.matrix).translate(part.travel));
    }
    return box;
  };
  /**
   * Bounds of what is drawn now (R1-A, M1): as `currentBounds`, without the bodies hidden or isolated away (a fit of
   * a board must not frame the shell the person hid). Everything when nothing is drawn.
   */
  const drawnBox = () => {
    const box = new THREE.Box3();
    for (const rec of bodies.current.values()) {
      if (rec.box.isEmpty() || !rec.obj.visible) continue;
      box.union(rec.box.clone().applyMatrix4(rec.obj.matrix));
      for (const part of rec.parts) if (!part.cadBox.isEmpty()) box.union(part.cadBox.clone().applyMatrix4(rec.obj.matrix).translate(part.travel));
    }
    return box.isEmpty() ? currentBounds() : box;
  };
  /** Where the section plane cuts `box` (the assembled bounds), and which side it keeps (flip: the + side). */
  const sectionPlane = (box: THREE.Box3) => {
    const h = handle.current;
    if (!h || !section || box.isEmpty()) return undefined;
    const lo = box.min.getComponent(section.axis);
    const hi = box.max.getComponent(section.axis);
    const at = lo + (hi - lo) * section.at;
    const flip = section.flip ?? h.camera.position.getComponent(section.axis) < h.controls.target.getComponent(section.axis);
    return { at, flip };
  };
  /** Bounds of what is drawn now: the model as exploded, less what a section cuts away. */
  const visibleBounds = () => {
    const box = drawnBox();
    const cut = sectionPlane(assembledBounds());
    if (!section || !cut || box.isEmpty()) return box;
    if (cut.flip) box.min.setComponent(section.axis, Math.max(box.min.getComponent(section.axis), cut.at));
    else box.max.setComponent(section.axis, Math.min(box.max.getComponent(section.axis), cut.at));
    return box;
  };
  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    const grid = h.scene.children.find((o) => o instanceof THREE.GridHelper);
    const box = assembledBounds();
    // a cut body is a shell: draw the far side of its faces too, or a closed part (a battery) seen
    // through the cut shows only the faces that face the camera and seems to vanish (PB-873)
    const cut = sections.length > 0 && !box.isEmpty();
    for (const group of [h.root, harnessGroup.current])
      group.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | undefined;
        if (!m || Array.isArray(m)) return;
        const side = (m.userData.side ??= m.side) as THREE.Side;
        const next = cut ? THREE.DoubleSide : side;
        if (m.side !== next) {
          m.side = next;
          m.needsUpdate = true;
        }
      });
    const planes = resolvePlanes(sections as ScopedSectionPlane[], box, { position: h.camera.position, target: h.controls.target });
    const scope = (sections[0] as ScopedSectionPlane | undefined)?.scope;
    h.sections.set(planes.length ? { planes: planes.map((p) => p.plane), ...(scope ? { scopePaths: [scope] } : {}) } : null);
    if (grid) grid.visible = planes.length ? false : !present;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections, loaded, model]);
  /** Bodies that hold another (shells): what X-ray has to see through. None: the control is disabled and says so. */
  const [shells, setShells] = useState(0);
  useEffect(() => {
    // a body whose bounds hold another body's centre is a shell (an enclosure): x-ray makes it see-through
    const recs = [...bodies.current.values()].filter((r) => !r.box.isEmpty());
    const world = new Map(recs.map((r) => [r, r.box.clone().applyMatrix4(r.base)]));
    let count = 0;
    for (const r of recs) {
      const shell = recs.some((o) => o !== r && world.get(r)!.containsPoint(world.get(o)!.getCenter(new THREE.Vector3())));
      if (shell) count++;
      // a shared see-through variant of each mesh's own material (./render/looks.ts), never an edit of a shared one
      const see = xray && shell;
      r.obj.traverse((o) => {
        if ((o as THREE.Mesh).isMesh && o.userData.bodyKey !== undefined) setMeshLook(o as THREE.Mesh, { xray: see });
      });
    }
    setShells(count);
    handle.current?.invalidate();
  }, [xray, loaded, model, settled]);

  // ---- what glows (R1-A: A1, A2, M5) ----------------------------------------------------------------------
  /** The plan in force and its undo list: a body built by a hot swap is painted with it before it is shown (M1). */
  const glowNow = useRef<{ plan: GlowPlan; restore: (() => void)[] } | null>(null);
  /** Paint one body as the plan says: the selection's solid accent surface, the highlight's glow, its components. */
  const paintBody = (rec: BodyRec, plan: GlowPlan, colors: SceneColors, restore: (() => void)[]) => {
    const key = rec.body.key;
    const selected = plan.selected.has(key);
    const glow = plan.highlighted.has(key) ? colors.glowStrong : undefined;
    rec.obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || o.userData.bodyKey === undefined) return;
      // a highlight is a shared variant of the mesh's material: under the batcher, an instance attribute
      setMeshLook(mesh, { emissive: glow });
      // DEFAULT (M5): a selected body is drawn in the theme's accent surface, as a selected component is
      if (selected) swapMaterial(mesh, focusMaterial(colors.focus), restore);
    });
    if (plan.component?.holder === key) paintComponent(rec, plan.component.path, "select", colors, restore);
    for (const c of plan.components) if (c.holder === key) paintComponent(rec, c.path, "highlight", colors, restore);
  };

  // ---- selection overlays: interface geometry per direction, frames ----------
  useEffect(() => {
    const h = handle.current;
    if (!h || !model) return;
    const restore: (() => void)[] = [];
    const newNotes: string[] = [];
    const objOf = (key: string) => bodies.current.get(key)?.obj;

    // R1-A: one plan for what glows. A picked component lights itself, never its holder board (A2); a highlight below
    // a body lights the component it names (A1); the selection is the accent surface on bodies and components alike (M5)
    const plan = glowPlan({ bodies: bodies.current.keys(), harnesses: harnessObjs.current.keys(), selection: sel, highlight, within: model.within });
    for (const rec of bodies.current.values()) paintBody(rec, plan, h.colors, restore);
    glowNow.current = { plan, restore };
    for (const key of plan.harnesses) {
      const obj = harnessObjs.current.get(key);
      obj?.traverse((o) => {
        if (!(o as THREE.Mesh).isMesh) return;
        setMeshLook(o as THREE.Mesh, { emissive: h.colors.glowStrong });
        restore.push(() => setMeshLook(o as THREE.Mesh, { emissive: undefined }));
      });
    }
    const addInBody = (key: string, obj: THREE.Object3D) => {
      const body = objOf(key);
      if (!body) return;
      body.add(obj);
      restore.push(() => body.remove(obj));
    };

    const drawInterface = (body: CadBody, row: InterfaceRow, color: number) => {
      for (const src of row.sources.length ? row.sources : [row.iface.id]) {
        const iface = body.def.interfaces.find((i) => i.id === src)!;
        const frame = iface.geometry?.frame;
        const targetKey = frame?.artifact ? `${body.path.join("/")}#${frame.artifact}` : body.key;
        if (frame) addInBody(targetKey, frameGizmo(frame, h.colors));
        const refs = row.byDirection[direction].filter((r) => r.interfaceId === src);
        if (!refs.length) {
          newNotes.push(`${src}: no ${DIRECTIONS.find((d) => d.id === direction)!.label} binding`);
          continue;
        }
        for (const r of refs) {
          if (r.ref.kind === "feature") {
            if (r.note) {
              newNotes.push(`${src}: ${r.note}`);
              continue;
            }
            const artifactKey = r.ref.artifact === body.bodyArtifact ? body.key : `${body.path.join("/")}#${r.ref.artifact}`;
            const obj = objOf(artifactKey) ?? objOf(body.key);
            const nodes: THREE.Object3D[] = [];
            const featureName = r.ref.name;
            obj?.traverse((o) => {
              if (o.name === featureName && !nodes.some((n) => n.getObjectById(o.id))) nodes.push(o);
            });
            if (!nodes.length) {
              const sig = model.manifests.get(`${body.def.id}:${r.ref.artifact}`)?.features[r.ref.name];
              newNotes.push(`${src}: "${r.ref.name}" is in the manifest but not a named node in the GLB — marker at its centroid`);
              if (sig) {
                const m = new THREE.Mesh(new THREE.SphereGeometry(1.6, 16, 12), focusMaterial(color));
                m.position.set(...sig.centroid);
                addInBody(artifactKey, m);
              }
              continue;
            }
            for (const n of nodes) {
              const wasVisible = n.visible;
              n.visible = true;
              const mats = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
              n.traverse((o) => {
                const mesh = o as THREE.Mesh;
                if (mesh.isMesh) {
                  mats.set(mesh, mesh.material);
                  mesh.material = focusMaterial(color);
                  mesh.renderOrder = 5;
                }
              });
              restore.push(() => {
                n.visible = wasVisible;
                for (const [mesh, m] of mats) mesh.material = m;
              });
            }
            if (r.status === "stale") newNotes.push(`${src}: "${r.ref.name}" changed since it was bound`);
          } else if (r.ref.kind === "artifact") {
            if (r.note) {
              newNotes.push(`${src}: ${r.note}`);
              continue;
            }
            const art = body.def.artifacts?.find((a) => a.id === (r.ref as { artifact: string }).artifact);
            if (!art?.filePath) continue;
            const holder = new THREE.Group();
            addInBody(targetKey, holder);
            const artUrl = resolve(body.def.id, art.filePath);
            if (!artUrl) continue;
            loadGlb(artUrl).then((gltf) => {
              if (!gltf) return;
              const s = gltf.scene.clone(true);
              s.traverse((o) => {
                if ((o as THREE.Mesh).isMesh) {
                  (o as THREE.Mesh).material = focusMaterial(color);
                  o.renderOrder = 5;
                }
              });
              holder.add(cadWrapper(s));
            });
          } else if (frame) {
            const obj = proceduralGeometry(iface, r.ref.generator, frame, color, newNotes);
            if (obj) addInBody(targetKey, obj);
            else newNotes.push(`${src}: procedural "${r.ref.generator}" has no parameters to work from`);
          }
        }
      }
    };

    const bodyFor = (key?: string) => model.bodies.find((b) => b.key === key);
    const rowFor = (def: ModuleDef, id: string) => interfaceRows(def, model.manifests).find((r) => r.iface.id === id);
    // a component selected on its own (an agent's `select {component}`): the body that holds it (gate 3; the
    // longest placed body whose path prefixes the component's), so the component is drawn highlighted
    const holderOf = (path: string) => model.bodies.filter((b) => path.startsWith(`${b.key.split("#")[0]}/`)).sort((a, b) => b.key.length - a.key.length)[0];
    const selBody = bodyFor(sel.body) ?? (sel.component ? holderOf(sel.component) : undefined);
    const mateOf = (m: MateEdge, key: string, ifaceId: string) =>
      (m.a.path.join("/") === key.split("#")[0] && m.a.iface.id === ifaceId) || (m.b.path.join("/") === key.split("#")[0] && m.b.iface.id === ifaceId);
    let mate = sel.mate ? model.assembly.mates.find((m) => m.linkId === sel.mate) : undefined;
    if (!mate && selBody && sel.iface) mate = model.assembly.mates.find((m) => mateOf(m, selBody.key, sel.iface!));
    if (selBody && sel.iface) {
      const row = rowFor(selBody.def, sel.iface);
      if (row) drawInterface(selBody, row, h.colors.focus);
    }
    if (mate) {
      for (const end of [mate.a, mate.b]) {
        const key = end.path.join("/") + (end.frame.artifact ? `#${end.frame.artifact}` : "");
        if (selBody && key.split("#")[0] === selBody.key.split("#")[0] && end.iface.id === sel.iface) continue;
        const b = model.bodies.find((x) => x.path.join("/") === end.path.join("/") && (x.key === key || !end.frame.artifact));
        const row = b && rowFor(b.def, end.iface.id);
        if (b && row) drawInterface(b, row, sel.iface ? h.colors.counterpart : h.colors.focus);
      }
      // the mate's hardware glows too
      if (mate.harnessPath) {
        const hk = mate.harnessPath.join("/");
        for (const hw of hardware.current.filter((x) => x.harness === hk)) {
          const mats = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
          hw.obj.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (mesh.isMesh) {
              mats.set(mesh, mesh.material);
              mesh.material = focusMaterial(h.colors.focus);
            }
          });
          restore.push(() => {
            for (const [mesh, m] of mats) mesh.material = m;
          });
        }
      }
    }
    if (sel.harness) {
      // a selected cable: the same accent surface as any selected part (M5)
      const obj = harnessObjs.current.get(sel.harness);
      obj?.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) swapMaterial(o as THREE.Mesh, focusMaterial(h.colors.focus), restore);
      });
    }
    if (showFrames) {
      for (const b of model.bodies) {
        for (const i of b.def.interfaces) {
          const f = i.geometry?.frame;
          if (!f) continue;
          const targetKey = f.artifact ? `${b.path.join("/")}#${f.artifact}` : b.key;
          if (f.artifact && targetKey !== b.key && !bodies.current.has(targetKey)) continue;
          if (!f.artifact && b.key.includes("#")) continue;
          addInBody(targetKey, frameGizmo(f, h.colors, 9));
        }
      }
    }
    setNotes([...new Set(newNotes)]);
    h.invalidate();
    return () => {
      // last applied first: a component's glow is undone before its body's look is
      for (let i = restore.length - 1; i >= 0; i--) restore[i]();
      if (glowNow.current?.restore === restore) glowNow.current = null;
      handle.current?.invalidate();
    };
    // x-ray repoints the meshes at its own variants: the selection is painted again over it
  }, [model, sel, direction, showFrames, loaded, themed, highlight, xray]);

  // ---- isolation and hidden paths (the view state's): a body, a harness or a fastener is drawn or not -----
  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    for (const [key, rec] of bodies.current) rec.obj.visible = shownBy(key, isolation, hidden);
    for (const [key, obj] of harnessObjs.current) obj.visible = shownBy(key, isolation, hidden);
    for (const hw of hardware.current) hw.obj.visible = showHardware && shownBy(hw.harness, isolation, hidden);
    h.invalidate();
  }, [isolation, hidden, loaded, settled, showHardware]);

  // ---- picking ---------------------------------------------------------------
  /**
   * The nearest drawn body or harness under a world ray (three-mesh-bvh, ./render/pick.ts): hidden things and
   * what a section cuts away are skipped; the hit carries the GLB's instance path and face id where it has them.
   */
  const pickAt = (ray: THREE.Ray) => {
    const h = handle.current;
    if (!h) return undefined;
    h.scene.updateMatrixWorld();
    return pick(ray, [h.root, harnessGroup.current], {
      clippingPlanes: h.renderer.clippingPlanes,
      filter: (m) => Boolean(m.userData.bodyKey || m.userData.harness),
      // ids stop at the body's own group (the parts above it belong to the assembly)
      stop: (m) => {
        let o: THREE.Object3D | null = m;
        while (o && o.userData.key === undefined && o.userData.harness === undefined) o = o.parent;
        return o ?? undefined;
      },
    });
  };
  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    const el = h.renderer.domElement;
    // a click is a press whose pointer never wandered more than 4 px (DEFAULT): a drag that ends where it began (a
    // shake, R1-C's observation) is a drag, not a pick
    let down: { x: number; y: number; far: number } | null = null;
    const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY, far: 0 });
    const onMove = (e: PointerEvent) => {
      if (down) down.far = Math.max(down.far, Math.hypot(e.clientX - down.x, e.clientY - down.y));
    };
    const onUp = (e: PointerEvent) => {
      if (!down || Math.max(down.far, Math.hypot(e.clientX - down.x, e.clientY - down.y)) > 4) return;
      down = null;
      // a person's pick never frames: a focus still waiting to frame (a host's, on what had nothing drawn) is dropped
      look.current = false;
      const r = el.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), h.camera);
      // three-mesh-bvh, nearest first, skipping what is hidden or cut away by the section (PB-1175)
      const hit = pickAt(ray.ray);
      if (!hit) setSel({});
      else if (hit.object.userData.harness) setSel({ harness: hit.object.userData.harness });
      else {
        const k = hit.object.userData.bodyKey as string;
        const hwMate = model?.assembly.hardware.find((x) => x.harness === k)?.linkId;
        // the node's id in the body, else the instance path the GLB's extras (or the sidecar's feature ids) give
        const child = (hit.object.userData.component as string | undefined) ?? hit.partInstanceId;
        // a component is named by its instance path in the model (the body's path, then its id in the body), as a host's focus names it
        const holder = k.split("#")[0];
        const component = child === undefined ? undefined : instancePathIn(holder, child);
        // the face under the pick: "Look along normal" faces it (R1-A, E3)
        const normal = triangleNormal(hit.object, hit.triangle, h.camera.position.clone().sub(hit.point), hit.instance);
        lastPick.current = normal && !hwMate ? { key: component ?? k, normal } : null;
        setSel(hwMate ? { mate: hwMate } : component ? { body: k, component } : { body: k });
      }
    };
    /**
     * Double-click on a part (PB-1072): the part opens on its own, in 3D. A bought part (nothing inside it, a
     * model of its own: the flight controller in the FC + ESC stack) shows its own model; an assembly its parts.
     * Without a host that opens tabs, the part is selected and framed.
     */
    const onDouble = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), h.camera);
      const hit = pickAt(ray.ray);
      const k = hit?.object.userData.bodyKey as string | undefined;
      if (!hit || k === undefined || model?.assembly.hardware.some((x) => x.harness === k)) return;
      const child = (hit.object.userData.component as string | undefined) ?? hit.partInstanceId;
      const holder = k.split("#")[0];
      const path = child === undefined ? holder : instancePathIn(holder, child);
      const full = outOfScope(path, at);
      const def = full ? defAt(system, lookup, full.split("/")) : undefined;
      if (!def || full === at) return;
      const open = openModuleRef.current;
      if (open && (def.children?.length || glbFor(def))) return open(full, "3d");
      // no host to open it: select it here and look at it
      look.current = true;
      setSel(child === undefined ? { body: k } : { body: k, component: path });
    };
    // turn-taking (W3-A, PB-1179): while the person's pointer is down agent writes answer "busy"
    const turns = store as { setInteracting?: (on: boolean) => void };
    const interactOn = () => turns.setInteracting?.(true);
    const interactOff = () => turns.setInteracting?.(false);
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("dblclick", onDouble);
    el.addEventListener("pointerdown", interactOn);
    window.addEventListener("pointerup", interactOff);
    window.addEventListener("pointercancel", interactOff);
    // a pointer-up that never comes (focus lost mid-drag, a lost capture) must not hold agents off (gate 3)
    window.addEventListener("blur", interactOff);
    el.addEventListener("lostpointercapture", interactOff);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("dblclick", onDouble);
      el.removeEventListener("pointerdown", interactOn);
      window.removeEventListener("pointerup", interactOff);
      window.removeEventListener("pointercancel", interactOff);
      window.removeEventListener("blur", interactOff);
      el.removeEventListener("lostpointercapture", interactOff);
      interactOff();
    };
  }, [model]);

  // ---- camera helpers and the capture API ---------------------------------------
  /** The direction drawn up (a display hint; default +z) and the rotation from +z to it. */
  // the project's saved view (its up direction, its camera) is the assembly's: a module on its own is seen in its own coordinates
  // `spatial.view.up`, or the shorthand `spatial.up` (PB-1137: a model built on a tilted root opens upright)
  const upVec = useMemo(() => new THREE.Vector3(...viewUp(display as { up?: unknown; view?: { up?: unknown } }, at)), [source, at]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!upRef.current.equals(upVec)) upRef.current = upVec.clone();
  const upQuat = useMemo(() => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), upVec), [upVec]);
  /** Unit vector from the target to the camera for an azimuth and elevation about `up`. */
  const viewDir = (azimuthDeg: number, elevationDeg: number) => {
    const az = (azimuthDeg * Math.PI) / 180;
    const el = (elevationDeg * Math.PI) / 180;
    return new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)).applyQuaternion(upQuat);
  };
  const orbit = (azimuthDeg: number, elevationDeg: number, distance: number, target = new THREE.Vector3(0, 0, 18), actor: Actor = SYSTEM) => {
    const h = handle.current;
    if (!h) return;
    h.controls.target.copy(target);
    h.camera.position.copy(target).addScaledVector(viewDir(azimuthDeg, elevationDeg), distance);
    h.camera.lookAt(target);
    h.invalidate("view");
    reportCamera(actor);
  };
  // ---- the camera and the view state: the view reports where it looks; a camera written elsewhere is taken ----
  /** While set, programmatic moves are not reported (a fit worked out and put back, the explode's camera tween). */
  const muteCamera = useRef(false);
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  const cameraNow = (h: SceneHandle): CameraState => ({
    position: h.camera.position.toArray().map(r3) as [number, number, number],
    target: h.controls.target.toArray().map(r3) as [number, number, number],
    up: h.camera.up.toArray().map(r3) as [number, number, number],
    fov: h.camera.fov,
  });
  /** Tell the view state where the camera is (the user's drag, a fit, a focus, the opening camera). */
  const reportCamera = (actor: Actor, gesture?: string) => {
    const h = handle.current;
    if (!h || muteCamera.current) return;
    const r = store.dispatch([{ op: "camera", camera: cameraNow(h) }], { actor, label: actor.kind === "human" ? "move the camera" : "place the camera", gesture: gesture ?? `camera:${actor.id}`, source: "view" });
    if (r && "error" in r) console.warn(`[cad] camera: ${r.error}`);
  };
  /**
   * Put the camera where the view state says (a host, an agent, a restored state). The view keeps its own up
   * direction (the display's `up`): a written camera's `up` is reported back, not applied (DEFAULT).
   */
  const applyCamera = (cam: CameraState) => {
    const h = handle.current;
    if (!h) return;
    cameraTween.current = null;
    viewTween.current = null;
    framed.current = true;
    h.controls.target.set(...cam.target);
    h.camera.position.set(...cam.position);
    if (cam.fov && Math.abs(cam.fov - h.camera.fov) > 1e-6) {
      h.camera.fov = cam.fov;
      h.camera.updateProjectionMatrix();
    }
    h.camera.lookAt(h.controls.target);
    h.controls.update();
    h.invalidate("view");
  };
  /**
   * Fit the camera to a box from a direction: the nearest distance at which
   * every corner is inside the view, leaving `margin` of each half-view free
   * (and the inspector's width on the right when it is open).
   */
  const fit = (box: THREE.Box3, azimuthDeg: number, elevationDeg: number) => {
    const h = handle.current;
    if (!h || box.isEmpty()) return;
    const dir = viewDir(azimuthDeg, elevationDeg);
    const f = dir.clone().negate();
    const right = f.clone().cross(h.camera.up).normalize();
    const up = right.clone().cross(f).normalize();
    const size = h.renderer.getSize(new THREE.Vector2());
    const tanV = Math.tan((h.camera.fov * Math.PI) / 360);
    const tanH = tanV * h.camera.aspect;
    // room for callout columns when labels are on, and for the inspector card
    const panel = !present && !noChrome && hub.opening.panel !== "none" && inspector && size.x > 900 ? 380 / size.x : 0;
    const mx = (showLabels ? 0.5 : 0.8) - panel;
    const my = 0.78;
    const c = box.getCenter(new THREE.Vector3());
    // shift the target so the model is centred in the part of the view the inspector leaves free
    let d = 1;
    for (let i = 0; i < 8; i++) {
      const p = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(c);
      const depth = p.dot(f);
      d = Math.max(d, Math.abs(p.dot(right)) / (tanH * Math.max(0.2, mx)) - depth, Math.abs(p.dot(up)) / (tanV * my) - depth);
    }
    const target = c.clone().addScaledVector(right, d * tanH * panel);
    // `?zoom=` (document mode): the fit comes that much closer
    orbit(azimuthDeg, elevationDeg, d / (hub.opening.zoom ?? 1), target);
  };
  /** Fit what is drawn now, from where the camera looks. */
  const fitAsSeen = () => {
    const h = handle.current;
    if (!h) return;
    const v = h.camera.position.clone().sub(h.controls.target).normalize();
    const local = v.clone().applyQuaternion(upQuat.clone().invert());
    fit(visibleBounds(), (Math.atan2(local.y, local.x) * 180) / Math.PI, (Math.asin(Math.max(-1, Math.min(1, local.z))) * 180) / Math.PI);
  };
  /**
   * Explode or assemble (R1-A, M11). The camera keeps the view the person framed and only follows the parts'
   * envelope: where they end is measured (laid out there for a moment and put back), and the camera moves by the
   * change of that envelope (`explodeCamera`), never a fresh fit. Nothing moves (a model with no steps, or steps
   * that move nothing): the camera stays and the model info card says so.
   */
  const toggleExploded = (on: boolean) => {
    const h = handle.current;
    const ex = explode.current;
    if (h && model && ex.target !== (on ? 1 : 0)) {
      // the sequence the parts follow, now (it resolves lazily, W3-C): without it nothing would move here
      if (!player.current && settledRef.current) resolveSequence();
      const steps = player.current?.snapshot().steps.length ?? 0;
      const where = () => {
        h.root.updateMatrixWorld(true);
        const out: THREE.Vector3[] = [];
        for (const rec of bodies.current.values()) {
          out.push(new THREE.Vector3().setFromMatrixPosition(rec.obj.matrixWorld));
          for (const part of rec.parts) out.push(new THREE.Vector3().setFromMatrixPosition(part.obj.matrixWorld));
        }
        for (const hw of hardware.current) out.push(new THREE.Vector3().setFromMatrixPosition(hw.obj.matrixWorld));
        return out;
      };
      const before = where();
      const fromBox = drawnBox();
      applyExplode(on ? 1 : 0);
      const after = where();
      const toBox = drawnBox();
      applyExplode(ex.value);
      h.root.updateMatrixWorld(true);
      const moved = before.reduce((m, p, i) => Math.max(m, after[i] ? p.distanceTo(after[i]) : 0), 0);
      const next = explodeCamera({ from: fromBox, to: toBox, moved, position: h.camera.position, target: h.controls.target });
      if (next) cameraTween.current = { from: [h.camera.position.clone(), h.controls.target.clone()], to: [next.position, next.target], start: ex.value };
      setExplodeNote(on && (steps === 0 || moved < EXPLODE_STILL_MM) ? "nothing to explode in this model" : null);
    }
    write([{ op: "explode", t: on ? 1 : 0 }], on ? "explode the assembly" : "assemble the parts");
  };
  /** What a selection covers: its body, or the parts of an assembly that has none of its own (QA B4). */
  const selectionRecs = (key: string | undefined): BodyRec[] => {
    if (key === undefined) return [];
    const own = bodies.current.get(key);
    if (own) return [own];
    return key ? [...bodies.current.entries()].filter(([k]) => k.startsWith(`${key}/`)).map(([, r]) => r) : [];
  };
  /**
   * Bring the selection into view (QA B4): its box framed from where the camera looks now, with room around it
   * (twice its size, and never closer than a hand's width of context), not filling the view. With an interface
   * picked, look along its normal at it instead.
   */
  const focus = () => {
    const h = handle.current;
    const recs = selectionRecs(sel.body);
    const rec = recs.length === 1 && sel.body !== undefined ? bodies.current.get(sel.body) : undefined;
    // a routed wire harness selected on its own: its geometry
    const wire = sel.body === undefined && sel.harness !== undefined ? harnessObjs.current.get(sel.harness) : undefined;
    const objs = wire ? [wire] : recs.map((r) => r.obj);
    if (!h || !objs.length) return;
    // a component inside a body (a board's U13): its own box, with less room around it (PB-1184, framing a callout)
    const holderKey = sel.body?.split("#")[0] ?? "";
    const part = rec && sel.component ? componentIn(rec.obj, holderKey && sel.component.startsWith(`${holderKey}/`) ? sel.component.slice(holderKey.length + 1) : sel.component, sel.component) : undefined;
    if (part && !sel.iface) {
      const box = part.box.clone();
      const size = box.getSize(new THREE.Vector3());
      // R1-A (M1): room of half its size on each side (twice its size in all, QA B4), at least 12 mm. DEFAULT. It was
      // 1.5x its size on each side, so a large part (ClientX's USB-C) left the board tiny ("why did it get smaller?")
      box.expandByScalar(Math.max(size.length() * 0.5, 12));
      const v = h.camera.position.clone().sub(h.controls.target).normalize();
      const local = v.clone().applyQuaternion(upQuat.clone().invert());
      fit(box, (Math.atan2(local.y, local.x) * 180) / Math.PI, (Math.asin(Math.max(-1, Math.min(1, local.z))) * 180) / Math.PI);
      return;
    }
    if (wire || !sel.iface || !rec) {
      const box = new THREE.Box3();
      for (const o of objs) box.expandByObject(o);
      if (box.isEmpty()) return;
      const size = box.getSize(new THREE.Vector3());
      const grow = Math.max(size.length() * 0.5, 40);
      box.expandByScalar(grow);
      const v = h.camera.position.clone().sub(h.controls.target).normalize();
      const local = v.clone().applyQuaternion(upQuat.clone().invert());
      fit(box, (Math.atan2(local.y, local.x) * 180) / Math.PI, (Math.asin(Math.max(-1, Math.min(1, local.z))) * 180) / Math.PI);
      return;
    }
    const f = rec.body.def.interfaces.find((i) => i.id === sel.iface)?.geometry?.frame;
    const target = f ? new THREE.Vector3(...f.origin).applyMatrix4(rec.obj.matrix) : rec.centre.clone().applyMatrix4(rec.obj.matrix);
    const n = f ? new THREE.Vector3(...f.normal).transformDirection(rec.obj.matrix) : new THREE.Vector3(0.6, -0.8, 0.6);
    const dir = n.clone().multiplyScalar(0.75).add(new THREE.Vector3(0.55, -0.75, 0).normalize().multiplyScalar(0.66)).normalize();
    h.controls.target.copy(target);
    h.camera.position.copy(target.clone().add(dir.multiplyScalar(160)));
    h.invalidate("view");
    reportCamera(SYSTEM);
  };
  /**
   * "Look along normal" (R1-A, E3): the camera turns to face the selection's dominant face, at the distance it is
   * now, eased over LOOK_ALONG_MS. The face is the one under the person's last pick on this selection, else the
   * largest face of its box (in its own frame: a tilted panel is faced square), else an interface's own normal.
   * "Fit" is unchanged.
   */
  const lookAlongNormal = () => {
    const h = handle.current;
    if (!h) return;
    const recs = selectionRecs(sel.body);
    const wire = sel.body === undefined && sel.harness !== undefined ? harnessObjs.current.get(sel.harness) : undefined;
    if (!recs.length && !wire) return;
    const toward = h.camera.position.clone().sub(h.controls.target);
    const rec = recs.length === 1 ? recs[0] : undefined;
    let box = new THREE.Box3();
    let normal: THREE.Vector3 | undefined;
    const pickKey = sel.component ?? sel.body ?? sel.harness;
    if (rec) rec.obj.updateWorldMatrix(true, true);
    const iface = rec && sel.iface ? rec.body.def.interfaces.find((i) => i.id === sel.iface)?.geometry?.frame : undefined;
    if (rec && iface) {
      box.setFromCenterAndSize(new THREE.Vector3(...iface.origin).applyMatrix4(rec.obj.matrixWorld), new THREE.Vector3());
      // an interface's frame normal points out of the part: the camera looks at it from that side
      normal = new THREE.Vector3(...iface.normal).transformDirection(rec.obj.matrixWorld);
    } else if (rec && sel.component) {
      const holderKey = rec.body.key.split("#")[0];
      const part = componentIn(rec.obj, holderKey && sel.component.startsWith(`${holderKey}/`) ? sel.component.slice(holderKey.length + 1) : sel.component, sel.component);
      if (part) {
        box = part.box.clone();
        // its box in the holder's frame (a board's parts sit square to the board)
        const toLocal = rec.obj.matrixWorld.clone().invert();
        normal = dominantNormal(part.box.clone().applyMatrix4(toLocal), rec.obj.matrixWorld, toward);
      }
    }
    if (box.isEmpty() && rec && !rec.box.isEmpty()) {
      box = rec.box.clone().applyMatrix4(rec.obj.matrixWorld);
      // gate R1: the way its surface faces (its triangles), else its box's flattest axis
      normal = principalNormal([rec.obj], toward) ?? dominantNormal(rec.box, rec.obj.matrixWorld, toward);
    }
    if (box.isEmpty()) {
      for (const o of wire ? [wire] : recs.map((r) => r.obj)) box.expandByObject(o);
      if (box.isEmpty()) return;
      normal = dominantNormal(box, new THREE.Matrix4(), toward);
    }
    // gate R1: which face. A part away from the middle of what is drawn (a shell panel) is faced from outside, away
    // from that middle (it was faced through the shell, from inside); a part at the middle (a board on its own) from
    // the side the camera is on, seen from the part's own centre (DEFAULT: "away" past 10 % of the drawn radius)
    if (normal && !iface) {
      const centre = box.getCenter(new THREE.Vector3());
      const drawn = drawnBox();
      const middle = drawn.isEmpty() ? centre : drawn.getCenter(new THREE.Vector3());
      const radius = drawn.isEmpty() ? 0 : drawn.getSize(new THREE.Vector3()).length() / 2;
      const out = centre.clone().sub(middle);
      const side = radius > 0 && out.length() > 0.1 * radius && Math.abs(out.clone().normalize().dot(normal)) > 0.2 ? out : h.camera.position.clone().sub(centre);
      if (normal.dot(side) < 0) normal.negate();
    }
    // the person's own pick on this selection: the face they clicked
    if (lastPick.current && lastPick.current.key === pickKey && !iface) normal = lastPick.current.normal.clone();
    const target = box.getCenter(new THREE.Vector3());
    const position = lookAlong(target, target.clone().add(toward), normal ?? toward.clone().normalize(), upRef.current);
    const from = { position: h.camera.position.clone(), target: h.controls.target.clone() };
    const to = { position, target };
    cameraTween.current = null;
    const reduced = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      h.controls.target.copy(target);
      h.camera.position.copy(position);
      h.camera.lookAt(target);
      h.invalidate("view");
      reportCamera(SYSTEM);
      return;
    }
    viewTween.current = { from, to, start: performance.now(), ms: LOOK_ALONG_MS };
    h.invalidate("view");
  };
  reportCameraRef.current = reportCamera;
  /** Bounds of each body as drawn now, from its precise local box (the same box from a sidecar or a plain GLB). */
  const drawnBounds = (rec: BodyRec): [[number, number, number], [number, number, number]] | null => {
    if (rec.box.isEmpty()) return null;
    rec.obj.updateMatrixWorld(true);
    const box = rec.box.clone().applyMatrix4(rec.obj.matrixWorld);
    for (const part of rec.parts) if (!part.cadBox.isEmpty()) box.union(part.cadBox.clone().applyMatrix4(rec.obj.matrixWorld).translate(part.travel));
    return [box.min.toArray().map(r3) as [number, number, number], box.max.toArray().map(r3) as [number, number, number]];
  };
  /** The assembly's root as a path from the root system (the body nothing placed: `""` is the system itself). */
  const rootOf = () => {
    const b = model?.bodies.find((x) => !x.via && !x.hint);
    return b ? outOfScope(b.path.join("/"), at) : undefined;
  };
  /** What the 3D view draws, as data (PB-1175, PB-1178): the observation plus the view state's seq, the root and the placeholders. */
  const observe = (opts: { components?: boolean } = {}): Omit<CadObservation, "loading"> & { loading: CadObservation["loading"] & { stage?: string }; frame: number; versions: Record<string, number>; scope: string; root?: string; placeholders: PlaceholderSummary; sequence?: PlayerSnapshot } => {
    const h = handle.current!;
    const st = h.stats();
    const obs = observeScene({
      // the view state's version (PB-1178): a write a batch did not see raises it; frames drawn are `frame`
      seq: store.seq,
      bodies: [...bodies.current.values()].map((r) => ({ key: r.body.key, obj: r.obj, hasModel: r.hash !== "" })),
      harnesses: harnessObjs.current,
      selection: { ...selRef.current },
      camera: h.camera,
      target: h.controls.target,
      counts: { draws: st.last.draws, triangles: st.last.triangles, frames: st.frames, ...(st.batch ? { instances: st.batch.instances, batches: st.batch.groups, materials: st.batch.materials } : {}) },
      loading: loadState.current,
      ...(opts.components === false ? { components: false } : {}),
    });
    // bodies: precise bounds from the body's own box, so a sidecar-to-GLB hot swap does not move them (handoffs W2-A item 2)
    for (const n of obs.nodes) {
      if (n.kind !== "body") continue;
      const rec = bodies.current.get(n.id);
      if (rec && rec.hash) n.bounds = drawnBounds(rec);
    }
    const summary = placeholderSummary(observeScene({ ...obsInput(h), components: true }).nodes, [...source.hostDiagnostics, ...hostDiagnostics], (p) => intoScope(p, at));
    const loadStage = tracker.current?.tracker.snapshot()?.stage;
    return {
      ...obs,
      ...(loadStage ? { loading: { ...obs.loading, stage: loadStage } } : {}),
      frame: st.frames,
      versions: store.versions(),
      scope: at,
      ...(rootOf() !== undefined ? { root: rootOf() } : {}),
      placeholders: summary,
      ...(player.current ? { sequence: player.current.snapshot() } : {}),
    };
  };
  const obsInput = (h: SceneHandle) => ({
    seq: store.seq,
    bodies: [...bodies.current.values()].map((r) => ({ key: r.body.key, obj: r.obj, hasModel: r.hash !== "" })),
    harnesses: harnessObjs.current,
    selection: {},
    camera: h.camera,
    target: h.controls.target,
    counts: { draws: 0, triangles: 0, frames: 0 },
    loading: loadState.current,
  });
  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    // Deterministic control for video capture (scripts/capture-cad-video.mjs), and the view state (PB-1178)
    const cadApi: Record<string, unknown> = {
      ready: () => loaded,
      settled: () => settled,
      /**
       * Capture control (azimuth, elevation, distance, target, explode, labels, snap, caption: the capture scripts'
       * keys, which switch the view to drawing on `renderOnce` only), and view-state keys (camera, selection,
       * highlight, isolation, visibility, direction, sections, explode as `{t, step}`, namedViews), written as the
       * page's script would: last writer wins, logged as the `__cad` actor.
       */
      set: (s: { azimuth?: number; elevation?: number; distance?: number; target?: [number, number, number]; explode?: number | { t: number; step?: string | null }; labels?: boolean; snap?: boolean; caption?: [string, string] } & Partial<Record<string, unknown>>) => {
        const capture = ["azimuth", "elevation", "distance", "labels", "snap", "caption"].some((k) => k in s) || typeof s.explode === "number";
        // the assembly sequence (W2-C): a command, or a step and an explode amount
        if (s.sequence !== undefined || s.step !== undefined || s.t !== undefined) {
          // the sequence resolves lazily (W3-C): a capture page asked for a step resolves it now (gate 3)
          if (!player.current && settledRef.current) resolveSequence();
          const seq = s.sequence as SequenceCommand | true | undefined;
          const r = typeof seq === "object" ? runSequence(seq) : player.current ? runSequence({ action: "set", t: typeof s.t === "number" ? s.t : player.current.t }) : { ok: false, error: "no sequence yet" };
          if (typeof s.step === "string" && player.current) {
            seqDriving.current = true;
            try {
              player.current.set({ step: s.step, ...(typeof s.t === "number" ? { t: s.t } : {}) });
            } finally {
              seqDriving.current = false;
            }
            explode.current.value = explode.current.target = player.current.t;
            applyExplode(player.current.t, true);
          }
          if (!r.ok) throw new Error(r.error ?? "sequence command refused");
          h.renderOnce();
        }
        if (capture) h.manual.on = true;
        const stateKeys = ["camera", "selection", "highlight", "isolation", "visibility", "direction", "sections", "placements", "theme", "namedViews", "annotations"].filter((k) => k in s);
        if (stateKeys.length || (s.explode !== undefined && typeof s.explode === "object")) {
          const ops = stateKeys.map((k) => ({ op: "set", path: [k], value: s[k] }));
          if (typeof s.explode === "object") ops.push({ op: "set", path: ["explode"], value: { t: s.explode.t, step: s.explode.step ?? null } });
          const r = store.dispatch(ops, { actor: SCRIPT, label: "set from the page script", source: "host" });
          if (r && "error" in r) throw new Error(r.error);
        }
        if (s.caption) setCaption(s.caption);
        if (typeof s.explode === "number") {
          explode.current.value = explode.current.target = s.explode;
          const e = s.explode;
          applyExplode(e < 0.5 ? 4 * e ** 3 : 1 - (-2 * e + 2) ** 3 / 2);
          store.dispatch([{ op: "explode", t: Math.min(1, Math.max(0, e)) }], { actor: SCRIPT, label: "set the explode amount", source: "capture" });
          h.invalidate();
        }
        if (s.labels !== undefined && labelsRef.current) {
          labelsRef.current.target = s.labels ? 1 : 0;
          // stills: no fade between shots
          if (s.snap) labelsRef.current.opacity = labelsRef.current.target;
        }
        if (s.snap && labelsRef.current) {
          labelsRef.current.snap = true;
        }
        // callouts drawn in place for a still (no reveal animation), from the records just written
        if ("annotations" in s) syncAnnot.current();
        if (s.snap && annotRef.current) annotRef.current.snap = true;
        if (s.azimuth !== undefined) orbit(s.azimuth, s.elevation ?? 28, s.distance ?? 520, s.target ? new THREE.Vector3(...s.target) : undefined, SCRIPT);
        h.renderOnce();
      },
      /** The view state (./state, PB-1178): camera, selection, visibility, sections, explode, named views, the facts. */
      get: () => serializeViewState(store.get()),
      /** A checked batch, as the live-tab bridge applies one (preconditions, the op log, a resent batchId answered from memory). */
      apply: (batch: Batch) => store.applyBatch(batch, { kind: "agent", id: "__cad" }, "host"),
      /** The op log after `since`. */
      log: (since?: number) => store.log(since),
      /** The named views and annotations, as the display file keeps them (`spatial.views`, `spatial.annotations`). */
      presentation: () => presentation(store.get()),
      /**
       * What is drawn, as data (PB-1175): every body (and the parts a GLB names by instance path, and every routed
       * harness) with its bounds as drawn now, the selection, the camera and the last frame's counts. `seq` is the
       * view state's version (it rises with every committed write, PB-1178); `frame` counts frames drawn.
       * `placeholders` is "N of M components are placeholders"; `root` the instance the assembly is placed from.
       */
      observe,
      /** The loads' progress (also `onLoadState`). */
      loading: (): LoadState => ({ ...loadState.current }),
      /** Check every model's content again and hot-swap what changed (a GLB re-exported to the same path). */
      refresh: () => setReload((n) => n + 1),
      /** Renderer and batcher counts, frames drawn so far, BVH builds. */
      stats: () => ({ ...h.stats(), bvh: bvhStats(), cachedModels: glbCache.size }),
      /** Pick at a point of the view (fractions of its width and height from the top left). */
      pick: (fx: number, fy: number) => {
        const ray = new THREE.Raycaster();
        ray.setFromCamera(new THREE.Vector2(fx * 2 - 1, -(fy * 2 - 1)), h.camera);
        const hit = pickAt(ray.ray);
        if (!hit) return null;
        const body = hit.object.userData.bodyKey as string | undefined;
        const child = (hit.object.userData.component as string | undefined) ?? hit.partInstanceId;
        return {
          body,
          harness: hit.object.userData.harness as string | undefined,
          instancePath: body !== undefined && child !== undefined ? instancePathIn(body.split("#")[0], child) : (body?.split("#")[0] ?? hit.object.userData.harness),
          face: hit.face,
          feature: hit.feature,
          triangle: hit.triangle,
          point: hit.point.toArray().map((n) => Math.round(n * 1000) / 1000),
          distance: Math.round(hit.distance * 1000) / 1000,
        };
      },
      /** Build every BVH now and say how long it took (the GPU id-buffer fallback is due above 2 s). */
      bvh: () => buildAll([h.root, harnessGroup.current]),
      /** The assembly sequence player's state (W2-C, PB-1183): steps with ids and titles, t, the current step, joints. */
      sequence: () => player.current?.snapshot(),
      /** The quality curve (W2-B, PB-1176): its state, knobs, bottleneck and attention, read-only. */
      quality: () => h.quality.report(),
      /** Configure the quality curve (`{ enabled, tauMs, budgetMs, ... }`, as `createScene`'s `quality`). */
      configureQuality: (c: Record<string, unknown>) => h.quality.configure(c),
      /** The loading screen's stage (PB-1177): captures may wait on `stage === "ready"`. */
      loadStage: () => tracker.current?.tracker.snapshot(),
      /**
       * World points (mm, the root's coordinates) to the canvas (W2-D, PB-1180): `[px, py, depth]`, CSS pixels
       * from the canvas's top left, and the distance along the view axis (negative: behind the camera).
       */
      project: (points: [number, number, number][]) => projectPoints(h, points),
      /**
       * Callouts and findings as drawn on the last frame (PB-1184): per record and pinned finding card its status
       * (placed, pinned, occluded, offscreen, orphan, hidden), the anchor and label box in CSS px; the findings with
       * their 3D anchors ("no location" ones have none and a reason); the layer's placement times (ms).
       */
      annotations: () => ({ records: annotRef.current?.report() ?? [], findings: annotFindingsRef.current, timing: annotRef.current?.timing(), placement: annotRef.current?.debug }),
      /**
       * Measure in the page (W3-D, PB-1187): picks are `[fx, fy]` fractions of the canvas; the mesh tier's result,
       * the exact tier's request for the CLI, and the refs picked.
       */
      measure: (kind: MeasureKind, picks: [number, number][]) => {
        const refs: MeasureRef[] = [];
        for (const [fx, fy] of picks) {
          const rc = new THREE.Raycaster();
          rc.setFromCamera(new THREE.Vector2(fx * 2 - 1, -(fy * 2 - 1)), h.camera);
          h.scene.updateMatrixWorld();
          const r = pickRef(rc.ray, [h.root], { clippingPlanes: h.renderer.clippingPlanes });
          if (!r) return { error: `nothing drawn at [${fx}, ${fy}]` };
          refs.push(r);
        }
        const [a, b] = refs;
        const mesh =
          kind === "face-face" && a && b
            ? measureFaceFace(refFace(a, "assembly"), refFace(b, "assembly"))
            : kind === "point-point" && a && b
              ? measurePointPoint(a.point, b.point, { a: refFace(a, "assembly"), b: refFace(b, "assembly") })
              : kind === "point-face" && a && b
                ? measurePointFace(a.point, refFace(b, "assembly"), refFace(a, "assembly"))
                : kind === "cylinder" && a
                  ? measureCylinder(refFace(a, "assembly"))
                  : kind === "bounds" && a
                    ? measureBounds(refFace(a, "assembly"))
                    : undefined;
        if (!mesh) return { error: `${kind} needs ${kind === "cylinder" || kind === "bounds" ? "one pick" : "two picks"}` };
        return { mesh, request: exactRequest(kind, a, b), refs: refs.map((r) => ({ part: r.part, component: r.component, face: r.face, point: r.point })) };
      },
      /** A body's size in its own frame (W3-D): by instance path from the root. */
      measureBounds: (path: string) => {
        const key = keyIntoScope(path);
        const rec = key !== undefined ? bodies.current.get(key) : undefined;
        return rec ? measureBounds(objectFace(rec.obj, "part"), "part") : { error: `no body ${path}` };
      },
      /** Drawn labels' boxes (W3-D's critic): CSS px from the canvas's top left, with what each points at. */
      labels: () => {
        const r = h.renderer.domElement.getBoundingClientRect();
        const out: { id: string; rect: [number, number, number, number]; target?: string }[] = [];
        for (const s of annotRef.current?.report() ?? []) if (s.labelBox) out.push({ id: s.id, rect: [s.labelBox.x, s.labelBox.y, s.labelBox.w, s.labelBox.h], ...(s.ref ? { target: s.ref } : {}) });
        for (const c of labelsRef.current?.boxes() ?? []) out.push({ id: c.id, rect: [Math.round(c.rect.left - r.left), Math.round(c.rect.top - r.top), Math.round(c.rect.width), Math.round(c.rect.height)] });
        return out;
      },
      /** Play a tour (W3-D, PB-1188; `protoboard.tour/v0`), or stop with null. Any input of the person pauses it. */
      tour: (t: unknown) => playTour(t),
      /** Select a part by instance path from the root and frame it (a finding's "look at"; scripts and tests). */
      lookAt: (ref: string) => lookAtRef(ref),
      /** Who is working where, as chips near the parts (PB-1184, until W3-A's bridge sends it): `[{who, ref, intent?}]`. */
      presence: (list: PresenceChip[]) => setPresenceSet(Array.isArray(list) ? list.slice(0, 16) : []),
    };
    (window as unknown as Record<string, unknown>).__cad = cadApi;
    // the host handle and the live-tab bridge read the same observation (./state/hub.ts)
    hub.observer = (opts) => observe(opts);
    hub.view = "3d";
    // the bridge's probes (W4-D: the critic's pick probes and label boxes, MCP view_review and view_pick)
    hub.pick = cadApi.pick as (fx: number, fy: number) => unknown;
    hub.labels = cadApi.labels as () => unknown[];
    hub.canvas = () => ({ width: h.renderer.domElement.clientWidth, height: h.renderer.domElement.clientHeight });
    // a host's quality settings (uhd-viewer:quality) reach this view's curve
    hub.quality = (c) => {
      h.quality.configure(c as never);
      return h.quality.report();
    };
    // a host's sequence commands (uhd-viewer:sequence) reach this view's player
    hub.sequence = (command) => {
      const r = runSequence(command as unknown as SequenceCommand);
      return { type: "uhd-viewer:sequenceState", ok: r.ok, ...(r.error ? { error: r.error } : {}), ...(r.state ? { state: r.state } : {}) };
    };
    return () => {
      if (hub.observer) hub.observer = undefined;
      hub.pick = undefined;
      hub.labels = undefined;
      hub.canvas = undefined;
      hub.sequence = undefined;
      hub.quality = undefined;
      hub.view = "diagram";
      // the API holds this view's scene handle: gone with the view, so a script never drives a disposed renderer (wave 2 gate)
      const w = window as unknown as Record<string, unknown>;
      if (w.__cad === cadApi) delete w.__cad;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyExplode, loaded, settled]);

  // ---- named views from the display file (deliberate presentation: `spatial.views`, read as the project keeps them) ----
  const displayViews = useMemo(() => presentationFromDisplay(source.display as { spatial?: Record<string, unknown> }), [source]);
  useEffect(() => {
    if (same(displayViews.namedViews, store.get().namedViews) && same(displayViews.annotations, store.get().annotations)) return;
    store.dispatch(
      [
        { op: "set", path: ["namedViews"], value: displayViews.namedViews },
        { op: "set", path: ["annotations"], value: displayViews.annotations },
      ],
      { actor: SYSTEM, label: "read the saved views", source: "display" },
    );
  }, [displayViews, store]);

  // ---- the view state's camera, written elsewhere (a host, an agent, a restored state), is where the view looks ----
  useEffect(
    () =>
      store.subscribe((c) => {
        if (c.source === "view" || !c.state.camera || c.state.camera === c.prev.camera) return;
        openedByDefault.current = false;
        applyCamera(c.state.camera);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store],
  );
  // the user's own camera moves (orbit, pan, zoom, and the damping after): reported at most every CAMERA_REPORT_MS
  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    let user = false;
    let last = 0;
    let trailing: ReturnType<typeof setTimeout> | undefined;
    let ending: ReturnType<typeof setTimeout> | undefined;
    const report = () => {
      last = performance.now();
      reportCamera(HUMAN, "camera");
    };
    const onStart = () => {
      user = true;
      // the user took the camera: no opening fit or tween takes it back
      framed.current = true;
      openedByDefault.current = false;
      cameraTween.current = null;
      viewTween.current = null;
      clearTimeout(ending);
    };
    const onChange = () => {
      if (!user) return;
      const t = performance.now();
      clearTimeout(trailing);
      if (t - last >= CAMERA_REPORT_MS) report();
      else trailing = setTimeout(report, CAMERA_REPORT_MS - (t - last));
    };
    const onEnd = () => {
      clearTimeout(ending);
      // damping carries the camera on a little after the pointer lets go
      ending = setTimeout(() => {
        clearTimeout(trailing);
        report();
        user = false;
      }, 350);
    };
    h.controls.addEventListener("start", onStart);
    h.controls.addEventListener("change", onChange);
    h.controls.addEventListener("end", onEnd);
    return () => {
      clearTimeout(trailing);
      clearTimeout(ending);
      h.controls.removeEventListener("start", onStart);
      h.controls.removeEventListener("change", onChange);
      h.controls.removeEventListener("end", onEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // the loads' progress is a fact of the view state (read-only for writers)
  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    const f = () => {
      const l = loadState.current;
      store.setFacts({ loading: { phase: l.phase, total: l.total, done: l.done, failed: l.failed } });
      return false;
    };
    h.beforeRender.add(f);
    f();
    return () => void h.beforeRender.delete(f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // the opening camera (once): the view state's when it has one (this scope seen before, a restored or written state),
  // else the URL's (cam, view3d, az/el/dist), else the project's saved view, else the defaults; the model is fitted once
  // every model has loaded unless a camera or a distance was given (PB-873)
  const urlOpen = hub.opening;
  const saved = at ? undefined : display.view?.camera;
  const opening = {
    az: urlOpen.az ?? saved?.azimuth ?? -58,
    el: urlOpen.el ?? saved?.elevation ?? 28,
    dist: urlOpen.dist ?? saved?.distance,
    target: saved?.target ? new THREE.Vector3(...saved.target) : undefined,
  };
  const framed = useRef(false);
  /** The camera is still the default opening orbit this view put there (no one chose it). */
  const openedByDefault = useRef(false);
  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    h.setUp(upVec);
    const have = store.get().camera;
    if (have) {
      applyCamera(have);
      // the camera this view placed itself by default (React's development double mount runs this twice): still
      // to be fitted once the models are in, not a camera someone chose (R1-A, M1)
      if (openedByDefault.current) framed.current = false;
      return;
    }
    if (urlOpen.camera) {
      applyCamera({ ...urlOpen.camera, up: urlOpen.camera.up ?? (upVec.toArray() as [number, number, number]) });
      return reportCamera(SYSTEM);
    }
    if (urlOpen.view && store.get().namedViews[urlOpen.view]) {
      store.dispatch([{ op: "applyView", name: urlOpen.view }], { actor: SYSTEM, label: `open the named view ${urlOpen.view}`.slice(0, 120), source: "url" });
      return;
    }
    if (!urlOpen.focus) {
      orbit(opening.az, opening.el, opening.dist ?? 520, opening.target);
      openedByDefault.current = opening.dist === undefined;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upVec]);
  useEffect(() => {
    const h = handle.current;
    if (!h || !model || !settled) return;
    const box = assembledBounds();
    h.setGround(box);
    if (h.manual.on) return;
    // R1-A (M1): the camera is fitted on a first load only. A rebuild's hot swap or a remount keeps the camera the
    // person (or a host, or a restored state) placed, unless the model's size changed by more than REFIT_RATIO
    // (DEFAULT 2x): then it is fitted again from where the camera looks
    const drawn = visibleBounds();
    const memo = `${system.id}|${at}`;
    const placed = framed.current || urlOpen.focus || opening.dist !== undefined;
    if (!placed) {
      framed.current = true;
      openedByDefault.current = false;
      // what is drawn: a section view opens on the half it keeps, centred
      fit(drawn, opening.az, opening.el);
    } else if (needsRefit(fittedBoxes.get(memo), drawn, true)) {
      fitAsSeen();
    }
    if (opening.dist !== undefined) framed.current = true;
    if (!drawn.isEmpty()) fittedBoxes.set(memo, drawn.clone());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, model]);
  // gate R1 (M1): what the person shows (isolation, hidden parts) is the size the next rebuild compares with: isolating
  // the board after the whole assembly was fitted made the next rebuild refit the camera (the drawn bounds shrank
  // past REFIT_RATIO against the memo of the whole assembly)
  useEffect(() => {
    if (!settled || !model) return;
    const drawn = visibleBounds();
    if (!drawn.isEmpty()) fittedBoxes.set(`${system.id}|${at}`, drawn.clone());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isolation, hidden]);
  useEffect(() => {
    // `?focus=1` frames the focus once (per system and scope), not again on every rebuild (R1-A, M1)
    const memo = `${system.id}|${at}`;
    if (!urlOpen.focus || urlFocusDone.has(memo) || loaded < (model?.bodies.filter((b) => b.glb).length ?? 1)) return;
    urlFocusDone.add(memo);
    focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, model]);

  // ---- the host's snapshot first (PB-1180, W2-D's handoff): painted at once, the camera set exactly, then live -------
  const [shot, setShot] = useState<{ msg: ViewerSnapshotMessage; fading: boolean; local?: boolean } | null>(() => (hub.snapshot && snapshotFor(hub.snapshot, at) ? { msg: hub.snapshot, fading: false } : null));
  useEffect(() => {
    hub.onSnapshot = (m) => {
      // R1-B handoff (B3): a host's snapshot paints only before the first models are in, never over a hot swap
      if (snapshotFor(m, at) && !settledRef.current && bodies.current.size === 0) setShot({ msg: m, fading: false });
    };
    return () => void (hub.onSnapshot = undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hub, at]);
  // its camera and view, exactly, before the first live frame: no jump when it goes live
  useEffect(() => {
    if (!shot || shot.fading) return;
    const m = shot.msg;
    const ops: unknown[] = [];
    if (m.camera) ops.push({ op: "camera", camera: m.camera });
    const vs = m.viewState ?? {};
    for (const k of ["selection", "highlight", "isolation", "visibility", "sections", "explode"] as const) if (vs[k] !== undefined) ops.push({ op: "set", path: [k], value: vs[k] });
    if (!ops.length) return;
    const r = store.dispatch(ops, { actor: SNAPSHOT, label: "open where the snapshot left it", source: "snapshot" });
    if (r && "error" in r) console.warn(`[cad] snapshot view not taken: ${r.error}`);
    if (typeof vs.explode?.t === "number") explode.current.value = explode.current.target = vs.explode.t;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shot?.msg]);
  const settledRef = useRef(false);
  settledRef.current = settled;
  // the 160 ms fade timers, cleared on unmount (wave 2 gate item 3)
  const fadeTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(
    () => () => {
      for (const t of fadeTimers.current) clearTimeout(t);
      fadeTimers.current = [];
    },
    [],
  );
  // the first frame after every model is in: the snapshot fades out (150 ms) over the live view
  useEffect(() => {
    const h = handle.current;
    if (!h || !settled || !shot || shot.fading) return;
    const off = h.onFrame(() => {
      off();
      setShot((s) => (s ? { ...s, fading: true } : s));
      fadeTimers.current.push(
        setTimeout(() => {
          setShot(null);
          hub.snapshot = undefined;
        }, 160),
      );
    });
    h.invalidate();
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, shot?.msg]);
  // ---- one snapshot path (W2-B's settle snapshots, PB-1176 and PB-1180): the save points for the host, and the
  // tab's picture while the view is suspended (hidden, or over the live-view budget) until it draws again
  const lastSnap = useRef<{ blob: Blob; width: number; height: number } | null>(null);
  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    const offSnap = h.onSnapshot((snap) => {
      lastSnap.current = snap;
      const save = hub.savePoint;
      const cam = store.get().camera;
      if (!save || !cam || !settledRef.current) return;
      const el = h.renderer.domElement;
      save({ png: snap.blob, level: at, view: "3d", width: snap.width, height: snap.height, css: { width: el.clientWidth, height: el.clientHeight, dpr: h.renderer.getPixelRatio() }, camera: cam, viewState: store.get(), reason: snap.reason === "settle" || snap.reason === "request" ? "settle" : "hide", takenAt: new Date().toISOString() });
    });
    let pictureUrl: string | undefined;
    const offLife = h.onLifecycle((st) => {
      if (st.suspended && lastSnap.current) {
        if (pictureUrl) URL.revokeObjectURL(pictureUrl);
        pictureUrl = URL.createObjectURL(lastSnap.current.blob);
        setShot({ msg: { type: "uhd-viewer:snapshot", schema: "protoboard.snapshot/v0", view: "3d", level: at, imageUrl: pictureUrl }, fading: false, local: true });
      } else if (!st.suspended) {
        // live again: the picture goes with the first frame
        const off = h.onFrame(() => {
          off();
          setShot((cur) => (cur?.local ? { ...cur, fading: true } : cur));
          fadeTimers.current.push(setTimeout(() => setShot((cur) => (cur?.local ? null : cur)), 160));
        });
        h.invalidate();
      }
    });
    return () => {
      offSnap();
      offLife();
      if (pictureUrl) URL.revokeObjectURL(pictureUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // the first save point once every model is in (the curve's own settle snapshots follow each later gesture)
  useEffect(() => {
    const h = handle.current;
    if (!h || !settled || !hub.savePoint) return;
    const t = setTimeout(() => void h.snapshot(), 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, model]);

  // ---- attention (W2-B, PB-1176): what is selected and what an agent points at keep full quality while moving ----
  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    const selected = new Set<string>();
    if (sel.harness) selected.add(sel.harness);
    for (const r of selectionRecs(sel.body)) selected.add(r.body.key);
    h.setAttention("selected", selected);
    // a highlighted component keeps its holder body at full quality too (R1-A, A1)
    h.setAttention("agent", [...bodies.current.keys(), ...harnessObjs.current.keys()].filter((k) => highlight.some((p) => matchesPath(k, p) || holdsPath(k, p))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, highlight, loaded, settled]);

  // ---- the quality curve's state is a read-only fact of the view state (W2-B) -----------------------
  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    const report = () => store.setFacts({ quality: { mode: h.quality.report().state } });
    report();
    return h.quality.onChange(report);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- "N of M components are placeholders" (handoffs W2-A item 1): once the models are in -------------------
  const [placeholders, setPlaceholders] = useState<PlaceholderSummary | null>(null);
  useEffect(() => {
    const h = handle.current;
    if (!h || !settled || !model) return;
    const nodes = observeScene({ ...obsInput(h), components: true }).nodes;
    setPlaceholders(placeholderSummary(nodes, [...source.hostDiagnostics, ...hostDiagnostics], (p) => intoScope(p, at)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, model, hostDiagnostics]);

  // a host's focus: select the module's body (the board body a component is drawn in, or the
  // nearest placed module above it), then look at it once its model is loaded
  const look = useRef(false);
  useEffect(() => {
    if (!focusOn || !model) return;
    // R1-A (A2): a focus is applied once per page. The view remounts on a rebuild or a tab switch and used to apply
    // the shell's last focus again (an old hierarchy click), selecting the board after the person had cleared it
    if (!freshFocus(focusOn)) return;
    if (focusOn.kind === "none") return setSel({});
    // the host names paths from the root: in a module's view, what lies outside it is not there to select
    const key = intoScope(focusOn.path, at);
    if (key === undefined) return;
    if (focusOn.kind === "link") {
      if (model.assembly.mates.some((m) => m.linkId === key)) setSel({ mate: key });
      return;
    }
    // a routed wire harness: selected as itself (a hierarchy row, a host's focus or select on it)
    if (model.assembly.harnesses.some((hp) => hp.key === key)) {
      setSel({ harness: key });
      // framed once its geometry is there (never left set for whatever is selected next)
      look.current = focusOn.look !== false && harnessObjs.current.has(key);
      return;
    }
    // the body; a component in the body that draws it (never that body alone: it painted the whole board, A2); an
    // assembly drawn by its parts (QA B4)
    const next: CadSelection | undefined = focusSelection(key, model.bodies.map((b) => b.key), model.within);
    if (!next) return;
    setSel(next);
    look.current = focusOn.look !== false;
  }, [focusOn, model]);
  useEffect(() => {
    if (!look.current) return;
    const wire = sel.body === undefined && sel.harness !== undefined && harnessObjs.current.has(sel.harness);
    if (!wire && (sel.body === undefined || !selectionRecs(sel.body).length)) return;
    look.current = false;
    focus();
    handle.current?.renderOnce();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, loaded]);
  const selectHandler = useRef(onSelect);
  selectHandler.current = onSelect;
  // the host hears paths from the root
  useEffect(() => {
    const out = (p: string | undefined) => (p === undefined ? undefined : p.includes("#") ? `${outOfScope(p.split("#")[0], at)}#${p.split("#")[1]}` : outOfScope(p, at));
    // R1-A (M2): a component named by its id in its body (the inspector card's rows) is named by its instance path
    const holder = sel.body?.split("#")[0];
    const component = sel.component !== undefined && holder !== undefined ? instancePathIn(holder, sel.component) : sel.component;
    selectHandler.current?.({ ...sel, ...(sel.body !== undefined ? { body: out(sel.body) } : {}), ...(component !== undefined ? { component: out(component) } : {}), ...(sel.harness !== undefined ? { harness: out(sel.harness) } : {}), ...(sel.mate !== undefined ? { mate: out(sel.mate) } : {}) });
  }, [sel, at]);

  // render on demand (PB-1175): whatever React state changed (selection, visibility, explode, sections, labels,
  // a load) asks for one frame after the effects above have changed the scene. Nothing changes: no frame.
  useEffect(() => {
    handle.current?.invalidate();
  });

  // ---- W3-D: display-side placements (PB-1187 place on face / orient by face) --------------------------------
  // while `placements[path]` exists the body is drawn at that matrix instead of its assembled base; an explode moves
  // it by its explode delta on top (DEFAULT, W3-D); dropped when the key is removed
  const placements = useViewSlice(store, (s) => (s as { placements?: Record<string, { matrix?: number[] }> }).placements);
  const placedBase = useRef(new Map<string, { rec: BodyRec; base: THREE.Matrix4 }>());
  /**
   * The shown scope's frame in the root assembly's (W4-D, wave 3 carry-forward: placements are stored relative to
   * the root, not per scope): from a body both assemblies place, root = S x scope. Identity at the root; undefined
   * when no body is placed by both (DEFAULT: a placement made then keeps `frame: <scope>` and shows only there).
   */
  const rootFrame = useRef<{ model: CadModel | null; at: string; s: THREE.Matrix4 | undefined } | null>(null);
  const scopeToRoot = (): THREE.Matrix4 | undefined => {
    if (!at) return new THREE.Matrix4();
    if (rootFrame.current && rootFrame.current.model === model && rootFrame.current.at === at) return rootFrame.current.s?.clone();
    let s: THREE.Matrix4 | undefined;
    if (model && manifests) {
      try {
        const rootModel = scopedModel(system, lookup, manifests, display, "");
        for (const b of model.bodies) {
          const r = rootModel.bodies.find((x) => x.key === `${at}/${b.key}`);
          if (r) {
            s = toMatrix4(r.matrix).multiply(toMatrix4(b.matrix).invert());
            break;
          }
        }
      } catch {
        s = undefined;
      }
    }
    rootFrame.current = { model, at, s };
    return s?.clone();
  };
  /** A stored placement as drawn in this scope (part to the scope's assembly), or undefined when it is not shown here. */
  const placementHere = (pl: { matrix: number[]; frame?: unknown }): THREE.Matrix4 | undefined => {
    const m = toMatrix4(pl.matrix as unknown as Parameters<typeof toMatrix4>[0]);
    if (typeof pl.frame === "string") return pl.frame === at ? m : undefined;
    const s = scopeToRoot();
    return s ? s.invert().multiply(m) : undefined;
  };
  useEffect(() => {
    const keep = new Set<string>();
    for (const [path, pl] of Object.entries(placements ?? {})) {
      const key = keyIntoScope(path);
      const rec = key !== undefined ? bodies.current.get(key) : undefined;
      if (!rec || key === undefined || !Array.isArray(pl?.matrix) || pl.matrix.length !== 16 || !pl.matrix.every(Number.isFinite)) continue;
      const here = placementHere(pl as { matrix: number[]; frame?: unknown });
      if (!here) continue;
      const was = placedBase.current.get(key);
      if (!was || was.rec !== rec) placedBase.current.set(key, { rec, base: rec.base.clone() });
      rec.base.copy(here);
      if (!player.current) rec.obj.matrix.copy(rec.base);
      keep.add(key);
    }
    for (const [key, { rec, base }] of placedBase.current) {
      if (keep.has(key)) continue;
      if (bodies.current.get(key) === rec) {
        rec.base.copy(base);
        if (!player.current) rec.obj.matrix.copy(rec.base);
      }
      placedBase.current.delete(key);
    }
    if (player.current) applyExplode(player.current.t, true);
    handle.current?.invalidate("pose");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placements, loaded, settled]);

  // ---- W4-D: placement verbs from the bridge (MCP view_place_on_face / view_orient_by_face, PB-1187) -------------
  // Faces are read in the body's own frame and placed by the body's assembled pose (`rec.base`), never by what is
  // drawn now, so a placement made while exploded is the same as one made assembled (wave 3 carry-forward).
  const faceInScope = (path: string, face: number): MeshFaceInput | undefined => {
    const scoped = keyIntoScope(path);
    if (scoped === undefined) return undefined;
    const holder = bodies.current.has(scoped)
      ? scoped
      : [...bodies.current.keys()].filter((k) => scoped.startsWith(`${k.split("#")[0]}/`)).sort((a, b) => b.length - a.length)[0];
    const rec = holder !== undefined ? bodies.current.get(holder) : undefined;
    if (!rec || holder === undefined) return undefined;
    const wrapper = rec.obj.children.find((c) => c.name === "cad");
    let mesh: THREE.Mesh | undefined;
    rec.obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (mesh || !m.isMesh || !m.geometry?.getAttribute("position")) return;
      if (holder === scoped) mesh = m;
      else {
        const own = partInstanceIdOf(m, wrapper);
        if (own && instancePathIn(holder.split("#")[0], own.id) === scoped) mesh = m;
      }
    });
    if (!mesh) return undefined;
    const toPart = toPartFrame(mesh);
    if (!toPart) return undefined;
    const f = meshFace(mesh, face, { toFrame: toPart });
    if (!f.patch.positions.length) return undefined;
    // the body's frame to the scope's assembly, as assembled (or as placed): mm, Z up
    const m = rec.base;
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    const v = new THREE.Vector3();
    const p = f.patch.positions;
    const pos = new Float64Array(p.length);
    for (let i = 0; i < p.length; i += 3) {
      v.set(p[i], p[i + 1], p[i + 2]).applyMatrix4(m);
      pos[i] = v.x;
      pos[i + 1] = v.y;
      pos[i + 2] = v.z;
    }
    let normals: Float64Array | undefined;
    if (f.patch.normals) {
      const n = f.patch.normals;
      normals = new Float64Array(n.length);
      for (let i = 0; i < n.length; i += 3) {
        v.set(n[i], n[i + 1], n[i + 2]).applyMatrix3(nm).normalize();
        normals[i] = v.x;
        normals[i + 1] = v.y;
        normals[i + 2] = v.z;
      }
    }
    return { patch: { ...f.patch, positions: pos, ...(normals ? { normals } : {}) }, quantization: f.quantization };
  };
  const placeRef = useRef<(op: PlacementVerb, by: string) => { set: SetOp; facts: PlacementFacts } | { error: string }>(() => ({ error: "the 3D view is not ready" }));
  placeRef.current = (op, by) => {
    if (op.op === "unplace") return { error: "unplace needs no faces" };
    const key = keyIntoScope(op.part);
    const rec = key !== undefined ? bodies.current.get(key) : undefined;
    if (!rec) return { error: `${op.part} is not a body drawn in this view (a placement moves a whole body; pick its face with view_pick)` };
    const src: FaceSource = { face: (p, f) => faceInScope(p, f), matrix: (p) => (p === op.part ? toMat4(rec.base) : undefined) };
    let pl;
    try {
      pl =
        op.op === "placeOnFace"
          ? placeOnFace(src, op.part, op.face, op.target, op.targetFace, { ...(op.gap !== undefined ? { gap: op.gap } : {}), ...(op.spinDeg !== undefined ? { spinDeg: op.spinDeg } : {}), ...(op.align ? { align: op.align } : {}) })
          : orientByFace(src, op.part, op.face, op.target, op.targetFace, { ...(op.flip ? { flip: true } : {}) });
    } catch (e) {
      return { error: (e as Error).message };
    }
    // stored relative to the root (W4-D): the same placement shows in every scope that draws the part
    const s = scopeToRoot();
    const r9 = (m: number[]) => m.map((x) => Math.round(x * 1e9) / 1e9);
    const matrix = s ? r9(toMat4(s.multiply(toMatrix4(pl.matrix as unknown as Parameters<typeof toMatrix4>[0])))) : pl.matrix;
    const value = { matrix, by, method: op.op, faces: { part: op.part, face: op.face, target: op.target, targetFace: op.targetFace }, ...(s ? {} : { frame: at }) };
    return { set: { op: "set", path: ["placements", op.part], value }, facts: { part: op.part, matrix, delta: pl.delta, turnedDeg: pl.turnedDeg, movedMm: pl.movedMm } };
  };
  useEffect(() => {
    hub.place = (op, by) => placeRef.current(op, by);
    return () => {
      hub.place = undefined;
    };
  }, [hub]);

  // ---- W3-D: tours live (PB-1188) ------------------------------------------------------------------------------
  const tour = useRef<{ playback: TourPlayback; by: string; title: string } | null>(null);
  const [tourChip, setTourChip] = useState<string | null>(null);
  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    const f = (dt: number) => {
      const t = tour.current;
      if (!t) return false;
      const frame = t.playback.tick(dt);
      const st = t.playback.state();
      if (frame) {
        const ops = tourOps(frame).filter((o) => o.path[0] !== "explode");
        // one log entry for the whole tour, not one per frame (gate 3: 60 entries a second evicted agents' undo history)
        if (ops.length) store.dispatch(ops, { actor: { kind: "agent", id: t.by }, label: "tour frame", gesture: "tour", source: "tour" } as never);
        if (frame.explode !== undefined && player.current) {
          player.current.set({ t: frame.explode });
          explode.current.value = explode.current.target = frame.explode;
          applyExplode(frame.explode, true);
          h.invalidate("pose");
        }
      }
      if (st.done || (!st.playing && st.driver !== "user")) {
        tour.current = null;
        setTourChip(null);
        return false;
      }
      setTourChip(st.driver === "user" ? `Tour · ${t.title} · paused (resumes when you stop)` : `Tour · ${t.title} · click to take over`);
      return true;
    };
    h.beforeRender.add(f);
    const el = h.renderer.domElement;
    const input = () => tour.current?.playback.userInput();
    el.addEventListener("pointerdown", input);
    el.addEventListener("wheel", input, { passive: true });
    window.addEventListener("keydown", input);
    return () => {
      h.beforeRender.delete(f);
      el.removeEventListener("pointerdown", input);
      el.removeEventListener("wheel", input);
      window.removeEventListener("keydown", input);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /** Start a tour (or stop with null): `__cad.tour(t)`. */
  const playTour = (raw: unknown): { ok: boolean; error?: string } => {
    if (raw === null) {
      tour.current = null;
      setTourChip(null);
      return { ok: true };
    }
    try {
      const t: Tour = parseTour(raw);
      tour.current = { playback: new TourPlayback(t, { steps: player.current?.snapshot().steps.map((x) => ({ id: x.id, window: x.window })) ?? [] }), by: t.by ?? "tour", title: t.title ?? t.id };
      handle.current?.invalidate();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };

  // ---- callouts and DRC markers (PB-1184) ------------------------------------------------------------------
  /** A scoped key with an artifact suffix kept (`video#cad_camera_step`). */
  const keyIntoScope = (ref: string): string | undefined => {
    const [p, art] = ref.split("#");
    const k = intoScope(p, at);
    return k === undefined ? undefined : art !== undefined ? `${k}#${art}` : k;
  };
  const keyOutOfScope = (key: string): string => {
    const [p, art] = key.split("#");
    return art !== undefined ? `${outOfScope(p, at)}#${art}` : outOfScope(p, at);
  };
  /** What a scoped key names on screen: a body, a harness, a component inside a body, or a module drawn by its parts. */
  const resolvePart = (key: string): PartHit | null => {
    const rec = bodies.current.get(key);
    if (rec) {
      rec.obj.updateWorldMatrix(true, false);
      const box = rec.box.isEmpty() ? boundsOf([rec.obj]) : rec.box.clone().applyMatrix4(rec.obj.matrixWorld);
      return { objects: [rec.obj], box, frame: rec.obj.matrixWorld.clone(), body: key, ...(drawnObj(rec.obj) ? {} : { hidden: true }) };
    }
    const wire = harnessObjs.current.get(key);
    if (wire) return { objects: [wire], box: boundsOf([wire]), frame: wire.matrixWorld.clone(), body: key, ...(drawnObj(wire) ? {} : { hidden: true }) };
    const m = model;
    if (!m) return null;
    const holder = m.within.get(key);
    const holderRec = holder !== undefined ? bodies.current.get(holder) : undefined;
    if (holder !== undefined && holderRec) {
      const rel = holder && key.startsWith(`${holder}/`) ? key.slice(holder.length + 1) : key;
      const c = componentIn(holderRec.obj, rel, key);
      holderRec.obj.updateWorldMatrix(true, false);
      return c ? { ...c, frame: holderRec.obj.matrixWorld.clone(), body: holder, ...(drawnObj(holderRec.obj) ? {} : { hidden: true }) } : null;
    }
    // a module drawn by its parts (an FC + ESC stack): every body under it
    // (and a part drawn as named artifact bodies only: "battery#cad_glb")
    const under = [...bodies.current.entries()].filter(([k]) => key === "" || k.split("#")[0] === key || k.split("#")[0].startsWith(`${key}/`));
    if (under.length) {
      const objs = under.map(([, r]) => r.obj).filter(drawnObj);
      if (!objs.length) return { objects: [], box: new THREE.Box3(), frame: new THREE.Matrix4(), body: under[0][0], hidden: true };
      const handleRoot = handle.current?.root;
      return { objects: objs, box: boundsOf(objs), frame: handleRoot ? handleRoot.matrixWorld.clone() : new THREE.Matrix4(), body: under[0][0] };
    }
    return null;
  };
  const drawnMeshes = useRef<{ mesh: THREE.Mesh; sphere: THREE.Sphere }[]>([]);
  const annotHost = useRef<AnnotHost>(null as unknown as AnnotHost);
  annotHost.current = {
    resolve: (ref) => {
      if (ref.startsWith("link:")) {
        const a = model ? anchorOf(model, ref) : undefined;
        return a ? resolvePart(a.body) : null;
      }
      const key = keyIntoScope(ref);
      return key === undefined ? null : resolvePart(key);
    },
    pickOn: (ray, roots) => pick(ray, roots, { clippingPlanes: handle.current?.renderer.clippingPlanes ?? [] })?.point,
    // the drawn meshes and their world bounding spheres, gathered once per frame that tests: each ray then runs the
    // BVH test only on meshes whose bounds it passes nearer than the anchor
    prepare: () => {
      const h = handle.current;
      const list: { mesh: THREE.Mesh; sphere: THREE.Sphere }[] = [];
      if (h) {
        const walk = (o: THREE.Object3D) => {
          if (!o.visible) return;
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh && (o.userData.bodyKey !== undefined || o.userData.harness !== undefined) && mesh.geometry?.getAttribute("position")) {
            const inst = mesh as THREE.InstancedMesh;
            if (inst.isInstancedMesh) {
              if (!inst.boundingSphere) inst.computeBoundingSphere();
            } else if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
            const local = inst.isInstancedMesh ? inst.boundingSphere! : mesh.geometry.boundingSphere!;
            list.push({ mesh, sphere: local.clone().applyMatrix4(mesh.matrixWorld) });
          }
          for (const c of o.children) walk(c);
        };
        walk(h.root);
        walk(harnessGroup.current);
      }
      drawnMeshes.current = list;
    },
    firstHit: (ray, maxDistance = Infinity, exclude) => {
      const h = handle.current;
      if (!h) return undefined;
      const near = drawnMeshes.current.filter(({ mesh, sphere }) => !exclude?.has(mesh) && ray.intersectsSphere(sphere) && ray.origin.distanceTo(sphere.center) - sphere.radius < maxDistance).map((x) => x.mesh);
      if (!near.length) return undefined;
      const hit = pick(ray, near, { clippingPlanes: h.renderer.clippingPlanes });
      return hit && hit.distance < maxDistance ? { object: hit.object, distance: hit.distance, point: hit.point } : undefined;
    },
    onFinding: (id, action) => {
      if (action === "hover") return;
      setOpenFindings((prev) => {
        const n = new Set(prev);
        if (action === "open") n.add(id);
        else n.delete(id);
        return n;
      });
      if (action === "open") {
        // a click on a marker opens the finding in the Findings control
        setCurrentFinding(id);
        setFindingsMenu(true);
      }
    },
    onLookAt: (ref) => lookAtRef(ref),
    onInspect: (_id, ref) => {
      if (ref) inspectRef(ref);
    },
    onDismiss: (id) => write([{ op: "set", path: ["annotations", id], value: undefined }], "remove a callout"),
  };
  /** Select what a scoped key names and frame it (a finding's "look at", a double-click on a label). */
  const lookAtRef = (ref: string) => {
    const m = model;
    const key = keyIntoScope(ref.startsWith("link:") ? ref : ref.split(":")[0]);
    if (!m || key === undefined) return;
    const next: CadSelection | undefined = focusSelection(key, m.bodies.map((b) => b.key), m.within);
    if (!next) return;
    if (same(next, sel)) {
      // already selected: frame it now (no selection change to wait for)
      focus();
      handle.current?.renderOnce();
      return;
    }
    look.current = true;
    setSel(next);
  };
  /**
   * Show what a ref names in the Inspector (R1-C handoff, D3): selected here without moving the camera (the host's
   * Inspector follows the selection, M2), and the host's own `uhd-viewer:inspect` when it gave `onInspect`.
   */
  const inspectRef = (ref: string) => {
    const m = model;
    const path = ref.startsWith("link:") ? undefined : ref.split(":")[0].split("#")[0];
    const key = path !== undefined ? keyIntoScope(path) : undefined;
    if (m && key !== undefined) {
      const next = focusSelection(key, m.bodies.map((b) => b.key), m.within);
      if (next && !same(next, sel)) setSel(next);
    }
    if (path !== undefined) inspectHandler.current?.(path, path ? defAt(system, lookup, path.split("/"))?.id : system.id);
  };
  // a host's openFinding (gate R1): pinned once per message for the page's lifetime (the view remounts on a rebuild
  // or a tab switch and must not reopen a card the person closed, as for a focus, A2), as soon as the finding is
  // known (a load may still be running)
  useEffect(() => {
    if (!findingOn || findingsPinned.has(findingOn) || !model) return;
    const f = findingForHost(annotFindings, findingOn, keyOutOfScope);
    if (!f) return;
    findingsPinned.add(findingOn);
    if (!showFindings) setVis("findings", true);
    if (!shownSev.has(f.severity)) setShownSev((prev) => new Set(prev).add(f.severity));
    setCurrentFinding(f.id);
    if (f.anchors.length) setOpenFindings((prev) => new Set(prev).add(f.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findingOn, model, annotFindings]);
  const chooseFinding = (f: FindingAnchors) => {
    setCurrentFinding(f.id);
    if (!f.anchors.length) return;
    setOpenFindings((prev) => new Set(prev).add(f.id));
    if (f.refs[0] !== undefined) lookAtRef(keyOutOfScope(f.refs[0]));
  };
  const isolateFinding = (f: FindingAnchors | null) => {
    const paths = f ? isolationOf(f) : null;
    write([{ op: "isolate", paths }], f ? `isolate the parts ${f.code} names` : "show everything");
    setIsolatedFinding(f && paths ? f.id : undefined);
  };
  // the records in the view state, scoped; the markers of the findings shown; who is where
  /** Hand the layer what it draws (also called by `__cad.set` so a capture's records are drawn in the same frame). */
  const syncAnnot = useRef<() => void>(() => {});
  syncAnnot.current = () => {
    const layer = annotRef.current;
    if (!layer) return;
    const list = store.get().annotations;
    const { records } = recordsOf(Array.isArray(list) ? list : []);
    const markers = showFindings && model ? drcMarkers(annotFindings, shownSev) : [];
    const who = [...(presence ?? []), ...presenceSet, ...storeChips].filter((p) => p && typeof p.who === "string" && typeof p.ref === "string").slice(0, 16);
    const reduced = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // gate R1: markers find their part's surface (BVH builds) once the view has settled, not during the load; a
    // document-mode page (a capture) at once, so its frame has them
    layer.setInput({ records, markers, open: openFindings, presence: who, ghosts, motion: !noChrome && !present && !reduced, anchorParts: settled || noChrome });
    layer.margins = { top: noChrome || present ? 12 : 56, bottom: noChrome || present ? 12 : 60, left: noChrome || present ? 12 : 52, right: present || noChrome || !inspector || hub.opening.panel === "none" ? 16 : 380 };
    annotActive.current = records.length > 0 || markers.length > 0 || who.length > 0;
    handle.current?.invalidate("view");
  };
  useEffect(() => {
    syncAnnot.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotations, annotFindings, showFindings, shownSev, openFindings, presence, presenceSet, storeChips, ghosts, model, at, loaded, settled, inspector, present, noChrome]);
  /** The inspector's "Callout": a ring and a label sheet (refdes, MPN, LCSC) on the selected part, written by the person. */
  const calloutKey = sel.component ?? sel.body;
  const calloutTarget = (() => {
    if (calloutKey === undefined || !model) return undefined;
    const ref = keyOutOfScope(calloutKey);
    const path = ref.split("#")[0];
    const inst = instanceAt(system, lookup, path);
    // the person's own callout and ring on this part (ids are per press: the store never reuses a removed id)
    const mine = (Array.isArray(annotations) ? annotations : []).filter((x): x is { id: string } => {
      const r = x as { id?: unknown; author?: unknown; ref?: unknown; kind?: unknown; shape?: unknown };
      return typeof r.id === "string" && r.author === "user" && r.ref === ref && (r.kind === "callout" || (r.kind === "mark" && r.shape === "ring"));
    });
    return {
      on: mine.length > 0,
      what: inst?.child?.name ?? inst?.def.name ?? ref,
      toggle: () => {
        if (mine.length) return write(mine.map((r) => ({ op: "set", path: ["annotations", r.id], value: undefined })), "remove a callout");
        const facts = partFacts(path, inst?.def, inst?.child);
        const made = partCallout(ref, facts);
        // ids are at most 128 characters (schema): a long instance path is hashed into the id (W4-D, wave 3
        // carry-forward: `user:callout:<path>:<stamp>` broke the cap on paths over about 105 characters)
        const callout = { ...made.callout, id: shortRecordId(made.callout.id) };
        const ring = { ...made.ring, id: shortRecordId(made.ring.id) };
        write(
          [ring, callout].map((r) => ({ op: "set", path: ["annotations", r.id], value: r })),
          `callout ${facts.refdes ?? facts.name ?? ref}`,
        );
      },
    };
  })();

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const turns = store as { takeOver?: () => unknown; undo?: (a: Actor, meta?: { source?: string }) => unknown };
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "Escape" && !e.defaultPrevented) turns.takeOver?.();
      else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
        turns.undo?.(HUMAN, { source: "view" });
        e.preventDefault();
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [store]);

  const toggleKind = (k: LabelKind) => {
    const n = new Set(labelKinds);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    setVis("labelKinds", [...n]);
  };

  // R1-D handoff (G4): what the model has, so the frame toggle and the D1/D2/D3 radios say "none in this model"
  const toolbarAvail = useMemo(() => (model ? toolbarAvailability(model) : undefined), [model]);

  // after the last hook (W4-B's mount): a G-code file is shown by its own viewer, with its own toolbar
  if (gcode) return <GcodeView url={gcode.url} name={gcode.name} />;
  if (gcodeRaw) return <div role="alert" style={{ padding: 16 }}>G-code not opened: only a file of this page's own origin is read (?gcode=/path/to/file.gcode).</div>;

  return (
    <div className={`cad-view${present ? " present" : ""}`}>
      <div className="cad-canvas" ref={host}>
        {!present && !noChrome && (
          <CadToolbar
            exploded={exploded}
            onExploded={toggleExploded}
            labels={showLabels}
            onLabels={(on) => setVis("labels", on)}
            labelKinds={labelKinds}
            onLabelKind={toggleKind}
            labelMenu={labelMenu}
            onLabelMenu={setLabelMenu}
            hardwareCount={model?.assembly.hardware.length ?? 0}
            hardware={showHardware}
            onHardware={(on) => setVis("hardware", on)}
            harnessCount={model?.assembly.harnesses.length ?? 0}
            wires={showWires}
            onWires={(on) => setVis("wires", on)}
            frames={showFrames}
            onFrames={(on) => setVis("frames", on)}
            section={section}
            onSection={setSection}
            sections={sections as ScopedSectionPlane[]}
            onSections={(s) => write([{ op: "section", sections: s }])}
            takeOver={{ agents: agentsHere, onTakeOver: () => store.takeOver() }}
            saveCallouts={{ count: Array.isArray(annotations) ? annotations.length : 0, onSave: () => hub.saveCallouts?.() }}
            scopeCandidate={sel.body ? { path: sel.body.split("#")[0], label: sel.body.split("#")[0].split("/").pop() ?? sel.body } : null}
            sectionMenu={sectionMenu}
            onSectionMenu={setSectionMenu}
            autoFlip={(axis) => {
              const h = handle.current;
              return h ? h.camera.position.getComponent(axis) < h.controls.target.getComponent(axis) : false;
            }}
            shells={shells}
            xray={xray}
            onXray={(on) => setVis("xray", on)}
            findings={annotFindings.length}
            showFindings={showFindings}
            onFindings={(on) => setVis("findings", on)}
            findingsControl={
              annotFindings.length ? (
                <FindingsControl
                  findings={annotFindings}
                  markers={showFindings}
                  onMarkers={(on) => setVis("findings", on)}
                  shown={shownSev}
                  onShown={(sv, on) =>
                    setShownSev((prev) => {
                      const n = new Set(prev);
                      if (on) n.add(sv);
                      else n.delete(sv);
                      return n;
                    })
                  }
                  ghosts={ghosts}
                  onGhosts={setGhosts}
                  open={openFindings}
                  {...(currentFinding ? { current: currentFinding } : {})}
                  onChoose={chooseFinding}
                  onIsolate={isolateFinding}
                  {...(isolatedFinding ? { isolated: isolatedFinding } : {})}
                  onOpenAll={(on) => setOpenFindings(on ? new Set(annotFindings.filter((f) => f.anchors.length > 0 && shownSev.has(f.severity)).slice(0, MAX_OPEN_FINDINGS).map((f) => f.id)) : new Set())}
                  menu={findingsMenu}
                  onMenu={setFindingsMenu}
                />
              ) : undefined
            }
            direction={direction}
            onDirection={setDirection}
            onFit={fitAsSeen}
            onFocus={lookAlongNormal}
            availability={toolbarAvail}
            canFocus={Boolean(sel.body)}
          />
        )}
        {!model && <div className="cad-loading">Loading manifests…</div>}
        {model && summary && !present && (nothing || (settled && !bodies.current.size) || (settled && loaded === 0)) ? (
          <div className="cad-empty" role="status">
            <Icon name="box" size={26} strokeWidth={1.25} />
            <div className="cad-empty-title">No 3D model for {shown.name} yet.</div>
            {emptyHint && (
              <details className="cad-empty-how">
                <summary>How is one made?</summary>
                <p>{emptyHint}</p>
              </details>
            )}
          </div>
        ) : (
          model && summary && !present && !noChrome && (
            <div className="cad-scope" data-chrome="scope" data-tooltip={summary.unplaced.length ? `Not placed (nothing says where they sit): ${summary.unplaced.slice(0, 12).map((u) => u.name).join(", ")}${summary.unplaced.length > 12 ? ` and ${summary.unplaced.length - 12} more` : ""}` : undefined} data-tooltip-side="bottom">
              <span className="cad-scope-name">{shown.name}</span>
              <span className="cad-scope-what">
                {summary.inRow.length
                  ? summary.inRow.length === summary.parts
                    ? `${summary.parts === 1 ? "its part" : `its ${summary.parts} parts`}, unplaced: side by side`
                    : `${summary.placed.length - summary.inRow.length} of ${summary.parts} parts placed, ${summary.inRow.length} unplaced beside them`
                  : model.placedBy?.kind === "ancestor"
                    ? `its ${summary.parts} parts, placed as in ${placedByName(model.placedBy.from)}`
                    : summary.ownBody
                  ? summary.parts
                    ? `with its ${summary.parts} parts`
                    : "on its own"
                  : summary.parts === 0
                    ? "on its own"
                    : summary.unplaced.length
                      ? `${summary.placed.length} of ${summary.parts} parts placed${summary.placed.length === 1 ? `: ${summary.placed[0].name}` : ""}`
                      : at
                        ? `its ${summary.parts} parts, assembled`
                        : "the whole assembly"}
              </span>
              {explodeNote && exploded && (
                // R1-A (M11): "Exploded" on a model whose parts have nowhere to go
                <span className="cad-scope-what cad-scope-explode" data-explode="none">
                  {explodeNote}
                </span>
              )}
              {placeholders?.line && (
                // W1-B's rule (handoffs.md): stand-in models drawn, and parts the build says have none of their own
                <span className="cad-scope-what cad-scope-placeholders" data-placeholders={placeholders.count} title={`Placeholders (no model of their own yet): ${placeholders.paths.slice(0, 12).join(", ")}${placeholders.paths.length > 12 ? ` and ${placeholders.paths.length - 12} more` : ""}`}>
                  {placeholders.line}
                </span>
              )}
            </div>
          )
        )}
        {present && (
          <div className="cad-caption">
            <div className="cad-caption-brand">
              <span>UHD</span> VIEWER · 5-INCH 6S QUADCOPTER
            </div>
            {caption && (
              <>
                <div className="cad-caption-title">{caption[0]}</div>
                {caption[1] && <div className="cad-caption-sub">{caption[1]}</div>}
              </>
            )}
          </div>
        )}
        {tourChip && !noChrome && (
          <button type="button" className="cad-tour-chip" data-chrome="tour" onClick={() => tour.current?.playback.userInput()} style={{ position: "absolute", left: "50%", top: 64, transform: "translateX(-50%)", zIndex: 22, padding: "3px 10px", borderRadius: 10, border: "1px dashed var(--uhd-accent, #5aa9ff)", background: "var(--uhd-surface, #1c1c1c)", color: "var(--uhd-text, #e5e5e5)", font: "11px var(--uhd-font-label, ui-monospace, monospace)", cursor: "pointer" }}>
            {tourChip}
          </button>
        )}
        {!present && !noChrome && notes.length > 0 && (
          <div className="cad-notes" data-chrome="notes">
            {notes.map((n, i) => (
              <div key={i}>{n}</div>
            ))}
          </div>
        )}
        {shot && (
          // over the canvas, under the toolbar: scaled to the view's HEIGHT and centred (the vertical fov is what
          // the snapshot and the live view share), so the live frame lines up under it for the same camera
          <div className={`cad-snapshot${shot.fading ? " fading" : ""}`} aria-hidden={shot.fading || undefined} style={{ position: "absolute", inset: 0, zIndex: 4, overflow: "hidden", pointerEvents: "none", background: "var(--uhd-scene-background, transparent)", opacity: shot.fading ? 0 : 1, transition: "opacity 150ms linear" }}>
            <img src={shot.msg.imageUrl} alt="" style={{ position: "absolute", top: 0, left: "50%", height: "100%", width: "auto", transform: "translateX(-50%)", maxWidth: "none" }} />
            <div className="cad-snapshot-note" role="status" data-chrome="snapshot-note" style={{ position: "absolute", left: "50%", top: 16, transform: "translateX(-50%)", padding: "4px 10px", borderRadius: 6, font: "12px var(--uhd-font-ui, system-ui)", color: "var(--uhd-text-muted, #888)", background: "var(--uhd-surface, rgba(0,0,0,0.5))" }}>
              {shot.msg.bundleHash && shot.msg.currentBundleHash && shot.msg.bundleHash !== shot.msg.currentBundleHash ? "Updating model" : "Loading model"}
            </div>
          </div>
        )}
        {loadSnap && !shot && (
          <LoadingScreen
            state={loadSnap}
            // the lighter tiers (W3-C's useLoadTiers): a choice reloads at that tier and is also told to the host
            onChoose={(tier) => {
              tiers.choose(tier);
              onLoadTier?.(tier);
            }}
          />
        )}
      </div>
      {model && !present && !noChrome && inspector && hub.opening.panel !== "none" && <CadInspector model={model} sel={sel} onSel={setSel} direction={direction} findings={findings} resolve={resolve} {...(calloutTarget ? { callout: calloutTarget } : {})} />}
    </div>
  );
}

