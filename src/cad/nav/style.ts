/**
 * The look of the 3D view's navigation chrome (R2-A, 2026-11-02): back and forward beside the level's name, the
 * part menu's title and disabled items (the menu itself is the app's `.context-menu`), the hover tooltip. Theme
 * tokens only (`--uhd-*`), the app's radius. Injected once per document as a string, like the annotation sheet, so
 * the library, the headless page and a VS Code webview all get it.
 */
export const NAV_CSS = `
.cad-scope-head { display: flex; align-items: center; gap: 4px; min-width: 0; }
.cad-nav { display: inline-flex; gap: 2px; margin: -2px 0 2px -4px; pointer-events: auto; }
.cad-nav-btn {
  display: grid; place-items: center; width: 22px; height: 22px; padding: 0;
  border: 0; border-radius: calc(var(--uhd-radius, 6px) - 2px); background: transparent;
  color: var(--uhd-text-muted); cursor: pointer;
}
.cad-nav-btn:hover:not(:disabled), .cad-nav-btn:focus-visible { background: var(--uhd-active); color: var(--uhd-text); outline: none; }
.cad-nav-btn:disabled { opacity: 0.35; cursor: default; }
.cad-part-menu { position: fixed; z-index: 60; }
.cad-part-menu-title {
  padding: 4px 8px 6px; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font: 10.5px/1.2 var(--uhd-font-label); letter-spacing: 0.6px; text-transform: uppercase; color: var(--uhd-text-muted);
}
.cad-part-menu button { border: 0; background: transparent; cursor: pointer; }
.cad-part-menu button[aria-disabled="true"] { color: var(--uhd-text-faint); cursor: default; }
.cad-part-menu button[aria-disabled="true"]:hover { background: transparent; }
.cad-part-menu button[aria-disabled="true"] .context-menu-icon { color: var(--uhd-text-faint); }
.cad-part-menu button[aria-checked="true"] .context-menu-icon { color: var(--uhd-accent); }
.cad-tip {
  position: absolute; z-index: 30; pointer-events: none; max-width: 300px;
  padding: 4px 8px; border-radius: var(--uhd-radius, 6px);
  background: var(--uhd-surface-raised); border: 1px solid var(--uhd-border); box-shadow: var(--uhd-shadow-md);
  font: 12px/1.35 var(--uhd-font-ui); color: var(--uhd-text);
}
.cad-tip-title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cad-tip-long { padding: 6px 10px 7px; }
.cad-tip-rows { display: grid; grid-template-columns: auto 1fr; gap: 1px 10px; margin: 5px 0 0; }
.cad-tip-rows dt { font: 10px/1.6 var(--uhd-font-label); letter-spacing: 0.5px; text-transform: uppercase; color: var(--uhd-text-muted); }
.cad-tip-rows dd { margin: 0; overflow-wrap: anywhere; }
.cad-tip-hint { margin-top: 5px; font-size: 11px; color: var(--uhd-text-muted); }
@media (prefers-reduced-motion: no-preference) { .cad-tip { transition: opacity 80ms linear; } }
`;

/** Puts the sheet in the document once (no-op without a document). */
export function ensureNavStyle(doc: Document | undefined = typeof document === "undefined" ? undefined : document): void {
  if (!doc || doc.getElementById("uhd-nav-css")) return;
  const el = doc.createElement("style");
  el.id = "uhd-nav-css";
  el.textContent = NAV_CSS;
  doc.head.appendChild(el);
}
