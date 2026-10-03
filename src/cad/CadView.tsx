/**
 * 3D view (PB-775): the quadcopter assembled from UHD links, with interface
 * geometry resolved through three binding directions, mounting hardware
 * placed from the harnesses' fastener stacks, wire harnesses drawn from their
 * own routed artifacts (placed by the parts they connect), and callout labels.
 */
import { useEffect, useMemo, useRef, useState } from "react";
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
  buildCadModel,
  interfaceRows,
  loadManifests,
  type BindingStatus,
  type CadBody,
  type CadModel,
  type Direction,
  type InterfaceRow,
} from "./model";
import { COLORS, cadWrapper, createScene, focusMaterial, frameGizmo, loadGlb, materialFor, proceduralGeometry, toMatrix4, type SceneHandle } from "./scene";
import { LabelLayer, type LabelItem, type LabelKind } from "./labels";
import { Icon } from "../canvas/Icon";

const params = new URLSearchParams(window.location.search);

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
  parts: { obj: THREE.Object3D; base: THREE.Vector3; dir: THREE.Vector3 }[];
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
}: {
  system: ModuleDef;
  lookup: ModuleLookup;
  source: LoadedSource;
  /** The viewer's own checks (root and boards) and the host's findings, pinned to the model where they name something placed. */
  diagnostics?: ScopedDiagnostic[];
  hostDiagnostics?: UhdBundleDiagnostic[];
}) {
  const display = source.display.spatial ?? {};
  const resolve = source.resolveArtifact;
  const appearanceOf = (defId: string) => display.appearance?.[defId];
  const hints = useMemo(
    () => Object.entries(display.placements ?? {}).map(([key, h]) => ({ path: key.split("/"), matrix: h.matrix, note: h.note ?? "placed by a display hint" })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source],
  );
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<SceneHandle | null>(null);
  const labelsRef = useRef<LabelLayer | null>(null);
  const bodies = useRef(new Map<string, BodyRec>());
  const hardware = useRef<HardwareRec[]>([]);
  const harnessGroup = useRef(new THREE.Group());
  const harnessObjs = useRef(new Map<string, THREE.Group>());
  const explode = useRef({ value: Number(params.get("explode") ?? 0) > 0 ? 1 : 0, target: Number(params.get("explode") ?? 0) > 0 ? 1 : 0 });
  const [manifests, setManifests] = useState<Map<string, GeometryManifest> | null>(null);
  const [loaded, setLoaded] = useState(0);
  const [direction, setDirection] = useState<Direction>((params.get("dir") as Direction) ?? "feature");
  const [exploded, setExploded] = useState(explode.current.target === 1);
  const [showLabels, setShowLabels] = useState(params.get("labels") !== "0");
  const [labelKinds, setLabelKinds] = useState<Set<LabelKind>>(new Set((params.get("labelkinds") ?? "module,harness").split(",") as LabelKind[]));
  const [labelMenu, setLabelMenu] = useState(false);
  const [showFrames, setShowFrames] = useState(params.get("frames") === "1");
  const [showWires, setShowWires] = useState(params.get("wires") !== "0");
  const [showHardware, setShowHardware] = useState(params.get("hardware") !== "0");
  const [showFindings, setShowFindings] = useState(params.get("findings") !== "0");
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
    const out = new Map<string, ModuleDef>();
    const walk = (d: ModuleDef) => {
      for (const c of d.children ?? []) {
        const def = lookup(c.moduleDefId);
        if (def && !out.has(def.id)) {
          out.set(def.id, def);
          walk(def);
        }
      }
    };
    walk(system);
    return [...out.values()];
  }, [system, lookup]);
  useEffect(() => {
    loadManifests(allDefs, resolve).then(setManifests);
  }, [allDefs]);

  const model: CadModel | null = useMemo(
    () => (manifests ? buildCadModel(system, lookup, manifests, hints, display.root ? display.root.split("/") : undefined) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [system, lookup, manifests, hints],
  );

  const findings = useMemo(() => (model ? findingAnchors(model, diagnostics, hostDiagnostics) : []), [model, diagnostics, hostDiagnostics]);

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

  // ---- bodies and hardware ---------------------------------------------------
  useEffect(() => {
    const h = handle.current;
    if (!h || !model) return;
    h.root.clear();
    bodies.current.clear();
    hardware.current = [];
    let cancelled = false;
    let count = 0;
    const bump = () => {
      count++;
      if (!cancelled) setLoaded(count);
    };
    for (const body of model.bodies) {
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
      loadGlb(url).then((gltf) => {
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
        // named bodies that come apart when exploded: each moves away from the largest
        const named = Object.entries(manifest?.bodies ?? {}).filter(([n]) => top.children.some((c) => c.name === n));
        if (named.length > 1) {
          const [largest] = [...named].sort((a, b) => b[1] - a[1])[0];
          const centreOf = (n: string) => new THREE.Box3().setFromObject(top.children.find((c) => c.name === n)!).getCenter(new THREE.Vector3());
          const c0 = centreOf(largest);
          for (const [n] of named) {
            if (n === largest) continue;
            const part = top.children.find((c) => c.name === n)!;
            const d = centreOf(n).sub(c0).normalize();
            // CAD (x, y, z) mm → the node's glTF space (x, z, −y) m
            rec.parts.push({ obj: part, base: part.position.clone(), dir: new THREE.Vector3(d.x, d.z, -d.y).divideScalar(1000) });
          }
        }
        obj.add(w);
        rec.box.copy(box);
        rec.centre.copy(box.getCenter(new THREE.Vector3()));
        rec.top.set(rec.centre.x, rec.centre.y, box.max.z);
        bump();
      });
    }
    // routed wire harnesses: each harness's own GLB, placed by the part its first end lands on
    harnessGroup.current.clear();
    harnessObjs.current.clear();
    harnessMaterials.current = [];
    for (const hp of model.assembly.harnesses) {
      const obj = new THREE.Group();
      obj.matrixAutoUpdate = false;
      obj.matrix.copy(toMatrix4(hp.matrix));
      obj.userData.harness = hp.key;
      harnessGroup.current.add(obj);
      harnessObjs.current.set(hp.key, obj);
      const glb = hp.def.artifacts?.find((a) => a.role === "body" && a.format === "glb")?.filePath;
      const url = glb && resolve(hp.def.id, glb);
      if (!url) continue;
      loadGlb(url).then((gltf) => {
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
      });
    }
    for (const hw of model.assembly.hardware) {
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
      loadGlb(url).then((gltf) => {
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
      });
    }
    return () => {
      cancelled = true;
    };
  }, [model]);

  // ---- explode: animate each body along the mate that placed it --------------
  useEffect(() => {
    explode.current.target = exploded ? 1 : 0;
  }, [exploded]);

  const applyExplode = useMemo(() => {
    return (e: number) => {
      if (!model) return;
      // a small assembly (a board in its enclosure) comes apart in proportion to its size
      const size = assembledBounds().getSize(new THREE.Vector3()).length();
      const E = e * EXPLODE_MM * (size > 0 && size < 120 ? Math.max(0.3, size / 120) : 1);
      for (const b of model.bodies) {
        const rec = bodies.current.get(b.key);
        if (!rec) continue;
        rec.offset.set(0, 0, 0);
        const mate = model.assembly.mates.find((m) => m.linkId === b.via);
        if (mate && E) {
          const keyOf = (end: MateEdge["a"]) => end.path.join("/") + (end.frame.artifact ? `#${end.frame.artifact}` : "");
          const parentEnd = keyOf(mate.b) === b.key ? mate.a : mate.b;
          const parent = bodies.current.get(keyOf(parentEnd));
          const n = new THREE.Vector3(...parentEnd.frame.normal).transformDirection(parent?.base ?? rec.base);
          // parts on a shaft (props, pulleys) travel further so they clear what drives them
          const onShaft = [mate.a.iface, mate.b.iface].some((i) => i.protocols?.some((p) => p.type === "shaft"));
          const k = onShaft ? 1.6 : 1;
          rec.offset.copy(parent?.offset ?? new THREE.Vector3()).addScaledVector(n, E * k);
        }
        rec.obj.matrix.copy(new THREE.Matrix4().makeTranslation(rec.offset).multiply(rec.base));
        rec.obj.matrixWorldNeedsUpdate = true;
        // a lid clears what sits inside the shell: twice the step of a mated module
        for (const part of rec.parts) part.obj.position.copy(part.base).addScaledVector(part.dir, E * 2.2);
      }
      for (const hw of hardware.current) {
        const S = bodies.current.get(hw.structure)?.offset ?? new THREE.Vector3();
        const M = bodies.current.get(hw.mounted)?.offset ?? new THREE.Vector3();
        const off = new THREE.Vector3();
        if (hw.atMm < 0 && hw.direction === 1) off.copy(S).addScaledVector(hw.normal, -E * 0.9); // screws from behind: pulled out behind
        else if (hw.direction === -1 && hw.atMm > 0) off.copy(M).addScaledVector(hw.normal, -E * 0.9); // from the far side: pulled out beyond
        else if (hw.direction === -1) off.copy(S).addScaledVector(hw.normal, E * 0.9); // nuts behind the structure
        else off.copy(S).lerp(M, 0.5); // spacers, standoffs: between
        hw.offset.copy(off);
        hw.obj.matrix.copy(new THREE.Matrix4().makeTranslation(off).multiply(hw.base));
        hw.obj.matrixWorldNeedsUpdate = true;
      }
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
    const names = instanceNames(system, lookup);
    const nameOf = (path: string) => names.get(path) ?? path;
    // a name shared by several instances (four "Motor"s) is qualified by the parent's name
    const sameName = (path: string) => [...names.entries()].filter(([p, n]) => n === nameOf(path) && p !== path && model.bodies.some((b) => b.key === p)).length > 0;
    const rootKey = model.bodies.find((b) => !b.via && !b.hint)?.key;
    if (labelKinds.has("module")) {
      for (const b of model.bodies) {
        const h = hintsL.modules?.[b.key];
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
        const h = hintsL.harnesses?.[harness];
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
        const h = hintsL.harnesses?.[hp.key];
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
    layer.margins = { top: present ? 60 : 60, bottom: 64, left: 56, right: present ? 16 : 380 };
  }, [model, labelKinds, showLabels, loaded, showHardware, showWires, present, findings, showFindings]);

  // ---- section plane and x-ray (PB-823) ---------------------------------------
  /** Bounds of the assembled model (CAD coordinates of the root), from the loaded bodies. */
  const assembledBounds = () => {
    const box = new THREE.Box3();
    for (const rec of bodies.current.values()) if (!rec.box.isEmpty()) box.union(rec.box.clone().applyMatrix4(rec.base));
    return box;
  };
  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    const grid = h.scene.children.find((o) => o instanceof THREE.GridHelper);
    const box = assembledBounds();
    if (!section || box.isEmpty()) {
      h.renderer.clippingPlanes = [];
      if (grid) grid.visible = !present;
      return;
    }
    const lo = box.min.getComponent(section.axis);
    const hi = box.max.getComponent(section.axis);
    const at = lo + (hi - lo) * section.at;
    const flip = section.flip ?? h.camera.position.getComponent(section.axis) < h.controls.target.getComponent(section.axis);
    const n = new THREE.Vector3();
    n.setComponent(section.axis, flip ? 1 : -1);
    // three.js keeps what lies on the normal's side: n·p + c ≥ 0
    h.renderer.clippingPlanes = [new THREE.Plane(n, flip ? -at : at)];
    if (grid) grid.visible = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, loaded, model]);
  useEffect(() => {
    // a body whose bounds hold another body's centre is a shell (an enclosure): x-ray makes it see-through
    const recs = [...bodies.current.values()].filter((r) => !r.box.isEmpty());
    const world = new Map(recs.map((r) => [r, r.box.clone().applyMatrix4(r.base)]));
    for (const r of recs) {
      const shell = recs.some((o) => o !== r && world.get(r)!.containsPoint(world.get(o)!.getCenter(new THREE.Vector3())));
      for (const m of r.materials) {
        const base = (m.userData.base ??= { transparent: m.transparent, opacity: m.opacity, depthWrite: m.depthWrite }) as { transparent: boolean; opacity: number; depthWrite: boolean };
        const see = xray && shell;
        m.transparent = see || base.transparent;
        m.opacity = see ? 0.22 : base.opacity;
        m.depthWrite = see ? false : base.depthWrite;
        m.needsUpdate = true;
      }
    }
  }, [xray, loaded, model]);

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
        if (m && "emissive" in m) m.emissive.setHex(key === sel.body ? 0x2a1200 : 0x000000);
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
        if (frame) addInBody(targetKey, frameGizmo(frame));
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
      if (row) drawInterface(selBody, row, COLORS.focus);
    }
    if (mate) {
      for (const end of [mate.a, mate.b]) {
        const key = end.path.join("/") + (end.frame.artifact ? `#${end.frame.artifact}` : "");
        if (selBody && key.split("#")[0] === selBody.key.split("#")[0] && end.iface.id === sel.iface) continue;
        const b = model.bodies.find((x) => x.path.join("/") === end.path.join("/") && (x.key === key || !end.frame.artifact));
        const row = b && rowFor(b.def, end.iface.id);
        if (b && row) drawInterface(b, row, sel.iface ? COLORS.counterpart : COLORS.focus);
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
              mesh.material = focusMaterial(COLORS.focus);
            }
          });
          restore.push(() => {
            for (const [mesh, m] of mats) mesh.material = m;
          });
        }
      }
    }
    if (selBody && sel.component) {
      // a component inside the body (a board's part): its node glows
      objOf(selBody.key)?.traverse((o) => {
        if (o.name !== sel.component) return;
        o.traverse((x) => {
          const mesh = x as THREE.Mesh;
          if (!mesh.isMesh) return;
          const was = mesh.material;
          mesh.material = focusMaterial(COLORS.focus);
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
        m.emissive.setHex(0x3a1600);
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
          addInBody(targetKey, frameGizmo(f, 9));
        }
      }
    }
    setNotes([...new Set(newNotes)]);
    return () => restore.forEach((f) => f());
  }, [model, sel, direction, showFrames, loaded]);

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
        const component = hit.object.userData.component as string | undefined;
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
  const orbit = (azimuthDeg: number, elevationDeg: number, distance: number, target = new THREE.Vector3(0, 0, 18)) => {
    const h = handle.current;
    if (!h) return;
    const az = (azimuthDeg * Math.PI) / 180;
    const el = (elevationDeg * Math.PI) / 180;
    h.controls.target.copy(target);
    h.camera.position.set(target.x + distance * Math.cos(el) * Math.cos(az), target.y + distance * Math.cos(el) * Math.sin(az), target.z + distance * Math.sin(el));
    h.camera.lookAt(target);
  };
  const focus = () => {
    const h = handle.current;
    const rec = sel.body ? bodies.current.get(sel.body) : undefined;
    if (!h || !rec) return;
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
    if (!params.get("focus")) orbit(Number(params.get("az") ?? -58), Number(params.get("el") ?? 28), Number(params.get("dist") ?? 520));
    // Deterministic control for video capture: scripts/capture-cad-video.mjs
    (window as unknown as Record<string, unknown>).__cad = {
      ready: () => loaded,
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
        if (s.azimuth !== undefined) orbit(s.azimuth, s.elevation ?? 28, s.distance ?? 520, s.target ? new THREE.Vector3(...s.target) : undefined);
        h.renderOnce();
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyExplode, loaded]);
  // a small assembly (a board, a pod) is framed once it has loaded, unless the URL sets the camera
  const framed = useRef(false);
  useEffect(() => {
    const h = handle.current;
    if (!h || !model || framed.current || params.get("dist") || params.get("focus")) return;
    if (loaded < model.bodies.filter((b) => b.glb).length) return;
    const box = assembledBounds();
    if (box.isEmpty() || box.getSize(new THREE.Vector3()).length() > 200) return;
    framed.current = true;
    orbit(Number(params.get("az") ?? -58), Number(params.get("el") ?? 32), 1, box.getCenter(new THREE.Vector3()));
    h.frameAll(box);
    // back off a little: the inspector covers the right of the view
    h.camera.position.lerp(h.controls.target, -0.7);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, model]);
  useEffect(() => {
    if (params.get("focus") === "1" && loaded >= (model?.bodies.filter((b) => b.glb).length ?? 1)) focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, model]);

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
          <div className="cad-toolbar">
            <div className="segmented">
              <button className={!exploded ? "on" : ""} onClick={() => setExploded(false)} title="Every module where its links put it">
                <Icon name="box" size={16} /> Assembled
              </button>
              <button className={exploded ? "on" : ""} onClick={() => setExploded(true)} title="Separate each module along the mate that placed it">
                <Icon name="layers" size={16} /> Exploded
              </button>
            </div>
            <span className="sep" />
            <div className="cad-menu-wrap">
              <button className={`chip-toggle${showLabels ? " on" : ""}`} onClick={() => setShowLabels(!showLabels)} title="Callout labels">
                <Icon name="tag" size={16} /> Labels
              </button>
              <button className="chip-toggle caret" onClick={() => setLabelMenu(!labelMenu)} title="Label types">
                <Icon name="chevron-up" size={14} />
              </button>
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
              <button className={`chip-toggle${showHardware ? " on" : ""}`} onClick={() => setShowHardware(!showHardware)} title="Mounting hardware from the harnesses' fastener stacks">
                <Icon name="wrench" size={16} /> Hardware
              </button>
            )}
            {(model?.assembly.harnesses.length ?? 0) > 0 && (
              <button className={`chip-toggle${showWires ? " on" : ""}`} onClick={() => setShowWires(!showWires)} title="Routed wire harnesses (each harness's own CAD artifact)">
                <Icon name="cable" size={16} /> Cables
              </button>
            )}
            <button className={`chip-toggle${showFrames ? " on" : ""}`} onClick={() => setShowFrames(!showFrames)} title="Every interface frame">
              <Icon name="move-3d" size={16} /> Frames
            </button>
            <span className="sep" />
            <div className="cad-menu-wrap">
              <button
                className={`chip-toggle icon${section ? " on" : ""}`}
                onClick={() => setSection(section ? null : { axis: 1, at: 0.5 })}
                title="Cut the model with a plane (cut faces are left open)"
              >
                <Icon name="scissors" size={16} />
              </button>
              <button className="chip-toggle caret" onClick={() => setSectionMenu(!sectionMenu)} title="Section plane">
                <Icon name="chevron-up" size={14} />
              </button>
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
                      title="Keep the other side"
                    >
                      FLIP
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
            <button className={`chip-toggle icon${xray ? " on" : ""}`} onClick={() => setXray(!xray)} title="X-ray: see through bodies that hold others (an enclosure)">
              <Icon name="scan-eye" size={16} />
            </button>
            {findings.length > 0 && (
              <button className={`chip-toggle${showFindings ? " on" : ""}`} onClick={() => setShowFindings(!showFindings)} title="Findings: errors and warnings pinned where they are on the model">
                <Icon name="triangle-alert" size={16} /> {findings.length}
              </button>
            )}
            <span className="sep" />
            <div className="segmented">
              {DIRECTIONS.map((d) => (
                <button key={d.id} title={d.hint} className={d.id === direction ? "on" : ""} onClick={() => setDirection(d.id)}>
                  {d.label.split(" ")[0]}
                </button>
              ))}
            </div>
            <span className="sep" />
            <button className="chip-toggle icon" onClick={() => handle.current?.frameAll()} title="Fit">
              <Icon name="maximize" size={16} />
            </button>
            <button className="chip-toggle icon" disabled={!sel.body} onClick={focus} title="Look along the selected interface's normal">
              <Icon name="crosshair" size={16} />
            </button>
          </div>
        )}
        {!model && <div className="cad-loading">Loading manifests…</div>}
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
      {model && !present && <CadInspector model={model} sel={sel} onSel={setSel} direction={direction} findings={findings} resolve={resolve} />}
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
      <div className="inspector-body">
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
                {model.within.size} components are drawn in their board's own body ({[...new Set(model.within.values())].map((k) => k || model.bodies.find((b) => b.key === k)?.def.name).join(", ")}), not placed one by one.
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
      </div>
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
              <a key={a.id} className="artifact-file" href={a.url ?? (a.filePath ? resolve(body.def.id, a.filePath) : undefined)} target="_blank" rel="noreferrer">
                <Icon name="printer" size={11} />
                <span className="artifact-name">{(a.filePath ?? a.name).split("/").pop()}</span>
                <span className="artifact-format">{(a.format ?? "").toUpperCase()}</span>
              </a>
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
