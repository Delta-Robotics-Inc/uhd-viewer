/**
 * From the loaded scene to face patches (PB-1187): which B-rep face a picked
 * triangle belongs to, and that face's triangles in mm.
 *
 * Face ids. The view sidecar (W1-A, `protoboard.view-sidecar/v0`) merges a
 * part's faces and keeps each triangle's source face as the per-vertex
 * feature id `_FEATURE_ID_0` (GLTFLoader: `_feature_id_0`): the ordinal of
 * the source primitive within the part, one primitive per B-rep face in an
 * OCCT export. A plain GLB (hardware, or a body without a sidecar) keeps one
 * mesh per primitive, so there the face id is the mesh's ordinal among the
 * part's meshes, the same numbering. Neither is the face's index in the
 * STEP: the sidecar does not record that mapping (handoff to the view-model
 * owner, phase-1/handoffs.md 2026-11-01 W3-D), so the exact tier matches a
 * face by its signature (centroid, normal, kind, radius, area), see ./exact.ts.
 *
 * Units, the metre-to-mm boundary. GLB vertex data is metres, Y up. CadView
 * wraps every loaded GLB in `cadWrapper` (scene.ts: rotate +90 degrees about
 * X, scale x1000), so a mesh's `matrixWorld` already maps metres Y-up to the
 * view's mm Z-up (UHD). Everything this file returns is mm: world positions
 * through `matrixWorld`, part positions through the inverse of the body's
 * frame (the wrapper's parent), which is the CAD file's own frame (STEP mm).
 */
import * as THREE from "three";
import { FEATURE_ID_ATTRIBUTE, featureIdAt, partInstanceIdOf } from "../render/ids";
import type { FacePatch } from "./fit";
import type { V3 } from "./linalg";

/** GLB metres to view mm (the factor `cadWrapper` applies). */
export const GLB_TO_MM = 1000;

/** The object CadView places a body with: the parent of its `cadWrapper` group (named "cad", scale 1000). */
export function bodyFrameOf(o: THREE.Object3D): THREE.Object3D | undefined {
  for (let x: THREE.Object3D | null = o; x; x = x.parent) {
    if (x.name === "cad" && Math.abs(x.scale.x - GLB_TO_MM) < 1e-6 && x.parent) return x.parent;
  }
  return undefined;
}

/**
 * The node a face id is numbered within. In a view sidecar every part (the owner's remainder, each named
 * feature or body node, each board component) is its own glTF node with its own face numbering, so the
 * scope is the nearest object GLTFLoader made for a glTF node (`userData.gltfNode`, set by ../render/ids.ts
 * `applySidecar` on every load): the mesh itself for a one-primitive node, else its group. Without that
 * mark (a scene built by hand), the nearest node with its own `partInstanceId`, else the GLB's root.
 * Face ids are therefore unique per node, not per body: a `MeasureRef` keeps its mesh for that reason.
 */
export function partNodeOf(mesh: THREE.Object3D): THREE.Object3D {
  const frame = bodyFrameOf(mesh);
  const wrapper = frame?.children.find((c) => c.name === "cad");
  for (let x: THREE.Object3D | null = mesh; x && x !== wrapper; x = x.parent) if (typeof x.userData.gltfNode === "number") return x;
  const own = partInstanceIdOf(mesh, wrapper ?? undefined);
  if (own) return own.node;
  return wrapper?.children[0] ?? wrapper ?? mesh.parent ?? mesh;
}

const meshesUnder = (o: THREE.Object3D): THREE.Mesh[] => {
  const out: THREE.Mesh[] = [];
  o.traverse((x) => {
    const m = x as THREE.Mesh;
    if (m.isMesh && m.geometry?.getAttribute("position")) out.push(m);
  });
  return out;
};

/** Where a face id came from. */
export type FaceIdSource = "feature-id" | "primitive";

/** The face a triangle of `mesh` belongs to. */
export function faceIdOf(mesh: THREE.Mesh, triangle: number): { face: number; source: FaceIdSource } {
  const f = featureIdAt(mesh.geometry, triangle);
  if (f !== undefined) return { face: f, source: "feature-id" };
  const part = partNodeOf(mesh);
  return { face: Math.max(0, meshesUnder(part).filter((m) => !m.geometry.getAttribute(FEATURE_ID_ATTRIBUTE)).indexOf(mesh)), source: "primitive" };
}

/**
 * Position grid of a quantized mesh in world mm (KHR_mesh_quantization: one
 * storage unit times the mesh's world scale); 0 for float positions.
 */
export function quantizationStep(mesh: THREE.Mesh): number {
  const attr = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
  if (!attr?.normalized) return 0;
  const arr = (attr as THREE.BufferAttribute).array;
  const unit = arr instanceof Int16Array ? 1 / 32767 : arr instanceof Uint16Array ? 1 / 65535 : arr instanceof Int8Array ? 1 / 127 : arr instanceof Uint8Array ? 1 / 255 : 0;
  mesh.updateWorldMatrix(true, false);
  const s = new THREE.Vector3().setFromMatrixScale(mesh.matrixWorld);
  return unit * Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z));
}

export interface PatchOptions {
  /** Instance of an InstancedMesh (a GPU-instanced part); default every instance is NOT merged: instance 0. */
  instance?: number;
  /** Maps world mm to the frame wanted (e.g. the inverse of the body frame's matrixWorld for part mm). */
  toFrame?: THREE.Matrix4;
}

export interface MeshFace {
  patch: FacePatch;
  meshes: THREE.Mesh[];
  /** Position grid, mm (the largest of the meshes'). */
  quantization: number;
  source: FaceIdSource;
}

const _a = new THREE.Vector3();
const _n = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _im = new THREE.Matrix4();
const _nm = new THREE.Matrix3();

/** Append the triangles of `mesh` that `keep` accepts, in world mm (then `toFrame`), with corner normals when present. */
function collect(mesh: THREE.Mesh, keep: (tri: number) => boolean, opts: PatchOptions, pos: number[], nor: number[] | undefined): number {
  const g = mesh.geometry;
  const p = g.getAttribute("position") as THREE.BufferAttribute;
  const n = g.getAttribute("normal") as THREE.BufferAttribute | undefined;
  mesh.updateWorldMatrix(true, false);
  _m.copy(mesh.matrixWorld);
  const inst = mesh as THREE.InstancedMesh;
  if (inst.isInstancedMesh) {
    inst.getMatrixAt(opts.instance ?? 0, _im);
    _m.multiply(_im);
  }
  if (opts.toFrame) _m.premultiply(opts.toFrame);
  _nm.getNormalMatrix(_m);
  const idx = g.index;
  const tris = (idx ? idx.count : p.count) / 3;
  let added = 0;
  for (let t = 0; t < tris; t++) {
    if (!keep(t)) continue;
    for (let k = 0; k < 3; k++) {
      const v = idx ? idx.getX(t * 3 + k) : t * 3 + k;
      _a.fromBufferAttribute(p, v).applyMatrix4(_m);
      pos.push(_a.x, _a.y, _a.z);
      if (nor && n) {
        _n.fromBufferAttribute(n, v).applyMatrix3(_nm).normalize();
        nor.push(_n.x, _n.y, _n.z);
      }
    }
    added++;
  }
  return added;
}

/**
 * The triangles of face `face` of the part that `mesh` belongs to (every
 * mesh of that part: a multi-material part is several meshes sharing one
 * numbering), in world mm unless `toFrame` says otherwise.
 */
export function meshFace(mesh: THREE.Mesh, face: number, opts: PatchOptions = {}): MeshFace {
  const part = partNodeOf(mesh);
  const all = meshesUnder(part);
  const plain = all.filter((m) => !m.geometry.getAttribute(FEATURE_ID_ATTRIBUTE));
  const pos: number[] = [];
  const nor: number[] = [];
  const used: THREE.Mesh[] = [];
  let source: FaceIdSource = "feature-id";
  const withNormals = all.every((m) => m.geometry.getAttribute("normal"));
  for (const m of all) {
    if (m.geometry.getAttribute(FEATURE_ID_ATTRIBUTE)) {
      if (collect(m, (t) => featureIdAt(m.geometry, t) === face, opts, pos, withNormals ? nor : undefined)) used.push(m);
    }
  }
  if (!used.length && plain[face]) {
    source = "primitive";
    collect(plain[face], () => true, opts, pos, withNormals ? nor : undefined);
    used.push(plain[face]);
  }
  return {
    patch: { positions: Float64Array.from(pos), ...(withNormals && nor.length === pos.length ? { normals: Float64Array.from(nor) } : {}) },
    meshes: used,
    quantization: used.reduce((q, m) => Math.max(q, quantizationStep(m)), 0),
    source,
  };
}

/** Every triangle under `obj` (a body, a part node), in world mm unless `toFrame` says otherwise. Hidden meshes are skipped. */
export function objectPatch(obj: THREE.Object3D, opts: PatchOptions = {}): MeshFace {
  const pos: number[] = [];
  const nor: number[] = [];
  const used: THREE.Mesh[] = [];
  const all = meshesUnder(obj);
  const withNormals = all.every((m) => m.geometry.getAttribute("normal"));
  for (const m of all) {
    let shown = true;
    for (let x: THREE.Object3D | null = m; x && x !== obj.parent; x = x.parent) if (!x.visible) shown = false;
    if (!shown) continue;
    const inst = m as THREE.InstancedMesh;
    const count = inst.isInstancedMesh ? inst.count : 1;
    for (let i = 0; i < count; i++) collect(m, () => true, { ...opts, instance: i }, pos, withNormals ? nor : undefined);
    used.push(m);
  }
  return { patch: { positions: Float64Array.from(pos), ...(withNormals && nor.length === pos.length ? { normals: Float64Array.from(nor) } : {}) }, meshes: used, quantization: used.reduce((q, m) => Math.max(q, quantizationStep(m)), 0), source: "primitive" };
}

/** World mm to the body's own frame (its CAD file's frame, mm, Z up). */
export function toPartFrame(mesh: THREE.Object3D): THREE.Matrix4 | undefined {
  const frame = bodyFrameOf(mesh);
  if (!frame) return undefined;
  frame.updateWorldMatrix(true, false);
  return frame.matrixWorld.clone().invert();
}

/** A three matrix as UHD's row-major Mat4 (16 numbers, mm). */
export function toMat4(m: THREE.Matrix4): number[] {
  const e = m.elements; // column-major
  return [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14], e[3], e[7], e[11], e[15]];
}

export const v3of = (v: THREE.Vector3): V3 => [v.x, v.y, v.z];
