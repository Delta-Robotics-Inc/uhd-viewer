/**
 * R5-B (2026-11-02, Kevin): "The explode and assembly buttons are individual on and off toggles, not one or the
 * other." "If you switch mid animation, the assembly does not autostart; you have to click play to continue."
 * "Clicking the void should deselect callouts."
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ASSEMBLE_LABEL, CadToolbar, EXPLODE_LABEL, type CadToolbarProps } from "../src/cad/CadToolbar";
import {
  CLICK_TOLERANCE_PX,
  flipToggle,
  hasCalloutSelection,
  pressToggle,
  releaseAction,
  timelineOpenFor,
  togglesOf,
  voidMenuFor,
  type MotionToggles,
  type VoidMenuInput,
} from "../src/cad/nav";
import { createViewStore } from "../src/cad/state";
import { MotionController } from "../src/cad/sequence";

const ALL: MotionToggles[] = [
  { explode: false, assemble: false },
  { explode: true, assemble: false },
  { explode: false, assemble: true },
  { explode: true, assemble: true },
];

const props = (over: Partial<CadToolbarProps> = {}): CadToolbarProps =>
  ({
    exploded: false, onExploded: () => {}, labels: false, onLabels: () => {}, labelKinds: new Set(["module"]), onLabelKind: () => {}, labelMenu: false, onLabelMenu: () => {},
    hardwareCount: 0, hardware: false, onHardware: () => {}, harnessCount: 0, wires: false, onWires: () => {}, frames: false, onFrames: () => {},
    section: null, onSection: () => {}, sectionMenu: false, onSectionMenu: () => {}, autoFlip: () => true, shells: 0, xray: false, onXray: () => {},
    findings: 0, showFindings: false, onFindings: () => {}, direction: "feature", onDirection: () => {}, onFit: () => {}, onFocus: () => {}, canFocus: false,
    sections: [], onSections: () => {},
    ...over,
  }) as CadToolbarProps;
const html = (over: Partial<CadToolbarProps> = {}) => renderToStaticMarkup(createElement(CadToolbar, props(over)));
const tag = (m: string, which: "explode" | "assemble") => m.match(new RegExp(`<button[^>]*data-toggle="${which}"[^>]*>`))?.[0] ?? "";

describe("Explode and Assemble are two independent toggles", () => {
  it("tooltips are Kevin's words", () => {
    expect(EXPLODE_LABEL).toBe("Explode");
    expect(ASSEMBLE_LABEL).toBe("Assemble");
  });

  it("the toolbar shows all four on/off combinations, each button pressed only by its own flag", () => {
    for (const t of ALL) {
      const m = html({ toggles: t });
      expect(tag(m, "explode")).toContain(`aria-pressed="${t.explode}"`);
      expect(tag(m, "assemble")).toContain(`aria-pressed="${t.assemble}"`);
      expect(tag(m, "explode")).toContain('data-tooltip="Explode"');
      expect(tag(m, "assemble")).toContain('data-tooltip="Assemble"');
      expect(m).toContain('data-glyph="explode"');
      expect(m).toContain('data-glyph="assemble"');
    }
  });

  it("a press flips only its own toggle, from every combination", () => {
    for (const t of ALL) {
      expect(flipToggle(t, "explode")).toEqual({ explode: !t.explode, assemble: t.assemble });
      expect(flipToggle(t, "assemble")).toEqual({ explode: t.explode, assemble: !t.assemble });
    }
    // reaching each combination from all off
    let t: MotionToggles = { explode: false, assemble: false };
    t = flipToggle(t, "explode");
    expect(t).toEqual({ explode: true, assemble: false });
    t = flipToggle(t, "assemble");
    expect(t).toEqual({ explode: true, assemble: true });
    t = flipToggle(t, "explode");
    expect(t).toEqual({ explode: false, assemble: true });
  });

  it("the timeline is open while either is on, closed when both are off", () => {
    expect(ALL.map(timelineOpenFor)).toEqual([false, true, true, true]);
  });

  it("the view state reads both flags on their own; a pre-R5 state reads from t and mode", () => {
    expect(togglesOf({ t: 1, mode: "radial", on: true, assemble: true })).toEqual({ explode: true, assemble: true });
    expect(togglesOf({ t: 0, on: false, assemble: true })).toEqual({ explode: false, assemble: true });
    expect(togglesOf({ t: 0 })).toEqual({ explode: false, assemble: false });
    expect(togglesOf({ t: 1, mode: "radial" })).toEqual({ explode: true, assemble: false });
    expect(togglesOf({ t: 1, mode: "sequence" })).toEqual({ explode: false, assemble: true });
    expect(togglesOf({ t: 0.4, step: "fit:a" })).toEqual({ explode: false, assemble: true });
  });
});

describe("a toggle never starts play (a switch mid-animation stays paused)", () => {
  const controller = () => ({ setExplode: vi.fn(), setAssemble: vi.fn(), play: vi.fn(), pause: vi.fn() });

  it("each press calls only its own setter, never play, from every combination", () => {
    for (const t of ALL) {
      for (const which of ["explode", "assemble"] as const) {
        const c = controller();
        const next = pressToggle(c, t, which);
        expect(next[which]).toBe(!t[which]);
        expect(c.play).not.toHaveBeenCalled();
        if (which === "explode") {
          expect(c.setExplode).toHaveBeenCalledWith(!t.explode);
          expect(c.setAssemble).not.toHaveBeenCalled();
        } else {
          expect(c.setAssemble).toHaveBeenCalledWith(!t.assemble);
          expect(c.setExplode).not.toHaveBeenCalled();
        }
      }
    }
  });

  it("a mid-animation switch (Explode off while Assemble plays) does not call play", () => {
    const c = controller();
    let t: MotionToggles = { explode: true, assemble: true };
    t = pressToggle(c, t, "explode");
    t = pressToggle(c, t, "explode");
    t = pressToggle(c, t, "assemble");
    expect(c.play).not.toHaveBeenCalled();
    expect(t).toEqual({ explode: true, assemble: false });
  });
});

describe("through R5-A's MotionController, a press sends only a toggle command (never play or resume)", () => {
  it("in all four combinations, each press is one `toggle` command naming its own flag", () => {
    for (const t of ALL) {
      for (const which of ["explode", "assemble"] as const) {
        const sent: { action: string }[] = [];
        const ctrl = new MotionController({ player: () => null, run: (c) => (sent.push(c as { action: string }), { ok: true }) });
        pressToggle(ctrl, t, which);
        expect(sent).toEqual([{ action: "toggle", [which]: !t[which] }]);
        expect(sent.some((c) => c.action === "play" || c.action === "resume" || c.action === "loop")).toBe(false);
      }
    }
  });
});

describe("the void menu's Explode and Assemble match the toggles", () => {
  const base: VoidMenuInput = { hidden: 0, isolated: false, exploded: false, mode: "radial", section: false, capture: true };
  it("two checkbox items, checked by their own flag, in all four combinations", () => {
    for (const t of ALL) {
      const m = voidMenuFor({ ...base, toggles: t });
      expect(m.find((i) => i.id === "explode")).toMatchObject({ label: "Explode", checked: t.explode });
      expect(m.find((i) => i.id === "assemble")).toMatchObject({ label: "Assemble", checked: t.assemble });
    }
  });
});

describe("a click on empty space deselects callouts; a drag does not", () => {
  it("a left click in the void clears (parts and callouts)", () => {
    expect(releaseAction({ far: 0, button: 0, measuring: false, hit: false })).toBe("deselect");
    expect(releaseAction({ far: CLICK_TOLERANCE_PX, button: 0, measuring: false, hit: false })).toBe("deselect");
  });

  it("a drag (orbit, pan) beyond the click tolerance clears nothing", () => {
    expect(releaseAction({ far: CLICK_TOLERANCE_PX + 0.5, button: 0, measuring: false, hit: false })).toBe("drag");
    expect(releaseAction({ far: 40, button: 2, measuring: false, hit: false })).toBe("drag");
    expect(releaseAction({ far: 40, button: 0, measuring: true, hit: true })).toBe("drag");
  });

  it("a right-click in the void opens the view's menu and keeps the selection (R4-A)", () => {
    expect(releaseAction({ far: 1, button: 2, measuring: false, hit: false })).toBe("voidMenu");
  });

  it("a click on a part selects it; the Measure tool takes clicks while on", () => {
    expect(releaseAction({ far: 0, button: 0, measuring: false, hit: true })).toBe("select");
    expect(releaseAction({ far: 0, button: 0, measuring: true, hit: false })).toBe("measure");
  });

  it("there is something to clear only when a card is pinned or a finding is current", () => {
    expect(hasCalloutSelection({ open: new Set() })).toBe(false);
    expect(hasCalloutSelection({ open: new Set(["f1"]) })).toBe(true);
    expect(hasCalloutSelection({ open: new Set(), current: "f1" })).toBe(true);
  });
});

describe("the view state carries both flags (the bridge, both ways)", () => {
  it("the flags go through the store's explode op and are kept by a write that leaves them out (the bridge, both ways)", () => {
    const store = createViewStore();
    expect(store.dispatch([{ op: "explode", t: 1, mode: "sequence", on: true, assemble: true } as never])).not.toHaveProperty("error");
    expect(togglesOf(store.get().explode)).toEqual({ explode: true, assemble: true });
    // the player's step write-back (no flags) keeps them
    store.dispatch([{ op: "explode", t: 0.5, step: null } as never]);
    expect(store.get().explode).toMatchObject({ t: 0.5, mode: "sequence", on: true, assemble: true });
    // an agent turns Explode off only
    store.dispatch([{ op: "explode", t: 0.5, on: false } as never]);
    expect(togglesOf(store.get().explode)).toEqual({ explode: false, assemble: true });
    // and a bad flag is refused
    const bad = store.dispatch([{ op: "explode", t: 0, on: "yes" } as never]);
    expect(bad && "error" in bad ? bad.error : "").toMatch(/explode.on must be true or false/);
  });
});
