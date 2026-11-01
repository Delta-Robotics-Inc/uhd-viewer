/**
 * `window.__cad.observe()` (PB-1175): what the 3D view shows, as data, for
 * agents and tests. Bounds are world (assembly) coordinates in mm, Z up, as
 * drawn now (exploded or not).
 */
import * as THREE from "three";
import { instancePathIn, isPlaceholder } from "./ids";
import { shown } from "./pick";
import { sectionsByCamera, type SectionsReport } from "../sections";

/**
 * DEFAULT (W4-D, wave 3 carry-forward): section polylines one observation carries in all, against the bridge's
 * 2 MB reply cap (each part is already capped at MAX_POINTS_PER_PART). Past it the rest of the parts keep their
 * counts and lengths and lose their points (`pointsTruncated` says how many points were left out).
 */
export const MAX_SECTION_POINTS_TOTAL = 40_000;

/** The sections report with at most `max` polyline points in all, in plane then part order. */
export function capSections(report: SectionsReport | undefined, max = MAX_SECTION_POINTS_TOTAL): (SectionsReport & { pointsTruncated?: number }) | undefined {
  if (!report?.cuts) return report;
  let left = max;
  let dropped = 0;
  const cuts = report.cuts.map((cut) => ({
    ...cut,
    parts: cut.parts.map((part) => {
      const lines = (part as { polylines?: unknown[][] }).polylines;
      if (!Array.isArray(lines)) return part;
      const n = lines.reduce((sum, l) => sum + (Array.isArray(l) ? l.length : 0), 0);
      if (n <= left) {
        left -= n;
        return part;
      }
      dropped += n;
      return { ...part, polylines: [] };
    }),
  }));
  return dropped ? { ...report, cuts, pointsTruncated: dropped } : report;
}

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
  /**
   * The view state's version (PB-1178): rises with every committed write (camera, selection, explode, ...).
   * Model loads and hot swaps do not raise it; to wait for a redraw, watch `counts.frames` (`frame`).
   */
  seq: number;
  nodes: ObservedNode[];
  selection: Record<string, string | undefined>;
  camera: { position: [number, number, number]; target: [number, number, number]; up: [number, number, number]; fov: number; distance: number };
  counts: { draws: number; triangles: number; frames: number; instances?: number; batches?: number; materials?: number };
  loading: LoadState;
  /**
   * Section planes in force (PB-1186): planes (world mm), scope, the live caps' last pass, and once the view has
   * been quiet for a moment the exact cut per plane: per part, polylines in world mm (absent: no section).
   */
  sections?: SectionsReport;
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
  /** The scene's sections report; absent: the one the scene registered for `camera` (scene.ts). */
  sections?: SectionsReport;
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
  const sections = capSections(input.sections ?? sectionsByCamera.get(c)?.());
  return {
    seq: input.seq,
    nodes,
    selection: Object.fromEntries(Object.entries(input.selection).filter(([, v]) => v !== undefined)),
    camera: { position: v3(c.position), target: v3(input.target), up: v3(c.up), fov: c.fov, distance: round(c.position.distanceTo(input.target)) },
    counts: input.counts,
    loading: { ...input.loading },
    ...(sections ? { sections } : {}),
  };
}
