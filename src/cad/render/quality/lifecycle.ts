/**
 * Snapshot when settled, suspend when hidden, resume when shown (PB-1176;
 * review-round-1 README §5).
 *
 * - **Snapshot.** When the view settles (the quality curve's final
 *   full-quality frame) a PNG of the canvas goes to the host's snapshot
 *   callback. The context has `preserveDrawingBuffer: false`, so the read
 *   happens in the same task as a render: `renderFull()` then `toBlob`
 *   (which copies the bitmap at the call and encodes off the main thread).
 *   The host keeps the latest one as the tab's picture (W2-A shows it while
 *   the live view is suspended or rebuilding).
 * - **Suspend.** Stops drawing; with `freeGpu`, also gives the GL context
 *   back (`WEBGL_lose_context.loseContext()`: the GPU buffers, textures and
 *   programs go; the CPU copies of every geometry stay in the GLB cache).
 *   A snapshot is taken first unless the latest one still shows the last
 *   frame drawn.
 * - **Resume.** Restores the context (three.js re-uploads from the CPU copies
 *   on the next draw), compiles the programs without blocking, then draws one
 *   frame. Timings are reported.
 *
 * The page's own visibility drives suspend and resume (scene.ts); the host
 * drives them too for its `maxLiveViews` budget (the least recently used
 * view drops to its snapshot). A view the host suspended is not resumed by
 * the page becoming visible: the host resumes it.
 *
 * Everything the browser does is injected, so the state machine runs in tests.
 */

export type SnapshotReason = "settle" | "suspend" | "request";
export type SuspendReason = "hidden" | "host";

export interface Snapshot {
  /** PNG. */
  blob: Blob;
  /** Drawing-buffer pixels. */
  width: number;
  height: number;
  /** Clock at the capture (ms, performance.now). */
  at: number;
  /** Render plus read-back, on the main thread (ms). */
  ms: number;
  /** Until the PNG was encoded (ms, off the main thread mostly). */
  encodeMs: number;
  reason: SnapshotReason;
  /** The frame count it shows (a later snapshot is skipped while nothing new was drawn). */
  frame: number;
}

export interface SuspendResult {
  snapshot?: Snapshot;
  /** The GL context was given back. */
  freedGpu: boolean;
  ms: number;
}

export interface ResumeResult {
  /** The context had been given back and is restored. */
  restored: boolean;
  /** Restore, compile and the first frame (ms). */
  ms: number;
  restoreMs: number;
  compileMs: number;
  firstFrameMs: number;
}

export interface LifecycleDeps {
  /** Draw one full-quality frame now, synchronously. */
  renderFull(): void;
  /** Read the canvas as a PNG; called in the same task as `renderFull`. */
  read(): Promise<Blob | null>;
  size(): { width: number; height: number };
  /** Frames drawn so far. */
  frames(): number;
  /** Stop (true) or allow (false) scheduled frames. */
  pause(on: boolean): void;
  /** Give the GL context back; false when the browser cannot. */
  loseContext?(): boolean;
  /** Get it back; resolves when the context is usable again. */
  restoreContext?(): Promise<boolean>;
  /** Compile programs before the first frame. */
  warm?(): Promise<void>;
  /** The context is gone (lost by the browser, not by us): nothing can be drawn or read. */
  contextLost?(): boolean;
  now(): number;
}

export type LifecycleState = { suspended: false } | { suspended: true; reason: SuspendReason; freedGpu: boolean; at: number };

export class ViewLifecycle {
  state: LifecycleState = { suspended: false };
  lastSnapshot: Snapshot | undefined;
  private snapshotSubs = new Set<(s: Snapshot) => void>();
  private stateSubs = new Set<(s: LifecycleState) => void>();
  private busy: Promise<unknown> = Promise.resolve();
  /** Whether the GPU is freed while suspended (the setting `freeGpuWhenHidden`; the host passes its own). */
  freeGpuWhenHidden: boolean;

  constructor(
    private deps: LifecycleDeps,
    options: { freeGpuWhenHidden?: boolean } = {},
  ) {
    this.freeGpuWhenHidden = options.freeGpuWhenHidden ?? false;
  }

  /** Someone wants a snapshot at every settle. */
  get wantsSnapshots(): boolean {
    return this.snapshotSubs.size > 0;
  }

  onSnapshot(cb: (s: Snapshot) => void): () => void {
    this.snapshotSubs.add(cb);
    return () => void this.snapshotSubs.delete(cb);
  }

  onState(cb: (s: LifecycleState) => void): () => void {
    this.stateSubs.add(cb);
    return () => void this.stateSubs.delete(cb);
  }

  /**
   * Draw at full quality and read the canvas. A "settle" or "suspend" snapshot
   * is skipped when the latest one shows the last frame drawn (it is returned
   * instead). Nothing is drawn while suspended or with the context lost.
   */
  async snapshot(reason: SnapshotReason = "request"): Promise<Snapshot | undefined> {
    const d = this.deps;
    if (reason !== "request" && this.lastSnapshot && this.lastSnapshot.frame === d.frames()) return this.lastSnapshot;
    if (this.state.suspended || d.contextLost?.()) return this.lastSnapshot;
    const t0 = d.now();
    let blob: Blob | null;
    let ms: number;
    let size: { width: number; height: number };
    try {
      d.renderFull();
      size = d.size();
      const pending = d.read();
      ms = d.now() - t0;
      blob = await pending;
    } catch (e) {
      console.warn("[cad] snapshot failed:", e);
      return this.lastSnapshot;
    }
    if (!blob) return this.lastSnapshot;
    const shot: Snapshot = { blob, width: size.width, height: size.height, at: t0, ms, encodeMs: d.now() - t0, reason, frame: d.frames() };
    this.lastSnapshot = shot;
    for (const cb of this.snapshotSubs) {
      try {
        cb(shot);
      } catch (e) {
        console.warn("[cad] snapshot subscriber failed:", e);
      }
    }
    return shot;
  }

  /** Stop drawing (and, with `freeGpu`, give the GL context back) after a last snapshot. */
  suspend(options: { freeGpu?: boolean; reason?: SuspendReason } = {}): Promise<SuspendResult> {
    return this.serial(async () => {
      const d = this.deps;
      const reason = options.reason ?? "host";
      if (this.state.suspended) {
        // the host's suspend outranks the page's: a host-suspended view is not resumed by visibility
        if (reason === "host" && this.state.reason === "hidden") this.setState({ ...this.state, reason: "host" });
        return { ...(this.lastSnapshot ? { snapshot: this.lastSnapshot } : {}), freedGpu: this.state.freedGpu, ms: 0 };
      }
      const t0 = d.now();
      const snapshot = await this.snapshot("suspend");
      d.pause(true);
      let freedGpu = false;
      if (options.freeGpu ?? this.freeGpuWhenHidden) freedGpu = !!d.loseContext?.();
      this.setState({ suspended: true, reason, freedGpu, at: d.now() });
      return { ...(snapshot ? { snapshot } : {}), freedGpu, ms: d.now() - t0 };
    });
  }

  /** Draw again: restore the context if it was given back, compile, one frame. `reason` "hidden" resumes only a view the page suspended. */
  resume(options: { reason?: SuspendReason } = {}): Promise<ResumeResult | undefined> {
    return this.serial(async () => {
      const d = this.deps;
      const st = this.state;
      if (!st.suspended) return undefined;
      if (options.reason === "hidden" && st.reason === "host") return undefined;
      const t0 = d.now();
      let restored = false;
      if (st.freedGpu && d.restoreContext) restored = await d.restoreContext();
      const t1 = d.now();
      if (d.warm) await d.warm().catch(() => undefined);
      const t2 = d.now();
      this.setState({ suspended: false });
      d.pause(false);
      d.renderFull();
      const t3 = d.now();
      return { restored, ms: t3 - t0, restoreMs: t1 - t0, compileMs: t2 - t1, firstFrameMs: t3 - t2 };
    });
  }

  private setState(s: LifecycleState) {
    this.state = s;
    for (const cb of this.stateSubs) {
      try {
        cb(s);
      } catch (e) {
        console.warn("[cad] lifecycle subscriber failed:", e);
      }
    }
  }

  /** One suspend or resume at a time, in call order. */
  private serial<T>(f: () => Promise<T>): Promise<T> {
    const next = this.busy.then(f, f);
    this.busy = next.catch(() => undefined);
    return next;
  }
}

/** True inside a VS Code webview (its API is injected into the page). */
export function inVsCodeWebview(): boolean {
  return typeof (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi === "function";
}
