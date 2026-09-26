/**
 * 3D view (PB-775): the quadcopter assembled from UHD links, with interface
 * geometry resolved through three binding directions.
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
  param,
  type BindingStatus,
  type CadBody,
  type CadModel,
  type Direction,
  type InterfaceRow,
} from "./model";
import {
  COLORS,
  cadWrapper,
  createScene,
  focusMaterial,
  frameGizmo,
  loadGlb,
  materialFor,
  proceduralGeometry,
  toMatrix4,
  type SceneHandle,
} from "./scene";

const params = new URLSearchParams(window.location.search);

/** Battery: strapped, so no link can place it; the frame's pad is a placement hint. */
const HINTS = [
  {
    path: ["battery"],
    // rotate the pack's long side (its Y) onto the frame's X, sit it on the top plate
    matrix: [0, -1, 0, BATTERY_PAD.origin[0] + 0, 1, 0, 0, BATTERY_PAD.origin[1], 0, 0, 1, BATTERY_PAD.origin[2], 0, 0, 0, 1],
    note: "placed by the frame's battery-pad hint: the pack is strapped, it has no mechanical interface",
  },
];

export interface CadSelection {
  body?: string;
  iface?: string;
  mate?: string;
}

export function CadView({ system, lookup }: { system: ModuleDef; lookup: ModuleLookup }) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<SceneHandle | null>(null);
  const bodyObjects = useRef(new Map<string, THREE.Group>());
  const [manifests, setManifests] = useState<Map<string, GeometryManifest> | null>(null);
  const [loaded, setLoaded] = useState(0);
  const [direction, setDirection] = useState<Direction>((params.get("dir") as Direction) ?? "feature");
  const [explode, setExplode] = useState(Number(params.get("explode") ?? 0));
  const [showFrames, setShowFrames] = useState(params.get("frames") === "1");
  const [showWires, setShowWires] = useState(params.get("wires") !== "0");
  const [showHardware, setShowHardware] = useState(params.get("hardware") !== "0");
  const [sel, setSel] = useState<CadSelection>({
    body: params.get("body") ?? undefined,
    iface: params.get("iface") ?? undefined,
    mate: params.get("mate") ?? undefined,
  });
  const [notes, setNotes] = useState<string[]>([]);

  // manifests (feature signatures) for every module in the system
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

  const model: CadModel | null = useMemo(
    () => (manifests ? buildCadModel(system, lookup, manifests, HINTS) : null),
    [system, lookup, manifests],
  );

  // ---- scene lifecycle -----------------------------------------------------
  useEffect(() => {
    if (!host.current) return;
    const h = createScene(host.current);
    handle.current = h;
    (window as unknown as { __cad: SceneHandle }).__cad = h;
    return () => {
      h.dispose();
      handle.current = null;
    };
  }, []);

  // ---- bodies --------------------------------------------------------------
  useEffect(() => {
    const h = handle.current;
    if (!h || !model) return;
    h.root.clear();
    bodyObjects.current.clear();
    let cancelled = false;
    let count = 0;
    for (const body of model.bodies) {
      const obj = new THREE.Group();
      obj.matrixAutoUpdate = false;
      obj.userData.key = body.key;
      obj.matrix.copy(toMatrix4(body.matrix));
      h.root.add(obj);
      bodyObjects.current.set(body.key, obj);
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
            if ((o as THREE.Mesh).isMesh) {
              const mesh = o as THREE.Mesh;
              if (!vendor) mesh.material = materialFor(body.def, part.name);
              else mesh.material = (mesh.material as THREE.Material).clone();
              mesh.userData.bodyKey = body.key;
            }
          });
        }
        const w = cadWrapper(scene);
        w.name = "cad";
        obj.add(w);
        if (body.hint) {
          w.traverse((o) => {
            const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
            if (m) {
              m.transparent = true;
              m.opacity = 0.35;
            }
          });
        }
        count++;
        setLoaded(count);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [model]);

  // ---- explode: move each body along the normal of the mate that placed it --
  useEffect(() => {
    if (!model) return;
    const offsets = new Map<string, THREE.Vector3>();
    for (const b of model.bodies) {
      const obj = bodyObjects.current.get(b.key);
      if (!obj) continue;
      let off = new THREE.Vector3();
      const mate = model.assembly.mates.find((m) => m.linkId === b.via);
      if (mate && explode) {
        const [parent, frame] =
          mate.b.path.join("/") + (mate.b.frame.artifact ? `#${mate.b.frame.artifact}` : "") === b.key ? [mate.a, mate.a.frame] : [mate.b, mate.b.frame];
        const parentKey = parent.path.join("/") + (frame.artifact ? `#${frame.artifact}` : "");
        const parentBody = model.bodies.find((x) => x.key === parentKey);
        const n = new THREE.Vector3(...frame.normal).transformDirection(toMatrix4(parentBody?.matrix ?? b.matrix));
        off = (offsets.get(parentKey) ?? new THREE.Vector3()).clone().add(n.multiplyScalar(explode));
      }
      offsets.set(b.key, off);
      obj.matrix.copy(new THREE.Matrix4().makeTranslation(off).multiply(toMatrix4(b.matrix)));
      obj.matrixWorldNeedsUpdate = true;
    }
  }, [model, explode, loaded]);

  // ---- overlays: selection, interface geometry, frames, wires, hardware ----
  useEffect(() => {
    const h = handle.current;
    if (!h || !model) return;
    h.overlay.clear();
    const restore: (() => void)[] = [];
    const newNotes: string[] = [];

    // module highlight
    for (const [key, obj] of bodyObjects.current) {
      obj.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (m && "emissive" in m) m.emissive.setHex(key === sel.body ? 0x2a1200 : 0x000000);
      });
    }

    const addInBody = (key: string, obj: THREE.Object3D) => {
      const body = bodyObjects.current.get(key);
      if (!body) return;
      obj.userData.overlay = true;
      body.add(obj);
      restore.push(() => body.remove(obj));
    };

    /** Draw an interface's geometry for the current direction, in its body's coordinates. */
    const drawInterface = (body: CadBody, row: InterfaceRow, color: number) => {
      const bodyObj = bodyObjects.current.get(body.key);
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
            const obj = bodyObjects.current.get(artifactKey) ?? bodyObj;
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
              if (!gltf) {
                newNotes.push(`${src}: ${art.filePath} not found`);
                return;
              }
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

    // selected interface, and its mated counterpart
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
    }

    // all frames
    if (showFrames) {
      for (const b of model.bodies) {
        for (const i of b.def.interfaces) {
          const f = i.geometry?.frame;
          if (!f) continue;
          const targetKey = f.artifact ? `${b.path.join("/")}#${f.artifact}` : b.key;
          if (f.artifact && targetKey !== b.key && !bodyObjects.current.has(targetKey)) continue;
          if (!f.artifact && b.key.includes("#")) continue;
          addInBody(targetKey, frameGizmo(f, 9));
        }
      }
    }

    // world position of a frame on a body (explode included)
    const world = (key: string, p: [number, number, number]) => {
      const obj = bodyObjects.current.get(key);
      return obj ? new THREE.Vector3(...p).applyMatrix4(obj.matrix) : new THREE.Vector3(...p);
    };
    const worldDir = (key: string, d: [number, number, number]) => {
      const obj = bodyObjects.current.get(key);
      return obj ? new THREE.Vector3(...d).transformDirection(obj.matrix) : new THREE.Vector3(...d);
    };

    // wires: electrical links with geometry on both ends
    if (showWires) {
      for (const r of model.assembly.routes) {
        const aKey = r.a.path.join("/");
        const bKey = r.b.path.join("/");
        const highlighted = sel.mate === r.linkId || sel.body === aKey || sel.body === bKey;
        r.b.frames.forEach((bf, k) => {
          const af = r.a.frames[Math.min(k, r.a.frames.length - 1)].frame;
          const spread: [number, number, number] =
            r.a.frames.length === 1 ? [af.origin[0], af.origin[1] - Math.sign(af.origin[1]) * (k - 1) * 3.2, af.origin[2]] : af.origin;
          const p0 = world(aKey, spread);
          const p3 = world(bKey, bf.frame.origin);
          const n0 = worldDir(aKey, af.normal);
          const n3 = worldDir(bKey, bf.frame.normal);
          const p1 = p0.clone().add(n0.multiplyScalar(6));
          const p2 = p3.clone().add(n3.multiplyScalar(10));
          const mid = p1.clone().lerp(p2, 0.5).add(new THREE.Vector3(0, 0, -3));
          const curve = new THREE.CatmullRomCurve3([p0, p1, mid, p2, p3]);
          const tube = new THREE.Mesh(
            new THREE.TubeGeometry(curve, 48, highlighted ? 0.9 : 0.7, 8),
            new THREE.MeshStandardMaterial({ color: COLORS.phase[k % 3], roughness: 0.6, emissive: highlighted ? COLORS.phase[k % 3] : 0, emissiveIntensity: 0.35 }),
          );
          tube.userData.link = r.linkId;
          h.overlay.add(tube);
        });
      }
    }

    // stack hardware: the harness's fasteners at the frame's stack pattern
    if (showHardware) {
      const frameBody = bodyFor("frame");
      const stack = frameBody?.def.interfaces.find((i) => i.id === "stack_mount");
      const esc = bodyFor("stack/esc");
      const fc = bodyFor("stack/fc");
      const screw = lookup("iso-4762-m3x30-socket-head-cap-screw");
      const spacer = lookup("ettinger-005-83-060-m3-nylon-spacer-6mm");
      const nut = lookup("iso-10511-m3-nyloc-nut");
      if (stack?.geometry?.frame && esc && fc && screw && spacer && nut) {
        const s = (param(stack, "hole_spacing") ?? 30.5) / 2;
        const zPlateTop = stack.geometry.frame.origin[2];
        // stack-up from the assembled (not exploded) placements
        const zEsc = esc.matrix[11];
        const zFc = fc.matrix[11];
        const pcb = 1.6;
        const glbOf = (d: ModuleDef) => d.artifacts?.find((a) => a.role === "body" && a.format === "glb")?.filePath;
        const place = (d: ModuleDef, x: number, y: number, z: number, color?: number) => {
          const file = glbOf(d);
          if (!file) return;
          loadGlb(file).then((gltf) => {
            if (!gltf) return;
            const obj = gltf.scene.clone(true);
            obj.traverse((o) => {
              if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = color ? focusMaterial(color) : materialFor(d, "");
              if (o.name === "thread" || o.name === "bore") o.visible = false;
            });
            const w = cadWrapper(obj);
            w.position.set(x, y, z);
            h.overlay.add(w);
          });
        };
        const hl = sel.body === "stack_hardware" ? COLORS.focus : undefined;
        for (const [x, y] of [
          [-s, -s],
          [-s, s],
          [s, -s],
          [s, s],
        ]) {
          place(screw, x, y, 0, hl);
          place(spacer, x, y, zPlateTop, hl);
          place(spacer, x, y, zEsc + pcb, hl);
          place(nut, x, y, zFc + pcb, hl);
        }
        const screwLen = param(screw.interfaces[0], "length") ?? 30;
        const needed = zFc + pcb + 4;
        newNotes.push(
          needed <= screwLen
            ? `stack hardware: M3×${screwLen} reaches the nut (stack-up ${needed.toFixed(1)} mm, ${(screwLen - needed).toFixed(1)} mm proud)`
            : `stack hardware: M3×${screwLen} is ${(needed - screwLen).toFixed(1)} mm short of the nut`,
        );
      }
    }

    setNotes([...new Set(newNotes)]);
    return () => restore.forEach((f) => f());
  }, [model, sel, direction, showFrames, showWires, showHardware, explode, loaded, lookup]);

  // ---- focus: look at the selected module's interface from the side its normal faces
  const focus = () => {
    const h = handle.current;
    const obj = sel.body ? bodyObjects.current.get(sel.body) : undefined;
    const body = model?.bodies.find((b) => b.key === sel.body);
    if (!h || !obj || !body) return;
    const f = body.def.interfaces.find((i) => i.id === sel.iface)?.geometry?.frame;
    const target = f ? new THREE.Vector3(...f.origin).applyMatrix4(obj.matrix) : new THREE.Box3().setFromObject(obj).getCenter(new THREE.Vector3());
    const n = f ? new THREE.Vector3(...f.normal).transformDirection(obj.matrix) : new THREE.Vector3(0.6, -0.8, 0.6);
    // oblique: mostly along the normal, tilted sideways so the part stays readable
    const dir = n.clone().multiplyScalar(0.75).add(new THREE.Vector3(0.55, -0.75, 0).normalize().multiplyScalar(0.66)).normalize();
    h.controls.target.copy(target);
    h.camera.position.copy(target.clone().add(dir.multiplyScalar(160)));
  };
  useEffect(() => {
    if (params.get("focus") === "1" && loaded >= (model?.bodies.filter((b) => b.glb).length ?? 1)) focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, model]);

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
      const hit = ray.intersectObjects([h.root, h.overlay], true).find((x) => x.object.visible && (x.object.userData.bodyKey || x.object.userData.link));
      if (!hit) setSel({});
      else if (hit.object.userData.link) setSel({ mate: hit.object.userData.link });
      else setSel({ body: hit.object.userData.bodyKey });
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
    };
  }, []);

  return (
    <div className="cad-view">
      <div className="cad-canvas" ref={host}>
        <div className="cad-toolbar">
          <div className="segmented">
            {DIRECTIONS.map((d) => (
              <button key={d.id} title={d.hint} className={d.id === direction ? "on" : ""} onClick={() => setDirection(d.id)}>
                {d.label}
              </button>
            ))}
          </div>
          <label className="cad-slider" title="Separate each module along the normal of the mate that placed it">
            EXPLODE
            <input type="range" min={0} max={40} value={explode} onChange={(e) => setExplode(Number(e.target.value))} />
          </label>
          <button className={`chip-toggle${showFrames ? " on" : ""}`} onClick={() => setShowFrames(!showFrames)}>
            FRAMES
          </button>
          <button className={`chip-toggle${showWires ? " on" : ""}`} onClick={() => setShowWires(!showWires)}>
            WIRES
          </button>
          <button className={`chip-toggle${showHardware ? " on" : ""}`} onClick={() => setShowHardware(!showHardware)}>
            HARDWARE
          </button>
          <button className="chip-toggle" onClick={() => handle.current?.frameAll()}>
            FIT
          </button>
          <button className="chip-toggle" disabled={!sel.body} onClick={focus} title="Look at the selected interface along its normal">
            FOCUS
          </button>
        </div>
        {!model && <div className="cad-loading">Loading manifests…</div>}
        {notes.length > 0 && (
          <div className="cad-notes">
            {notes.map((n, i) => (
              <div key={i}>{n}</div>
            ))}
          </div>
        )}
      </div>
      {model && <CadInspector model={model} sel={sel} onSel={setSel} direction={direction} />}
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
