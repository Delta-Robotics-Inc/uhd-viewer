/**
 * The person's viewer settings a host passes (R2-E, J1; R2 integration, 2026-11-02): `ViewerOptions.settings`, put on
 * the page's view hub by the mount. Read where they apply: the long hover of callouts and part tooltips, the model
 * info card's first state; `zoomToCursor` goes to the hub's camera controls (R1-A, E1) here. `openModelsInPlace` is
 * the host's own (it turns a `replace` navigate into a new tab); the viewer only carries it.
 */
import type { ViewerHostSettings } from "../api";
import { LONG_HOVER_MS } from "./annot/style";
import { viewHub, type ViewHub } from "./state/hub";

/** The long-hover delay a host may set, ms (R2-E's range for `viewer.hoverLongDelayMs`). */
export const HOVER_LONG_MIN_MS = 200;
export const HOVER_LONG_MAX_MS = 5000;

/** Every setting's DEFAULT: today's behaviour (R2-E's DEFAULTs, the same values). */
export const VIEWER_SETTING_DEFAULTS: Readonly<Required<ViewerHostSettings>> = Object.freeze({
  openModelsInPlace: true,
  zoomToCursor: true,
  modelInfo: true,
  hoverLongDelayMs: LONG_HOVER_MS,
});

/** The settings in force: each a value the host gave when it is well formed (the delay within its range), else its DEFAULT. */
export function readViewerSettings(s: unknown): Required<ViewerHostSettings> {
  const o = s && typeof s === "object" && !Array.isArray(s) ? (s as Record<string, unknown>) : {};
  const bool = (k: keyof ViewerHostSettings) => (typeof o[k] === "boolean" ? (o[k] as boolean) : (VIEWER_SETTING_DEFAULTS[k] as boolean));
  const ms = o.hoverLongDelayMs;
  return {
    openModelsInPlace: bool("openModelsInPlace"),
    zoomToCursor: bool("zoomToCursor"),
    modelInfo: bool("modelInfo"),
    hoverLongDelayMs: typeof ms === "number" && Number.isFinite(ms) && ms >= HOVER_LONG_MIN_MS && ms <= HOVER_LONG_MAX_MS ? Math.round(ms) : VIEWER_SETTING_DEFAULTS.hoverLongDelayMs,
  };
}

/** The settings on the page's hub (the DEFAULTs when no host gave any). */
export function viewerSettings(hub: ViewHub = viewHub()): Required<ViewerHostSettings> {
  return readViewerSettings(hub.settings);
}

/** The long-hover tier's delay (callouts and part tooltips), ms. */
export function longHoverMs(hub?: ViewHub): number {
  return viewerSettings(hub).hoverLongDelayMs;
}

/**
 * Puts a host's settings on the hub (the mount, at mount and on `update({ settings })`). A host that gives
 * `zoomToCursor` sets the hub's camera controls: the 3D view mounted now at once, any mounted later from
 * `controlOptions` (R1-A). Settings absent leave the controls as they are (a URL's `?zoomToCursor=0` keeps working).
 */
export function applyViewerSettings(hub: ViewHub, settings: ViewerHostSettings | undefined): void {
  hub.settings = settings ? { ...settings } : undefined;
  if (typeof settings?.zoomToCursor !== "boolean") return;
  hub.controlOptions = { ...hub.controlOptions, zoomToCursor: settings.zoomToCursor };
  hub.controls?.({ zoomToCursor: settings.zoomToCursor });
}
