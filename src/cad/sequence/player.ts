/**
 * Playing a resolved assembly sequence (PB-1183): step through, isolate a
 * step, drive a joint, play assemble or explode, loop, and record and replay
 * joint values as a motion clip. No three.js: the view applies `pose()` to its
 * objects (./apply.ts) and calls `tick(dt)` from its frame loop while
 * `tick` returns true.
 *
 * Addressing (agents and people, one vocabulary):
 * - URL: `?step=<id>&play=assemble|explode[&loop=1][&levels=one][&t=0..1]`;
 * - `window.__cad.set({ sequence: <command> | true, step, t })` and host
 *   messages carry a `SequenceCommand`.
 * "Show how the lid goes on" is `{ action: "play", mode: "assemble", from: "fit:lid_mount", to: "fasten:lid_mount" }`.
 */
import { clampJoint, poseAt, stepAt, tAfter, tBefore, type Mat, type ResolvedJoint, type ResolvedSequence } from "./resolve";

export type PlayMode = "assemble" | "explode";

/** Joint values over time (recorded, then replayed through `poseAt`): 4 bytes per joint per sample, not a matrix per part. */
export interface MotionClip {
  schema: "protoboard.motion-clip/v0";
  joints: string[];
  /** Seconds from the start; joint values in `joints` order; optional explode amount. */
  samples: { t: number; v: number[]; x?: number }[];
  loop?: boolean;
}

export type SequenceCommand =
  /** Hold the state just before `step` is assembled (`where: "after"`: just after). */
  | { action: "goto"; step: string; where?: "before" | "after" }
  /** Explode or assemble everything (or up to `step`), animated unless `instant`. */
  | { action: "explode" | "assemble"; step?: string; instant?: boolean }
  /** Play from `from` (default the current state) to `to`. */
  | { action: "play"; mode?: PlayMode; from?: string; to?: string }
  | { action: "loop"; on?: boolean; mode?: PlayMode; from?: string; to?: string }
  | { action: "stop" }
  /** Only this step's members move (undefined clears). */
  | { action: "isolate"; step?: string }
  /** Drive a joint (clamped to its stops); `type` makes an ad-hoc joint on a mate (no limits). */
  | { action: "joint"; id: string; value: number }
  /** Jump to an explode amount. */
  | { action: "set"; t: number }
  /** Replay a motion clip (undefined stops it). */
  | { action: "clip"; clip?: MotionClip };

export interface PlayerSnapshot {
  source: ResolvedSequence["source"];
  /** In assembly order; `window` is where the step comes apart in explode amount (t from start to end: in, then out). */
  steps: { id: string; title: string; kind: string; sequence: string; depth: number; members: number; links: string[]; still: boolean; window: [number, number] }[];
  t: number;
  /** The step in progress (or just finished) at t. */
  step?: string;
  playing?: PlayMode;
  loop: boolean;
  isolate?: string;
  joints: Record<string, { value: number; min?: number; max?: number; rest: number; type: string }>;
  unknown: string[];
  clip?: { joints: string[]; samples: number; durationS: number };
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export class SequencePlayer {
  t = 0;
  private target = 0;
  private mode: PlayMode | undefined;
  private looping = false;
  private range: [number, number] = [0, 1];
  private isolated: string | undefined;
  private values: Record<string, number> = {};
  private clip: { clip: MotionClip; time: number } | undefined;
  private extraJoints: ResolvedJoint[] = [];
  /** Playback speed multiplier. */
  speed = 1;
  private stepListeners = new Set<(step: string | null, t: number) => void>();
  private lastStep: string | null | undefined = undefined;
  /** The step a goto asked for, while t stays where the goto put it (a step boundary belongs to two windows). */
  private held: { step: string; t: number } | undefined;

  constructor(public resolved: ResolvedSequence) {}

  /** Seconds for t to go from 0 to 1 at speed 1 (the steps' durations). */
  get durationS(): number {
    return Math.max(0.1, this.resolved.steps.reduce((s, x) => s + (x.still ? 0 : x.durationS), 0));
  }
  get joints(): ResolvedJoint[] {
    return [...this.resolved.joints, ...this.extraJoints.filter((j) => !this.resolved.joints.some((r) => r.id === j.id))];
  }
  /** Add an ad-hoc joint (from `jointOnMate`), kept when the sequence is swapped. */
  addJoint(j: ResolvedJoint) {
    this.extraJoints = [...this.extraJoints.filter((x) => x.id !== j.id), j];
  }
  /** A new resolved sequence (a rebuilt model): the explode amount and joint values are kept. */
  replace(resolved: ResolvedSequence) {
    this.resolved = resolved;
  }

  set(s: { t?: number; step?: string; where?: "before" | "after"; isolate?: string | null; joints?: Record<string, number> }): boolean {
    let ok = true;
    if (s.isolate !== undefined) this.isolated = s.isolate ?? undefined;
    if (s.step !== undefined) ok = this.goto(s.step, s.where);
    if (s.t !== undefined) {
      this.t = this.target = clamp01(s.t);
      this.mode = undefined;
    }
    for (const [id, v] of Object.entries(s.joints ?? {})) this.driveJoint(id, v);
    this.notifyStep();
    return ok;
  }

  goto(step: string, where: "before" | "after" = "before"): boolean {
    const t = where === "before" ? tBefore(this.resolved, step) : tAfter(this.resolved, step);
    if (t === undefined) return false;
    this.t = this.target = t;
    this.mode = undefined;
    this.looping = false;
    this.held = { step, t };
    this.notifyStep();
    return true;
  }

  /** Animate toward assembled (t falls) or exploded (t rises), between `from` and `to` steps when given. */
  play(mode: PlayMode, opts: { from?: string; to?: string } = {}): boolean {
    const end = (id: string | undefined, m: PlayMode) => (id === undefined ? (m === "assemble" ? 0 : 1) : m === "assemble" ? tAfter(this.resolved, id) : tBefore(this.resolved, id));
    const start = (id: string | undefined, m: PlayMode) => (id === undefined ? undefined : m === "assemble" ? tBefore(this.resolved, id) : tAfter(this.resolved, id));
    const to = end(opts.to ?? (mode === "assemble" ? undefined : undefined), mode);
    if (to === undefined) return false;
    if (opts.from !== undefined) {
      const s = start(opts.from, mode);
      if (s === undefined) return false;
      this.t = s;
    } else if (opts.to !== undefined && ((mode === "assemble" && this.t < to) || (mode === "explode" && this.t > to))) {
      // asked to play to a step it is already past: start from that step's other side
      const s = start(opts.to, mode);
      if (s !== undefined) this.t = s;
    }
    this.target = to;
    this.mode = mode;
    this.range = [Math.min(this.t, to), Math.max(this.t, to)];
    return true;
  }

  loop(on = true, mode: PlayMode = "explode", opts: { from?: string; to?: string } = {}): boolean {
    this.looping = on;
    if (!on) return true;
    const ok = this.play(mode, opts);
    if (!opts.from && !opts.to) this.range = [0, 1];
    return ok;
  }

  stop() {
    this.mode = undefined;
    this.looping = false;
    this.target = this.t;
    this.clip = undefined;
  }

  isolate(step: string | undefined): boolean {
    if (step !== undefined && !this.resolved.steps.some((s) => s.id === step)) return false;
    this.isolated = step;
    return true;
  }

  /** Set a joint value; returns the value held after its hard stops (undefined for an unknown joint). */
  driveJoint(id: string, value: number): number | undefined {
    const j = this.joints.find((x) => x.id === id);
    if (!j) return undefined;
    const v = clampJoint(j, value);
    this.values[id] = v;
    return v;
  }

  playClip(clip: MotionClip | undefined) {
    this.clip = clip ? { clip, time: 0 } : undefined;
  }

  get playing(): PlayMode | undefined {
    return this.mode;
  }

  /** Advance by dt seconds; true while anything is still moving (the view keeps drawing). */
  tick(dt: number): boolean {
    let moving = false;
    if (this.clip) {
      const c = this.clip;
      c.time += dt * this.speed;
      const s = sampleClip(c.clip, c.time);
      for (const [id, v] of Object.entries(s.joints)) this.driveJoint(id, v);
      if (s.x !== undefined) this.t = this.target = clamp01(s.x);
      if (s.done) this.clip = undefined;
      else moving = true;
    }
    if (this.mode) {
      const step = (dt * this.speed) / this.durationS;
      if (this.mode === "explode") this.t = Math.min(this.target, this.t + step);
      else this.t = Math.max(this.target, this.t - step);
      moving = true;
      if (this.t === this.target) {
        if (this.looping) {
          // ping-pong over the range
          this.mode = this.mode === "explode" ? "assemble" : "explode";
          this.target = this.mode === "explode" ? this.range[1] : this.range[0];
        } else this.mode = undefined;
      }
    }
    this.notifyStep();
    return moving;
  }

  pose(): Map<string, Mat> {
    const resolved = this.extraJoints.length ? { ...this.resolved, joints: this.joints } : this.resolved;
    return poseAt(resolved, { t: this.t, joints: this.values, isolate: this.isolated });
  }

  /** Members of a step (to highlight or show alone). */
  membersOf(step: string): string[] {
    return this.resolved.steps.find((s) => s.id === step)?.members.map((m) => m.ref) ?? [];
  }

  snapshot(): PlayerSnapshot {
    const joints: PlayerSnapshot["joints"] = {};
    for (const j of this.joints) joints[j.id] = { value: this.values[j.id] ?? j.rest, min: j.min, max: j.max, rest: j.rest, type: j.type };
    return {
      source: this.resolved.source,
      steps: this.resolved.steps.map((s, i) => ({ id: s.id, title: s.title, kind: s.kind, sequence: s.sequence, depth: s.depth, members: s.members.length, links: s.links, still: s.still, window: [+this.resolved.windows[i][0].toFixed(6), +this.resolved.windows[i][1].toFixed(6)] as [number, number] })),
      t: this.t,
      step: this.isolated ?? stepAt(this.resolved, this.t)?.id,
      playing: this.mode,
      loop: this.looping,
      isolate: this.isolated,
      joints,
      unknown: [...this.resolved.unknown],
      clip: this.clip ? { joints: this.clip.clip.joints, samples: this.clip.clip.samples.length, durationS: this.clip.clip.samples.at(-1)?.t ?? 0 } : undefined,
    };
  }

  /**
   * The step id the view state's `explode.step` holds (the gate's one type: a string step id, or null): the
   * isolated step, else the step in progress (or just finished) at t.
   */
  currentStep(): string | null {
    if (this.isolated) return this.isolated;
    if (this.held && this.held.t === this.t) return this.held.step;
    return stepAt(this.resolved, this.t)?.id ?? null;
  }

  /**
   * Called when `currentStep()` changes (after goto, set, isolate, a play's ticks, any command), so the view can
   * write the step back into the view state (`{ op: "explode", t, step }`; the gate's item, wired by CadView's
   * owner). Returns the unsubscribe function.
   */
  onStepChange(cb: (step: string | null, t: number) => void): () => void {
    this.stepListeners.add(cb);
    return () => void this.stepListeners.delete(cb);
  }

  private notifyStep() {
    const s = this.currentStep();
    if (s === this.lastStep) return;
    this.lastStep = s;
    for (const cb of this.stepListeners) {
      try {
        cb(s, this.t);
      } catch (e) {
        console.error("sequence step listener", e);
      }
    }
  }

  /** Carry out a host or agent command; `error` says why it could not. */
  run(cmd: SequenceCommand): { ok: boolean; error?: string } {
    const r = this.runCommand(cmd);
    this.notifyStep();
    return r;
  }

  private runCommand(cmd: SequenceCommand): { ok: boolean; error?: string } {
    const unknownStep = (id: string) => ({ ok: false, error: `no step "${id}" (steps: ${this.resolved.steps.slice(0, 8).map((s) => s.id).join(", ")}${this.resolved.steps.length > 8 ? ", …" : ""})` });
    switch (cmd.action) {
      case "goto":
        return this.goto(cmd.step, cmd.where) ? { ok: true } : unknownStep(cmd.step);
      case "explode":
      case "assemble": {
        if (cmd.instant) {
          const t = cmd.step === undefined ? (cmd.action === "explode" ? 1 : 0) : cmd.action === "explode" ? tBefore(this.resolved, cmd.step) : tAfter(this.resolved, cmd.step);
          if (t === undefined) return unknownStep(cmd.step!);
          this.set({ t });
          return { ok: true };
        }
        return this.play(cmd.action, { to: cmd.step }) ? { ok: true } : unknownStep(cmd.step!);
      }
      case "play":
        return this.play(cmd.mode ?? "assemble", { from: cmd.from, to: cmd.to }) ? { ok: true } : unknownStep(cmd.from ?? cmd.to ?? "");
      case "loop":
        return this.loop(cmd.on ?? true, cmd.mode, { from: cmd.from, to: cmd.to }) ? { ok: true } : unknownStep(cmd.from ?? cmd.to ?? "");
      case "stop":
        this.stop();
        return { ok: true };
      case "isolate":
        return this.isolate(cmd.step) ? { ok: true } : unknownStep(cmd.step ?? "");
      case "joint":
        return this.driveJoint(cmd.id, cmd.value) === undefined ? { ok: false, error: `no joint "${cmd.id}" (joints: ${this.joints.map((j) => j.id).join(", ") || "none"})` } : { ok: true };
      case "set":
        this.set({ t: cmd.t });
        return { ok: true };
      case "clip":
        this.playClip(cmd.clip);
        return { ok: true };
    }
    return { ok: false, error: "unknown sequence command" };
  }
}

/** Joint values (and explode amount) at `time` seconds of a clip, interpolated; looped clips wrap. */
export function sampleClip(clip: MotionClip, time: number): { joints: Record<string, number>; x?: number; done: boolean } {
  const s = clip.samples;
  const joints: Record<string, number> = {};
  if (!s.length) return { joints, done: true };
  const end = s[s.length - 1].t;
  let at = time;
  let done = false;
  if (clip.loop && end > 0) at = ((time % end) + end) % end;
  else if (time >= end) {
    at = end;
    done = true;
  }
  let i = 0;
  while (i < s.length - 2 && s[i + 1].t <= at) i++;
  const a = s[i];
  const b = s[Math.min(i + 1, s.length - 1)];
  const k = b.t > a.t ? Math.min(1, Math.max(0, (at - a.t) / (b.t - a.t))) : 0;
  clip.joints.forEach((id, j) => (joints[id] = a.v[j] + (b.v[j] - a.v[j]) * k));
  const x = a.x !== undefined && b.x !== undefined ? a.x + (b.x - a.x) * k : a.x;
  return { joints, x, done };
}

/** Records joint values (not matrices) as a clip. */
export class ClipRecorder {
  private samples: MotionClip["samples"] = [];
  constructor(private readonly jointIds: string[]) {}
  sample(time: number, values: Readonly<Record<string, number>>, x?: number) {
    this.samples.push({ t: time, v: this.jointIds.map((id) => values[id] ?? 0), ...(x !== undefined ? { x } : {}) });
  }
  finish(loop = false): MotionClip {
    const t0 = this.samples[0]?.t ?? 0;
    return { schema: "protoboard.motion-clip/v0", joints: [...this.jointIds], samples: this.samples.map((s) => ({ ...s, t: s.t - t0 })), ...(loop ? { loop } : {}) };
  }
}

/** The URL's sequence request: `?step=<id>&play=assemble|explode&loop=1&levels=one&t=0.5`. */
export function sequenceUrlState(search: string): { step?: string; play?: PlayMode; loop: boolean; levels: "all" | "one"; t?: number } {
  const q = new URLSearchParams(search);
  const play = q.get("play");
  const t = q.get("t");
  return {
    step: q.get("step") ?? undefined,
    play: play === "assemble" || play === "explode" ? play : undefined,
    loop: q.get("loop") === "1" || q.get("loop") === "true",
    levels: q.get("levels") === "one" ? "one" : "all",
    t: t !== null && Number.isFinite(Number(t)) ? clamp01(Number(t)) : undefined,
  };
}

/**
 * Put a player in the state the URL asks for: `step` alone holds the state
 * before it is assembled; with `play=assemble` that step goes on, with
 * `play=explode` it comes off; `play` alone runs the whole sequence; `loop`
 * repeats.
 */
export function applyUrlState(player: SequencePlayer, url: ReturnType<typeof sequenceUrlState>): { ok: boolean; error?: string } {
  if (url.t !== undefined) player.set({ t: url.t });
  if (url.step !== undefined) {
    if (!url.play) return player.run({ action: "goto", step: url.step });
    const r = url.play === "assemble" ? player.run({ action: url.loop ? "loop" : "play", mode: "assemble", from: url.step, to: url.step }) : player.run({ action: url.loop ? "loop" : "play", mode: "explode", from: url.step, to: url.step });
    return r;
  }
  if (url.play) {
    player.set({ t: url.play === "assemble" ? 1 : 0 });
    return player.run(url.loop ? { action: "loop", mode: url.play } : { action: url.play });
  }
  return { ok: true };
}
