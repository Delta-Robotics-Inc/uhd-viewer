/** How much of the legend fits beside the bottom toolbar (ui/legendFit.ts): full, compact, then a button in the toolbar; folded, a tab. */
import { describe, expect, it } from "vitest";
import { LEGEND_GAP, LEGEND_HYSTERESIS, LEGEND_SHORT, legendFolded, legendRoom, legendStage, type Box, type LegendMeasure } from "../src/ui/legendFit";

/**
 * A canvas `width` wide and 600 high; the legend at its bottom right (8 px in, or `cover` px more for a panel
 * over the canvas's right side); a toolbar `toolbarWidth` wide centred on what the panels leave, both 8 px off the
 * bottom; the folded tab (36 px) at the right edge.
 */
function at(width: number, opts: { full?: number; compact?: number; toolbarWidth?: number; height?: number; slot?: number; inset?: number; cover?: number } = {}): LegendMeasure {
  const { full = 230, compact = 90, toolbarWidth = 430, height = 220, slot, inset = 0, cover = 0 } = opts;
  const right = width - 8 - cover;
  const form = (w: number): Box => ({ left: right - w, right, top: 592 - height, bottom: 592 });
  const tbLeft = inset + (width - inset - cover - toolbarWidth) / 2;
  return {
    right,
    full: form(full),
    compact: form(compact),
    tab: { left: width - cover - 36, right: width - cover, top: 592 - 90, bottom: 592 },
    toolbar: { left: tbLeft, right: tbLeft + toolbarWidth, top: 552, bottom: 592 },
    ...(slot ? { slot } : {}),
  };
}

describe("the legend's form at a canvas width", () => {
  // the VS Code tab's toolbar (about 430 px) and the Domain legend with its meanings (about 230 px full, 90 px compact)
  it.each([
    [1400, "full"],
    [1000, "full"],
    [860, "compact"],
    [620, "button"],
    [400, "button"],
  ] as const)("%i px: %s", (width, stage) => {
    expect(legendStage(at(width))).toBe(stage);
  });

  it("keeps the gap: a form exactly as wide as the room fits, one pixel more does not", () => {
    const m = at(1000);
    const room = legendRoom(m);
    expect(room).toBe(m.right - m.toolbar!.right - LEGEND_GAP);
    expect(legendStage(at(1000, { full: room }))).toBe("full");
    expect(legendStage(at(1000, { full: room + 1 }))).toBe("compact");
    expect(legendStage(at(1000, { full: room + 1, compact: room + 1 }))).toBe("button");
  });

  it("counts a docked panel at the left (the hierarchy): the toolbar is centred on what it leaves, nearer the legend", () => {
    expect(legendStage(at(1100))).toBe("full");
    expect(legendStage(at(1100, { inset: 280 }))).toBe("compact");
    expect(legendStage(at(1100, { inset: 520 }))).toBe("button");
  });

  it("counts a panel over the right side (an inspector): the legend sits left of it", () => {
    expect(legendStage(at(1400, { cover: 352 }))).toBe("full");
    expect(legendStage(at(1100, { cover: 352 }))).toBe("compact");
    expect(legendStage(at(900, { cover: 352 }))).toBe("button");
  });

  it("takes the full form with no toolbar, or one not in its rows", () => {
    expect(legendStage({ ...at(400), toolbar: null })).toBe("full");
    const m = at(400);
    expect(legendStage({ ...m, toolbar: { ...m.toolbar!, top: 100, bottom: 140 } }, "button")).toBe("full");
  });

  it("measures the toolbar as if its legend button were not in it, so the button does not keep the legend away", () => {
    // 860 px, compact fits; the toolbar with the button (40 px) reaches 20 px further right, as it is centred
    const without = at(860);
    const withButton = at(860, { toolbarWidth: 430 + 40, slot: 40 });
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

describe("the folded legend", () => {
  it("is the tab at the right edge while the tab clears the toolbar, then the toolbar's button", () => {
    expect(legendStage(at(1400), "full", true)).toBe("full");
    expect(legendStage(at(560), "full", true)).toBe("full");
    // the toolbar reaches the tab only when the canvas is about as narrow as the toolbar and the tab together
    expect(legendStage(at(470), "full", true)).toBe("button");
  });

  it("is the tab whatever the card's width: the card is not shown", () => {
    expect(legendStage(at(700, { full: 600, compact: 500 }), "full", true)).toBe("full");
  });
});

describe("folding on a short canvas", () => {
  it("folds by itself below the threshold, unless opened while short", () => {
    expect(legendFolded(true, 860, false)).toBe(false);
    expect(legendFolded(true, LEGEND_SHORT, false)).toBe(false);
    expect(legendFolded(true, LEGEND_SHORT - 1, false)).toBe(true);
    expect(legendFolded(true, 420, true)).toBe(false);
  });

  it("stays folded when the user folded it, at any height", () => {
    expect(legendFolded(false, 860, false)).toBe(true);
    expect(legendFolded(false, 420, true)).toBe(true);
  });

  it("does not fold before the canvas is measured", () => {
    expect(legendFolded(true, 0, false)).toBe(false);
  });
});
