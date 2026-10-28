/**
 * 3D view (PB-775): the quadcopter assembled from UHD links, with interface
 * geometry resolved through three binding directions, mounting hardware
 * placed from the harnesses' fastener stacks, wire harnesses drawn from their
 * own routed artifacts (placed by the parts they connect), and callout labels.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import type { GeometryFrame, ModuleDef } from "@uhd/types/index.js";
import type { ModuleLookup } from "@uhd/system/index.js";
import type { GeometryManifest, HarnessPlacement, MateEdge } from "@uhd/system/geometry.js";
import type { UhdBundleDiagnostic } from "@uhd/types/bundle.js";
import type { LoadedSource } from "../source/source";
import type { ScopedDiagnostic } from "../model/diagnostics";
import { cadOutputs, circuitOutputs } from "../model/outputs";
import { isNet } from "@uhd/protocols/net.js";
import { findingAnchors, type FindingAnchor } from "./findings";
import {
  DIRECTIONS,
  defAt,
  explodeParts,
  interfaceRows,
  loadManifests,
  type BindingStatus,
  type CadBody,
  type CadModel,
  type Direction,
  type InterfaceRow,
} from "./model";
import { useTheme, tokenColor } from "../theme/ThemeProvider";
import { DEFAULT_SCENE_ACCENT, DEFAULT_SCENE_HIGHLIGHT, cadWrapper, createScene, focusMaterial, frameGizmo, loadGlb, materialFor, proceduralGeometry, toMatrix4, type SceneHandle } from "./scene";
import { LabelLayer, type LabelItem, type LabelKind } from "./labels";
import { planStack } from "./explode";
import { exitByRays, sampleStackPart, surrounded, type SampledPart } from "./explodeSample";
import { Icon } from "../canvas/Icon";
import { IconButton, ToggleGroup, Toolbar, ToolbarSeparator } from "../ui/Toolbar";
import { ScrollArea } from "../ui/ScrollArea";
import { ArtifactLink } from "../chrome/Artifacts";
import { layOutRow } from "./row";
import { intoScope, outOfScope, scopeRef, scopedModel, scopedPlacements, shownSummary } from "./scope";

/** View parameters from the page URL (read when the view mounts, so importing the library touches no window). */
const urlParams = () => new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);

/** Explode distance (mm per mate level) at "exploded". */
const EXPLODE_MM = 26;

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

/** The route manifest a harness's generator wrote (loaded with the other manifests). */
interface RouteManifest {
  length_mm: number;
  route_length_mm: number;
  conductor_lengths_mm: number[];
  bundle: { kind: string; conductors: number; conductor_od_mm: number; bundle_od_mm: number; twist_pitch_mm: number | null };
  bend_radius_mm: { target: number; minimum: number; centreline: number; conductors: number };
  clearance_mm: { min_conductor_surface: number | null };
  length_fit: { method: string; slack_mm?: number };
  route: [number, number, number][];
  status: string;
  notes: string[];
  step: string;
}

function routeManifest(model: CadModel, hp: HarnessPlacement): RouteManifest | undefined {
  const m = [...model.manifests.entries()].find(([k]) => k.startsWith(`${hp.def.id}:`))?.[1] as unknown as RouteManifest | undefined;
  return m && Array.isArray(m.route) ? m : undefined;
}

function cableTrait(hp: HarnessPlacement): { length_mm?: number; wire_gauge_awg?: number; conductors?: number } {
  return (hp.def.traits?.find((t) => t.type === "performance" && t.params?.kind === "cable")?.params ?? {}) as { length_mm?: number; wire_gauge_awg?: number; conductors?: number };
}

/** "3 × 20 AWG · 78 mm · twisted" */
function cableSummary(hp: HarnessPlacement, m?: RouteManifest): string {
  const c = cableTrait(hp);
  const n = c.conductors ?? m?.bundle.conductors;
  const gauge = c.wire_gauge_awg ? `${c.wire_gauge_awg} AWG` : m ? `ø${m.bundle.conductor_od_mm} mm` : "";
  return [n ? `${n} × ${gauge}`.trim() : "", c.length_mm ? `${c.length_mm} mm` : "", m?.bundle.kind ?? ""].filter(Boolean).join(" · ");
}

/**
 * Surface for a node of a harness artifact: the generator names every node
 * (conductor_*, *_housing, *_joint_*, *_tip_*) and gives it a base colour;
 * the viewer only sets how each kind of surface reflects light.
 */
function harnessMaterial(src: THREE.MeshStandardMaterial, name: string): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: src.color.clone(), metalness: src.metalness, roughness: src.roughness });
  if (/^conductor_/.test(name) && src.metalness < 0.5) {
    // silicone insulation: soft satin
    m.roughness = 0.48;
    m.metalness = 0.0;
  } else if (/_joint_|_tip_/.test(name) || src.metalness >= 0.5) {
    m.metalness = 0.9;
    m.roughness = 0.28;
  } else if (/_housing/.test(name)) {
    m.roughness = 0.42;
    m.metalness = 0.0;
  }
  return m;
}

export interface CadSelection {
  body?: string;
  iface?: string;
  /** A component drawn inside the selected body (a board's part in board.glb), by instance path. */
  component?: string;
  mate?: string;
  /** A routed wire harness, by instance path. */
  harness?: string;
}

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
  materials: THREE.MeshStandardMaterial[];
}

/**
 * Section plane: an axis of the assembly's frame, a position across its
 * bounds (0..1), and which side is kept: the lower side, the upper (`flip`),
 * or, when unset, the side away from the camera, so the cut faces the viewer.
 */
interface Section {
  axis: 0 | 1 | 2;
  at: number;
  flip?: boolean;
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
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<SceneHandle | null>(null);
  const labelsRef = useRef<LabelLayer | null>(null);
  const bodies = useRef(new Map<string, BodyRec>());
  const hardware = useRef<HardwareRec[]>([]);
  const harnessGroup = useRef(new THREE.Group());
  const harnessObjs = useRef(new Map<string, THREE.Group>());
  const [params] = useState(urlParams);
  const explode = useRef({ value: Number(params.get("explode") ?? 0) > 0 ? 1 : 0, target: Number(params.get("explode") ?? 0) > 0 ? 1 : 0 });
  const [manifests, setManifests] = useState<Map<string, GeometryManifest> | null>(null);
  const [loaded, setLoaded] = useState(0);
  /** Every model load has finished (or failed). */
  const [settled, setSettled] = useState(false);
  const [direction, setDirection] = useState<Direction>((params.get("dir") as Direction) ?? "feature");
  const [exploded, setExploded] = useState(explode.current.target === 1);
  /** The camera's move while the model comes apart or together: from where it was to a fit of where it ends. */
  const cameraTween = useRef<{ from: [THREE.Vector3, THREE.Vector3]; to: [THREE.Vector3, THREE.Vector3]; start: number } | null>(null);
  // off unless asked for (?labels=1, or the toolbar): on a small view the callouts hide the model (PB-861)
  const [showLabels, setShowLabels] = useState(params.get("labels") === "1");
  const [labelKinds, setLabelKinds] = useState<Set<LabelKind>>(new Set((params.get("labelkinds") ?? "module,harness").split(",") as LabelKind[]));
  const [labelMenu, setLabelMenu] = useState(false);
  const [showFrames, setShowFrames] = useState(params.get("frames") === "1");
  const [showWires, setShowWires] = useState(params.get("wires") !== "0");
  const [showHardware, setShowHardware] = useState(params.get("hardware") !== "0");
  // findings are pinned by default only when a host sent some that land on the model (D18); `findings=1|0` overrides
  const [findingsChoice, setShowFindings] = useState<boolean | undefined>(params.has("findings") ? params.get("findings") !== "0" : undefined);
  const [xray, setXray] = useState(params.get("xray") === "1");
  const [section, setSection] = useState<Section | null>(
    params.get("section") ? { axis: Math.max(0, ["x", "y", "z"].indexOf(params.get("section")!)) as 0 | 1 | 2, at: Number(params.get("at") ?? 0.5), ...(params.get("flip") ? { flip: params.get("flip") === "1" } : {}) } : null,
  );
  const [sectionMenu, setSectionMenu] = useState(false);
  const present = params.get("present") === "1";
  const [sel, setSel] = useState<CadSelection>({
    body: params.get("body") ?? undefined,
    iface: params.get("iface") ?? undefined,
    mate: params.get("mate") ?? undefined,
    harness: params.get("harness") ?? undefined,
    component: params.get("component") ?? undefined,
  });
  const [notes, setNotes] = useState<string[]>([]);
  const [caption, setCaption] = useState<[string, string] | null>(null);

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
    const h = createScene(host.current);
    handle.current = h;
    h.scene.add(harnessGroup.current);
    labelsRef.current = new LabelLayer(host.current);
    return () => {
      labelsRef.current?.dispose();
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

  // ---- bodies and hardware ---------------------------------------------------
  useEffect(() => {
    const h = handle.current;
    if (!h || !model) return;
    h.root.clear();
    bodies.current.clear();
    hardware.current = [];
    let cancelled = false;
    let count = 0;
    const loads: Promise<unknown>[] = [];
    setSettled(false);
    stackPlan.current = null;
    const bump = () => {
      stackPlan.current = null;
      count++;
      if (!cancelled) setLoaded(count);
    };
    for (const body of nothing ? [] : model.bodies) {
      const obj = new THREE.Group();
      obj.matrixAutoUpdate = false;
      obj.userData.key = body.key;
      const base = toMatrix4(body.matrix);
      obj.matrix.copy(base);
      h.root.add(obj);
      const rec: BodyRec = { body, obj, base, centre: new THREE.Vector3(), top: new THREE.Vector3(), offset: new THREE.Vector3(), box: new THREE.Box3(), parts: [], materials: [] };
      bodies.current.set(body.key, rec);
      if (!body.glb?.filePath) continue;
      const url = resolve(body.def.id, body.glb.filePath);
      if (!url) continue;
      loads.push(loadGlb(url).then((gltf) => {
        if (cancelled || !gltf) return;
        const scene = gltf.scene.clone(true);
        const manifest = model.manifests.get(`${body.def.id}:${body.bodyArtifact}`);
        const featureNames = new Set(Object.keys(manifest?.features ?? {}));
        // a board's manifest names its components by instance path: those are bodies, not feature pads
        const components = new Set((body.def.children ?? []).map((c) => c.id));
        // vendor models, and outputs that come with their own colours (a board), keep their materials
        const ownColours = (gltf.parser.json.materials?.length ?? 0) > 0 && !appearanceOf(body.def.id);
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
          part.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh) return;
            mesh.material = vendor ? (mesh.material as THREE.Material).clone() : materialFor(body.def, part.name, appearanceOf(body.def.id));
            rec.materials.push(mesh.material as THREE.MeshStandardMaterial);
            mesh.userData.bodyKey = body.key;
            if (components.has(part.name)) mesh.userData.component = part.name;
          });
        }
        const w = cadWrapper(scene);
        w.name = "cad";
        // local bounds for label anchors (before parenting, so world = CAD coordinates)
        w.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(w);
        // a cad standard output's named bodies come apart when exploded: each moves away from the largest
        const parts = explodeParts(body.def, body.glb, manifest);
        const node = (n: string) => top.children.find((c) => c.name === n);
        if (parts && node(parts.fixed)) {
          const centreOf = (o: THREE.Object3D) => new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3());
          const c0 = centreOf(node(parts.fixed)!);
          const fixedBox = new THREE.Box3().setFromObject(node(parts.fixed)!);
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
            const cadBox = new THREE.Box3().setFromObject(part);
            const sz = cadBox.getSize(new THREE.Vector3());
            const clear = Math.max(0, along(fixedBox, d)[1] - along(cadBox, d)[0]);
            rec.parts.push({ obj: part, base: part.position.clone(), cadDir: d, cadBox, clear, volume: sz.x * sz.y * sz.z, travel: new THREE.Vector3() });
          }
        }
        obj.add(w);
        rec.box.copy(box);
        rec.centre.copy(box.getCenter(new THREE.Vector3()));
        rec.top.set(rec.centre.x, rec.centre.y, box.max.z);
        bump();
      }));
    }
    // routed wire harnesses: each harness's own GLB, placed by the part its first end lands on
    harnessGroup.current.clear();
    harnessObjs.current.clear();
    harnessMaterials.current = [];
    for (const hp of nothing ? [] : model.assembly.harnesses) {
      const obj = new THREE.Group();
      obj.matrixAutoUpdate = false;
      obj.matrix.copy(toMatrix4(hp.matrix));
      obj.userData.harness = hp.key;
      harnessGroup.current.add(obj);
      harnessObjs.current.set(hp.key, obj);
      const glb = hp.def.artifacts?.find((a) => a.role === "body" && a.format === "glb")?.filePath;
      const url = glb && resolve(hp.def.id, glb);
      if (!url) continue;
      loads.push(loadGlb(url).then((gltf) => {
        if (cancelled || !gltf) return;
        const s = gltf.scene.clone(true);
        s.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.material = harnessMaterial(mesh.material as THREE.MeshStandardMaterial, o.name);
          harnessMaterials.current.push(mesh.material as THREE.MeshStandardMaterial);
          mesh.userData.harness = hp.key;
        });
        obj.add(cadWrapper(s));
        bump();
      }));
    }
    for (const hw of nothing ? [] : model.assembly.hardware) {
      const obj = new THREE.Group();
      obj.matrixAutoUpdate = false;
      const base = toMatrix4(hw.matrix);
      obj.matrix.copy(base);
      obj.userData.harness = hw.harness;
      h.root.add(obj);
      const zCol = new THREE.Vector3().setFromMatrixColumn(base, 2).normalize().multiplyScalar(hw.direction);
      hardware.current.push({ obj, base, harness: hw.harness, structure: hw.structure, mounted: hw.mounted, normal: zCol, atMm: hw.atMm, direction: hw.direction, offset: new THREE.Vector3() });
      const file = hw.def.artifacts?.find((a) => a.role === "body" && a.format === "glb")?.filePath;
      const url = file && resolve(hw.def.id, file);
      if (!url) continue;
      loads.push(loadGlb(url).then((gltf) => {
        if (cancelled || !gltf) return;
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
      }));
    }
    // every model has loaded (or failed): what nothing places is laid out beside the rest, then the camera fits the whole once
    void Promise.allSettled(loads).then(() => {
      if (cancelled) return;
      layOutRow([...bodies.current.values()]);
      setSettled(true);
    });
    return () => {
      cancelled = true;
    };
  }, [model, nothing]);

  // ---- explode: each body up the stack, or along the mate that placed it ------
  useEffect(() => {
    explode.current.target = exploded ? 1 : 0;
  }, [exploded]);

  /** Explode step at "exploded" (mm): a small assembly (a board in its enclosure) comes apart in proportion to its size. */
  const explodeScale = () => {
    const size = assembledBounds().getSize(new THREE.Vector3()).length();
    return EXPLODE_MM * (size > 0 && size < 120 ? Math.max(0.3, size / 120) : 1);
  };
  /**
   * The exploded stack (PB-899): how far each part rises along the model's up
   * direction, by assembly order (./explode.ts). A part placed by a mate
   * across that direction (a camera on the front) comes off along its mate
   * instead. Planned once per loaded model, in the assembled pose.
   */
  const stackPlan = useRef<{ rise: Map<string, number>; partKeys: Map<string, string> } | null>(null);
  const upRef = useRef(new THREE.Vector3(0, 0, 1));
  const planStacks = () => {
    if (stackPlan.current) return stackPlan.current;
    const h = handle.current;
    const axis = upRef.current.clone().normalize();
    const partKeys = new Map<string, string>();
    if (!h || !model) return { rise: new Map<string, number>(), partKeys };
    // the assembled pose
    for (const rec of bodies.current.values()) {
      rec.obj.matrix.copy(rec.base);
      for (const part of rec.parts) part.obj.position.copy(part.base);
    }
    h.root.updateMatrixWorld(true);
    // a named body moves in its parent's space (the GLB's own nodes may turn and scale it)
    for (const rec of bodies.current.values())
      for (const part of rec.parts) if (part.obj.parent) part.toLocal = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().copy(part.obj.parent.matrixWorld).invert());
    const along = (rec: BodyRec) => {
      const mate = rec.body.via ? model.assembly.mates.find((m) => m.linkId === rec.body.via) : undefined;
      if (!mate) return true;
      const keyOf = (end: MateEdge["a"]) => end.path.join("/") + (end.frame.artifact ? `#${end.frame.artifact}` : "");
      const parentEnd = keyOf(mate.b) === rec.body.key ? mate.a : mate.b;
      const parent = bodies.current.get(keyOf(parentEnd));
      const n = new THREE.Vector3(...parentEnd.frame.normal).transformDirection(parent?.base ?? rec.base);
      return Math.abs(n.dot(axis)) > 0.9;
    };
    const elements: { key: string; objects: THREE.Object3D[]; skip: Set<THREE.Object3D> }[] = [];
    for (const rec of bodies.current.values()) {
      if (rec.box.isEmpty() || !along(rec)) continue;
      const moving = rec.parts.filter((p) => Math.abs(p.cadDir.clone().transformDirection(rec.base).dot(axis)) > 0.7);
      elements.push({ key: rec.body.key, objects: [rec.obj], skip: new Set(moving.map((p) => p.obj)) });
      for (const p of moving) {
        const key = `${rec.body.key}::${p.obj.name}`;
        partKeys.set(key, rec.body.key);
        elements.push({ key, objects: [p.obj], skip: new Set() });
      }
    }
    const parts = elements.map((e) => sampleStackPart(e.key, e.objects, e.skip, axis)).filter((p): p is SampledPart => Boolean(p));
    const byKey = new Map(parts.map((p) => [p.key, p]));
    const rise = planStack(parts, {
      gap: explodeScale(),
      surrounds: (holder, part) => surrounded(byKey.get(holder.key)!, byKey.get(part.key)!, axis),
      exit: (holder, part) => exitByRays(byKey.get(holder.key)!, byKey.get(part.key)!, axis),
    });
    stackPlan.current = { rise, partKeys };
    return stackPlan.current;
  };
  const applyExplode = useMemo(() => {
    return (e: number) => {
      if (!model) return;
      const E = e * explodeScale();
      // assembled: nothing to plan (the plan samples every loaded body, so it waits until something comes apart)
      const plan = e > 0 ? planStacks() : { rise: new Map<string, number>(), partKeys: new Map<string, string>() };
      const axis = upRef.current.clone().normalize();
      const keyOf = (end: MateEdge["a"]) => end.path.join("/") + (end.frame.artifact ? `#${end.frame.artifact}` : "");
      /** Travel of the named body of `rec` that holds a point (body-local CAD coordinates), if one moves. */
      const partTravel = (rec: BodyRec | undefined, local: THREE.Vector3) => {
        const part = rec?.parts.find((p) => p.cadBox.clone().expandByScalar(1).containsPoint(local));
        return part ? part.travel.clone() : new THREE.Vector3();
      };
      // stacked bodies rise along up; the rest come off along the mate that placed them, after their parent
      for (const b of model.bodies) {
        const rec = bodies.current.get(b.key);
        if (!rec) continue;
        rec.offset.set(0, 0, 0);
        const rise = plan.rise.get(b.key);
        if (rise !== undefined) rec.offset.copy(axis).multiplyScalar(rise * e);
      }
      for (const b of model.bodies) {
        const rec = bodies.current.get(b.key);
        if (!rec || plan.rise.has(b.key)) continue;
        const mate = model.assembly.mates.find((m) => m.linkId === b.via);
        if (mate && E) {
          const parentEnd = keyOf(mate.b) === b.key ? mate.a : mate.b;
          const parent = bodies.current.get(keyOf(parentEnd));
          const n = new THREE.Vector3(...parentEnd.frame.normal).transformDirection(parent?.base ?? rec.base);
          // parts on a shaft (props, pulleys) travel further so they clear what drives them
          const onShaft = [mate.a.iface, mate.b.iface].some((i) => i.protocols?.some((p) => p.type === "shaft"));
          rec.offset.copy(parent?.offset ?? new THREE.Vector3()).addScaledVector(n, E * (onShaft ? 1.6 : 1));
        }
      }
      // named bodies of one artifact (an enclosure's lid): up the stack, or apart along the line between their centres
      for (const rec of bodies.current.values()) {
        for (const part of rec.parts) {
          const rise = plan.rise.get(`${rec.body.key}::${part.obj.name}`);
          if (rise !== undefined) part.travel.copy(axis).multiplyScalar(rise * e).sub(rec.offset);
          // off the stack (a plunger through a side wall): out of its bore, just clear of the body, and no further
          else part.travel.copy(part.cadDir).transformDirection(rec.base).multiplyScalar(part.clear * e + E * 0.35);
          // world travel (mm) → the node's parent's space
          part.obj.position.copy(part.base);
          if (part.toLocal && e > 0) part.obj.position.add(part.travel.clone().applyMatrix3(part.toLocal));
        }
      }
      for (const b of model.bodies) {
        const rec = bodies.current.get(b.key);
        if (!rec) continue;
        rec.obj.matrix.copy(new THREE.Matrix4().makeTranslation(rec.offset).multiply(rec.base));
        rec.obj.matrixWorldNeedsUpdate = true;
      }
      for (const hw of hardware.current) {
        const S = bodies.current.get(hw.structure)?.offset ?? new THREE.Vector3();
        const M = bodies.current.get(hw.mounted)?.offset ?? new THREE.Vector3();
        const off = new THREE.Vector3();
        if (hw.atMm < 0 && hw.direction === 1) off.copy(S).addScaledVector(hw.normal, -E * 0.9); // screws from behind: pulled out behind
        else if (hw.direction === -1 && hw.atMm > 0) off.copy(M).addScaledVector(hw.normal, -E * 0.9); // from the far side: pulled out beyond
        else if (hw.direction === -1) off.copy(S).addScaledVector(hw.normal, E * 0.9); // nuts behind the structure
        else off.copy(S).lerp(M, 0.5); // spacers, standoffs: between
        // fasteners through a shell's lid go with the lid
        const srec = bodies.current.get(hw.structure);
        if (srec?.parts.length) off.add(partTravel(srec, new THREE.Vector3().setFromMatrixPosition(hw.base).applyMatrix4(srec.base.clone().invert())));
        hw.offset.copy(off);
        hw.obj.matrix.copy(new THREE.Matrix4().makeTranslation(off).multiply(hw.base));
        hw.obj.matrixWorldNeedsUpdate = true;
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
  const showWiresRef = useRef(showWires);
  showWiresRef.current = showWires;
  const harnessMaterials = useRef<THREE.MeshStandardMaterial[]>([]);

  // per-frame: tween explode, lay out labels
  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    const f = (dt: number) => {
      const ex = explode.current;
      if (ex.value !== ex.target) {
        const step = dt / 1.4; // 1.4 s full travel
        ex.value = ex.target > ex.value ? Math.min(ex.target, ex.value + step) : Math.max(ex.target, ex.value - step);
        const eased = ex.value < 0.5 ? 4 * ex.value ** 3 : 1 - (-2 * ex.value + 2) ** 3 / 2;
        applyExplode(eased);
        const cam = cameraTween.current;
        if (cam) {
          // the camera's share of the way, on the same curve as the parts
          const k = Math.abs(ex.target - cam.start) > 0 ? Math.min(1, Math.abs(ex.value - cam.start) / Math.abs(ex.target - cam.start)) : 1;
          const t = k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2;
          h.camera.position.lerpVectors(cam.from[0], cam.to[0], t);
          h.controls.target.lerpVectors(cam.from[1], cam.to[1], t);
          h.camera.lookAt(h.controls.target);
          if (ex.value === ex.target) cameraTween.current = null;
        }
      }
      const size = h.renderer.getSize(new THREE.Vector2());
      labelsRef.current?.update(h.camera, size.x, size.y, dt);
    };
    h.onFrame.add(f);
    return () => {
      h.onFrame.delete(f);
    };
  }, [applyExplode]);
  useEffect(() => {
    const ex = explode.current;
    const eased = ex.value < 0.5 ? 4 * ex.value ** 3 : 1 - (-2 * ex.value + 2) ** 3 / 2;
    applyExplode(eased);
  }, [applyExplode, loaded, showWires]);

  useEffect(() => {
    harnessGroup.current.visible = showWires && explode.current.value < 0.35;
  }, [showWires, loaded]);

  useEffect(() => {
    for (const hw of hardware.current) hw.obj.visible = showHardware;
  }, [showHardware, loaded]);

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
      for (const m of r.materials) {
        const base = (m.userData.base ??= { transparent: m.transparent, opacity: m.opacity, depthWrite: m.depthWrite }) as { transparent: boolean; opacity: number; depthWrite: boolean };
        const see = xray && shell;
        m.transparent = see || base.transparent;
        m.opacity = see ? 0.22 : base.opacity;
        m.depthWrite = see ? false : base.depthWrite;
        m.needsUpdate = true;
      }
    }
    setShells(count);
    handle.current?.renderOnce();
  }, [xray, loaded, model, settled]);

  // ---- selection overlays: interface geometry per direction, frames ----------
  useEffect(() => {
    const h = handle.current;
    if (!h || !model) return;
    const restore: (() => void)[] = [];
    const newNotes: string[] = [];
    const objOf = (key: string) => bodies.current.get(key)?.obj;

    for (const [key, rec] of bodies.current) {
      rec.obj.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        // an assembly with no body of its own is selected as its parts
        if (m && "emissive" in m) m.emissive.setHex(sel.body !== undefined && (key === sel.body || (sel.body !== "" && key.startsWith(`${sel.body}/`))) ? h.colors.glow : 0x000000);
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
      objOf(selBody.key)?.traverse((o) => {
        if (o.name !== node) return;
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
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (!m || !("emissive" in m)) return;
        const was = m.emissive.getHex();
        m.emissive.setHex(h.colors.glowStrong);
        restore.push(() => m.emissive.setHex(was));
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
    return () => restore.forEach((f) => f());
  }, [model, sel, direction, showFrames, loaded, themed]);

  // ---- picking ---------------------------------------------------------------
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
      const hit = ray.intersectObjects([h.root, harnessGroup.current], true).find((x) => x.object.visible && harnessGroup.current.visible !== false && (x.object.userData.bodyKey || x.object.userData.harness));
      if (!hit) setSel({});
      else if (hit.object.userData.harness) setSel({ harness: hit.object.userData.harness });
      else {
        const k = hit.object.userData.bodyKey as string;
        const hwMate = model?.assembly.hardware.find((x) => x.harness === k)?.linkId;
        const child = hit.object.userData.component as string | undefined;
        // a component is named by its instance path in the model (the body's path, then its id in the body), as a host's focus names it
        const holder = k.split("#")[0];
        const component = child === undefined ? undefined : holder ? `${holder}/${child}` : child;
        setSel(hwMate ? { mate: hwMate } : component ? { body: k, component } : { body: k });
      }
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
    };
  }, [model]);

  // ---- camera helpers and the capture API ---------------------------------------
  /** The direction drawn up (a display hint; default +z) and the rotation from +z to it. */
  // the project's saved view (its up direction, its camera) is the assembly's: a module on its own is seen in its own coordinates
  const upVec = useMemo(() => new THREE.Vector3(...((at ? undefined : display.view?.up) ?? [0, 0, 1])).normalize(), [source, at]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!upRef.current.equals(upVec)) {
    upRef.current = upVec.clone();
    stackPlan.current = null;
  }
  const upQuat = useMemo(() => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), upVec), [upVec]);
  /** Unit vector from the target to the camera for an azimuth and elevation about `up`. */
  const viewDir = (azimuthDeg: number, elevationDeg: number) => {
    const az = (azimuthDeg * Math.PI) / 180;
    const el = (elevationDeg * Math.PI) / 180;
    return new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)).applyQuaternion(upQuat);
  };
  const orbit = (azimuthDeg: number, elevationDeg: number, distance: number, target = new THREE.Vector3(0, 0, 18)) => {
    const h = handle.current;
    if (!h) return;
    h.controls.target.copy(target);
    h.camera.position.copy(target).addScaledVector(viewDir(azimuthDeg, elevationDeg), distance);
    h.camera.lookAt(target);
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
    const panel = !present && inspector && size.x > 900 ? 380 / size.x : 0;
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
    orbit(azimuthDeg, elevationDeg, d, target);
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
      // where it ends: lay the parts out there for a moment, fit, and put everything back
      applyExplode(on ? 1 : 0);
      h.root.updateMatrixWorld(true);
      fitAsSeen();
      const to: [THREE.Vector3, THREE.Vector3] = [h.camera.position.clone(), h.controls.target.clone()];
      applyExplode(now);
      h.camera.position.copy(from[0]);
      h.controls.target.copy(from[1]);
      h.camera.lookAt(from[1]);
      cameraTween.current = { from, to, start: ex.value };
    }
    setExploded(on);
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
    if (!h || !recs.length) return;
    if (!sel.iface || !rec) {
      const box = new THREE.Box3();
      for (const r of recs) box.expandByObject(r.obj);
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
  };
  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    // Deterministic control for video capture: scripts/capture-cad-video.mjs
    (window as unknown as Record<string, unknown>).__cad = {
      ready: () => loaded,
      settled: () => settled,
      set: (s: { azimuth?: number; elevation?: number; distance?: number; target?: [number, number, number]; explode?: number; labels?: boolean; snap?: boolean; caption?: [string, string] }) => {
        h.manual.on = true;
        if (s.caption) setCaption(s.caption);
        if (s.explode !== undefined) {
          explode.current.value = explode.current.target = s.explode;
          const e = s.explode;
          applyExplode(e < 0.5 ? 4 * e ** 3 : 1 - (-2 * e + 2) ** 3 / 2);
        }
        if (s.labels !== undefined && labelsRef.current) {
          labelsRef.current.target = s.labels ? 1 : 0;
          // stills: no fade between shots
          if (s.snap) labelsRef.current.opacity = labelsRef.current.target;
        }
        if (s.snap && labelsRef.current) {
          labelsRef.current.snap = true;
        }
        if (s.azimuth !== undefined) orbit(s.azimuth, s.elevation ?? 28, s.distance ?? 520, s.target ? new THREE.Vector3(...s.target) : undefined);
        h.renderOnce();
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyExplode, loaded, settled]);
  // the opening camera (once): the URL's az/el/dist, else the project's saved view, else the defaults;
  // the model is fitted once every model has loaded unless a distance was given (PB-873)
  const saved = at ? undefined : display.view?.camera;
  const opening = {
    az: Number(params.get("az") ?? saved?.azimuth ?? -58),
    el: Number(params.get("el") ?? saved?.elevation ?? 28),
    dist: params.get("dist") ? Number(params.get("dist")) : saved?.distance,
    target: saved?.target ? new THREE.Vector3(...saved.target) : undefined,
  };
  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    h.setUp(upVec);
    if (!params.get("focus")) orbit(opening.az, opening.el, opening.dist ?? 520, opening.target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upVec]);
  const framed = useRef(false);
  useEffect(() => {
    const h = handle.current;
    if (!h || !model || !settled) return;
    const box = assembledBounds();
    h.setGround(box);
    if (framed.current || params.get("focus") || h.manual.on) return;
    framed.current = true;
    if (opening.dist !== undefined) return;
    // what is drawn: a section view opens on the half it keeps, centred
    fit(visibleBounds(), opening.az, opening.el);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, model]);
  useEffect(() => {
    if (params.get("focus") === "1" && loaded >= (model?.bodies.filter((b) => b.glb).length ?? 1)) focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, model]);

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
    if (!look.current || sel.body === undefined || !selectionRecs(sel.body).length) return;
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

  const toggleKind = (k: LabelKind) =>
    setLabelKinds((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  return (
    <div className={`cad-view${present ? " present" : ""}`}>
      <div className="cad-canvas" ref={host}>
        {!present && (
          <Toolbar label="3D tools" className="cad-toolbar">
            <ToggleGroup
              label="Assembly"
              tooltipSide="top"
              options={[
                { id: "assembled", icon: "box", label: "Assembled" },
                { id: "exploded", icon: "layers", label: "Exploded" },
              ]}
              value={exploded ? "exploded" : "assembled"}
              onChange={(v) => toggleExploded(v === "exploded")}
            />
            <ToolbarSeparator />
            <div className="cad-menu-wrap">
              <IconButton icon="tag" label="Callout labels" tooltipSide="top" pressed={showLabels} onClick={() => setShowLabels(!showLabels)} />
              <IconButton icon="chevron-up" size="sm" className="w-5" label="Label types" tooltipSide="top" aria-expanded={labelMenu} onClick={() => setLabelMenu(!labelMenu)} />
              {labelMenu && (
                <div className="cad-menu">
                  <div className="cad-menu-label">Show labels for</div>
                  {(
                    [
                      ["module", "Modules"],
                      ["harness", "Harnesses & hardware"],
                      ["interface", "Interfaces (mates)"],
                    ] as [LabelKind, string][]
                  ).map(([k, label]) => (
                    <button key={k} className="cad-menu-item" onClick={() => toggleKind(k)}>
                      <span className={`cad-check${labelKinds.has(k) ? " on" : ""}`}>{labelKinds.has(k) && <Icon name="check" size={12} />}</span>
                      <span className={`cad-kind-dot kind-${k}`} />
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {(model?.assembly.hardware.length ?? 0) > 0 && (
              <IconButton icon="wrench" label="Mounting hardware" tooltipSide="top" pressed={showHardware} onClick={() => setShowHardware(!showHardware)} />
            )}
            {(model?.assembly.harnesses.length ?? 0) > 0 && (
              <IconButton icon="cable" label="Routed wire harnesses" tooltipSide="top" pressed={showWires} onClick={() => setShowWires(!showWires)} />
            )}
            <IconButton icon="move-3d" label="Every interface frame" tooltipSide="top" pressed={showFrames} onClick={() => setShowFrames(!showFrames)} />
            <ToolbarSeparator />
            <div className="cad-menu-wrap">
              <IconButton icon="scissors" label="Section" tooltipSide="top" pressed={Boolean(section)} onClick={() => setSection(section ? null : { axis: 1, at: 0.5 })} />
              <IconButton icon="chevron-up" size="sm" className="w-5" label="Section plane" tooltipSide="top" aria-expanded={sectionMenu} onClick={() => setSectionMenu(!sectionMenu)} />
              {sectionMenu && (
                <div className="cad-menu cad-section">
                  <div className="cad-menu-label">Section plane</div>
                  <div className="segmented">
                    {(["X", "Y", "Z"] as const).map((a, i) => (
                      <button key={a} className={section?.axis === i ? "on" : ""} onClick={() => setSection({ at: section?.at ?? 0.5, axis: i as 0 | 1 | 2 })}>
                        {a}
                      </button>
                    ))}
                    <button
                      className={section?.flip !== undefined ? "on" : ""}
                      onClick={() => {
                        const h = handle.current;
                        const axis = section?.axis ?? 1;
                        const auto = h ? h.camera.position.getComponent(axis) < h.controls.target.getComponent(axis) : false;
                        setSection({ axis, at: section?.at ?? 0.5, flip: !(section?.flip ?? auto) });
                      }}
                      aria-label="Keep the other side"
                      data-tooltip="Keep the other side"
                    >
                      <Icon name="arrow-up-down" size={13} />
                    </button>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={section?.at ?? 0.5}
                    onChange={(e) => setSection({ ...(section ?? { axis: 1 }), at: Number(e.target.value) })}
                  />
                </div>
              )}
            </div>
            <IconButton
              icon="scan-eye"
              label={shells ? "X-ray" : "X-ray: nothing to see through"}
              tooltipSide="top"
              pressed={xray && shells > 0}
              aria-disabled={!shells || undefined}
              className={shells ? undefined : "cursor-default opacity-40 hover:bg-transparent"}
              onClick={() => shells && setXray(!xray)}
            />
            {findings.length > 0 && (
              <IconButton
                icon="triangle-alert"
                label={`Findings on the model · ${findings.length}`}
                tooltipSide="top"
                pressed={showFindings}
                badge={findings.length}
                onClick={() => setShowFindings(!showFindings)}
              />
            )}
            <ToolbarSeparator />
            <ToggleGroup
              label="Interface direction"
              tooltipSide="top"
              options={DIRECTIONS.map((d) => ({ id: d.id, icon: d.icon, label: `Interface geometry by ${d.label.toLowerCase().replace(/^d/, "D")}: ${d.hint}` }))}
              value={direction}
              onChange={setDirection}
            />
            <ToolbarSeparator />
            <IconButton icon="maximize" label="Fit" tooltipSide="top" onClick={fitAsSeen} />
            <IconButton icon="crosshair" label="Look along normal" tooltipSide="top" disabled={!sel.body} onClick={focus} />
          </Toolbar>
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
          model && summary && !present && (
            <div className="cad-scope" data-tooltip={summary.unplaced.length ? `Not placed (nothing says where they sit): ${summary.unplaced.slice(0, 12).map((u) => u.name).join(", ")}${summary.unplaced.length > 12 ? ` and ${summary.unplaced.length - 12} more` : ""}` : undefined} data-tooltip-side="bottom">
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
        {!present && notes.length > 0 && (
          <div className="cad-notes">
            {notes.map((n, i) => (
              <div key={i}>{n}</div>
            ))}
          </div>
        )}
      </div>
      {model && !present && inspector && <CadInspector model={model} sel={sel} onSel={setSel} direction={direction} findings={findings} resolve={resolve} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<BindingStatus, string> = {
  bound: "bound",
  stale: "stale",
  missing: "missing",
  unchecked: "unchecked",
  none: "—",
};

function Chips({ row }: { row: InterfaceRow }) {
  if (row.logical) return <span className="gchip logical">LOGICAL</span>;
  if (row.unmapped) return <span className="gchip unmapped">UNMAPPED</span>;
  return (
    <span className="gchips">
      {row.frame ? <span className="gchip ok" title="Has a mating frame">FRAME</span> : row.sources.some((s) => s !== row.iface.id) ? <span className="gchip via" title="Resolved through its children">VIA {row.sources.length}</span> : null}
      {DIRECTIONS.map((d) => {
        const list = row.byDirection[d.id];
        const status: BindingStatus = !list.length ? "none" : list.some((x) => x.status === "stale") ? "stale" : list.some((x) => x.status === "missing") ? "missing" : list.every((x) => x.status === "unchecked") ? "unchecked" : "bound";
        return (
          <span key={d.id} className={`gchip ${status}`} title={`${d.label}: ${STATUS_LABEL[status]}`}>
            {d.label.split(" ")[0]}
          </span>
        );
      })}
    </span>
  );
}

const fmtV = (v?: number[]) => (v ? `[${v.map((x) => +x.toFixed(2)).join(", ")}]` : "—");

function FrameTable({ frame }: { frame: GeometryFrame }) {
  return (
    <div className="kv-grid">
      {frame.artifact && (
        <>
          <span className="k">body</span>
          <span className="v">{frame.artifact}</span>
        </>
      )}
      <span className="k">origin</span>
      <span className="v">{fmtV(frame.origin)}</span>
      <span className="k">normal</span>
      <span className="v">{fmtV(frame.normal)}</span>
      <span className="k">xAxis</span>
      <span className="v">{fmtV(frame.xAxis)}</span>
      <span className="k">symmetry</span>
      <span className="v">{frame.symmetryDeg ? `${frame.symmetryDeg}°` : "none"}</span>
    </div>
  );
}

function CadInspector({
  model,
  sel,
  onSel,
  direction,
  findings,
  resolve,
}: {
  model: CadModel;
  sel: CadSelection;
  onSel: (s: CadSelection) => void;
  direction: Direction;
  findings: FindingAnchor[];
  resolve: LoadedSource["resolveArtifact"];
}) {
  const body = model.bodies.find((b) => b.key === sel.body);
  // a board's nets are its conductors, drawn by its body and shown in the diagram: not interface geometry
  const rows = useMemo(() => (body ? interfaceRows(body.def, model.manifests).filter((r) => !isNet(r.iface)) : []), [body, model]);
  const row = rows.find((r) => r.iface.id === sel.iface);
  const mate = sel.mate ? model.assembly.mates.find((m) => m.linkId === sel.mate) : undefined;
  const route = sel.mate ? model.assembly.routes.find((m) => m.linkId === sel.mate) : undefined;
  const harness = sel.harness ? model.assembly.harnesses.find((h) => h.key === sel.harness) : undefined;
  const hm = harness && routeManifest(model, harness);
  const nameOf = (path: string[]) => {
    const def = model.defs.get(path.join("/"));
    return def?.name ?? path.join("/");
  };
  // links inside a body that draws its components (a board's nets) are the board design's, not wires to route
  const holders = [...new Set(model.within.values())];
  const unrouted = model.assembly.unrouted.filter((u) => !holders.some((h) => !h || u.linkId.startsWith(`${h}/`)));

  return (
    <aside className="inspector cad-inspector">
      <div className="inspector-header">
        <span className="section-title">{body ? "MODULE" : harness ? "HARNESS" : mate || route ? "LINK" : "ASSEMBLY"}</span>
        {(body || mate || route || harness) && (
          <button className="mini" onClick={() => onSel({})}>
            ASSEMBLY
          </button>
        )}
      </div>
      <ScrollArea className="inspector-scroll" contentClassName="inspector-body">
        {body ? (
          <>
            <h3 className="cad-title">{body.def.name}</h3>
            <div className="cad-sub">
              {body.path.join(" / ") || "the bundle's root"}
              {body.key.includes("#") ? ` · body ${body.key.split("#")[1]}` : ""}
            </div>
            <div className="cad-sub">
              {body.via ? (
                <>
                  placed by link <button className="linklike" onClick={() => onSel({ mate: body.via })}>{body.via}</button>
                </>
              ) : body.hint ? (
                body.hint
              ) : (
                "assembly root"
              )}
            </div>
            <div className="section-title">INTERFACES · GEOMETRY</div>
            <div className="cad-rows">
              {rows.map((r) => (
                <button key={r.iface.id} className={`cad-row${r.iface.id === sel.iface ? " on" : ""}`} onClick={() => onSel({ body: body.key, iface: r.iface.id })}>
                  <span className="cad-row-name">{r.iface.id}</span>
                  <Chips row={r} />
                </button>
              ))}
            </div>
            {row && <InterfaceDetails row={row} direction={direction} />}
            <BodyContents model={model} body={body} sel={sel} onSel={onSel} resolve={resolve} />
            <div className="section-title">ARTIFACTS</div>
            <div className="cad-artifacts">
              {(body.def.artifacts ?? [])
                .filter((a) => a.role)
                .map((a) => (
                  <div key={a.id} className="cad-artifact" title={a.filePath ?? a.url}>
                    <span className={`gchip role-${a.role}`}>{a.role?.toUpperCase()}</span>
                    <span className="cad-artifact-name">{a.id}</span>
                    <span className="cad-artifact-fmt">{a.format}</span>
                    {a.interfaceId && <span className="cad-artifact-if">→ {a.interfaceId}</span>}
                  </div>
                ))}
            </div>
          </>
        ) : harness ? (
          <>
            <h3 className="cad-title">{harness.def.name}</h3>
            <div className="cad-sub">{harness.key} · placed by link {harness.via}</div>
            <div className="kv-grid">
              <span className="k">cable</span>
              <span className="v">{cableSummary(harness, hm)}</span>
              {hm && (
                <>
                  <span className="k">routed</span>
                  <span className="v">
                    {hm.route_length_mm} mm · {hm.length_fit.method ?? "shortest"}
                    {hm.length_fit.slack_mm && hm.length_fit.slack_mm > 0.5 ? ` (${hm.length_fit.slack_mm} mm slack)` : ""}
                  </span>
                  <span className="k">bend</span>
                  <span className="v">
                    min {hm.bend_radius_mm.centreline} mm (target {hm.bend_radius_mm.target})
                  </span>
                  <span className="k">clearance</span>
                  <span className="v">{hm.clearance_mm.min_conductor_surface ?? "—"} mm</span>
                </>
              )}
            </div>
            <div className="section-title">ENDS</div>
            {harness.ends.map((e) => (
              <div key={e.interfaceId} className="cad-row">
                <span className="cad-row-name">
                  {e.interfaceId} → {e.counterpart}
                </span>
                <span className={`gchip ${e.status === "stale" ? "stale" : e.status === "matches" || e.status === "anchor" ? "bound" : "unchecked"}`}>{e.status.toUpperCase()}</span>
              </div>
            ))}
            {hm?.notes.map((n, i) => (
              <div key={i} className="cad-issue warning">
                {n}
              </div>
            ))}
            <div className="section-title">ARTIFACTS</div>
            <div className="cad-artifacts">
              {(harness.def.artifacts ?? [])
                .filter((a) => a.role)
                .map((a) => (
                  <div key={a.id} className="cad-artifact" title={a.filePath ?? a.url}>
                    <span className={`gchip role-${a.role}`}>{a.role?.toUpperCase()}</span>
                    <span className="cad-artifact-name">{a.id}</span>
                    <span className="cad-artifact-fmt">{a.format}</span>
                  </div>
                ))}
            </div>
          </>
        ) : mate ? (
          <>
            <h3 className="cad-title">{mate.linkId}</h3>
            <div className="cad-sub">rigid mate{mate.harness ? ` · harness ${mate.harness}` : ""}</div>
            {[mate.a, mate.b].map((end, i) => (
              <div key={i} className="cad-end">
                <button className="linklike" onClick={() => onSel({ body: end.path.join("/") + (end.frame.artifact ? `#${end.frame.artifact}` : ""), iface: end.iface.id, mate: mate.linkId })}>
                  {end.path.join("/")}.{end.iface.id}
                </button>
                <FrameTable frame={end.frame} />
              </div>
            ))}
            <div className="kv-grid">
              <span className="k">gap</span>
              <span className="v">{mate.mate?.gapMm ?? 0} mm</span>
              <span className="k">rotation</span>
              <span className="v">{mate.mate?.rotationDeg ?? 0}°</span>
            </div>
          </>
        ) : route ? (
          <>
            <h3 className="cad-title">{route.linkId}</h3>
            <div className="cad-sub">wire route: {route.a.frames.length} → {route.b.frames.length} frame(s)</div>
            <div className="cad-sub">
              {route.a.path.join("/")}.{route.a.iface.id} ({route.a.frames.map((f) => f.interfaceId).join(", ")}) → {route.b.path.join("/")}.{route.b.iface.id} (
              {route.b.frames.map((f) => f.interfaceId).join(", ")})
            </div>
          </>
        ) : (
          <>
            <div className="section-title">PLACED FROM LINKS · {model.assembly.placements.length}</div>
            <div className="cad-rows">
              {model.bodies.map((b) => (
                <button key={b.key} className="cad-row" onClick={() => onSel({ body: b.key })}>
                  <span className="cad-row-name">{b.key || b.def.name}</span>
                  <span className="cad-row-via">{b.via ?? (b.hint ? "hint" : "root")}</span>
                </button>
              ))}
            </div>
            {findings.length > 0 && (
              <>
                <div className="section-title">FINDINGS ON THE MODEL · {findings.length}</div>
                {findings.map((f) => (
                  <button key={f.id} className={`cad-finding ${f.severity}`} onClick={() => onSel(f.select)}>
                    <Icon name={f.severity === "error" ? "octagon-x" : "triangle-alert"} size={13} />
                    <span>
                      <b>{f.title}</b>
                      {f.message}
                    </span>
                  </button>
                ))}
              </>
            )}
            <div className="section-title">NOT PLACED</div>
            {model.within.size > 0 && (
              <div className="cad-issue">
                {model.within.size} components are drawn in their board's own body ({[...new Set(model.within.values())].map((k) => model.bodies.find((b) => b.key === k)?.def.name ?? (k || "root")).join(", ")}), not placed one by one.
              </div>
            )}
            {model.assembly.issues
              .filter((i) => i.severity === "info" && !model.bodies.some((b) => b.key === i.subject) && !model.within.has(i.subject))
              .map((i) => (
                <div key={i.subject} className="cad-issue">
                  <b>{nameOf(i.subject.split("/"))}</b> — {i.message}
                </div>
              ))}
            {model.assembly.issues
              .filter((i) => i.severity !== "info")
              .map((i) => (
                <div key={i.subject + i.message} className={`cad-issue ${i.severity}`}>
                  <b>{i.subject}</b> — {i.message}
                </div>
              ))}
            <div className="section-title">HARNESSES · {model.assembly.harnesses.length} ROUTED</div>
            {model.assembly.harnesses.map((hp) => (
              <button key={hp.key} className="cad-row" onClick={() => onSel({ harness: hp.key })}>
                <span className="cad-row-name">{hp.key}</span>
                <span className="cad-row-via">{hp.ends.some((e) => e.status === "stale") ? "stale" : cableTrait(hp).length_mm ? `${cableTrait(hp).length_mm} mm` : ""}</span>
              </button>
            ))}
            {model.assembly.routes.length > 0 && <div className="section-title">DIRECT WIRES · {model.assembly.routes.length}</div>}
            {model.assembly.routes.map((r) => (
              <button key={r.linkId} className="cad-row" onClick={() => onSel({ mate: r.linkId })}>
                <span className="cad-row-name">{r.linkId}</span>
                <span className="cad-row-via">
                  {r.a.frames.length}→{r.b.frames.length}
                </span>
              </button>
            ))}
            {unrouted.length > 0 && (
              <>
                <div className="section-title">UNROUTED · {unrouted.length}</div>
                <div className="cad-issue">
                  No geometry on {[...new Set(unrouted.flatMap((u) => u.missing))].slice(0, 8).join(", ")}
                  {unrouted.length > 8 ? " …" : ""}
                </div>
              </>
            )}
          </>
        )}
      </ScrollArea>
    </aside>
  );
}

/**
 * What a body holds besides its interfaces: the components a board's body
 * draws (named by instance path in its manifest), the named bodies of a
 * multi-body artifact (an enclosure's back and lid), and the manufacturing
 * exports of a cad output.
 */
function BodyContents({ model, body, sel, onSel, resolve }: { model: CadModel; body: CadBody; sel: CadSelection; onSel: (s: CadSelection) => void; resolve: LoadedSource["resolveArtifact"] }) {
  const manifest = model.manifests.get(`${body.def.id}:${body.bodyArtifact}`);
  const components = (body.def.children ?? []).filter((c) => manifest?.features[c.id]);
  const named = Object.entries(manifest?.bodies ?? {});
  const cad = cadOutputs(body.def);
  const circuit = circuitOutputs(body.def);
  return (
    <>
      {components.length > 0 && (
        <>
          <div className="section-title">COMPONENTS · {components.length}</div>
          <div className="cad-rows">
            {components.map((c) => (
              <button key={c.id} className={`cad-row${sel.component === c.id ? " on" : ""}`} onClick={() => onSel({ body: body.key, component: c.id })}>
                <span className="cad-row-name">{c.id}</span>
                <span className="cad-row-via">{c.name ?? c.moduleDefId}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {named.length > 1 && (
        <>
          <div className="section-title">BODIES · {named.length}</div>
          <div className="kv-grid">
            {named.map(([n, v]) => (
              <span key={n} style={{ display: "contents" }}>
                <span className="k">{n}</span>
                <span className="v">{Math.round(v).toLocaleString()} mm³</span>
              </span>
            ))}
          </div>
          <div className="cad-sub">Exploding separates them along the line between their centres.</div>
        </>
      )}
      {cad && cad.exports.length > 0 && (
        <>
          <div className="section-title">MANUFACTURING EXPORTS · {cad.exports.length}</div>
          <div className="artifact-files">
            {cad.exports.map((a) => (
              <ArtifactLink key={a.id} defId={body.def.id} artifactId={a.id} href={a.url ?? (a.filePath ? resolve(body.def.id, a.filePath) : undefined)}>
                <Icon name="printer" size={11} />
                <span className="artifact-name">{(a.filePath ?? a.name).split("/").pop()}</span>
                <span className="artifact-format">{(a.format ?? "").toUpperCase()}</span>
              </ArtifactLink>
            ))}
          </div>
        </>
      )}
      {circuit && <div className="cad-sub">Board drawings, BOM and pick-and-place: select the board in the diagram.</div>}
    </>
  );
}

function InterfaceDetails({ row, direction }: { row: InterfaceRow; direction: Direction }) {
  return (
    <div className="cad-detail">
      <div className="section-title">{row.iface.id.toUpperCase()}</div>
      {row.frame ? <FrameTable frame={row.frame} /> : row.sources.length > 0 && <div className="cad-sub">frames from {row.sources.join(", ")}</div>}
      {row.unmapped && <div className="cad-sub">No frame and no geometry reference, on the interface or its children.</div>}
      {DIRECTIONS.map((d) => (
        <div key={d.id} className={`cad-dir${d.id === direction ? " on" : ""}`}>
          <span className="cad-dir-label">{d.label}</span>
          {row.byDirection[d.id].length === 0 ? (
            <span className="cad-dir-none">—</span>
          ) : (
            row.byDirection[d.id].map((r, i) => (
              <div key={i} className="cad-ref">
                <span className={`gchip ${r.status}`}>{r.status.toUpperCase()}</span>
                <code>
                  {r.ref.kind === "feature" ? `${r.ref.artifact} › ${r.ref.name}` : r.ref.kind === "artifact" ? r.ref.artifact : `${r.ref.generator}()`}
                </code>
                {r.ref.kind !== "procedural" && r.ref.signature && (
                  <span className="cad-sig">
                    {r.ref.signature.area_mm2.toFixed(1)} mm² @ {fmtV(r.ref.signature.centroid)}
                  </span>
                )}
                {r.note && <span className="cad-sig">{r.note}</span>}
              </div>
            ))
          )}
        </div>
      ))}
      {row.issues.map((i, k) => (
        <div key={k} className={`cad-issue ${i.severity}`}>
          {i.message}
        </div>
      ))}
    </div>
  );
}
