/**
 * Measurement picks (PB-1187): a ray through W1-C's three-mesh-bvh picking
 * (../render/pick.ts) gives the nearest drawn hit; this turns it into a
 * measurement reference (the body and component it names, the face hit, the
 * point in assembly mm) and the face's triangles for the mesh tier or its
 * signature for the exact tier.
 */
import type * as THREE from "three";
import { instancePathIn } from "../render/ids";
import { pick, type Pick, type PickOptions } from "../render/pick";
import { bodyFrameOf, faceIdOf, meshFace, objectPatch, toMat4, toPartFrame, v3of, type FaceIdSource } from "./faces";
import type { MeshFaceInput } from "./mesh";
import type { FaceSource } from "./place";
import type { V3 } from "./linalg";

export interface MeasureRef {
  /** The body's key and instance path (the part whose CAD file holds the face). */
  body: string;
  part: string;
  /** The component inside the body the hit names (a board's part), by instance path, when it is not the body itself. */
  component?: string;
  face: number;
  faceSource: FaceIdSource;
  /** The hit, assembly mm (Z up). */
  point: V3;
  mesh: THREE.Mesh;
  triangle: number;
  instance?: number;
}

/** A measurement reference from a W1-C pick hit (undefined when the hit is not on a body: a harness, a gizmo). */
export function refFromHit(hit: Pick): MeasureRef | undefined {
  const mesh = hit.object;
  const bodyKey = mesh.userData.bodyKey as string | undefined;
  if (bodyKey === undefined) return undefined;
  const part = bodyKey.split("#")[0];
  const child = (mesh.userData.component as string | undefined) ?? hit.partInstanceId;
  const component = child !== undefined ? instancePathIn(part, child) : undefined;
  const { face, source } = faceIdOf(mesh, hit.triangle);
  return {
    body: bodyKey,
    part,
    ...(component && component !== part ? { component } : {}),
    face: hit.face ?? face,
    faceSource: source,
    point: v3of(hit.point),
    mesh,
    triangle: hit.triangle,
    ...(hit.instance !== undefined ? { instance: hit.instance } : {}),
  };
}

/** Pick for a measurement: the nearest drawn hit of `ray` under `roots`, as a reference. */
export function pickRef(ray: THREE.Ray, roots: THREE.Object3D[], options: PickOptions = {}): MeasureRef | undefined {
  const hit = pick(ray, roots, options);
  return hit ? refFromHit(hit) : undefined;
}

/** The face a reference hit, in assembly mm (`frame: "part"`: in the body's own CAD frame). */
export function refFace(ref: MeasureRef, frame: "assembly" | "part" = "assembly"): MeshFaceInput {
  const toFrame = frame === "part" ? toPartFrame(ref.mesh) : undefined;
  const f = meshFace(ref.mesh, ref.face, { instance: ref.instance, ...(toFrame ? { toFrame } : {}) });
  return { patch: f.patch, quantization: f.quantization };
}

/** The point of a reference in the body's own frame (mm). */
export function refPointInPart(ref: MeasureRef): V3 {
  const m = toPartFrame(ref.mesh);
  if (!m) return ref.point;
  const e = m.elements;
  const [x, y, z] = ref.point;
  return [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]];
}

/** Part to assembly for the body a reference is on (row-major UHD Mat4, mm); undefined when the body frame is not found. */
export function refTransform(ref: MeasureRef): number[] | undefined {
  const f = bodyFrameOf(ref.mesh);
  if (!f) return undefined;
  f.updateWorldMatrix(true, false);
  return toMat4(f.matrixWorld);
}

/** Every drawn triangle of an object (a body's frame, a component's node), for its bounds. */
export function objectFace(obj: THREE.Object3D, frame: "assembly" | "part" = "assembly"): MeshFaceInput {
  const toFrame = frame === "part" ? toPartFrame(obj.children.find((c) => c.name === "cad") ?? obj) : undefined;
  const f = objectPatch(obj, toFrame ? { toFrame } : {});
  return { patch: f.patch, quantization: f.quantization };
}

/** A `FaceSource` for ./place.ts over picked references: faces by (body instance path, face id), placements from the scene. */
export function refFaceSource(refs: MeasureRef[]): FaceSource {
  const find = (part: string, face?: number) => refs.find((r) => (r.part === part || r.component === part) && (face === undefined || r.face === face));
  return {
    face: (part, face) => {
      const r = find(part, face);
      return r ? refFace(r) : undefined;
    },
    matrix: (part) => {
      const r = find(part);
      return r ? refTransform(r) : undefined;
    },
  };
}
