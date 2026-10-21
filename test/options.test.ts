import { describe, expect, it } from "vitest";
import type { UhdBundle } from "@uhd/types/bundle.js";
import type { ViewerLayout, ViewerOptions } from "../src/api";
import { hostViewportsChange, mergeOptions, sameLayout, sameViewports } from "../src/options";

const bundle = { schema: "uhd.bundle/v0", root: "sys", definitions: [] } as unknown as UhdBundle;

describe("update()", () => {
  it("merges the change into the current options", () => {
    const onLayoutChange = () => {};
    const next = mergeOptions({ bundleUrl: "/a.json", onLayoutChange }, { diagnostics: [] });
    expect(next).toEqual({ bundleUrl: "/a.json", onLayoutChange, diagnostics: [] });
  });

  it("switches from a given bundle to a bundle URL", () => {
    const next = mergeOptions({ bundle, bundleUrl: "/a.json" }, { bundleUrl: "/b.json" });
    expect(next).toEqual({ bundleUrl: "/b.json" });
  });

  it("keeps the bundle URL next to a new bundle (relative artifacts resolve against it)", () => {
    const rebuilt = { ...bundle };
    const next = mergeOptions({ bundle, bundleUrl: "/a.json" }, { bundle: rebuilt });
    expect(next.bundle).toBe(rebuilt);
    expect(next.bundleUrl).toBe("/a.json");
  });

  it("carries a host's marks, and replaces them whole when the host sends new ones", () => {
    const first = mergeOptions<ViewerOptions>({ bundle }, { nodeMarks: { mcu: { tone: "ok", label: "Reviewed" }, cell: { tone: "neutral" } } });
    expect(first.nodeMarks).toEqual({ mcu: { tone: "ok", label: "Reviewed" }, cell: { tone: "neutral" } });
    // a later update that does not mention marks keeps them; one that does replaces them
    expect(mergeOptions(first, { diagnostics: [] }).nodeMarks).toBe(first.nodeMarks);
    expect(mergeOptions(first, { nodeMarks: { mcu: { tone: "warning" } } }).nodeMarks).toEqual({ mcu: { tone: "warning" } });
  });

  it("does not change the current options", () => {
    const current = { bundle, bundleUrl: "/a.json" };
    mergeOptions(current, { bundleUrl: "/b.json" });
    expect(current.bundle).toBe(bundle);
  });
});

describe("host layout", () => {
  const edited: ViewerLayout = { positions: { "": { battery: { x: 480, y: 512 } } }, links: {} };

  it("compares by content, so the host passing back what it was sent is no change", () => {
    expect(sameLayout(edited, JSON.parse(JSON.stringify(edited)))).toBe(true);
  });

  it("treats no layout as an empty one", () => {
    expect(sameLayout(undefined, { positions: {}, links: {} })).toBe(true);
    expect(sameLayout(undefined, edited)).toBe(false);
  });

  it("sees a moved node and a pinned waypoint", () => {
    expect(sameLayout(edited, { positions: { "": { battery: { x: 490, y: 512 } } }, links: {} })).toBe(false);
    expect(sameLayout(edited, { ...edited, links: { "": { vbat: { waypoints: [[0, 0]] } } } })).toBe(false);
  });
});

describe("host viewports (PB-1037)", () => {
  const a = { "": { x: 10, y: 20, zoom: 1 }, board: { x: 0, y: 0, zoom: 0.5 } };
  const b = { "": { x: -300, y: 40, zoom: 0.8 } };

  it("the same viewports in another order are the same", () => {
    expect(sameViewports(a, { board: { x: 0, y: 0, zoom: 0.5 }, "": { x: 10, y: 20, zoom: 1 } })).toBe(true);
    expect(sameViewports(undefined, {})).toBe(true);
    expect(sameViewports(a, b)).toBe(false);
    expect(sameViewports(a, undefined)).toBe(false);
  });

  it("a later update({ viewports }) replaces the viewer's; what it was sent, passed back, does not", () => {
    // another project's viewports (or none, which fits the new diagram)
    expect(hostViewportsChange({ hosted: true, wasHosted: true, host: b, known: a })).toBe("replace");
    expect(hostViewportsChange({ hosted: true, wasHosted: true, host: undefined, known: a })).toBe("replace");
    // the host passing back what it was sent
    expect(hostViewportsChange({ hosted: true, wasHosted: true, host: { ...a }, known: a })).toBe("keep");
  });

  it("taking over or giving up keeping the viewports replaces them; without a host nothing changes", () => {
    expect(hostViewportsChange({ hosted: true, wasHosted: false, host: b, known: undefined })).toBe("replace");
    expect(hostViewportsChange({ hosted: false, wasHosted: true, host: undefined, known: a })).toBe("replace");
    expect(hostViewportsChange({ hosted: false, wasHosted: false, host: b, known: undefined })).toBe("keep");
  });
});
