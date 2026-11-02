/**
 * The look of dimensions, angles and the measure hint (R3-C), after concept B (image 1: the motor-to-motor
 * "158.4 mm NOMINAL" chip, the GPS mast's NOW / REST / HARD STOP / 0° labels). Colours are theme tokens
 * (`dimLine`, `dimExtension`, `dimChip`, `dimChipBorder`, `dimText`, `dimTierSurface`, `explodePath` in
 * src/theme/themes.ts, CSS variables `--uhd-<kebab>`), with the dark set's values as fallbacks; the angle's NOW
 * uses the accent (selection blue) and a hard stop the fail red (`drcError`). The stylesheet is injected once per
 * document, as the callout layer's is.
 */

/** Fallbacks when no theme is mounted (the dark set's values). */
export const DIM_FALLBACK = {
  line: "#d4d4d4",
  extension: "#8a8a8a",
  chip: "#1f1f1f",
  chipBorder: "#4a4a4a",
  text: "#e5e5e5",
  tier: "#333333",
  path: "#5c5c5c",
  accent: "#5aa9ff",
  stop: "#f87171",
} as const;

/** End dots of a dimension, CSS px (DEFAULT: the concept's small dots). */
export const DIM_DOT_PX = 5;
/** Dash and gap of the dashed lines, CSS px (DEFAULT). */
export const DASH_PX = 5;
export const GAP_PX = 4;
/** The ghost of a dimension's or angle's solid lines where a part hides them (DEFAULT 22 %, as the callout ghosts' feel). */
export const DIM_GHOST_OPACITY = 0.22;

export const DIMS_CSS = `
.cad-dims { position: absolute; inset: 0; pointer-events: none; z-index: 20; font-family: var(--uhd-font-label, ui-monospace, monospace); }
.cad-dims .dim-chip {
  position: absolute; left: 0; top: 0; display: inline-flex; align-items: center; gap: 8px; white-space: nowrap;
  padding: 3px 4px 3px 9px; border-radius: 6px; font-size: 12px; line-height: 16px; letter-spacing: 0.02em;
  color: var(--uhd-dim-text, ${DIM_FALLBACK.text});
  background: var(--uhd-dim-chip, ${DIM_FALLBACK.chip});
  border: 1px solid var(--uhd-dim-chip-border, ${DIM_FALLBACK.chipBorder});
  box-shadow: var(--uhd-shadow-sm, 0 1px 2px rgba(0,0,0,.25));
  will-change: transform;
}
.cad-dims .dim-chip .dim-tier {
  padding: 1px 6px; border-radius: 4px; font-size: 9.5px; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--uhd-dim-text, ${DIM_FALLBACK.text}); background: var(--uhd-dim-tier-surface, ${DIM_FALLBACK.tier});
}
.cad-dims .dim-chip .dim-title { color: var(--uhd-text-muted, #8b949e); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; }
.cad-dims .dim-ang {
  position: absolute; left: 0; top: 0; white-space: nowrap; font-size: 11px; line-height: 14px; letter-spacing: 0.08em;
  text-transform: uppercase; padding: 1px 4px; border-radius: 4px; will-change: transform;
  color: var(--uhd-dim-text, ${DIM_FALLBACK.text});
  /* a faint chip of the label surface so a label reads over a light part as over the void (R3-C, DEFAULT 85 %) */
  background: color-mix(in oklab, var(--uhd-dim-chip, ${DIM_FALLBACK.chip}) 85%, transparent);
}
.cad-dims .dim-ang.now { color: var(--uhd-accent, ${DIM_FALLBACK.accent}); }
.cad-dims .dim-ang.rest, .cad-dims .dim-ang.zero { color: var(--uhd-text-muted, #8b949e); }
.cad-dims .dim-ang.stop { color: var(--uhd-drc-error, ${DIM_FALLBACK.stop}); display: inline-flex; align-items: center; gap: 5px; }
/* the hard stop's small square (concept B), drawn with the label so it never drifts from it */
.cad-dims .dim-ang.stop::before { content: ""; width: 7px; height: 7px; border: 1.5px solid currentColor; box-sizing: border-box; }
.cad-dims .dim-hint {
  position: absolute; left: 50%; top: 64px; transform: translateX(-50%); white-space: nowrap; pointer-events: none;
  padding: 4px 10px; border-radius: 6px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--uhd-dim-text, ${DIM_FALLBACK.text}); background: var(--uhd-dim-chip, ${DIM_FALLBACK.chip});
  border: 1px dashed var(--uhd-accent, ${DIM_FALLBACK.accent});
}
@media (max-width: 420px) { .cad-dims .dim-chip { font-size: 11px; gap: 5px; } .cad-dims .dim-ang { font-size: 10px; } }
`;

/** Injects the stylesheet once into `doc`. */
export function ensureDimsStyles(doc: Document = document): void {
  if (doc.getElementById("uhd-dims-css")) return;
  const el = doc.createElement("style");
  el.id = "uhd-dims-css";
  el.textContent = DIMS_CSS;
  doc.head.appendChild(el);
}
