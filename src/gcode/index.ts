/**
 * G-code for the viewer's G-code tab (PB-1192): parse plain FDM G-code
 * (parser.ts), draw it with one instanced draw (geometry.ts), slide over the
 * visible layers (range.ts). The React tab is src/cad/GcodeView.tsx.
 */
export { CUSTOM, FEATURE_COUNT, GCODE_FEATURES, OUTER_WALL, TRAVEL, featureFromName, featureIndex, type GcodeFeature } from "./features";
export {
  ARC_TOLERANCE_MM,
  DEFAULT_FILAMENT_MM,
  GCODE_HARD_STOP_FACTOR,
  GcodeParser,
  MAX_GCODE_BYTES,
  MAX_GCODE_LAYERS,
  MAX_GCODE_LINE_CHARS,
  MAX_GCODE_NUMBER,
  MAX_GCODE_SEGMENTS,
  gcodeSummary,
  parseGcode,
  parseGcodeStream,
  type FeatureTotals,
  type GcodeDecimation,
  type GcodeLayers,
  type GcodeModel,
  type GcodeParseOptions,
  type SegmentColumns,
} from "./parser";
export { buildGcodeDraw, segmentTemplate, setWindow, type GcodeDraw, type GcodeDrawOptions } from "./geometry";
export { rangeLayers, rebaseRange, setEnd, visibleLayers, visibleMask, type LayerRange } from "./range";
export { gcodeEntry } from "./entry";
