/**
 * Render on demand (PB-1175): a frame is drawn only after something asked for
 * one (the camera moved, the selection, visibility, explode, a section, a
 * hover or a load changed). While a frame callback says it is still moving (a
 * damped orbit, an explode tween, labels easing in) the loop asks for the next
 * one itself; when everything is still, no animation frame is scheduled at
 * all, so an idle view costs no CPU.
 *
 * The scheduler takes its clock and animation-frame functions as arguments,
 * so it runs (and is tested) without a browser.
 */

/**
 * What changed: only the camera ("view"); only the placement of objects already drawn, nothing shown, hidden
 * or recoloured ("pose": an explode tween, a sequence playing; PB-1176, the batcher then rewrites matrices
 * only); or anything in the scene ("scene").
 */
export type Invalidation = "view" | "pose" | "scene";

export interface FrameInfo {
  /** Seconds since the previous frame (1/60 for the first frame after idle, capped at 0.1). */
  dt: number;
  /** Something other than the camera changed since the last frame. */
  scene: boolean;
  /** Only placements changed since the last frame (`invalidate("pose")`, and no "scene"). */
  pose?: boolean;
  /** Drawn by `flush` (a capture), not by the scheduler (PB-1176: the quality curve does not measure these). */
  flush?: boolean;
  /** ms since the previous scheduled frame, when it was under 100 ms ago (frames of one motion); undefined otherwise. */
  interval?: number;
}

export interface FrameLoopOptions {
  /** Draw one frame; return true to ask for the next one (an animation is still running). */
  frame: (info: FrameInfo) => boolean | void;
  raf?: (cb: (t: number) => void) => number;
  caf?: (id: number) => void;
  now?: () => number;
}

export interface FrameLoop {
  /** Ask for a frame (coalesced: many calls before the next animation frame draw one). */
  invalidate: (what?: Invalidation) => void;
  /** Draw now, synchronously (capture: the frame and the read-back in one task). */
  flush: (dt?: number) => void;
  /** While true, scheduled frames are skipped (an external driver such as a video capture draws with flush). */
  paused: boolean;
  /** Frames drawn since the loop was created. */
  readonly frames: number;
  /** A frame is scheduled. */
  readonly pending: boolean;
  dispose: () => void;
}

export function createFrameLoop(options: FrameLoopOptions): FrameLoop {
  const raf = options.raf ?? ((cb) => requestAnimationFrame(cb));
  const caf = options.caf ?? ((id) => cancelAnimationFrame(id));
  const now = options.now ?? (() => performance.now());
  let id: number | null = null;
  let sceneDirty = true;
  let poseDirty = false;
  let last: number | null = null;
  /** The previous scheduled frame's clock (for `interval`). */
  let prevFrame: number | null = null;
  let frames = 0;
  let disposed = false;

  const draw = (dt: number, extra: { flush?: boolean; interval?: number } = {}) => {
    const scene = sceneDirty;
    const pose = poseDirty && !scene;
    sceneDirty = false;
    poseDirty = false;
    frames++;
    return options.frame({ dt, scene, ...(pose ? { pose } : {}), ...extra }) === true;
  };

  const schedule = () => {
    if (id === null && !disposed) id = raf(tick);
  };
  function tick() {
    id = null;
    if (disposed) return;
    if (loop.paused) {
      last = null;
      return;
    }
    const t = now();
    // after idle the clock has jumped: an animation that starts now steps one ordinary frame, not 0.1 s
    const dt = last === null ? 1 / 60 : Math.min(0.1, Math.max(0, (t - last) / 1000));
    const gap = prevFrame === null ? undefined : t - prevFrame;
    prevFrame = t;
    const again = draw(dt, gap !== undefined && gap < 100 ? { interval: gap } : {});
    if (again) {
      last = t;
      schedule();
    } else last = null;
  }

  const loop: FrameLoop = {
    invalidate: (what = "scene") => {
      if (what === "scene") sceneDirty = true;
      else if (what === "pose") poseDirty = true;
      schedule();
    },
    flush: (dt = 1 / 30) => {
      if (!disposed) draw(dt, { flush: true });
    },
    paused: false,
    get frames() {
      return frames;
    },
    get pending() {
      return id !== null;
    },
    dispose: () => {
      disposed = true;
      if (id !== null) caf(id);
      id = null;
    },
  };
  return loop;
}
