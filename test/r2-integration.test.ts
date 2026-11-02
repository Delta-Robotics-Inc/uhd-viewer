/**
 * R2 integration (2026-11-02): the cross-agent handoffs applied after the five R2 builders finished. The mount's
 * navigation wiring (R2-A, F1), the host's viewer settings (R2-E, J1), the toolbar's Export (R2-E, G3), R2-B's
 * section and explode fields in the schema and the host protocol, and the part menu's class clash.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// the mount without a DOM: React's root is a stub (nothing renders), the window and document are just event targets
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render: () => {}, unmount: () => {} }) }));

import { renderViewer } from "../src/viewer/mount";
import { makeHub, viewHub, type ViewHub } from "../src/cad/state/hub";
import { applyOps, checkValue, defaultViewState } from "../src/cad/state";
import { navOf, hostDrawsHistory, hostNavigates } from "../src/cad/nav/history";
import { NavButtons } from "../src/cad/nav/ui";
import { NAV_CSS } from "../src/cad/nav/style";
import { isViewerEvent, parseHostMessage, parseModeScope } from "../src/host/protocol";
import { deliver } from "../src/host/channel";
import { CadToolbar, EXPORT_LABEL, EXPORT_UNHOSTED, type CadToolbarProps } from "../src/cad/CadToolbar";
import { HOVER_LONG_MAX_MS, VIEWER_SETTING_DEFAULTS, applyViewerSettings, longHoverMs, readViewerSettings, viewerSettings } from "../src/cad/viewerSettings";
import { LONG_HOVER_MS } from "../src/cad/annot/style";
import type { ExportRequest, NavigateRequest, ViewerHistoryState, ViewerOptions } from "../src/api";

const g = globalThis as Record<string, unknown>;
const saved = { window: g.window, document: g.document };
const listeners = () => ({ addEventListener: () => {}, removeEventListener: () => {} });
beforeAll(() => {
  g.window = { ...listeners(), location: { search: "" } };
  // getElementById: the style sheets count as already in the page
  g.document = { ...listeners(), visibilityState: "visible", getElementById: () => ({}) };
});
afterAll(() => {
  g.window = saved.window;
  g.document = saved.document;
});
/** A fresh hub for each mount (the mount takes the page's, kept on `window.__uhdViewHub`). */
const freshHub = (): ViewHub => {
  const h = makeHub(new URLSearchParams(""));
  (g.window as Record<string, unknown>).__uhdViewHub = h;
  return h;
};
const Shell = () => null;
const mount = (options: Partial<ViewerOptions>) => renderViewer({} as HTMLElement, { bundle: {} as never, ...options } as never, Shell as never);

describe("the mount's navigation wiring (R2-A, F1)", () => {
  it("reports the history to the host, takes historyGo and hostCapabilities, and stops on unmount", () => {
    const hub = freshHub();
    const history: ViewerHistoryState[] = [];
    const navigated: NavigateRequest[] = [];
    const v = mount({ onHistory: (h) => history.push(h), onNavigate: (r) => navigated.push(r) });
    expect(viewHub()).toBe(hub);
    expect(hub.navLink).toBeDefined();
    // a host that gives onNavigate takes navigate; one that gives onHistory draws its own back and forward
    expect(hostNavigates(hub)).toBe(true);
    expect(hostDrawsHistory(hub)).toBe(true);
    const nav = navOf(hub);
    nav.push({ scope: "", label: "Root", kind: "open" });
    nav.push({ scope: "", label: "U13", kind: "frame", selection: { body: "pcb" } });
    expect(history.at(-1)).toMatchObject({ index: 1, length: 2, canBack: true });
    // the header's Back, as a host message: routed to navigation before anything else
    expect(v.post({ type: "uhd-viewer:historyGo", delta: -1 })).toBe(true);
    expect(nav.index).toBe(0);
    expect(history.at(-1)).toMatchObject({ index: 0, canForward: true });
    // the viewer's own navigate request reaches onNavigate through the link the mount set
    hub.navLink!.emit({ type: "uhd-viewer:navigate", target: { module: "pcb" }, how: "replace", view: "3d", from: "" });
    expect(navigated).toEqual([{ target: { module: "pcb" }, how: "replace", view: "3d", from: "" }]);
    v.unmount();
    expect(hub.navLink).toBeUndefined();
  });

  it("a host with neither option: no navigate, the in-page back and forward stay", () => {
    const hub = freshHub();
    const v = mount({});
    expect(hostNavigates(hub)).toBe(false);
    expect(hostDrawsHistory(hub)).toBe(false);
    // a frame's parent can say both
    v.post({ type: "uhd-viewer:hostCapabilities", navigate: true, history: true });
    expect(hostNavigates(hub)).toBe(true);
    expect(hostDrawsHistory(hub)).toBe(true);
    v.unmount();
  });

  it("setViewState writes highlightColor (it was dropped by the mount's own key list)", () => {
    freshHub();
    const v = mount({});
    v.setViewState({ highlight: ["pcb/u13"], highlightColor: "drcError" } as never);
    expect(v.viewState()).toMatchObject({ highlight: ["pcb/u13"], highlightColor: "drcError" });
    v.unmount();
  });

  it("the in-page NavButtons draw nothing when the host draws its own", () => {
    const hub = makeHub(new URLSearchParams(""));
    expect(renderToStaticMarkup(createElement(NavButtons, { hub, scope: "" }))).toContain('aria-label="Back"');
    hub.hostCaps = { history: true };
    expect(renderToStaticMarkup(createElement(NavButtons, { hub, scope: "" }))).toBe("");
  });
});

describe("the host's viewer settings (R2-E, J1)", () => {
  it("defaults to today's values and refuses anything malformed or out of range", () => {
    expect(readViewerSettings(undefined)).toEqual({ openModelsInPlace: true, zoomToCursor: true, modelInfo: true, hoverLongDelayMs: LONG_HOVER_MS });
    expect(VIEWER_SETTING_DEFAULTS.hoverLongDelayMs).toBe(900);
    expect(readViewerSettings({ zoomToCursor: "no", modelInfo: false, hoverLongDelayMs: HOVER_LONG_MAX_MS + 1 })).toEqual({ openModelsInPlace: true, zoomToCursor: true, modelInfo: false, hoverLongDelayMs: 900 });
    expect(readViewerSettings({ hoverLongDelayMs: 1500.4 }).hoverLongDelayMs).toBe(1500);
    expect(readViewerSettings({ hoverLongDelayMs: 100 }).hoverLongDelayMs).toBe(900);
  });

  it("the mount puts them on the hub at mount and on update; zoomToCursor reaches the camera controls", () => {
    const hub = freshHub();
    const controls = vi.fn((o: { zoomToCursor?: boolean }) => ({ zoomToCursor: o.zoomToCursor ?? true }));
    hub.controls = controls;
    const v = mount({ settings: { zoomToCursor: false, hoverLongDelayMs: 1500, modelInfo: false } });
    expect(longHoverMs(hub)).toBe(1500);
    expect(viewerSettings(hub).modelInfo).toBe(false);
    expect(hub.controlOptions).toEqual({ zoomToCursor: false });
    expect(controls).toHaveBeenLastCalledWith({ zoomToCursor: false });
    v.update({ settings: { zoomToCursor: true, hoverLongDelayMs: 400 } });
    expect(longHoverMs(hub)).toBe(400);
    expect(viewerSettings(hub).modelInfo).toBe(true);
    expect(hub.controlOptions).toEqual({ zoomToCursor: true });
    v.unmount();
  });

  it("settings without zoomToCursor leave the controls alone (a URL's ?zoomToCursor=0 keeps working)", () => {
    const hub = makeHub(new URLSearchParams(""));
    hub.controlOptions = { zoomToCursor: false };
    applyViewerSettings(hub, { hoverLongDelayMs: 700 });
    expect(hub.controlOptions).toEqual({ zoomToCursor: false });
    expect(longHoverMs(hub)).toBe(700);
  });
});

describe("the toolbar's Export (R2-E, G3)", () => {
  it("the mount offers export only to a host that takes it, and sends the request as an event", () => {
    let hub = freshHub();
    let v = mount({});
    expect(hub.exportView).toBeUndefined();
    v.unmount();
    hub = freshHub();
    const got: ExportRequest[] = [];
    v = mount({ onExport: (r) => got.push(r) });
    hub.exportView!({ format: "stl", target: "fan_unit_1/fan" });
    hub.exportView!({ format: "png" });
    expect(got).toEqual([{ format: "stl", target: "fan_unit_1/fan" }, { format: "png" }]);
    v.unmount();
    expect(hub.exportView).toBeUndefined();
  });

  it("the event is a viewer event and delivers to onExport", () => {
    expect(isViewerEvent({ type: "uhd-viewer:export", format: "png" })).toBe(true);
    const got: ExportRequest[] = [];
    deliver({ onExport: (r) => got.push(r) } as ViewerOptions, { type: "uhd-viewer:export", format: "glb", target: "pcb" });
    expect(got).toEqual([{ format: "glb", target: "pcb" }]);
  });

  it("the button is enabled when hosted, disabled with its reason when not", () => {
    const base = {
      exploded: false, onExploded: () => {}, labels: false, onLabels: () => {}, labelKinds: new Set(["module"]), onLabelKind: () => {}, labelMenu: false, onLabelMenu: () => {},
      hardwareCount: 0, hardware: false, onHardware: () => {}, harnessCount: 0, wires: false, onWires: () => {}, frames: false, onFrames: () => {},
      section: null, onSection: () => {}, sectionMenu: false, onSectionMenu: () => {}, autoFlip: () => true, shells: 0, xray: false, onXray: () => {},
      findings: 0, showFindings: false, onFindings: () => {}, direction: "feature", onDirection: () => {}, onFit: () => {}, onFocus: () => {}, canFocus: false,
      sections: [], onSections: () => {},
    } as unknown as CadToolbarProps;
    const button = (markup: string) => markup.match(/<button[^>]*data-export="menu"[^>]*>/)?.[0] ?? "";
    const hosted = button(renderToStaticMarkup(createElement(CadToolbar, { ...base, onExport: () => {}, exportTarget: null })));
    expect(hosted).toContain(`data-tooltip="${EXPORT_LABEL}"`);
    expect(hosted).not.toContain("aria-disabled");
    const alone = button(renderToStaticMarkup(createElement(CadToolbar, base)));
    expect(alone).toContain(`data-tooltip="${EXPORT_UNHOSTED}"`);
    expect(alone).toContain('aria-disabled="true"');
  });
});

describe("R2-B's section and explode fields (schema, ops, protocol)", () => {
  const plane = { axis: 1, at: 0.5, source: "face", normal: [0, -0.707, 0.707], point: [10, 0, 5], offset: -44.5, face: { path: "shell/blank_1", face: 12, body: "shell/blank_1", planar: true } };
  it("accepts a placed plane and refuses malformed fields", () => {
    expect(checkValue("sections", [plane])).toBeUndefined();
    expect(checkValue("sections", [{ axis: 2, at: 0.5, source: "origin", normal: [0, 0, 1], point: [0, 0, 0] }])).toBeUndefined();
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ source: "edge" }, /source/],
      [{ point: undefined }, /both or neither/],
      [{ normal: [0, 0, 0] }, /non-zero/],
      [{ normal: [0, "1", 0] }, /non-zero/],
      [{ point: [0, 0] }, /point/],
      [{ offset: 1e6 }, /offset/],
      [{ offset: Number.NaN }, /offset/],
      [{ face: { face: 1 } }, /face/],
      [{ face: { path: "a", face: -1 } }, /non-negative/],
      [{ face: { path: "a", face: 1.5 } }, /non-negative/],
      [{ face: { path: "a", planar: "yes" } }, /planar/],
    ];
    for (const [change, why] of bad) expect(checkValue("sections", [{ ...plane, ...change }])).toMatch(why);
    // the legacy axis plane is unchanged
    expect(checkValue("sections", [{ axis: 0, at: 0.25, flip: true }])).toBeUndefined();
  });

  it("explode.mode is radial, sequence or absent; the explode op merges it", () => {
    expect(checkValue("explode", { t: 1, step: null, mode: "radial" })).toBeUndefined();
    expect(checkValue("explode", { t: 1, step: "fit:a", mode: "sequence", scope: "fan_unit_1" })).toBeUndefined();
    expect(checkValue("explode", { t: 1, step: null, mode: "burst" })).toMatch(/mode/);
    const s0 = defaultViewState();
    const s1 = applyOps(s0, [{ op: "explode", t: 1, mode: "radial" }]);
    expect("error" in s1).toBe(false);
    const st1 = (s1 as { state: typeof s0 }).state;
    expect(st1.explode).toMatchObject({ t: 1, mode: "radial" });
    // a host's explode {t} keeps the mode in force
    const s2 = applyOps(st1, [{ op: "explode", t: 0 }]);
    expect((s2 as { state: typeof s0 }).state.explode).toMatchObject({ t: 0, mode: "radial" });
    expect("error" in applyOps(st1, [{ op: "explode", t: 1, mode: "spiral" } as never])).toBe(true);
  });

  it("the host protocol checks the player's mode and scope commands", () => {
    const seq = (command: unknown) => parseHostMessage({ type: "uhd-viewer:sequence", command });
    expect(seq({ action: "mode", mode: "radial" })).toEqual({ type: "uhd-viewer:sequence", command: { action: "mode", mode: "radial" } });
    expect(seq({ action: "mode" })).toBeDefined();
    expect(seq({ action: "scope", scope: "fan_unit_1", instant: true })).toBeDefined();
    expect(seq({ action: "scope" })).toBeDefined();
    expect(seq({ action: "mode", mode: "burst" })).toBeUndefined();
    expect(seq({ action: "mode", mode: "radial", instant: "now" })).toBeUndefined();
    expect(seq({ action: "scope", scope: 3 })).toBeUndefined();
    expect(seq({ action: "scope", scope: "a" + String.fromCharCode(0) + "b" })).toBeUndefined();
    expect(seq({ action: "scope", scope: "x".repeat(513) })).toBeUndefined();
    // other commands still go to the player as before
    expect(seq({ action: "goto", step: "fit:a" })).toBeDefined();
    expect(parseModeScope({ action: "goto" })).toBe(false);
  });
});

describe("the part menu's classes (R2-B's handoff to R2-A)", () => {
  it("the navigation sheet styles no .cad-menu (the toolbar's own menus keep their placement and buttons)", () => {
    expect(NAV_CSS).not.toMatch(/\.cad-menu\b/);
    expect(NAV_CSS).toMatch(/\.cad-part-menu\b/);
  });
});
