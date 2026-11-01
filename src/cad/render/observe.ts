/**
 * `window.__cad.observe()` (PB-1175): what the 3D view shows, as data, for
 * agents and tests. Bounds are world (assembly) coordinates in mm, Z up, as
 * drawn now (exploded or not).
 */
import * as THREE from "three";
import { instancePathIn, isPlaceholder } from "./ids";
import { shown } from "./pick";

export interface ObservedNode {
  /** Selection key: a body's key (instance path, `#artifact` for a second body of one module), a component's or a harness's instance path. */
  id: string;
  instancePath: string;
  kind: "body" | "component" | "harness";
  /** [[min x, y, z], [max x, y, z]] in mm, or null when nothing is drawn for it. */
  bounds: [[number, number, number], [number, number, number]] | null;
  visible: boolean;
  /** A stand-in (no model, or a GLB node marked `extras.protoboard.placeholder`). */
  placeholder: boolean;
}

export interface CadObservation {
  /** Changes whenever what is drawn changes (frames are drawn only on change). */
  seq: number;
  nodes: ObservedNode[];
  selection: Record<string, string | undefined>;
  camera: { position: [number, number, number]; target: [number, number, number]; up: [number, number, number]; fov: number; distance: number };
  counts: { draws: number; triangles: number; frames: number; instances?: number; batches?: number; materials?: number };
  loading: LoadState;
}

export interface LoadState {
  phase: "loading" | "ready";
  /** Models asked for, arrived, failed. */
  total: number;
  done: number;
  failed: number;
  bytes: number;
  /** Bodies replaced (content changed) and kept (unchanged) by the last hot swap. */
  swapped: number;
  kept: number;
  started: number;
  ms: number;
}

const v3 = (v: THREE.Vector3): [number, number, number] => [round(v.x), round(v.y), round(v.z)];
const round = (n: number) => Math.round(n * 1000) / 1000;

function boundsOf(o: THREE.Object3D): ObservedNode["bounds"] {
  const box = new THREE.Box3().setFromObject(o);
  return box.isEmpty() ? null : [v3(box.min), v3(box.max)];
}

export interface ObserveInput {
  seq: number;
  bodies: Iterable<{ key: string; obj: THREE.Object3D; hasModel: boolean }>;
  harnesses: Iterable<[string, THREE.Object3D]>;
  selection: Record<string, string | undefined>;
  camera: THREE.PerspectiveCamera;
  target: THREE.Vector3;
  counts: CadObservation["counts"];
  loading: LoadState;
  /** Include the parts drawn inside bodies (a board's components) that the GLB names by instance path. Default true. */
  components?: boolean;
}

export function observeScene(input: ObserveInput): CadObservation {
  const nodes: ObservedNode[] = [];
  for (const { key, obj, hasModel } of input.bodies) {
    obj.updateMatrixWorld(true);
    const path = key.split("#")[0];
    const meshes: THREE.Object3D[] = [];
    obj.traverse((o) => (o as THREE.Mesh).isMesh && meshes.push(o));
    nodes.push({
      id: key,
      instancePath: path,
      kind: "body",
      bounds: boundsOf(obj),
      visible: shown(obj) && meshes.some((m) => shown(m)),
      placeholder: !hasModel || (meshes.length > 0 && meshes.every((m) => isPlaceholder(m, obj.parent ?? undefined))),
    });
    if (input.components === false) continue;
    const seen = new Set<string>();
    obj.traverse((o) => {
      const id = (o.userData.protoboard as { partInstanceId?: unknown } | undefined)?.partInstanceId;
      if (typeof id !== "string" || !id || o === obj) return;
      const full = instancePathIn(path, id);
      if (full === path || seen.has(full)) return;
      seen.add(full);
      nodes.push({ id: full, instancePath: full, kind: "component", bounds: boundsOf(o), visible: shown(o), placeholder: isPlaceholder(o, obj) });
    });
  }
  for (const [key, obj] of input.harnesses) {
    obj.updateMatrixWorld(true);
    nodes.push({ id: key, instancePath: key, kind: "harness", bounds: boundsOf(obj), visible: shown(obj), placeholder: false });
  }
  const c = input.camera;
  return {
    seq: input.seq,
    nodes,
    selection: Object.fromEntries(Object.entries(input.selection).filter(([, v]) => v !== undefined)),
    camera: { position: v3(c.position), target: v3(input.target), up: v3(c.up), fov: c.fov, distance: round(c.position.distanceTo(input.target)) },
    counts: input.counts,
    loading: { ...input.loading },
  };
}
