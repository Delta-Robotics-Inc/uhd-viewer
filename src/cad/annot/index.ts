/**
 * Callouts and marker-first DRC for the 3D view (PB-1184). See ./record.ts
 * (the records), ./layer.ts (drawing), ./place.ts and ./leader.ts (layout),
 * ./findings-anchors.ts (findings to 3D anchors, shared with the stack),
 * ./drc.ts and ./FindingsControl.tsx (the markers and their control).
 */
export * from "./record";
export * from "./facts";
export * from "./leader";
export * from "./place";
export * from "./drc";
export * from "./sources";
// findingsAnchors with the stack's plain-language title and summary carried over (R2-C, ./plain.ts)
export { findingsAnchors, findingText, plainKey, plainString, plainTextIndex, PLAIN_TITLE_MAX, PLAIN_SUMMARY_MAX, type FindingText } from "./plain";
export { severityOf, worst, glbToBody, SEVERITY_ORDER, MAX_POINTS_PER_FINDING, type FindingAnchors, type FindingAnchorPoint, type FindingInput, type FindingLocation, type FindingSeverity, type SceneBody, type SceneNode } from "./findings-anchors";
export { AnnotLayer, MAX_OPEN_CALLOUTS, ANCHOR_BUDGET_MS, type AnnotHost, type AnnotInput, type AnnotStatus, type PresenceChip } from "./layer";
export { componentIn, boundsOf, drawn, surfacePoint, type PartHit } from "./resolve";
// LONG_HOVER_MS: the long-hover delay, shared with the part tooltips (R2-A; Kevin 2026-11-02: 900 ms)
export { DRC_COLOURS, LONG_HOVER_MS, REVEAL_MS, SEVERITY_LABEL, SEVERITY_SHAPE, markerSvg } from "./style";
export { FindingsControl } from "./FindingsControl";
