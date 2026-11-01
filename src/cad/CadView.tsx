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
import { findingAnchors, type FindingAnchor } from "./findings";
import { DIRECTIONS, defAt, explodeParts, glbFor, interfaceRows, loadManifests, type CadBody, type CadModel, type Direction, type InterfaceRow } from "./model";
import { useTheme, tokenColor } from "../theme/ThemeProvider";
import { DEFAULT_SCENE_ACCENT, DEFAULT_SCENE_HIGHLIGHT, cadWrapper, createScene, focusMaterial, frameGizmo, glbCache, loadGlb, loadModel, materialFor, proceduralGeometry, toMatrix4, type AntialiasMode, type LoadedModel, type SceneHandle } from "./scene";
import { buildAll, bvhStats, pick } from "./render/pick";
import { setMeshLook } from "./render/looks";
import { instancePathIn, isPlaceholder } from "./render/ids";
import { observeScene, type CadObservation, type LoadState } from "./render/observe";
import { attachSceneTelemetry } from "../telemetry";
import { LabelLayer, type LabelItem, type LabelKind } from "./labels";
import { LoadingScreen, attachLoadTracker, type LoadSnapshot, type LoadTier } from "./loading";
import { SequencePlayer, applyCadPose, applyUrlState, fetchSequenceBeside, resolveForCad, sequenceUrlState, type PlayerSnapshot, type SequenceCommand, type SequenceFile } from "./sequence";
import { Icon } from "../canvas/Icon";
import { layOutRow } from "./row";
import { intoScope, outOfScope, scopeRef, scopedModel, scopedPlacements, shownSummary } from "./scope";
import { CadInspector } from "./CadInspector";
import { CadToolbar } from "./CadToolbar";
import { cableSummary, harnessMaterial, routeManifest } from "./harness";
import type { ViewerSnapshotMessage } from "../api";
import { HUMAN, SYSTEM, presentation, presentationFromDisplay, same, serializeViewState, useViewSlice, viewHub, type Actor, type Batch, type CameraState, type SectionPlane, type ViewHub, type ViewSelection, type ViewState } from "./state";
import { matchesPath, placeholderSummary, shownBy, viewUp, type PlaceholderSummary } from "./state/view";

/** Render knobs from the page URL (read when the view mounts, so importing the library touches no window). */
const urlParams = () => new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);

/** Explode distance (mm per mate level) at "exploded". */
const EXPLODE_MM = 26;
/** A camera drag reports its camera to the view state at most this often (ms); the host saves after 400 ms of quiet. */
const CAMERA_REPORT_MS = 200;

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
  onSelect,
  inspector = true,
  scope,
  emptyHint,
  onLoadState,
  onOpenModule,
  hub: givenHub,
  sequence,
  onLoadTier,
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
  const explode = useRef({ value: explodeT, target: explodeT });
  const [manifests, setManifests] = useState<Map<string, GeometryManifest> | null>(null);
  const [loaded, setLoaded] = useState(0);
  /** Every model load has finished (or failed). */
  const [settled, setSettled] = useState(false);
  /** The camera's move while the model comes apart or together: from where it was to a fit of where it ends. */
  const cameraTween = useRef<{ from: [THREE.Vector3, THREE.Vector3]; to: [THREE.Vector3, THREE.Vector3]; start: number } | null>(null);
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
  const showFindings = findingsChoice ?? findings.some((f) => f.host);

  // ---- scene lifecycle -----------------------------------------------------
  useEffect(() => {
    if (!host.current) return;
    // knobs for measuring (PB-1175): ?aa=msaa|native|none, ?samples=<n>, ?batch=0
    const aa = params.get("aa");
    const h = createScene(host.current, {
      ...(aa === "msaa" || aa === "native" || aa === "none" ? { antialias: aa as AntialiasMode } : {}),
      ...(params.get("samples") ? { samples: Number(params.get("samples")) } : {}),
      ...(params.get("batch") === "0" ? { batching: false } : {}),
    });
    handle.current = h;
    // local crash and performance records (PB-1181, W1-E): frames, loads, context loss of this scene
    const stopTelemetry = attachSceneTelemetry(h);
    h.scene.add(harnessGroup.current);
    labelsRef.current = new LabelLayer(host.current);
    return () => {
      labelsRef.current?.dispose();
      stopTelemetry();
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
    if (!h || !model) return;
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
      tracker.current?.loadState({ ...state });
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
        loadModel(url)
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
  }, [model, nothing, reload]);

  // ---- explode and the assembly sequence (PB-1183, W2-C's player in ./sequence) -----------------------
  // the view state's explode amount is where the parts ease to (a toggle, a host, an agent)
  useEffect(() => {
    explode.current.target = explodeT;
    handle.current?.invalidate("pose");
  }, [explodeT]);

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
  /** Resolve the sequence for what is loaded now (the stack planner samples it: 125 ms drone, 369 ms ClientX). */
  const resolveSequence = () => {
    const h = handle.current;
    if (!h || !model) return;
    const resolved = resolveForCad({ model, bodies: bodies.current, hardware: hardware.current, file: seqFile, up: upRef.current, gap: explodeScale(), root: h.root, levels: seqUrl.levels });
    if (player.current) player.current.replace(resolved);
    else {
      player.current = new SequencePlayer(resolved);
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
    const r = p.run(cmd);
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
      // still moving: the next frame is drawn too; otherwise the view goes idle
      return moving || seqMoving || ex.value !== ex.target || easing;
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
    const findingItems: LabelItem[] = findings.map((f: FindingAnchor) => ({
      id: `f:${f.id}`,
      kind: "finding",
      tone: f.severity,
      title: f.title,
      sub: f.message,
      anchor: () => {
        const rec = bodies.current.get(f.body);
        if (!rec || (!rec.obj.children.length && !f.local)) return null;
        return (f.local ? new THREE.Vector3(...f.local) : rec.centre.clone()).applyMatrix4(rec.obj.matrix);
      },
      onClick: () => setSel(f.select),
    }));
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
        const sub = h?.sub ?? (b.def.name !== title ? b.def.name : undefined) ?? (b.hint ? "placed by a display hint" : undefined);
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
    // findings show with the labels or on their own
    layer.setItems([...(showLabels ? items : []), ...(showFindings ? findingItems : [])]);
    layer.target = showLabels || (showFindings && findingItems.length) ? 1 : 0;
    // the inspector card covers the right of the view only while it is open
    layer.margins = { top: 60, bottom: 64, left: 56, right: present || !inspector ? 16 : 380 };
  }, [model, labelKinds, showLabels, loaded, showHardware, showWires, present, findings, showFindings, inspector]);

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
    const box = currentBounds();
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
    const cut = !!section && !box.isEmpty();
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
    if (!section || box.isEmpty()) {
      h.renderer.clippingPlanes = [];
      if (grid) grid.visible = !present;
      return;
    }
    const { at, flip } = sectionPlane(box)!;
    const n = new THREE.Vector3();
    n.setComponent(section.axis, flip ? 1 : -1);
    // three.js keeps what lies on the normal's side: n·p + c ≥ 0
    h.renderer.clippingPlanes = [new THREE.Plane(n, flip ? -at : at)];
    if (grid) grid.visible = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, loaded, model]);
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

  // ---- selection overlays: interface geometry per direction, frames ----------
  useEffect(() => {
    const h = handle.current;
    if (!h || !model) return;
    const restore: (() => void)[] = [];
    const newNotes: string[] = [];
    const objOf = (key: string) => bodies.current.get(key)?.obj;

    for (const [key, rec] of bodies.current) {
      // an assembly with no body of its own is selected as its parts
      const lit = sel.body !== undefined && (key === sel.body || (sel.body !== "" && key.startsWith(`${sel.body}/`)));
      // what the view state highlights besides the selection (an agent pointing at a part): the stronger glow
      const marked = highlight.some((p) => matchesPath(key, p));
      rec.obj.traverse((o) => {
        // a highlight is a shared variant of the mesh's material: under the batcher, an instance attribute
        if ((o as THREE.Mesh).isMesh && o.userData.bodyKey !== undefined) setMeshLook(o as THREE.Mesh, { emissive: lit ? h.colors.glow : marked ? h.colors.glowStrong : undefined });
      });
    }
    for (const [key, obj] of harnessObjs.current) {
      if (key === sel.harness || !highlight.some((p) => matchesPath(key, p))) continue;
      obj.traverse((o) => {
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
    const selBody = bodyFor(sel.body);
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
    if (selBody && sel.component) {
      // a component inside the body (a board's part): its node, named by its id in the body, glows
      const holder = selBody.key.split("#")[0];
      const node = holder && sel.component.startsWith(`${holder}/`) ? sel.component.slice(holder.length + 1) : sel.component;
      const partId = (o: THREE.Object3D) => (o.userData.protoboard as { partInstanceId?: unknown } | undefined)?.partInstanceId;
      objOf(selBody.key)?.traverse((o) => {
        // by the node's name (its id in the body), or by the instance path its extras carry (PB-1175 ids)
        const id = partId(o);
        if (o.name !== node && !(typeof id === "string" && (id === node || id === sel.component))) return;
        o.traverse((x) => {
          const mesh = x as THREE.Mesh;
          if (!mesh.isMesh) return;
          const was = mesh.material;
          mesh.material = focusMaterial(h.colors.focus);
          restore.push(() => (mesh.material = was));
        });
      });
    }
    if (sel.harness) {
      const obj = harnessObjs.current.get(sel.harness);
      obj?.traverse((o) => {
        if (!(o as THREE.Mesh).isMesh) return;
        setMeshLook(o as THREE.Mesh, { emissive: h.colors.glowStrong });
        restore.push(() => setMeshLook(o as THREE.Mesh, { emissive: undefined }));
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
      restore.forEach((f) => f());
      handle.current?.invalidate();
    };
  }, [model, sel, direction, showFrames, loaded, themed, highlight]);

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
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY });
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
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
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("dblclick", onDouble);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("dblclick", onDouble);
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
    fit(currentBounds(), (Math.atan2(local.y, local.x) * 180) / Math.PI, (Math.asin(Math.max(-1, Math.min(1, local.z))) * 180) / Math.PI);
  };
  /** Explode or assemble, the camera moving with the parts to frame where they end. */
  const toggleExploded = (on: boolean) => {
    const h = handle.current;
    const ex = explode.current;
    if (h && model && ex.target !== (on ? 1 : 0)) {
      const from: [THREE.Vector3, THREE.Vector3] = [h.camera.position.clone(), h.controls.target.clone()];
      const now = ex.value < 0.5 ? 4 * ex.value ** 3 : 1 - (-2 * ex.value + 2) ** 3 / 2;
      // where it ends: lay the parts out there for a moment, fit, and put everything back (not reported: the
      // camera is reported when the tween ends)
      applyExplode(on ? 1 : 0);
      h.root.updateMatrixWorld(true);
      muteCamera.current = true;
      fitAsSeen();
      muteCamera.current = false;
      const to: [THREE.Vector3, THREE.Vector3] = [h.camera.position.clone(), h.controls.target.clone()];
      applyExplode(now);
      h.camera.position.copy(from[0]);
      h.controls.target.copy(from[1]);
      h.camera.lookAt(from[1]);
      cameraTween.current = { from, to, start: ex.value };
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
      set: (s: { azimuth?: number; elevation?: number; distance?: number; target?: [number, number, number]; explode?: number | { t: number; step?: number | null }; labels?: boolean; snap?: boolean; caption?: [string, string] } & Partial<Record<string, unknown>>) => {
        const capture = ["azimuth", "elevation", "distance", "labels", "snap", "caption"].some((k) => k in s) || typeof s.explode === "number";
        // the assembly sequence (W2-C): a command, or a step and an explode amount
        if (s.sequence !== undefined || s.step !== undefined || s.t !== undefined) {
          const seq = s.sequence as SequenceCommand | true | undefined;
          const r = typeof seq === "object" ? runSequence(seq) : player.current ? runSequence({ action: "set", t: typeof s.t === "number" ? s.t : player.current.t }) : { ok: false, error: "no sequence yet" };
          if (typeof s.step === "string" && player.current) {
            player.current.set({ step: s.step, ...(typeof s.t === "number" ? { t: s.t } : {}) });
            explode.current.value = explode.current.target = player.current.t;
            applyExplode(player.current.t, true);
          }
          if (!r.ok) throw new Error(r.error ?? "sequence command refused");
          h.renderOnce();
        }
        if (capture) h.manual.on = true;
        const stateKeys = ["camera", "selection", "highlight", "isolation", "visibility", "direction", "sections", "namedViews"].filter((k) => k in s);
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
    };
    (window as unknown as Record<string, unknown>).__cad = cadApi;
    // the host handle and the live-tab bridge read the same observation (./state/hub.ts)
    hub.observer = (opts) => observe(opts);
    hub.view = "3d";
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
      cameraTween.current = null;
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
  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    h.setUp(upVec);
    const have = store.get().camera;
    if (have) return applyCamera(have);
    if (urlOpen.camera) {
      applyCamera({ ...urlOpen.camera, up: urlOpen.camera.up ?? (upVec.toArray() as [number, number, number]) });
      return reportCamera(SYSTEM);
    }
    if (urlOpen.view && store.get().namedViews[urlOpen.view]) {
      store.dispatch([{ op: "applyView", name: urlOpen.view }], { actor: SYSTEM, label: `open the named view ${urlOpen.view}`.slice(0, 120), source: "url" });
      return;
    }
    if (!urlOpen.focus) orbit(opening.az, opening.el, opening.dist ?? 520, opening.target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upVec]);
  useEffect(() => {
    const h = handle.current;
    if (!h || !model || !settled) return;
    const box = assembledBounds();
    h.setGround(box);
    if (framed.current || urlOpen.focus || h.manual.on) return;
    framed.current = true;
    if (opening.dist !== undefined) return;
    // what is drawn: a section view opens on the half it keeps, centred
    fit(visibleBounds(), opening.az, opening.el);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, model]);
  useEffect(() => {
    if (urlOpen.focus && loaded >= (model?.bodies.filter((b) => b.glb).length ?? 1)) focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, model]);

  // ---- the host's snapshot first (PB-1180, W2-D's handoff): painted at once, the camera set exactly, then live -------
  const [shot, setShot] = useState<{ msg: ViewerSnapshotMessage; fading: boolean; local?: boolean } | null>(() => (hub.snapshot && snapshotFor(hub.snapshot, at) ? { msg: hub.snapshot, fading: false } : null));
  useEffect(() => {
    hub.onSnapshot = (m) => {
      if (snapshotFor(m, at) && !settledRef.current) setShot({ msg: m, fading: false });
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
  // the first frame after every model is in: the snapshot fades out (150 ms) over the live view
  useEffect(() => {
    const h = handle.current;
    if (!h || !settled || !shot || shot.fading) return;
    const off = h.onFrame(() => {
      off();
      setShot((s) => (s ? { ...s, fading: true } : s));
      setTimeout(() => {
        setShot(null);
        hub.snapshot = undefined;
      }, 160);
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
          setTimeout(() => setShot((cur) => (cur?.local ? null : cur)), 160);
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
    h.setAttention("agent", [...bodies.current.keys(), ...harnessObjs.current.keys()].filter((k) => highlight.some((p) => matchesPath(k, p))));
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
  const focused = useRef(0);
  const look = useRef(false);
  useEffect(() => {
    if (!focusOn || !model || focused.current === focusOn.seq) return;
    focused.current = focusOn.seq;
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
    const has = (k: string) => model.bodies.some((b) => b.key === k);
    const holder = model.within.get(key);
    const parts = key.split("/");
    const above = parts.map((_, i) => parts.slice(0, parts.length - 1 - i).join("/")).find((k) => k && has(k));
    // an assembly drawn by its parts (an FC + ESC stack): selected as the group of them (QA B4)
    const parts_ = key !== "" && model.bodies.some((b) => b.key.startsWith(`${key}/`));
    const next: CadSelection | undefined = has(key) ? { body: key } : holder !== undefined ? { body: holder, component: key } : parts_ ? { body: key } : above ? { body: above } : undefined;
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
    selectHandler.current?.({ ...sel, ...(sel.body !== undefined ? { body: out(sel.body) } : {}), ...(sel.component !== undefined ? { component: out(sel.component) } : {}), ...(sel.harness !== undefined ? { harness: out(sel.harness) } : {}), ...(sel.mate !== undefined ? { mate: out(sel.mate) } : {}) });
  }, [sel, at]);

  // render on demand (PB-1175): whatever React state changed (selection, visibility, explode, sections, labels,
  // a load) asks for one frame after the effects above have changed the scene. Nothing changes: no frame.
  useEffect(() => {
    handle.current?.invalidate();
  });

  const toggleKind = (k: LabelKind) => {
    const n = new Set(labelKinds);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    setVis("labelKinds", [...n]);
  };

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
            sectionMenu={sectionMenu}
            onSectionMenu={setSectionMenu}
            autoFlip={(axis) => {
              const h = handle.current;
              return h ? h.camera.position.getComponent(axis) < h.controls.target.getComponent(axis) : false;
            }}
            shells={shells}
            xray={xray}
            onXray={(on) => setVis("xray", on)}
            findings={findings.length}
            showFindings={showFindings}
            onFindings={(on) => setVis("findings", on)}
            direction={direction}
            onDirection={setDirection}
            onFit={fitAsSeen}
            onFocus={focus}
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
              {shot.msg.bundleHash && shot.msg.currentBundleHash && shot.msg.bundleHash !== shot.msg.currentBundleHash ? "Updating to the latest build" : "Getting your model ready"}
            </div>
          </div>
        )}
        {loadSnap && !shot && (
          <LoadingScreen
            state={loadSnap}
            // the lighter tiers are offered only when the host acts on the choice: CadView does not load the coarse
            // tier or boxes itself yet (W2-B's loadModel tier option and loadBoxes are not wired; wave 2 gate, W3 item)
            onChoose={
              onLoadTier
                ? (tier) => {
                    tracker.current?.tracker.push({ type: "choose", tier });
                    onLoadTier(tier);
                  }
                : undefined
            }
          />
        )}
      </div>
      {model && !present && !noChrome && inspector && hub.opening.panel !== "none" && <CadInspector model={model} sel={sel} onSel={setSel} direction={direction} findings={findings} resolve={resolve} />}
    </div>
  );
}

