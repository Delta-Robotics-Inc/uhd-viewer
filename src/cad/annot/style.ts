/**
 * The look of callouts and DRC markers (PB-1184), after the callout and
 * marker sheet (round-2 notes, concept A) and Kevin's rulings: one accent,
 * the selection blue (`--uhd-accent`); orange only for DRC risk; severity by
 * shape and glyph as well as colour (colour is never the only signal: all four
 * hues collapse to olive under deuteranopia).
 *
 * Colours are W3-C's style tokens (PB-1189, `src/theme/themes.ts`, CSS
 * variables `--uhd-<kebab>`), with the sheet's values as fallbacks:
 * `drcError`, `drcRisk`, `drcWarning`, `drcInfo`, `drcPass`, `drcUnknown`
 * (each 4.5:1 on its theme), and `calloutSurface`, `calloutBorder`,
 * `calloutText`, `calloutLabel`, `calloutLeader`, `calloutLeaderWidth`,
 * `calloutDot`, `calloutGhost`.
 *
 * The stylesheet is injected once per document (a string, not a CSS import),
 * so the library build, the headless page and a VS Code webview (style-src
 * 'unsafe-inline') all get it.
 */
import type { FindingSeverity } from "./findings-anchors";

/** The sheet's colours (dark ground / paper), WCAG-checked in the round-2 note §E.3. */
export const DRC_COLOURS: Record<FindingSeverity, { dark: string; light: string }> = {
  fail: { dark: "#ef4444", light: "#b91c1c" },
  risk: { dark: "#ff7a1a", light: "#c2410c" },
  warn: { dark: "#eed202", light: "#8a6a00" },
  info: { dark: "#8b949e", light: "#57606a" },
  pass: { dark: "#22c55e", light: "#15803d" },
  unknown: { dark: "#8b949e", light: "#57606a" },
};

/** The CSS variable of a severity's colour (W3-C's token names). */
export const SEVERITY_VAR: Record<FindingSeverity, string> = { fail: "--uhd-drc-error", risk: "--uhd-drc-risk", warn: "--uhd-drc-warning", info: "--uhd-drc-info", pass: "--uhd-drc-pass", unknown: "--uhd-drc-unknown" };

export const SEVERITY_LABEL: Record<FindingSeverity, string> = { fail: "Fail", risk: "Risk", warn: "Warn", info: "Info", pass: "Pass", unknown: "Unknown" };
export const SEVERITY_SHAPE: Record<FindingSeverity, string> = { fail: "octagon", risk: "diamond", warn: "triangle", info: "circle", pass: "circle", unknown: "dashed circle" };

/**
 * Hover reveal (round-2 note §D.2): intent delay, leader scan, card unfold, retract. The note gives "about"
 * values; these are the ones taken (DEFAULT, PB-1184).
 */
export const REVEAL_MS = { intent: 80, leader: 180, card: 120, retract: 120 } as const;

/** A severity marker as SVG markup in a 20 x 20 box (shape + glyph), for the DOM (the Findings control, cards). */
export function markerSvg(s: FindingSeverity, size = 14): string {
  const c = `var(${SEVERITY_VAR[s]}, ${DRC_COLOURS[s].dark})`;
  const glyph = `stroke="var(--uhd-drc-glyph, #111)" stroke-width="2" stroke-linecap="round" fill="none"`;
  let body = "";
  if (s === "fail") body = `<path d="M7 1h6l6 6v6l-6 6H7l-6-6V7z" fill="${c}"/><path d="M7 7l6 6M13 7l-6 6" ${glyph}/>`;
  else if (s === "risk") body = `<path d="M10 0.8L19.2 10 10 19.2 0.8 10z" fill="${c}"/><path d="M10 5.5v5.2" ${glyph}/><circle cx="10" cy="14" r="1.2" fill="var(--uhd-drc-glyph, #111)"/>`;
  else if (s === "warn") body = `<path d="M10 1.5L19 18H1z" fill="${c}"/><path d="M10 7v5" ${glyph}/><circle cx="10" cy="14.8" r="1.1" fill="var(--uhd-drc-glyph, #111)"/>`;
  else if (s === "pass") body = `<circle cx="10" cy="10" r="9" fill="${c}"/><path d="M6 10.5l2.8 2.8L14.5 7.5" ${glyph}/>`;
  else if (s === "unknown") body = `<circle cx="10" cy="10" r="8.2" fill="none" stroke="${c}" stroke-width="1.6" stroke-dasharray="2.6 2.2"/><path d="M8 8a2 2 0 1 1 2.6 1.9c-.5.2-.6.6-.6 1.1" stroke="${c}" stroke-width="1.6" fill="none" stroke-linecap="round"/><circle cx="10" cy="14.2" r="1" fill="${c}"/>`;
  else body = `<circle cx="10" cy="10" r="9" fill="${c}"/><path d="M10 9v5" ${glyph}/><circle cx="10" cy="6.3" r="1.1" fill="var(--uhd-drc-glyph, #111)"/>`;
  return `<svg class="annot-sev sev-${s}" width="${size}" height="${size}" viewBox="0 0 20 20" aria-hidden="true">${body}</svg>`;
}

/** Draws a severity marker on a 2D canvas (the depth-tested sprite's texture), `px` square. */
export function drawMarker(ctx: CanvasRenderingContext2D, s: FindingSeverity, colour: string, px: number, count = 1): void {
  const k = px / 20;
  ctx.save();
  ctx.clearRect(0, 0, px, px);
  ctx.scale(k, k);
  const glyph = "#111";
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.fillStyle = colour;
  ctx.strokeStyle = glyph;
  const poly = (pts: number[]) => {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 2) (i ? ctx.lineTo : ctx.moveTo).call(ctx, pts[i], pts[i + 1]);
    ctx.closePath();
  };
  const dot = (x: number, y: number, r: number, fill = glyph) => {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
  };
  const line = (pts: number[]) => {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 2) (i ? ctx.lineTo : ctx.moveTo).call(ctx, pts[i], pts[i + 1]);
    ctx.stroke();
  };
  if (s === "fail") {
    poly([7, 1, 13, 1, 19, 7, 19, 13, 13, 19, 7, 19, 1, 13, 1, 7]);
    ctx.fill();
    line([7, 7, 13, 13]);
    line([13, 7, 7, 13]);
  } else if (s === "risk") {
    poly([10, 0.8, 19.2, 10, 10, 19.2, 0.8, 10]);
    ctx.fill();
    line([10, 5.5, 10, 10.7]);
    dot(10, 14, 1.2);
  } else if (s === "warn") {
    poly([10, 1.5, 19, 18, 1, 18]);
    ctx.fill();
    line([10, 7, 10, 12]);
    dot(10, 14.8, 1.1);
  } else if (s === "unknown") {
    ctx.setLineDash([2.6, 2.2]);
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(10, 10, 8.2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    dot(10, 14.2, 1, colour);
  } else {
    dot(10, 10, 9, colour);
    if (s === "pass") line([6, 10.5, 8.8, 13.3, 14.5, 7.5]);
    else {
      line([10, 9, 10, 14]);
      dot(10, 6.3, 1.1);
    }
  }
  if (count > 1) {
    // a count badge, top right (several findings at one anchor: one marker in the worst severity)
    dot(16.5, 3.5, 3.6, "#f5f5f5");
    ctx.fillStyle = "#111";
    ctx.font = "bold 5.6px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(count > 9 ? "9+" : String(count), 16.5, 3.7);
  }
  ctx.restore();
}

/** Injects the stylesheet once into `doc`. */
export function ensureAnnotStyles(doc: Document = document): void {
  if (doc.getElementById("uhd-annot-css")) return;
  const el = doc.createElement("style");
  el.id = "uhd-annot-css";
  el.textContent = ANNOT_CSS;
  doc.head.appendChild(el);
}

/** Leader and ring stroke in CSS px: constant on screen (round-2 note §E.3: 1.25 dark, 1 light; DEFAULT 1.25). */
export const LEADER_PX = 1.25;
/** The leader's terminal dot radius (4 px diameter, the sheet's terminal). DEFAULT. */
export const TERMINAL_R = 2;

const sev = (s: FindingSeverity) => `var(${SEVERITY_VAR[s]}, ${DRC_COLOURS[s].dark})`;

export const ANNOT_CSS = `
.cad-annot { position: absolute; inset: 0; pointer-events: none; z-index: 21; font-family: var(--uhd-font-label, ui-monospace, monospace); }
.cad-annot svg.annot-ink { position: absolute; inset: 0; overflow: visible; }
.cad-annot .annot-leader { fill: none; stroke: var(--uhd-callout-leader, var(--uhd-accent, #5aa9ff)); stroke-width: var(--uhd-callout-leader-width, ${LEADER_PX}px); stroke-linejoin: miter; vector-effect: non-scaling-stroke; }
.cad-annot .annot-terminal { fill: var(--uhd-callout-dot, var(--uhd-accent, #5aa9ff)); }
.cad-annot .annot-ring { fill: none; stroke: var(--uhd-accent, #5aa9ff); stroke-width: 1.5; }
.cad-annot .annot-ring.behind { stroke-dasharray: 4 3; opacity: 0.35; }
.cad-annot .annot-arrow { fill: none; stroke: var(--uhd-accent, #5aa9ff); stroke-width: ${LEADER_PX}; }
.cad-annot .annot-arrowhead { fill: var(--uhd-accent, #5aa9ff); }
${(["fail", "risk", "warn", "info", "pass", "unknown"] as FindingSeverity[])
  .map((s) => `.cad-annot .tone-${s} .annot-leader, .cad-annot .annot-leader.tone-${s}, .cad-annot .annot-ring.tone-${s} { stroke: ${sev(s)}; } .cad-annot .annot-terminal.tone-${s} { fill: ${sev(s)}; } .cad-annot .annot-sheet.tone-${s} .annot-title { color: ${sev(s)}; } .cad-annot .annot-sheet.tone-${s} { border-bottom-color: ${sev(s)}; }`)
  .join("\n")}
.cad-annot .annot-leader.tone-neutral, .cad-annot .annot-ring.tone-neutral { stroke: var(--uhd-text-muted, #8b949e); }
.cad-annot .annot-sheet {
  position: absolute; left: 0; top: 0; pointer-events: auto; cursor: default;
  min-width: 96px; max-width: 280px; padding: 4px 8px 5px 8px;
  color: var(--uhd-callout-text, var(--uhd-text, #e5e5e5));
  background: var(--uhd-callout-surface, color-mix(in oklab, var(--uhd-surface, #1c1c1c) 90%, transparent));
  outline: 1px solid var(--uhd-callout-border, transparent);
  border-bottom: var(--uhd-callout-leader-width, ${LEADER_PX}px) solid var(--uhd-callout-leader, var(--uhd-accent, #5aa9ff));
  font-size: 10.5px; line-height: 1.35;
  will-change: transform; transform-origin: 0 100%;
  transition: opacity 120ms ease-out, clip-path ${REVEAL_MS.card}ms ease-out;
  clip-path: inset(0 0 0 0);
}
.cad-annot .annot-sheet.side-l { transform-origin: 100% 100%; }
.cad-annot .annot-title { font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--uhd-callout-label, var(--uhd-text, #e5e5e5)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; gap: 6px; align-items: center; }
.cad-annot .annot-rows { display: grid; grid-template-columns: auto 1fr; column-gap: 8px; margin-top: 2px; }
.cad-annot .annot-k { color: var(--uhd-text-muted, #8b949e); letter-spacing: 0.06em; font-size: 9.5px; }
.cad-annot .annot-v { color: var(--uhd-text, #e5e5e5); font-family: var(--uhd-font-sans, system-ui, sans-serif); overflow-wrap: anywhere; }
.cad-annot .annot-text { font-family: var(--uhd-font-sans, system-ui, sans-serif); margin-top: 2px; color: var(--uhd-text, #e5e5e5); }
.cad-annot .annot-by { margin-top: 2px; font-size: 9px; letter-spacing: 0.06em; color: var(--uhd-text-muted, #8b949e); text-transform: uppercase; }
.cad-annot .annot-sheet.ghost { opacity: 0.3; }
.cad-annot .annot-sheet.closed { opacity: 0; clip-path: inset(0 100% 0 0); pointer-events: none; transition: opacity ${REVEAL_MS.retract}ms ease-in, clip-path ${REVEAL_MS.retract}ms ease-in; }
.cad-annot .annot-sheet.side-l.closed { clip-path: inset(0 0 0 100%); }
.cad-annot .annot-sheet.reveal { transition-delay: ${REVEAL_MS.intent + REVEAL_MS.leader}ms; }
.cad-annot path.annot-leader.reveal { transition: stroke-dashoffset ${REVEAL_MS.leader}ms ease-out ${REVEAL_MS.intent}ms; }
.cad-annot path.annot-leader.retract { transition: stroke-dashoffset ${REVEAL_MS.retract}ms ease-in; }
.cad-annot .annot-pin { position: absolute; left: 0; top: 0; width: 16px; height: 16px; margin: -8px 0 0 -8px; border-radius: 50%; background: var(--uhd-accent, #5aa9ff); color: var(--uhd-text-on-accent, #fff); font-size: 9.5px; display: grid; place-items: center; pointer-events: auto; cursor: pointer; border: 0; padding: 0; }
.cad-annot .annot-hit { position: absolute; left: 0; top: 0; width: 22px; height: 22px; margin: -11px 0 0 -11px; border-radius: 50%; background: transparent; border: 0; padding: 0; pointer-events: auto; cursor: pointer; }
.cad-annot .annot-hit:focus-visible { outline: 1.5px solid var(--uhd-focus-ring, #5aa9ff); outline-offset: 1px; }
.cad-annot .annot-hit.pinned { box-shadow: 0 0 0 1.5px currentColor; }
.cad-annot .annot-chip { position: absolute; left: 0; top: 0; pointer-events: none; padding: 1px 6px; border-radius: 8px; font-size: 9.5px; letter-spacing: 0.04em; white-space: nowrap; color: var(--uhd-text, #e5e5e5); background: color-mix(in oklab, var(--uhd-surface, #1c1c1c) 85%, transparent); border: 1px dashed var(--uhd-accent, #5aa9ff); }
.cad-annot .annot-edge { position: absolute; left: 0; top: 0; width: 0; height: 0; border: 6px solid transparent; border-left-color: var(--uhd-accent, #5aa9ff); margin: -6px 0 0 -3px; pointer-events: none; }
.annot-sev { flex: none; vertical-align: -2px; }
/* the Findings control */
.annot-findings { min-width: 260px; max-width: min(360px, calc(100vw - 32px)); max-height: min(420px, 70vh); overflow: auto; }
.annot-findings .annot-chips { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0 6px; }
.annot-findings .annot-chip-btn { display: inline-flex; gap: 4px; align-items: center; padding: 2px 7px; border-radius: 6px; border: 1px solid var(--uhd-border, #333); background: transparent; color: var(--uhd-text, #e5e5e5); font: inherit; font-size: 11px; cursor: pointer; }
.annot-findings .annot-chip-btn[aria-pressed="false"] { opacity: 0.45; }
.annot-findings .annot-row { display: grid; grid-template-columns: 16px 1fr; gap: 6px; width: 100%; text-align: left; padding: 4px 6px; border: 0; border-radius: 5px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.annot-findings .annot-row:hover, .annot-findings .annot-row[aria-current="true"] { background: var(--uhd-accent-tint, rgba(90,169,255,.15)); }
.annot-findings .annot-row-code { font-size: 10.5px; letter-spacing: 0.06em; text-transform: uppercase; }
.annot-findings .annot-row-msg { font-size: 11px; color: var(--uhd-text-muted, #8b949e); font-family: var(--uhd-font-sans, system-ui, sans-serif); overflow-wrap: anywhere; }
.annot-findings .annot-noloc { font-size: 9.5px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--uhd-text-muted, #8b949e); margin-left: 4px; }
.annot-findings .annot-group { margin-top: 6px; font-size: 9.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--uhd-text-muted, #8b949e); }
.annot-findings .annot-actions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
@media (prefers-reduced-motion: reduce) {
  .cad-annot .annot-sheet, .cad-annot .annot-sheet.closed, .cad-annot path.annot-leader.reveal, .cad-annot path.annot-leader.retract { transition: none !important; }
}
/* a narrow tab (320 px, PB-1184 acceptance): smaller sheets, rows still legible */
@container (max-width: 420px) { .cad-annot .annot-sheet { max-width: 180px; font-size: 10px; } }
@media (max-width: 420px) { .cad-annot .annot-sheet { max-width: 180px; } }
`;
