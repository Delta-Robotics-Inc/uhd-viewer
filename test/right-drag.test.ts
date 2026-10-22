/** The right button on the diagram (canvas/rightDrag.ts): a drag pans, a click opens the menu, a drag never does. */
import { describe, expect, it } from "vitest";
import { CLICK_SLOP, RIGHT, initialInteraction, interactionProps, interactionReducer, rightMove, rightPress, rightRelease } from "../src/canvas/interaction";
import { createRightDrag } from "../src/canvas/rightDrag";
import type { Viewport } from "../src/canvas/interaction";

describe("click or drag", () => {
  it("is a click while the pointer stays within the slop, and a pan once it goes further", () => {
    const p = rightPress(100, 100);
    expect(rightRelease(p)).toBe("menu");
    expect(rightRelease(rightMove(p, 100 + CLICK_SLOP, 100))).toBe("menu");
    expect(rightRelease(rightMove(p, 103, 102))).toBe("menu"); // 3.6 px
    expect(rightRelease(rightMove(p, 100 + CLICK_SLOP + 1, 100))).toBe("pan");
    expect(rightRelease(rightMove(p, 104, 104))).toBe("pan"); // 5.7 px
  });

  it("stays a pan when the pointer comes back to where it went down", () => {
    const panned = rightMove(rightPress(0, 0), 40, 0);
    expect(rightRelease(rightMove(panned, 1, 0))).toBe("pan");
  });

  it("leaves the right button out of React Flow's own panning (which would swallow the canvas's menu) with either tool", () => {
    const states = [initialInteraction, interactionReducer(initialInteraction, { type: "space", down: true }), interactionReducer(initialInteraction, { type: "tool", tool: "pan" })];
    for (const s of states) {
      const { panOnDrag } = interactionProps(s);
      if (Array.isArray(panOnDrag)) expect(panOnDrag).not.toContain(RIGHT);
    }
  });
});

type Target = "pane" | "node" | "link" | "bare";

function setup(opts: { menus?: Target[] } = {}) {
  let view: Viewport = { x: 10, y: 20, zoom: 1.5 };
  let clock = 0;
  const log: string[] = [];
  const menus = new Set<Target>(opts.menus ?? ["pane", "node", "link"]);
  const g = createRightDrag<Target>({
    viewport: () => view,
    setViewport: (v) => {
      view = v;
    },
    panStart: () => log.push("panStart"),
    panEnd: (v) => log.push(`panEnd ${v.x},${v.y}`),
    hasMenu: (t) => menus.has(t),
    openMenu: (t, x, y) => log.push(`menu ${t} ${x},${y}`),
    now: () => clock,
  });
  return { g, log, view: () => view, tick: (ms: number) => (clock += ms) };
}

const R = (x: number, y: number, target: Target = "pane") => ({ button: RIGHT, buttons: 2, x, y, target });

describe("the right button on the canvas", () => {
  it("pans the view by the drag, keeping the zoom, and opens no menu when let go (Linux, macOS: the browser's menu comes on press)", () => {
    const { g, log, view } = setup();
    expect(g.down(R(100, 100))).toBe(true);
    expect(g.contextMenu(R(100, 100))).toBe(true); // cancelled now; decided on release
    expect(g.move({ x: 102, y: 101, buttons: 2 })).toBe(false); // within the slop: still a click
    expect(view()).toEqual({ x: 10, y: 20, zoom: 1.5 });
    expect(g.move({ x: 160, y: 130, buttons: 2 })).toBe(true);
    expect(view()).toEqual({ x: 70, y: 50, zoom: 1.5 });
    expect(g.up(R(160, 130))).toBe("pan");
    expect(log).toEqual(["panStart", "panEnd 70,50"]);
  });

  it("opens no menu after a drag on Windows either (the browser's menu comes after release)", () => {
    const { g, log, tick } = setup();
    g.down(R(10, 10, "node"));
    g.move({ x: 60, y: 10, buttons: 2 });
    expect(g.up(R(60, 10, "node"))).toBe("pan");
    tick(5);
    expect(g.contextMenu(R(60, 10, "node"))).toBe(true);
    expect(log.some((l) => l.startsWith("menu"))).toBe(false);
  });

  it("opens the canvas's menu on release for a click, where it was let go, once", () => {
    const { g, log, tick } = setup();
    g.down(R(50, 50, "node"));
    expect(g.contextMenu(R(50, 50, "node"))).toBe(true);
    g.move({ x: 52, y: 52, buttons: 2 });
    expect(g.up(R(52, 52, "node"))).toBe("menu");
    tick(3);
    expect(g.contextMenu(R(52, 52, "node"))).toBe(true); // Windows' late one: cancelled, not a second menu
    expect(log).toEqual(["menu node 52,52"]);
  });

  it("over a link and over the empty canvas too", () => {
    for (const t of ["link", "pane"] as const) {
      const { g, log, view } = setup();
      g.down(R(0, 0, t));
      g.move({ x: -30, y: 40, buttons: 2 });
      g.up(R(-30, 40, t));
      expect(view()).toEqual({ x: -20, y: 60, zoom: 1.5 });
      expect(log).toEqual(["panStart", "panEnd -20,60"]);
    }
  });

  it("leaves the browser's (or the webview host's) menu alone where the canvas has none, on a click", () => {
    const { g, log, tick } = setup({ menus: ["pane"] });
    g.down(R(5, 5, "bare"));
    expect(g.contextMenu(R(5, 5, "bare"))).toBe(false);
    // Windows: after release
    g.up(R(5, 5, "bare"));
    tick(2);
    expect(g.contextMenu(R(5, 5, "bare"))).toBe(false);
    expect(log).toEqual([]);
  });

  it("opens the menu at once for a context menu with no right press (the menu key, Shift+F10, Ctrl+click on a Mac)", () => {
    const { g, log, tick } = setup();
    tick(10_000);
    expect(g.contextMenu({ x: 30, y: 40, target: "node" })).toBe(true);
    expect(log).toEqual(["menu node 30,40"]);
  });

  it("ignores the other buttons", () => {
    const { g, log } = setup();
    expect(g.down({ button: 0, x: 0, y: 0, target: "pane" })).toBe(false);
    expect(g.move({ x: 90, y: 90, buttons: 1 })).toBe(false);
    expect(g.up({ button: 0, x: 90, y: 90, target: "pane" })).toBeUndefined();
    expect(g.down({ button: 1, x: 0, y: 0, target: "pane" })).toBe(false);
    expect(log).toEqual([]);
  });

  it("ends a pan whose release it did not hear (let go outside the window), with no menu", () => {
    const { g, log } = setup();
    g.down(R(0, 0));
    g.move({ x: 20, y: 0, buttons: 2 });
    expect(g.move({ x: 25, y: 0, buttons: 0 })).toBe(false);
    expect(g.panning).toBe(false);
    expect(log).toEqual(["panStart", "panEnd 30,20"]);
  });
});
