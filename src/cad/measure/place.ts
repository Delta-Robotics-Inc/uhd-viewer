/**
 * Face primitives (PB-1187): "place on face" and "orient by face", as in
 * the slicers (lay a part flat on a picked face), for the 3D view. Pure
 * functions: they read face frames and the moving part's placement and
 * return the new placement plus the view-state write that shows it.
 *
 * Display-side only: a placement here changes what the view draws (a
 * person or an agent trying a fit), never the UHD design. The write is
 * `{ op: "set", path: ["placements", <instance path>], value }`, the
 * view state's `placements` key (W3-A's schema, `PlacementOverride` in
 * src/api.ts); a `PlacementOp` is a `SetOp`.
 *
 * Units and frames: mm, Z up (UHD); matrices are UHD's row-major Mat4,
 * part to assembly.
 */
import { surfaceOf, type MeshFaceInput } from "./mesh";
import { patchCentroid } from "./fit";
import type { SetOp } from "../../api";
import { add, angleDeg, applyDir, applyPoint, dot, mul, norm, orthonormalize, rotationAbout, rotationBetween, round, scale, sub, translation, type M4, type V3 } from "./linalg";

/** A face as a placement sees it: a plane (point, outward normal) or an axis (point on it, direction). */
export interface FaceFrame {
  kind: "plane" | "axis";
  point: V3;
  /** The plane's outward normal, or the axis direction. */
  normal: V3;
}

/** The frame of a face from its fits (assembly mm): a flat face is its plane through its centroid; a round one its axis. */
export function faceFrameOf(f: MeshFaceInput): FaceFrame {
  const s = surfaceOf(f);
  if (s.kind === "cylinder" && s.cylinder) {
    // the axis point nearest the face's centroid, so "on the axis" stays near the face
    const c = patchCentroid(f.patch);
    const d = norm(s.cylinder.axis);
    const p = add(s.cylinder.point, scale(d, dot(sub(c, s.cylinder.point), d)));
    return { kind: "axis", point: p, normal: d };
  }
  return { kind: "plane", point: s.plane.point, normal: norm(s.plane.normal) };
}

/** The view-state write that shows a placement (a `SetOp` on `placements`). */
export interface PlacementOp extends SetOp {
  op: "set";
  path: ["placements", string];
  value: {
    /** Part to assembly, row-major, mm. */
    matrix: number[];
    /** "placeOnFace" or "orientByFace". */
    by: string;
    /** The faces it used: the moving part's and the target's (instance path and the viewer's face id). */
    faces: { part: string; face: number; target: string; targetFace: number };
  };
}

export interface Placement {
  part: string;
  /** The new placement, part to assembly (row-major, mm). */
  matrix: number[];
  /** What moved the part: new = delta x old. */
  delta: number[];
  /** How far the part turned (degrees) and how far its face's point moved (mm). */
  turnedDeg: number;
  movedMm: number;
  op: PlacementOp;
}

export interface PlaceOptions {
  /** Space left between the faces along the target's normal, mm (DEFAULT 0: touching). */
  gap?: number;
  /** A turn about the target's normal after placing, degrees (DEFAULT 0). */
  spinDeg?: number;
  /**
   * Where on the target the face lands: "centroid" puts the face's point on the target's (DEFAULT),
   * "project" keeps the in-plane offset and only closes the gap.
   */
  align?: "centroid" | "project";
}

/** Rounded finely enough to stay rigid within the view state's 1e-6 check. */
const r9 = (m: number[]) => m.map((x) => round(x, 1e-9));

/**
 * Place on face, from frames: turn the part the least so its face looks
 * against the target's (plane on plane: normals opposite), then move it so
 * the faces meet. An axis on an axis (a bore on a shaft) is made coaxial,
 * same direction, keeping the part's position along the axis.
 */
export function placeOnFaceFrames(partMatrix: M4, face: FaceFrame, target: FaceFrame, opts: PlaceOptions = {}): { matrix: M4; delta: M4 } {
  const gap = opts.gap ?? 0;
  if (face.kind === "axis" && target.kind === "axis") {
    const R = rotationBetween(face.normal, target.normal, face.point);
    // the face's axis point after turning is face.point (the pivot); slide it onto the target axis, across only
    const d = norm(target.normal);
    const off = sub(face.point, target.point);
    const across = sub(off, scale(d, dot(off, d)));
    let delta = mul(translation(scale(across, -1)), R);
    if (opts.spinDeg) delta = mul(rotationAbout(d, opts.spinDeg, target.point), delta);
    return { matrix: mul(delta, partMatrix), delta };
  }
  const want = scale(norm(target.normal), -1);
  const R = rotationBetween(face.normal, want, face.point);
  const n = norm(target.normal);
  let move: V3;
  if (opts.align === "project") {
    // close the gap along the normal only
    move = scale(n, dot(sub(target.point, face.point), n) + gap);
  } else move = add(sub(target.point, face.point), scale(n, gap));
  let delta = mul(translation(move), R);
  if (opts.spinDeg) delta = mul(rotationAbout(n, opts.spinDeg, add(target.point, scale(n, gap))), delta);
  return { matrix: mul(delta, partMatrix), delta };
}

/**
 * Orient by face, from frames: turn the part the least so its face's
 * normal (or axis) points the way the target's does (`flip`: the opposite
 * way), about the face's own point; the part does not travel.
 */
export function orientByFaceFrames(partMatrix: M4, face: FaceFrame, target: FaceFrame, opts: { flip?: boolean } = {}): { matrix: M4; delta: M4 } {
  const want = opts.flip ? scale(norm(target.normal), -1) : norm(target.normal);
  const delta = rotationBetween(face.normal, want, face.point);
  return { matrix: mul(delta, partMatrix), delta };
}

/** Where a placement finds faces and parts (built from the scene by the view, or from fixtures in tests). */
export interface FaceSource {
  /** A face of a part, assembly mm (undefined: no such face). */
  face(part: string, face: number): MeshFaceInput | undefined;
  /** A part's placement, part to assembly (row-major, mm). */
  matrix(part: string): M4 | undefined;
}

function finish(by: string, part: string, faceId: number, target: string, targetFace: number, face: FaceFrame, res: { matrix: M4; delta: M4 }): Placement {
  const moved = applyPoint(res.delta, face.point);
  // squared up: the part's placement may come from rounded numbers, and the view state takes only rigid ones
  const matrix = r9(orthonormalize(res.matrix));
  return {
    part,
    matrix,
    delta: r9(res.delta),
    turnedDeg: round(angleDeg(face.normal, applyDir(res.delta, face.normal)), 1e-4),
    movedMm: round(Math.hypot(...sub(moved, face.point)), 1e-4),
    op: { op: "set", path: ["placements", part], value: { matrix, by, faces: { part, face: faceId, target, targetFace } } },
  };
}

/** `placeOnFace(partId, faceId, targetPartId, targetFaceId)`: the part's face laid on the target's. */
export function placeOnFace(src: FaceSource, partId: string, faceId: number, targetPartId: string, targetFaceId: number, opts: PlaceOptions = {}): Placement {
  const { face, target, matrix } = inputs(src, partId, faceId, targetPartId, targetFaceId);
  return finish("placeOnFace", partId, faceId, targetPartId, targetFaceId, face, placeOnFaceFrames(matrix, face, target, opts));
}

/** `orientByFace(partId, faceId, targetPartId, targetFaceId)`: the part turned so its face points like the target's. */
export function orientByFace(src: FaceSource, partId: string, faceId: number, targetPartId: string, targetFaceId: number, opts: { flip?: boolean } = {}): Placement {
  const { face, target, matrix } = inputs(src, partId, faceId, targetPartId, targetFaceId);
  return finish("orientByFace", partId, faceId, targetPartId, targetFaceId, face, orientByFaceFrames(matrix, face, target, opts));
}

function inputs(src: FaceSource, partId: string, faceId: number, targetPartId: string, targetFaceId: number) {
  const f = src.face(partId, faceId);
  const t = src.face(targetPartId, targetFaceId);
  const matrix = src.matrix(partId);
  if (!f || !f.patch.positions.length) throw new Error(`no face ${faceId} on ${partId}`);
  if (!t || !t.patch.positions.length) throw new Error(`no face ${targetFaceId} on ${targetPartId}`);
  if (!matrix) throw new Error(`no placement for ${partId}`);
  return { face: faceFrameOf(f), target: faceFrameOf(t), matrix };
}
