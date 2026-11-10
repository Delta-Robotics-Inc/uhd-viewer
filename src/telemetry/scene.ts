/**
 * Subscribing a session recorder to a 3D scene (PB-1181): the scene's hooks
 * (W1-C, `src/cad/scene.ts`: `onFrame`, `onGlbLoad`, `onContextLost`) and
 * its renderer (`renderer.info`, the GPU strings, the canvas). This file
 * never edits the scene; it only listens.
 *
 * The hooks are taken by shape, not by type, so this works whatever form the
 * scene module gives them: a `Set` of listeners (as `onFrame` is today), a
 * subscribe function that returns the unsubscribe, or nothing at all (the
 * hook is not there yet: that part of the record stays empty).
 *
 *   onFrame:       W1-C's handle method `onFrame(cb)` with `{ scene, ms, draws,
 *                  triangles }` (frames are drawn on demand, so `ms` is the
 *                  frame's CPU time and idle time never arrives); also a
 *                  number of seconds (the old continuous loop's dt)
 *   onGlbLoad:     W1-C's module-wide `onGlbLoad` (src/cad/render/events.ts)
 *                  with `{ path, requested, hash, ms, cached, source, counts:
 *                  { bytes, nodes, meshes, triangles } }`; also `{ ms?, bytes?,
 *                  fetchMs?, parseMs?, compileMs? }` or (url, ms, bytes).
 *                  Cache hits (`cached: true`) are not loads and are skipped.
 *   onContextLost: the handle's `onContextLost(cb)`; without it the canvas's
 *                  own `webglcontextlost` event is used. Restores always come
 *                  from the canvas's `webglcontextrestored`.
 *
 * The URL, path and hash of a load are never recorded (they name the
 * project's files).
 */
import { isSoftwareRenderer, type SessionRecorder } from "./record";

/** A hook as the scene may expose it. */
export type Hook<F extends (...args: never[]) => unknown> = Set<F> | ((listener: F) => (() => void) | void) | undefined;

/** The parts of a WebGL renderer read here (three.js WebGLRenderer has them all). */
export interface RendererLike {
  info?: {
    render?: { calls?: number; triangles?: number; points?: number; lines?: number };
    memory?: { geometries?: number; textures?: number };
    programs?: unknown[] | null;
  };
  domElement?: EventTarget & { width?: number; height?: number; clientWidth?: number; clientHeight?: number };
  getContext?: () => unknown;
  getPixelRatio?: () => number;
  capabilities?: { isWebGL2?: boolean };
}

/** What a scene handle offers telemetry (`SceneHandle` in src/cad/scene.ts, by shape). */
export interface SceneHooks {
  renderer?: RendererLike;
  onFrame?: Hook<(frame: unknown) => void>;
  onGlbLoad?: Hook<(...args: unknown[]) => void>;
  onContextLost?: Hook<(...args: unknown[]) => void>;
}

/** Subscribes `listener` to a hook of any supported shape; returns the unsubscribe (a no-op when there is no hook). */
export function subscribe<F extends (...args: never[]) => unknown>(hook: Hook<F> | unknown, listener: F): () => void {
  if (hook instanceof Set) {
    (hook as Set<F>).add(listener);
    return () => void (hook as Set<F>).delete(listener);
  }
  if (typeof hook === "function") {
    const off = (hook as (l: F) => (() => void) | void)(listener);
    return typeof off === "function" ? off : () => {};
  }
  return () => {};
}

/** A frame's duration in ms from whatever `onFrame` passes. */
export function frameMs(frame: unknown): number | undefined {
  if (typeof frame === "number") return frame * 1000;
  if (frame && typeof frame === "object") {
    const f = frame as { dt?: unknown; ms?: unknown; renderMs?: unknown };
    if (typeof f.ms === "number") return f.ms;
    if (typeof f.dt === "number") return f.dt * 1000;
  }
  return undefined;
}

/** A load's numbers from whatever `onGlbLoad` passes (the URL, path and hash are dropped); undefined for a cache hit. */
export function glbLoadInfo(args: unknown[]): { bytes?: number; ms?: number; fetchMs?: number; parseMs?: number; compileMs?: number } | undefined {
  const [a, b, c] = args;
  if (a && typeof a === "object") {
    const o = a as Record<string, unknown>;
    if (o.cached === true) return undefined;
    const n = (k: string, from: Record<string, unknown> = o) => (typeof from[k] === "number" ? (from[k] as number) : undefined);
    const counts = o.counts && typeof o.counts === "object" ? (o.counts as Record<string, unknown>) : {};
    return { bytes: n("bytes") ?? n("bytes", counts), ms: n("ms"), fetchMs: n("fetchMs"), parseMs: n("parseMs"), compileMs: n("compileMs") };
  }
  return { ms: typeof b === "number" ? b : undefined, bytes: typeof c === "number" ? c : undefined };
}

/** Draw calls and triangles a frame event carries (W1-C's `{ draws, triangles }`: the scene pass, which `renderer.info` may no longer hold after the output pass). */
export function frameCounts(frame: unknown): { calls?: number; triangles?: number } | undefined {
  if (!frame || typeof frame !== "object") return undefined;
  const f = frame as { draws?: unknown; triangles?: unknown };
  const calls = typeof f.draws === "number" ? f.draws : undefined;
  const triangles = typeof f.triangles === "number" ? f.triangles : undefined;
  return calls === undefined && triangles === undefined ? undefined : { calls, triangles };
}

interface DebugInfoGL {
  getExtension(name: string): unknown;
  getParameter(p: number): unknown;
}

/** GPU vendor and renderer strings (WEBGL_debug_renderer_info; blank where the browser hides them) and the backend. */
export function gpuInfo(renderer: RendererLike): NonNullable<ReturnType<SessionRecorder["snapshot"]>["gpu"]> {
  const backend = renderer.capabilities?.isWebGL2 === false ? "webgl" : "webgl2";
  let vendor: string | undefined;
  let name: string | undefined;
  try {
    const gl = renderer.getContext?.() as DebugInfoGL | undefined;
    const ext = gl?.getExtension("WEBGL_debug_renderer_info") as { UNMASKED_VENDOR_WEBGL: number; UNMASKED_RENDERER_WEBGL: number } | null | undefined;
    if (gl && ext) {
      const v = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL);
      const r = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
      vendor = typeof v === "string" ? v : undefined;
      name = typeof r === "string" ? r : undefined;
    }
  } catch {
    // a lost context, or the extension refused: no strings
  }
  return { backend, ...(vendor ? { vendor } : {}), ...(name ? { renderer: name } : {}), software: isSoftwareRenderer(name) };
}

export interface AttachOptions {
  /** Read `renderer.info` every n frames (default 1: every frame; reading is a few property loads). */
  infoEvery?: number;
  /** Called when the context is lost (the session writes a partial record then). */
  onContextLost?: () => void;
  /** Heap use, sampled every 300 frames (Chromium's `performance.memory`); tests pass their own. */
  heap?: () => number | undefined;
}

const defaultHeap = (): number | undefined => {
  const m = (globalThis as { performance?: { memory?: { usedJSHeapSize?: number } } }).performance?.memory;
  return typeof m?.usedJSHeapSize === "number" ? m.usedJSHeapSize : undefined;
};

/**
 * Subscribes `recorder` to a scene: frames, loads, renderer counts, the GPU
 * strings (once), the canvas size and context loss. Returns the detach.
 */
export function attachScene(recorder: SessionRecorder, scene: SceneHooks, options: AttachOptions = {}): () => void {
  const offs: (() => void)[] = [];
  const renderer = scene.renderer;
  const every = Math.max(1, options.infoEvery ?? 1);
  const heap = options.heap ?? defaultHeap;
  let n = 0;
  let gpuDone = false;
  const readRenderer = () => {
    if (!renderer) return;
    if (!gpuDone) {
      gpuDone = true;
      recorder.gpu = gpuInfo(renderer);
    }
    if (renderer.info) recorder.rendererInfo(renderer.info);
    const el = renderer.domElement;
    const dpr = renderer.getPixelRatio?.() ?? 1;
    const w = el?.clientWidth ?? (el?.width !== undefined ? el.width / dpr : undefined);
    const h = el?.clientHeight ?? (el?.height !== undefined ? el.height / dpr : undefined);
    if (typeof w === "number" && typeof h === "number") recorder.viewport = { w: Math.round(w), h: Math.round(h), dpr: Math.round(dpr * 100) / 100 };
  };
  offs.push(
    subscribe(scene.onFrame, (frame: unknown) => {
      const ms = frameMs(frame);
      if (ms !== undefined) recorder.frame(ms);
      const counts = frameCounts(frame);
      if (counts) recorder.rendererInfo({ render: counts });
      if (n++ % every === 0) readRenderer();
      if (n % 300 === 1) recorder.memorySample(heap());
    }),
  );
  offs.push(
    subscribe(scene.onGlbLoad, (...args: unknown[]) => {
      const info = glbLoadInfo(args);
      if (info) recorder.glbLoaded(info);
    }),
  );
  const lost = () => {
    recorder.contextLost();
    recorder.error("webglcontextlost", "WebGL context lost");
    options.onContextLost?.();
  };
  const hasLostHook = scene.onContextLost instanceof Set || typeof scene.onContextLost === "function";
  if (hasLostHook) offs.push(subscribe(scene.onContextLost, () => lost()));
  const canvas = renderer?.domElement;
  if (canvas?.addEventListener) {
    const onLost = (e: Event) => {
      // preventDefault lets the context be restored (the WebGL spec's restore flow)
      e.preventDefault?.();
      if (!hasLostHook) lost();
    };
    const onRestored = () => recorder.contextRestored();
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    offs.push(() => {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
    });
  }
  readRenderer();
  return () => {
    for (const off of offs.splice(0)) off();
  };
}
