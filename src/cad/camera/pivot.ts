/**
 * The orbit pivot, made intentional (R4-A, 2026-11-02). Kevin: "if it's a full assembly exploded, then it should
 * orbit around its center. If it's fully assembled, same thing: orbit around its center. If you select an object,
 * that does not change, but if you isolate an object in that assembly, then it should orbit around the object.
 * Just have the origin of the orbit be intentional."
 *
 * The pivot is the orbit target (OrbitControls turns about it). The rule: the centre of the box of what is drawn
 * (the visible assembly, exploded or not; the isolated set when isolated). A selection never moves it. A pan carries
 * it with the view (as Onshape); Fit, an isolation, a change of what is shown, an explode or another level put it
 * back on the rule, eased so the view does not jump. Pure functions.
 */
import * as THREE from "three";
import type { CameraPose } from "./zoom";

/** DEFAULT (R4-A): the pivot eases to its new place over this long (the camera moves with it: a short pan). */
export const PIVOT_EASE_MS = 200;
/** DEFAULT (R4-A): the pivot dot fades this long after an orbit ends. */
export const PIVOT_DOT_FADE_MS = 400;
/** DEFAULT (R4-A): the pivot dot's diameter in CSS px. */
export const PIVOT_DOT_PX = 7;
/** DEFAULT (R4-A): a pivot already this close to the rule (share of the drawn radius) is not moved (no needless pan). */
export const PIVOT_STILL_SHARE = 0.002;

/** The rule's pivot: the centre of the drawn box (undefined when nothing is drawn). */
export function pivotOf(drawn: THREE.Box3): THREE.Vector3 | undefined {
  return drawn.isEmpty() ? undefined : drawn.getCenter(new THREE.Vector3());
}

/** The bounding radius of a box (half its diagonal); 0 when empty. */
export function radiusOf(box: THREE.Box3): number {
  return box.isEmpty() ? 0 : box.getSize(new THREE.Vector3()).length() / 2;
}

/**
 * Where the camera goes when the pivot moves to `pivot` (R4-A): the camera keeps its direction and distance and is
 * carried with the target (a pan), so what was framed stays framed around the new centre. Null when the pivot is
 * already there (within PIVOT_STILL_SHARE of `radius`).
 */
export function movePivot(pose: CameraPose, pivot: THREE.Vector3, radius = 0): CameraPose | null {
  const shift = pivot.clone().sub(pose.target);
  if (shift.length() <= Math.max(1e-6, PIVOT_STILL_SHARE * radius)) return null;
  return { target: pivot.clone(), position: pose.position.clone().add(shift) };
}

/**
 * Whether a view-state change asks for the pivot rule again (R4-A): isolation or the hidden list changed, and the
 * same change did not also place the camera (Back restoring a place, an agent's explicit camera keep theirs).
 */
export function pivotChange(prev: { isolation?: unknown; hidden?: unknown; camera?: unknown }, next: { isolation?: unknown; hidden?: unknown; camera?: unknown }): boolean {
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  if (!same(prev.camera, next.camera)) return false;
  return !same(prev.isolation, next.isolation) || !same(prev.hidden, next.hidden);
}
