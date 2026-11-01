/**
 * The UHD types the shared sequence files use (repo-specific: the stack's copy of this file imports them from
 * `@deltarobotics/uhd`). Types only: the sequence code calls nothing in UHD.
 */
export type { Assembly, HardwarePlacement, Mat4, MateEdge, Placement } from "@uhd/system/geometry.js";
export type { GeometryFrame, ModuleDef } from "@uhd/types/index.js";
