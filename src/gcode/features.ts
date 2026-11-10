/**
 * G-code feature types (PB-1192): what a slicer says each extrusion is, read
 * from its comments, and the colour the G-code tab draws it in.
 *
 * Slicers name the same features differently. PrusaSlicer and OrcaSlicer
 * (non-Bambu printers) write `;TYPE:External perimeter` / `;TYPE:Outer wall`,
 * Bambu Studio (and Orca for Bambu printers) `; FEATURE: Outer wall`, Cura
 * `;TYPE:WALL-OUTER`. They all map onto the sixteen ids below by keyword
 * (`featureFromName`), so the legend, the toggles and the colours are the same
 * whatever made the file. Index 0 is reserved for travel moves; the ids fit a
 * 16-bit mask (one bit per type per layer, `GcodeModel.layers.types`).
 *
 * Clean room: written from the comment formats only (runtime-and-workflows.md
 * §6.1 lists them); no slicer or viewer code was read or copied.
 */

export interface GcodeFeature {
  id: string;
  label: string;
  /**
   * DEFAULT palette (PB-1192, Kevin to revisit): data colours of our own choosing, distinct in hue. They follow
   * the familiar slicer convention of a hue per feature (warm walls, red infill, green support), so several sit
   * close to common slicer defaults (noted by the wave 4 gate's review); no slicer's palette file was copied. They
   * are a data palette like the DRC colours, so they do not follow the UI theme; travel is the one neutral and
   * GcodeView may tint it from the theme's faint text colour.
   */
  color: string;
}

export const GCODE_FEATURES: readonly GcodeFeature[] = [
  { id: "travel", label: "Travel", color: "#8a8f98" },
  { id: "outer-wall", label: "Outer wall", color: "#ff8a3d" },
  { id: "inner-wall", label: "Inner wall", color: "#f2c94c" },
  { id: "overhang-wall", label: "Overhang wall", color: "#2f6bff" },
  { id: "sparse-infill", label: "Sparse infill", color: "#b8323a" },
  { id: "solid-infill", label: "Solid infill", color: "#9b4dca" },
  { id: "top-surface", label: "Top surface", color: "#ff4d6d" },
  { id: "bottom-surface", label: "Bottom surface", color: "#3fb8b0" },
  { id: "bridge", label: "Bridge", color: "#6fa8ff" },
  { id: "support", label: "Support", color: "#3fbf5f" },
  { id: "support-interface", label: "Support interface", color: "#1f7a45" },
  { id: "skirt-brim", label: "Skirt and brim", color: "#00a6c8" },
  { id: "prime-tower", label: "Prime tower", color: "#8d6e63" },
  { id: "ironing", label: "Ironing", color: "#f48fb1" },
  { id: "gap-fill", label: "Gap fill", color: "#e8e8e8" },
  { id: "custom", label: "Other", color: "#a7b4bf" },
];

export const FEATURE_COUNT = GCODE_FEATURES.length; // 16
export const TRAVEL = 0;
export const OUTER_WALL = 1;
export const CUSTOM = 15;

/** The index of a feature id ("outer-wall"), or -1. */
export const featureIndex = (id: string): number => GCODE_FEATURES.findIndex((f) => f.id === id);

/**
 * A slicer's feature name (the text after `;TYPE:` or `; FEATURE:`) as one of the ids above. Unknown names are
 * "custom" (index 15), never an error: a new slicer feature draws in the neutral colour until it is mapped.
 */
export function featureFromName(name: string): number {
  const n = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!n) return CUSTOM;
  const has = (...words: string[]) => words.some((w) => n.includes(w));
  if (has("support interface", "support material interface", "support transition")) return 10;
  if (has("support")) return 9;
  if (has("overhang")) return 3;
  if (has("ironing")) return 13;
  if (has("bridge")) return 8;
  if (has("gap")) return 14;
  if (has("top")) return 6;
  if (has("bottom")) return 7;
  if (has("skirt", "brim")) return 11;
  if (has("prime tower", "wipe tower", "prime", "purge")) return 12;
  // Cura's SKIN is solid infill (top and bottom skins are not told apart in its comments)
  if (has("solid", "skin")) return 5;
  if (has("infill", "fill")) return 4;
  if (has("outer", "external", "wall outer")) return 1;
  if (has("inner", "perimeter", "wall")) return 2;
  if (has("travel")) return TRAVEL;
  return CUSTOM;
}
