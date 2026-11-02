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
import { clampJoint, identity, multiply, poseAt, stepAt, tAfter, tBefore, translation, type Mat, type ResolvedJoint, type ResolvedSequence } from "./resolve";
import type { JointLimitFlag } from "./types";
import { planRadial, radialEase, sphereOf, underScope, type RadialMove, type RadialPart } from "../explode";

export type PlayMode = "assemble" | "explode";

/**
 * How the parts come apart (R2-B, 2026-11-02, Kevin's walkthrough H2): `radial`, every part at once along the
 * outward normal of its mounting face (the toolbar's Explode, DEFAULT when the model has a radial plan); `sequence`,
 * the assembly steps one after another (the toolbar's Assemble: today's step player, unchanged).
 */
export type ExplodeMode = "radial" | "sequence";

/** The radial explode of a loaded model (./apply.ts `resolveForCad`): each part's move at amount 1, world mm. */
export interface RadialPlan {
  moves: Map<string, RadialMove>;
  centre: [number, number, number];
  radius: number;
  /** CPU ms to read the facings and plan. */
  ms: number;
  /** What the plan was made from: a sub-assembly exploded on its own is planned again from its parts (R2-A's `explode.scope`). */
  parts?: RadialPart[];
  up?: [number, number, number];
  overrides?: ReadonlyMap<string, { direction?: [number, number, number]; distance?: number }>;
}

/** A resolved sequence with the radial plan beside it (CadView's; tests may build a player without one). */
export type ResolvedWithRadial = ResolvedSequence & { radial?: RadialPlan };

/** A change of mode while the parts are apart fades from where they are to the new mode's pose (DEFAULT, ms). */
export const MODE_BLEND_MS = 500;

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
  | { action: "clip"; clip?: MotionClip }
  /** R2-B: radial (all at once) or the steps; no mode: report the state. */
  | { action: "mode"; mode?: ExplodeMode; instant?: boolean }
  /** R2-B: only this sub-assembly comes apart (an instance path); no scope: the whole model. */
  | { action: "scope"; scope?: string; instant?: boolean };

export interface PlayerSnapshot {
  source: ResolvedSequence["source"];
  /** In assembly order; `window` is where the step comes apart in explode amount (t from start to end: in, then out). */
  /** `limits`: keyframe joint values the hard stops held in this step (PB-1185); absent when none. */
  steps: { id: string; title: string; kind: string; sequence: string; depth: number; members: number; links: string[]; still: boolean; window: [number, number]; limits?: JointLimitFlag[] }[];
  t: number;
  /** The step in progress (or just finished) at t. */
  step?: string;
  playing?: PlayMode;
  loop: boolean;
  isolate?: string;
  /**
   * `held`: the last value asked of the joint (a drive, a clip sample) went beyond a stop and is held there;
   * `limited`: its authored rest was beyond a stop (PB-1185).
   */
  joints: Record<string, { value: number; min?: number; max?: number; rest: number; type: string; held?: JointLimitFlag; limited?: JointLimitFlag }>;
  unknown: string[];
  clip?: { joints: string[]; samples: number; durationS: number };
  /** R2-B: radial (all at once) or the steps; and the radial plan's size (parts, distance at amount 1, mm). */
  explodeMode?: ExplodeMode;
  /** The sub-assembly that comes apart (R2-A's `explode.scope`); absent: the whole model. */
  scope?: string;
  radial?: { parts: number; distanceMm: number; ms: number; from: Record<string, number> };
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
  /** The last asked value a stop held, per joint (cleared when a value within the stops is asked). */
  private stopped: Record<string, JointLimitFlag> = {};
  private clip: { clip: MotionClip; time: number } | undefined;
  private extraJoints: ResolvedJoint[] = [];
  /** Playback speed multiplier. */
  speed = 1;
  private stepListeners = new Set<(step: string | null, t: number) => void>();
  private lastStep: string | null | undefined = undefined;
  /** The step a goto asked for, while t stays where the goto put it (a step boundary belongs to two windows). */
  private held: { step: string; t: number } | undefined;
  /** Radial or the steps (R2-B). */
  private explodeModeNow: ExplodeMode;
  /** A mode change under way: the pose it started from and when (`now()` ms). */
  private blend: { from: Map<string, Mat>; start: number } | undefined;
  /** The clock of the mode blend (tests set their own). */
  now: () => number = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  /** Only this sub-assembly comes apart (an instance path: R2-A's `explode.scope`, the part menu's "Explode this sub-assembly"). */
  private scopeNow: string | undefined;
  private scopedPlan: { scope: string; moves: Map<string, RadialMove> } | undefined;

  /** The sub-assembly that comes apart (undefined: the whole model). */
  get scope(): string | undefined {
    return this.scopeNow;
  }

  /**
   * Explode only the parts at or under `scope` (an instance path), each about the sub-assembly's own centre in the
   * radial mode; undefined: the whole model. While apart the change fades like a mode change.
   */
  setScope(scope: string | undefined, opts: { instant?: boolean } = {}): void {
    const next = scope || undefined;
    if (next === this.scopeNow) return;
    const from = this.t > 0 && !opts.instant ? this.pose() : undefined;
    this.scopeNow = next;
    this.blend = from ? { from, start: this.now() } : undefined;
  }

  /** The radial moves in force: the whole plan, or the sub-assembly's own (planned about its centre, cached). */
  private radialMoves(): Map<string, RadialMove> | undefined {
    const plan = this.resolved.radial;
    if (!plan) return undefined;
    const scope = this.scopeNow;
    if (!scope) return plan.moves;
    if (this.scopedPlan?.scope === scope) return this.scopedPlan.moves;
    const parts = (plan.parts ?? []).filter((p) => underScope(p.key, scope));
    const sphere = sphereOf(parts.filter((p) => !p.rides));
    const moves = parts.length && sphere ? planRadial(parts, { centre: sphere.centre, radius: sphere.radius, up: plan.up, overrides: plan.overrides }) : new Map([...plan.moves].filter(([k]) => underScope(k, scope)));
    this.scopedPlan = { scope, moves };
    return moves;
  }

  constructor(public resolved: ResolvedWithRadial) {
    this.explodeModeNow = resolved.radial ? "radial" : "sequence";
  }

  /** Radial (all at once) or the steps. Without a radial plan, always the steps. */
  get explodeMode(): ExplodeMode {
    return this.resolved.radial ? this.explodeModeNow : "sequence";
  }

  /**
   * Switch how the parts come apart. While they are apart (t > 0) the pose fades from where they are to the new
   * mode's over MODE_BLEND_MS (unless `instant`); assembled, nothing moves. Returns false for "radial" without a plan.
   */
  setMode(mode: ExplodeMode, opts: { instant?: boolean } = {}): boolean {
    if (mode === "radial" && !this.resolved.radial) return false;
    if (mode === this.explodeMode) return true;
    const from = this.t > 0 && !opts.instant ? this.pose() : undefined;
    this.explodeModeNow = mode;
    this.blend = from ? { from, start: this.now() } : undefined;
    return true;
  }

  /** The mode blend's progress (0..1), or undefined when none runs. */
  private blendK(): number | undefined {
    if (!this.blend) return undefined;
    const k = (this.now() - this.blend.start) / MODE_BLEND_MS;
    if (k >= 1) {
      this.blend = undefined;
      return undefined;
    }
    return Math.max(0, k);
  }

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
  /** A new resolved sequence (a rebuilt model): the explode amount, joint values and mode are kept. */
  replace(resolved: ResolvedWithRadial) {
    this.resolved = resolved;
    this.scopedPlan = undefined;
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
    // a hard stop held it: flagged (snapshot().joints[id].held), never an error
    if (v !== value) this.stopped[id] = { joint: id, asked: value, held: v, stop: v < value ? "max" : "min" };
    else delete this.stopped[id];
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
    // a mode change fading between poses keeps the view drawing
    if (this.blendK() !== undefined) moving = true;
    this.notifyStep();
    return moving;
  }

  pose(): Map<string, Mat> {
    const target = this.modePose();
    const k = this.blendK();
    if (k === undefined || !this.blend) return target;
    // fade from where the parts were to where the new mode puts them (a short fade; matrices mixed entry by entry)
    const e = radialEase(k);
    const out = new Map<string, Mat>();
    const keys = new Set([...this.blend.from.keys(), ...target.keys()]);
    for (const key of keys) {
      const a = this.blend.from.get(key) ?? identity();
      const b = target.get(key) ?? identity();
      const m = new Float64Array(16);
      for (let i = 0; i < 16; i++) m[i] = a[i] + (b[i] - a[i]) * e;
      out.set(key, m);
    }
    return out;
  }

  /** The pose of the mode in force: the steps at t, or every part out along its radial move by the eased t. */
  private modePose(): Map<string, Mat> {
    const resolved = this.extraJoints.length ? { ...this.resolved, joints: this.joints } : this.resolved;
    const moves = this.radialMoves();
    const scope = this.scopeNow;
    if (this.explodeMode !== "radial" || !moves) {
      const steps = poseAt(resolved, { t: this.t, joints: this.values, isolate: this.isolated });
      if (!scope) return steps;
      // a sub-assembly on its own: the steps move only its parts; the rest stay assembled (joint values hold)
      const base = poseAt(resolved, { t: 0, joints: this.values });
      const out = new Map(base);
      for (const [key, m] of steps) if (underScope(key, scope)) out.set(key, m);
      return out;
    }
    // radial: the assembled pose (joint values hold) with each part's move on top, all on one ease
    const base = poseAt(resolved, { t: 0, joints: this.values });
    const e = radialEase(this.t);
    if (e <= 0) return base;
    const out = new Map(base);
    for (const [key, m] of moves) {
      const d = m.distance * e;
      const tr = translation([m.dir[0] * d, m.dir[1] * d, m.dir[2] * d]);
      out.set(key, multiply(tr, base.get(key) ?? identity()));
    }
    return out;
  }

  /** Members of a step (to highlight or show alone). */
  membersOf(step: string): string[] {
    return this.resolved.steps.find((s) => s.id === step)?.members.map((m) => m.ref) ?? [];
  }

  snapshot(): PlayerSnapshot {
    const joints: PlayerSnapshot["joints"] = {};
    for (const j of this.joints) joints[j.id] = { value: this.values[j.id] ?? j.rest, min: j.min, max: j.max, rest: j.rest, type: j.type, ...(this.stopped[j.id] ? { held: this.stopped[j.id] } : {}), ...(j.limited ? { limited: j.limited } : {}) };
    return {
      source: this.resolved.source,
      steps: this.resolved.steps.map((s, i) => ({ id: s.id, title: s.title, kind: s.kind, sequence: s.sequence, depth: s.depth, members: s.members.length, links: s.links, still: s.still, window: [+this.resolved.windows[i][0].toFixed(6), +this.resolved.windows[i][1].toFixed(6)] as [number, number], ...(s.limits?.length ? { limits: s.limits } : {}) })),
      t: this.t,
      step: this.isolated ?? stepAt(this.resolved, this.t)?.id,
      playing: this.mode,
      loop: this.looping,
      isolate: this.isolated,
      joints,
      unknown: [...this.resolved.unknown],
      clip: this.clip ? { joints: this.clip.clip.joints, samples: this.clip.clip.samples.length, durationS: this.clip.clip.samples.at(-1)?.t ?? 0 } : undefined,
      explodeMode: this.explodeMode,
      ...(this.scopeNow ? { scope: this.scopeNow } : {}),
      ...(this.resolved.radial ? { radial: radialSummary(this.resolved.radial) } : {}),
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

  /**
   * Carry out a host or agent command; `error` says why it could not, `held` that a joint value asked beyond a
   * hard stop is held at the stop (PB-1185: clamped and flagged, not refused).
   */
  run(cmd: SequenceCommand): { ok: boolean; error?: string; held?: JointLimitFlag } {
    const r = this.runCommand(cmd);
    this.notifyStep();
    return r;
  }

  private runCommand(cmd: SequenceCommand): { ok: boolean; error?: string; held?: JointLimitFlag } {
    // the steps' own commands play the steps (R2-B): a goto, a play, a loop, an isolate, a step explode or assemble
    if (cmd.action === "goto" || cmd.action === "play" || cmd.action === "loop" || cmd.action === "isolate" || ((cmd.action === "explode" || cmd.action === "assemble") && cmd.step !== undefined)) this.setMode("sequence");
    if (cmd.action === "scope") {
      if (cmd.scope !== undefined && (typeof cmd.scope !== "string" || cmd.scope.length > 512)) return { ok: false, error: "scope must be an instance path" };
      this.setScope(cmd.scope, { instant: cmd.instant });
      return { ok: true };
    }
    if (cmd.action === "mode") {
      if (cmd.mode === undefined) return { ok: true };
      if (cmd.mode !== "radial" && cmd.mode !== "sequence") return { ok: false, error: 'explode mode must be "radial" or "sequence"' };
      return this.setMode(cmd.mode, { instant: cmd.instant }) ? { ok: true } : { ok: false, error: "no radial explode for this model (no parts to move)" };
    }
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
      case "joint": {
        if (this.driveJoint(cmd.id, cmd.value) === undefined) return { ok: false, error: `no joint "${cmd.id}" (joints: ${this.joints.map((j) => j.id).join(", ") || "none"})` };
        return this.stopped[cmd.id] ? { ok: true, held: this.stopped[cmd.id] } : { ok: true };
      }
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

/** A short account of a radial plan (snapshot, observe): parts, the distance at amount 1, and why each direction. */
export function radialSummary(plan: RadialPlan): NonNullable<PlayerSnapshot["radial"]> {
  const from: Record<string, number> = {};
  let distance = 0;
  for (const m of plan.moves.values()) {
    from[m.from] = (from[m.from] ?? 0) + 1;
    distance = Math.max(distance, m.distance);
  }
  return { parts: plan.moves.size, distanceMm: Math.round(distance * 10) / 10, ms: plan.ms, from };
}
