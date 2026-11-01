/**
 * The loading stages of the 3D view (PB-1177): fetch, parse, merge (only when
 * a load-time fallback runs), upload to the GPU (compileAsync), first frame.
 * A pure state machine: the view feeds it events (its LoadState, the
 * module-wide `onGlbLoad`, fetch progress, compile and frame callbacks) and
 * reads one serializable snapshot for the screen, `observe()` and the host.
 *
 * Stage rules (review round 2, runtime-and-workflows.md section 1, in our words):
 * - never a half scene popping in: the screen stays until the first frame;
 * - a failed part never blocks the rest: it is counted and the view opens;
 * - over the pre-flight thresholds (more than 20,000 draws or 5 M triangles,
 *   from the sidecar counts) the view warns and offers "load coarse" or
 *   "boxes", and never refuses (decision 15);
 * - the stage line appears after 1 s; after 10 s it offers boxes or coarse.
 */

export type LoadStage = "idle" | "preflight" | "fetch" | "parse" | "merge" | "upload" | "first-frame" | "ready";
export type LoadTier = "fine" | "coarse" | "boxes";

/** Above these, one frame of the model is heavy: warn and offer lighter tiers (never refuse). */
export const PREFLIGHT_LIMITS = { draws: 20_000, triangles: 5_000_000 } as const;
/** When the stage line shows, and when the screen offers boxes or coarse while waiting (ms). */
export const SHOW_STAGE_AFTER_MS = 1_000;
export const OFFER_LIGHTER_AFTER_MS = 10_000;

export interface Preflight {
  /** One frame of every placement at the fine tier (sidecar counts × placements). */
  draws: number;
  triangles: number;
  /** The coarse tier's triangles, where the sidecars state them. */
  coarseTriangles?: number;
  over: boolean;
  /** Plain reasons, e.g. "73,000 draw calls (limit 20,000)". */
  reasons: string[];
}

export interface LoadSnapshot {
  stage: LoadStage;
  /** ms since the load began. */
  ms: number;
  /** ms each finished stage took. */
  timings: Partial<Record<LoadStage, number>>;
  files: { total: number; fetched: number; parsed: number; failed: number; cached: number };
  bytes: { done: number; total?: number };
  merge?: { done: number; total: number };
  upload: { done: number; total: number };
  tier: LoadTier;
  preflight?: Preflight;
  /** A person or agent chose a tier after the warning (or "fine": load it all anyway). */
  choice?: LoadTier;
  /** The stage line, in plain words. */
  message: string;
  /** 0..1 when a total is known, else undefined (an indeterminate bar). */
  progress?: number;
  /** Offer boxes or coarse now (heavy model, or a long wait). */
  offerLighter: boolean;
  /** The screen should show (it stays until the first frame). */
  visible: boolean;
  /** Show the stage line (after 1 s). */
  showStage: boolean;
  failedUrls: string[];
}

const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
const fmtMB = (b: number) => `${(b / 1e6).toFixed(b < 1e7 ? 1 : 0)} MB`;

/** Sum sidecar counts over placements and compare with the limits. */
export function preflight(files: readonly { draws?: number; triangles?: number; coarseTriangles?: number; placements?: number }[]): Preflight {
  let draws = 0;
  let triangles = 0;
  let coarse = 0;
  let coarseKnown = false;
  for (const f of files) {
    const n = Math.max(1, f.placements ?? 1);
    draws += (f.draws ?? 0) * n;
    triangles += (f.triangles ?? 0) * n;
    if (f.coarseTriangles !== undefined) {
      coarse += f.coarseTriangles * n;
      coarseKnown = true;
    } else coarse += (f.triangles ?? 0) * n;
  }
  const reasons: string[] = [];
  if (draws > PREFLIGHT_LIMITS.draws) reasons.push(`${fmtInt(draws)} draw calls (limit ${fmtInt(PREFLIGHT_LIMITS.draws)})`);
  if (triangles > PREFLIGHT_LIMITS.triangles) reasons.push(`${fmtInt(triangles)} triangles (limit ${fmtInt(PREFLIGHT_LIMITS.triangles)})`);
  return { draws, triangles, ...(coarseKnown ? { coarseTriangles: coarse } : {}), over: reasons.length > 0, reasons };
}

/** The pre-flight inputs from a view sidecar index (`X.view.json`, schema protoboard.view-sidecar/v0). */
export function sidecarCounts(index: unknown, placements = 1): { draws?: number; triangles?: number; coarseTriangles?: number; placements: number } {
  const t = (index as { tiers?: { fine?: { draws?: unknown; triangles?: unknown }; coarse?: { triangles?: unknown } } } | undefined)?.tiers;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
  return { draws: num(t?.fine?.draws), triangles: num(t?.fine?.triangles), coarseTriangles: num(t?.coarse?.triangles), placements };
}

/** The progress events a load produces, in any order (late ones after `ready` are ignored). */
export type LoadEvent =
  | { type: "begin"; files: number; bytesTotal?: number; tier?: LoadTier }
  | { type: "preflight"; preflight: Preflight }
  | { type: "choose"; tier: LoadTier }
  /** Bytes arrived for some file (fetch progress). */
  | { type: "bytes"; bytes: number }
  /** A file is fetched and parsed (the GLB cache's `onGlbLoad`): its bytes, and whether it came from the cache. */
  | { type: "file"; url: string; bytes: number; cached?: boolean; parsed?: boolean }
  | { type: "failed"; url: string }
  /** The view's own count of models asked for and arrived (CadView's LoadState). */
  | { type: "counts"; total: number; done: number; failed: number; bytes?: number }
  /** A load-time merge fallback runs over `total` parts. */
  | { type: "merge"; done: number; total: number }
  /** Programs compiling and buffers uploading (compileAsync), `done` of `total` objects. */
  | { type: "upload"; done: number; total: number }
  /** Every model has arrived (or failed). */
  | { type: "loaded" }
  /** The first frame of the whole model was drawn. */
  | { type: "frame" };

/** The load stage state machine. `now` is injectable for tests. */
export class LoadTracker {
  private stage: LoadStage = "idle";
  private began = 0;
  private stageAt = 0;
  private timings: Partial<Record<LoadStage, number>> = {};
  private files = { total: 0, fetched: 0, parsed: 0, failed: 0, cached: 0 };
  private bytes = { done: 0, total: undefined as number | undefined };
  private mergeState: { done: number; total: number } | undefined;
  private uploadState = { done: 0, total: 0 };
  private tier: LoadTier = "fine";
  private pre: Preflight | undefined;
  private chosen: LoadTier | undefined;
  private failedUrls: string[] = [];
  private seen = new Set<string>();
  private listeners = new Set<(s: LoadSnapshot) => void>();

  constructor(private readonly now: () => number = () => (typeof performance !== "undefined" ? performance.now() : Date.now())) {}

  private enter(stage: LoadStage) {
    if (stage === this.stage) return;
    const t = this.now();
    if (this.stage !== "idle") this.timings[this.stage] = (this.timings[this.stage] ?? 0) + (t - this.stageAt);
    this.stage = stage;
    this.stageAt = t;
  }

  /** Feed one event; listeners hear the new snapshot. */
  push(e: LoadEvent): LoadSnapshot {
    switch (e.type) {
      case "begin":
        this.began = this.now();
        this.stage = "idle";
        this.timings = {};
        this.files = { total: e.files, fetched: 0, parsed: 0, failed: 0, cached: 0 };
        this.bytes = { done: 0, total: e.bytesTotal };
        this.mergeState = undefined;
        this.uploadState = { done: 0, total: 0 };
        this.tier = e.tier ?? this.chosen ?? "fine";
        this.failedUrls = [];
        this.seen.clear();
        this.enter(this.pre?.over && !this.chosen ? "preflight" : "fetch");
        break;
      case "preflight":
        this.pre = e.preflight;
        // heavy: wait for a choice before fetching, unless one was made (it never refuses: "fine" loads it all)
        if (e.preflight.over && !this.chosen && (this.stage === "idle" || this.stage === "fetch") && this.files.fetched === 0) this.enter("preflight");
        break;
      case "choose":
        this.chosen = e.tier;
        this.tier = e.tier;
        if (this.stage === "preflight") this.enter("fetch");
        break;
      case "bytes":
        this.bytes.done += e.bytes;
        if (this.stage === "idle" || this.stage === "preflight") this.enter("fetch");
        break;
      case "file":
        if (this.stage === "ready") break;
        if (!this.seen.has(e.url)) {
          this.seen.add(e.url);
          this.files.fetched++;
          if (e.cached) this.files.cached++;
          if (e.parsed !== false) this.files.parsed++;
          this.bytes.done += e.bytes;
          if (this.files.total < this.files.fetched) this.files.total = this.files.fetched;
        }
        if (this.stage === "idle" || this.stage === "preflight" || this.stage === "fetch") this.enter(this.files.fetched >= this.files.total ? "parse" : "fetch");
        break;
      case "failed":
        if (!this.failedUrls.includes(e.url)) {
          this.failedUrls.push(e.url);
          this.files.failed++;
        }
        break;
      case "counts":
        // the view's own count is the authority on models arrived (several placements share one file: the file
        // events, one per distinct URL, count bytes)
        if (this.stage === "ready") break;
        this.files.total = Math.max(this.files.total, e.total);
        this.files.failed = Math.max(this.files.failed, e.failed);
        this.files.fetched = Math.max(this.files.fetched, e.done);
        this.files.parsed = Math.max(this.files.parsed, e.done);
        if (e.bytes !== undefined && e.bytes > this.bytes.done) this.bytes.done = e.bytes;
        if (this.stage === "idle" || this.stage === "fetch") this.enter(this.allIn() ? "parse" : "fetch");
        break;
      case "merge":
        this.mergeState = { done: e.done, total: e.total };
        // per-body work while files still arrive stays counted under fetch; the stage moves once every file is in
        if (this.allIn() && this.stage !== "ready" && this.stage !== "first-frame") this.enter("merge");
        break;
      case "upload":
        this.uploadState = { done: e.done, total: e.total };
        if (this.allIn() && this.stage !== "ready" && this.stage !== "first-frame") this.enter("upload");
        break;
      case "loaded":
        if (this.stage !== "ready") this.enter("first-frame");
        break;
      case "frame":
        if (this.stage === "first-frame" || this.stage === "upload") this.enter("ready");
        break;
    }
    const s = this.snapshot();
    for (const cb of this.listeners) {
      try {
        cb(s);
      } catch (err) {
        console.error("[cad] loading listener failed", err);
      }
    }
    return s;
  }

  private allIn(): boolean {
    return this.files.total > 0 && this.files.fetched + this.files.failed >= this.files.total;
  }

  subscribe(cb: (s: LoadSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  /** Where the load is, for the screen, `observe()` and the host. */
  snapshot(): LoadSnapshot {
    const ms = this.stage === "idle" ? 0 : this.now() - this.began;
    const f = this.files;
    let message = "Getting your model ready";
    let progress: number | undefined;
    switch (this.stage) {
      case "preflight":
        message = `This model is large: ${this.pre?.reasons.join(" and ")}. Load a lighter view, or load it all.`;
        break;
      case "fetch":
        message = `Fetching parts (${fmtInt(f.fetched)} of ${fmtInt(f.total)}${this.bytes.total ? `, ${fmtMB(this.bytes.done)} of ${fmtMB(this.bytes.total)}` : this.bytes.done ? `, ${fmtMB(this.bytes.done)}` : ""})`;
        progress = this.bytes.total ? this.bytes.done / this.bytes.total : f.total ? f.fetched / f.total : undefined;
        break;
      case "parse":
        message = `Unpacking geometry (${fmtInt(f.parsed)} of ${fmtInt(f.total)})`;
        progress = f.total ? f.parsed / f.total : undefined;
        break;
      case "merge":
        message = `Arranging ${fmtInt(this.mergeState?.total ?? 0)} parts`;
        progress = this.mergeState?.total ? this.mergeState.done / this.mergeState.total : undefined;
        break;
      case "upload":
        message = "Preparing the view";
        progress = this.uploadState.total ? this.uploadState.done / this.uploadState.total : undefined;
        break;
      case "first-frame":
        message = "Preparing the view";
        break;
      case "ready":
        message = f.failed ? `${fmtInt(f.failed)} part(s) could not be read. The rest are shown.` : "Ready";
        progress = 1;
        break;
    }
    if (progress !== undefined) progress = Math.min(1, Math.max(0, progress));
    const loading = this.stage !== "ready" && this.stage !== "idle";
    return {
      stage: this.stage,
      ms,
      timings: { ...this.timings },
      files: { ...f },
      bytes: { ...this.bytes },
      ...(this.mergeState ? { merge: { ...this.mergeState } } : {}),
      upload: { ...this.uploadState },
      tier: this.tier,
      ...(this.pre ? { preflight: this.pre } : {}),
      ...(this.chosen ? { choice: this.chosen } : {}),
      message,
      progress,
      offerLighter: loading && this.tier === "fine" && (this.stage === "preflight" || Boolean(this.pre?.over) || ms > OFFER_LIGHTER_AFTER_MS),
      visible: loading,
      showStage: this.stage === "preflight" || (loading && ms > SHOW_STAGE_AFTER_MS),
      failedUrls: [...this.failedUrls],
    };
  }
}
