/**
 * Ids in a loaded model (PB-1175): every node of an exported GLB carries
 * `extras.protoboard.partInstanceId` (the UHD instance path; GLTFLoader puts
 * glTF extras in `userData`), placeholder boxes carry
 * `extras.protoboard.placeholder: true`, merged meshes carry a per-vertex
 * feature id (`_FEATURE_ID_0`, which GLTFLoader names `_feature_id_0`), and
 * the view sidecar adds a face-range table per node. These helpers turn a hit
 * (an object and a triangle) into an instance path and a face id.
 */
import type * as THREE from "three";
import { faceAt, type FaceRange, type ViewSidecar, type ViewSidecarFeature } from "./sidecar";

/** GLTFLoader's name for `_FEATURE_ID_0`. */
export const FEATURE_ID_ATTRIBUTE = "_feature_id_0";

interface ProtoboardExtras {
  partInstanceId?: unknown;
  placeholder?: unknown;
}

const extrasOf = (o: THREE.Object3D): ProtoboardExtras | undefined => {
  const p = (o.userData as { protoboard?: unknown }).protoboard;
  return p && typeof p === "object" ? (p as ProtoboardExtras) : undefined;
};

/** The nearest `partInstanceId` at or above `obj`, stopping at `stop` (a body's group), with the node that carries it. */
export function partInstanceIdOf(obj: THREE.Object3D, stop?: THREE.Object3D): { id: string; node: THREE.Object3D } | undefined {
  for (let o: THREE.Object3D | null = obj; o && o !== stop; o = o.parent) {
    const id = extrasOf(o)?.partInstanceId;
    if (typeof id === "string" && id) return { id, node: o };
  }
  return undefined;
}

/** Whether `obj` or a node above it (up to `stop`) is marked as a placeholder. */
export function isPlaceholder(obj: THREE.Object3D, stop?: THREE.Object3D): boolean {
  for (let o: THREE.Object3D | null = obj; o && o !== stop; o = o.parent) if (extrasOf(o)?.placeholder === true) return true;
  return false;
}

/**
 * The instance path of a part drawn inside the body at `holder` (the body's
 * own instance path; "" for the root). A GLB names its parts by instance path
 * relative to the module it draws, or from the root when the exporter knew it:
 * a name that already starts with the holder is kept as it is.
 */
export function instancePathIn(holder: string, id: string): string {
  if (!holder || id === holder || id.startsWith(`${holder}/`)) return id;
  return `${holder}/${id}`;
}

/** The vertex a triangle starts at (indexed or not). */
function firstVertex(geometry: THREE.BufferGeometry, triangle: number): number {
  const index = geometry.index;
  return index ? index.getX(triangle * 3) : triangle * 3;
}

/** The feature id of a triangle of a merged mesh, if the mesh has `_FEATURE_ID_0`. */
export function featureIdAt(geometry: THREE.BufferGeometry, triangle: number): number | undefined {
  const attr = geometry.getAttribute(FEATURE_ID_ATTRIBUTE) as THREE.BufferAttribute | undefined;
  if (!attr) return undefined;
  const v = firstVertex(geometry, triangle);
  if (v < 0 || v >= attr.count) return undefined;
  return Math.round(attr.getX(v));
}

/**
 * Face tables of loaded sidecars, by key (`<hash>#<node>#<primitive>`). They
 * live here, not in `userData`, because a scene clone deep-copies `userData`
 * and a board's tables run to tens of thousands of ranges.
 */
const faceTables = new Map<string, FaceRange[]>();
const featureTables = new Map<string, Map<number, ViewSidecarFeature>>();

export function registerFaceTable(key: string, ranges: FaceRange[]): void {
  faceTables.set(key, ranges);
}
export function registerFeatures(hash: string, features: Map<number, ViewSidecarFeature>): void {
  if (features.size) featureTables.set(hash, features);
}

/** What a hit on a mesh names, from the node's extras, the sidecar's face table and the feature id attribute. */
export interface HitIds {
  /** The part's instance path as the GLB names it (see `instancePathIn`). */
  partInstanceId?: string;
  /** The B-rep face the triangle came from. */
  face?: number;
  /** The merged mesh's feature id. */
  feature?: number;
  placeholder?: boolean;
}

export function idsAt(mesh: THREE.Object3D, triangle: number | undefined, stop?: THREE.Object3D, instance?: number): HitIds {
  const out: HitIds = {};
  const part = partInstanceIdOf(mesh, stop);
  if (part) out.partInstanceId = part.id;
  // a GPU-instanced node names each instance: extras.protoboard.instances[i] (W1-A v0), or the sidecar's list
  if (instance !== undefined) {
    for (let o: THREE.Object3D | null = mesh; o && o !== stop; o = o.parent) {
      const list = ((o.userData.protoboard as { instances?: unknown } | undefined)?.instances ?? o.userData.protoboardInstances) as unknown;
      if (Array.isArray(list)) {
        if (typeof list[instance] === "string" && list[instance]) out.partInstanceId = list[instance];
        break;
      }
    }
  }
  if (isPlaceholder(mesh, stop)) out.placeholder = true;
  const geometry = (mesh as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
  if (triangle === undefined || !geometry) return out;
  const feature = featureIdAt(geometry, triangle);
  const hash = (mesh.userData as { protoboardHash?: string }).protoboardHash;
  if (feature !== undefined) {
    out.feature = feature;
    const named = hash ? featureTables.get(hash)?.get(feature) : undefined;
    if (named?.instancePath) out.partInstanceId = named.instancePath;
    // v0 numbers features within each part: the feature is the part's B-rep face
    out.face = named?.face ?? feature;
  }
  const faceKey = (mesh.userData as { protoboardFaces?: string }).protoboardFaces;
  const face = faceKey ? faceAt(faceTables.get(faceKey), triangle) : undefined;
  if (face !== undefined) out.face = face;
  return out;
}

/**
 * Put the sidecar's index onto a freshly parsed scene (before it is cloned):
 * node extras where the GLB lacks them, the hash, and face-table keys on each
 * primitive's mesh. `nodeIndex` is GLTFLoader's association of objects to glTF
 * node indices.
 */
export function applySidecar(root: THREE.Object3D, hash: string, sidecar: ViewSidecar | undefined, nodeIndex: (o: THREE.Object3D) => number | undefined): void {
  const byIndex = new Map<number, ViewSidecar["nodes"][number]>();
  const byName = new Map<string, ViewSidecar["nodes"][number]>();
  for (const n of sidecar?.nodes ?? []) {
    if (n.node !== undefined) byIndex.set(n.node, n);
    else if (n.name) byName.set(n.name, n);
  }
  if (sidecar) registerFeatures(hash, sidecar.features);
  root.traverse((o) => {
    o.userData.protoboardHash = hash;
    const idx = nodeIndex(o);
    if (idx !== undefined) o.userData.gltfNode = idx;
    const entry = (idx !== undefined ? byIndex.get(idx) : undefined) ?? (o.name ? byName.get(o.name) : undefined);
    if (!entry) return;
    const pb = { ...((o.userData.protoboard as object | undefined) ?? {}) } as Record<string, unknown>;
    if (entry.instancePath && typeof pb.partInstanceId !== "string") pb.partInstanceId = entry.instancePath;
    if (entry.placeholder) pb.placeholder = true;
    o.userData.protoboard = pb;
    if (entry.instances) o.userData.protoboardInstances = entry.instances;
    if (!entry.faces?.length) return;
    // a node with one primitive is the mesh itself; with several, a group whose children are the primitives in order
    const prims = (o as THREE.Mesh).isMesh ? [o] : o.children.filter((c) => (c as THREE.Mesh).isMesh);
    entry.faces.forEach((ranges, i) => {
      const prim = prims[i];
      if (!prim || !ranges.length) return;
      const key = `${hash}#${idx ?? o.name}#${i}`;
      registerFaceTable(key, ranges);
      prim.userData.protoboardFaces = key;
    });
  });
}
