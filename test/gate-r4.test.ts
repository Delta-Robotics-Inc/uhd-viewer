/**
 * Wave R4 gate (2026-11-02): R4-B's settings plumbing on the viewer's side. The host passes `units` and
 * `scaleReference` in its settings (they win over this browser's storage); the toolbar's choice reaches the host as
 * `uhd-viewer:setting` (`ViewerOptions.onSetting`, or a frame's parent), which the mount puts on the hub as
 * `saveSetting`.
 */
import { describe, expect, it } from "vitest";
import type { ViewerOptions } from "../src/api";
import { deliver } from "../src/host/channel";
import { isViewerEvent } from "../src/host/protocol";
import { readScaleSettings, rememberScaleSetting } from "../src/cad/scaleref/kinds";
import { readViewerSettings, VIEWER_SETTING_DEFAULTS } from "../src/cad/viewerSettings";
import { WheelNotches, zoomLimits, MIN_DISTANCE_FLOOR_MM } from "../src/cad/camera/zoom";
import { voidMenuFor } from "../src/cad/nav/void";

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe("viewer settings of R4-B (wave R4 gate)", () => {
  it("the host's settings carry units and the scale reference, DEFAULT mm and banana", () => {
    expect(VIEWER_SETTING_DEFAULTS).toMatchObject({ units: "mm", scaleReference: "banana" });
    expect(readViewerSettings({ units: "in", scaleReference: "cube" })).toMatchObject({ units: "in", scaleReference: "cube" });
    expect(readViewerSettings({ units: "cm", scaleReference: 3 })).toMatchObject({ units: "mm", scaleReference: "banana" });
  });

  it("the setting event reaches the host's onSetting and is a viewer event", () => {
    const seen: unknown[] = [];
    deliver({ onSetting: (c) => seen.push(c) } as ViewerOptions, { type: "uhd-viewer:setting", key: "viewer.scaleReference", value: "benchy" });
    expect(seen).toEqual([{ key: "viewer.scaleReference", value: "benchy" }]);
    expect(isViewerEvent({ type: "uhd-viewer:setting", key: "viewer.units", value: "in" })).toBe(true);
  });

  it("a choice saved through the host comes back from the host on the next load, over this browser's storage", () => {
    const kv = memory();
    const saved: Record<string, unknown> = {};
    rememberScaleSetting("scaleReference", "cube", (k, v) => (saved[k] = v), kv);
    rememberScaleSetting("units", "in", (k, v) => (saved[k] = v), kv);
    expect(saved).toEqual({ "viewer.scaleReference": "cube", "viewer.units": "in" });
    // the reload: the host's settings file says so (as the extension passes it), the browser's storage agrees
    expect(readScaleSettings({ units: saved["viewer.units"], scaleReference: saved["viewer.scaleReference"] }, kv)).toEqual({ units: "in", scaleReference: "cube" });
    // the host wins where it differs (a change from the Settings page or an agent)
    expect(readScaleSettings({ units: "mm", scaleReference: "benchy" }, kv)).toEqual({ units: "mm", scaleReference: "benchy" });
    // no host: this browser's storage
    expect(readScaleSettings(undefined, kv)).toEqual({ units: "in", scaleReference: "cube" });
  });
});

describe("the review's camera and menu fixes (wave R4 gate)", () => {
  it("the near stop clears the camera's near plane; the far stop keeps the model inside the far plane", () => {
    // an isolated 0402 (0.6 mm radius): the stop was 0.5 mm, inside the 1 mm near plane
    const tiny = zoomLimits({ focusRadius: 0.6, assemblyRadius: 0.6, fovDeg: 32, aspect: 1.6, near: 1, far: 5000 });
    expect(MIN_DISTANCE_FLOOR_MM).toBe(0.5);
    expect(tiny.min).toBe(2);
    // a 1.5 m model: the far stop leaves its far side inside 95 % of the 5 m far plane
    const huge = zoomLimits({ focusRadius: 1500, assemblyRadius: 1500, fovDeg: 32, aspect: 1.6, near: 1, far: 5000 });
    expect(huge.max + 1500).toBeLessThanOrEqual(0.95 * 5000 + 1e-6);
    // without near and far, as R4-A's tests call it
    expect(zoomLimits({ focusRadius: 0.6, assemblyRadius: 0.6, fovDeg: 32, aspect: 1.6 }).min).toBe(0.5);
  });

  it("ctrl with a mouse wheel is one notch; a pinch's small deltas follow the fingers", () => {
    expect(new WheelNotches().read({ deltaY: 100, deltaMode: 0, ctrlKey: true })).toBe(1);
    expect(new WheelNotches().read({ deltaY: -100, deltaMode: 0, ctrlKey: true })).toBe(-1);
    expect(Math.abs(new WheelNotches().read({ deltaY: -20, deltaMode: 0, ctrlKey: true }))).toBeGreaterThan(1);
  });

  it("the void menu's on/off items are checkboxes when off too", () => {
    const m = voidMenuFor({ hidden: 0, isolated: false, exploded: false, mode: "radial", section: false, capture: true, grid: { on: false }, scaleRef: { on: false, choice: "Banana" } });
    for (const id of ["explode", "grid", "scaleRef"]) expect(m.find((i) => i.id === id)?.checked).toBe(false);
  });
});
