/**
 * From a record's `ref` to what is drawn (PB-1184): the part's objects, its
 * world bounds and its body's frame, looked up every frame that is drawn, so
 * a callout follows its part through explode, a camera move and a hot swap
 * (a swapped body is a new object under the same key).
 *
 * A ref is an instance path from the shown module: a placed body ("battery",
 * "video#cad_camera_step"), a module drawn by its parts ("stack": every body
 * under it), a component drawn inside a body ("pcb/power/rail_5v_ext/u13": a
 * node named by its id in the body, or carrying that instance path in
 * `extras.protoboard.partInstanceId`, or one instance of a GPU-instanced node
 * by `extras.protoboard.instances`), a routed harness, or `link:<id>` (the
 * caller's own resolver).
 */
import * as THREE from "three";

export interface PartHit {
  objects: THREE.Object3D[];
  /** World bounds. */
  box: THREE.Box3;
  /** The body's frame (body CAD mm → world) for a record's `point`. */
  frame: THREE.Matrix4;
  /** The placement key of the body that holds it. */
  body: string;
  /** Not drawn now (hidden, isolated away, or nothing with a size): its records are listed "hidden", not drawn. */
  hidden?: boolean;
}

/** Drawn: visible all the way up. */
export function drawn(o: THREE.Object3D): boolean {
  for (let x: THREE.Object3D | null = o; x; x = x.parent) if (!x.visible) return false;
  return true;
}

const extras = (o: THREE.Object3D) => (o.userData.protoboard ?? {}) as { partInstanceId?: unknown; instances?: unknown };

const _m = new THREE.Matrix4();
const _b = new THREE.Box3();

/** World bounds of one instance of an InstancedMesh. */
function instanceBox(mesh: THREE.InstancedMesh, i: number): THREE.Box3 {
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  mesh.getMatrixAt(i, _m);
  return _b.copy(mesh.geometry.boundingBox!).applyMatrix4(_m).applyMatrix4(mesh.matrixWorld).clone();
}

/**
 * A component drawn inside a body: `rel` is its path relative to the body, `full` from the root.
 * The objects and world box, or undefined when the body draws no such node.
 */
export function componentIn(body: THREE.Object3D, rel: string, full: string): { objects: THREE.Object3D[]; box: THREE.Box3 } | undefined {
  let node: THREE.Object3D | undefined;
  let inst: { mesh: THREE.InstancedMesh; i: number } | undefined;
  body.traverse((o) => {
    if (node || inst) return;
    const id = extras(o).partInstanceId;
    if (o.name === rel || id === rel || id === full) {
      node = o;
      return;
    }
    const list = extras(o).instances;
    if ((o as THREE.InstancedMesh).isInstancedMesh && Array.isArray(list)) {
      const i = list.findIndex((p) => p === rel || p === full);
      if (i >= 0 && i < (o as THREE.InstancedMesh).count) inst = { mesh: o as THREE.InstancedMesh, i };
    }
  });
  if (node) {
    body.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(node);
    return box.isEmpty() ? undefined : { objects: [node], box };
  }
  if (inst) {
    inst.mesh.updateWorldMatrix(true, false);
    return { objects: [inst.mesh], box: instanceBox(inst.mesh, inst.i) };
  }
  return undefined;
}

/** World bounds of objects (each one's whole subtree). */
export function boundsOf(objects: THREE.Object3D[]): THREE.Box3 {
  const box = new THREE.Box3();
  for (const o of objects) {
    o.updateWorldMatrix(true, true);
    box.union(new THREE.Box3().setFromObject(o));
  }
  return box;
}

/**
 * The visible surface of a part toward the camera: the first hit of the ray from the camera to the part's centre,
 * on the part's own meshes (others are ignored: an anchor hidden behind something stays on its part, and the
 * depth-tested dot shows that it is hidden). Falls back to the top centre of its box.
 */
export function surfacePoint(camera: THREE.Camera, part: PartHit, pick: (ray: THREE.Ray, roots: THREE.Object3D[]) => THREE.Vector3 | undefined): THREE.Vector3 {
  const centre = part.box.getCenter(new THREE.Vector3());
  const origin = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
  const dir = centre.clone().sub(origin);
  if (dir.lengthSq() > 1e-12) {
    const hit = pick(new THREE.Ray(origin, dir.normalize()), part.objects);
    if (hit) return hit;
  }
  return new THREE.Vector3(centre.x, centre.y, part.box.max.z);
}

/** A point `px` CSS pixels nearer the camera (so a camera-facing quad at a surface does not cut into it). */
export function towardCamera(p: THREE.Vector3, camera: THREE.PerspectiveCamera, px: number, height: number): THREE.Vector3 {
  const origin = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
  const d = origin.distanceTo(p);
  const perPx = (2 * Math.tan(((camera.fov ?? 50) * Math.PI) / 360) * d) / Math.max(1, height);
  return p.clone().add(origin.sub(p).normalize().multiplyScalar(Math.min(d * 0.5, perPx * px)));
}

/** World units per CSS pixel at distance `d` (perspective camera). */
export const worldPerPx = (camera: THREE.PerspectiveCamera, d: number, height: number) => (2 * Math.tan(((camera.fov ?? 50) * Math.PI) / 360) * d) / Math.max(1, height);
