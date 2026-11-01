/**
 * The mesh tier (PB-1187): measurements on the display mesh, each carrying
 * `tier: "mesh"` and a tolerance taken from the mesh itself (chord error of
 * the tessellation, the fit's residual, the position grid of a quantized
 * mesh). Pure: inputs are face patches in mm (./faces.ts makes them from the
 * scene, in the assembly frame or a part's frame), outputs are
 * `MeasureResult`s (./protocol.ts), the same shape the exact tier answers.
 *
 * Rule (review round 1, section 6): a number that must be exact comes from
 * the exact tier; the mesh tier says how far it may be off.
 */
import { classifySurface, nearestOnPatch, patchArea, patchBounds, patchCentroid, patchDistance, tessellationStats, type FacePatch, type SurfaceFit } from "./fit";
import { add, cross, dist, dot, len, lineAngleDeg, angleDeg, norm, round, round3, scale, sub, type V3 } from "./linalg";
import type { FaceSignature, MeasureResult, Tolerance } from "./protocol";

/** A face as the mesh tier sees it: its triangles (mm) and the position grid of the mesh they came from. */
export interface MeshFaceInput {
  patch: FacePatch;
  /** Position grid, mm (0 for float positions). */
  quantization?: number;
}

/** DEFAULT: two faces whose normals (or axes) are within this angle are treated as parallel, degrees. */
export const PARALLEL_DEG = 1;

/** The fits of a face, cached on the input object. */
const fits = new WeakMap<MeshFaceInput, SurfaceFit>();
export function surfaceOf(f: MeshFaceInput): SurfaceFit {
  let s = fits.get(f);
  if (!s) {
    s = classifySurface(f.patch, f.quantization ?? 0);
    fits.set(f, s);
  }
  return s;
}

/**
 * How far a point on this face's triangles may be from the true surface:
 * the chord error (curved faces), the plane fit's largest residual (flat
 * ones), and the position grid; mm.
 */
export function surfaceTolerance(f: MeshFaceInput): Tolerance {
  const s = surfaceOf(f);
  const q = f.quantization ?? 0;
  const basis: string[] = [];
  let mm = q;
  if (q) basis.push(`position grid ${fmt(q)} mm`);
  if (s.kind === "plane") {
    mm += s.plane.max;
    basis.push(`plane fit residual ${fmt(s.plane.max)} mm`);
  } else {
    const t = tessellationStats(f.patch);
    mm += t.sagitta.max;
    basis.push(`chord error ${fmt(t.sagitta.max)} mm (edges median ${fmt(t.edge.median)} mm)`);
    if (s.kind === "cylinder" && s.cylinder) {
      mm += s.cylinder.max;
      basis.push(`circle fit residual ${fmt(s.cylinder.max)} mm`);
    }
  }
  return { mm, basis };
}

const fmt = (x: number) => (x < 0.001 ? x.toExponential(1) : x.toFixed(4));
const r = (x: number) => round(x, 1e-4);

/** The face's signature for the exact tier (in whatever frame the patch is: the part's, for a request). */
export function faceSignature(f: MeshFaceInput): FaceSignature {
  const s = surfaceOf(f);
  const sig: FaceSignature = { type: s.kind, centroid: round3(patchCentroid(f.patch)), area: r(patchArea(f.patch)) };
  if (s.kind === "cylinder" && s.cylinder) {
    sig.axis = round3(s.cylinder.axis, 1e-6);
    sig.axisPoint = round3(s.cylinder.point);
    sig.radius = r(s.cylinder.radius);
  } else sig.normal = round3(s.plane.normal, 1e-6);
  return sig;
}

const combine = (...ts: Tolerance[]): Tolerance => ({ mm: ts.reduce((s, t) => s + t.mm, 0), basis: ts.flatMap((t) => t.basis) });

/** Distance between two picked points; a point picked on a face carries that face's tolerance. */
export function measurePointPoint(a: V3, b: V3, faces: { a?: MeshFaceInput; b?: MeshFaceInput } = {}, frame: MeasureResult["frame"] = "assembly"): MeasureResult {
  const tol = combine(...[faces.a, faces.b].filter((x): x is MeshFaceInput => !!x).map(surfaceTolerance));
  return {
    tier: "mesh",
    kind: "point-point",
    frame,
    method: "points",
    distance: r(dist(a, b)),
    points: { a: round3(a), b: round3(b) },
    tolerance: { mm: tol.mm, basis: tol.basis.length ? tol.basis : ["picked points on triangles"] },
  };
}

/** Distance from a point to a face: to its fitted plane when flat (signed: + on the normal's side), else to its nearest triangle. */
export function measurePointFace(p: V3, face: MeshFaceInput, pointFace?: MeshFaceInput, frame: MeasureResult["frame"] = "assembly"): MeasureResult {
  const s = surfaceOf(face);
  const tol = combine(surfaceTolerance(face), ...(pointFace ? [surfaceTolerance(pointFace)] : []));
  if (s.kind === "plane") {
    const d = dot(sub(p, s.plane.point), s.plane.normal);
    return { tier: "mesh", kind: "point-face", frame, method: "plane-fit", distance: r(d), points: { a: round3(p), b: round3(sub(p, scale(s.plane.normal, d))) }, tolerance: tol, surfaces: { b: "plane" } };
  }
  const n = nearestOnPatch(p, face.patch);
  return { tier: "mesh", kind: "point-face", frame, method: "nearest", distance: r(n.distance), points: { a: round3(p), b: round3(n.point) }, tolerance: tol, surfaces: { b: s.kind } };
}

/** Distance between two lines (point, unit direction); for parallel lines, the perpendicular offset. */
export function lineDistance(p1: V3, d1: V3, p2: V3, d2: V3): { distance: number; a: V3; b: V3 } {
  const w = sub(p2, p1);
  const c = cross(d1, d2);
  if (lineAngleDeg(d1, d2) <= PARALLEL_DEG || len(c) < 1e-12) {
    const along = dot(w, d1);
    const foot = add(p1, scale(d1, along));
    return { distance: dist(foot, p2), a: foot, b: p2 };
  }
  // closest points of two skew lines
  const a = dot(d1, d1);
  const b = dot(d1, d2);
  const e = dot(d2, d2);
  const dd = dot(d1, w);
  const f = dot(d2, w);
  const den = a * e - b * b;
  const s = (dd * e - b * f) / den;
  const t = (b * dd - a * f) / den;
  const pa = add(p1, scale(d1, s));
  const pb = add(p2, scale(d2, -t));
  return { distance: dist(pa, pb), a: pa, b: pb };
}

/**
 * Two faces: their angle (normals for planes, axes for cylinders, normal to
 * axis for a plane and a cylinder) and their distance: parallel planes give
 * the gap between them, two parallel cylinders the distance between their
 * axes (hole to hole), anything else the nearest points of the two surfaces.
 * `minDistance` is in the notes when the main distance is not the nearest.
 */
export function measureFaceFace(a: MeshFaceInput, b: MeshFaceInput, frame: MeasureResult["frame"] = "assembly"): MeasureResult {
  const sa = surfaceOf(a);
  const sb = surfaceOf(b);
  const tol = combine(surfaceTolerance(a), surfaceTolerance(b));
  const surfaces = { a: sa.kind, b: sb.kind };
  const extent = Math.max(sa.extent, sb.extent, 1e-6);
  const degTol = (Math.atan2(tol.mm, extent) * 180) / Math.PI;
  const notes: string[] = [];
  // the nearest points cost (triangles x triangles): taken only when they are the answer (as the exact tier does)
  const nearestOf = () => {
    const n = patchDistance(a.patch, b.patch);
    if (n.approximate) notes.push("nearest distance from a thinned triangle set (large faces)");
    return n;
  };
  if (sa.kind === "plane" && sb.kind === "plane") {
    const angle = angleDeg(sa.plane.normal, sb.plane.normal);
    const lineAngle = lineAngleDeg(sa.plane.normal, sb.plane.normal);
    if (lineAngle <= PARALLEL_DEG) {
      // gap between the planes, measured both ways and averaged (the planes are not quite parallel on a mesh)
      const d1 = Math.abs(dot(sub(sb.plane.point, sa.plane.point), sa.plane.normal));
      const d2 = Math.abs(dot(sub(sa.plane.point, sb.plane.point), sb.plane.normal));
      const foot = sub(sb.plane.point, scale(sa.plane.normal, dot(sub(sb.plane.point, sa.plane.point), sa.plane.normal)));
      return { tier: "mesh", kind: "face-face", frame, method: "parallel-planes", distance: r((d1 + d2) / 2), angleDeg: r(angle), points: { a: round3(foot), b: round3(sb.plane.point) }, tolerance: { ...tol, deg: degTol }, surfaces, notes };
    }
    const nearest = nearestOf();
    return { tier: "mesh", kind: "face-face", frame, method: "nearest", distance: r(nearest.distance), angleDeg: r(angle), points: { a: round3(nearest.pointA), b: round3(nearest.pointB) }, tolerance: { ...tol, deg: degTol }, surfaces, notes };
  }
  if (sa.kind === "cylinder" && sb.kind === "cylinder" && sa.cylinder && sb.cylinder) {
    const angle = lineAngleDeg(sa.cylinder.axis, sb.cylinder.axis);
    const l = lineDistance(sa.cylinder.point, sa.cylinder.axis, sb.cylinder.point, sb.cylinder.axis);
    notes.push(`diameters ${r(sa.cylinder.diameter)} and ${r(sb.cylinder.diameter)} mm`);
    return { tier: "mesh", kind: "face-face", frame, method: angle <= PARALLEL_DEG ? "axis-to-axis" : "axis-to-axis-skew", distance: r(l.distance), angleDeg: r(angle), points: { a: round3(l.a), b: round3(l.b) }, tolerance: { ...tol, deg: degTol }, surfaces, notes };
  }
  // a plane and a cylinder: angle between the plane's normal and the axis (0: the axis stands on the plane)
  let angle: number | undefined;
  const cyl = sa.kind === "cylinder" ? sa.cylinder : sb.kind === "cylinder" ? sb.cylinder : undefined;
  const pl = sa.kind === "plane" ? sa.plane : sb.kind === "plane" ? sb.plane : undefined;
  if (cyl && pl) angle = lineAngleDeg(cyl.axis, pl.normal);
  const nearest = nearestOf();
  return {
    tier: "mesh",
    kind: "face-face",
    frame,
    method: "nearest",
    distance: r(nearest.distance),
    ...(angle !== undefined ? { angleDeg: r(angle) } : {}),
    points: { a: round3(nearest.pointA), b: round3(nearest.pointB) },
    tolerance: { ...tol, deg: degTol },
    surfaces,
    notes,
  };
}

/** A round face: its axis, radius and diameter from a circle fit. */
export function measureCylinder(f: MeshFaceInput, frame: MeasureResult["frame"] = "assembly"): MeasureResult {
  const s = surfaceOf(f);
  const c = s.cylinder;
  const tol = surfaceTolerance(f);
  if (!c || s.kind === "plane") return { tier: "mesh", kind: "cylinder", frame, method: "circle-fit", tolerance: tol, surfaces: { a: s.kind }, notes: ["the face is flat: no axis"] };
  const notes = s.kind === "cylinder" ? [`covers ${Math.round(c.coverageDeg)} degrees of arc, ${r(c.length)} mm long`] : [`not a clean cylinder (fit residual ${fmt(c.max)} mm): the diameter is approximate`];
  return {
    tier: "mesh",
    kind: "cylinder",
    frame,
    method: "circle-fit",
    radius: r(c.radius),
    diameter: r(c.diameter),
    axis: { point: round3(c.point), direction: round3(norm(c.axis), 1e-6) },
    // vertices lie on the true surface, so the diameter is off by the fit residual and the grid on both sides
    tolerance: { mm: 2 * (c.max + (f.quantization ?? 0)), basis: [`circle fit residual ${fmt(c.max)} mm`, ...((f.quantization ?? 0) ? [`position grid ${fmt(f.quantization!)} mm`] : [])] },
    surfaces: { a: s.kind },
    notes,
  };
}

/** Axis-aligned bounds of a set of triangles (a part, or a face), mm, in the patch's frame. */
export function measureBounds(f: MeshFaceInput, frame: MeasureResult["frame"] = "assembly"): MeasureResult {
  const b = patchBounds(f.patch);
  const size: V3 = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  const q = f.quantization ?? 0;
  const sag = tessellationStats(f.patch).sagitta.max;
  return {
    tier: "mesh",
    kind: "bounds",
    frame,
    method: "vertices",
    min: round3(b.min),
    max: round3(b.max),
    size: round3(size),
    // a curved extreme between vertices can bulge past them by the chord error; the grid moves each side
    tolerance: { mm: 2 * q + sag, basis: [`chord error ${fmt(sag)} mm`, ...(q ? [`position grid ${fmt(q)} mm per side`] : [])] },
  };
}
