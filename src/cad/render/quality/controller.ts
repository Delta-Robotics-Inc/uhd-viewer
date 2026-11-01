/**
 * The interaction quality curve (PB-1176, phase-1 wave 2, W2-B).
 *
 * A pure state machine: it is fed frame samples (CPU render time, GPU time
 * where the timer query exists, the interval to the previous frame of the
 * same motion), pointer state and the clock, and says which knobs are
 * engaged. It draws nothing and reads no clock of its own, so it runs (and is
 * tested) as a function of frame-time sequences. `scene.ts` applies the knobs.
 *
 * Design: review-round-1 README §26 and round-2-notes
 * quality-curve-uhd-carrier-transcripts.md section B (the control law, the
 * state table and the pseudocode), written here in our own code.
 *
 * - States: `idle` (settled, full quality, no frames), `interacting` (the
 *   camera moves or an animation runs), `settling` (released: the recovery
 *   curve runs).
 * - Knobs, cheapest visual loss first: effects (edges and outline once they
 *   exist, MSAA samples on the "msaa" path), device pixel ratio 1.5, 1.0,
 *   unfocused parts at the coarse tier, unfocused parts merged into one batch
 *   per look, device pixel ratio 0.75 (the floor). Emergency only: device
 *   pixel ratio 0.5, when frames stay over the hard threshold (50 ms) at the
 *   floor.
 * - Bottleneck aware: a CPU-bound frame (draw submission dominates) skips the
 *   pixel knobs, which cannot help it, and coarsens and merges instead.
 * - Degrade when the frame-time average is over 1.15 x the display budget for
 *   3 frames; upgrade (during a gesture) when under 0.70 x for 20 frames; at
 *   least 250 ms between changes; a lock after more than 3 reversals in 2 s.
 * - On release (pointer up, the camera still, 120 ms quiet) quality recovers
 *   on q(t) = 1 - (1 - q_release) exp(-t / tau), tau 200 ms: the engaged
 *   knobs come back in reverse ladder order at t_k = tau ln(n / k), and at
 *   3 tau (600 ms) everything is back, ending with one full-quality render.
 * - A small model never looks worse: every gesture starts at full quality
 *   (unless this scene's last full-quality frame was itself over budget), and
 *   nothing engages while the average stays under 1.15 x the budget.
 */

/** One knob of the ladder. */
export type Knob = "effects" | "dpr1.5" | "dpr1" | "coarse" | "merge" | "dpr0.75" | "dpr0.5";

/** The ladder, cheapest visual loss first; the last rung is the normal floor. */
export const LADDER: readonly Knob[] = ["effects", "dpr1.5", "dpr1", "coarse", "merge", "dpr0.75"];
/** Below the floor, only when frames stay over the hard threshold there. */
export const EMERGENCY: readonly Knob[] = ["dpr0.5"];
const ORDER: readonly Knob[] = [...LADDER, ...EMERGENCY];
/** Rung index of a knob (0 = cheapest loss). */
export const rungOf = (k: Knob) => ORDER.indexOf(k);

/** The device pixel ratio a DPR knob sets. */
export const DPR_OF: Partial<Record<Knob, number>> = { "dpr1.5": 1.5, dpr1: 1, "dpr0.75": 0.75, "dpr0.5": 0.5 };
/** Knobs that relieve the GPU's pixel work (no use when the frame is CPU-bound). */
const FILL = new Set<Knob>(["effects", "dpr1.5", "dpr1", "dpr0.75", "dpr0.5"]);

export type QualityState = "idle" | "interacting" | "settling";
/** What limits the frame: draw submission ("cpu"), pixels ("gpu"), or not known yet. */
export type Bottleneck = "cpu" | "gpu" | "unknown";

export interface QualityConfig {
  /** The display frame period (ms): 16.7 at 60 Hz. */
  budgetMs: number;
  /** Degrade above this x budget ... */
  degradeAt: number;
  /** ... held this many frames. */
  degradeFrames: number;
  /** Upgrade (during a gesture) below this x budget ... */
  upgradeAt: number;
  /** ... held this many frames. */
  upgradeFrames: number;
  /** Least time between two changes (ms), except a panic step. */
  dwellMs: number;
  /** More reversals than this within `flipWindowMs` lock the rung for the rest of the gesture. */
  flipLimit: number;
  flipWindowMs: number;
  /** The hard threshold (ms): the floor holds below it; two frames over it step down 2 rungs at once. */
  hardMs: number;
  /** Frames over `hardMs` in a row before a panic step (DEFAULT 2: one GC pause never degrades a small model). */
  panicFrames: number;
  /** Frames over `hardMs` in a row, at the floor, before the emergency rung. */
  emergencyFrames: number;
  /** Quiet after the last movement, with the pointer up, before settling (ms). */
  quietMs: number;
  /** Recovery time constant (ms); 0 snaps straight back to full quality. */
  tauMs: number;
  /** Weight of the newest frame in the moving average. */
  emaAlpha: number;
  /** Samples ignored after a knob changed (the first frame pays for a resize or a rebuild). */
  settleFrames: number;
  /**
   * Time at the start of a gesture whose samples are ignored (DEFAULT 200 ms, and at least the first frame): the
   * first frames after idle are slow on their own while the GPU leaves its low-power state. Measured on the
   * phase-1 Intel UHD (ClientX, GPU timer): 10 to 14 ms of GPU time for the first 200 ms of a drag, 5.1 ms after.
   * Time, not a frame count, so a heavy scene (470 ms frames in SwiftShader) is not held for seconds.
   */
  warmupMs: number;
  /**
   * A knob is on trial after it engages (DEFAULT: `trialLag` 3 frames ignored, then the median of
   * `trialFrames` 8 frames; 0 turns trials off): when that median is not `minGain` (3 %) under the median of
   * the 8 frames before, the knob did not help this scene (the bottleneck guess was wrong: a vertex-bound frame
   * does not get cheaper with fewer pixels), so it is released (not counted as a reversal) and skipped until
   * the scene changes. Medians, not the moving average: GPU timer results arrive 3 to 4 frames late (measured,
   * Intel UHD and ANGLE), and one hitch must not decide. Measured on ClientX: the lower pixel ratio with the
   * foveal inset made frames dearer (7.6 ms against 5.7), as the inset draws the geometry a second time.
   */
  trialLag: number;
  trialFrames: number;
  minGain: number;
  /** false: the controller never engages a knob. */
  enabled: boolean;
}

export const DEFAULT_QUALITY: QualityConfig = {
  budgetMs: 1000 / 60,
  degradeAt: 1.15,
  degradeFrames: 3,
  upgradeAt: 0.7,
  upgradeFrames: 20,
  dwellMs: 250,
  flipLimit: 3,
  flipWindowMs: 2000,
  hardMs: 50,
  panicFrames: 2,
  emergencyFrames: 3,
  quietMs: 120,
  tauMs: 200,
  emaAlpha: 0.3,
  settleFrames: 1,
  warmupMs: 200,
  trialLag: 3,
  trialFrames: 8,
  minGain: 0.03,
  enabled: true,
};

/** Which knobs can do anything in this scene now (a knob that cannot help is skipped, never engaged). */
export interface Availability {
  /** An effect (edges, outline) is registered, or MSAA samples can drop. */
  effects: boolean;
  /** The device pixel ratio at full quality (min(devicePixelRatio, 2)). */
  baseDpr: number;
  /** Unfocused parts have a coarse tier that differs from the fine one. */
  coarse: boolean;
  /** Merging unfocused parts would save draw calls. */
  merge: boolean;
}

export const NO_AVAILABILITY: Availability = { effects: false, baseDpr: 1, coarse: false, merge: false };

/** One drawn frame as the scene measured it. */
export interface FrameSample {
  /** Clock at the frame (ms). */
  t: number;
  /** CPU time of the render (ms). */
  cpuMs: number;
  /** GPU time of the frame (ms), where EXT_disjoint_timer_query_webgl2 gave one. */
  gpuMs?: number;
  /** Time since the previous frame of the same motion (ms), when the frames ran back to back. */
  intervalMs?: number;
  /** The camera moved or an animation ran in this frame (an interaction, not a one-off redraw). */
  active: boolean;
}

/** What the controller says after an input. */
export interface Decision {
  /** The engaged knobs changed: apply them and draw. */
  changed: boolean;
  /** Settled: draw one full-quality frame (and take the settle snapshot). */
  final: boolean;
}

export interface QualityStatus {
  state: QualityState;
  /** Engaged knobs, in ladder order. */
  knobs: Knob[];
  /** Highest engaged rung + 1 (0 = full quality). */
  rung: number;
  bottleneck: Bottleneck;
  /** The frame time the last decision used (ms) and its moving average. */
  frameMs: number;
  emaMs: number;
  budgetMs: number;
  locked: boolean;
  /** Device pixel ratio the knobs set (the base when no DPR knob is engaged). */
  dpr: number;
}

/** Frame time of a sample: CPU plus GPU when the GPU time is known, else the longer of CPU time and the frame interval. */
export function frameTimeOf(s: FrameSample): number {
  if (s.gpuMs !== undefined) return s.cpuMs + s.gpuMs;
  return Math.max(s.cpuMs, s.intervalMs ?? s.cpuMs);
}

/**
 * The bottleneck guess. With a GPU time: CPU-bound when CPU time is over 75 %
 * of the frame or the GPU time under 50 % of it. Without one, a frame interval
 * longer than the CPU time means the GPU (or the compositor) held it up.
 */
export function bottleneckOf(s: FrameSample): Bottleneck {
  const f = frameTimeOf(s);
  if (f <= 0) return "unknown";
  if (s.gpuMs !== undefined) return s.cpuMs > 0.75 * f || s.gpuMs < 0.5 * f ? "cpu" : "gpu";
  if (s.intervalMs === undefined) return "unknown";
  return s.cpuMs > 0.75 * f ? "cpu" : "gpu";
}

/** Whether a knob can do anything with this availability and bottleneck. */
export function knobUseful(k: Knob, a: Availability, bottleneck: Bottleneck): boolean {
  if (bottleneck === "cpu" && FILL.has(k)) return false;
  if (k === "effects") return a.effects;
  if (k === "coarse") return a.coarse;
  if (k === "merge") return a.merge;
  const dpr = DPR_OF[k];
  return dpr !== undefined && a.baseDpr > dpr + 1e-3;
}

/** The device pixel ratio for a set of engaged knobs. */
export function dprFor(knobs: Iterable<Knob>, baseDpr: number): number {
  let d = baseDpr;
  for (const k of knobs) {
    const v = DPR_OF[k];
    if (v !== undefined) d = Math.min(d, v);
  }
  return d;
}

/**
 * Restore times after settling begins (ms), from the most visible loss down:
 * with n knobs engaged, quality q(t) = 1 - (1 - q_release) exp(-t/tau) brings
 * the count to k at tau ln(n/k); the last one goes at 3 tau.
 */
export function restoreTimes(n: number, tauMs: number): number[] {
  const out: number[] = [];
  for (let k = n - 1; k >= 1; k--) out.push(tauMs * Math.log(n / k));
  if (n > 0) out.push(3 * tauMs);
  return out;
}

export class QualityController {
  config: QualityConfig;
  availability: Availability;
  state: QualityState = "idle";
  /** Engaged knobs, in ladder order. */
  private engaged: Knob[] = [];
  private ema = 0;
  private haveEma = false;
  private over = 0;
  private under = 0;
  private hard = 0;
  private skip = 0;
  /** When the gesture began (warm-up runs from here). */
  private gestureStart = -Infinity;
  private warmed = false;
  private lastChange = -Infinity;
  private lastDir = 0;
  private flips: number[] = [];
  private locked = false;
  private held = false;
  private lastActive = -Infinity;
  private settleStart = 0;
  private settleN = 0;
  private lastFrameMs = 0;
  private bottleneck: Bottleneck = "unknown";
  /** This scene's last full-quality frame cost, and the knobs its last gesture needed (the start rung). */
  private lastFullMs = 0;
  private remembered = 0;
  /** The knob on trial: the average before it engaged, and the frames measured since. */
  private trial: { knob: Knob; before: number; n: number; after: number[]; t: number } | undefined;
  /** The last measured frame times of this gesture (the trials' "before"). */
  private recent: number[] = [];
  /** Knobs that did not help this scene (skipped until the availability changes). */
  private ineffective = new Set<Knob>();

  constructor(config: Partial<QualityConfig> = {}, availability: Availability = NO_AVAILABILITY) {
    this.config = { ...DEFAULT_QUALITY, ...config };
    this.availability = availability;
  }

  get knobs(): Knob[] {
    return [...this.engaged];
  }

  status(): QualityStatus {
    const top = this.engaged.length ? Math.max(...this.engaged.map(rungOf)) + 1 : 0;
    return {
      state: this.state,
      knobs: this.knobs,
      rung: top,
      bottleneck: this.bottleneck,
      frameMs: this.lastFrameMs,
      emaMs: this.ema,
      budgetMs: this.config.budgetMs,
      locked: this.locked,
      dpr: dprFor(this.engaged, this.availability.baseDpr),
    };
  }

  /** Pointer (or key) held down: the gesture cannot settle while it is. */
  pointer(down: boolean, t: number): Decision {
    this.held = down;
    if (down) return this.begin(t);
    return NONE;
  }

  /** A drawn frame. Samples of one-off redraws (not `active`) only update the full-quality cost. */
  frame(s: FrameSample): Decision {
    const f = frameTimeOf(s);
    if (!this.engaged.length && (s.gpuMs !== undefined || s.intervalMs !== undefined)) this.lastFullMs = f;
    if (!s.active) return NONE;
    const began = this.begin(s.t);
    this.lastActive = s.t;
    if (!this.config.enabled) return began;
    if (!this.warmed) {
      // at least the gesture's first frame, then until the warm-up time is over
      if (s.t - this.gestureStart < this.config.warmupMs || s.t === this.gestureStart) return began;
      this.warmed = true;
    }
    if (this.skip > 0) {
      this.skip--;
      return began;
    }
    const c = this.config;
    const B = c.budgetMs;
    this.lastFrameMs = f;
    this.bottleneck = bottleneckOf(s);
    this.ema = this.haveEma ? (1 - c.emaAlpha) * this.ema + c.emaAlpha * f : f;
    this.haveEma = true;
    this.hard = f > c.hardMs ? this.hard + 1 : 0;
    this.over = this.ema > c.degradeAt * B ? this.over + 1 : 0;
    this.under = this.ema < c.upgradeAt * B ? this.under + 1 : 0;
    this.recent.push(f);
    if (this.recent.length > 16) this.recent.shift();
    // the knob on trial: released (not a reversal) when it did not make frames cheaper
    if (this.trial && ++this.trial.n > c.trialLag) this.trial.after.push(f);
    // judged after `trialFrames` frames, or after the dwell with at least 3 (slow frames do not hold the ladder for seconds)
    if (this.trial && (this.trial.after.length >= c.trialFrames || (this.trial.after.length >= 3 && s.t - this.trial.t >= c.dwellMs))) {
      const tr = this.trial;
      this.trial = undefined;
      if (median(tr.after) > tr.before * (1 - c.minGain) && this.engaged.includes(tr.knob)) {
        this.engaged = this.engaged.filter((k) => k !== tr.knob);
        this.ineffective.add(tr.knob);
        this.lastChange = s.t;
        this.over = this.under = 0;
        this.skip = c.settleFrames;
        return CHANGED;
      }
    }
    // emergency: frames stay over the hard threshold at the floor
    if (this.hard >= c.emergencyFrames && !this.next(+1) && !this.engaged.includes("dpr0.5") && knobUseful("dpr0.5", this.availability, this.bottleneck)) {
      this.engage("dpr0.5", s.t, +1);
      return CHANGED;
    }
    // panic: two frames over the hard threshold step down two rungs at once (dwell does not hold it)
    if (this.hard >= c.panicFrames && !this.locked) {
      const a = this.step(+1, s.t, false);
      const b = this.step(+1, s.t, false);
      if (a || b) {
        this.hard = 0;
        return CHANGED;
      }
    }
    if (s.t - this.lastChange < c.dwellMs || this.locked || this.trial) return began;
    if (this.over >= c.degradeFrames && this.step(+1, s.t)) return CHANGED;
    if (this.under >= c.upgradeFrames && this.engaged.length && this.step(-1, s.t)) return CHANGED;
    return began;
  }

  /** The clock moved (a timer): settle when released and quiet, and run the recovery curve. */
  tick(t: number): Decision {
    const c = this.config;
    if (this.state === "interacting" && !this.held && t - this.lastActive >= c.quietMs) {
      this.state = "settling";
      this.settleStart = t;
      this.settleN = this.engaged.length;
      this.remembered = this.engaged.length;
    }
    if (this.state !== "settling") return NONE;
    const dt = t - this.settleStart;
    const n = this.settleN;
    if (c.tauMs <= 0 || dt >= 3 * c.tauMs || !this.engaged.length) return this.finish();
    // the count q(t) allows: ceil(n exp(-t/tau)); the most visible loss goes first
    const allowed = Math.ceil(n * Math.exp(-dt / c.tauMs) - 1e-9);
    let changed = false;
    while (this.engaged.length > allowed) {
      this.engaged.pop();
      changed = true;
    }
    if (!this.engaged.length) return this.finish();
    return changed ? CHANGED : NONE;
  }

  /** When the scene should call `tick` next (ms on the same clock), or undefined when nothing is due. */
  nextWakeAt(): number | undefined {
    const c = this.config;
    if (this.state === "interacting") return this.held ? undefined : this.lastActive + c.quietMs;
    if (this.state !== "settling") return undefined;
    const n = this.settleN;
    const times = restoreTimes(n, c.tauMs);
    const done = n - this.engaged.length;
    const next = times[Math.min(done, times.length - 1)];
    return this.settleStart + (next ?? 0);
  }

  /** Knobs found not to help this scene (released after their trial). */
  get skipped(): Knob[] {
    return [...this.ineffective];
  }

  /** Forget which knobs did not help (the scene changed enough to try them again). */
  forgetTrials(): void {
    this.ineffective.clear();
    this.trial = undefined;
  }

  /** Drop every knob at once (a capture, video mode, a suspend): full quality, idle. */
  reset(): Decision {
    const had = this.engaged.length > 0;
    this.engaged = [];
    this.state = "idle";
    this.endGesture();
    return had ? CHANGED : NONE;
  }

  /** New availability (the scene changed, the focus moved): knobs that can no longer help are released. */
  setAvailability(a: Availability): Decision {
    const prev = this.availability;
    if (prev.effects !== a.effects || prev.baseDpr !== a.baseDpr || prev.coarse !== a.coarse || prev.merge !== a.merge) this.ineffective.clear();
    this.availability = a;
    const keep = this.engaged.filter((k) => knobUseful(k, a, "unknown"));
    if (keep.length === this.engaged.length) return NONE;
    this.engaged = keep;
    return CHANGED;
  }

  // ---- internals ----

  private begin(t: number): Decision {
    if (this.state === "interacting") return NONE;
    const fromIdle = this.state === "idle";
    this.state = "interacting";
    this.lastActive = t;
    if (!fromIdle) return NONE; // a re-grab while settling keeps the current knobs
    this.endGesture();
    this.gestureStart = t;
    this.warmed = false;
    // a scene whose own full-quality frame is over budget starts one rung below what it needed last time
    if (this.config.enabled && this.lastFullMs > this.config.degradeAt * this.config.budgetMs && this.remembered > 1) {
      for (let i = 0; i < this.remembered - 1; i++) {
        const k = this.next(+1);
        if (!k) break;
        this.insert(k);
      }
      if (this.engaged.length) {
        this.lastChange = t;
        return CHANGED;
      }
    }
    return NONE;
  }

  private endGesture() {
    this.ema = 0;
    this.haveEma = false;
    this.over = this.under = this.hard = 0;
    this.lastDir = 0;
    this.flips = [];
    this.locked = false;
    this.lastChange = -Infinity;
    this.trial = undefined;
    this.recent = [];
  }

  private finish(): Decision {
    const had = this.engaged.length > 0;
    this.engaged = [];
    this.state = "idle";
    this.endGesture();
    return { changed: had, final: true };
  }

  /** The next knob to engage (+1), or the one to release (-1). */
  private next(dir: number): Knob | undefined {
    if (dir < 0) return this.engaged[this.engaged.length - 1];
    return LADDER.find((k) => !this.engaged.includes(k) && !this.ineffective.has(k) && knobUseful(k, this.availability, this.bottleneck));
  }

  private insert(k: Knob) {
    this.engaged.push(k);
    this.engaged.sort((a, b) => rungOf(a) - rungOf(b));
  }

  private engage(k: Knob, t: number, dir: number) {
    this.insert(k);
    this.changed(t, dir);
  }

  private step(dir: number, t: number, trial = true): boolean {
    const k = this.next(dir);
    if (!k) return false;
    if (dir > 0) this.insert(k);
    else this.engaged = this.engaged.filter((x) => x !== k);
    this.changed(t, dir);
    const before = this.recent.slice(-8);
    this.trial = dir > 0 && trial && this.config.trialFrames > 0 && before.length >= 3 ? { knob: k, before: median(before), n: 0, after: [], t } : undefined;
    return true;
  }

  private changed(t: number, dir: number) {
    const c = this.config;
    if (this.lastDir !== 0 && dir !== this.lastDir) {
      this.flips.push(t);
      this.flips = this.flips.filter((x) => t - x <= c.flipWindowMs);
      if (this.flips.length > c.flipLimit) this.locked = true;
    }
    this.lastDir = dir;
    this.lastChange = t;
    this.over = this.under = 0;
    this.skip = c.settleFrames;
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

const NONE: Decision = { changed: false, final: false };
const CHANGED: Decision = { changed: true, final: false };

/** A scripted input for `simulate` (tests, and the measurement notes). */
export type SimEvent =
  | { at: number; frame: Omit<FrameSample, "t"> }
  | { at: number; pointer: boolean }
  | { at: number; tick: true };

export interface SimStep {
  at: number;
  state: QualityState;
  knobs: Knob[];
  final: boolean;
}

/**
 * Run a controller over a script, calling `tick` whenever a wake time is due
 * between events (as the scene's timer does). Returns every change.
 */
export function simulate(controller: QualityController, events: SimEvent[], until?: number): SimStep[] {
  const out: SimStep[] = [];
  const record = (at: number, d: Decision) => {
    if (d.changed || d.final) out.push({ at, state: controller.state, knobs: controller.knobs, final: d.final });
  };
  const drain = (to: number) => {
    for (let guard = 0; guard < 1000; guard++) {
      const w = controller.nextWakeAt();
      if (w === undefined || w > to) return;
      record(w, controller.tick(w));
      if (controller.state === "idle") return;
    }
  };
  const sorted = [...events].sort((a, b) => a.at - b.at);
  for (const e of sorted) {
    drain(e.at);
    if ("frame" in e) record(e.at, controller.frame({ ...e.frame, t: e.at }));
    else if ("pointer" in e) record(e.at, controller.pointer(e.pointer, e.at));
    else record(e.at, controller.tick(e.at));
  }
  drain(until ?? (sorted.length ? sorted[sorted.length - 1].at + 5000 : 5000));
  return out;
}
