/**
 * The assembly timeline's look (R3-B, 2026-11-02, Kevin's chosen concept, image 1's bottom panel): a card on the
 * scene's ground with a hairline border and the app's radius, mono uppercase labels, the accent for the playhead and
 * the moving segment, the DRC red for contacts. Theme tokens only (`--uhd-*`), so the dark and paper themes (and a
 * VS Code theme) both hold; injected once per document like the navigation and annotation sheets.
 *
 * Docking: the panel is a sibling of `.cad-canvas` inside `.cad-view` (CadView's mount). While it shows, `.cad-view`
 * becomes a column, so the canvas, and the renderer with it (scene.ts resizes on its container), gets shorter and the
 * floating toolbar sits right above the panel: "pop up underneath the toolbar" without covering the model. Its right
 * edge leaves the floating inspector's width (app.css's numbers), its left the host's inset (the Protoboard look's
 * hierarchy panel).
 */
export const TIMELINE_CSS = `
.cad-view:has(> .cad-timeline) { flex-direction: column; background: var(--uhd-scene-background, var(--uhd-background)); }
.cad-view:has(> .cad-timeline) > .cad-canvas { flex: 1 1 auto; min-height: 0; }
.cad-timeline {
  --tl-label: 92px; --tl-pad: 14px;
  position: relative; flex: 0 0 auto; z-index: 20;
  margin: 0 8px 8px calc(var(--uhd-inset-left, 0px) + 8px);
  background: var(--uhd-surface); border: 1px solid var(--uhd-border); border-radius: var(--uhd-radius, 8px);
  box-shadow: var(--uhd-shadow-md); color: var(--uhd-text);
  font: 11px/1.3 var(--uhd-font-label); letter-spacing: 0.06em;
  user-select: none; outline: none; overflow: hidden;
}
.cad-view:has(> .cad-inspector) > .cad-timeline { margin-right: calc(min(360px, 100% - 64px) + 12px); }
@media (max-width: 900px) { .cad-view:has(> .cad-inspector) > .cad-timeline { margin-right: calc(min(300px, 100% - 96px) + 12px); } }
@media (max-width: 700px) { .cad-timeline { margin-left: 8px; } }
.cad-timeline:focus-visible { box-shadow: 0 0 0 2px var(--uhd-focus-ring), var(--uhd-shadow-md); }
@media (prefers-reduced-motion: no-preference) { .cad-timeline { animation: cad-tl-in 140ms ease-out; } }
@keyframes cad-tl-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

.cad-tl-head { display: flex; align-items: center; gap: 10px; padding: 8px var(--tl-pad) 6px 10px; min-width: 0; }
.cad-tl-btn {
  display: grid; place-items: center; flex: 0 0 auto; width: 30px; height: 30px; padding: 0; cursor: pointer;
  border: 1px solid var(--uhd-border); border-radius: calc(var(--uhd-radius, 8px) - 2px);
  background: transparent; color: var(--uhd-text-muted);
}
.cad-tl-btn:hover { background: var(--uhd-hover); color: var(--uhd-text); }
.cad-tl-btn:focus-visible { outline: 2px solid var(--uhd-focus-ring); outline-offset: 1px; }
.cad-tl-btn[aria-pressed="true"] { border-color: var(--uhd-accent); color: var(--uhd-accent); background: var(--uhd-accent-tint); }
.cad-tl-play { width: 32px; height: 32px; border-radius: 50%; border-color: var(--uhd-text); background: var(--uhd-text); color: var(--uhd-surface); }
.cad-tl-play:hover { background: var(--uhd-text); color: var(--uhd-surface); opacity: 0.88; }
.cad-tl-title { min-width: 0; flex: 1 1 auto; }
.cad-tl-name { font-size: 12px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--uhd-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cad-tl-sub { margin-top: 2px; font-size: 10.5px; letter-spacing: 0.02em; color: var(--uhd-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cad-tl-explode { display: flex; align-items: center; gap: 8px; flex: 0 1 230px; min-width: 120px; text-transform: uppercase; color: var(--uhd-text-muted); }
.cad-tl-explode input { flex: 1 1 auto; min-width: 50px; accent-color: var(--uhd-text); }
.cad-tl-explode output { min-width: 32px; text-align: right; color: var(--uhd-text); font-variant-numeric: tabular-nums; }
.cad-tl-chip {
  display: inline-flex; align-items: center; gap: 6px; flex: 0 1 auto; min-width: 0; padding: 4px 9px;
  border: 1px solid var(--uhd-border); border-radius: calc(var(--uhd-radius, 8px) - 2px);
  text-transform: uppercase; color: var(--uhd-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.cad-tl-fold { width: 26px; height: 26px; border-color: transparent; }

.cad-tl-tracks { position: relative; padding: 2px var(--tl-pad) 10px 0; }
.cad-tl-row { display: grid; grid-template-columns: var(--tl-label) 1fr; align-items: center; min-height: 26px; }
.cad-tl-label { padding-left: 14px; font-size: 10.5px; text-transform: uppercase; color: var(--uhd-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cad-tl-lane { position: relative; height: 26px; cursor: ew-resize; touch-action: none; }
/* three joint rows, then a scroll (DEFAULT); the box reaches 7 px past the lanes so a keyframe at the very end is not clipped */
.cad-tl-joints { max-height: 82px; overflow-y: auto; overflow-x: hidden; scrollbar-width: thin; padding-right: 7px; margin-right: -7px; }
.cad-tl-steps .cad-tl-lane { height: 24px; }
.cad-tl-stepchip {
  position: absolute; top: 2px; bottom: 2px; box-sizing: border-box; margin: 0 1px; padding: 0 6px; min-width: 6px;
  display: flex; align-items: center; gap: 5px; overflow: hidden; white-space: nowrap; cursor: pointer;
  border: 1px solid var(--uhd-border); border-radius: calc(var(--uhd-radius, 8px) - 4px);
  background: transparent; color: var(--uhd-text-muted); font: inherit; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em;
}
.cad-tl-stepchip[data-state="done"] { background: var(--uhd-muted); color: var(--uhd-text); }
/* the current chip: accent outline on the accent wash, its words in the text colour (the accent on its own wash is under 4.5:1) */
.cad-tl-stepchip[data-state="current"] { border-color: var(--uhd-accent); box-shadow: inset 0 0 0 1px var(--uhd-accent); color: var(--uhd-text); background: var(--uhd-accent-tint); z-index: 1; }
.cad-tl-stepchip[data-sub] { border-style: dashed; }
.cad-tl-stepchip:hover { color: var(--uhd-text); }
.cad-tl-stepchip:focus-visible { outline: 2px solid var(--uhd-focus-ring); outline-offset: 0; z-index: 2; }
.cad-tl-stepchip { container-type: inline-size; }
.cad-tl-stepchip .n { flex: 0 0 auto; }
/* a narrow chip shows its number only (the title is its tooltip): DEFAULT under 64 px */
@container (max-width: 64px) { .cad-tl-stepchip .t { display: none; } }
.cad-tl-stepchip .t { overflow: hidden; text-overflow: ellipsis; }
.cad-tl-line { position: absolute; left: 0; right: 0; top: 50%; height: 1px; background: var(--uhd-border); }
.cad-tl-seg { position: absolute; top: calc(50% - 1px); height: 2px; background: var(--uhd-text-faint); }
.cad-tl-seg[data-active] { background: var(--uhd-accent); }
.cad-tl-key {
  position: absolute; top: 50%; width: 9px; height: 9px; margin: -5px 0 0 -5px; transform: rotate(45deg);
  border: 1.5px solid var(--uhd-text-muted); background: var(--uhd-surface); box-sizing: border-box;
}
.cad-tl-key[data-on] { border-color: var(--uhd-accent); }
.cad-tl-key[data-held] { border-color: var(--uhd-drc-warning); }
.cad-tl-note { position: absolute; top: 50%; transform: translateY(-50%); padding: 0 6px; background: var(--uhd-surface); font-size: 10px; text-transform: uppercase; color: var(--uhd-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-sizing: border-box; pointer-events: none; }
.cad-tl-empty { position: absolute; left: 0; top: 50%; transform: translateY(-50%); padding-right: 6px; background: var(--uhd-surface); font-size: 10px; text-transform: uppercase; color: var(--uhd-text-muted); white-space: nowrap; }
.cad-tl-contact { position: absolute; top: 50%; width: 14px; height: 14px; margin: -7px 0 0 -7px; padding: 0; border: 0; background: transparent; color: var(--uhd-drc-error); cursor: pointer; }
.cad-tl-contact svg { display: block; }
.cad-tl-contact-note { color: var(--uhd-drc-error); }
/* a contact that lasts: a red span from where it starts to where it is last seen, ending in a short bar */
.cad-tl-span { position: absolute; top: calc(50% - 1px); height: 2px; background: var(--uhd-drc-error); pointer-events: none; }
.cad-tl-span::after { content: ""; position: absolute; right: -1px; top: -6px; width: 2px; height: 14px; background: var(--uhd-drc-error); }

.cad-tl-overlay { position: absolute; top: 0; bottom: 6px; left: var(--tl-label); right: var(--tl-pad); pointer-events: none; }
.cad-tl-playhead { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--uhd-accent); }
.cad-tl-playhead::before { content: ""; position: absolute; top: -3px; left: -4px; width: 10px; height: 10px; border-radius: 50%; background: var(--uhd-accent); }

.cad-timeline[data-collapsed] .cad-tl-head { padding: 5px 10px; }
.cad-timeline[data-collapsed] .cad-tl-play { width: 26px; height: 26px; }
`;

/** Puts the sheet in the document once (no-op without a document). */
export function ensureTimelineStyle(doc: Document | undefined = typeof document === "undefined" ? undefined : document): void {
  if (!doc || doc.getElementById("uhd-timeline-css")) return;
  const el = doc.createElement("style");
  el.id = "uhd-timeline-css";
  el.textContent = TIMELINE_CSS;
  doc.head.appendChild(el);
}
