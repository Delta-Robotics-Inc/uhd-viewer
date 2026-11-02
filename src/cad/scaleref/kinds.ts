/**
 * The scale references' kinds, words and settings (R4-B, 2026-11-02). Pure apart from the optional local memory.
 *
 * Kevin: "There is a 3D model of a banana that we use for scale ... I had a dedicated icon in the toolbar with a
 * tooltip that said 'banana for scale.'" "Can you also use cubes for scale and a benchy for scale? Add a little up
 * chevron to select which one (banana = default)."
 *
 * Settings (stack core settings.ts, R4-B): `viewer.scaleReference` ("banana" | "cube" | "benchy", DEFAULT banana)
 * and `viewer.units` ("mm" | "in", DEFAULT mm). A host passes them on `ViewerOptions.settings` as `scaleReference`
 * and `units` (read here from the raw settings object, so an older host that sends neither gets the DEFAULTs); the
 * person's choice in the toolbar is written back through the hub's `saveSetting` when a host offers one, and kept in
 * this browser's storage otherwise (DEFAULT: per viewer origin, a convenience only).
 */
import { DEFAULT_UNITS, readUnits, type Units } from "../grid/levels";

export type ScaleKind = "banana" | "cube" | "benchy";
export const SCALE_KINDS: readonly ScaleKind[] = ["banana", "cube", "benchy"];
/** DEFAULT (Kevin): the banana. */
export const DEFAULT_SCALE_KIND: ScaleKind = "banana";

/** Each kind's words and Lucide icon (DEFAULT R4-B: the toolbar's icon follows the choice). */
export const SCALE_KIND_INFO: Readonly<Record<ScaleKind, { label: string; tooltip: string; icon: string; detail: string }>> = Object.freeze({
  banana: { label: "Banana", tooltip: "Banana for scale", icon: "banana", detail: "A real banana, scanned at true size" },
  cube: { label: "Cube", tooltip: "Cube for scale", icon: "box", detail: "One cube, a power of ten of the units, with a grid on its faces" },
  benchy: { label: "Benchy", tooltip: "Benchy for scale", icon: "ship", detail: "#3DBenchy, 60 x 31 x 48 mm (3DBenchy.com, CC0)" },
});

export const readScaleKind = (v: unknown): ScaleKind => (SCALE_KINDS.includes(v as ScaleKind) ? (v as ScaleKind) : DEFAULT_SCALE_KIND);

/** The toolbar button's tooltip: the choice, and whether it is shown. */
export function scaleButtonLabel(kind: ScaleKind, shown: boolean): string {
  const t = SCALE_KIND_INFO[kind].tooltip;
  return shown ? `${t}: on` : t;
}

export interface ScaleSettings {
  units: Units;
  scaleReference: ScaleKind;
}

/** DEFAULT (R4-B): the browser storage key that remembers the choice where no host saves settings. */
export const SCALE_STORAGE_KEY = "uhd-viewer.scale";

/** Storage that may be missing or throw (private windows, webviews without storage). */
type KV = Pick<Storage, "getItem" | "setItem">;
const storage = (): KV | undefined => {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
};

/**
 * The settings in force: what the host passed (`settings.units`, `settings.scaleReference`) wins; else what this
 * browser remembers; else the DEFAULTs.
 */
export function readScaleSettings(hostSettings: unknown, kv: KV | undefined = storage()): ScaleSettings {
  const o = hostSettings && typeof hostSettings === "object" && !Array.isArray(hostSettings) ? (hostSettings as Record<string, unknown>) : {};
  let kept: Record<string, unknown> = {};
  try {
    const raw = kv?.getItem(SCALE_STORAGE_KEY);
    if (raw && raw.length < 512) kept = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    kept = {};
  }
  return {
    units: "units" in o ? readUnits(o.units) : kept.units !== undefined ? readUnits(kept.units) : DEFAULT_UNITS,
    scaleReference: "scaleReference" in o ? readScaleKind(o.scaleReference) : kept.scaleReference !== undefined ? readScaleKind(kept.scaleReference) : DEFAULT_SCALE_KIND,
  };
}

/** The stack setting keys of the two values (core settings.ts). */
export const SCALE_SETTING_KEYS = { units: "viewer.units", scaleReference: "viewer.scaleReference" } as const;

/**
 * Remember a choice: in this browser, and through `save` (the hub's `saveSetting`, when a host offers one) under the
 * stack's key. Never throws.
 */
export function rememberScaleSetting<K extends keyof ScaleSettings>(key: K, value: ScaleSettings[K], save?: (key: string, value: unknown) => unknown, kv: KV | undefined = storage()): void {
  try {
    const raw = kv?.getItem(SCALE_STORAGE_KEY);
    const kept = raw && raw.length < 512 ? (JSON.parse(raw) as Record<string, unknown>) : {};
    kv?.setItem(SCALE_STORAGE_KEY, JSON.stringify({ ...kept, [key]: value }));
  } catch {
    // a convenience only
  }
  try {
    save?.(SCALE_SETTING_KEYS[key], value);
  } catch (e) {
    console.warn("[cad] saving the scale setting failed:", e);
  }
}
