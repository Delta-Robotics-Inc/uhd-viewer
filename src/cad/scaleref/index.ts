/**
 * Scale references (R4-B, 2026-11-02): a banana (DEFAULT), a cube or a Benchy beside the model, at true size.
 *
 * Kevin: "The banana must stay its actual size and reference, so the user understands the actual size of the project.
 * The banana should be placed outside of the reference frame of the actual 3D model ... For an exploded view or an
 * unassembled view, the bounding box should grow, and thus the banana should move as well."
 *
 * One group in the scene (a logical root of its own, not under the model's root): so it is never in a fit (fits read
 * the model's bodies), an explode (the player moves bodies), a pick, a hover, a selection or a finding (those pick the
 * model's root and harnesses), and it is in a capture only while shown (a capture draws the scene). Its meshes are
 * drawn as themselves (`noBatch`). It stands on the floor just outside the visible assembly's box (./place.ts) and
 * eases to a new place when explode or isolation grows or shrinks the box (DEFAULT 0.15 s time constant).
 *
 * Units: scene mm throughout; the GLB assets' metres are converted at load (./assets.ts).
 */
import * as THREE from "three";
import { formatLength, type Units } from "../grid/levels";
import { loadAsset } from "./assets";
import { cubeEdgeFor, makeCube, type CubeColors } from "./cube";
import { DEFAULT_SCALE_KIND, SCALE_KIND_INFO, type ScaleKind } from "./kinds";
import { cameraLeft, floorExtent, placeBeside, sideToward, standHeight, type Footprint, type Placement, type Side } from "./place";

export * from "./kinds";
export { cubeEdgeFor, CUBE_EDGES, type CubeColors } from "./cube";
export { placeBeside, sideToward, cameraLeft, floorExtent, standHeight, GAP_SHARE, GAP_MIN_MM, type Footprint, type Placement, type Side } from "./place";

/** What the references need of the 3D view (CadView's scene handle has all of it). */
export interface ScaleRefHost {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: { target: THREE.Vector3 };
  beforeRender: Set<(dt: number) => boolean | void>;
  invalidate: (what?: "view" | "pose" | "scene") => void;
  /** The floor grid: the references stand on its floor and share its units. */
  grid?: { readonly floor: number; units: Units };
  /** While on, frames are drawn only by a capture's `renderOnce`: a move then jumps to its place (no easing frames). */
  manual?: { on: boolean };
}

export interface ScaleRefOptions {
  /** The view's container (positioned): the cube's edge label is placed in it. */
  container?: HTMLElement | null;
  /** The visible assembly's bounds now (mm), read each drawn frame while a reference is shown. */
  bounds?: () => THREE.Box3;
  kind?: ScaleKind;
  units?: Units;
  shown?: boolean;
}

export interface ScaleRefStatus {
  kind: ScaleKind;
  shown: boolean;
  /** Shown and drawn (loaded, not suppressed, with a box to stand beside). */
  drawn: boolean;
  loading: boolean;
  error?: string;
  units: Units;
  side?: Side;
  /** The cube's edge (mm) and its words ("10 mm"). */
  edgeMm?: number;
  edgeLabel?: string;
  /** The reference's own size (mm) and where it stands now / is going. */
  footprint?: Footprint;
  box?: THREE.Box3;
  target?: THREE.Box3;
  /** The visible assembly's box it was placed against. */
  bounds?: THREE.Box3;
}

export interface ScaleReference {
  readonly object: THREE.Group;
  kind: ScaleKind;
  shown: boolean;
  units: Units;
  /** Hidden for a while without forgetting `shown` (a section cut, as the floor grid). */
  suppressed: boolean;
  /** The visible assembly's box changed (mm); with a `bounds` option this is read by itself. */
  setBounds(box: THREE.Box3): void;
  /** Choose the side again (the camera's left now). */
  reseat(): void;
  /** Theme colours: the cube's face and lines (CSS colours). */
  setColors(c: Partial<CubeColors>): void;
  status(): ScaleRefStatus;
  onChange(cb: (s: ScaleRefStatus) => void): () => void;
  dispose(): void;
}

/** DEFAULT (R4-B): the easing time constant of a move (s), and how close counts as arrived (mm). */
export const EASE_TAU_S = 0.15;
export const ARRIVED_MM = 0.01;
/** DEFAULT (R4-B): the banana's and the Benchy's colours (a ripe banana; a Benchy in its usual orange PLA). */
export const ASSET_COLORS: Readonly<Record<"banana" | "benchy", number>> = Object.freeze({ banana: 0xf0cf4a, benchy: 0xe8713a });
/** DEFAULT (R4-B): the cube's colours until the theme's are set (the dark scene's model tone and ink). */
export const DEFAULT_CUBE_COLORS: CubeColors = { face: "#3a3a3a", minor: "#6a6a6a", major: "#d4d4d4" };

export function createScaleReference(host: ScaleRefHost, options: ScaleRefOptions = {}): ScaleReference {
  const group = new THREE.Group();
  group.name = "scale-reference";
  group.userData.scaleReference = true;
  group.visible = false;
  host.scene.add(group);

  let kind: ScaleKind = options.kind ?? DEFAULT_SCALE_KIND;
  let shown = options.shown ?? false;
  let units: Units = options.units ?? host.grid?.units ?? "mm";
  // the floor grid follows the same units (one setting, `viewer.units`)
  if (host.grid) host.grid.units = units;
  let suppressed = false;
  let side: Side | undefined;
  let error: string | undefined;
  const bounds = new THREE.Box3();
  let boundsKey = "";

  const meshes = new Map<"banana" | "benchy", THREE.Mesh>();
  const loading = new Set<"banana" | "benchy">();
  let cubeColors: CubeColors = { ...DEFAULT_CUBE_COLORS };
  const cube = makeCube(cubeColors);
  cube.mesh.visible = false;
  group.add(cube.mesh);
  let edgeMm: number | undefined;

  /** The current reference's mesh, when there is one to draw. */
  const current = (): THREE.Mesh | undefined => (kind === "cube" ? cube.mesh : meshes.get(kind));
  const footprintOf = (m: THREE.Mesh | undefined): Footprint | undefined => {
    if (!m) return undefined;
    if (m === cube.mesh) return edgeMm ? { length: edgeMm, width: edgeMm, height: edgeMm } : undefined;
    const b = m.geometry.boundingBox;
    if (!b) return undefined;
    return { length: b.max.x - b.min.x, width: b.max.y - b.min.y, height: b.max.z - b.min.z };
  };

  // where it stands now and where it is going
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  let goal: Placement | undefined;
  let placed = false;

  const subs = new Set<(s: ScaleRefStatus) => void>();
  const status = (): ScaleRefStatus => {
    const m = current();
    const fp = footprintOf(m);
    const box = fp && placed ? new THREE.Box3(new THREE.Vector3(-fp.length / 2, -fp.width / 2, 0), new THREE.Vector3(fp.length / 2, fp.width / 2, fp.height)).applyMatrix4(new THREE.Matrix4().compose(pos, quat, new THREE.Vector3(1, 1, 1))) : undefined;
    return {
      kind,
      shown,
      drawn: group.visible && !!m?.visible,
      loading: kind !== "cube" && loading.has(kind),
      ...(error ? { error } : {}),
      units,
      ...(side ? { side } : {}),
      ...(kind === "cube" && edgeMm ? { edgeMm, edgeLabel: formatLength(edgeMm, units) } : {}),
      ...(fp ? { footprint: fp } : {}),
      ...(box ? { box } : {}),
      ...(goal ? { target: goal.box.clone() } : {}),
      ...(!bounds.isEmpty() ? { bounds: bounds.clone() } : {}),
    };
  };
  const changed = () => {
    if (!subs.size) return;
    const s = status();
    for (const cb of subs) {
      try {
        cb(s);
      } catch (e) {
        console.warn("[cad] scale reference subscriber failed:", e);
      }
    }
  };

  // ---- the cube's edge label: plain DOM over the canvas, at the middle of the top edge nearest the camera ----
  let label: HTMLDivElement | undefined;
  if (options.container && typeof document !== "undefined") {
    label = document.createElement("div");
    label.className = "cad-scale-edge";
    label.dataset.chrome = "scale-edge";
    Object.assign(label.style, {
      position: "absolute",
      left: "0",
      top: "0",
      zIndex: "4",
      padding: "0 5px",
      borderRadius: "3px",
      font: "600 11px/16px var(--uhd-font-mono, ui-monospace, monospace)",
      color: "var(--uhd-dim-text, var(--uhd-text, #e5e5e5))",
      background: "var(--uhd-dim-chip, rgba(20,20,20,0.85))",
      border: "1px solid var(--uhd-dim-chip-border, transparent)",
      pointerEvents: "none",
      whiteSpace: "nowrap",
      display: "none",
      willChange: "transform",
    } satisfies Partial<CSSStyleDeclaration>);
    options.container.appendChild(label);
  }
  const corner = new THREE.Vector3();
  const best = new THREE.Vector3();
  const placeLabel = () => {
    if (!label) return;
    const el = options.container;
    if (kind !== "cube" || !edgeMm || !group.visible || !el) {
      label.style.display = "none";
      return;
    }
    // the four top edges' middles (local), in the world; the one nearest the camera, a little above it
    const e = edgeMm;
    let bestD = Infinity;
    for (const [x, y] of [[0, -0.5], [0, 0.5], [-0.5, 0], [0.5, 0]] as const) {
      corner.set(x * e, y * e, e).applyQuaternion(quat).add(pos);
      const d = corner.distanceToSquared(host.camera.position);
      if (d < bestD) {
        bestD = d;
        best.copy(corner);
      }
    }
    best.project(host.camera);
    if (best.z > 1 || best.z < -1) {
      label.style.display = "none";
      return;
    }
    const w = el.clientWidth;
    const h = el.clientHeight;
    const text = formatLength(e, units);
    if (label.textContent !== text) label.textContent = text;
    label.style.display = "block";
    label.style.transform = `translate(${Math.round(((best.x + 1) / 2) * w)}px, ${Math.round(((1 - best.y) / 2) * h)}px) translate(-50%, -130%)`;
  };

  const applyVisibility = () => {
    const m = current();
    cube.mesh.visible = kind === "cube";
    for (const [k, mesh] of meshes) mesh.visible = k === kind;
    group.visible = shown && !suppressed && !!m && placed;
    placeLabel();
  };

  const writeTransform = () => {
    group.position.copy(pos);
    group.quaternion.copy(quat);
    group.updateMatrix();
    group.updateMatrixWorld(true);
  };

  /** Work out the goal from the bounds; jump there when nothing was placed yet. */
  const replan = (jump = false) => {
    const m = current();
    if (kind === "cube") {
      const e = bounds.isEmpty() ? undefined : floorExtent(bounds, host.camera.up);
      const size = e ? Math.max(e.u[1] - e.u[0], e.v[1] - e.v[0], e.high - e.low) : 0;
      const next = cubeEdgeFor(size, units);
      if (next !== edgeMm) {
        edgeMm = next;
        cube.set(next, units);
      }
    }
    const fp = footprintOf(m);
    if (!fp || bounds.isEmpty()) {
      goal = undefined;
      applyVisibility();
      return;
    }
    const up = host.camera.up.clone().normalize();
    if (!side) side = sideToward(cameraLeft(host.camera, host.controls.target, up), up);
    goal = placeBeside(bounds, up, fp, side, standHeight(bounds, up, host.grid?.floor));
    if (jump || !placed) {
      pos.copy(goal.position);
      quat.copy(goal.quaternion);
      placed = true;
      writeTransform();
    }
    applyVisibility();
  };

  const readBounds = () => {
    if (!options.bounds) return false;
    const b = options.bounds();
    const key = b.isEmpty() ? "" : `${b.min.toArray().map((v) => v.toFixed(3))}|${b.max.toArray().map((v) => v.toFixed(3))}`;
    if (key === boundsKey) return false;
    boundsKey = key;
    bounds.copy(b);
    return true;
  };

  const tick = (dt: number): boolean => {
    if (!shown || suppressed) return false;
    if (readBounds()) replan();
    if (!goal || !placed) {
      placeLabel();
      return false;
    }
    const d = pos.distanceTo(goal.position);
    const angle = quat.angleTo(goal.quaternion);
    if (d <= ARRIVED_MM && angle < 1e-4) {
      placeLabel();
      return false;
    }
    // a capture draws one frame at a time (the scene's manual mode): the reference is where it belongs in that frame
    const k = host.manual?.on ? 1 : 1 - Math.exp(-Math.max(0, dt) / EASE_TAU_S);
    if (d <= ARRIVED_MM || k >= 1) pos.copy(goal.position);
    else pos.lerp(goal.position, k);
    quat.slerp(goal.quaternion, k);
    writeTransform();
    placeLabel();
    host.invalidate("view");
    const arrived = pos.distanceTo(goal.position) <= ARRIVED_MM && quat.angleTo(goal.quaternion) < 1e-4;
    if (arrived) changed();
    return !arrived;
  };
  host.beforeRender.add(tick);

  const ensureLoaded = () => {
    if (kind === "cube" || meshes.has(kind) || loading.has(kind)) return;
    const k = kind;
    loading.add(k);
    error = undefined;
    loadAsset(k)
      .then((geometry) => {
        const material = new THREE.MeshStandardMaterial({ color: ASSET_COLORS[k], roughness: k === "banana" ? 0.72 : 0.55, metalness: 0, flatShading: k === "benchy" });
        material.name = `scale-${k}`;
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = `scale-${k}`;
        mesh.userData.noBatch = true;
        mesh.raycast = () => undefined;
        mesh.visible = false;
        group.add(mesh);
        meshes.set(k, mesh);
      })
      .catch((e: Error) => {
        error = `${SCALE_KIND_INFO[k].label}: ${e.message}`;
        console.warn("[cad] scale reference failed to load:", e);
      })
      .finally(() => {
        loading.delete(k);
        if (disposed) return;
        replan(true);
        host.invalidate("scene");
        changed();
      });
  };

  let disposed = false;
  const refresh = (jump = false) => {
    if (shown) ensureLoaded();
    readBounds();
    replan(jump);
    host.invalidate("scene");
    changed();
  };
  if (shown) refresh(true);

  return {
    object: group,
    get kind() {
      return kind;
    },
    set kind(k: ScaleKind) {
      if (k === kind) return;
      kind = k;
      // a new reference has a new size: it takes its place at once, on the side chosen now
      side = undefined;
      placed = false;
      refresh(true);
    },
    get shown() {
      return shown;
    },
    set shown(on: boolean) {
      if (on === shown) return;
      shown = on;
      if (on) {
        side = undefined;
        placed = false;
      }
      refresh(true);
    },
    get units() {
      return units;
    },
    set units(u: Units) {
      if (u === units) return;
      units = u;
      if (host.grid) host.grid.units = u;
      edgeMm = undefined;
      refresh(true);
    },
    get suppressed() {
      return suppressed;
    },
    set suppressed(s: boolean) {
      if (s === suppressed) return;
      suppressed = s;
      refresh(true);
    },
    setBounds(box) {
      bounds.copy(box);
      boundsKey = "";
      replan();
      host.invalidate("view");
    },
    reseat() {
      side = undefined;
      replan();
      host.invalidate("view");
    },
    setColors(c) {
      cubeColors = { ...cubeColors, ...c };
      cube.setColors(cubeColors);
      host.invalidate("scene");
    },
    status,
    onChange(cb) {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    dispose() {
      disposed = true;
      host.beforeRender.delete(tick);
      subs.clear();
      label?.remove();
      host.scene.remove(group);
      cube.dispose();
      // the asset geometries are shared (./assets.ts cache); only the materials are this view's
      for (const m of meshes.values()) (m.material as THREE.Material).dispose();
      meshes.clear();
    },
  };
}
