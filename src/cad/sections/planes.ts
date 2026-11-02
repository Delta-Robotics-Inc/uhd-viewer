/**
 * Section planes (PB-1186) from the view state's `sections` (W3-A's schema, `src/cad/state`). World units are the
 * assembly's: mm, Z up (the GLBs' metres are scaled to mm by `cadWrapper` before anything here sees them).
 *
 * Two forms of a plane (R2-B, 2026-11-02, Kevin's walkthrough G5):
 * - the legacy axis plane: an axis of the assembly (0 x, 1 y, 2 z), a position as a fraction of the assembled bounds
 *   along it (`at`), and the side it keeps (`flip`);
 * - a placed plane: `normal` and `point` give the base plane (an origin plane of the model's frame, `source:
 *   "origin"`, or the plane of a face the person picked, `source: "face"`, with the face in `face`), and `offset`
 *   moves it along `normal` (mm). `axis` and `at` are kept in step with it (the dominant axis of the normal and the
 *   fraction of the bounds the plane passes through), so readers of the legacy form (the URL, the fit, older hosts)
 *   still see where it is.
 *
 * Kept side: three.js keeps n·p + c ≥ 0. For the placed form `flip` is relative to `normal`: true keeps the side
 * `normal` points to, false the other side; absent, the side away from the camera (as the axis form always did).
 */
import * as THREE from "three";
import type { SectionPlane } from "../state";

type V3 = [number, number, number];

/**
 * What R2-B adds to a section plane (additive; R2-A owns `state/schema.ts`, the checks are handed off in
 * phase-1/handoffs.md). The view state keeps unknown fields of a plane, so these work before the checks land.
 */
export interface PlacedPlaneFields {
  /** Where the plane came from: an origin plane of the model's frame, or a picked face. Absent: the axis form. */
  source?: "origin" | "face";
  /** The base plane's unit normal (world mm, Z up): the axis for an origin plane, the face's outward normal for a face. */
  normal?: V3;
  /** A point on the base plane (world mm). */
  point?: V3;
  /** mm along `normal` from the base plane (DEFAULT 0). */
  offset?: number;
  /** The picked face: the part's instance path, its face id (feature id, or the coplanar set's first triangle) and its body key. */
  face?: { path: string; face?: number; body?: string; planar?: boolean };
}

/** A plane of the view state, optionally applied to one subtree only (`scope`: an instance path; DEFAULT none = the whole model). */
export type ScopedSectionPlane = SectionPlane & { scope?: string } & PlacedPlaneFields;

/** A placed plane sits this far toward the side it removes, so what lies exactly on it is kept (DEFAULT, mm: above the view sidecar's 14-bit position step on a 250 mm part, about 0.015 mm). */
export const COPLANAR_KEEP_MM = 0.1;

/** At most this many planes at once (the view state's own limit). */
export const MAX_SECTIONS = 3;

/** The three origin planes of the model's frame, by the axis they cut across. */
export const ORIGIN_PLANES = [
  { id: "YZ", axis: 0, label: "YZ plane", hint: "cut across X" },
  { id: "ZX", axis: 1, label: "ZX plane", hint: "cut across Y" },
  { id: "XY", axis: 2, label: "XY plane", hint: "cut across Z" },
] as const;

export interface ResolvedPlane {
  /** three.js keeps what lies on the normal's side: n·p + c ≥ 0. World, mm. */
  plane: THREE.Plane;
  /** Where along the axis (mm); for a placed plane, along its dominant axis where it crosses the bounds' centre line. */
  at: number;
  /** True: the + side (of the axis, or of `normal`) is kept. */
  flip: boolean;
  axis: 0 | 1 | 2;
  scope?: string;
  source?: "origin" | "face";
  /** The base plane's normal and point, the offset (placed planes only). */
  normal?: THREE.Vector3;
  point?: THREE.Vector3;
  offset?: number;
}

/** What a placed plane carries for `observe().sections` (R2-B), by the THREE.Plane instance `resolvePlane` made. */
export interface PlaneMeta {
  source: "axis" | "origin" | "face";
  offset?: number;
  face?: PlacedPlaneFields["face"];
}
/** Read by `SceneSections.report()` (./index.ts): the scene keeps the plane instances it was handed. */
export const planeMeta = new WeakMap<THREE.Plane, PlaneMeta>();

const finite3 = (v: unknown): v is V3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x));

/** Whether a plane is the placed form (normal and point). */
export const isPlaced = (s: ScopedSectionPlane): boolean => finite3(s.normal) && finite3(s.point) && Math.hypot(...s.normal) > 1e-9;

/** The axis a normal points along most (0 x, 1 y, 2 z). */
export function dominantAxis(n: { x: number; y: number; z: number }): 0 | 1 | 2 {
  const a = [Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)];
  return a[0] >= a[1] && a[0] >= a[2] ? 0 : a[1] >= a[2] ? 1 : 2;
}

/**
 * The plane for a section over `box` (the assembled bounds, mm). With no side set, it keeps the side away from the
 * camera (so the cut face looks at the camera), as the 3D view always has.
 */
export function resolvePlane(s: ScopedSectionPlane, box: THREE.Box3, camera?: { position: THREE.Vector3; target: THREE.Vector3 }): ResolvedPlane | undefined {
  if (isPlaced(s)) return resolvePlaced(s, box, camera);
  if (box.isEmpty()) return undefined;
  const lo = box.min.getComponent(s.axis);
  const hi = box.max.getComponent(s.axis);
  const at = lo + (hi - lo) * Math.min(1, Math.max(0, s.at));
  const flip = s.flip ?? (camera ? camera.position.getComponent(s.axis) < camera.target.getComponent(s.axis) : true);
  const n = new THREE.Vector3();
  n.setComponent(s.axis, flip ? 1 : -1);
  const plane = new THREE.Plane(n, flip ? -at : at);
  planeMeta.set(plane, { source: "axis" });
  return { plane, at, flip, axis: s.axis, ...(s.scope ? { scope: s.scope } : {}) };
}

function resolvePlaced(s: ScopedSectionPlane, box: THREE.Box3, camera?: { position: THREE.Vector3; target: THREE.Vector3 }): ResolvedPlane {
  const normal = new THREE.Vector3(...s.normal!).normalize();
  const offset = Number.isFinite(s.offset) ? (s.offset as number) : 0;
  const point = new THREE.Vector3(...s.point!).addScaledVector(normal, offset);
  // the side away from the camera: keep the side of `normal` when the camera is on the other side
  const flip = s.flip ?? (camera ? normal.dot(camera.position.clone().sub(point)) < 0 : false);
  const keep = flip ? normal.clone() : normal.clone().negate();
  // a hair toward the removed side, so a face lying exactly on the plane (a picked face at offset 0) stays whole
  // instead of flickering half clipped
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(keep, point.clone().addScaledVector(keep, -COPLANAR_KEEP_MM));
  const axis = dominantAxis(normal);
  const at = point.getComponent(axis);
  planeMeta.set(plane, { source: s.source ?? "face", offset, ...(s.face ? { face: s.face } : {}) });
  void box; // a placed plane does not depend on the bounds (its `at` is kept by `withLegacy`)
  return { plane, at, flip, axis, ...(s.scope ? { scope: s.scope } : {}), source: s.source ?? "face", normal, point: new THREE.Vector3(...s.point!), offset };
}

export function resolvePlanes(list: readonly ScopedSectionPlane[], box: THREE.Box3, camera?: { position: THREE.Vector3; target: THREE.Vector3 }): ResolvedPlane[] {
  return list.slice(0, MAX_SECTIONS).flatMap((s) => resolvePlane(s, box, camera) ?? []);
}

/** The fraction of `box` along `axis` a coordinate is at (clamped 0..1; 0.5 for an empty or flat box). */
export function fractionAt(box: THREE.Box3, axis: 0 | 1 | 2, coord: number): number {
  if (box.isEmpty()) return 0.5;
  const lo = box.min.getComponent(axis);
  const hi = box.max.getComponent(axis);
  return hi - lo > 1e-9 ? Math.min(1, Math.max(0, (coord - lo) / (hi - lo))) : 0.5;
}

/** A placed plane's `axis` and `at` brought in step with its normal, point and offset (for the legacy readers). */
export function withLegacy(s: ScopedSectionPlane, box: THREE.Box3): ScopedSectionPlane {
  if (!isPlaced(s)) return s;
  const n = new THREE.Vector3(...s.normal!).normalize();
  const p = new THREE.Vector3(...s.point!).addScaledVector(n, s.offset ?? 0);
  const axis = dominantAxis(n);
  // where the plane crosses the line through the box centre along its dominant axis
  const c = box.isEmpty() ? p.clone() : box.getCenter(new THREE.Vector3());
  const along = new THREE.Vector3().setComponent(axis, 1);
  const denom = n.dot(along);
  const coord = Math.abs(denom) > 1e-9 ? c.getComponent(axis) + n.dot(p.clone().sub(c)) / denom : p.getComponent(axis);
  return { ...s, axis, at: round(fractionAt(box, axis, coord), 1e-6) };
}

const round = (x: number, q: number) => Math.round(x / q) * q;

/** An origin plane passes through the model's origin when the origin lies in this inner share of the bounds along its axis (DEFAULT). */
export const ORIGIN_INNER_SHARE = 0.8;

/**
 * An origin plane of the model's frame (R2-B): through the model's origin when the origin lies well inside the
 * assembled bounds along the plane's axis (the inner `ORIGIN_INNER_SHARE`), else through the bounds' middle along
 * it (a model standing on its origin, like ClientX's shell on its feet, would be cut at its very bottom; DEFAULT),
 * offset 0, side automatic.
 */
export function originPlane(axis: 0 | 1 | 2, box: THREE.Box3, keep?: Pick<ScopedSectionPlane, "scope" | "flip">): ScopedSectionPlane {
  const normal: V3 = [0, 0, 0];
  normal[axis] = 1;
  const point: V3 = [0, 0, 0];
  if (!box.isEmpty()) {
    const lo = box.min.getComponent(axis);
    const hi = box.max.getComponent(axis);
    const margin = ((hi - lo) * (1 - ORIGIN_INNER_SHARE)) / 2;
    if (!(lo + margin <= 0 && 0 <= hi - margin)) point[axis] = round((lo + hi) / 2, 1e-4);
  }
  return withLegacy({ axis, at: 0.5, source: "origin", normal, point, offset: 0, ...(keep?.scope ? { scope: keep.scope } : {}), ...(keep?.flip !== undefined ? { flip: keep.flip } : {}) }, box);
}

/**
 * A plane on a picked face (R2-B): the face's plane, its outward normal, offset 0. The side kept is the one behind
 * the face (`flip: false`, the material under it; DEFAULT), so moving the plane into the part shows its section.
 */
export function facePlane(normal: THREE.Vector3, point: THREE.Vector3, box: THREE.Box3, face: NonNullable<PlacedPlaneFields["face"]>, keep?: Pick<ScopedSectionPlane, "scope">): ScopedSectionPlane {
  const n = normal.clone().normalize();
  const r = (x: number) => round(x, 1e-6);
  return withLegacy({ axis: dominantAxis(n), at: 0.5, source: "face", normal: [r(n.x), r(n.y), r(n.z)], point: [round(point.x, 1e-4), round(point.y, 1e-4), round(point.z, 1e-4)], offset: 0, flip: false, face, ...(keep?.scope ? { scope: keep.scope } : {}) }, box);
}

/** The plane moved to `offset` mm along its normal (a placed plane), or to that many mm from its axis position. */
export function withOffset(s: ScopedSectionPlane, offset: number, box: THREE.Box3): ScopedSectionPlane {
  // the axis form becomes the origin plane on its axis at that offset (same side, same scope)
  const base = isPlaced(s) ? s : originPlane(s.axis, box, s);
  return withLegacy({ ...base, offset: round(offset, 1e-3) }, box);
}

/** The side kept when none is set, for a plane (the toolbar's `autoFlip(axis)` is for the axis form). */
export function autoFlipOf(s: ScopedSectionPlane, autoAxis: (axis: 0 | 1 | 2) => boolean): boolean {
  if (!isPlaced(s)) return autoAxis(s.axis);
  // the axis rule turned into the normal's sense: + side of the axis kept and the normal along + axis, or both against
  const n = s.normal![dominantAxis({ x: s.normal![0], y: s.normal![1], z: s.normal![2] })];
  return autoAxis(dominantAxis({ x: s.normal![0], y: s.normal![1], z: s.normal![2] })) === n > 0;
}

/** The plane's offset in mm along its normal from its base plane (an axis plane: from the origin plane on its axis). */
export function offsetOf(s: ScopedSectionPlane, box: THREE.Box3): number {
  if (isPlaced(s)) return s.offset ?? 0;
  if (box.isEmpty()) return 0;
  const o = originPlane(s.axis, box);
  const base = o.point![s.axis];
  const at = box.min.getComponent(s.axis) + (box.max.getComponent(s.axis) - box.min.getComponent(s.axis)) * s.at;
  return round(at - base, 1e-3);
}

/** The range an offset can take: the bounds' extent along the normal, from the base plane (mm). */
export function offsetRange(s: ScopedSectionPlane, box: THREE.Box3): [number, number] {
  if (box.isEmpty()) return [-100, 100];
  const placed = isPlaced(s) ? s : originPlane(s.axis, box, s);
  const n = new THREE.Vector3(...placed.normal!).normalize();
  const p = new THREE.Vector3(...placed.point!);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < 8; i++) {
    const c = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    const d = n.dot(c.sub(p));
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
  }
  return [Math.floor(lo), Math.ceil(hi)];
}

/**
 * Where a plane is drawn: the outline's centre (the bounds' centre projected onto it), the handle's point (the picked
 * face's point, else that centre), two in-plane axes and the half sizes that cover the bounds' shadow on it (mm).
 */
export function planeFrame(s: ScopedSectionPlane, box: THREE.Box3): { centre: THREE.Vector3; handle: THREE.Vector3; normal: THREE.Vector3; u: THREE.Vector3; v: THREE.Vector3; half: [number, number] } {
  const placed = isPlaced(s) ? s : originPlane(s.axis, box, s);
  const normal = new THREE.Vector3(...placed.normal!).normalize();
  const offset = isPlaced(s) ? (s.offset ?? 0) : offsetOf(s, box);
  const base = new THREE.Vector3(...placed.point!).addScaledVector(normal, offset);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, base);
  // in-plane axes: u along the world axis least aligned with the normal, crossed (a right-handed frame)
  const ref = Math.abs(normal.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(ref, normal).normalize();
  const v = new THREE.Vector3().crossVectors(normal, u).normalize();
  // the outline round the bounds' shadow, centred on the bounds' centre; the handle at the picked face's point
  const centre = plane.projectPoint(box.isEmpty() ? base : box.getCenter(new THREE.Vector3()), new THREE.Vector3());
  const handle = s.source === "face" ? plane.projectPoint(base, new THREE.Vector3()) : centre.clone();
  let hu = 1;
  let hv = 1;
  if (!box.isEmpty())
    for (let i = 0; i < 8; i++) {
      const c = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(centre);
      hu = Math.max(hu, Math.abs(c.dot(u)));
      hv = Math.max(hv, Math.abs(c.dot(v)));
    }
  // DEFAULT: 6 % beyond the bounds' shadow, so the outline is seen around the model
  return { centre, handle, normal, u, v, half: [hu * 1.06, hv * 1.06] };
}

/** The next plane the toolbar's "Add plane" adds: an origin plane not cut yet (XY, then YZ, then ZX). */
export function nextPlane(list: readonly ScopedSectionPlane[], box?: THREE.Box3): ScopedSectionPlane | undefined {
  if (list.length >= MAX_SECTIONS) return undefined;
  const used = new Set(list.map((s) => s.axis));
  const axis = ([2, 0, 1] as const).find((a) => !used.has(a)) ?? 2;
  return box && !box.isEmpty() ? originPlane(axis, box) : { axis, at: 0.5 };
}

/** The kept side flipped, as an explicit side (an automatic side becomes the other one). */
export function flipped(s: ScopedSectionPlane, auto: boolean): ScopedSectionPlane {
  return { ...s, flip: !(s.flip ?? auto) };
}
