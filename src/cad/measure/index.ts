/**
 * Measurement in two tiers and face primitives (PB-1187). The mesh tier
 * runs here on the display mesh; the exact tier is the CLI's geometry
 * service (build123d), asked through `exactRequest`. Every result carries
 * its tier and, for the mesh tier, a tolerance from the mesh.
 */
export * from "./protocol";
export { type FacePatch, type TessellationStats, type PlaneFit, type CylinderFit, type SurfaceFit, type SurfaceKind, classifySurface, fitCylinder, fitPlane, patchArea, patchBounds, patchCentroid, patchDistance, nearestOnPatch, tessellationStats } from "./fit";
export { type MeshFaceInput, PARALLEL_DEG, faceSignature, lineDistance, measureBounds, measureCylinder, measureFaceFace, measurePointFace, measurePointPoint, surfaceOf, surfaceTolerance } from "./mesh";
export { GLB_TO_MM, bodyFrameOf, faceIdOf, meshFace, objectPatch, partNodeOf, quantizationStep, toMat4, toPartFrame, type FaceIdSource, type MeshFace } from "./faces";
export { type MeasureRef, objectFace, pickRef, refFace, refFaceSource, refFromHit, refPointInPart, refTransform } from "./pick";
export { exactBoundsRequest, exactRequest, geometryRef } from "./exact";
export { type FaceFrame, type FaceSource, type Placement, type PlacementOp, type PlaceOptions, faceFrameOf, orientByFace, orientByFaceFrames, placeOnFace, placeOnFaceFrames } from "./place";
