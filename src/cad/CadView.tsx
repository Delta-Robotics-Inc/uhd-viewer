/**
 * 3D view (PB-775): the quadcopter assembled from UHD links, with interface
 * geometry resolved through three binding directions, mounting hardware
 * placed from the harnesses' fastener stacks, wire harnesses simulated as
 * ropes, and callout labels.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { GeometryFrame, ModuleDef } from "@uhd/types/index.js";
import type { ModuleLookup } from "@uhd/system/index.js";
import type { GeometryManifest, MateEdge } from "@uhd/system/geometry.js";
import { BATTERY_PAD } from "@uhd-library/systems/quadcopter-5in/frame.js";
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
import { rope, strands } from "./wires";
import { Icon } from "../canvas/Icon";

const params = new URLSearchParams(window.location.search);

/** Explode distance (mm per mate level) at "exploded". */
const EXPLODE_MM = 26;

/** Battery: strapped, so no link can place it; the frame's pad is a placement hint. */
const HINTS = [
  {
    path: ["battery"],
    matrix: [0, -1, 0, BATTERY_PAD.origin[0], 1, 0, 0, BATTERY_PAD.origin[1], 0, 0, 1, BATTERY_PAD.origin[2], 0, 0, 0, 1],
    note: "placed by the top plate's battery-pad hint: the pack is strapped, it has no mechanical interface",
  },
];

/** Friendly callout names for the quadcopter's instances. */
const ARM_NAMES: Record<string, string> = { fl: "front-left", fr: "front-right", rl: "rear-left", rr: "rear-right" };

export interface CadSelection {
  body?: string;
  iface?: string;
  mate?: string;
}

interface BodyRec {
  body: CadBody;
  obj: THREE.Group;
  base: THREE.Matrix4;
  centre: THREE.Vector3; // local bbox centre (CAD coords)
  top: THREE.Vector3; // local bbox top centre
  offset: THREE.Vector3;
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

export function CadView({ system, lookup }: { system: ModuleDef; lookup: ModuleLookup }) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<SceneHandle | null>(null);
  const labelsRef = useRef<LabelLayer | null>(null);
  const bodies = useRef(new Map<string, BodyRec>());
  const hardware = useRef<HardwareRec[]>([]);
  const wiresGroup = useRef(new THREE.Group());
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
  const present = params.get("present") === "1";
  const [sel, setSel] = useState<CadSelection>({
    body: params.get("body") ?? undefined,
    iface: params.get("iface") ?? undefined,
    mate: params.get("mate") ?? undefined,
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
    loadManifests(allDefs).then(setManifests);
  }, [allDefs]);

  const model: CadModel | null = useMemo(() => (manifests ? buildCadModel(system, lookup, manifests, HINTS) : null), [system, lookup, manifests]);

  // ---- scene lifecycle -----------------------------------------------------
  useEffect(() => {
    if (!host.current) return;
    const h = createScene(host.current);
    handle.current = h;
    h.scene.add(wiresGroup.current);
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
      const rec: BodyRec = { body, obj, base, centre: new THREE.Vector3(), top: new THREE.Vector3(), offset: new THREE.Vector3() };
      bodies.current.set(body.key, rec);
      if (!body.glb?.filePath) continue;
      loadGlb(body.glb.filePath).then((gltf) => {
        if (cancelled || !gltf) return;
        const scene = gltf.scene.clone(true);
        const featureNames = new Set(Object.keys(model.manifests.get(`${body.def.id}:${body.bodyArtifact}`)?.features ?? {}));
        const vendor = body.glb!.id.startsWith("cad_vendor");
        const top = scene.children.length === 1 ? scene.children[0] : scene;
        for (const part of top.children) {
          if (!vendor && featureNames.has(part.name)) {
            part.userData.feature = part.name;
            part.visible = false;
            continue;
          }
          part.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh) return;
            mesh.material = vendor ? (mesh.material as THREE.Material).clone() : materialFor(body.def, part.name);
            mesh.userData.bodyKey = body.key;
          });
        }
        const w = cadWrapper(scene);
        w.name = "cad";
        // local bounds for label anchors (before parenting, so world = CAD coordinates)
        w.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(w);
        obj.add(w);
        rec.centre.copy(box.getCenter(new THREE.Vector3()));
        rec.top.set(rec.centre.x, rec.centre.y, box.max.z);
        bump();
      });
    }
    // battery strap (a module with no mechanical interface): drawn around the hinted battery
    const strapDef = model.assembly.instances.find((i) => i.path.join("/") === "strap")?.def;
    const batt = model.bodies.find((b) => b.key === "battery");
    if (strapDef && batt) {
      const g = new THREE.Group();
      g.matrixAutoUpdate = false;
      g.matrix.copy(toMatrix4(batt.matrix));
      const mat = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.85 });
      const band = (w: number, d: number, hgt: number, x: number, y: number, z: number) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, d, hgt), mat);
        m.position.set(x, y, z);
        m.userData.bodyKey = "strap";
        g.add(m);
      };
      // pack coordinates: 39.5 (x) × 75 (y) × 35 (z); strap 20 mm wide across the pack, under the 2 mm plate
      band(41.5, 20, 1, 0, 0, 35.5);
      band(1, 20, 38, 20.75, 0, 16.5);
      band(1, 20, 38, -20.75, 0, 16.5);
      band(41.5, 20, 1, 0, 0, -2.5);
      const logo = new THREE.Mesh(new THREE.BoxGeometry(12, 20.2, 1.4), new THREE.MeshStandardMaterial({ color: 0xff5c00, roughness: 0.5 }));
      logo.position.set(6, 0, 35.6);
      g.add(logo);
      g.userData.key = "strap";
      h.root.add(g);
      const rec: BodyRec = {
        body: { key: "strap", path: ["strap"], def: strapDef, matrix: batt.matrix, hint: "wrapped around the battery and the top plate" },
        obj: g,
        base: g.matrix.clone(),
        centre: new THREE.Vector3(0, 0, 16),
        top: new THREE.Vector3(0, 0, 36),
        offset: new THREE.Vector3(),
      };
      bodies.current.set("strap", rec);
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
      if (!file) continue;
      loadGlb(file).then((gltf) => {
        if (cancelled || !gltf) return;
        const s = gltf.scene.clone(true);
        s.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh) {
            mesh.material = materialFor(hw.def, "");
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
      const E = e * EXPLODE_MM;
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
          // props travel further so they clear the motors
          const k = b.key.endsWith("/prop") ? 1.6 : 1;
          rec.offset.copy(parent?.offset ?? new THREE.Vector3()).addScaledVector(n, E * k);
        }
        rec.obj.matrix.copy(new THREE.Matrix4().makeTranslation(rec.offset).multiply(rec.base));
        rec.obj.matrixWorldNeedsUpdate = true;
      }
      const strap = bodies.current.get("strap");
      const battRec = bodies.current.get("battery");
      if (strap && battRec) {
        battRec.offset.set(0, 0, E * 2.2);
        battRec.obj.matrix.copy(new THREE.Matrix4().makeTranslation(battRec.offset).multiply(battRec.base));
        strap.offset.set(0, 0, E * 1.2);
        strap.obj.matrix.copy(new THREE.Matrix4().makeTranslation(strap.offset).multiply(strap.base));
        strap.obj.matrixWorldNeedsUpdate = battRec.obj.matrixWorldNeedsUpdate = true;
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
      wiresGroup.current.visible = showWiresRef.current && e < 0.02;
      for (const m of wireMaterials.current) {
        m.opacity = Math.max(0, 1 - e * 30);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);
  const showWiresRef = useRef(showWires);
  showWiresRef.current = showWires;
  const wireMaterials = useRef<THREE.MeshStandardMaterial[]>([]);

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

  // ---- wire harnesses: ropes from ESC pads, tied along the arm, to the motor leads
  useEffect(() => {
    const g = wiresGroup.current;
    g.clear();
    wireMaterials.current = [];
    if (!model || !showWires) return;
    const at = (key: string, p: [number, number, number]) => {
      const rec = bodies.current.get(key);
      return rec ? new THREE.Vector3(...p).applyMatrix4(rec.base) : new THREE.Vector3(...p);
    };
    const R = 0.75; // conductor radius (≈ 18 AWG with insulation)
    const plate = 5;
    const floor = (x: number, y: number) => {
      // bottom plate: body, arms (to each motor) and motor pads
      const inBody = x > -65 && x < 62 && Math.abs(y) < 28;
      let onArm = false;
      for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const mx = sx * 79.55;
        const my = sy * 79.55;
        const t = Math.max(0, Math.min(1, (x * mx + y * my) / (mx * mx + my * my)));
        if (Math.hypot(x - mx * t, y - my * t) < 7 || Math.hypot(x - mx, y - my) < 12) onArm = true;
      }
      return inBody || onArm ? plate + R * 2.2 : -50;
    };
    const colors = [0xd9363e, 0xe5b62a, 0x2f7fd6];
    for (const r of model.assembly.routes) {
      const aKey = r.a.path.join("/");
      const bKey = r.b.path.join("/");
      const pad = r.a.frames[0].frame;
      const padC = at(aKey, pad.origin as [number, number, number]);
      const ends = r.b.frames.map((f) => at(bKey, f.frame.origin as [number, number, number]));
      const endC = ends.reduce((s, v) => s.add(v), new THREE.Vector3()).divideScalar(ends.length);
      const out = new THREE.Vector3(endC.x - padC.x, endC.y - padC.y, 0).normalize();
      const side = new THREE.Vector3(-out.y, out.x, 0);
      const starts = [0, 1, 2].map((k) => padC.clone().addScaledVector(side, (k - 1) * 3.2).setZ(padC.z + 0.3));
      const armDir = new THREE.Vector3(endC.x, endC.y, 0).normalize();
      const armLen = Math.hypot(endC.x, endC.y);
      const tie = (f: number) => armDir.clone().multiplyScalar(armLen * f).setZ(plate + R * 2.2);
      const pins = [padC.clone().setZ(padC.z + 0.8), padC.clone().addScaledVector(out, 9).setZ(padC.z + 1.5), tie(0.5), tie(0.78), endC.clone()];
      const centre = rope(pins, { slack: 0.05, floor, segment: 2 });
      const lines = strands(centre, starts, ends, R * 1.25, 24, 8);
      lines.forEach((pts, k) => {
        const mat = new THREE.MeshStandardMaterial({ color: colors[k % 3], roughness: 0.55, metalness: 0.05, transparent: true });
        wireMaterials.current.push(mat);
        const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), pts.length * 2, R, 10), mat);
        tube.userData.link = r.linkId;
        g.add(tube);
      });
      // zip ties at the tie points
      for (const f of [0.5, 0.78]) {
        const tieMesh = new THREE.Mesh(new THREE.TorusGeometry(R * 2.9, 0.55, 8, 24), new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 }));
        const p = tie(f);
        tieMesh.position.copy(p).setZ(plate + R * 1.8);
        tieMesh.lookAt(p.clone().add(armDir).setZ(plate + R * 1.8));
        tieMesh.scale.set(1, 0.72, 1);
        g.add(tieMesh);
      }
      g.userData[r.linkId] = centre[Math.floor(centre.length * 0.62)];
    }
    applyExplode(explode.current.value);
  }, [model, showWires, loaded, applyExplode]);

  useEffect(() => {
    for (const hw of hardware.current) hw.obj.visible = showHardware;
  }, [showHardware, loaded]);

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
    const name = (key: string) => model.defs.get(key.split("#")[0])?.name ?? key;
    if (labelKinds.has("module")) {
      const add = (key: string, title: string, sub?: string, where: "top" | "centre" = "top") =>
        bodies.current.has(key) && items.push({ id: `m:${key}`, kind: "module", title, sub, anchor: bodyAnchor(key, where), onClick: () => setSel({ body: key }) });
      add("frame", "Frame", "bottom plate · 5 mm, 225 mm wheelbase", "centre");
      add("top_plate", "Top plate", "2 mm, on 30 mm standoffs");
      add("stack/fc", "Flight controller", name("stack/fc"));
      add("stack/esc", "4-in-1 ESC", name("stack/esc"), "centre");
      for (const c of ["fl", "fr", "rl", "rr"]) add(`arm_${c}/motor`, `Motor · ${ARM_NAMES[c]}`, "MEPS NEON 2207 V2 1950KV");
      add("arm_fl/prop", "Propeller", "HQProp Ethix S5 · 5.1 in", "centre");
      add("battery", "Battery", "CNHL 6S 1100 mAh · strapped");
      add("video", "O4 air unit", "DJI O4 transmission module", "centre");
      add("video#cad_camera_step", "O4 camera", "side-plate mount", "centre");
      add("gnss", "GNSS + compass", "Matek M9N-5883 (vendor CAD)");
    }
    if (labelKinds.has("harness") && bodies.current.has("strap"))
      items.push({ id: "h:strap", kind: "harness", title: "Battery strap", sub: "20 × 250 mm Kevlar · through the top plate", anchor: () => bodies.current.get("strap")!.top.clone().applyMatrix4(bodies.current.get("strap")!.obj.matrix), onClick: () => setSel({ body: "battery" }) });
    if (labelKinds.has("harness")) {
      const hwAnchor = (harness: string) => () => {
        const list = hardware.current.filter((h) => h.harness === harness);
        if (!list.length || !showHardware) return null;
        const p = new THREE.Vector3();
        list.forEach((h) => p.add(new THREE.Vector3().setFromMatrixPosition(h.obj.matrix)));
        return p.divideScalar(list.length);
      };
      const hw = (harness: string, title: string) => {
        const list = model.assembly.hardware.filter((h) => h.harness === harness);
        if (!list.length) return;
        // short names from the harness's own child refs ("M2 x 12 screw", "5 mm spacer")
        const hdef = model.assembly.instances.find((i) => i.path.join("/") === harness)?.def;
        const counts = new Map<string, number>();
        for (const h of list) {
          const n = hdef?.children?.find((c) => c.id === h.child)?.name ?? h.def.name;
          counts.set(n, (counts.get(n) ?? 0) + 1);
        }
        const sub = [...counts].map(([n, c]) => `${c}× ${n.replace(/ x /g, "×")}`).join(" · ");
        items.push({ id: `h:${harness}`, kind: "harness", title, sub, anchor: hwAnchor(harness), onClick: () => setSel({ mate: list[0].linkId }) });
      };
      hw("stack_hardware", "Stack hardware");
      hw("frame_hardware", "Frame hardware");
      hw("arm_fr_hardware", "Motor hardware (×4 motors)");
      hw("gps_hardware", "GPS hardware");
      hw("vtx_hardware", "Air unit hardware");
      hw("camera_hardware", "Camera hardware");
      const phase = model.assembly.routes.find((r) => r.linkId === "m4_phases") ?? model.assembly.routes[0];
      if (phase)
        items.push({
          id: "h:phases",
          kind: "harness",
          title: "Motor phase leads (×4)",
          sub: "3 × 150 mm leads, tied to the arm",
          anchor: () => (wiresGroup.current.visible ? (wiresGroup.current.userData[phase.linkId] as THREE.Vector3 | undefined)?.clone() ?? null : null),
          onClick: () => setSel({ mate: phase.linkId }),
        });
    }
    if (labelKinds.has("interface")) {
      for (const m of model.assembly.mates) {
        if (m.linkId.includes("prop_on_shaft") && !m.linkId.startsWith("arm_fl")) continue;
        if (/arm_(fr|rl|rr)_mount/.test(m.linkId)) continue;
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
    layer.setItems(items);
    layer.target = showLabels ? 1 : 0;
    layer.margins = { top: present ? 60 : 60, bottom: 64, left: 56, right: present ? 16 : 380 };
  }, [model, labelKinds, showLabels, loaded, showHardware, showWires, present]);

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
            loadGlb(art.filePath).then((gltf) => {
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
      const hit = ray.intersectObjects([h.root, wiresGroup.current], true).find((x) => x.object.visible && (x.object.userData.bodyKey || x.object.userData.link));
      if (!hit) setSel({});
      else if (hit.object.userData.link) setSel({ mate: hit.object.userData.link });
      else {
        const k = hit.object.userData.bodyKey as string;
        const hwMate = model?.assembly.hardware.find((x) => x.harness === k)?.linkId;
        setSel(hwMate ? { mate: hwMate } : { body: k });
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
      set: (s: { azimuth?: number; elevation?: number; distance?: number; explode?: number; labels?: boolean; caption?: [string, string] }) => {
        h.manual.on = true;
        if (s.caption) setCaption(s.caption);
        if (s.explode !== undefined) {
          explode.current.value = explode.current.target = s.explode;
          const e = s.explode;
          applyExplode(e < 0.5 ? 4 * e ** 3 : 1 - (-2 * e + 2) ** 3 / 2);
        }
        if (s.labels !== undefined && labelsRef.current) labelsRef.current.target = s.labels ? 1 : 0;
        if (s.azimuth !== undefined) orbit(s.azimuth, s.elevation ?? 28, s.distance ?? 520);
        h.renderOnce();
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyExplode, loaded]);
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
            <button className={`chip-toggle${showHardware ? " on" : ""}`} onClick={() => setShowHardware(!showHardware)} title="Mounting hardware from the harnesses' fastener stacks">
              <Icon name="wrench" size={16} /> Hardware
            </button>
            <button className={`chip-toggle${showWires ? " on" : ""}`} onClick={() => setShowWires(!showWires)} title="Wire harnesses">
              <Icon name="cable" size={16} /> Wires
            </button>
            <button className={`chip-toggle${showFrames ? " on" : ""}`} onClick={() => setShowFrames(!showFrames)} title="Every interface frame">
              <Icon name="move-3d" size={16} /> Frames
            </button>
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
      {model && !present && <CadInspector model={model} sel={sel} onSel={setSel} direction={direction} />}
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

function CadInspector({ model, sel, onSel, direction }: { model: CadModel; sel: CadSelection; onSel: (s: CadSelection) => void; direction: Direction }) {
  const body = model.bodies.find((b) => b.key === sel.body);
  const rows = useMemo(() => (body ? interfaceRows(body.def, model.manifests) : []), [body, model]);
  const row = rows.find((r) => r.iface.id === sel.iface);
  const mate = sel.mate ? model.assembly.mates.find((m) => m.linkId === sel.mate) : undefined;
  const route = sel.mate ? model.assembly.routes.find((m) => m.linkId === sel.mate) : undefined;
  const nameOf = (path: string[]) => {
    const def = model.defs.get(path.join("/"));
    return def?.name ?? path.join("/");
  };

  return (
    <aside className="inspector cad-inspector">
      <div className="inspector-header">
        <span className="section-title">{body ? "MODULE" : mate || route ? "LINK" : "ASSEMBLY"}</span>
        {(body || mate || route) && (
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
              {body.path.join(" / ")}
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
                  <span className="cad-row-name">{b.key}</span>
                  <span className="cad-row-via">{b.via ?? (b.hint ? "hint" : "root")}</span>
                </button>
              ))}
            </div>
            <div className="section-title">NOT PLACED</div>
            {model.assembly.issues
              .filter((i) => i.severity === "info" && !model.bodies.some((b) => b.key === i.subject))
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
            <div className="section-title">WIRES · {model.assembly.routes.length} ROUTED</div>
            {model.assembly.routes.map((r) => (
              <button key={r.linkId} className="cad-row" onClick={() => onSel({ mate: r.linkId })}>
                <span className="cad-row-name">{r.linkId}</span>
                <span className="cad-row-via">
                  {r.a.frames.length}→{r.b.frames.length}
                </span>
              </button>
            ))}
            <div className="section-title">UNROUTED · {model.assembly.unrouted.length}</div>
            <div className="cad-issue">
              No geometry on {[...new Set(model.assembly.unrouted.flatMap((u) => u.missing))].slice(0, 8).join(", ")}
              {model.assembly.unrouted.length > 8 ? " …" : ""}
            </div>
          </>
        )}
      </div>
    </aside>
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
