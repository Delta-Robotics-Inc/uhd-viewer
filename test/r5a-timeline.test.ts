/**
 * Wave R5-A (2026-11-02): the timeline panel stays (Kevin: "The bottom popup stays instead of going away after x
 * time"), shows while Explode or Assemble is on, and carries the speed and the direction (server markup; the panel's
 * handlers are covered in cad-timeline-actions-r3b.test.ts).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Assembly, Mat4 } from "@uhd/system/geometry.js";
import type { ModuleDef } from "@uhd/types/index.js";
import { MotionController, SequencePlayer, generateSequence, resolveSequence, type ResolvedWithRadial } from "../src/cad/sequence";
import { createViewStore } from "../src/cad/state";
import * as timeline from "../src/cad/timeline";
import { TIMELINE_CSS, TimelinePanel, directionWords, headerText, speedText, timelineModel, timelineShown } from "../src/cad/timeline";

const T = (x: number, y: number, z: number): Mat4 => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
const def = (id: string): ModuleDef => ({ id, name: id, interfaces: [] }) as unknown as ModuleDef;
const bolt = (role: "structure" | "component") => ({ id: "mount", domain: "mechanical", protocols: [{ type: "bolt_pattern", roles: [role] }] });
function fixture(): Assembly {
  const mate = (link: string, child: string, parent: string, z: number) => ({ linkId: link, a: { path: [child], def: def(child), iface: bolt("component"), frame: { origin: [0, 0, z], normal: [0, 0, -1] } }, b: { path: [parent], def: def(parent), iface: bolt("structure"), frame: { origin: [0, 0, z], normal: [0, 0, 1] } } });
  return {
    instances: [],
    placements: [
      { key: "case", path: ["case"], matrix: T(0, 0, 0) },
      { key: "lid", path: ["lid"], matrix: T(0, 0, 20), via: "lid_mount" },
      { key: "mast", path: ["mast"], matrix: T(0, 0, 30), via: "mast_mount" },
    ],
    mates: [mate("lid_mount", "lid", "case", 20), mate("mast_mount", "mast", "lid", 30)],
    routes: [], hardware: [], harnesses: [], unrouted: [], issues: [],
  } as unknown as Assembly;
}
function resolved(): ResolvedWithRadial {
  const r: ResolvedWithRadial = resolveSequence({ assembly: fixture(), gap: 10 }, generateSequence(fixture(), { root: ["case"] }));
  r.radial = { moves: new Map([["lid", { dir: [0, 0, 1], distance: 30, from: "face" }], ["mast", { dir: [1, 0, 0], distance: 40, from: "face" }]]), centre: [0, 0, 10], radius: 40, ms: 0 };
  return r;
}
const mount = (player: SequencePlayer, requested = false) => {
  const store = createViewStore();
  const run = vi.fn((c) => player.run(c));
  return renderToStaticMarkup(createElement(TimelinePanel, { store, source: { player: () => player, run }, requested }));
};
const settle = (p: SequencePlayer) => {
  for (let i = 0; i < 10_000 && p.tick(1 / 60); i++);
};

describe("the panel stays (no auto-hide)", () => {
  it("has no linger timer any more", () => {
    expect("LINGER_MS" in timeline).toBe(false);
  });

  it("shows while a toggle is on, also with the parts back together and at rest", () => {
    const p = new SequencePlayer(resolved());
    p.setExplode(true);
    settle(p);
    p.setDirection("together");
    p.resume();
    settle(p);
    expect(p.t).toBe(0);
    expect(p.playing).toBeUndefined();
    expect(p.explodeOn).toBe(true);
    // R3-B hid the panel 1.2 s after this; it stays now, however long it rests
    expect(mount(p)).toContain('class="cad-timeline"');
    expect(timelineShown({ explodeOn: true })).toBe(true);
    expect(timelineShown({ assembleOn: true })).toBe(true);
    expect(timelineShown({ requested: true })).toBe(true);
  });

  it("goes when both toggles are off (and nothing asks)", () => {
    const p = new SequencePlayer(resolved());
    p.setAssemble(true);
    settle(p);
    p.setAssemble(false);
    settle(p);
    expect(p.t).toBe(0);
    expect(mount(p)).toBe("");
    expect(timelineShown({})).toBe(false);
    // the toolbar asking still shows it at once (before the player reports a toggle)
    expect(mount(p, true)).toContain('class="cad-timeline"');
  });
});

describe("the speed and the direction on the panel", () => {
  it("draws the direction pair (its words per mode), the speed select and a close button", () => {
    const p = new SequencePlayer(resolved());
    p.setExplode(true);
    settle(p);
    const html = mount(p);
    expect(html).toContain('data-timeline="direction"');
    // wave R5 gate: the pair says which way in its name, so it never reads as the toolbar's toggles
    expect(html).toContain('aria-label="Together: collapse"');
    expect(html).toContain('aria-label="Apart: explode"');
    expect(html).toMatch(/data-dir="apart"[^>]*aria-pressed="true"/);
    expect(html).toContain('<select aria-label="Speed">');
    expect(html).toContain('<option value="0.25">0.25x</option>');
    expect(html).toContain('<option value="4">4x</option>');
    expect(html).toContain('aria-label="Close the timeline"');
    p.setAssemble(true);
    p.setSpeed(2);
    const steps = mount(p);
    expect(steps).toContain('aria-label="Together: assemble"');
    expect(steps).toContain('aria-label="Apart: disassemble"');
    expect(steps).toMatch(/<option value="2" selected="">2x<\/option>/);
  });

  it("an agent's off-list speed shows in the list too", () => {
    const p = new SequencePlayer(resolved());
    p.setExplode(true);
    p.setSpeed(3);
    expect(mount(p)).toMatch(/<option value="3" selected="">3x<\/option>/);
  });

  it("names the direction and speed in the header", () => {
    const m = timelineModel(new SequencePlayer(resolved()).resolved);
    expect(headerText(m, { mode: "sequence", t: 0.5, speed: 2, playing: true, direction: "together" }).sub).toMatch(/ 2x · assemble$/);
    expect(headerText(m, { mode: "radial", t: 0.5, speed: 0.5, playing: false, direction: "apart" }).sub).toMatch(/amount 0\.50 · 0\.5x · explode$/);
    expect(directionWords("radial")).toEqual({ together: "Collapse", apart: "Explode" });
    expect(directionWords("sequence")).toEqual({ together: "Assemble", apart: "Disassemble" });
    expect(speedText(0.25)).toBe("0.25x");
    expect(TIMELINE_CSS).toContain(".cad-tl-speed");
    expect(TIMELINE_CSS).toContain(".cad-tl-dirs");
  });

  it("uses CadView's controller when given one", () => {
    const p = new SequencePlayer(resolved());
    p.setExplode(true);
    const motion = new MotionController({ player: () => p, run: (c) => p.run(c) });
    const store = createViewStore();
    const html = renderToStaticMarkup(createElement(TimelinePanel, { store, source: { player: () => p, run: (c) => p.run(c) }, motion }));
    expect(html).toContain('class="cad-timeline"');
  });
});
