/**
 * Where a scale reference stands (R4-B, 2026-11-02). Pure.
 *
 * Kevin: "The banana should be placed outside of the reference frame of the actual 3D model: there's a bounding box
 * over the entire assembly, and the banana just needs to be outside of that, to prevent collisions. For an exploded
 * view or an unassembled view, the bounding box should grow, and thus the banana should move as well."
 *
 * The reference stands on the floor beside the visible assembly's box, on one of its four sides in the floor plane
 * (DEFAULT: the side toward the camera's left when the reference is turned on, kept while the view turns so it does
 * not jump about), a gap of 10 % of the box's larger floor extent away (DEFAULT, at least 2 mm), its long axis along
 * that side, centred on the box's middle along it. Its footprint starts past the gap, so it never overlaps the box.
 * Units: scene mm.
 */
import * as THREE from "three";
import { floorAxes, lowAlong } from "../grid";

/** A side of the box in the floor plane: along the floor's u or v axis, + or -. */
export type Side = "+u" | "-u" | "+v" | "-v";

/** A reference's own extents (mm): `length` along its local x, `width` along local y, `height` along local z (up). */
export interface Footprint {
  length: number;
  width: number;
  height: number;
}

/** DEFAULT (R4-B): the gap to the box, as a share of its larger floor extent, and the least gap (mm). */
export const GAP_SHARE = 0.1;
export const GAP_MIN_MM = 2;

/** The box's extent along the floor axes and up (mm). */
export function floorExtent(box: THREE.Box3, up: THREE.Vector3): { u: [number, number]; v: [number, number]; low: number; high: number } {
  const { u, v } = floorAxes(up);
  const r = { u: [Infinity, -Infinity] as [number, number], v: [Infinity, -Infinity] as [number, number], low: Infinity, high: -Infinity };
  const p = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    const a = p.dot(u);
    const b = p.dot(v);
    const c = p.dot(up);
    r.u = [Math.min(r.u[0], a), Math.max(r.u[1], a)];
    r.v = [Math.min(r.v[0], b), Math.max(r.v[1], b)];
    r.low = Math.min(r.low, c);
    r.high = Math.max(r.high, c);
  }
  return r;
}

/** The side of the floor nearest a world direction (the camera's left). */
export function sideToward(dir: THREE.Vector3, up: THREE.Vector3): Side {
  const { u, v } = floorAxes(up);
  const a = dir.dot(u);
  const b = dir.dot(v);
  if (Math.abs(a) >= Math.abs(b)) return a >= 0 ? "+u" : "-u";
  return b >= 0 ? "+v" : "-v";
}

/** The camera's left, in the world: up x forward (forward = target - camera). */
export function cameraLeft(camera: { position: THREE.Vector3 }, target: THREE.Vector3, up: THREE.Vector3): THREE.Vector3 {
  const forward = target.clone().sub(camera.position);
  const left = new THREE.Vector3().crossVectors(up, forward);
  return left.lengthSq() > 1e-12 ? left.normalize() : floorAxes(up).u.negate();
}

export interface Placement {
  /** Where the reference's local origin goes (its footprint's centre, at its base), world mm. */
  position: THREE.Vector3;
  /** Its rotation: local x along its side, local z along up. */
  quaternion: THREE.Quaternion;
  /** Its bounds in the world once placed. */
  box: THREE.Box3;
  side: Side;
  gap: number;
}

/**
 * Place a reference of `ref`'s size beside `box` on `side`. `base`: the floor height along up it stands on (DEFAULT:
 * the box's lowest point, where the model stands).
 */
export function placeBeside(box: THREE.Box3, up: THREE.Vector3, ref: Footprint, side: Side, base?: number, gapShare = GAP_SHARE): Placement {
  const n = up.clone().normalize();
  const axes = floorAxes(n);
  const e = floorExtent(box, n);
  const size = Math.max(e.u[1] - e.u[0], e.v[1] - e.v[0], 0);
  const gap = Math.max(GAP_MIN_MM, gapShare * size);
  const onU = side === "+u" || side === "-u";
  const sign = side[0] === "+" ? 1 : -1;
  // the long axis runs along the side: beside a u side it lies along v
  const along = (onU ? axes.v : axes.u).clone();
  const across = new THREE.Vector3().crossVectors(n, along).normalize();
  const half = ref.width / 2;
  const range = onU ? e.u : e.v;
  const mid = onU ? (e.v[0] + e.v[1]) / 2 : (e.u[0] + e.u[1]) / 2;
  const out = sign > 0 ? range[1] + gap + half : range[0] - gap - half;
  const h = base ?? e.low;
  const position = new THREE.Vector3()
    .addScaledVector(onU ? axes.u : axes.v, out)
    .addScaledVector(onU ? axes.v : axes.u, mid)
    .addScaledVector(n, h);
  const quaternion = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(along, across, n));
  const local = new THREE.Box3(new THREE.Vector3(-ref.length / 2, -ref.width / 2, 0), new THREE.Vector3(ref.length / 2, ref.width / 2, ref.height));
  const world = local.applyMatrix4(new THREE.Matrix4().compose(position, quaternion, new THREE.Vector3(1, 1, 1)));
  return { position, quaternion, box: world, side, gap };
}

/** The floor height a reference stands on: the grid's floor plus its half millimetre, else the box's lowest point. */
export function standHeight(box: THREE.Box3, up: THREE.Vector3, gridFloor?: number): number {
  return gridFloor !== undefined && Number.isFinite(gridFloor) ? gridFloor + 0.5 : lowAlong(box, up);
}
