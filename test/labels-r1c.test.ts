/**
 * R1-C (Kevin's walkthrough 2026-11-01): exploded-view labels. D5: the end bar on the leader's side, column
 * hysteresis, eased slot changes, the leader glued to its anchor in the same frame, labels behind the model faded;
 * D2: a wheel over a label zooms the view; M12: no internal wording in subtitles.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import { BEHIND_OPACITY, JUMP_PX, LabelLayer, SLOT_EASE_MS, SWITCH_HOLD_MS, SWITCH_MARGIN, easeLeft, holdSides, labelSubtitle, partSubtitle, solveLabels, type LabelItem } from "../src/cad/labels";
import { FakeEl, FakeWheelEvent, installFakeDom } from "./labels-fakedom";

const W = 1440;
const H = 900;
const M = { top: 60, bottom: 64, left: 56, right: 16 };

describe("column hysteresis (D5b)", () => {
  it("keeps a label's side until its anchor is past the midline by the margin for the hold time", () => {
    const prev = new Map<string, { side: -1 | 1; since?: number }>([["a", { side: -1 }]]);
    // anchors span 400..1000: the midline is 700; the switch line for a left label is 700 + 8 % of 1440
    const line = 700 + SWITCH_MARGIN * W;
    const items = (x: number) => [
      { id: "a", x },
      { id: "l", x: 400 },
      { id: "r", x: 1000 },
    ];
    // a little past the midline: stays left, nothing pending
    expect(holdSides(items(720), prev, W, 0).get("a")).toEqual({ side: -1 });
    // past the switch line: pending, still left
    const p1 = holdSides(items(line + 5), prev, W, 1000);
    expect(p1.get("a")).toEqual({ side: -1, since: 1000 });
    // held, but not long enough
    expect(holdSides(items(line + 5), p1, W, 1000 + SWITCH_HOLD_MS - 1).get("a")).toEqual({ side: -1, since: 1000 });
    // long enough: switches
    expect(holdSides(items(line + 5), p1, W, 1000 + SWITCH_HOLD_MS).get("a")).toEqual({ side: 1 });
    // back before the hold ends: the pending switch is dropped
    expect(holdSides(items(710), p1, W, 1100).get("a")).toEqual({ side: -1 });
    // labels with no side yet are left to the solver
    expect(holdSides(items(500), prev, W, 0).has("l")).toBe(false);
  });

  it("the solver keeps fixed sides and balances only the free labels", () => {
    const items = [
      { id: "a", x: 1100, y: 300, w: 120, h: 30 },
      { id: "b", x: 1120, y: 400, w: 120, h: 30 },
      { id: "c", x: 300, y: 500, w: 120, h: 30 },
    ];
    const free = solveLabels(items, W, H, M);
    expect(free.get("a")!.side).toBe(1);
    const fixed = solveLabels(items, W, H, M, new Map([["a", -1 as const]]));
    expect(fixed.get("a")!.side).toBe(-1);
    expect(fixed.get("c")!.side).toBe(-1);
  });

  it("eases out over the slot time", () => {
    expect(easeLeft(0)).toBe(1);
    expect(easeLeft(SLOT_EASE_MS)).toBe(0);
    expect(easeLeft(SLOT_EASE_MS / 2)).toBeCloseTo(0.125, 5);
    // ease-out: most of the way in the first half
    expect(easeLeft(SLOT_EASE_MS / 4)).toBeLessThan(0.5);
  });
});

describe("subtitles (M12)", () => {
  it("drops internal wording, keeps refdes or MPN", () => {
    expect(labelSubtitle("placed by a display hint")).toBeUndefined();
    expect(labelSubtitle("Placed by display hint")).toBeUndefined();
    expect(labelSubtitle("  ")).toBeUndefined();
    expect(labelSubtitle("Grill triangle (rev0)")).toBe("Grill triangle (rev0)");
    expect(partSubtitle({ refdes: "U13", mpn: "TPS54429" })).toBe("U13");
    expect(partSubtitle({ mpn: "TPS54429" })).toBe("TPS54429");
    expect(partSubtitle(undefined)).toBeUndefined();
  });
});

describe("the label layer in a page (stand-in DOM)", () => {
  let dom: ReturnType<typeof installFakeDom>;
  beforeEach(() => {
    dom = installFakeDom();
  });
  afterEach(() => dom.restore());

  const camera = () => {
    const c = new THREE.PerspectiveCamera(32, W / H, 1, 5000);
    c.up.set(0, 0, 1);
    c.position.set(0, -400, 200);
    c.lookAt(0, 0, 0);
    c.updateMatrixWorld();
    return c;
  };
  const cards = (layer: LabelLayer) => (layer.root as unknown as FakeEl).children.filter((e) => e.className.includes("cad-label"));
  const svg = (layer: LabelLayer) => (layer.root as unknown as FakeEl).children[0];

  it("puts the end bar on the side the leader enters, and drops internal subtitles", () => {
    const layer = new LabelLayer(dom.host as unknown as HTMLElement);
    layer.target = layer.opacity = 1;
    const items: LabelItem[] = [
      { id: "left", kind: "module", title: "Blank triangle 4", sub: "placed by a display hint", anchor: () => new THREE.Vector3(-60, 0, 0) },
      { id: "right", kind: "module", title: "Grill triangle 2", sub: "Grill triangle (rev0)", anchor: () => new THREE.Vector3(60, 0, 0) },
    ];
    layer.setItems(items);
    layer.update(camera(), W, H, 1 / 60, 0);
    const [l, r] = cards(layer);
    expect(l.classList.contains("side-l")).toBe(true);
    expect(r.classList.contains("side-r")).toBe(true);
    // M12: the internal subtitle is not rendered
    expect(l.innerHTML).not.toContain("cad-label-sub");
    expect(r.innerHTML).toContain("cad-label-sub");
    // the stylesheet moves the bar to the right edge of a left-column card
    const css = dom.doc.head.children.map((c) => c.textContent).join("\n");
    expect(css).toMatch(/\.cad-label\.side-l \{[^}]*border-right-width: 3px/);
    expect(css).toContain(`opacity: ${BEHIND_OPACITY}`);
  });

  it("glues the leader's base to the anchor in the same frame the camera moved (D5c)", () => {
    const layer = new LabelLayer(dom.host as unknown as HTMLElement);
    layer.target = layer.opacity = 1;
    const anchor = new THREE.Vector3(20, 10, 30);
    layer.setItems([{ id: "a", kind: "module", title: "A", anchor: () => anchor }]);
    const cam = camera();
    layer.update(cam, W, H, 1 / 60, 0);
    // the controls move the camera; its matrices are brought up to date only later in the frame
    cam.position.set(120, -380, 160);
    cam.lookAt(0, 0, 0);
    layer.update(cam, W, H, 1 / 60, 16);
    const want = anchor.clone().project(cam);
    const dot = svg(layer).children.find((c) => c.tagName === "circle")!;
    expect(Number(dot.getAttribute("cx"))).toBeCloseTo(((want.x + 1) / 2) * W, 0);
    expect(Number(dot.getAttribute("cy"))).toBeCloseTo(((1 - want.y) / 2) * H, 0);
  });

  it("an orbit at 60 fps: a slot change is spread over frames, never one jump; sides hold near the midline", () => {
    const layer = new LabelLayer(dom.host as unknown as HTMLElement);
    layer.target = layer.opacity = 1;
    // twelve anchors on a ring (an exploded assembly), orbited a full turn in 4 s
    const pts = Array.from({ length: 12 }, (_, i) => new THREE.Vector3(Math.cos(i * 0.52) * 90, Math.sin(i * 0.52) * 90, (i % 3) * 25));
    layer.setItems(pts.map((p, i) => ({ id: `p${i}`, kind: "module", title: `Part ${i}`, anchor: () => p })));
    const cam = new THREE.PerspectiveCamera(32, W / H, 1, 5000);
    cam.up.set(0, 0, 1);
    const prev = new Map<string, { at: [number, number]; target: [number, number]; side: number }>();
    let jumps = 0;
    let worstShare = 0;
    let flips = 0;
    for (let f = 0; f <= 240; f++) {
      const t = f * (1000 / 60);
      const az = (f / 240) * Math.PI * 2;
      cam.position.set(Math.sin(az) * 420, -Math.cos(az) * 420, 220);
      cam.lookAt(0, 0, 0);
      layer.update(cam, W, H, 1 / 60, t);
      for (const l of layer.layout()) {
        const p = prev.get(l.id);
        if (p) {
          const jump = Math.hypot(l.target[0] - p.target[0], l.target[1] - p.target[1]);
          if (jump > 3 * JUMP_PX) {
            // the solver moved this card to another slot: the card itself moves a small share of that this frame
            jumps++;
            const step = Math.hypot(l.at[0] - p.at[0], l.at[1] - p.at[1]);
            worstShare = Math.max(worstShare, step / jump);
          }
          if (p.side !== l.side) flips++;
        }
        prev.set(l.id, { at: l.at, target: l.target, side: l.side });
      }
    }
    // before R1-C a card drawn on a new slot moved there in the frame it changed (share 1); now it starts from where
    // it was and eases out over SLOT_EASE_MS
    expect(jumps).toBeGreaterThan(0);
    expect(worstShare).toBeLessThan(0.1);
    // each label crosses at most twice in one turn (it passes behind and comes back), never flickers
    expect(flips).toBeLessThanOrEqual(pts.length * 2);
  });

  it("snap (a still) places cards at once; a jump is eased from where the card was", () => {
    const layer = new LabelLayer(dom.host as unknown as HTMLElement);
    layer.target = layer.opacity = 1;
    const a = new THREE.Vector3(-40, 0, 0);
    layer.setItems([{ id: "a", kind: "module", title: "A", anchor: () => a }]);
    const cam = camera();
    layer.update(cam, W, H, 1 / 60, 0);
    const before = layer.layout()[0];
    // the anchor jumps far across: its target moves, the card eases (not there in the next frame)
    a.set(0, 0, 160);
    layer.update(cam, W, H, 1 / 60, 16);
    const mid = layer.layout()[0];
    expect(Math.abs(mid.at[1] - mid.target[1])).toBeGreaterThan(JUMP_PX / 2);
    layer.update(cam, W, H, 1 / 60, 16 + SLOT_EASE_MS + 1);
    const done = layer.layout()[0];
    expect(done.at[1]).toBeCloseTo(done.target[1], 3);
    expect(before.at[1]).not.toBeCloseTo(done.at[1], 0);
    layer.snap = true;
    a.set(-40, 0, 0);
    layer.update(cam, W, H, 1 / 60, 1000);
    const snapped = layer.layout()[0];
    expect(snapped.at).toEqual(snapped.target);
  });

  it("fades labels whose anchor is behind the model's centre", () => {
    const layer = new LabelLayer(dom.host as unknown as HTMLElement);
    layer.target = layer.opacity = 1;
    // camera at -y looking at the origin: +y is behind
    layer.setItems([
      { id: "front", kind: "module", title: "F", anchor: () => new THREE.Vector3(0, -80, 0) },
      { id: "back", kind: "module", title: "B", anchor: () => new THREE.Vector3(0, 80, 0) },
    ]);
    layer.update(camera(), W, H, 1 / 60, 0);
    const by = Object.fromEntries(layer.layout().map((l) => [l.id, l.behind]));
    expect(by).toEqual({ front: false, back: true });
    const back = cards(layer)[1];
    expect(back.classList.contains("behind")).toBe(true);
  });

  it("a wheel over a label zooms the view: forwarded to the canvas (D2)", () => {
    const g = globalThis as { WheelEvent?: unknown };
    const had = g.WheelEvent;
    g.WheelEvent = FakeWheelEvent;
    try {
      const layer = new LabelLayer(dom.host as unknown as HTMLElement);
      const canvas = dom.host.children.find((c) => c.tagName === "CANVAS")!;
      const got: FakeWheelEvent[] = [];
      canvas.addEventListener("wheel", (e) => got.push(e as FakeWheelEvent));
      const e = new FakeWheelEvent("wheel", { deltaY: -120, clientX: 300, clientY: 200, ctrlKey: true, bubbles: true, cancelable: true });
      (layer.root as unknown as FakeEl).dispatchEvent(e);
      expect(got).toHaveLength(1);
      expect(got[0].deltaY).toBe(-120);
      expect(got[0].clientX).toBe(300);
      expect(got[0].ctrlKey).toBe(true);
      expect(e.defaultPrevented).toBe(true);
      layer.dispose();
      (layer.root as unknown as FakeEl).dispatchEvent(new FakeWheelEvent("wheel", { deltaY: 1, cancelable: true }));
      expect(got).toHaveLength(1);
    } finally {
      g.WheelEvent = had;
    }
  });
});
