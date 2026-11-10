/**
 * Zoom policy (R4-A, 2026-11-02). Kevin: "use the same behavior that Onshape has for the zoom-in feature. How far
 * it actually zooms in is a scale factor of the actual model itself, and it's a hard stop, not a soft stop"; "there
 * should be a min and max zoom (scale with size of model maybe? like 2x max size of model or something)".
 *
 * Each wheel notch scales the camera's distance to the orbit target by one constant factor, the same in and out, at
 * once (no glide). Toward the cursor: the camera and the target are scaled about the point under the cursor, so that
 * point stays where it is on screen and zooming back out with the pointer still returns along the same path. The
 * target is then kept inside the model's box (the pivot never drifts off into space). At either stop the wheel does
 * nothing more: no spring, no creep. Pure functions (scene units: mm).
 */
import * as THREE from "three";

/** DEFAULT (R4-A): the distance changes by this factor per wheel notch, in and out alike (Onshape-like). */
export const ZOOM_STEP = 1.15;
/** DEFAULT (R4-A): the closest the camera comes to its target, as a share of the bounding radius of what is in view. */
export const MIN_DISTANCE_SHARE = 0.02;
/** DEFAULT (R4-A): never closer than this (mm), however small the part. */
export const MIN_DISTANCE_FLOOR_MM = 0.5;
/**
 * DEFAULT (R4-A): the farthest the camera goes is where the visible model's bounding sphere fills this share of the
 * view's height (a fit fills about all of it, so this is about 2x the fit distance: "2x max size of model").
 */
export const MAX_FILL = 0.5;
/** DEFAULT (wave R4 gate): the near stop stays this many times the camera's near plane from the pivot. */
export const NEAR_CLEARANCE = 2;
/** DEFAULT (wave R4 gate): the far stop keeps the model's far side within this share of the camera's far plane. */
export const FAR_SHARE = 0.95;
/** DEFAULT (R4-A): one wheel notch in pixels when the browser reports pixels (Chrome and Edge on Windows: 100). */
export const NOTCH_PX = 100;
/** DEFAULT (R4-A): one wheel notch in lines (Firefox reports 3 lines a notch). */
export const NOTCH_LINES = 3;
/** DEFAULT (R4-A): a wheel event with |deltaY| at least this (pixels) is a mouse notch; smaller ones are a trackpad's. */
export const NOTCH_MIN_PX = 50;
/** DEFAULT (R4-A): the most notches one event may carry (a fast flick of a free-spinning wheel). */
export const MAX_NOTCHES_PER_EVENT = 4;

export interface ZoomLimits {
  /** Closest distance from the camera to the target (mm). */
  min: number;
  /** Farthest distance from the camera to the target (mm). */
  max: number;
}

/**
 * The hard stops (R4-A): `focusRadius` is the bounding radius of what is in view (the isolated part when isolated,
 * else the visible assembly), `assemblyRadius` the visible assembly's. `fovDeg` is the camera's vertical field of
 * view; on a view taller than wide the narrower horizontal one decides.
 */
export function zoomLimits(input: { focusRadius: number; assemblyRadius: number; fovDeg: number; aspect: number; near?: number; far?: number }): ZoomLimits {
  const { focusRadius, assemblyRadius, fovDeg, aspect } = input;
  // wave R4 gate: never inside the camera's near plane (the scene keeps it at 1 mm or more), so a tiny isolated part
  // (an 0402's 0.6 mm radius gave a 0.5 mm stop) is not cut open by the near plane before the stop
  const nearStop = Number.isFinite(input.near) && (input.near as number) > 0 ? NEAR_CLEARANCE * (input.near as number) : 0;
  const min = Math.max(MIN_DISTANCE_FLOOR_MM, nearStop, MIN_DISTANCE_SHARE * (Number.isFinite(focusRadius) && focusRadius > 0 ? focusRadius : 0));
  const v = (fovDeg * Math.PI) / 180;
  const h = 2 * Math.atan(Math.tan(v / 2) * (aspect > 0 ? aspect : 1));
  const fov = Math.min(v, h);
  // the sphere's angular diameter 2 asin(R / d) equals MAX_FILL of the view: d = R / sin(MAX_FILL * fov / 2)
  const r = Number.isFinite(assemblyRadius) && assemblyRadius > 0 ? assemblyRadius : 0;
  let max = r > 0 ? r / Math.sin((MAX_FILL * fov) / 2) : Infinity;
  // wave R4 gate: the far stop keeps the whole sphere inside the far plane (a model over about 0.6 m in radius was
  // partly cut off at the stop by the scene's 5 m far plane)
  if (Number.isFinite(input.far) && (input.far as number) > 0) max = Math.min(max, FAR_SHARE * (input.far as number) - r);
  return { min, max: Math.max(max, min * 4) };
}

/**
 * Wheel notches from wheel events (R4-A). Positive: away from the model (zoom out), as the wheel pulled toward the
 * person (deltaY > 0) has zoomed out here since R1 (DEFAULT kept). A mouse notch counts as one, whatever size the
 * browser and the system's scaling report it as (the first notch seen sets the size); a trackpad's small deltas and
 * a pinch (ctrl + wheel) give fractions of a notch, so the same rule holds continuously.
 */
export class WheelNotches {
  /** The size of one notch in pixels, learned from the first mouse notch (DEFAULT NOTCH_PX until then). */
  private notchPx: number | undefined;

  read(e: { deltaY: number; deltaMode: number; ctrlKey?: boolean }): number {
    const dy = e.deltaY;
    if (!Number.isFinite(dy) || dy === 0) return 0;
    let n: number;
    if (e.deltaMode === 1) n = dy / NOTCH_LINES;
    else if (e.deltaMode === 2) n = dy;
    // a pinch's deltas are small; ctrl held with a mouse wheel gives whole notches (wave R4 gate: it zoomed about
    // 1.75x a notch on the pinch rule), so a delta of a mouse notch's size is read as one
    else if (e.ctrlKey && Math.abs(dy) < NOTCH_MIN_PX) {
      // a trackpad pinch: Chrome and Edge send ctrl + wheel with scale = exp(-deltaY / 100); the distance follows
      // the fingers exactly (DEFAULT), in notches of ZOOM_STEP so the same stops apply
      n = dy / 100 / Math.log(ZOOM_STEP);
    } else if (Math.abs(dy) >= NOTCH_MIN_PX) {
      // a mouse notch: whole notches of the first size seen (a coalesced event carries several)
      this.notchPx ??= Math.abs(dy);
      n = Math.sign(dy) * Math.max(1, Math.round(Math.abs(dy) / this.notchPx));
    } else n = dy / NOTCH_PX; // a trackpad's two-finger scroll: continuous
    return Math.max(-MAX_NOTCHES_PER_EVENT, Math.min(MAX_NOTCHES_PER_EVENT, n));
  }
}

export interface CameraPose {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

/**
 * One zoom step (R4-A): the distance from the camera to the target scaled by `step ** notches`, clamped to the
 * limits, about `anchor` (the point under the cursor; the target for a plain dolly). Null at a stop (nothing moves:
 * a hard stop). A camera already beyond a stop (an isolation shrank the model in view) is not pulled back: only the
 * wheel's own direction is refused. `keepIn`: the target is held inside this box (the pivot never leaves the model).
 */
export function zoomStep(pose: CameraPose, input: { anchor: THREE.Vector3; notches: number; limits: ZoomLimits; step?: number; keepIn?: THREE.Box3 }): (CameraPose & { distance: number; atStop: boolean }) | null {
  const { anchor, notches, limits } = input;
  const step = input.step ?? ZOOM_STEP;
  const d = pose.position.distanceTo(pose.target);
  if (!(d > 0) || !Number.isFinite(notches) || notches === 0) return null;
  const want = d * Math.pow(step, notches);
  let next: number;
  if (notches > 0) {
    next = Math.min(want, limits.max);
    if (next <= d) return null;
  } else {
    next = Math.max(want, limits.min);
    if (next >= d) return null;
  }
  const s = next / d;
  const position = anchor.clone().add(pose.position.clone().sub(anchor).multiplyScalar(s));
  const target = anchor.clone().add(pose.target.clone().sub(anchor).multiplyScalar(s));
  if (input.keepIn && !input.keepIn.isEmpty() && !input.keepIn.containsPoint(target)) {
    const held = input.keepIn.clampPoint(target, new THREE.Vector3());
    position.add(held.clone().sub(target));
    target.copy(held);
  }
  return { position, target, distance: next, atStop: next === limits.min || next === limits.max };
}

/**
 * The zoom anchor when nothing is under the cursor (R4-A): where the cursor's ray crosses the plane through the
 * target facing the camera. The target itself when the ray runs along that plane.
 */
export function planeAnchor(ray: THREE.Ray, pose: CameraPose): THREE.Vector3 {
  const normal = pose.position.clone().sub(pose.target).normalize();
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, pose.target);
  return ray.intersectPlane(plane, new THREE.Vector3()) ?? pose.target.clone();
}

/** Clamp an explicit camera (an agent's, a host's) to the farthest stop along its own view line (R4-A). */
export function clampToMax(pose: CameraPose, max: number): CameraPose {
  const d = pose.position.distanceTo(pose.target);
  if (!(d > max) || !Number.isFinite(max)) return pose;
  const dir = pose.position.clone().sub(pose.target).normalize();
  return { target: pose.target.clone(), position: pose.target.clone().addScaledVector(dir, max) };
}
