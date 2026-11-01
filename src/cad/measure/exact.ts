/**
 * The exact tier's request (PB-1187): the viewer cannot run OCCT, so it
 * describes what was picked to the CLI's geometry service (`protoboard
 * geometry measure`, protoboard-stack `packages/core/src/geometry-service/`),
 * which loads the body's source STEP through build123d and answers with the
 * same `MeasureResult` shape, `tier: "exact"`.
 *
 * Faces travel as signatures (centroid, normal or axis and radius, area) in
 * the body's own frame, never as triangle indices or sidecar feature ids:
 * those are not STEP face indices (./faces.ts). Each ref carries its body's
 * placement so the answer comes back in assembly mm.
 */
import { faceSignature, type MeshFaceInput } from "./mesh";
import { refFace, refPointInPart, refTransform, type MeasureRef } from "./pick";
import { GEOMETRY_REQUEST_SCHEMA, type GeometryRef, type GeometryRequest, type MeasureKind } from "./protocol";

/** One side of a request from a measurement reference: the face's signature in part mm, the point, the placement. */
export function geometryRef(ref: MeasureRef, opts: { face?: boolean; point?: boolean } = {}): GeometryRef {
  const face: MeshFaceInput | undefined = opts.face === false ? undefined : refFace(ref, "part");
  const transform = refTransform(ref);
  return {
    part: ref.part,
    ...(ref.component ? { component: ref.component } : {}),
    face: ref.face,
    ...(face && face.patch.positions.length ? { signature: faceSignature(face) } : {}),
    ...(opts.point === false ? {} : { point: refPointInPart(ref) }),
    ...(transform ? { transform } : {}),
  };
}

/** The exact-tier request for a measurement between picks (the same kinds as the mesh tier). */
export function exactRequest(kind: MeasureKind, a: MeasureRef, b?: MeasureRef): GeometryRequest {
  const facesOn = (which: "a" | "b") => kind === "face-face" || kind === "cylinder" || (kind === "point-face" && which === "b") || kind === "point-point";
  return {
    schema: GEOMETRY_REQUEST_SCHEMA,
    kind,
    a: geometryRef(a, { face: facesOn("a"), point: kind !== "face-face" && kind !== "cylinder" }),
    ...(b ? { b: geometryRef(b, { face: facesOn("b"), point: kind === "point-point" }) } : {}),
  };
}

/** The exact bounds of a body (its STEP's optimal bounding box), placed in the assembly when `transform` is given. */
export function exactBoundsRequest(part: string, transform?: number[]): GeometryRequest {
  return { schema: GEOMETRY_REQUEST_SCHEMA, kind: "bounds", a: { part, ...(transform ? { transform } : {}) } };
}
