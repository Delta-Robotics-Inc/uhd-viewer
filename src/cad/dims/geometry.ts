/**
 * The geometry of a dimension and of an angle (R3-C), pure: where the dimension line, its extension lines and its
 * label sit, and where an angle's arc, ticks and arm go about a joint. Units: the scene's world units are assembly
 * mm (each body's glTF metres are scaled x1000 and turned Z up by its `cadWrapper` in ../scene.ts, at the
 * boundary), so every length here is mm; a host whose root is itself transformed gives the root's matrix and the
 * layer converts at that boundary.
 */
import * as THREE from "three";

/**
 * Where a dimension line sits when its record gives no `offset` (DEFAULT, R3-C): off the measured points, away from
 * the assembly's up (below the parts, as the concept's motor-to-motor dimension), by this share of the measured
 * distance and never less than DIM_OFFSET_MIN_MM.
 */
export const DIM_OFFSET_SHARE = 0.15;
export const DIM_OFFSET_MIN_MM = 6;
/** Extension lines run this far past the dimension line, CSS px (DEFAULT). */
export const EXT_OVERSHOOT_PX = 6;
/**
 * An angle's arc radius: this multiple of the arm (the joint axis to the turned part's centre), DEFAULT 1.25: the arc
 * runs outside the part it measures (concept B's GPS mast), not through it (0.6 hid it inside the part on the drone).
 */
export const ARC_SHARE = 1.25;
/**
 * ... and never under this many CSS px on screen (DEFAULT), so a small joint's arc still reads. Wave R3 gate: 44 px
 * left the drone's GPS fold a knot of labels at a normal zoom; 96 px reads as concept image 1's arc.
 */
export const ARC_MIN_PX = 96;
/** Arc polyline step, degrees (DEFAULT). */
export const ARC_STEP_DEG = 3;
/** A tick runs from (1 - TICK_SHARE) to (1 + TICK_SHARE) of the radius (DEFAULT). */
export const TICK_SHARE = 0.1;

const EPS = 1e-9;

/** A unit vector at right angles to `n` (any one, stable for a given `n`). */
export function anyPerpendicular(n: THREE.Vector3): THREE.Vector3 {
  const a = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  return a.sub(n.clone().multiplyScalar(a.dot(n))).normalize();
}

/**
 * The dimension line's offset from the measured points (world mm): the record's own when given (`offset`, already
 * in world axes), else DEFAULT: away from `up`, at right angles to the measured line, DIM_OFFSET_SHARE of its length
 * (at least DIM_OFFSET_MIN_MM). A measured line along `up` is offset sideways (world X, else Y, at right angles).
 */
export function dimensionOffset(a: THREE.Vector3, b: THREE.Vector3, up: THREE.Vector3, offset?: THREE.Vector3): THREE.Vector3 {
  if (offset) return offset.clone();
  const d = b.clone().sub(a);
  const len = d.length();
  const size = Math.max(DIM_OFFSET_MIN_MM, DIM_OFFSET_SHARE * len);
  const u = up.clone().normalize();
  if (len < EPS) return u.multiplyScalar(-size);
  const dir = d.divideScalar(len);
  const down = u.clone().negate();
  const perp = down.sub(dir.clone().multiplyScalar(down.dot(dir)));
  if (perp.length() < 0.2) return anyPerpendicular(dir).multiplyScalar(size);
  return perp.normalize().multiplyScalar(size);
}

/** The pieces of a dimension: the measured points, the dimension line's ends, and its middle. */
export interface DimensionShape {
  a: THREE.Vector3;
  b: THREE.Vector3;
  a2: THREE.Vector3;
  b2: THREE.Vector3;
  /** The extension lines' far ends (a little past the dimension line). */
  a3: THREE.Vector3;
  b3: THREE.Vector3;
  mid: THREE.Vector3;
  /** Unit direction of the offset (the label is pushed this way on screen). */
  out: THREE.Vector3;
}

/** A dimension's shape from its two points, an offset (./dimensionOffset) and the world size of a pixel there. */
export function dimensionShape(a: THREE.Vector3, b: THREE.Vector3, off: THREE.Vector3, perPx: number): DimensionShape {
  const out = off.length() > EPS ? off.clone().normalize() : new THREE.Vector3(0, 0, -1);
  const a2 = a.clone().add(off);
  const b2 = b.clone().add(off);
  const over = out.clone().multiplyScalar(EXT_OVERSHOOT_PX * perPx);
  return { a: a.clone(), b: b.clone(), a2, b2, a3: a2.clone().add(over), b3: b2.clone().add(over), mid: a2.clone().add(b2).multiplyScalar(0.5), out };
}

/** A length in mm for a label: 1 decimal from 10 mm up ("158.4 mm"), 2 under it ("3.12 mm"); DEFAULT. */
export function formatMm(v: number, tolerance?: number): string {
  const s = Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
  const t = tolerance !== undefined && tolerance > 0 ? ` ±${tolerance >= 1 ? tolerance.toFixed(1) : tolerance.toPrecision(1)}` : "";
  return `${s} mm${t}`;
}

/** An angle for a label: whole degrees when within 0.05 of one, else 1 decimal ("62°", "12.5°"); DEFAULT. */
export function formatDeg(v: number): string {
  const r = Math.round(v);
  const s = Math.abs(v - r) < 0.05 ? String(r) : v.toFixed(1);
  return `${s === "-0" ? "0" : s}°`;
}

const DEG = Math.PI / 180;

/** The signed angle from `u` to `w` about `n` (right hand), degrees, after both are put in the plane across `n`. */
export function signedAngleDeg(u: THREE.Vector3, w: THREE.Vector3, n: THREE.Vector3): number {
  const nn = n.clone().normalize();
  const a = u.clone().sub(nn.clone().multiplyScalar(u.dot(nn)));
  const b = w.clone().sub(nn.clone().multiplyScalar(w.dot(nn)));
  if (a.lengthSq() < EPS || b.lengthSq() < EPS) return 0;
  return Math.atan2(nn.dot(a.clone().cross(b)), a.dot(b)) / DEG;
}

/** A revolute joint in the world, at rest: its axis line and the direction its part lies at `rest`. */
export interface AngleFrame {
  origin: THREE.Vector3;
  /** Unit axis. */
  axis: THREE.Vector3;
  /** Unit, at right angles to `axis`: where the arm points at the joint's `rest` value. */
  restDir: THREE.Vector3;
  rest: number;
  min?: number;
  max?: number;
}

/**
 * The direction the turned part lies at rest: from the axis to its centre, across the axis. A centre on the axis
 * gives any direction at right angles (`arm` is then 0).
 */
export function restDirection(origin: THREE.Vector3, axis: THREE.Vector3, centre: THREE.Vector3): { dir: THREE.Vector3; arm: number } {
  const n = axis.clone().normalize();
  const v = centre.clone().sub(origin);
  const across = v.sub(n.clone().multiplyScalar(v.dot(n)));
  const arm = across.length();
  return arm > 1e-6 ? { dir: across.divideScalar(arm), arm } : { dir: anyPerpendicular(n), arm: 0 };
}

/** The arm's direction at joint value `v` (degrees): `restDir` turned about the axis by v - rest. */
export function directionAt(f: AngleFrame, v: number): THREE.Vector3 {
  return f.restDir.clone().applyAxisAngle(f.axis, (v - f.rest) * DEG);
}

/** The arc from value `from` to `to` (degrees) at `radius`, as points (ARC_STEP_DEG apart, at most 121). */
export function arcPoints(f: AngleFrame, from: number, to: number, radius: number): THREE.Vector3[] {
  const span = to - from;
  const n = Math.min(120, Math.max(1, Math.ceil(Math.abs(span) / ARC_STEP_DEG)));
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) pts.push(f.origin.clone().addScaledVector(directionAt(f, from + (span * i) / n), radius));
  return pts;
}

/** A tick across the arc at value `v`: from (1 - TICK_SHARE) to (1 + TICK_SHARE) of `radius`. */
export function tickAt(f: AngleFrame, v: number, radius: number, share = TICK_SHARE): [THREE.Vector3, THREE.Vector3] {
  const d = directionAt(f, v);
  return [f.origin.clone().addScaledVector(d, radius * (1 - share)), f.origin.clone().addScaledVector(d, radius * (1 + share))];
}

/**
 * The joint value a part shows now, from its pose: `delta` (world, the part's current frame times the inverse of
 * its assembled frame) turns `restDir` about the axis; the value is rest plus that turn. Translations (explode,
 * a parent's move) do not change it. A parent that itself turns would add its turn (not drawn today: DEFAULT).
 */
export function valueFromDelta(f: Pick<AngleFrame, "axis" | "restDir" | "rest">, delta: THREE.Matrix4): number {
  const w = f.restDir.clone().transformDirection(delta);
  return f.rest + signedAngleDeg(f.restDir, w, f.axis);
}

/** The angle labels to draw, in priority order (a later one that lands on an earlier one on screen is dropped). */
export interface AngleTick {
  kind: "now" | "stop" | "rest" | "zero";
  value: number;
  label: string;
}

/**
 * The ticks of a joint (concept B, the GPS mast): NOW (the arm), the hard stops (max, and min when it is not 0°),
 * REST, and 0°. Labels in degrees ("NOW 62°", "HARD STOP 95°", "REST 90°", "0°").
 */
export function angleTicks(f: Pick<AngleFrame, "rest" | "min" | "max">, now: number): AngleTick[] {
  const out: AngleTick[] = [{ kind: "now", value: now, label: `NOW ${formatDeg(now)}` }];
  if (f.max !== undefined) out.push({ kind: "stop", value: f.max, label: `HARD STOP ${formatDeg(f.max)}` });
  if (f.min !== undefined && Math.abs(f.min) > 1e-9) out.push({ kind: "stop", value: f.min, label: `HARD STOP ${formatDeg(f.min)}` });
  out.push({ kind: "rest", value: f.rest, label: `REST ${formatDeg(f.rest)}` });
  out.push({ kind: "zero", value: 0, label: "0°" });
  return out;
}

/** The arc's span: from the lowest to the highest of 0, the stops, rest and now (degrees). */
export function arcSpan(f: Pick<AngleFrame, "rest" | "min" | "max">, now: number): [number, number] {
  const vs = [0, f.rest, now, ...(f.min !== undefined ? [f.min] : []), ...(f.max !== undefined ? [f.max] : [])];
  return [Math.min(...vs), Math.max(...vs)];
}

/** World size of one CSS pixel at `depth` (along the view axis) for a perspective camera `height` px tall. */
export function perPxAt(camera: THREE.PerspectiveCamera, depth: number, height: number): number {
  return (2 * Math.max(depth, 1e-6) * Math.tan((camera.fov * DEG) / 2)) / Math.max(1, height) / Math.max(1e-6, camera.zoom);
}
