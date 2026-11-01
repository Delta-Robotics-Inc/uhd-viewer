/**
 * Section planes (PB-1186) from the view state's `sections` (W3-A's schema, `src/cad/state`): each is an axis of
 * the assembly (0 x, 1 y, 2 z), a position as a fraction of the assembled bounds along it, and the side it keeps.
 * World units are the assembly's: mm, Z up (the GLBs' metres are scaled to mm by `cadWrapper` before anything
 * here sees them).
 */
import * as THREE from "three";
import type { SectionPlane } from "../state";

/** A plane of the view state, optionally applied to one subtree only (`scope`: an instance path; DEFAULT none = the whole model). */
export type ScopedSectionPlane = SectionPlane & { scope?: string };

/** At most this many planes at once (the view state's own limit). */
export const MAX_SECTIONS = 3;

export interface ResolvedPlane {
  /** three.js keeps what lies on the normal's side: n·p + c ≥ 0. World, mm. */
  plane: THREE.Plane;
  /** Where along the axis (mm). */
  at: number;
  /** True: the + side is kept. */
  flip: boolean;
  axis: 0 | 1 | 2;
  scope?: string;
}

/**
 * The plane for a section over `box` (the assembled bounds, mm). With no side set, it keeps the side away from the
 * camera along the axis (so the cut face looks at the camera), as the 3D view always has.
 */
export function resolvePlane(s: ScopedSectionPlane, box: THREE.Box3, camera?: { position: THREE.Vector3; target: THREE.Vector3 }): ResolvedPlane | undefined {
  if (box.isEmpty()) return undefined;
  const lo = box.min.getComponent(s.axis);
  const hi = box.max.getComponent(s.axis);
  const at = lo + (hi - lo) * Math.min(1, Math.max(0, s.at));
  const flip = s.flip ?? (camera ? camera.position.getComponent(s.axis) < camera.target.getComponent(s.axis) : true);
  const n = new THREE.Vector3();
  n.setComponent(s.axis, flip ? 1 : -1);
  return { plane: new THREE.Plane(n, flip ? -at : at), at, flip, axis: s.axis, ...(s.scope ? { scope: s.scope } : {}) };
}

export function resolvePlanes(list: readonly ScopedSectionPlane[], box: THREE.Box3, camera?: { position: THREE.Vector3; target: THREE.Vector3 }): ResolvedPlane[] {
  return list.slice(0, MAX_SECTIONS).flatMap((s) => resolvePlane(s, box, camera) ?? []);
}

/** The next plane the toolbar's "Add plane" adds: an axis not cut yet (z, then x, then y), through the middle. */
export function nextPlane(list: readonly ScopedSectionPlane[]): ScopedSectionPlane | undefined {
  if (list.length >= MAX_SECTIONS) return undefined;
  const used = new Set(list.map((s) => s.axis));
  const axis = ([2, 0, 1] as const).find((a) => !used.has(a)) ?? 2;
  return { axis, at: 0.5 };
}

/** The kept side flipped, as an explicit side (an automatic side becomes the other one). */
export function flipped(s: ScopedSectionPlane, auto: boolean): ScopedSectionPlane {
  return { ...s, flip: !(s.flip ?? auto) };
}
