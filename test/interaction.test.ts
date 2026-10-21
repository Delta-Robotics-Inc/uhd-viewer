/** How the pointer and the keys act on the diagram (canvas/interaction.ts), and what a double-click opens. */
import { describe, expect, it } from "vitest";
import { applySelectChanges, canvasCommand, firstView, initialInteraction, interactionProps, interactionReducer, typingTarget, validViewport, TOOL_OPTIONS, type InteractionState } from "../src/canvas/interaction";
import { openAction } from "../src/viewer/controller";
import { deliver } from "../src/host/channel";
import { isViewerEvent } from "../src/host/protocol";

describe("the pointer's tool", () => {
  it("starts on select: a left-drag on the empty canvas draws a selection box, the middle button pans", () => {
    expect(initialInteraction).toEqual({ tool: "select", space: false });
    expect(interactionProps(initialInteraction)).toEqual({ panOnDrag: [1], selectionOnDrag: true, nodesDraggable: true, cursor: "default" });
  });

  it("pans with a left-drag on the pan tool, and leaves the modules where they are", () => {
    const pan = interactionReducer(initialInteraction, { type: "tool", tool: "pan" });
    expect(pan.tool).toBe("pan");
    expect(interactionProps(pan)).toEqual({ panOnDrag: true, selectionOnDrag: false, nodesDraggable: false, cursor: "grab" });
  });

  it("toggles between the two, and keeps its state object when nothing changes", () => {
    const pan = interactionReducer(initialInteraction, { type: "toggle" });
    expect(pan.tool).toBe("pan");
    expect(interactionReducer(pan, { type: "toggle" }).tool).toBe("select");
    expect(interactionReducer(pan, { type: "tool", tool: "pan" })).toBe(pan);
    expect(interactionReducer(pan, { type: "space", down: false })).toBe(pan);
    expect(interactionReducer(pan, { type: "blur" })).toBe(pan);
  });

  it("pans with a left-drag while Space is held on the select tool, and selects again when it is released", () => {
    const held = interactionReducer(initialInteraction, { type: "space", down: true });
    // modules are not dragged while Space is held: a left-drag that starts on one pans (PB-1037)
    expect(interactionProps(held)).toEqual({ panOnDrag: [0, 1], selectionOnDrag: false, nodesDraggable: false, cursor: "grab" });
    const released = interactionProps(interactionReducer(held, { type: "space", down: false }));
    expect(released.selectionOnDrag).toBe(true);
    expect(released.nodesDraggable).toBe(true);
    // a key released while the window was away
    expect(interactionReducer(held, { type: "blur" })).toEqual(initialInteraction);
    // on the pan tool Space changes nothing
    const pan: InteractionState = { tool: "pan", space: true };
    expect(interactionProps(pan)).toEqual(interactionProps({ tool: "pan", space: false }));
  });

  it("offers both tools as icon buttons with a label and a key", () => {
    expect(TOOL_OPTIONS.map((o) => [o.id, o.shortcut])).toEqual([["select", "V"], ["pan", "H"]]);
    for (const o of TOOL_OPTIONS) expect(o.icon && o.label).toBeTruthy();
  });
});

describe("the canvas's keys", () => {
  it("switches tools, fits and zooms with plain keys", () => {
    expect(canvasCommand({ key: "v" })).toEqual({ type: "tool", tool: "select" });
    expect(canvasCommand({ key: "H" })).toEqual({ type: "tool", tool: "pan" });
    expect(canvasCommand({ key: "f" })).toEqual({ type: "fit" });
    expect(canvasCommand({ key: "+" })).toEqual({ type: "zoom", by: "in" });
    expect(canvasCommand({ key: "=" })).toEqual({ type: "zoom", by: "in" });
    expect(canvasCommand({ key: "-" })).toEqual({ type: "zoom", by: "out" });
    expect(canvasCommand({ key: "0" })).toEqual({ type: "zoom", by: "reset" });
    expect(canvasCommand({ key: "Escape" })).toEqual({ type: "escape" });
  });

  it("selects all with Ctrl or Cmd+A, and leaves every other Ctrl, Cmd and Alt key to the host", () => {
    expect(canvasCommand({ key: "a", ctrlKey: true })).toEqual({ type: "selectAll" });
    expect(canvasCommand({ key: "A", metaKey: true })).toEqual({ type: "selectAll" });
    expect(canvasCommand({ key: "a" })).toBeUndefined();
    for (const key of ["s", "z", "=", "-", "0", "f", "v", "ArrowLeft"]) expect(canvasCommand({ key, ctrlKey: true }), key).toBeUndefined();
    expect(canvasCommand({ key: "f", altKey: true })).toBeUndefined();
    expect(canvasCommand({ key: "Delete" })).toBeUndefined();
  });

  it("nudges by a grid step, four with Shift", () => {
    expect(canvasCommand({ key: "ArrowRight" })).toEqual({ type: "nudge", dx: 16, dy: 0 });
    expect(canvasCommand({ key: "ArrowUp", shiftKey: true })).toEqual({ type: "nudge", dx: 0, dy: -64 });
    expect(canvasCommand({ key: "ArrowDown" }, 20)).toEqual({ type: "nudge", dx: 0, dy: 20 });
  });

  it("leaves keys typed into a field alone", () => {
    const inside = (selector: string) => ({ closest: (s: string) => (s.includes(selector) ? {} : null) });
    expect(typingTarget(inside("input"))).toBe(true);
    expect(typingTarget(inside("[role='menu']"))).toBe(true);
    expect(typingTarget({ closest: () => null })).toBe(false);
    expect(typingTarget(null)).toBe(false);
  });
});

describe("selecting several", () => {
  it("applies React Flow's selection changes to what was selected", () => {
    // Shift+click adds, a second one takes away
    expect(applySelectChanges(["a"], [{ id: "b", selected: true }])).toEqual(["a", "b"]);
    expect(applySelectChanges(["a", "b"], [{ id: "a", selected: false }])).toEqual(["b"]);
    // a plain press on another module: the others are unselected with it
    expect(applySelectChanges(["a", "b"], [{ id: "c", selected: true }, { id: "a", selected: false }, { id: "b", selected: false }])).toEqual(["c"]);
    // a click on the empty canvas
    expect(applySelectChanges(["a"], [{ id: "a", selected: false }])).toEqual([]);
  });

  it("names a supply rail's taps as the rail, once", () => {
    const canonical = (id: string) => (id.startsWith("tap:") ? "rail" : id);
    expect(applySelectChanges([], [{ id: "tap:1", selected: true }, { id: "tap:2", selected: true }, { id: "u1", selected: true }], canonical)).toEqual(["rail", "u1"]);
  });
});

describe("double-click on a node (leaf and container parts)", () => {
  const part = { defId: "usb-c", childCount: 0 };
  const board = { defId: "main-board", childCount: 5 };

  it("opens nothing for a part with nothing inside, with or without a host that opens modules", () => {
    expect(openAction(part, true)).toBe("none");
    expect(openAction(part, false)).toBe("none");
    expect(openAction(undefined, true)).toBe("none");
  });

  it("opens a module that holds modules in the host's new tab, and expands it in place without one", () => {
    expect(openAction(board, true)).toBe("open");
    expect(openAction(board, false)).toBe("expand");
  });

  it("never opens a net's junction, a rail's tap or a boundary port as a tab", () => {
    expect(openAction({ defId: "x", childCount: 2, net: {} }, true)).toBe("expand");
    expect(openAction({ defId: "x", childCount: 2, tapOf: "rail" }, true)).toBe("expand");
    expect(openAction({ childCount: 0, sheetPort: {} }, true)).toBe("none");
  });
});

describe("the view a level opens on", () => {
  const base = { restored: false, moved: false, nodesKey: "a|b", fittedKey: null, sized: true };

  it("fits the diagram when no viewport is saved", () => {
    expect(firstView(base)).toEqual({ kind: "fit" });
  });

  it("puts a saved viewport back, once, and never fits over it", () => {
    const saved = { x: 12, y: -40, zoom: 0.8 };
    expect(firstView({ ...base, saved })).toEqual({ kind: "restore", viewport: saved });
    expect(firstView({ ...base, saved, restored: true })).toEqual({ kind: "keep" });
    expect(firstView({ ...base, saved, restored: true, nodesKey: "a|b|c" })).toEqual({ kind: "keep" });
  });

  it("waits until the canvas has a size (a tab opened in the background)", () => {
    expect(firstView({ ...base, sized: false })).toEqual({ kind: "keep" });
    expect(firstView({ ...base, sized: false, saved: { x: 0, y: 0, zoom: 1 } })).toEqual({ kind: "keep" });
  });

  it("fits again when modules come or go, until the user moves the view", () => {
    expect(firstView({ ...base, fittedKey: "a|b" })).toEqual({ kind: "keep" });
    // an empty project gets its first modules; then one more
    expect(firstView({ ...base, nodesKey: "", fittedKey: null })).toEqual({ kind: "keep" });
    expect(firstView({ ...base, nodesKey: "a|b|c", fittedKey: "a|b" })).toEqual({ kind: "fit" });
    expect(firstView({ ...base, nodesKey: "a|b|c", fittedKey: "a|b", moved: true })).toEqual({ kind: "keep" });
  });

  it("takes only a well-formed viewport from storage", () => {
    expect(validViewport({ x: 0, y: 0, zoom: 1 })).toBe(true);
    expect(validViewport({ x: 0, y: 0, zoom: 0 })).toBe(false);
    expect(validViewport({ x: "0", y: 0, zoom: 1 })).toBe(false);
    expect(validViewport({ x: 0, y: Number.NaN, zoom: 1 })).toBe(false);
    expect(validViewport(null)).toBe(false);
  });
});

describe("INSPECT goes to a host that has an inspector", () => {
  it("is a viewer event, delivered to onInspect", () => {
    expect(isViewerEvent({ type: "uhd-viewer:inspect", path: "main/usb" })).toBe(true);
    const got: unknown[] = [];
    deliver({ onInspect: (r) => got.push(r) }, { type: "uhd-viewer:inspect", path: "main/usb", defId: "usb-c" });
    deliver({ onInspect: (r) => got.push(r) }, { type: "uhd-viewer:inspect", path: "main" });
    expect(got).toEqual([{ path: "main/usb", defId: "usb-c" }, { path: "main" }]);
  });
});
