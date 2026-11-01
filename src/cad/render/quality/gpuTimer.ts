/**
 * GPU frame time through `EXT_disjoint_timer_query_webgl2` (PB-1176), where
 * the browser exposes it. A query brackets the frame's draws; its result
 * arrives one to a few frames later, so `poll()` returns the newest finished
 * one. A disjoint event (the GPU was interrupted, the clock jumped) discards
 * the queries in flight. Where the extension is missing the quality curve
 * falls back to CPU time and the frame interval (controller.ts).
 *
 * Whether the extension is there is recorded (`available`, and the phase-1
 * progress notes for headless Chrome and the VS Code webview).
 */

/** The constants of EXT_disjoint_timer_query_webgl2 (the extension object carries them too). */
const TIME_ELAPSED_EXT = 0x88bf;
const GPU_DISJOINT_EXT = 0x8fbb;

/** The part of a WebGL2 context the timer uses (a fake in tests). */
export interface TimerGl {
  getExtension(name: string): unknown;
  createQuery(): WebGLQuery | null;
  deleteQuery(q: WebGLQuery | null): void;
  beginQuery(target: number, q: WebGLQuery): void;
  endQuery(target: number): void;
  getQueryParameter(q: WebGLQuery, pname: number): unknown;
  getParameter(pname: number): unknown;
  readonly QUERY_RESULT_AVAILABLE: number;
  readonly QUERY_RESULT: number;
}

export class GpuTimer {
  readonly available: boolean;
  private pending: WebGLQuery[] = [];
  private free: WebGLQuery[] = [];
  private open: WebGLQuery | null = null;
  /** Newest finished frame's GPU time (ms). */
  last: number | undefined;
  /** Frames measured, and disjoint events seen. */
  measured = 0;
  disjoint = 0;

  constructor(private gl: TimerGl | null) {
    this.available = !!gl && !!safe(() => gl.getExtension("EXT_disjoint_timer_query_webgl2"));
  }

  /** Start timing a frame (no-op without the extension, or while a query is open). */
  begin(): void {
    if (!this.available || this.open || !this.gl) return;
    // more than a few frames in flight means results are not coming back (a lost context): stop asking
    if (this.pending.length > 8) return;
    const q = this.free.pop() ?? this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(TIME_ELAPSED_EXT, q);
    this.open = q;
  }

  end(): void {
    if (!this.open || !this.gl) return;
    this.gl.endQuery(TIME_ELAPSED_EXT);
    this.pending.push(this.open);
    this.open = null;
  }

  /** Collect finished queries; returns the newest GPU time (ms), or undefined. */
  poll(): number | undefined {
    const gl = this.gl;
    if (!this.available || !gl) return undefined;
    if (safe(() => gl.getParameter(GPU_DISJOINT_EXT))) {
      // the queries in flight measured nothing usable
      this.disjoint++;
      this.free.push(...this.pending);
      this.pending = [];
      return this.last;
    }
    while (this.pending.length) {
      const q = this.pending[0];
      if (!safe(() => gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE))) break;
      const ns = Number(safe(() => gl.getQueryParameter(q, gl.QUERY_RESULT)) ?? NaN);
      this.pending.shift();
      this.free.push(q);
      if (Number.isFinite(ns)) {
        this.last = ns / 1e6;
        this.measured++;
      }
    }
    return this.last;
  }

  /** After a context loss or restore: the old queries belong to the old context. */
  reset(): void {
    this.pending = [];
    this.free = [];
    this.open = null;
    this.last = undefined;
  }

  dispose(): void {
    if (this.gl) for (const q of [...this.pending, ...this.free]) safe(() => this.gl!.deleteQuery(q));
    this.reset();
  }
}

function safe<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}
