/**
 * Telemetry hooks of the 3D view (PB-1175, consumed by PB-1181 in
 * `src/telemetry/`). Subscriptions are module-wide, so a subscriber does not
 * need a handle on the scene: every scene and the shared GLB cache report
 * here. Each `on*` returns its unsubscribe function. A throwing subscriber is
 * logged and never breaks a frame or a load.
 */

export interface GlbLoadEvent {
  /** The URL the bytes came from (`X.view.glb` when the sidecar was used, else `X.glb`). */
  path: string;
  /** The URL the bundle names (`X.glb`). */
  requested: string;
  /** Content hash: the sidecar's output hash, else sha-256 of the GLB bytes (hex). */
  hash: string;
  /** Fetch, hash and parse time (ms); 0-ish when the content hash was already in the cache. */
  ms: number;
  /** Served from the cache (the content hash was already parsed). */
  cached: boolean;
  /** Of `ms` when parsed now: the GLTFLoader parse, and the rest (fetch, hash, checks). Compile time is per scene, not per file. */
  parseMs?: number;
  fetchMs?: number;
  /** Which file was used. */
  source: "sidecar" | "glb";
  counts: { bytes: number; nodes: number; meshes: number; triangles: number };
}

export interface FrameEvent {
  /** Which scene drew (several views can be open). */
  scene: number;
  /** CPU time of the frame (sync, scene pass and output pass), ms. */
  ms: number;
  /** Draw calls and triangles of the scene pass (renderer.info, the output pass not counted). */
  draws: number;
  triangles: number;
}

export interface ContextLostEvent {
  scene: number;
  /** ms since the scene was created. */
  at: number;
}

type Listener<T> = (e: T) => void;

function channel<T>() {
  const subs = new Set<Listener<T>>();
  return {
    on: (cb: Listener<T>) => {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    emit: (e: T) => {
      for (const cb of subs) {
        try {
          cb(e);
        } catch (err) {
          console.warn("[cad] telemetry subscriber failed:", err);
        }
      }
    },
    get size() {
      return subs.size;
    },
  };
}

const glbLoads = channel<GlbLoadEvent>();
const frames = channel<FrameEvent>();
const contextLosses = channel<ContextLostEvent>();

/** Every GLB load (cache hits too, with `cached: true`). */
export const onGlbLoad = glbLoads.on;
/** Every drawn frame. Frames are drawn only on change, so nothing arrives while the view is idle. */
export const onFrame = frames.on;
/** A scene's WebGL context was lost. */
export const onContextLost = contextLosses.on;

export const emitGlbLoad = glbLoads.emit;
export const emitFrame = frames.emit;
export const emitContextLost = contextLosses.emit;
/** Whether anyone listens for frames (the frame timer is skipped otherwise). */
export const frameListeners = () => frames.size;
