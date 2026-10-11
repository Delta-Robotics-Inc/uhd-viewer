import { describe, expect, it } from "vitest";
import { cardHeight, cardInsets, fitChips, portLabelText, sideLabelWidth } from "../src/layout/card-body";
import { computeLayout, type PortGroup } from "../src/layout/layout";
import type { ViewModel, ViewNode, ViewPort } from "../src/model/types";

const group = (protocol: string, count: number): PortGroup => ({ protocol, domain: "electrical", count });
/** The smart bottle's cap board: four protocols of unlinked interfaces and a few more. */
const CAP_BOARD = [group("custom", 11), group("power", 4), group("connector", 1), group("digital", 1), group("i2c", 1), group("uart", 1)];

const BOTTOM = cardInsets([{ side: "bottom", name: "4 x M2 on Ø54" }], 170);
const port = (id: string, protocol = "custom"): ViewPort => ({ id, name: id, domain: "mechanical", protocol, roles: [], children: [] });
const node = (id: string, label: string, ports: ViewPort[]): ViewNode => ({ id, label, icon: "box", kind: "module", ports, shape: "rect", status: "configured", childCount: 0 });

describe("module card body", () => {
  it("keeps the port labels clear: a row on the top and bottom, the longest label's width on the sides", () => {
    const none = cardInsets([], 170);
    expect(cardInsets([{ side: "bottom", name: "Board bosses" }], 170).bottom).toBeGreaterThan(none.bottom);
    expect(cardInsets([{ side: "top", name: "x" }], 170).top).toBe(cardInsets([{ side: "bottom", name: "x" }], 170).bottom);
    // a long label on the right ("Mounting holes" beside the chips) pushes the body in, up to the label's cut-off width
    const right = cardInsets([{ side: "right", name: "Mounting holes" }], 170);
    expect(right.right).toBeGreaterThan(none.right);
    expect(right.left).toBe(none.left);
    expect(cardInsets([{ side: "right", name: "A very long port name that is cut with an ellipsis" }], 170).right).toBeLessThanOrEqual(9 + sideLabelWidth(170) + 4);
    // the qualifier the label drops does not count
    expect(portLabelText("Lid seal (AS568-040)")).toBe("Lid seal");
  });

  it("needs more height for chips and for a bottom label row", () => {
    const plain = cardHeight("Cap board", 170, [], cardInsets([], 170));
    const chips = cardHeight("Cap board", 170, CAP_BOARD, cardInsets([], 170));
    const both = cardHeight("Cap board", 170, CAP_BOARD, BOTTOM);
    expect(chips).toBeGreaterThan(plain);
    expect(both).toBeGreaterThan(chips);
  });

  it("draws only the chips that fit, the rest counted in +N", () => {
    const insets = BOTTOM;
    // a card as tall as it needs: the first chips, and +N for the interfaces of the others
    const tall = fitChips("Cap board", { w: 170, h: cardHeight("Cap board", 170, CAP_BOARD, insets) }, CAP_BOARD, insets);
    expect(tall.shown.length).toBeGreaterThan(0);
    const counted = tall.shown.reduce((n, g) => n + g.count, 0) + tall.rest;
    expect(counted).toBe(CAP_BOARD.reduce((n, g) => n + g.count, 0));
    // the default card height (84): fewer chips, never past the bottom label row
    const short = fitChips("Cap board", { w: 170, h: 84 }, CAP_BOARD, insets);
    expect(short.shown.length).toBeLessThan(tall.shown.length);
    // no room for a row: no chips at all
    expect(fitChips("Cap board", { w: 170, h: 48 }, CAP_BOARD, insets)).toEqual({ shown: [], rest: 0 });
  });
});

describe("layout grows a card to fit its body", () => {
  // the board's unlinked interfaces make its chips; its link to the housing below leaves from its bottom edge
  const board = node("board", "Cap board", [
    port("down"),
    ...CAP_BOARD.flatMap((g) => Array.from({ length: g.count }, (_, i) => port(`${g.protocol}${i}`, g.protocol))),
  ]);
  const housing = node("housing", "Cap housing", [port("up")]);
  const vm: ViewModel = {
    path: [{ id: "", label: "Bottle" }],
    nodes: [board, housing],
    links: [{ id: "l1", linkId: "l1", source: { node: "board", port: "down" }, target: { node: "housing", port: "up" }, name: "Board screws", domain: "mechanical", protocol: "custom", state: "configured", children: [], diagnostics: [] }],
    derived: [],
  };
  const hand = { nodes: { board: { x: 0, y: 0 }, housing: { x: 0, y: 400 } } };

  it("so its chips clear the labels of its bottom ports", () => {
    const layout = computeLayout(vm, hand, {}, false);
    expect(layout.ports["board|down"].side).toBe("bottom");
    const box = layout.boxes.board;
    expect(box.h).toBeGreaterThanOrEqual(cardHeight("Cap board", box.w, layout.groups.board, BOTTOM));
    expect(fitChips("Cap board", box, layout.groups.board, BOTTOM).shown.length).toBeGreaterThan(0);
  });

  it("but never past a hand-set height", () => {
    const layout = computeLayout(vm, { nodes: { ...hand.nodes, board: { x: 0, y: 0, h: 96 } } }, {}, false);
    expect(layout.boxes.board.h).toBe(96);
  });
});

describe("a card as wide as its labels need (node labels)", () => {
  const linked = (a: ViewNode, b: ViewNode, ids: [string, string][]): ViewModel =>
    ({
      path: [],
      nodes: [a, b],
      links: ids.map(([s, t], i) => ({ id: `l${i}`, linkId: `l${i}`, name: `l${i}`, source: { node: a.id, port: s }, target: { node: b.id, port: t }, domain: "electrical", protocol: "custom", state: "configured", children: [], conductors: [] })),
      derived: [],
    }) as unknown as ViewModel;

  it("keeps the plain width for short labels and grows for long ones, up to a limit", async () => {
    const { cardWidth, labelIsCut, CARD_W, CARD_W_MAX, sideLabelWidth: side } = await import("../src/layout/card-body");
    expect(cardWidth([])).toBe(CARD_W);
    expect(cardWidth(["vbus", "gnd"])).toBe(CARD_W);
    const long = cardWidth(["probe_power_out"]);
    expect(long).toBeGreaterThan(CARD_W);
    expect(long).toBeLessThanOrEqual(CARD_W_MAX);
    // at that width the label fits beside the body
    expect(labelIsCut("probe_power_out", side(long))).toBe(false);
    expect(labelIsCut("probe_power_out", side(CARD_W))).toBe(true);
    // past the limit a label is cut (and says its whole name on hover); so is one whose qualifier is left out
    expect(cardWidth(["a very long interface name that no card should grow for"])).toBe(CARD_W_MAX);
    expect(labelIsCut("a very long interface name that no card should grow for", side(CARD_W_MAX))).toBe(true);
    expect(labelIsCut("Lid seal (AS568-040)", 200)).toBe(true);
    expect(labelIsCut("vbus", 40)).toBe(false);
  });

  it("grows a card in the layout for the labels of its linked interfaces only", () => {
    const a = node("a", "Board", [port("probe_power_out"), port("an_unlinked_interface_with_a_long_name")]);
    const b = node("b", "Probe", [port("in")]);
    const plain = computeLayout(linked(node("a", "Board", [port("out")]), b, [["out", "in"]]), undefined, {}, false);
    const grown = computeLayout(linked(a, b, [["probe_power_out", "in"]]), undefined, {}, false);
    expect(plain.boxes.a.w).toBe(176);
    expect(grown.boxes.a.w).toBeGreaterThan(176);
    expect(grown.boxes.a.w).toBeLessThanOrEqual(272);
    expect(grown.boxes.b.w).toBe(176);
    // the two cards do not overlap in the automatic layout
    expect(grown.boxes.a.x + grown.boxes.a.w <= grown.boxes.b.x || grown.boxes.b.x + grown.boxes.b.w <= grown.boxes.a.x).toBe(true);
  });

  it("grows only into free room on a level the display file lays out, and keeps a width it sets", () => {
    const a = node("a", "Board", [port("probe_power_out")]);
    const b = node("b", "Probe", [port("in")]);
    const vm = linked(a, b, [["probe_power_out", "in"]]);
    // a neighbour 48 px to the right of the plain card: no room to grow
    const tight = computeLayout(vm, { nodes: { a: { x: 0, y: 0 }, b: { x: 224, y: 0 } } }, {}, false);
    expect(tight.boxes.a.w).toBe(176);
    // far away: it grows
    const roomy = computeLayout(vm, { nodes: { a: { x: 0, y: 0 }, b: { x: 640, y: 0 } } }, {}, false);
    expect(roomy.boxes.a.w).toBeGreaterThan(176);
    expect(roomy.boxes.a.x + roomy.boxes.a.w).toBeLessThan(640);
    // a neighbour above or below does not hold it back
    const below = computeLayout(vm, { nodes: { a: { x: 0, y: 0 }, b: { x: 224, y: 400 } } }, {}, false);
    expect(below.boxes.a.w).toBeGreaterThan(176);
    // the display file's own width stands
    const set = computeLayout(vm, { nodes: { a: { x: 0, y: 0, w: 192 }, b: { x: 640, y: 0 } } }, {}, false);
    expect(set.boxes.a.w).toBe(192);
  });
});
