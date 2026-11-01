/**
 * The viewer's local telemetry (PB-1181): one session per page, fed by the
 * 3D scene's hooks and the page's crash hooks, sent to the host as a window
 * event the host page relays to whatever writes the record (the VS Code
 * extension host, `protoboard dev`). Nothing here writes a file or reaches
 * the network; a page with no host listening records nothing anywhere.
 *
 *   import { attachSceneTelemetry } from "../telemetry";
 *   const stop = attachSceneTelemetry(sceneHandle);   // after createScene
 *   ...
 *   stop();                                           // before dispose
 *
 * The first attach starts the page's session and installs its crash hooks
 * (`window.onerror`, `unhandledrejection`, `visibilitychange`, `pagehide`,
 * the long-animation-frame observer). The session goes out:
 *
 *   - as a partial record (`partial: true`, exit `hidden`) every time the
 *     page is hidden, so a crash still leaves a record;
 *   - as a partial record (exit `crash` or `contextLost`) after an uncaught
 *     error or a lost WebGL context, at most once per 5 s;
 *   - as a partial record when the last scene detaches (a VS Code webview may
 *     be disposed without a `pagehide`);
 *   - as the final record (exit `closed`) on `pagehide`.
 *
 * The event is `uhd-viewer:telemetry` on `window`, its `detail` the record
 * (src/host/protocol.ts: TELEMETRY_EVENT); a viewer in a frame also posts it
 * to the parent over the host channel (src/host/channel.ts).
 *
 * Whether anything is kept is the writer's decision (the extension's and
 * VS Code's telemetry settings, `PROTOBOARD_TELEMETRY`): a host that records
 * nothing simply drops the event. `configureViewerTelemetry({ enabled: false })`
 * stops collection in the page itself.
 */
import { TELEMETRY_EVENT } from "../host/protocol";
// W1-C's module-wide load events (src/cad/render/events.ts): every scene and the shared GLB cache report there
import { onGlbLoad as cadGlbLoads } from "../cad/render/events";
import { SessionRecorder, type RenderSessionRecord, type SessionExit, type TelemetryHostKind } from "./record";
import { attachScene, type AttachOptions, type SceneHooks } from "./scene";

export { FRAME_BUCKETS, FrameStats, SessionRecorder, fnv1a, hashStack, redactMessage, type RenderSessionRecord, type SessionExit } from "./record";
export { attachScene, frameCounts, frameMs, glbLoadInfo, gpuInfo, subscribe, type SceneHooks } from "./scene";

/** Where records go. */
export type TelemetrySink = (record: RenderSessionRecord) => void;

/** The part of `window` the page hooks use (a test passes its own). */
export interface TelemetryWindow {
  addEventListener(type: string, listener: (e: Event) => void, options?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: string, listener: (e: Event) => void, options?: boolean | EventListenerOptions): void;
  dispatchEvent?(event: Event): boolean;
  document?: { visibilityState?: string };
  PerformanceObserver?: typeof PerformanceObserver;
}

/** Dispatches the record as `uhd-viewer:telemetry` on the window (the host page relays it). */
export function windowSink(win: TelemetryWindow): TelemetrySink {
  return (record) => {
    try {
      if (typeof CustomEvent === "function" && win.dispatchEvent) win.dispatchEvent(new CustomEvent(TELEMETRY_EVENT, { detail: record }));
    } catch {
      // a host's listener threw: never the viewer's problem
    }
  };
}

const PARTIAL_EVERY_MS = 5000;

export interface PageTelemetry {
  recorder: SessionRecorder;
  /** Send the record now (`partial` unless the page is going away). */
  flush(exit: SessionExit, partial: boolean): void;
  attach(scene: SceneHooks, options?: AttachOptions): () => void;
  dispose(): void;
}

export interface PageTelemetryOptions {
  win: TelemetryWindow;
  sink?: TelemetrySink;
  host?: TelemetryHostKind;
  viewerVersion?: string;
  recorder?: SessionRecorder;
  /** Milliseconds now (throttling partial records); tests pass their own. */
  now?: () => number;
  /**
   * Module-wide model loads, subscribed once for the page (default: the 3D
   * view's `onGlbLoad`, src/cad/render/events.ts). A scene's own
   * `onGlbLoad`, when its handle has one, is heard too.
   */
  glbLoads?: SceneHooks["onGlbLoad"] | null;
}

/**
 * A page's session with its crash hooks installed: `error`,
 * `unhandledrejection`, `visibilitychange`, `pagehide` and long animation
 * frames where the browser reports them.
 */
export function startPageTelemetry(options: PageTelemetryOptions): PageTelemetry {
  const { win } = options;
  const sink = options.sink ?? windowSink(win);
  const recorder = options.recorder ?? new SessionRecorder({ host: options.host, viewerVersion: options.viewerVersion });
  const now = options.now ?? (() => Date.now());
  let lastPartial = -Infinity;
  let scenes = 0;
  const send = (record: RenderSessionRecord) => {
    try {
      sink(record);
    } catch {
      // never let telemetry break the viewer
    }
  };
  const flush = (exit: SessionExit, partial: boolean) => {
    if (recorder.closed) return;
    if (!partial) recorder.closed = true;
    lastPartial = now();
    send(recorder.snapshot(exit, partial));
  };
  const soon = (exit: SessionExit) => {
    if (now() - lastPartial >= PARTIAL_EVERY_MS) flush(exit, true);
  };
  const lostNow = () => recorder.context.lost > recorder.context.restored;
  // the page's model loads: one subscription, whichever view loads
  const stopLoads = attachScene(recorder, { onGlbLoad: options.glbLoads === undefined ? cadGlbLoads : options.glbLoads ?? undefined });

  const onError = (e: Event) => {
    const ev = e as ErrorEvent;
    recorder.error("error", ev.error ?? ev.message ?? "error");
    soon("crash");
  };
  const onRejection = (e: Event) => {
    recorder.error("unhandledrejection", (e as PromiseRejectionEvent).reason);
    soon("crash");
  };
  const onVisibility = () => {
    if (win.document?.visibilityState === "hidden") flush(lostNow() ? "contextLost" : "hidden", true);
  };
  const onPageHide = () => flush(lostNow() ? "contextLost" : "closed", false);
  win.addEventListener("error", onError);
  win.addEventListener("unhandledrejection", onRejection);
  win.addEventListener("visibilitychange", onVisibility);
  win.addEventListener("pagehide", onPageHide);

  // long animation frames (Chromium; VS Code's webviews are Chromium), else long tasks; neither is required
  let observer: PerformanceObserver | undefined;
  try {
    const PO = win.PerformanceObserver;
    const types = PO?.supportedEntryTypes ?? [];
    const type = types.includes("long-animation-frame") ? "long-animation-frame" : types.includes("longtask") ? "longtask" : undefined;
    if (PO && type) {
      observer = new PO((list) => {
        for (const entry of list.getEntries()) recorder.frames.addLong(entry.duration);
      });
      observer.observe({ type, buffered: false });
    }
  } catch {
    observer = undefined;
  }

  return {
    recorder,
    flush,
    attach(scene, attachOptions) {
      scenes++;
      const detach = attachScene(recorder, scene, { ...attachOptions, onContextLost: () => soon("contextLost") });
      let done = false;
      return () => {
        if (done) return;
        done = true;
        detach();
        scenes--;
        // a webview can be disposed without pagehide: what was measured goes out now
        if (scenes === 0) flush(lostNow() ? "contextLost" : "hidden", true);
      };
    },
    dispose() {
      stopLoads();
      win.removeEventListener("error", onError);
      win.removeEventListener("unhandledrejection", onRejection);
      win.removeEventListener("visibilitychange", onVisibility);
      win.removeEventListener("pagehide", onPageHide);
      observer?.disconnect();
    },
  };
}

// ---------------------------------------------------------------------------
// The page's one session
// ---------------------------------------------------------------------------

let page: PageTelemetry | undefined;
let settings: { enabled: boolean; sink?: TelemetrySink; host?: TelemetryHostKind; viewerVersion?: string } = { enabled: true };

/**
 * Settings for the page's session, before the first scene attaches (a later
 * call applies to the next session): `enabled: false` stops collection in
 * the page; `sink` replaces the window event; `host` and `viewerVersion` go
 * into the record.
 */
export function configureViewerTelemetry(next: { enabled?: boolean; sink?: TelemetrySink; host?: TelemetryHostKind; viewerVersion?: string }): void {
  settings = { ...settings, ...next };
  if (settings.enabled === false && page) {
    page.dispose();
    page = undefined;
  }
}

/**
 * The one line a 3D view calls after creating its scene: subscribes the
 * page's session (started on first use) to the scene's hooks. Returns the
 * detach, to call before the scene is disposed. A no-op outside a browser or
 * when telemetry is disabled.
 */
export function attachSceneTelemetry(scene: SceneHooks, options?: AttachOptions): () => void {
  if (!settings.enabled || typeof window === "undefined") return () => {};
  try {
    page ??= startPageTelemetry({ win: window as unknown as TelemetryWindow, sink: settings.sink, host: settings.host, viewerVersion: settings.viewerVersion });
    return page.attach(scene, options);
  } catch {
    return () => {};
  }
}

/** The page's session, when one runs (tests, a host that wants to flush). */
export const currentPageTelemetry = (): PageTelemetry | undefined => page;

/** Ends the page's session (tests). */
export function resetViewerTelemetry(): void {
  page?.dispose();
  page = undefined;
  settings = { enabled: true };
}
