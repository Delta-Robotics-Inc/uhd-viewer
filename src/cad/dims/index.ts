/**
 * Dimensions, angles, the Measure tool and explode path lines in the 3D view (R3-C, 2026-11-02). See ./record.ts
 * (the records, additive kinds of `uhd-viewer.annotation/v0`), ./geometry.ts (the shapes), ./layer.ts (drawing),
 * ./paths.ts (explode path lines), ./measure.ts and ./MeasureControl.tsx (the person's tool).
 */
export * from "./record";
export * from "./geometry";
export { DimsLayer, type DimJoint, type DimPreview, type DimStatus, type DimsHost } from "./layer";
export { ExplodePaths, pathMovers, MAX_PATHS, PATH_MIN_EXPLODE, PATH_MIN_MM, PATH_MIN_PX, type PathMover } from "./paths";
export { MeasureTool, MEASURE_HINT, dimensionFromPicks, measureId, type MeasureHost, type MeasurePick } from "./measure";
export { MeasureControl } from "./MeasureControl";
export { DIMS_CSS, DIM_FALLBACK, DIM_DOT_PX, DASH_PX, GAP_PX, DIM_GHOST_OPACITY, ensureDimsStyles } from "./style";
