/**
 * R2-C (wave R2, 2026-11-02): plain-language finding text (walkthrough D3), the long-hover delay (Kevin: 900 ms),
 * DRC markers as instanced draws (the R1 gate: 16 markers cost 48 draws), markers anchored as they resolve.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { AnnotLayer, ANCHOR_BUDGET_MS, type AnnotHost } from "../src/cad/annot/layer";
import { DEFAULT_SHOWN, drcMarkers, findingCard, findingSummary } from "../src/cad/annot/drc";
import { findingText, findingsAnchors, plainKey, plainString, plainTextIndex, PLAIN_SUMMARY_MAX, PLAIN_TITLE_MAX } from "../src/cad/annot/plain";
import { findingInputs } from "../src/cad/annot/sources";
import { GlyphAtlas, QuadBatch, StemBatch, perPxUniform } from "../src/cad/annot/batch";
import { LONG_HOVER_MS, REVEAL_MS } from "../src/cad/annot/style";
import * as annot from "../src/cad/annot";
import { FakeEl, installFakeDom } from "./labels-fakedom";

const raw = (extra: Record<string, unknown> = {}) => ({ code: "UHD_INTERFACE_REUSE", severity: "error", message: "controller/sensors/pspin_4 is linked 2 times (a.b+c.d) but supports 1.", entity: { kind: "instance", id: "pcb" }, validator: "uhd-viewer/system", ...extra });

describe("the long hover (Kevin 2026-11-02)", () => {
  it("is 900 ms; the short hover stays 80 ms; the part tooltips can import the same value", () => {
    expect(LONG_HOVER_MS).toBe(900);
    expect(REVEAL_MS.intent).toBe(80);
    expect(annot.LONG_HOVER_MS).toBe(900);
  });
});

describe("plain-language text on findings (D3, R2-D's fields)", () => {
  it("reads title and summary from a diagnostic: strings only, whitespace collapsed, capped", () => {
    expect(findingText({ title: "  Pin used twice ", summary: "Two links\\nshare one pin." })).toEqual({ title: "Pin used twice", summary: "Two links\\nshare one pin." });
    expect(findingText({ title: "Pin\n used   twice" }).title).toBe("Pin used twice");
    expect(findingText({ title: 3, summary: "", other: "x" })).toEqual({});
    expect(findingText(null)).toEqual({});
    const long = plainString("word ".repeat(60), PLAIN_TITLE_MAX)!;
    expect(long.length).toBeLessThanOrEqual(PLAIN_TITLE_MAX);
    expect(long.endsWith("…")).toBe(true);
    expect(plainString("x".repeat(400), PLAIN_SUMMARY_MAX)!.length).toBe(PLAIN_SUMMARY_MAX);
  });

  it("carries them from the bundle diagnostic onto the finding (the shared anchors file untouched)", () => {
    const inputs = findingInputs([], [raw({ title: "A pin is used twice", summary: "Two links share pin 4; it supports one." }), { code: "INFO_X", severity: "info", message: "m" }, raw({ code: "OTHER" })] as never);
    expect(inputs[0]).toMatchObject({ title: "A pin is used twice", summary: "Two links share pin 4; it supports one." });
    const fs = findingsAnchors(inputs, [{ key: "pcb" }]);
    // the info finding is skipped by the shared function; the third keeps no text
    expect(fs).toHaveLength(2);
    expect(fs[0]).toMatchObject({ code: "UHD_INTERFACE_REUSE", title: "A pin is used twice", summary: "Two links share pin 4; it supports one." });
    expect(fs[1].title).toBeUndefined();
    // the index's findingsAnchors is this one
    expect(annot.findingsAnchors).toBe(findingsAnchors);
  });

  it("the viewer's own checks borrow the stack's text for the same check (UHD_ code, scoped message)", () => {
    const index = plainTextIndex([
      { code: "UHD_UNPOWERED", severity: "warning", message: "pcb (pcb-b1-4): power:p5v_int is a net port with no source.", validator: "uhd/checkSystem", title: "5 V rail has no supply", summary: "Nothing drives the 5 V net." },
      { code: "UHD_NET", severity: "warning", message: "no text here" },
    ]);
    expect(index.size).toBe(1);
    expect(plainKey("UHD_UNPOWERED", "pcb (pcb-b1-4): power:p5v_int is a net port  with no source.")).toBe(plainKey("unpowered", "power:p5v_int is a net port with no source."));
    const own = [{ id: "pcb/x", rule: "unpowered", severity: "warning", message: "power:p5v_int is a net port with no source.", refs: ["pcb/power:p5v_int"], scope: "pcb" }];
    const inputs = findingInputs(own as never, [], index);
    expect(inputs[0]).toMatchObject({ code: "UNPOWERED", title: "5 V rail has no supply", summary: "Nothing drives the 5 V net." });
    expect(findingInputs(own as never, [])[0].title).toBeUndefined();
  });

  it("the card: plain title first, the summary as the description, the code kept as a raw row", () => {
    const [f] = findingsAnchors([{ ...raw(), title: "A pin is used twice", summary: "Two links share pin 4." }] as never, [{ key: "pcb" }]);
    expect(findingSummary(f)).toMatchObject({ title: "A pin is used twice", description: "Two links share pin 4.", plain: true });
    expect(findingCard(f).rows).toEqual([
      ["CODE", "UHD INTERFACE REUSE"],
      ["AT", "pcb"],
      ["BY", "uhd-viewer/system"],
    ]);
    // without the fields: today's text, no CODE row
    const [g] = findingsAnchors([raw()] as never, [{ key: "pcb" }]);
    expect(findingSummary(g)).toMatchObject({ title: "UHD INTERFACE REUSE", description: "controller/sensors/pspin_4 is linked 2 times but supports 1.", plain: false });
    expect(findingCard(g).rows.map((r) => r[0])).toEqual(["AT", "BY"]);
  });
});

describe("the marker in a page: tiers with plain text, instanced draws (stand-in DOM)", () => {
  let dom: ReturnType<typeof installFakeDom>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    dom = installFakeDom();
  });
  afterEach(() => {
    dom.restore();
    vi.useRealTimers();
  });

  const setup = (parts = 1, extra: Record<string, unknown> = { title: "A pin is used twice", summary: "Two links share pin 4; it supports one." }) => {
    const meshes = Array.from({ length: parts }, (_, i) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 4));
      m.position.set(i * 14 - parts * 7, 0, 2);
      m.updateMatrixWorld(true);
      return m;
    });
    const hits = meshes.map((m, i) => ({ objects: [m], box: new THREE.Box3().setFromObject(m), frame: new THREE.Matrix4(), body: `p${i}` }));
    const calls: string[] = [];
    let picks = 0;
    const host: AnnotHost = {
      resolve: (ref) => hits[Number(ref.slice(1))] ?? null,
      pickOn: (ray, roots) => {
        picks++;
        return new THREE.Raycaster(ray.origin, ray.direction).intersectObjects(roots, true)[0]?.point;
      },
      firstHit: () => undefined,
      onFinding: (id, a) => calls.push(`${a}:${id}`),
      onInspect: (id, ref) => calls.push(`inspect:${id}:${ref}`),
    };
    const fs = findingsAnchors(
      meshes.map((_, i) => ({ ...raw({ entity: { kind: "instance", id: `p${i}` } }), ...extra })) as never,
      hits.map((h) => ({ key: h.body })),
    );
    const markers = drcMarkers(fs, new Set(DEFAULT_SHOWN));
    const layer = new AnnotLayer(dom.host as unknown as HTMLElement, host);
    const camera = new THREE.PerspectiveCamera(40, 1440 / 900, 1, 2000);
    camera.position.set(0, -160, 200);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    return { layer, markers, camera, calls, picks: () => picks, fs };
  };

  it("short: the plain title; long (900 ms): + the summary; pinned: both, the raw text under Details", () => {
    const { layer, markers, camera, fs } = setup();
    const open = new Set<string>();
    layer.setInput({ records: [], markers, open, presence: [], ghosts: true, motion: false });
    layer.update(camera, 1440, 900);
    const root = layer.root as unknown as FakeEl;
    const hit = root.find("annot-hit")[0];
    // the marker's accessible name is the plain title
    expect(hit.getAttribute("aria-label")).toBe("Fail: A pin is used twice");
    const sheet = () => root.find("annot-sheet").find((e) => !e.classList.contains("closed"))!;
    hit.dispatchEvent(new Event("pointerenter"));
    vi.advanceTimersByTime(60);
    layer.update(camera, 1440, 900);
    expect(sheet().find("annot-title-text")[0].textContent).toBe("A pin is used twice");
    expect(sheet().classList.contains("plain")).toBe(true);
    expect(sheet().find("annot-desc")).toHaveLength(0);
    // not yet long at the old 600 ms
    vi.advanceTimersByTime(600);
    layer.update(camera, 1440, 900);
    expect(layer.hoverState().tier).toBe("short");
    vi.advanceTimersByTime(LONG_HOVER_MS - 600);
    layer.update(camera, 1440, 900);
    expect(layer.hoverState().tier).toBe("long");
    expect(sheet().find("annot-desc")[0].textContent).toBe("Two links share pin 4; it supports one.");
    expect(sheet().find("annot-details")).toHaveLength(0);
    // pinned: title, summary, and a closed Details with the raw message and rows
    open.add(fs[0].id);
    hit.dispatchEvent(new Event("pointerleave"));
    layer.update(camera, 1440, 900);
    const pinned = sheet();
    expect(pinned.find("annot-desc")).toHaveLength(1);
    const det = pinned.find("annot-details");
    expect(det).toHaveLength(1);
    expect(det[0].text()).toContain("Details");
    expect(det[0].text()).toContain("CODE");
    expect(det[0].text()).toContain("AT");
    expect(det[0].text()).toContain("BY");
    expect(det[0].text().replace(/​/g, "")).toContain("is linked 2 times (a.b+c.d) but supports 1.");
    // the raw rows are only in the details, not on the card itself
    expect(pinned.children.filter((c) => c.classList.contains("annot-rows"))).toHaveLength(0);
    layer.dispose();
  });

  it("16 markers: 3 draws (live quads, their ghosts, the stems), 32 quads, 16 stems", () => {
    const { layer, markers, camera } = setup(16, {});
    expect(markers).toHaveLength(16);
    layer.setInput({ records: [], markers, open: new Set(), presence: [], ghosts: true, motion: false });
    while (layer.update(camera, 1440, 900));
    expect(layer.drawStats()).toMatchObject({ quads: 32, stems: 16, draws: 3 });
    // the annotation group holds the three batch meshes and nothing per marker
    const drawn = layer.group.children.filter((o) => (o as THREE.Mesh).isMesh || (o as THREE.Sprite).isSprite);
    expect(drawn).toHaveLength(3);
    expect(layer.group.children.some((o) => (o as THREE.Sprite).isSprite)).toBe(false);
    // ghosts off: 2 draws
    layer.setInput({ records: [], markers, open: new Set(), presence: [], ghosts: false, motion: false });
    layer.update(camera, 1440, 900);
    expect(layer.drawStats().draws).toBe(2);
    layer.dispose();
  });

  it("anchors markers as they resolve: within the frame budget, asking for frames until all are placed", () => {
    const { layer, markers, camera } = setup(6, {});
    layer.setInput({ records: [], markers, open: new Set(), presence: [], ghosts: true, motion: false, anchorParts: false });
    // the view has not settled: no raycast, nothing drawn for markers without their own point
    expect(layer.update(camera, 1440, 900)).toBe(false);
    expect(layer.markersDrawn()).toBe(0);
    layer.setInput({ records: [], markers, open: new Set(), presence: [], ghosts: true, motion: false, anchorParts: true });
    const now = vi.spyOn(performance, "now");
    let t = 0;
    // each surface search "costs" more than the budget: one marker a frame
    now.mockImplementation(() => (t += ANCHOR_BUDGET_MS + 1));
    const counts: number[] = [];
    for (let i = 0; i < 10; i++) {
      const more = layer.update(camera, 1440, 900);
      counts.push(layer.markersDrawn());
      if (!more) break;
    }
    now.mockRestore();
    expect(counts[0]).toBe(1);
    expect(counts.at(-1)).toBe(6);
    // counted up one a frame, no wait before the first
    expect(counts.slice(0, 6)).toEqual([1, 2, 3, 4, 5, 6]);
    layer.dispose();
  });

  it("the batches' world matrices are current after any frame (the R1 screen-filling glyph)", () => {
    const { layer, markers, camera } = setup(2, {});
    const overlay = new THREE.Group();
    overlay.position.set(5, 0, 0);
    overlay.add(layer.group);
    overlay.updateMatrixWorld(true);
    // a camera-only frame: nothing brings the scene's matrices up to date after the layer's update
    layer.setInput({ records: [], markers, open: new Set(), presence: [], ghosts: true, motion: false });
    layer.update(camera, 1440, 900);
    for (const o of layer.group.children) expect(o.matrixWorld.elements[12]).toBe(5);
    layer.dispose();
  });
});

describe("the instanced batches", () => {
  it("atlas: one cell per picture, cells never overlap, cleared when full", () => {
    const a = new GlyphAtlas(64, 2);
    const draw = () => {};
    expect(a.ensure("a", draw)).toBe(0);
    expect(a.ensure("a", draw)).toBe(0);
    a.ensure("b", draw);
    a.ensure("c", draw);
    a.ensure("d", draw);
    const [u0, v0, u1, v1] = a.uv("a");
    expect(u0).toBeGreaterThan(0);
    expect(u1).toBeLessThan(0.5);
    expect(v0).toBeGreaterThan(0.5);
    expect(v1).toBeLessThan(1);
    a.ensure("e", draw);
    expect(a.resets).toBe(1);
    expect(a.size).toBe(1);
  });

  it("quads and stems: grow past their capacity, instance count and visibility follow the list", () => {
    const q = new QuadBatch();
    const s = new StemBatch();
    const cam = new THREE.PerspectiveCamera(32, 1.6, 1, 1000);
    const list = Array.from({ length: 40 }, (_, i) => ({ centre: new THREE.Vector3(i, 0, 0), px: 16, key: `k${i % 3}`, draw: () => {} }));
    q.flush(list, cam, 900, true);
    expect(q.count).toBe(40);
    expect(q.live.visible && q.ghost.visible).toBe(true);
    expect(q.instance(39).centre).toEqual([39, 0, 0]);
    s.flush([{ base: new THREE.Vector3(1, 2, 3), widthPx: 1.75, lengthPx: 12, colour: "#ff0000" }], cam, 900);
    expect(s.instance(0)).toEqual({ base: [1, 2, 3], size: [1.75, 12] });
    q.flush([], cam, 900, true);
    expect(q.live.visible).toBe(false);
    // no pick lands on them
    const hits: THREE.Intersection[] = [];
    q.live.raycast(new THREE.Raycaster(), hits);
    expect(hits).toHaveLength(0);
    // the px scale: perspective by depth, orthographic constant
    expect(perPxUniform(cam, 900).x).toBeCloseTo((2 * Math.tan((32 * Math.PI) / 360)) / 900, 9);
    const o = new THREE.OrthographicCamera(-100, 100, 50, -50);
    expect(perPxUniform(o, 500).toArray()).toEqual([0, 100 / 500]);
    q.dispose();
    s.dispose();
  });
});
