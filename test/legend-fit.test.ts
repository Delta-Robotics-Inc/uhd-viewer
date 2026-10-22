/** How much of the legend fits beside the bottom toolbar (ui/legendFit.ts): full, compact, then a button in the toolbar. */
import { describe, expect, it } from "vitest";
import { LEGEND_GAP, LEGEND_HYSTERESIS, legendRoom, legendStage, type Box, type LegendMeasure } from "../src/ui/legendFit";

/** A canvas `width` wide and 600 high; the legend at its bottom left (8 px in); a centred toolbar `toolbarWidth` wide, both 8 px off the bottom. */
function at(width: number, opts: { full?: number; compact?: number; toolbarWidth?: number; height?: number; slot?: number; inset?: number } = {}): LegendMeasure {
  const { full = 170, compact = 70, toolbarWidth = 430, height = 180, slot, inset = 0 } = opts;
  const left = inset + 8;
  const form = (w: number): Box => ({ left, right: left + w, top: 592 - height, bottom: 592 });
  const tbLeft = inset + (width - inset - toolbarWidth) / 2;
  return { left, full: form(full), compact: form(compact), toolbar: { left: tbLeft, right: tbLeft + toolbarWidth, top: 552, bottom: 592 }, ...(slot ? { slot } : {}) };
}

describe("the legend's form at a canvas width", () => {
  // the web viewer's toolbar (about 430 px) and Domain legend (about 170 px full, 70 px compact)
  it.each([
    [1400, "full"],
    [1000, "full"],
    [760, "compact"],
    [560, "button"],
    [400, "button"],
  ] as const)("%i px: %s", (width, stage) => {
    expect(legendStage(at(width))).toBe(stage);
  });

  it("keeps the gap: a form exactly as wide as the room fits, one pixel more does not", () => {
    const m = at(1000);
    const room = legendRoom(m);
    expect(room).toBe(m.toolbar!.left - m.left - LEGEND_GAP);
    expect(legendStage(at(1000, { full: room }))).toBe("full");
    expect(legendStage(at(1000, { full: room + 1 }))).toBe("compact");
    expect(legendStage(at(1000, { full: room + 1, compact: room + 1 }))).toBe("button");
  });

  it("counts a docked panel at the left (the hierarchy): the legend and the toolbar both start after it", () => {
    expect(legendStage(at(1000))).toBe("full");
    expect(legendStage(at(1000, { inset: 280 }))).toBe("compact");
    expect(legendStage(at(1000, { inset: 400 }))).toBe("button");
  });

  it("takes the full form with no toolbar, or one not in its rows", () => {
    expect(legendStage({ ...at(400), toolbar: null })).toBe("full");
    const m = at(400);
    expect(legendStage({ ...m, toolbar: { ...m.toolbar!, top: 100, bottom: 140 } }, "button")).toBe("full");
  });

  it("measures the toolbar as if its legend button were not in it, so the button does not keep the legend away", () => {
    // 760 px, compact fits; the toolbar with the button (40 px) is 20 px further left, as it is centred
    const without = at(760);
    const withButton = at(760, { toolbarWidth: 430 + 40, slot: 40 });
    expect(legendRoom(withButton)).toBe(legendRoom(without));
    expect(legendStage(withButton, "button")).toBe("compact");
  });

  it("comes back to a larger form only with room to spare, so a width at the edge does not flicker", () => {
    const room = legendRoom(at(1000));
    const edge = at(1000, { full: room - 2 });
    expect(legendStage(edge, "full")).toBe("full");
    expect(legendStage(edge, "compact")).toBe("compact");
    expect(legendStage(at(1000, { full: room - LEGEND_HYSTERESIS }), "compact")).toBe("full");
    const compactEdge = at(1000, { full: 999, compact: room - 2 });
    expect(legendStage(compactEdge, "button")).toBe("button");
    expect(legendStage(compactEdge, "compact")).toBe("compact");
  });
});
