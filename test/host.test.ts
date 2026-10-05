/**
 * The host message protocol (README, "Host messages"): checking messages,
 * origins, the parent-window channel, and what focus, select and drill name
 * on the IMU pod fixture (a board with components and nets, an enclosure).
 */
import { describe, expect, it } from "vitest";
import type { ModuleDef } from "@uhd/types/index.js";
import type { ViewerEvent } from "../src/api";
import { buildView } from "../src/model/from-uhd";
import { systemDiagnostics } from "../src/model/diagnostics";
import { commandBus, connectParent, deliver, type ChannelWindow } from "../src/host/channel";
import { isViewerEvent, originAllowed, originList, parseHostMessage } from "../src/host/protocol";
import { cadHostSelection, cadSelectTarget, drillTarget, focusTarget, hostSelection, selectTarget, selectionKey } from "../src/host/targets";
import { revealViewport, selectionBounds } from "../src/canvas/reveal";
import bundle from "../fixtures/imu-pod/uhd-bundle.json";

const defs = new Map((bundle.definitions as unknown as ModuleDef[]).map((d) => [d.id, d]));
const lookup = (id: string) => defs.get(id);
const root = defs.get(bundle.root)!;
const view = (drill: string[], expanded: string[] = []) =>
  buildView(root, lookup, drill, { expanded: new Set(expanded), diagnostics: systemDiagnostics(root, lookup) });

describe("host messages", () => {
  it("accepts the four host messages and normalises paths", () => {
    expect(parseHostMessage({ type: "uhd-viewer:focus", path: "board/u2" })).toEqual({ type: "uhd-viewer:focus", path: "board/u2" });
    expect(parseHostMessage({ type: "uhd-viewer:focus", path: ["board", "u2"] })).toEqual({ type: "uhd-viewer:focus", path: "board/u2" });
    expect(parseHostMessage({ type: "uhd-viewer:drill", path: "/board/" })).toEqual({ type: "uhd-viewer:drill", path: "board" });
    expect(parseHostMessage({ type: "uhd-viewer:select", ids: ["u2", "link:board_mount"] })).toEqual({ type: "uhd-viewer:select", ids: ["u2", "link:board_mount"] });
    expect(parseHostMessage({ type: "uhd-viewer:setView", view: "3d" })).toEqual({ type: "uhd-viewer:setView", view: "3d" });
    // a select reveals what it selects unless the host says not to
    expect(parseHostMessage({ type: "uhd-viewer:select", ids: ["u2"], reveal: false })).toEqual({ type: "uhd-viewer:select", ids: ["u2"], reveal: false });
    expect(parseHostMessage({ type: "uhd-viewer:select", ids: ["u2"], reveal: true })).toEqual({ type: "uhd-viewer:select", ids: ["u2"] });
    expect(parseHostMessage({ type: "uhd-viewer:select", ids: ["u2"], reveal: "no" })).toBeUndefined();
  });

  it("refuses anything else", () => {
    for (const m of [
      null,
      "uhd-viewer:focus",
      { type: "uhd-viewer:focus" },
      { type: "uhd-viewer:focus", path: 3 },
      { type: "uhd-viewer:select", ids: [1] },
      { type: "uhd-viewer:setView", view: "pcb" },
      { type: "uhd-viewer:ready" },
      { type: "other", path: "x" },
    ]) {
      expect(parseHostMessage(m), JSON.stringify(m)).toBeUndefined();
    }
  });

  it("tells viewer events from other messages", () => {
    expect(isViewerEvent({ type: "uhd-viewer:openSource", defId: "x" })).toBe(true);
    expect(isViewerEvent({ type: "uhd-viewer:focus", path: "x" })).toBe(false);
  });
});

describe("origins", () => {
  it("matches exact origins, scheme wildcards and any", () => {
    expect(originAllowed("http://127.0.0.1:5180", ["http://127.0.0.1:5180"])).toBe(true);
    expect(originAllowed("http://127.0.0.1:5180", ["http://127.0.0.1:5180/"])).toBe(true);
    expect(originAllowed("http://127.0.0.1:5181", ["http://127.0.0.1:5180"])).toBe(false);
    expect(originAllowed("vscode-webview://1abc", ["vscode-webview://*"])).toBe(true);
    expect(originAllowed("https://evil.example", ["vscode-webview://*"])).toBe(false);
    expect(originAllowed("https://evil.example", ["*"])).toBe(true);
    expect(originAllowed("null", ["vscode-webview://*", "http://x"])).toBe(false);
    expect(originList(" http://a , ,vscode-webview://* ")).toEqual(["http://a", "vscode-webview://*"]);
  });
});

/** A frame and its parent, as far as the channel sees them. */
function frame(opts: { origin?: string; ancestor?: string; referrer?: string } = {}) {
  const posted: { message: unknown; target: string }[] = [];
  const listeners = new Set<(e: MessageEvent) => void>();
  const parent = { postMessage: (message: unknown, target: string) => posted.push({ message, target }) };
  const win: ChannelWindow = {
    parent,
    location: { origin: opts.origin ?? "http://127.0.0.1:5180", ...(opts.ancestor ? { ancestorOrigins: [opts.ancestor] } : {}) },
    document: { referrer: opts.referrer ?? "" },
    addEventListener: (_t, l) => listeners.add(l),
    removeEventListener: (_t, l) => listeners.delete(l),
  };
  const dispatch = (data: unknown, origin: string, source: unknown = parent) => {
    for (const l of listeners) l({ data, origin, source } as MessageEvent);
  };
  return { win, parent, posted, dispatch, listeners };
}

describe("the parent channel", () => {
  const ready: ViewerEvent = { type: "uhd-viewer:ready" };

  it("is not opened outside a frame", () => {
    const f = frame();
    const self = { ...f.win };
    self.parent = self as unknown as ChannelWindow["parent"];
    expect(connectParent(self, { onMessage: () => {} })).toBeUndefined();
  });

  it("takes messages from the parent only, at an allowed origin", () => {
    const f = frame({ ancestor: "vscode-webview://abc" });
    const got: unknown[] = [];
    const channel = connectParent(f.win, { origins: ["vscode-webview://*"], onMessage: (m) => got.push(m) })!;
    f.dispatch({ type: "uhd-viewer:focus", path: "board/u2" }, "vscode-webview://abc");
    f.dispatch({ type: "uhd-viewer:focus", path: "board/u3" }, "https://evil.example");
    f.dispatch({ type: "uhd-viewer:focus", path: "board/u4" }, "vscode-webview://abc", { postMessage() {} });
    f.dispatch({ type: "not-ours" }, "vscode-webview://abc");
    expect(got).toEqual([{ type: "uhd-viewer:focus", path: "board/u2" }]);
    channel.close();
    f.dispatch({ type: "uhd-viewer:setView", view: "3d" }, "vscode-webview://abc");
    expect(got).toHaveLength(1);
    expect(f.listeners.size).toBe(0);
  });

  it("posts events at the parent's origin when the frame knows it", () => {
    const f = frame({ ancestor: "vscode-webview://abc" });
    connectParent(f.win, { origins: ["vscode-webview://*"], onMessage: () => {} })!.post(ready);
    expect(f.posted).toEqual([{ message: ready, target: "vscode-webview://abc" }]);
  });

  it("defaults to the frame's own origin", () => {
    const f = frame({ referrer: "http://127.0.0.1:5180/host.html" });
    const got: unknown[] = [];
    connectParent(f.win, { onMessage: (m) => got.push(m) })!.post(ready);
    expect(f.posted).toEqual([{ message: ready, target: "http://127.0.0.1:5180" }]);
    f.dispatch({ type: "uhd-viewer:setView", view: "3d" }, "http://localhost:5180");
    expect(got).toEqual([]);
  });

  it("holds events until the parent's origin is known from its first message", () => {
    const f = frame({ referrer: "https://evil.example/" });
    const channel = connectParent(f.win, { origins: ["vscode-webview://*", "http://localhost:3000"], onMessage: () => {} })!;
    channel.post(ready);
    channel.post({ type: "uhd-viewer:selectionChanged", selection: null });
    expect(f.posted).toEqual([]);
    f.dispatch({ type: "uhd-viewer:setView", view: "diagram" }, "http://localhost:3000");
    expect(f.posted.map((p) => [p.message, p.target])).toEqual([
      [ready, "http://localhost:3000"],
      [{ type: "uhd-viewer:selectionChanged", selection: null }, "http://localhost:3000"],
    ]);
  });
});

describe("handle and callbacks", () => {
  it("queues messages until the viewer subscribes, then delivers them in order", () => {
    const bus = commandBus();
    bus.send({ type: "uhd-viewer:setView", view: "3d" });
    bus.send({ type: "uhd-viewer:focus", path: "board/u2" });
    const got: string[] = [];
    const off = bus.subscribe((m) => got.push(m.type));
    bus.send({ type: "uhd-viewer:select", ids: [] });
    off();
    bus.send({ type: "uhd-viewer:drill", path: "" });
    expect(got).toEqual(["uhd-viewer:setView", "uhd-viewer:focus", "uhd-viewer:select"]);
    const later: string[] = [];
    bus.subscribe((m) => later.push(m.type));
    expect(later).toEqual(["uhd-viewer:drill"]);
  });

  it("calls the callback that matches each event", () => {
    const calls: unknown[] = [];
    const options = {
      onReady: () => calls.push("ready"),
      onSelectionChanged: (s: unknown) => calls.push(["selection", s]),
      onOpenSource: (r: unknown) => calls.push(["source", r]),
      onOpenArtifact: (r: unknown) => calls.push(["artifact", r]),
    };
    deliver(options, { type: "uhd-viewer:ready" });
    deliver(options, { type: "uhd-viewer:selectionChanged", selection: { kind: "node", id: "board/u2", defId: "fixture-imu-lga12" } });
    deliver(options, { type: "uhd-viewer:openSource", defId: "fixture-imu-lga12", instancePath: "board/u2" });
    deliver(options, { type: "uhd-viewer:openArtifact", defId: "sample-imu-board", artifactId: "bom" });
    deliver({}, { type: "uhd-viewer:ready" });
    expect(calls).toEqual([
      "ready",
      ["selection", { kind: "node", id: "board/u2", defId: "fixture-imu-lga12" }],
      ["source", { defId: "fixture-imu-lga12", instancePath: "board/u2" }],
      ["artifact", { defId: "sample-imu-board", artifactId: "bom" }],
    ]);
  });
});

describe("focus, select and drill on the model", () => {
  const top = { drill: [] as string[], expanded: new Set<string>() };

  it("focus opens the level that holds the module and selects it there", () => {
    expect(focusTarget(root, lookup, "board/u2", top)).toEqual({ drill: ["board"], selection: { kind: "node", id: "u2" } });
    expect(focusTarget(root, lookup, "enclosure", top)).toEqual({ drill: [], selection: { kind: "node", id: "enclosure" } });
    // already drawn on the level being viewed: inside a module expanded in place, or a child of it
    expect(focusTarget(root, lookup, "board/u2", { drill: [], expanded: new Set(["board"]) })).toEqual({ drill: [], selection: { kind: "node", id: "board/u2" } });
    expect(focusTarget(root, lookup, "board/u3", { drill: ["board"], expanded: new Set() })).toEqual({ drill: ["board"], selection: { kind: "node", id: "u3" } });
    // from inside the board, a module elsewhere opens its own level
    expect(focusTarget(root, lookup, "enclosure", { drill: ["board"], expanded: new Set() })).toEqual({ drill: [], selection: { kind: "node", id: "enclosure" } });
  });

  it("focus follows a path as far as it names instances; the root selects nothing", () => {
    expect(focusTarget(root, lookup, "board/nothing/here", top)).toEqual({ drill: [], selection: { kind: "node", id: "board" } });
    expect(focusTarget(root, lookup, "", top)).toEqual({ drill: [], selection: null });
    expect(focusTarget(root, lookup, "nothing", top)).toEqual({ drill: [], selection: null });
  });

  it("drill stops at modules with children", () => {
    expect(drillTarget(root, lookup, "board")).toEqual(["board"]);
    expect(drillTarget(root, lookup, "board/u2")).toEqual(["board"]);
    expect(drillTarget(root, lookup, "enclosure")).toEqual([]);
    expect(drillTarget(root, lookup, "")).toEqual([]);
  });

  it("select takes the first id drawn on the level, canonical or relative", () => {
    const board = view(["board"]);
    expect(selectTarget(board, ["board"], ["board/u2"])).toEqual({ kind: "node", id: "u2" });
    expect(selectTarget(board, ["board"], ["u9", "u3"])).toEqual({ kind: "node", id: "u3" });
    expect(selectTarget(board, ["board"], ["board:v3v3"])).toEqual({ kind: "node", id: ":v3v3" });
    expect(selectTarget(board, ["board"], ["enclosure"])).toBeUndefined();
    expect(selectTarget(board, ["board"], [])).toBeNull();
    const pod = view([]);
    expect(selectTarget(pod, [], ["link:board_mount"])).toEqual({ kind: "link", id: "board_mount" });
    expect(selectTarget(pod, [], ["node:board_mount"])).toBeUndefined();
  });

  it("reports selections as canonical paths with their definitions, round-tripping through select", () => {
    const board = view(["board"]);
    const u2 = hostSelection(board, ["board"], { kind: "node", id: "u2" }, "sample-imu-board");
    expect(u2).toEqual({ kind: "node", id: "board/u2", defId: "fixture-imu-lga12" });
    expect(hostSelection(board, ["board"], { kind: "node", id: ":v3v3" }, "sample-imu-board")).toEqual({ kind: "node", id: "board:v3v3" });
    expect(selectTarget(board, ["board"], [u2!.id])).toEqual({ kind: "node", id: "u2" });
    const pod = view([]);
    expect(hostSelection(pod, [], { kind: "link", id: "board_mount" }, root.id)).toEqual({ kind: "link", id: "board_mount", defId: root.id });
    expect(hostSelection(pod, [], null)).toBeNull();
    // a link inside a module expanded in place belongs to that module's definition
    const expanded = view([], ["board"]);
    const inner = expanded.links.find((l) => l.linkId.startsWith("board/") && !l.passThrough);
    if (inner) expect(hostSelection(expanded, [], { kind: "link", id: inner.linkId }, root.id)).toMatchObject({ kind: "link", id: inner.linkId, defId: "sample-imu-board" });
    expect(selectionKey(u2)).not.toBe(selectionKey(null));
  });

  it("reports 3D selections by instance path", () => {
    const defAt = (path: string[]) => (path.join("/") === "board/u2" ? lookup("fixture-imu-lga12") : path.length === 0 ? root : lookup("sample-imu-board"));
    expect(cadHostSelection({ body: "board#board_glb", component: "board/u2" }, defAt)).toEqual({ kind: "node", id: "board/u2", defId: "fixture-imu-lga12" });
    expect(cadHostSelection({ body: "board#board_glb" }, defAt)).toEqual({ kind: "node", id: "board", defId: "sample-imu-board" });
    // a mate carries its owner's definition, as the same link does in the diagram
    const mate = cadHostSelection({ mate: "board_mount" }, defAt);
    expect(mate).toEqual({ kind: "link", id: "board_mount", defId: root.id });
    expect(mate).toEqual(hostSelection(view([]), [], { kind: "link", id: "board_mount" }, root.id));
    expect(cadHostSelection({ mate: "board/inner" }, defAt)).toEqual({ kind: "link", id: "board/inner", defId: "sample-imu-board" });
    expect(cadHostSelection({}, defAt)).toBeNull();
  });

  it("select in the 3D view: the level's pick by full path, else a full instance path", () => {
    const board = ["board"];
    expect(cadSelectTarget(root, lookup, board, { kind: "node", id: "u2" }, ["u2"])).toEqual({ kind: "node", path: "board/u2" });
    expect(cadSelectTarget(root, lookup, [], { kind: "link", id: "board_mount" }, ["board_mount"])).toEqual({ kind: "link", path: "board_mount" });
    // nets are not drawn in 3D
    expect(cadSelectTarget(root, lookup, board, { kind: "node", id: ":v3v3" }, ["board:v3v3"])).toBeUndefined();
    expect(cadSelectTarget(root, lookup, board, null, [])).toEqual({ kind: "none", path: "" });
    // not on the diagram's level: the first full instance path
    expect(cadSelectTarget(root, lookup, board, undefined, ["link:enclosure", "nothing", "node:enclosure"])).toEqual({ kind: "node", path: "enclosure" });
    expect(cadSelectTarget(root, lookup, board, undefined, ["board/nothing"])).toBeUndefined();
  });
});

describe("select brings the selection into view", () => {
  const pane = { width: 1000, height: 700 };
  const rect = { x0: 100, y0: 100, x1: 200, y1: 150 };
  it("leaves the view alone when the selection is clear of the chrome", () => {
    expect(revealViewport(rect, { x: 0, y: 0, zoom: 1 }, pane, false)).toBeUndefined();
  });
  it("pans, at the same zoom, to a selection off screen or under the inspector", () => {
    const off = revealViewport(rect, { x: -2000, y: 0, zoom: 1 }, pane, false)!;
    expect(off.zoom).toBe(1);
    // centred in what the chrome leaves: x 64..936, y 56..628
    expect(off.x + 150).toBeCloseTo(500);
    expect(off.y + 125).toBeCloseTo(342);
    // at x 700..800 it is on screen but under the inspector (376 px on the right)
    const under = revealViewport(rect, { x: 600, y: 0, zoom: 1 }, pane, true)!;
    expect(under).toBeDefined();
    expect(under.x + 200).toBeLessThanOrEqual(pane.width - 376);
  });
  it("zooms out only as far as a large selection needs, never in", () => {
    const big = revealViewport({ x0: 0, y0: 0, x1: 4000, y1: 100 }, { x: 0, y: 0, zoom: 1 }, pane, false)!;
    expect(big.zoom).toBeCloseTo((1000 - 128 - 48) / 4000);
    expect(revealViewport(rect, { x: -5000, y: 0, zoom: 0.5 }, pane, false)!.zoom).toBe(0.5);
  });
  it("finds where a module or a link is drawn on the level", () => {
    const v = view(["board"]);
    const layout = { boxes: Object.fromEntries(v.nodes.map((n, i) => [n.id, { x: i * 100, y: 0, w: 50, h: 40 }])), routes: Object.fromEntries(v.links.map((l) => [l.id, [[10, 20], [300, 400]]])) };
    const node = v.nodes[1];
    expect(selectionBounds(v, layout as never, { kind: "node", id: node.id })).toEqual({ x0: 100, y0: 0, x1: 150, y1: 40 });
    expect(v.links.length).toBeGreaterThan(0);
    expect(selectionBounds(v, layout as never, { kind: "link", id: v.links[0].linkId })).toEqual({ x0: 10, y0: 20, x1: 300, y1: 400 });
    expect(selectionBounds(v, layout as never, { kind: "node", id: "nothing" })).toBeUndefined();
  });
});
