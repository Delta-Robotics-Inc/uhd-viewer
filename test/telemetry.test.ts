/**
 * Local telemetry in the viewer (PB-1181): frame statistics, the session
 * record, redaction and stack hashes, the subscriber on a fixture scene whose
 * hooks have the names W1-C gives them (`onFrame`, `onGlbLoad`,
 * `onContextLost`) in each shape they may take, the page's crash hooks
 * (error, unhandledrejection, visibilitychange, pagehide), and the host
 * channel: the telemetry message check, the relay, and a frame's parent.
 */
import { describe, expect, it } from "vitest";
import { FRAME_BUCKETS, FrameStats, SessionRecorder, hashStack, redactMessage, type RenderSessionRecord } from "../src/telemetry/record";
import { attachScene, frameMs, glbLoadInfo, gpuInfo, subscribe, type SceneHooks } from "../src/telemetry/scene";
import { startPageTelemetry, windowSink, type TelemetryWindow } from "../src/telemetry";
import { MAX_TELEMETRY_BYTES, TELEMETRY_EVENT, parseTelemetryMessage } from "../src/host/protocol";
import { connectParent, relayTelemetry, type ChannelWindow } from "../src/host/channel";
import { emitGlbLoad } from "../src/cad/render/events";

/** A clock the test moves. */
function clock(start = 0) {
  let t = start;
  return { now: () => t, wall: () => new Date(Date.UTC(2026, 10, 1, 10, 0, 0) + t), advance: (ms: number) => (t += ms) };
}

const recorder = (c = clock()) => new SessionRecorder({ host: "vscode-webview", viewerVersion: "0.2.1", now: c.now, wallNow: c.wall, id: () => "sess-0001" });

/** A scene as `src/cad/scene.ts` will offer it (W1-C): Sets of listeners, a three.js-like renderer and canvas. */
function fixtureScene(shape: "sets" | "functions" | "frame-only" = "sets") {
  const frames = new Set<(f: unknown) => void>();
  const loads = new Set<(...a: unknown[]) => void>();
  const lost = new Set<(...a: unknown[]) => void>();
  const canvas = Object.assign(new EventTarget(), { clientWidth: 1440, clientHeight: 900 });
  const info = { render: { calls: 120, triangles: 400000, points: 0, lines: 10 }, memory: { geometries: 80, textures: 4 }, programs: new Array(9) };
  const gl = {
    getExtension: (name: string) => (name === "WEBGL_debug_renderer_info" ? { UNMASKED_VENDOR_WEBGL: 1, UNMASKED_RENDERER_WEBGL: 2 } : null),
    getParameter: (p: number) => (p === 1 ? "Google Inc. (Google)" : "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)"),
  };
  const renderer = { info, domElement: canvas, getContext: () => gl, getPixelRatio: () => 1.5, capabilities: { isWebGL2: true } };
  const scene: SceneHooks =
    shape === "sets"
      ? { renderer, onFrame: frames, onGlbLoad: loads, onContextLost: lost }
      : shape === "functions"
        ? {
            renderer,
            onFrame: (l: (f: unknown) => void) => (frames.add(l), () => frames.delete(l)),
            onGlbLoad: (l: (...a: unknown[]) => void) => (loads.add(l), () => loads.delete(l)),
          }
        : { renderer, onFrame: frames };
  return {
    scene,
    canvas,
    info,
    frame: (f: unknown) => frames.forEach((l) => l(f)),
    load: (...a: unknown[]) => loads.forEach((l) => l(...a)),
    lose: () => lost.forEach((l) => l()),
    listeners: () => frames.size + loads.size + lost.size,
  };
}

describe("frame statistics", () => {
  it("buckets frames, finds p50 and p95, counts long frames and drops idle gaps", () => {
    const f = new FrameStats();
    for (let i = 0; i < 90; i++) f.add(10);
    for (let i = 0; i < 8; i++) f.add(20);
    f.add(60);
    f.add(120);
    f.add(5000); // an idle gap (render on demand): not a frame
    f.add(Number.NaN);
    expect(f.frames).toBe(100);
    expect(f.counts).toEqual([0, 90, 8, 0, 1, 1]);
    expect(f.counts).toHaveLength(FRAME_BUCKETS.length + 1);
    expect(f.quantile(0.5)).toBe(10.5);
    expect(f.quantile(0.95)).toBe(20.5);
    expect(f.long).toBe(2);
    expect(f.maxMs).toBe(120);
    f.addLong(310);
    expect([f.long, f.maxMs]).toEqual([3, 310]);
    expect(new FrameStats().quantile(0.5)).toBeUndefined();
  });
});

describe("the session record", () => {
  it("has the fifteen fields, from what the hooks fed it", () => {
    const c = clock();
    const r = recorder(c);
    r.gpu = { backend: "webgl2", vendor: "v", renderer: "r", software: false };
    r.viewport = { w: 800, h: 600, dpr: 2 };
    c.advance(100);
    r.glbLoaded({ bytes: 1000, ms: 50, fetchMs: 20, parseMs: 25, compileMs: 5 });
    r.glbLoaded({ bytes: 500, ms: 30 });
    c.advance(400);
    r.frame(16);
    r.frame(9);
    r.rendererInfo({ render: { calls: 10, triangles: 99 }, memory: { geometries: 3, textures: 1 }, programs: [1, 2] });
    r.rendererInfo({ render: { calls: 5, triangles: 200 } });
    r.memorySample(1234);
    r.contextLost();
    r.contextRestored();
    c.advance(500);
    const rec = r.snapshot("closed", false);
    expect(rec).toEqual({
      schema: "pb.render-session/v0",
      session: "sess-0001",
      start: "2026-11-01T10:00:00.000Z",
      end: "2026-11-01T10:00:01.000Z",
      durationMs: 1000,
      host: "vscode-webview",
      versions: { viewer: "0.2.1" },
      gpu: { backend: "webgl2", vendor: "v", renderer: "r", software: false },
      viewport: { w: 800, h: 600, dpr: 2 },
      load: { glbs: 2, glbBytes: 1500, loadMs: 50, fetchMs: 20, parseMs: 25, compileMs: 5, firstFrameMs: 500 },
      scene: { calls: 10, triangles: 200, geometries: 3, textures: 1, programs: 2 },
      // 16 ms is under the 16.7 ms edge: both frames fall in the second bucket
      frameMs: { buckets: [8, 16.7, 33, 50, 100], counts: [0, 2, 0, 0, 0, 0], p50: 9.5, p95: 16.5, frames: 2 },
      longFrames: { count: 0, maxMs: 16 },
      memory: { method: "performance.memory", peakBytes: 1234 },
      contextLost: { lost: 1, restored: 1 },
      errors: { count: 0, first: [] },
      exit: "closed",
    });
    expect(r.snapshot("hidden", true)).toMatchObject({ partial: true, exit: "hidden" });
  });

  it("keeps the first five errors, counts them all, and never keeps a stack, a path or a quoted name", () => {
    const r = recorder();
    const e = new TypeError(`cannot load "Front Left Motor" from C:\\Users\\Kev\\drone\\cad\\motor.glb (https://127.0.0.1:5180/artifacts/x)`);
    for (let i = 0; i < 7; i++) r.error("error", e);
    r.error("unhandledrejection", { reason: "x" });
    const rec = r.snapshot("crash", true);
    expect(rec.errors!.count).toBe(8);
    expect(rec.errors!.first).toHaveLength(5);
    expect(rec.errors!.first[0]).toEqual({ kind: "error", name: "TypeError", message: "cannot load <str> from <path> (<url>)", stackHash: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(JSON.stringify(rec)).not.toMatch(/Front|Users|Kev|motor|127\.0\.0\.1|at /);
  });

  it("redacts messages and folds stacks so the same crash hashes alike anywhere", () => {
    expect(redactMessage("token ghp_abcdefghijklmnopqrstuvwxyz0123456789 for a@b.co in /home/kev/p/x.ts")).toBe("token <secret> for <email> in <path>");
    const a = "Error: x\n    at f (http://127.0.0.1:5180/__protoboard/viewer/web-viewer.js:10:5)";
    const b = "Error: x\n    at f (vscode-webview://abc123/dist/webview/web-viewer.js:10:5)";
    expect(hashStack(a)).toBe(hashStack(b));
    expect(hashStack(a)).not.toBe(hashStack(a.replace("10:5", "10:6")));
  });
});

describe("the subscriber on a fixture scene (W1-C's hook names)", () => {
  it("reads frames, loads, renderer counts, the GPU strings and the canvas from Set-shaped hooks", () => {
    const c = clock();
    const r = recorder(c);
    const s = fixtureScene("sets");
    const detach = attachScene(r, s.scene, { heap: () => 2048 });
    // the GPU strings and the canvas are read at once
    expect(r.gpu).toEqual({ backend: "webgl2", vendor: "Google Inc. (Google)", renderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)", software: true });
    expect(r.viewport).toEqual({ w: 1440, h: 900, dpr: 1.5 });
    c.advance(200);
    s.load({ url: "http://127.0.0.1/artifacts/p/cad/body.view.glb", ms: 300, bytes: 4096, fetchMs: 100, parseMs: 150, compileMs: 50 });
    c.advance(50);
    s.frame(1 / 60);
    s.info.render.calls = 300;
    s.frame({ dt: 0.02 });
    s.frame({ ms: 70 });
    const rec = r.snapshot("closed", false);
    expect(rec.load).toEqual({ glbs: 1, glbBytes: 4096, loadMs: 300, fetchMs: 100, parseMs: 150, compileMs: 50, firstFrameMs: 250 });
    expect(rec.frameMs!.frames).toBe(3);
    expect(rec.longFrames).toEqual({ count: 1, maxMs: 70 });
    expect(rec.scene).toMatchObject({ calls: 300, triangles: 400000, programs: 9, geometries: 80, textures: 4 });
    expect(rec.memory).toEqual({ method: "performance.memory", peakBytes: 2048 });
    // the load's URL is never kept
    expect(JSON.stringify(rec)).not.toContain("body.view.glb");
    // a lost context through the hook: counted once, even though the canvas fires too
    s.lose();
    s.canvas.dispatchEvent(new Event("webglcontextlost"));
    s.canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(r.context).toEqual({ lost: 1, restored: 1 });
    expect(r.snapshot("closed", false).errors!.first[0]).toMatchObject({ kind: "webglcontextlost" });
    detach();
    expect(s.listeners()).toBe(0);
  });

  it("takes function-shaped hooks and positional load arguments; without onContextLost the canvas tells", () => {
    const r = recorder();
    const s = fixtureScene("functions");
    const detach = attachScene(r, s.scene);
    s.load("http://x/a.glb", 120, 2048);
    s.frame(0.016);
    s.canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    expect(r.snapshot("closed", false)).toMatchObject({ load: { glbs: 1, glbBytes: 2048, loadMs: 120 }, contextLost: { lost: 1, restored: 0 } });
    detach();
    expect(s.listeners()).toBe(0);
    // after detach the canvas is not listened to
    s.canvas.dispatchEvent(new Event("webglcontextlost"));
    expect(r.context.lost).toBe(1);
  });

  it("takes W1-C's own shapes: the handle's onFrame({ms, draws, triangles}) and onContextLost, and the module-wide onGlbLoad (cache hits skipped)", () => {
    const win = fakeWindow();
    const sent: RenderSessionRecord[] = [];
    const r = recorder();
    // the real module-wide load events of src/cad/render/events.ts
    const page = startPageTelemetry({ win, sink: (x) => sent.push(x), recorder: r });
    const frameSubs = new Set<(e: unknown) => void>();
    const lostSubs = new Set<() => void>();
    const canvas = Object.assign(new EventTarget(), { clientWidth: 640, clientHeight: 480 });
    // after the output pass renderer.info holds the full-screen triangle only
    const handle = {
      renderer: { info: { render: { calls: 1, triangles: 1 }, memory: { geometries: 40, textures: 2 }, programs: [1, 2, 3] }, domElement: canvas, getPixelRatio: () => 1 },
      onFrame: (cb: (e: unknown) => void) => (frameSubs.add(cb), () => void frameSubs.delete(cb)),
      onContextLost: (cb: () => void) => (lostSubs.add(cb), () => void lostSubs.delete(cb)),
    };
    const detach = page.attach(handle as unknown as SceneHooks);
    emitGlbLoad({ path: "http://x/body.view.glb", requested: "http://x/body.glb", hash: "ab", ms: 210, cached: false, source: "sidecar", counts: { bytes: 31_800_000, nodes: 900, meshes: 1200, triangles: 2_000_000 } });
    emitGlbLoad({ path: "http://x/body.view.glb", requested: "http://x/body.glb", hash: "ab", ms: 0.2, cached: true, source: "sidecar", counts: { bytes: 31_800_000, nodes: 900, meshes: 1200, triangles: 2_000_000 } });
    for (const cb of frameSubs) cb({ scene: 1, ms: 12.5, draws: 388, triangles: 2_310_442 });
    for (const cb of frameSubs) cb({ scene: 1, ms: 61, draws: 390, triangles: 2_310_442 });
    for (const cb of lostSubs) cb();
    canvas.dispatchEvent(new Event("webglcontextlost"));
    const rec = r.snapshot("closed", false);
    expect(rec.load).toMatchObject({ glbs: 1, glbBytes: 31_800_000, loadMs: 210 });
    expect(rec.scene).toMatchObject({ calls: 390, triangles: 2_310_442, programs: 3, geometries: 40 });
    expect(rec.frameMs).toMatchObject({ frames: 2, counts: [0, 1, 0, 0, 1, 0] });
    expect(rec.longFrames).toEqual({ count: 1, maxMs: 61 });
    expect(rec.contextLost).toEqual({ lost: 1, restored: 0 });
    expect(JSON.stringify(rec)).not.toMatch(/body|http/);
    detach();
    expect(frameSubs.size + lostSubs.size).toBe(0);
    page.dispose();
    // after dispose the page no longer hears loads
    emitGlbLoad({ path: "p", requested: "p", hash: "h", ms: 5, cached: false, source: "glb", counts: { bytes: 1, nodes: 1, meshes: 1, triangles: 1 } });
    expect(r.snapshot("closed", false).load!.glbs).toBe(1);
  });

  it("works before W1-C's hooks exist: only onFrame, no load events", () => {
    const r = recorder();
    const s = fixtureScene("frame-only");
    attachScene(r, s.scene)();
    expect(subscribe(undefined, () => {})).toBeTypeOf("function");
    expect(frameMs("x")).toBeUndefined();
    expect(glbLoadInfo([{ bytes: 1, url: "secret" }])).toEqual({ bytes: 1, ms: undefined, fetchMs: undefined, parseMs: undefined, compileMs: undefined });
    expect(glbLoadInfo([{ cached: true, ms: 1 }])).toBeUndefined();
    expect(gpuInfo({ getContext: () => { throw new Error("lost"); } })).toEqual({ backend: "webgl2", software: false });
  });
});

/** A window with the events the page hooks use. */
function fakeWindow(): TelemetryWindow & EventTarget & { document: { visibilityState: string } } {
  const t = new EventTarget() as TelemetryWindow & EventTarget & { document: { visibilityState: string } };
  t.document = { visibilityState: "visible" };
  return t;
}

describe("the page's crash hooks", () => {
  it("sends a partial record when hidden, after an error (at most every 5 s) and when the last scene detaches; the final one on pagehide", () => {
    const win = fakeWindow();
    const sent: RenderSessionRecord[] = [];
    const c = clock();
    let now = 0;
    const page = startPageTelemetry({ win, sink: (r) => sent.push(r), recorder: recorder(c), now: () => now, glbLoads: null });
    const s = fixtureScene("sets");
    const detach = page.attach(s.scene);

    win.document.visibilityState = "hidden";
    win.dispatchEvent(new Event("visibilitychange"));
    expect(sent.map((r) => [r.partial, r.exit])).toEqual([[true, "hidden"]]);

    // an uncaught error: within 5 s of the last partial, recorded but not sent yet
    now = 1000;
    win.dispatchEvent(Object.assign(new Event("error"), { error: new RangeError("bad index") }));
    expect(sent).toHaveLength(1);
    now = 7000;
    win.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: new Error("nope") }));
    expect(sent.map((r) => [r.partial, r.exit, r.errors!.count])).toEqual([
      [true, "hidden", 0],
      [true, "crash", 2],
    ]);
    expect(sent[1].errors!.first.map((e) => [e.kind, e.name])).toEqual([
      ["error", "RangeError"],
      ["unhandledrejection", "Error"],
    ]);

    // a lost context goes out at once (after 5 s)
    now = 20000;
    s.lose();
    expect(sent[2]).toMatchObject({ partial: true, exit: "contextLost" });

    detach();
    expect(sent[3]).toMatchObject({ partial: true, exit: "contextLost" });
    win.dispatchEvent(new Event("pagehide"));
    expect(sent[4]).toMatchObject({ exit: "contextLost" });
    expect(sent[4].partial).toBeUndefined();
    // nothing after the final record
    win.dispatchEvent(new Event("pagehide"));
    win.document.visibilityState = "hidden";
    win.dispatchEvent(new Event("visibilitychange"));
    expect(sent).toHaveLength(5);
    page.dispose();
  });

  it("an ordinary close: exit closed; a listener that throws never reaches the viewer", () => {
    const win = fakeWindow();
    const page = startPageTelemetry({
      win,
      sink: () => {
        throw new Error("host gone");
      },
      recorder: recorder(),
    });
    expect(() => win.dispatchEvent(new Event("pagehide"))).not.toThrow();
    page.dispose();
    const sent: RenderSessionRecord[] = [];
    const page2 = startPageTelemetry({ win, sink: (r) => sent.push(r), recorder: recorder() });
    win.dispatchEvent(new Event("pagehide"));
    expect(sent.map((r) => r.exit)).toEqual(["closed"]);
    page2.dispose();
    // disposed: no more listeners
    win.dispatchEvent(new Event("pagehide"));
    expect(sent).toHaveLength(1);
  });

  it("the default sink is the window event the host page relays", () => {
    const win = fakeWindow();
    const got: unknown[] = [];
    const stop = relayTelemetry(win, (m) => got.push(m));
    windowSink(win)(recorder().snapshot("hidden", true));
    expect(got).toEqual([{ type: TELEMETRY_EVENT, record: expect.objectContaining({ schema: "pb.render-session/v0", partial: true }) }]);
    stop();
    windowSink(win)(recorder().snapshot("hidden", true));
    expect(got).toHaveLength(1);
  });
});

describe("telemetry on the host channel", () => {
  it("checks the envelope: a known schema, an object, not too large", () => {
    const rec = recorder().snapshot("closed", false);
    expect(parseTelemetryMessage({ type: TELEMETRY_EVENT, record: rec })).toEqual({ type: TELEMETRY_EVENT, record: rec });
    expect(parseTelemetryMessage(rec)).toEqual({ type: TELEMETRY_EVENT, record: rec });
    expect(parseTelemetryMessage({ type: TELEMETRY_EVENT, record: { schema: "x" } })).toBeUndefined();
    expect(parseTelemetryMessage({ type: TELEMETRY_EVENT, record: [rec] })).toBeUndefined();
    expect(parseTelemetryMessage({ ...rec, pad: "x".repeat(MAX_TELEMETRY_BYTES) })).toBeUndefined();
    expect(parseTelemetryMessage(null)).toBeUndefined();
  });

  it("a viewer in a frame posts its records to the parent, at the parent's origin", () => {
    const posted: [unknown, string][] = [];
    const target = new EventTarget();
    const win = Object.assign(target, {
      parent: { postMessage: (m: unknown, o: string) => posted.push([m, o]) },
      location: { origin: "http://127.0.0.1:5180", ancestorOrigins: ["vscode-webview://abc"] },
    });
    const channel = connectParent(win as unknown as ChannelWindow, { origins: ["vscode-webview://*"], onMessage: () => {} })!;
    windowSink(win as unknown as TelemetryWindow)(recorder().snapshot("hidden", true));
    expect(posted).toEqual([[{ type: TELEMETRY_EVENT, record: expect.objectContaining({ session: "sess-0001" }) }, "vscode-webview://abc"]]);
    channel.close();
    windowSink(win as unknown as TelemetryWindow)(recorder().snapshot("hidden", true));
    expect(posted).toHaveLength(1);
  });
});
