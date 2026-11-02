/**
 * R2-A (2026-11-02): navigation in place with back and forward (F1), the part menu (F2), double-click open (F3),
 * hover colours and tooltips and the highlight colour (A3), and the refdes and MPN label kinds (R1-C's handoff).
 */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModuleDef } from "@uhd/types/index.js";
import { NavHistory, MAX_HISTORY, connectNav, goBack, hostNavigates, navHostMessage, navOf } from "../src/cad/nav/history";
import { HOVER_MIX, SELECT_DELTA_E, deltaE, hoverColour, isDarkGround, labOf, mixColour, resolveHighlightColour, selectionColour } from "../src/cad/nav/colour";
import { longTipRows, menuFor, modelArtifact, navigateTarget, packageLine, shortTip, tipHint, type PartTip } from "../src/cad/nav/target";
import { TIP_LONG_MS, TIP_SHORT_MS, placeTip, tipStage } from "../src/cad/nav/tip";
import { HoverTip, NavButtons, PartMenu } from "../src/cad/nav/ui";
import { makeHub } from "../src/cad/state/hub";
import { applyOps, checkValue, defaultViewState, LABEL_KINDS, validHighlightColor } from "../src/cad/state";
import { fromUrlParams } from "../src/cad/state/serialize";
import { touchedPaths } from "../src/cad/state/leases";
import { MAX_HISTORY_DELTA, isViewerEvent, parseHostMessage, parseNavigateEvent } from "../src/host/protocol";
import { deliver } from "../src/host/channel";
import type { ViewerEvent, ViewerHostMessage } from "../src/api";

const hub = () => makeHub(new URLSearchParams(""));

describe("R2-A history (F1)", () => {
  it("pushes places, goes back and forward, and drops the places ahead on a new one", () => {
    const h = new NavHistory();
    h.push({ scope: "", label: "Root", kind: "open" });
    h.push({ scope: "pcb", label: "Board", kind: "drill" });
    h.push({ scope: "pcb", label: "U13", kind: "frame", selection: { body: "pcb", component: "pcb/u13" } });
    expect(h.state("pcb")).toMatchObject({ index: 2, length: 3, canBack: true, canForward: false });
    // without a mount that drills, only places of this level are reachable
    expect(h.go(-1, "pcb")?.label).toBe("Board");
    expect(h.state("pcb")).toMatchObject({ canBack: false, canForward: true });
    h.canCross = () => true;
    expect(h.state("pcb").canBack).toBe(true);
    expect(h.go(1, "pcb")?.label).toBe("U13");
    h.go(-2, "pcb");
    h.push({ scope: "", label: "Frame", kind: "frame" });
    expect(h.places().map((p) => p.label)).toEqual(["Root", "Frame"]);
  });

  it("replaces a place equal to the current one, keeps the view it is left with, and caps the list", () => {
    const h = new NavHistory();
    h.push({ scope: "", label: "Root", kind: "open" });
    h.push({ scope: "", label: "Root again", kind: "open" });
    expect(h.length).toBe(1);
    const cam = { position: [1, 2, 3] as [number, number, number], target: [0, 0, 0] as [number, number, number], up: [0, 0, 1] as [number, number, number] };
    h.snapshot = () => ({ camera: cam });
    h.push({ scope: "", label: "A", kind: "frame", selection: { body: "a" } });
    h.go(-1);
    // the place left (A) kept the camera it was left with: Forward comes back to it
    expect(h.places()[1].camera).toEqual(cam);
    for (let i = 0; i < MAX_HISTORY + 10; i++) h.push({ scope: "", label: `p${i}`, kind: "frame", selection: { body: `b${i}` } });
    expect(h.length).toBe(MAX_HISTORY);
    expect(h.index).toBe(MAX_HISTORY - 1);
  });

  it("reports itself to the host and takes the host's historyGo; a place of another level is drilled to", () => {
    const hb = hub();
    const events: ViewerEvent[] = [];
    const applied: ViewerHostMessage[] = [];
    const stop = connectNav(hb, { emit: (e) => events.push(e), apply: (m) => applied.push(m), navigates: () => true });
    const nav = navOf(hb);
    nav.push({ scope: "", label: "Root", kind: "open" });
    nav.push({ scope: "pcb", label: "Board", kind: "drill" });
    const last = events.filter((e) => e.type === "uhd-viewer:history").pop() as Extract<ViewerEvent, { type: "uhd-viewer:history" }>;
    expect(last).toMatchObject({ index: 1, length: 2, entries: [{ scope: "", label: "Root", kind: "open" }, { scope: "pcb", label: "Board", kind: "drill" }] });
    expect(navHostMessage(hb, { type: "uhd-viewer:historyGo", delta: -1 })).toBe(true);
    // the store shows the root ("" by default) and the board's place is not reachable from it without a drill: the
    // history moved back to the root's own place
    expect(nav.index).toBe(0);
    // from the board's level, Back to the root is a drill
    hb.store.enterScope("pcb");
    nav.go(1);
    nav.going = null;
    goBack(hb, -1);
    expect(applied).toEqual([{ type: "uhd-viewer:drill", path: "" }]);
    expect(hostNavigates(hb)).toBe(true);
    stop();
    expect(hb.navLink).toBeUndefined();
    expect(hostNavigates(hb)).toBe(false);
    expect(navHostMessage(hb, { type: "uhd-viewer:hostCapabilities", navigate: true })).toBe(true);
    expect(hostNavigates(hb)).toBe(true);
    expect(navHostMessage(hb, { type: "uhd-viewer:focus", path: "x" })).toBe(false);
  });
});

describe("R2-A host protocol", () => {
  it("parses historyGo and hostCapabilities, refusing anything else", () => {
    expect(parseHostMessage({ type: "uhd-viewer:historyGo", delta: -1 })).toEqual({ type: "uhd-viewer:historyGo", delta: -1 });
    for (const delta of [0, 1.5, "1", MAX_HISTORY_DELTA + 1, null]) expect(parseHostMessage({ type: "uhd-viewer:historyGo", delta })).toBeUndefined();
    expect(parseHostMessage({ type: "uhd-viewer:hostCapabilities", navigate: true })).toEqual({ type: "uhd-viewer:hostCapabilities", navigate: true });
    expect(parseHostMessage({ type: "uhd-viewer:hostCapabilities" })).toEqual({ type: "uhd-viewer:hostCapabilities" });
    expect(parseHostMessage({ type: "uhd-viewer:hostCapabilities", navigate: "yes" })).toBeUndefined();
  });

  it("checks a navigate event for a relay and delivers navigate and history to the options", () => {
    const ok = { type: "uhd-viewer:navigate", target: { module: "pcb/power/u13" }, how: "replace", view: "3d", from: "" };
    expect(parseNavigateEvent(ok)).toEqual(ok);
    expect(parseNavigateEvent({ type: "uhd-viewer:navigate", target: { model: { defId: "usb4105", artifactId: "step", path: "pcb/usb" } }, how: "newTab" })).toEqual({ type: "uhd-viewer:navigate", target: { model: { defId: "usb4105", artifactId: "step", path: "pcb/usb" } }, how: "newTab" });
    expect(parseNavigateEvent({ ...ok, how: "popup" })).toBeUndefined();
    expect(parseNavigateEvent({ ...ok, target: { module: "a\u0000b" } })).toBeUndefined();
    expect(parseNavigateEvent({ ...ok, target: { model: { defId: "", artifactId: "x" } } })).toBeUndefined();
    expect(isViewerEvent(ok)).toBe(true);
    expect(isViewerEvent({ type: "uhd-viewer:history" })).toBe(true);
    const onNavigate = vi.fn();
    const onHistory = vi.fn();
    deliver({ onNavigate, onHistory }, ok as ViewerEvent);
    deliver({ onNavigate, onHistory }, { type: "uhd-viewer:history", index: 0, length: 1, canBack: false, canForward: false, entries: [] });
    expect(onNavigate).toHaveBeenCalledWith({ target: { module: "pcb/power/u13" }, how: "replace", view: "3d", from: "" });
    expect(onHistory).toHaveBeenCalledWith({ index: 0, length: 1, canBack: false, canForward: false, entries: [] });
  });
});

describe("R2-A view state: highlight colour, explode scope, label kinds", () => {
  it("sets the highlight's colour per call and clears it when a call gives none", () => {
    const s = defaultViewState();
    const a = applyOps(s, [{ op: "highlight", paths: ["pcb/u13"], color: "drcError" }]);
    if ("error" in a) throw new Error(a.error);
    expect(a.state.highlight).toEqual(["pcb/u13"]);
    expect(a.state.highlightColor).toBe("drcError");
    const b = applyOps(a.state, [{ op: "highlight", paths: ["pcb/u2"] }]);
    if ("error" in b) throw new Error(b.error);
    expect(b.state.highlightColor).toBeUndefined();
    expect(applyOps(s, [{ op: "highlight", paths: ["x"], color: "#e11d48" }])).not.toHaveProperty("error");
    expect(applyOps(s, [{ op: "highlight", paths: ["x"], color: "red; background: url(x)" }])).toHaveProperty("error");
    expect(validHighlightColor("#abc")).toBe(true);
    expect(validHighlightColor("radius")).toBe(false);
    expect(checkValue("highlightColor", undefined)).toBeUndefined();
  });

  it("a highlight colour touches no path (it needs no lease of the root)", () => {
    expect(touchedPaths([{ op: "set", path: ["highlightColor"], value: "#ff0000" }], defaultViewState() as unknown as Record<string, unknown>)).toEqual([]);
  });

  it("names a sub-assembly to explode, checked as a path", () => {
    const s = defaultViewState();
    const r = applyOps(s, [{ op: "explode", t: 1, scope: "frame/arm_fl" }]);
    if ("error" in r) throw new Error(r.error);
    expect(r.state.explode).toEqual({ t: 1, step: null, scope: "frame/arm_fl" });
    expect(applyOps(s, [{ op: "explode", t: 1, scope: "x".repeat(600) }])).toHaveProperty("error");
  });

  it("takes refdes and MPN label kinds, in the state and the URL", () => {
    expect(LABEL_KINDS).toEqual(expect.arrayContaining(["refdes", "mpn"]));
    const r = applyOps(defaultViewState(), [{ op: "set", path: ["visibility", "labelKinds"], value: ["module", "refdes", "mpn"] }]);
    expect(r).not.toHaveProperty("error");
    expect(fromUrlParams(new URLSearchParams("labelkinds=refdes,mpn,bogus")).visibility.labelKinds).toEqual(["refdes", "mpn"]);
  });
});

describe("R2-A colours (A3)", () => {
  const orange = 0xff7a1a;
  it("measures colour difference in Lab", () => {
    expect(deltaE(orange, orange)).toBe(0);
    expect(labOf(0xffffff)[0]).toBeCloseTo(100, 1);
    expect(deltaE(0x000000, 0xffffff)).toBeCloseTo(100, 0);
  });

  it("selects a part already in the accent's colour in the secondary accent", () => {
    const secondary = 0x22d3ee;
    expect(selectionColour(0x1c1c1c, orange, secondary)).toBe(orange);
    expect(selectionColour(0xff8020, orange, secondary)).toBe(secondary); // a near-identical orange
    expect(deltaE(0xff8020, orange)).toBeLessThan(SELECT_DELTA_E);
    expect(selectionColour(undefined, orange, secondary)).toBe(orange);
  });

  it("derives the hover colour from the part's own, lighter on dark ground and darker on paper", () => {
    const lum = (hex: number) => labOf(hex)[0];
    const black = 0x111111;
    const dark = hoverColour(black, orange, true);
    const paper = hoverColour(0xdddddd, orange, false);
    expect(lum(dark)).toBeGreaterThan(lum(mixColour(black, orange, HOVER_MIX)));
    expect(lum(paper)).toBeLessThan(lum(mixColour(0xdddddd, orange, HOVER_MIX)));
    // an expression of the original colour: two parts keep two hover colours, both moved toward the accent
    const green = hoverColour(0x1f7a3a, orange, true);
    const blue = hoverColour(0x1f3a7a, orange, true);
    expect(green).not.toBe(blue);
    expect(deltaE(green, 0x1f7a3a)).toBeLessThan(deltaE(green, 0x1f3a7a));
    // a white part on a dark ground still changes
    expect(hoverColour(0xffffff, orange, true)).not.toBe(0xffffff);
    expect(isDarkGround(0x1c1c1c)).toBe(true);
    expect(isDarkGround(0xf6f6f3)).toBe(false);
  });

  it("resolves the agent's highlight colour from a hex or a theme token", () => {
    expect(resolveHighlightColour("#f00", () => undefined)).toBe(0xff0000);
    expect(resolveHighlightColour("#e11d48", () => undefined)).toBe(0xe11d48);
    expect(resolveHighlightColour("drcError", (t) => (t === "drcError" ? "#ef4444" : undefined))).toBe(0xef4444);
    expect(resolveHighlightColour(undefined, () => "#000000")).toBeUndefined();
    expect(resolveHighlightColour("nope", () => undefined)).toBeUndefined();
  });
});

describe("R2-A what a part opens, its menu and its tooltip (F2, F3, A3)", () => {
  const def = (o: Partial<ModuleDef>): ModuleDef => ({ id: "d", name: "D", interfaces: [], ...o }) as ModuleDef;
  it("opens a sub-assembly or a part with a body as its module, else its own model artifact, else nothing", () => {
    expect(navigateTarget(def({ children: [{ id: "a", moduleDefId: "x" }] as ModuleDef["children"] }), "frame")).toEqual({ module: "frame" });
    expect(navigateTarget(def({ artifacts: [{ id: "body", format: "glb", role: "body", filePath: "b.glb" }] as ModuleDef["artifacts"] }), "fc")).toEqual({ module: "fc" });
    const step = def({ id: "usb", artifacts: [{ id: "step", format: "step", role: "source", filePath: "usb.step" }] as ModuleDef["artifacts"] });
    expect(modelArtifact(step)?.id).toBe("step");
    expect(navigateTarget(step, "pcb/usb")).toEqual({ model: { defId: "usb", artifactId: "step", path: "pcb/usb" } });
    expect(navigateTarget(def({ artifacts: [{ id: "ds", format: "pdf", filePath: "d.pdf" }] as ModuleDef["artifacts"] }), "x")).toBeUndefined();
    expect(navigateTarget(undefined, "x")).toBeUndefined();
  });

  it("offers the menu Kevin listed, with reasons on what cannot run", () => {
    const items = menuFor({ target: { module: "x" }, component: true, canExplode: false, canOpenTab: true, isolated: false });
    expect(items.map((i) => i.label)).toEqual(["Inspect", "Open 3D model", "Open in new tab", "Frame", "Isolate", "Hide", "Explode this sub-assembly", "Copy instance path"]);
    expect(items.find((i) => i.id === "isolate")?.disabled).toMatch(/board/);
    expect(items.find((i) => i.id === "explode")?.disabled).toBeTruthy();
    const none = menuFor({ target: undefined, component: false, canExplode: true, canOpenTab: false, isolated: true });
    expect(none.find((i) => i.id === "open")?.disabled).toBeTruthy();
    expect(none.find((i) => i.id === "isolate")?.label).toBe("Show everything");
    expect(none.find((i) => i.id === "hide")?.disabled).toBeUndefined();
  });

  it("says the refdes and short name, then the MPN, package and findings", () => {
    const t: PartTip = { key: "pcb/power/u13", refdes: "U13", name: "TPS54427 5 V buck", mpn: "TPS54427DDAR", pkg: "SO-8 PowerPAD, 4.89 x 3.9 x 1.7 mm", findings: 2, worst: "warn", open: "open" };
    expect(shortTip(t)).toBe("U13 TPS54427 5 V buck");
    expect(longTipRows(t)).toEqual([
      ["MPN", "TPS54427DDAR"],
      ["Package", "SO-8 PowerPAD, 4.89 x 3.9 x 1.7 mm"],
      ["Findings", "2 (worst warn)"],
    ]);
    expect(tipHint(t)).toMatch(/Double-click to open its 3D model/);
    expect(shortTip({ key: "frame/arm_fl", findings: 0, open: "frame" })).toBe("arm_fl");
    expect(longTipRows({ key: "x", findings: 0, open: "frame" })).toEqual([["Findings", "none"]]);
    const pkg = def({ domains: [{ domain: "mechanical", package: { name: "SOIC-8", pin_count: 8, exposed_pad: false }, dimensions_mm: { length: 4.9, width: 3.9, height: 1.75 } }] as unknown as ModuleDef["domains"] });
    expect(packageLine(pkg)).toBe("SOIC-8, 4.9 x 3.9 x 1.75 mm");
  });

  it("times the tooltip at 80 ms and 900 ms and never puts it over the part", () => {
    expect([TIP_SHORT_MS, TIP_LONG_MS]).toEqual([80, 900]);
    expect(tipStage(40)).toBe("none");
    expect(tipStage(80)).toBe("short");
    expect(tipStage(899)).toBe("short");
    expect(tipStage(900)).toBe("long");
    const view = { width: 1000, height: 700 };
    const size = { width: 220, height: 80 };
    const overlaps = (a: { left: number; top: number; right: number; bottom: number }, b: { left: number; top: number; right: number; bottom: number }) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    for (let x = 0; x <= 900; x += 60)
      for (let y = 0; y <= 600; y += 60)
        for (const [w, h] of [[20, 20], [200, 120], [500, 400]]) {
          const part = { left: x, top: y, right: Math.min(view.width, x + w), bottom: Math.min(view.height, y + h) };
          const p = placeTip(part, { x: (part.left + part.right) / 2, y: (part.top + part.bottom) / 2 }, size, view);
          const tip = { left: p.left, top: p.top, right: p.left + size.width, bottom: p.top + size.height };
          if (p.side !== "edge") expect(overlaps(tip, part), JSON.stringify({ part, p })).toBe(false);
          expect(tip.left).toBeGreaterThanOrEqual(0);
          expect(tip.right).toBeLessThanOrEqual(view.width);
          expect(tip.top).toBeGreaterThanOrEqual(0);
          expect(tip.bottom).toBeLessThanOrEqual(view.height);
        }
  });
});

describe("R2-A chrome markup", () => {
  it("draws back and forward disabled at the ends, enabled with a place to go", () => {
    const hb = hub();
    const off = renderToStaticMarkup(createElement(NavButtons, { hub: hb, scope: "" }));
    expect(off.match(/disabled=""/g)?.length).toBe(2);
    const nav = navOf(hb);
    nav.push({ scope: "", label: "Root", kind: "open" });
    nav.push({ scope: "", label: "U13", kind: "frame", selection: { body: "pcb", component: "pcb/u13" } });
    const on = renderToStaticMarkup(createElement(NavButtons, { hub: hb, scope: "" }));
    expect(on).toContain('aria-label="Back"');
    expect(on).toContain("Back to Root (Alt+Left)");
    expect(on.match(/disabled=""/g)?.length).toBe(1);
  });

  it("draws the part menu with its title, items and disabled reasons", () => {
    const items = menuFor({ target: undefined, component: true, canExplode: true, canOpenTab: true, isolated: false });
    const html = renderToStaticMarkup(createElement(PartMenu, { x: 10, y: 20, title: "U13 TPS54427", items, onRun: () => {}, onClose: () => {} }));
    expect(html).toContain('role="menu"');
    expect(html).toContain("U13 TPS54427");
    expect(html).toContain('data-item="explode"');
    expect(html).toContain('aria-disabled="true" title="This part has no 3D model of its own"');
  });

  it("draws the short and the long tooltip", () => {
    const tip: PartTip = { key: "pcb/u13", refdes: "U13", name: "TPS54427 5 V buck", mpn: "TPS54427DDAR", findings: 0, open: "frame" };
    const box = { left: 100, top: 100, right: 140, bottom: 130 };
    const short = renderToStaticMarkup(createElement(HoverTip, { tip, stage: "short", part: box, pointer: { x: 120, y: 115 }, view: { width: 800, height: 600 } }));
    expect(short).toContain("U13 TPS54427 5 V buck");
    expect(short).not.toContain("MPN");
    const long = renderToStaticMarkup(createElement(HoverTip, { tip, stage: "long", part: box, pointer: { x: 120, y: 115 }, view: { width: 800, height: 600 } }));
    expect(long).toContain("TPS54427DDAR");
    expect(long).toContain("Right-click for more");
  });
});
