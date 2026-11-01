/**
 * The 3D view's state (PB-1178): the schema and its verbs, the store's op log
 * and preconditions, serialization, the URL and host-message round trips,
 * the split between what is saved per user and what is presentation, the
 * bridge's viewer end, and PB-1137's up direction and root rule.
 */
import { describe, expect, it } from "vitest";
import type { ModuleDef } from "@uhd/types/index.js";
import {
  HUMAN,
  LIVE_KEYS,
  PRESENTATION_KEYS,
  VIEW_STATE_SCHEMA,
  VIEWER_STATE_FILE_SCHEMA,
  applyOps,
  createViewStore,
  debounce,
  defaultViewState,
  expandOp,
  fromUrlParams,
  handleBridgeMessage,
  liveState,
  makeHub,
  parseBridgeRequest,
  parseViewState,
  parseViewerStateFile,
  presentation,
  presentationFromDisplay,
  serializeViewState,
  toUrlParams,
  viewerStateFile,
  watchLiveState,
  type Actor,
  type CameraState,
  type Timers,
} from "../src/cad/state";
import { assemblyRoot, matchesPath, placeholderSummary, shownBy, viewUp } from "../src/cad/state/view";
import { isViewerEvent, parseHostMessage } from "../src/host/protocol";
import { deliver } from "../src/host/channel";

const AGENT: Actor = { kind: "agent", id: "agent-a", session: "s1" };
const cam = (x = 100): CameraState => ({ position: [x, -200, 150], target: [0, 0, 20], up: [0, 0, 1], fov: 32 });

/** Timers a test advances by hand. */
function fakeTimers() {
  let now = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  const timers: Timers = {
    setTimeout: (fn, ms) => {
      const id = next++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (h) => void pending.delete(h as number),
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, t] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at <= now) {
        pending.delete(id);
        t.fn();
      }
    }
  };
  return { timers, advance };
}

describe("view state: schema and verbs", () => {
  it("has one versioned schema with the live and presentation split", () => {
    const s = defaultViewState("stack");
    expect(s.schema).toBe(VIEW_STATE_SCHEMA);
    expect(s.scope).toBe("stack");
    expect(s.camera).toBeNull();
    expect([...LIVE_KEYS].sort()).toEqual(["camera", "direction", "explode", "highlight", "isolation", "sections", "selection", "visibility"]);
    expect([...PRESENTATION_KEYS]).toEqual(["namedViews", "annotations"]);
  });

  it("expands verbs to set operations and applies them with their inverse", () => {
    const s = defaultViewState();
    const r = applyOps(s, [
      { op: "select", selection: { body: "battery" } },
      { op: "camera", camera: cam() },
      { op: "explode", t: 1 },
      { op: "set", path: "visibility.labels", value: true },
      { op: "hide", paths: ["arm_fl"] },
    ]);
    if ("error" in r) throw new Error(r.error);
    expect(r.state.selection).toEqual({ body: "battery" });
    expect(r.state.camera?.position).toEqual([100, -200, 150]);
    expect(r.state.explode).toEqual({ t: 1, step: null });
    expect(r.state.visibility.labels).toBe(true);
    expect(r.state.visibility.hidden).toEqual(["arm_fl"]);
    expect(r.changed.sort()).toEqual(["camera", "explode", "selection", "visibility"]);
    // the input is not changed, and the inverse puts it back
    expect(s.selection).toEqual({});
    const back = applyOps(r.state, r.inverse);
    if ("error" in back) throw new Error(back.error);
    expect(JSON.stringify({ ...back.state })).toBe(JSON.stringify({ ...s }));
  });

  it("refuses bad values and read-only keys, and applies nothing of a refused list", () => {
    const s = defaultViewState();
    for (const [op, msg] of [
      [{ op: "set", path: "scope", value: "x" }, /read-only/],
      [{ op: "set", path: "loading", value: {} }, /read-only/],
      [{ op: "camera", camera: { position: [0, 0, 0], target: [0, 0, 0], up: [0, 0, 1] } }, /differ/],
      [{ op: "camera", camera: { position: [1, 2], target: [0, 0, 0], up: [0, 0, 1] } }, /position/],
      [{ op: "explode", t: 2 }, /between 0 and 1/],
      [{ op: "section", sections: [{ axis: 3, at: 0.5 }] }, /axis/],
      [{ op: "set", path: "visibility.bogus", value: true }, /unknown/],
      [{ op: "evaluate", code: "alert(1)" }, /unknown op/],
      [{ op: "applyView", name: "Front" }, /no named view/],
    ] as [unknown, RegExp][]) {
      const r = applyOps(s, [{ op: "select", selection: { body: "a" } }, op]);
      expect("error" in r ? r.error : "applied", JSON.stringify(op)).toMatch(msg);
    }
  });

  it("saves, applies and deletes named views", () => {
    let s = defaultViewState();
    expect("error" in expandOp(s, { op: "saveView", name: "Front" })).toBe(true); // no camera yet
    const r1 = applyOps(s, [{ op: "camera", camera: cam(5) }, { op: "explode", t: 1 }, { op: "saveView", name: "Front" }]);
    if ("error" in r1) throw new Error(r1.error);
    s = r1.state;
    expect(s.namedViews.Front.camera.position[0]).toBe(5);
    const r2 = applyOps(s, [{ op: "camera", camera: cam(9) }, { op: "explode", t: 0 }, { op: "applyView", name: "Front" }]);
    if ("error" in r2) throw new Error(r2.error);
    expect(r2.state.camera?.position[0]).toBe(5);
    expect(r2.state.explode.t).toBe(1);
    const r3 = applyOps(r2.state, [{ op: "deleteView", name: "Front" }]);
    if ("error" in r3) throw new Error(r3.error);
    expect(r3.state.namedViews).toEqual({});
  });
});

describe("view state: the store, its op log and preconditions", () => {
  it("logs every committed write with seq, actor, label, ops and inverse", () => {
    const store = createViewStore();
    const changes: string[] = [];
    store.subscribe((c) => changes.push(c.source));
    const e = store.dispatch([{ op: "select", selection: { body: "battery" } }]);
    expect(e && !("error" in e) && e.seq).toBe(1);
    expect(store.seq).toBe(1);
    expect(store.log()[0]).toMatchObject({ seq: 1, actor: HUMAN, label: "set selection", keys: ["selection"] });
    expect(store.log()[0].inverse).toEqual([{ op: "set", path: ["selection"], value: {} }]);
    // a write that changes nothing commits nothing
    expect(store.dispatch([{ op: "select", selection: { body: "battery" } }])).toBeNull();
    expect(store.seq).toBe(1);
    expect(changes).toEqual(["view"]);
    expect(store.versions()).toEqual({ selection: 1 });
  });

  it("applies a batch, answers a resent batchId from memory, and refuses a stale expectSeq with the missed range", () => {
    const store = createViewStore();
    const r = store.applyBatch({ batchId: "b1", label: "select the battery pack", ops: [{ op: "select", selection: { body: "battery" } }], expectSeq: 0 }, AGENT);
    expect(r.status).toBe("applied");
    expect(r.seq).toBe(1);
    expect(store.log()[0]).toMatchObject({ seq: 1, actor: AGENT, batchId: "b1", label: "select the battery pack", baseSeq: 0 });
    // the same batch again: the first reply, not a second write
    const again = store.applyBatch({ batchId: "b1", label: "select the battery pack", ops: [{ op: "select", selection: { body: "battery" } }], expectSeq: 0 }, AGENT);
    expect(again).toMatchObject({ status: "applied", seq: 1, duplicate: true });
    expect(store.seq).toBe(1);
    // the user moves the camera; an agent that read at seq 1 is refused and told what it missed
    store.dispatch([{ op: "camera", camera: cam() }], { gesture: "camera" });
    const stale = store.applyBatch({ batchId: "b2", label: "frame the flight controller now", ops: [{ op: "camera", camera: cam(7) }], expectSeq: 1 }, AGENT);
    expect(stale).toMatchObject({ status: "refused", reason: "stale-seq", seq: 2, missed: { from: 2, to: 2 } });
    if (stale.status !== "refused") throw new Error();
    expect(stale.missed.entries).toEqual([{ seq: 2, actor: HUMAN, label: "move the camera".replace("move the camera", "set camera"), keys: ["camera"] }]);
    expect(store.get().camera?.position[0]).toBe(100);
  });

  it("refuses stale versions per key and lets unrelated batches through", () => {
    const store = createViewStore();
    store.applyBatch({ batchId: "a1", label: "highlight the four motors", ops: [{ op: "highlight", paths: ["arm_fl/motor"] }] }, AGENT);
    const v = store.versions();
    // the user changes the selection: a batch that only read the highlight still goes through
    store.dispatch([{ op: "select", selection: { body: "battery" } }]);
    const ok = store.applyBatch({ batchId: "a2", label: "highlight the front motors only", ops: [{ op: "highlight", paths: ["arm_fl/motor", "arm_fr/motor"] }], expectVersions: { highlight: v.highlight } }, AGENT);
    expect(ok.status).toBe("applied");
    // one that read the selection before the user's change is refused, naming who changed it
    const stale = store.applyBatch({ batchId: "a3", label: "clear the selection for capture", ops: [{ op: "select", selection: {} }], expectVersions: { selection: 0 } }, AGENT);
    expect(stale).toMatchObject({ status: "refused", reason: "stale-versions" });
    if (stale.status !== "refused") throw new Error();
    expect(stale.conflicts).toEqual([{ key: "selection", expected: 0, current: 1, value: { body: "battery" }, by: HUMAN, seq: 2 }]);
    expect(store.get().selection).toEqual({ body: "battery" });
  });

  it("refuses an invalid batch whole (label, ids, ops) and remembers the refusal", () => {
    const store = createViewStore();
    expect(store.applyBatch({ batchId: "", label: "a b c", ops: [] }, AGENT).status).toBe("invalid");
    expect(store.applyBatch({ batchId: "x1", label: "too short", ops: [] }, AGENT)).toMatchObject({ status: "invalid", error: /3 to 8 words/ });
    const bad = store.applyBatch({ batchId: "x2", label: "select then set a bad camera", ops: [{ op: "select", selection: { body: "a" } }, { op: "camera", camera: { position: [0, 0, 0], target: [0, 0, 0], up: [0, 0, 1] } }] }, AGENT);
    expect(bad).toMatchObject({ status: "invalid", index: 1 });
    expect(store.get().selection).toEqual({});
    expect(store.seq).toBe(0);
    // a read: the state and seq, nothing logged
    const read = store.applyBatch({ batchId: "r1", label: "read the current view state", ops: [] }, AGENT);
    expect(read).toMatchObject({ status: "read", seq: 0 });
    expect(read.status === "read" && read.state?.schema).toBe(VIEW_STATE_SCHEMA);
  });

  it("coalesces a repeated gesture into one entry with a new seq", () => {
    let t = 0;
    const store = createViewStore({}, { now: () => t });
    for (let i = 0; i < 5; i++) {
      t += 200;
      store.dispatch([{ op: "camera", camera: cam(100 + i) }], { gesture: "camera", label: "move the camera" });
    }
    expect(store.seq).toBe(5);
    expect(store.log()).toHaveLength(1);
    expect(store.log()[0].seq).toBe(5);
    // the inverse is the first move's: undoing the drag goes back to before it
    expect(store.log()[0].inverse).toEqual([{ op: "set", path: ["camera"], value: null }]);
    expect(store.versions().camera).toBe(5);
  });

  it("keeps each scope's camera and selection, and restores saved ones without overriding this session's writes", () => {
    const store = createViewStore();
    store.dispatch([{ op: "select", selection: { body: "battery" } }, { op: "camera", camera: cam(1) }]);
    store.restore({ "": { selection: { body: "frame" }, camera: cam(2), visibility: { ...defaultViewState().visibility, labels: true } }, stack: { camera: cam(3), selection: { body: "stack/fc" } } });
    // this session's writes win; what it did not write comes back
    expect(store.get().selection).toEqual({ body: "battery" });
    expect(store.get().camera?.position[0]).toBe(1);
    expect(store.get().visibility.labels).toBe(true);
    store.enterScope("stack");
    expect(store.get().scope).toBe("stack");
    expect(store.get().camera?.position[0]).toBe(3);
    expect(store.get().selection).toEqual({ body: "stack/fc" });
    store.enterScope("");
    expect(store.get().selection).toEqual({ body: "battery" });
    const by = store.liveByScope();
    expect(Object.keys(by).sort()).toEqual(["", "stack"]);
    expect(by.stack.camera?.position[0]).toBe(3);
  });

  it("reports facts without a seq", () => {
    const store = createViewStore();
    store.setFacts({ loading: { phase: "ready", total: 3, done: 3, failed: 0 }, quality: { mode: "interacting" } });
    expect(store.seq).toBe(0);
    expect(store.get().quality.mode).toBe("interacting");
  });
});

describe("view state: serialization and the persistence split", () => {
  it("round-trips through JSON and drops what does not check", () => {
    const store = createViewStore();
    store.dispatch([{ op: "camera", camera: cam() }, { op: "section", sections: [{ axis: 2, at: 0.4, flip: true }] }, { op: "saveView", name: "Iso" }]);
    const json = JSON.parse(JSON.stringify(serializeViewState(store.get())));
    expect(json.version).toBe(1);
    const back = parseViewState(json);
    if ("error" in back) throw new Error(back.error);
    expect(back.dropped).toEqual([]);
    expect(back.values.camera).toEqual(cam());
    expect(back.values.namedViews?.Iso.sections).toEqual([{ axis: 2, at: 0.4, flip: true }]);
    expect(parseViewState({ ...json, explode: { t: 9 } })).toMatchObject({ dropped: ["explode"] });
    expect(parseViewState({ schema: "other/v9" })).toMatchObject({ error: /unknown view-state schema/ });
  });

  it("puts live keys in viewer-state.json and named views only in the presentation", () => {
    const store = createViewStore();
    store.dispatch([{ op: "camera", camera: cam() }, { op: "select", selection: { body: "battery" } }, { op: "saveView", name: "Iso" }]);
    const live = liveState(store.get());
    expect(Object.keys(live).sort()).toEqual([...LIVE_KEYS].sort());
    expect("namedViews" in live).toBe(false);
    const pres = presentation(store.get());
    expect(Object.keys(pres)).toEqual(["namedViews", "annotations"]);
    expect(pres.namedViews.Iso).toBeDefined();
    const file = viewerStateFile(store.liveByScope(), "");
    expect(file.schema).toBe(VIEWER_STATE_FILE_SCHEMA);
    expect(JSON.stringify(file)).not.toContain("namedViews");
    expect(parseViewerStateFile(JSON.parse(JSON.stringify(file)))?.scopes[""].camera).toEqual(cam());
    expect(parseViewerStateFile({ schema: "x" })).toBeUndefined();
    // the display file's views come back as presentation, the bad ones left out
    expect(presentationFromDisplay({ spatial: { views: { Iso: pres.namedViews.Iso, Bad: { camera: null } } } }).namedViews).toEqual({ Iso: pres.namedViews.Iso });
  });

  it("hands the host the live state 400 ms after the last change, once, and never for facts", () => {
    const { timers, advance } = fakeTimers();
    const store = createViewStore();
    const saved: unknown[] = [];
    const w = watchLiveState(store, (f) => saved.push(f), { timers });
    store.dispatch([{ op: "camera", camera: cam(1) }]);
    advance(200);
    store.dispatch([{ op: "camera", camera: cam(2) }]);
    advance(399);
    expect(saved).toHaveLength(0);
    advance(1);
    expect(saved).toHaveLength(1);
    store.setFacts({ loading: { phase: "ready", total: 1, done: 1, failed: 0 } });
    advance(1000);
    expect(saved).toHaveLength(1);
    // a named view is presentation, not live state: no save
    store.dispatch([{ op: "saveView", name: "A" }]);
    advance(1000);
    expect(saved).toHaveLength(1);
    store.dispatch([{ op: "explode", t: 1 }]);
    w.flush();
    expect(saved).toHaveLength(2);
    w.stop();
  });

  it("debounces", () => {
    const { timers, advance } = fakeTimers();
    let n = 0;
    const d = debounce(() => n++, 100, timers);
    d.call();
    d.call();
    advance(100);
    expect(n).toBe(1);
    d.call();
    d.flush();
    expect(n).toBe(2);
    expect(d.pending).toBe(false);
  });
});

describe("view state: URL and host messages", () => {
  it("reads the URL the 3D view always read, and writes it back", () => {
    const p = new URLSearchParams("explode=1&dir=artifact&labels=1&labelkinds=module,interface&frames=1&wires=0&hardware=0&findings=0&xray=1&section=z&at=0.3&flip=1&body=battery&iface=xt60&az=30&el=10&dist=400&focus=1&hide=arm_fl&isolate=stack&highlight=stack/fc");
    const { values, visibility, opening } = fromUrlParams(p);
    expect(values).toMatchObject({ explode: { t: 1, step: null }, direction: "artifact", sections: [{ axis: 2, at: 0.3, flip: true }], selection: { body: "battery", iface: "xt60" }, isolation: ["stack"], highlight: ["stack/fc"] });
    expect(visibility).toEqual({ labels: true, labelKinds: ["module", "interface"], frames: true, wires: false, hardware: false, findings: false, xray: true, hidden: ["arm_fl"] });
    expect(opening).toMatchObject({ az: 30, el: 10, dist: 400, focus: true, present: false });
    // a hub opened on that URL holds it, and the URL it writes reads back the same
    const hub = makeHub(p);
    const again = fromUrlParams(toUrlParams(hub.store.get()));
    expect(again.values).toMatchObject({ explode: { t: 1 }, direction: "artifact", sections: [{ axis: 2, at: 0.3, flip: true }], selection: { body: "battery", iface: "xt60" } });
    expect(again.visibility).toMatchObject({ labels: true, frames: true, wires: false, hardware: false, findings: false, xray: true, hidden: ["arm_fl"] });
    // an exact camera
    hub.store.dispatch([{ op: "camera", camera: cam() }]);
    expect(fromUrlParams(toUrlParams(hub.store.get())).opening.camera).toEqual({ position: [100, -200, 150], target: [0, 0, 20], up: [0, 0, 1] });
  });

  it("accepts the view-state and bridge host messages and tells their events apart", () => {
    expect(parseHostMessage({ type: "uhd-viewer:setViewState", state: { selection: { body: "x" } } })).toEqual({ type: "uhd-viewer:setViewState", state: { selection: { body: "x" } } });
    expect(parseHostMessage({ type: "uhd-viewer:setViewState", state: [] })).toBeUndefined();
    const file = viewerStateFile({ "": { camera: cam() } }, "");
    expect(parseHostMessage({ type: "uhd-viewer:restoreViewState", file })).toEqual({ type: "uhd-viewer:restoreViewState", file });
    const bridge = { type: "uhd-viewer:bridge", id: "d1", batch: { batchId: "b", label: "read the current view state", ops: [] }, actor: { kind: "agent", id: "a" } };
    expect(parseHostMessage(bridge)).toMatchObject({ type: "uhd-viewer:bridge", id: "d1" });
    // a bridge request cannot speak for the person
    expect(parseHostMessage({ ...bridge, actor: { kind: "human", id: "user" } })).toBeUndefined();
    for (const t of ["uhd-viewer:viewState", "uhd-viewer:presentation", "uhd-viewer:bridgeReply"]) expect(isViewerEvent({ type: t })).toBe(true);
    // events reach the host's callbacks
    const got: unknown[] = [];
    deliver({ onViewStateChange: (f) => got.push(f), onPresentationChange: (p) => got.push(p), onOpenModule: (r) => got.push(r) }, { type: "uhd-viewer:viewState", file });
    deliver({ onOpenModule: (r) => got.push(r) }, { type: "uhd-viewer:openModule", path: "stack/fc", view: "3d" });
    expect(got).toEqual([file, { path: "stack/fc", view: "3d" }]);
  });

  it("answers a bridge request from the store, with the view's observation", () => {
    const store = createViewStore();
    store.dispatch([{ op: "select", selection: { body: "battery" } }, { op: "camera", camera: cam() }]);
    const req = parseBridgeRequest({ type: "uhd-viewer:bridge", id: "d1", batch: { batchId: "b1", label: "read the user's selection and camera", ops: [] }, actor: AGENT, observe: true });
    if (!req) throw new Error("request");
    const out = handleBridgeMessage(store, req, { observe: () => ({ nodes: 3 }), view: () => "3d" });
    expect(out).toMatchObject({ type: "uhd-viewer:bridgeReply", id: "d1", reply: { status: "read", seq: 1, observation: { nodes: 3 }, view: "3d" } });
    expect(out.reply.status === "read" && out.reply.state?.selection).toEqual({ body: "battery" });
    expect(out.reply.status === "read" && out.reply.state?.camera).toEqual(cam());
  });
});

describe("PB-1137 and the placeholder count", () => {
  const frame = { origin: [0, 0, 0], normal: [0, 0, 1], xAxis: [1, 0, 0] };
  const def = (id: string, frames: number, extra: Partial<ModuleDef> = {}): ModuleDef => ({ id, name: id, interfaces: Array.from({ length: frames }, (_, i) => ({ id: `m${i}`, protocols: [], geometry: { frame } })) as unknown as ModuleDef["interfaces"], ...extra });
  const parts = new Map<string, ModuleDef>([
    ["plate", def("plate", 2)],
    ["frame", def("frame", 4)],
    ["cable", def("cable", 6, { kind: "harness" })],
  ]);
  const system = def("sys", 0, { children: [{ id: "plate", moduleDefId: "plate" }, { id: "frame", moduleDefId: "frame" }, { id: "wire", moduleDefId: "cable" }] as ModuleDef["children"] });
  const lookup = (id: string) => parts.get(id);

  it("picks the root by one rule: the display's, else the system's own body, else the most frames", () => {
    expect(assemblyRoot(system, lookup)).toEqual({ path: ["frame"], rule: "most-frames" });
    expect(assemblyRoot(system, lookup, "plate")).toEqual({ path: ["plate"], rule: "display" });
    expect(assemblyRoot(system, lookup, "nothing")).toEqual({ path: ["frame"], rule: "most-frames" });
    const boardSystem = { ...system, artifacts: [{ id: "board_glb", role: "body", format: "glb", filePath: "out/board.glb" }] } as ModuleDef;
    expect(assemblyRoot(boardSystem, lookup)).toEqual({ path: [], rule: "own-body" });
    // a tie goes to the first declared (check used to take the first with any frame: the same here)
    parts.set("plate", def("plate", 4));
    expect(assemblyRoot(system, lookup).path).toEqual(["plate"]);
  });

  it("opens a tilted root upright: the display's up, or the spatial.up shorthand, normalised", () => {
    const s = 1 / Math.sqrt(3);
    expect(viewUp({ view: { up: [1, 1, 1] } }, "")).toEqual([s, s, s]);
    expect(viewUp({ up: [1, 1, 1] }, "")).toEqual([s, s, s]);
    expect(viewUp({ view: { up: [0, 0, -2] }, up: [1, 0, 0] }, "")).toEqual([0, 0, -1]);
    // a module on its own is seen in its own coordinates; nonsense is +z
    expect(viewUp({ up: [1, 1, 1] }, "stack")).toEqual([0, 0, 1]);
    expect(viewUp({ up: [0, 0, 0] }, "")).toEqual([0, 0, 1]);
    expect(viewUp({ up: ["x", 1, 1] }, "")).toEqual([0, 0, 1]);
  });

  it("matches paths for highlight, isolation and hiding", () => {
    expect(matchesPath("arm_fl/motor", "arm_fl")).toBe(true);
    expect(matchesPath("arm_flx", "arm_fl")).toBe(false);
    expect(matchesPath("board#case", "board")).toBe(true);
    expect(shownBy("stack/fc", ["stack/fc/u3"], [])).toBe(true); // the body that holds the component
    expect(shownBy("battery", ["stack"], [])).toBe(false);
    expect(shownBy("stack/fc", null, ["stack"])).toBe(false);
  });

  it("counts placeholders by W1-B's rule", () => {
    const nodes = [
      { instancePath: "frame", kind: "body", placeholder: false },
      { instancePath: "filter_1", kind: "body", placeholder: true },
      { instancePath: "board/u3", kind: "component", placeholder: false },
      { instancePath: "wire", kind: "harness", placeholder: false },
    ];
    const diags = [
      { code: "PB_MODEL_MISSING", entity: { kind: "instance", id: "strap" } },
      { code: "PB_MODEL_PLACEHOLDER", entity: { kind: "instance", id: "filter_1" } },
      { code: "UHD_UNPLACED", entity: { kind: "instance", id: "x" } },
    ];
    expect(placeholderSummary(nodes, diags)).toEqual({ count: 2, of: 4, paths: ["filter_1", "strap"], line: "2 of 4 components are placeholders" });
    expect(placeholderSummary(nodes.slice(0, 1), []).line).toBe("");
  });
});

describe("wave 2 handoffs: snapshot, sequence, quality and document mode messages", () => {
  it("accepts a host snapshot with a safe image URL and a camera, and refuses others", () => {
    const ok = { type: "uhd-viewer:snapshot", schema: "protoboard.snapshot/v0", level: "", view: "3d", imageUrl: "http://127.0.0.1:5180/__protoboard/snapshot.png?level=&view=3d", camera: cam() };
    expect(parseHostMessage(ok)).toMatchObject({ type: "uhd-viewer:snapshot", level: "", view: "3d" });
    expect(parseHostMessage({ ...ok, imageUrl: "javascript:alert(1)" })).toBeUndefined();
    expect(parseHostMessage({ ...ok, schema: "x" })).toBeUndefined();
    expect(parseHostMessage({ ...ok, camera: { position: [1, 2] } })).toBeUndefined();
  });

  it("accepts sequence commands and quality settings, numbers and switches only", () => {
    expect(parseHostMessage({ type: "uhd-viewer:sequence", command: { action: "goto", step: "fit:arm_fl_mount" } })).toEqual({ type: "uhd-viewer:sequence", command: { action: "goto", step: "fit:arm_fl_mount" } });
    expect(parseHostMessage({ type: "uhd-viewer:sequence", command: "goto" })).toBeUndefined();
    expect(parseHostMessage({ type: "uhd-viewer:quality", config: { enabled: false, tauMs: 200 } })).toEqual({ type: "uhd-viewer:quality", config: { enabled: false, tauMs: 200 } });
    expect(parseHostMessage({ type: "uhd-viewer:quality", config: { tauMs: "fast" } })).toBeUndefined();
    expect(isViewerEvent({ type: "uhd-viewer:sequenceState" })).toBe(true);
  });

  it("reads document mode from the URL and takes a step id in explode", () => {
    expect(fromUrlParams(new URLSearchParams("chrome=none&panel=none&zoom=1.5")).opening).toMatchObject({ chrome: "none", panel: "none", zoom: 1.5 });
    expect(fromUrlParams(new URLSearchParams("zoom=50")).opening.zoom).toBeUndefined();
    const r = applyOps(defaultViewState(), [{ op: "explode", t: 0.5, step: "fasten:stack_mount" }]);
    expect("error" in r ? r.error : r.state.explode).toEqual({ t: 0.5, step: "fasten:stack_mount" });
  });
});

describe("PB-1072: a bought part opens its own 3D view", () => {
  it("double-click on a part with nothing inside but a model of its own opens it on 3D (or shows it in 3D without a host)", async () => {
    const { openAction } = await import("../src/viewer/controller");
    const fc = { defId: "fc", childCount: 0 };
    expect(openAction(fc, true, true)).toBe("open3d");
    expect(openAction(fc, false, true)).toBe("show3d");
    // without a model of its own: nothing to open, as before
    expect(openAction(fc, true, false)).toBe("none");
    // a module with modules inside: its own level, as before
    expect(openAction({ defId: "stack", childCount: 2 }, true, true)).toBe("open");
    expect(openAction({ defId: "rail", childCount: 0, tapOf: "x" }, true, true)).toBe("none");
  });
});
