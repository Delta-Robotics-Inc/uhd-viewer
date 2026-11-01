/**
 * The loading screen and its stage model (PB-1177). `attachLoadTracker` feeds
 * a tracker from the module-wide GLB load events (PB-1175's `onGlbLoad`) and,
 * through the returned functions, from the view's own LoadState, compile and
 * first frame; the view mounts `<LoadingScreen state={snapshot} />`.
 */
import { onGlbLoad } from "../render/events";
import type { LoadState } from "../render/observe";
import { LoadTracker, type LoadSnapshot } from "./stages";

export { LoadingScreen, trianglePoint, type LoadingScreenProps } from "./LoadingScreen";
export { preflightFromSidecars } from "./preflight";
export { TierGate, glbPlacements, loadAtTier, useLoadTiers, type LoadTiers } from "./tiers";
export { LoadTracker, OFFER_LIGHTER_AFTER_MS, PREFLIGHT_LIMITS, SHOW_STAGE_AFTER_MS, preflight, sidecarCounts, type LoadEvent, type LoadSnapshot, type LoadStage, type LoadTier, type Preflight } from "./stages";

export interface AttachedTracker {
  tracker: LoadTracker;
  /** Call with each CadView LoadState (its `onLoadState`): counts, failures, and `ready` when every model is in. */
  loadState: (s: LoadState) => void;
  /** Call around the compile (compileAsync) of what was loaded. */
  upload: (done: number, total: number) => void;
  /** Call when the first frame with everything in it was drawn. */
  frame: () => void;
  detach: () => void;
}

/** A tracker fed by every GLB load (cache hits included), plus the view's own calls. */
export function attachLoadTracker(tracker = new LoadTracker()): AttachedTracker {
  let lastPhase: LoadState["phase"] | undefined;
  const off = onGlbLoad((e) => tracker.push({ type: "file", url: e.requested, bytes: e.counts.bytes, cached: e.cached }));
  return {
    tracker,
    loadState: (s) => {
      if (s.phase === "loading" && lastPhase !== "loading" && s.done === 0) tracker.push({ type: "begin", files: s.total });
      tracker.push({ type: "counts", total: s.total, done: s.done, failed: s.failed, bytes: s.bytes });
      if (s.phase === "ready" && lastPhase !== "ready") tracker.push({ type: "loaded" });
      lastPhase = s.phase;
    },
    upload: (done, total) => tracker.push({ type: "upload", done, total }),
    frame: () => tracker.push({ type: "frame" }),
    detach: off,
  };
}

/** A one-line text for logs and `views check`: the stage and its counts. */
export function loadLine(s: LoadSnapshot): string {
  const t = Object.entries(s.timings)
    .map(([k, v]) => `${k} ${Math.round(v ?? 0)} ms`)
    .join(", ");
  return `${s.stage}: ${s.files.fetched}/${s.files.total} files, ${s.files.failed} failed, ${(s.bytes.done / 1e6).toFixed(2)} MB${t ? `; ${t}` : ""}`;
}
