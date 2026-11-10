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
import { clampJoint, easeStep, identity, multiply, poseAt, stepAt, stepOut, tAfter, tBefore, translation, windowsOf, type Mat, type ResolvedJoint, type ResolvedSequence, type ResolvedStep } from "./resolve";
import type { JointLimitFlag } from "./types";
import { planRadial, radialEase, sphereOf, underScope, type RadialMove, type RadialPart } from "../explode";

export type PlayMode = "assemble" | "explode";

/**
 * Where a play goes (R5-A, 2026-11-02, Kevin: "You should be able to select direction of assembly"): `together`, the
 * parts come together (Assemble: in step order; Explode: collapse, all at once); `apart`, they go out along their
 * paths (Assemble: disassemble, the reverse step order; Explode: explode).
 */
export type MotionDirection = "together" | "apart";

/** The speeds the timeline offers (R5-A DEFAULT; 1x is the R4 timing: 1.4 s for an explode, 1.2 s per step). */
export const SPEEDS = [0.25, 0.5, 1, 2, 4] as const;
/** Seconds an explode (or a collapse) takes at 1x: the toolbar's ease before R5 (CadView's `dt / 1.4`). */
export const EXPLODE_TRAVEL_S = 1.4;
/** The slowest and fastest speed the player takes (an agent's `speed` is held between them). */
export const SPEED_MIN = 0.05;
export const SPEED_MAX = 16;

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
  /**
   * Wave R3 gate (additive): a board drawn as an assembly is in the plan (../assembly/plan.ts `withBoard`): its
   * components leave along the board's normal, not radially; `holder` is the board's body key (it stays put).
   */
  board?: { holder: string; components: number };
}

/** A resolved sequence with the radial plan beside it (CadView's; tests may build a player without one). */
export type ResolvedWithRadial = ResolvedSequence & {
  radial?: RadialPlan;
  /** R5-A: the sequence's base parts (./apply.ts): with a radial plan they move too, in a first step of their own. */
  baseParts?: string[];
};

/** A change of scope while the parts are apart fades from where they are to the new pose (DEFAULT, ms). R5-A: a change of mode no longer fades: the parts stay where they are, paused. */
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
  /** `keep` (R3-B's handoff, applied by R3-A): play in the explode mode in force (radial stays radial); without it, the steps. */
  | { action: "play"; mode?: PlayMode; from?: string; to?: string; keep?: boolean }
  | { action: "loop"; on?: boolean; mode?: PlayMode; from?: string; to?: string; keep?: boolean }
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
  | { action: "scope"; scope?: string; instant?: boolean }
  /**
   * R5-A: the toolbar's two independent toggles (either or both). A toggle turned on from rest plays once; turned on
   * or off while the parts move (or are paused mid-way) it only switches and the pose waits, paused. Both off: home.
   */
  | { action: "toggle"; explode?: boolean; assemble?: boolean }
  /** R5-A: the timeline's Play: from where the parts are, toward the direction's end, in the mode in force. */
  | { action: "resume" }
  /** R5-A: hold the parts where they are (flags, direction and speed kept). */
  | { action: "pause" }
  /** R5-A: playback speed (1 = 1.4 s an explode, 1.2 s a step); held to SPEED_MIN..SPEED_MAX. */
  | { action: "speed"; x: number }
  /** R5-A: where plays go; switching while moving pauses where the parts are. */
  | { action: "direction"; to: MotionDirection };

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
  radial?: { parts: number; distanceMm: number; ms: number; from: Record<string, number>; board?: { components: number } };
  /**
   * R5-A: the toggles, where plays go, the speed, whether the pose is one kept across a switch (`anchored`: Play goes
   * on from it), and the seconds a whole play takes at this speed.
   */
  motion: { explode: boolean; assemble: boolean; direction: MotionDirection; speed: number; anchored: boolean; playing: boolean; durationS: number };
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const EPS = 1e-9;

/** One part's explode path (world mm): every mode moves the part along it, by a share 0..1 of its distance. */
export interface MotionPath {
  dir: [number, number, number];
  distance: number;
}

/**
 * R5-A (Kevin, 2026-11-02: "Make the assembly use the same explode as the explode. Then the difference is that it
 * assembles in order"): with a radial plan, every part the plan moves belongs to one step. The sequence's base goes in
 * a first step (it is placed first, so it comes off last); any other part no step names goes in a final step (DEFAULT:
 * last on, first off). Without a plan, or with every part in a step, the resolution is returned unchanged.
 */
export function withMotionGroups(resolved: ResolvedWithRadial): ResolvedWithRadial {
  const plan = resolved.radial;
  if (!plan) return resolved;
  const named = new Set<string>();
  for (const s of resolved.steps) for (const m of s.members) named.add(m.ref);
  const base = new Set(resolved.baseParts ?? []);
  const first: string[] = [];
  const last: string[] = [];
  for (const [key, m] of plan.moves) {
    if (named.has(key) || !(m.distance > 0)) continue;
    (base.has(key) ? first : last).push(key);
  }
  if (!first.length && !last.length) return resolved;
  const sequence = resolved.steps[0]?.sequence ?? "main";
  const group = (id: string, title: string, keys: string[]): ResolvedStep => ({
    id,
    title,
    kind: "place",
    sequence,
    depth: 0,
    members: keys.map((ref) => {
      const m = plan.moves.get(ref)!;
      return { ref, dir: m.dir, distance: m.distance, pivot: [0, 0, 0], turns: 0, pitchMm: 0, delay: 0 };
    }),
    durationS: resolved.defaults.durationS,
    ease: "cubic",
    links: [],
    still: false,
    planned: false,
  });
  const steps = [...(first.length ? [group("place:base", first.length === 1 ? `Place the ${first[0].split("/").pop()}` : "Place the base", first)] : []), ...resolved.steps, ...(last.length ? [group("fit:rest", "Fit the remaining parts", last)] : [])];
  return { ...resolved, steps, windows: windowsOf(steps) };
}

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
  /** Playback speed multiplier (R5-A: the timeline's speed; `setSpeed` holds it to SPEED_MIN..SPEED_MAX). */
  speed = 1;
  private stepListeners = new Set<(step: string | null, t: number) => void>();
  private lastStep: string | null | undefined = undefined;
  /** The step a goto asked for, while t stays where the goto put it (a step boundary belongs to two windows). */
  private held: { step: string; t: number } | undefined;
  /** Radial or the steps (R2-B). */
  private explodeModeNow: ExplodeMode;
  /** A scope change under way: the pose it started from and when (`now()` ms). */
  private blend: { from: Map<string, Mat>; start: number } | undefined;
  /** The clock of the scope fade (tests set their own). */
  now: () => number = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  /** Only this sub-assembly comes apart (an instance path: R2-A's `explode.scope`, the part menu's "Explode this sub-assembly"). */
  private scopeNow: string | undefined;
  private scopedPlan: { scope: string; moves: Map<string, RadialMove> } | undefined;
  /** R5-A: the toolbar's two toggles (independent). */
  private explodeOnNow = false;
  private assembleOnNow = false;
  /** R5-A: where plays go. */
  private dir: MotionDirection = "apart";
  /**
   * R5-A: a pose kept across a switch of mode or direction (each part's share of its path, `from`), and the play that
   * goes on from it toward `side`'s end: `a` runs 0..1 over a whole play of the mode in force; each part goes from
   * where it was to its end on the mode's schedule (step order, or all at once); `t` moves from `t0` to the end.
   */
  private anchor: { from: Map<string, number>; side: MotionDirection; a: number; t0: number } | undefined;
  private anchorPlaying = false;
  /** Caches keyed by the resolution they were made from. */
  private cache: { of: ResolvedSequence; schedule: Map<string, { i: number; delay: number; maxDelay: number }>; jointsOnly: ResolvedSequence } | undefined;

  /** The sub-assembly that comes apart (undefined: the whole model). */
  get scope(): string | undefined {
    return this.scopeNow;
  }

  /**
   * Explode only the parts at or under `scope` (an instance path), each about the sub-assembly's own centre in the
   * radial mode; undefined: the whole model. While apart the change fades.
   */
  setScope(scope: string | undefined, opts: { instant?: boolean } = {}): void {
    const next = scope || undefined;
    if (next === this.scopeNow) return;
    const from = this.t > 0 && !opts.instant ? this.pose() : undefined;
    this.scopeNow = next;
    this.anchor = undefined;
    this.anchorPlaying = false;
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

  /**
   * R5-A: every moving part's one explode path, the same in both modes: the radial plan's move (the R2-E radial rule,
   * or the assembly script's `explode {direction, distance}` override); a step member the plan lacks keeps its step's
   * own path. Undefined without a radial plan (a bare resolution: today's step offsets).
   */
  paths(): Map<string, MotionPath> | undefined {
    const moves = this.radialMoves();
    if (!moves) return undefined;
    const out = new Map<string, MotionPath>();
    for (const [k, m] of moves) out.set(k, { dir: m.dir, distance: m.distance });
    const scope = this.scopeNow;
    for (const s of this.resolved.steps) for (const m of s.members) if (!out.has(m.ref) && (!scope || underScope(m.ref, scope)) && m.distance > 0) out.set(m.ref, { dir: m.dir, distance: m.distance });
    return out;
  }

  constructor(public resolved: ResolvedWithRadial) {
    this.resolved = withMotionGroups(resolved);
    this.explodeModeNow = resolved.radial ? "radial" : "sequence";
  }

  /** Radial (all at once) or the steps. Without a radial plan, always the steps. */
  get explodeMode(): ExplodeMode {
    return this.resolved.radial ? this.explodeModeNow : "sequence";
  }

  /**
   * Switch how the parts come apart (an agent's `mode`, the view state's `explode.mode`). R5-A: the assemble toggle
   * follows (`sequence` is Assemble on). While the parts move, or are apart, they stay where they are and wait, paused
   * (Kevin: "If you switch mid animation, the assembly does not autostart; you have to click play to continue");
   * `instant` jumps to the new mode's pose at the same t. Returns false for "radial" without a plan.
   */
  setMode(mode: ExplodeMode, opts: { instant?: boolean } = {}): boolean {
    if (mode === "radial" && !this.resolved.radial) return false;
    this.assembleOnNow = mode === "sequence";
    this.switchMode(mode, opts);
    return true;
  }

  /** The mode switch itself (the toggles call it without touching their flags). */
  private switchMode(mode: ExplodeMode, opts: { instant?: boolean } = {}): void {
    if (mode === this.explodeMode) return;
    const paths = opts.instant ? undefined : this.paths();
    const from = paths ? this.progressNow(paths) : undefined;
    this.halt();
    this.explodeModeNow = mode;
    this.anchor = undefined;
    if (from) this.anchorAt(from, this.dir);
  }

  /** Stop any play (a clip keeps running): the parts stay where they are. */
  private halt(): void {
    this.mode = undefined;
    this.looping = false;
    this.target = this.t;
    this.anchorPlaying = false;
  }

  /** Keep the pose `from` (each part's share of its path) for a play toward `side`; at an end no anchor is needed. */
  private anchorAt(from: Map<string, number>, side: MotionDirection): void {
    const vals = [...from.values()];
    if (vals.every((v) => v <= EPS)) {
      this.anchor = undefined;
      this.t = this.target = 0;
      return;
    }
    if (vals.every((v) => v >= 1 - EPS)) {
      this.anchor = undefined;
      this.t = this.target = 1;
      return;
    }
    this.anchor = { from, side, a: 0, t0: this.t };
  }

  /** Seconds for t to go from 0 to 1 at speed 1 (the steps' durations). */
  get durationS(): number {
    return Math.max(0.1, this.resolved.steps.reduce((s, x) => s + (x.still ? 0 : x.durationS), 0));
  }
  /** R5-A: seconds a whole play takes at speed 1 in the mode in force (an explode 1.4 s; the steps their durations). */
  playDurationS(): number {
    return this.explodeMode === "radial" ? EXPLODE_TRAVEL_S : this.durationS;
  }
  get joints(): ResolvedJoint[] {
    return [...this.resolved.joints, ...this.extraJoints.filter((j) => !this.resolved.joints.some((r) => r.id === j.id))];
  }
  /** Add an ad-hoc joint (from `jointOnMate`), kept when the sequence is swapped. */
  addJoint(j: ResolvedJoint) {
    this.extraJoints = [...this.extraJoints.filter((x) => x.id !== j.id), j];
  }
  /** A new resolved sequence (a rebuilt model): the explode amount, joint values, mode, toggles, speed and direction are kept. */
  replace(resolved: ResolvedWithRadial) {
    this.resolved = withMotionGroups(resolved);
    this.scopedPlan = undefined;
    this.anchor = undefined;
    this.anchorPlaying = false;
  }

  set(s: { t?: number; step?: string; where?: "before" | "after"; isolate?: string | null; joints?: Record<string, number> }): boolean {
    let ok = true;
    if (s.isolate !== undefined) this.isolated = s.isolate ?? undefined;
    if (s.step !== undefined) ok = this.goto(s.step, s.where);
    if (s.t !== undefined) {
      // a jump (a scrub, the view easing to an amount): no kept pose, no play
      this.anchor = undefined;
      this.anchorPlaying = false;
      this.t = this.target = clamp01(s.t);
      this.mode = undefined;
      // R5-A: apart with both toggles off (an agent's `explode t`, a URL): the mode in force is turned on
      if (this.t > 0 && !this.explodeOnNow && !this.assembleOnNow) {
        if (this.explodeMode === "radial") this.explodeOnNow = true;
        else this.assembleOnNow = true;
      }
    }
    for (const [id, v] of Object.entries(s.joints ?? {})) this.driveJoint(id, v);
    this.notifyStep();
    return ok;
  }

  goto(step: string, where: "before" | "after" = "before"): boolean {
    const t = where === "before" ? tBefore(this.resolved, step) : tAfter(this.resolved, step);
    if (t === undefined) return false;
    this.anchor = undefined;
    this.anchorPlaying = false;
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
    const to = end(opts.to, mode);
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
    // a step play (an agent's, a URL's) starts from the mode's own pose at t: no kept pose
    this.anchor = undefined;
    this.anchorPlaying = false;
    this.dir = mode === "assemble" ? "together" : "apart";
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
    this.halt();
    this.clip = undefined;
  }

  // ---- R5-A: the toggles, direction, speed and the timeline's Play ---------------------------------------------------

  /** Explode on (all parts at once) and Assemble on (in step order), independent. */
  get explodeOn(): boolean {
    return this.explodeOnNow;
  }
  get assembleOn(): boolean {
    return this.assembleOnNow;
  }
  get direction(): MotionDirection {
    return this.dir;
  }
  /** A pose kept across a switch: Play goes on from it. */
  get anchored(): boolean {
    return Boolean(this.anchor);
  }

  /** Nothing moves and the parts are all together or all out (a toggle turned on from here plays once). */
  private atRest(): boolean {
    return !this.moving() && !this.anchor && (this.t <= EPS || this.t >= 1 - EPS);
  }
  private moving(): boolean {
    return Boolean(this.mode) || this.anchorPlaying;
  }
  /** Every part is home (nothing out along its path). */
  private allTogether(): boolean {
    const paths = this.paths();
    if (!paths) return this.t <= EPS;
    for (const v of this.progressNow(paths).values()) if (v > EPS) return false;
    return true;
  }

  /**
   * The toolbar's Explode (R5-A). On: alone, the parts go out all at once (from rest it plays once; while moving or
   * paused mid-way, the switch keeps the pose, paused); with Assemble on, nothing moves: Assemble drives the step
   * order and Explode is its fully-out pose (one path per part, so the two are the same pose). Off: with Assemble on,
   * nothing moves; with both off, the parts go home together (a collapse, all at once).
   */
  setExplode(on: boolean): void {
    if (on === this.explodeOnNow) return;
    const rest = this.atRest();
    this.explodeOnNow = on;
    if (this.assembleOnNow) return;
    if (!on) return this.goHome();
    if (this.resolved.radial) this.switchMode("radial");
    this.setDirection("apart");
    if (rest && this.t < 1 - EPS) this.resume();
  }

  /**
   * The toolbar's Assemble (R5-A). On: the steps drive; the direction is `together` (the parts come together in step
   * order) unless every part is already home, then `apart` (taken apart in the reverse order: R3's Assemble from
   * assembled). From rest it plays once; while moving or paused mid-way it keeps the pose, paused. Off: with Explode
   * on, the mode goes back to all at once, the pose kept and paused; with both off, the parts go home together.
   */
  setAssemble(on: boolean): void {
    if (on === this.assembleOnNow) return;
    const rest = this.atRest();
    this.assembleOnNow = on;
    if (on) {
      const d: MotionDirection = this.allTogether() ? "apart" : "together";
      if (d !== this.dir) this.setDirection(d);
      this.switchMode("sequence");
      if (rest) this.resume();
      return;
    }
    if (this.explodeOnNow) {
      if (this.resolved.radial) this.switchMode("radial");
      return;
    }
    this.goHome();
  }

  /** Both toggles off: from where the parts are, all at once (radial when there is a plan) back together. */
  private goHome(): void {
    if (this.resolved.radial) this.switchMode("radial");
    if (this.dir !== "together") this.setDirection("together");
    if (this.anchor || this.t > EPS) this.resume();
  }

  /**
   * Where plays go. A change while moving pauses where the parts are (no autostart); Play then goes the new way: in
   * the same mode t simply runs back (the steps in the reverse order); from a kept pose, from that pose.
   */
  setDirection(d: MotionDirection): void {
    if (d === this.dir) return;
    this.halt();
    this.dir = d;
    const paths = this.anchor ? this.paths() : undefined;
    if (paths) this.anchorAt(this.progressNow(paths), d);
  }

  /** Playback speed, held to SPEED_MIN..SPEED_MAX (a running play goes on at the new speed). */
  setSpeed(x: number): number {
    if (typeof x === "number" && Number.isFinite(x)) this.speed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, x));
    return this.speed;
  }

  /**
   * The timeline's Play (R5-A): from where the parts are toward the direction's end, in the mode in force. From a kept
   * pose (a switch mid-way) each part goes on from where it is; already at that end, Play turns round: the direction
   * flips and the parts play back (wave R5 gate DEFAULT; it replayed from the other end, a jump, before).
   */
  resume(): boolean {
    this.clip = undefined;
    this.held = undefined;
    const T = this.dir === "together" ? 0 : 1;
    if (this.anchor) {
      if (this.anchor.side !== this.dir) {
        const paths = this.paths();
        if (paths) this.anchorAt(this.progressNow(paths), this.dir);
      }
      if (this.anchor) {
        this.mode = undefined;
        this.anchorPlaying = true;
        return true;
      }
    }
    // R5 gate: already at that end, Play turns round and plays back (the direction flips): it used to jump to the
    // other end and replay, so the parts snapped (assembled, Play: everything leapt out at once). DEFAULT.
    let to = T;
    if (Math.abs(this.t - T) <= EPS) {
      this.dir = this.dir === "together" ? "apart" : "together";
      to = 1 - T;
    }
    this.target = to;
    this.mode = to > this.t ? "explode" : "assemble";
    this.range = [Math.min(this.t, to), Math.max(this.t, to)];
    return true;
  }

  /** Hold the parts where they are. */
  pause(): void {
    this.halt();
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

  /** The play under way (`assemble`: t falls, the parts come together; `explode`: t rises), or undefined. */
  get playing(): PlayMode | undefined {
    if (this.anchorPlaying && this.anchor) return this.anchor.side === "together" ? "assemble" : "explode";
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
    const anchor = this.anchor;
    if (anchor && this.anchorPlaying) {
      // from a kept pose: every part from where it was to its end on the mode's schedule
      anchor.a = Math.min(1, anchor.a + (dt * this.speed) / this.playDurationS());
      const T = anchor.side === "together" ? 0 : 1;
      this.t = anchor.t0 + (T - anchor.t0) * anchor.a;
      moving = true;
      if (anchor.a >= 1) {
        this.anchor = undefined;
        this.anchorPlaying = false;
        this.t = this.target = T;
        if (this.looping) {
          this.mode = T === 1 ? "assemble" : "explode";
          this.target = T === 1 ? 0 : 1;
          this.range = [0, 1];
        }
      }
    } else if (this.mode) {
      const step = (dt * this.speed) / this.playDurationS();
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
    // a scope change fading between poses keeps the view drawing
    if (this.blendK() !== undefined) moving = true;
    this.notifyStep();
    if (moving) this.notifyChange();
    return moving;
  }

  /** The scope fade's progress (0..1), or undefined when none runs. */
  private blendK(): number | undefined {
    if (!this.blend) return undefined;
    const k = (this.now() - this.blend.start) / MODE_BLEND_MS;
    if (k >= 1) {
      this.blend = undefined;
      return undefined;
    }
    return Math.max(0, k);
  }

  pose(): Map<string, Mat> {
    const target = this.modePose();
    const k = this.blendK();
    if (k === undefined || !this.blend) return target;
    // fade from where the parts were to where the new scope puts them (a short fade; matrices mixed entry by entry)
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

  /** Per resolution: each part's step (index, stagger) and the resolution without member offsets (joints only). */
  private caches() {
    if (this.cache?.of === this.resolved) return this.cache;
    const schedule = new Map<string, { i: number; delay: number; maxDelay: number }>();
    this.resolved.steps.forEach((s, i) => {
      const maxDelay = Math.max(0, ...s.members.map((m) => m.delay));
      // DEFAULT: a part named by two steps moves with the first (where it is first put on)
      for (const m of s.members) if (!schedule.has(m.ref)) schedule.set(m.ref, { i, delay: m.delay, maxDelay });
    });
    const jointsOnly: ResolvedSequence = { ...this.resolved, steps: this.resolved.steps.map((s) => ({ ...s, members: [] })) };
    this.cache = { of: this.resolved, schedule, jointsOnly };
    return this.cache;
  }

  /** The clock the mode's schedule reads now: t, or (from a kept pose) where the play from it has got to. */
  private clock(): number {
    const a = this.anchor;
    if (!a) return this.t;
    return a.side === "together" ? 1 - a.a : a.a;
  }

  /** Each part's share of its path (0 home, 1 out) on the mode's schedule at clock s: all at once, or step by step. */
  private progressAt(s: number, paths: ReadonlyMap<string, MotionPath>): Map<string, number> {
    const out = new Map<string, number>();
    if (this.explodeMode === "radial") {
      const e = radialEase(s);
      for (const k of paths.keys()) out.set(k, e);
      return out;
    }
    const { schedule } = this.caches();
    const steps = this.resolved.steps;
    for (const k of paths.keys()) {
      const at = schedule.get(k);
      let u: number;
      let ease: "cubic" | "linear" = "cubic";
      if (!at) u = this.isolated !== undefined ? 0 : s;
      else {
        const step = steps[at.i];
        ease = step.ease;
        u = this.isolated !== undefined ? (step.id === this.isolated ? s : 0) : stepOut(this.resolved, at.i, s);
        if (at.maxDelay > 0) u = clamp01((u - at.delay) / (1 - at.maxDelay));
      }
      out.set(k, u <= 0 ? 0 : easeStep(u, ease));
    }
    return out;
  }

  /** Where each part is now (its share of its path), a kept pose taken into account. */
  private progressNow(paths: ReadonlyMap<string, MotionPath>): Map<string, number> {
    const prog = this.progressAt(this.clock(), paths);
    const a = this.anchor;
    if (!a) return prog;
    const out = new Map<string, number>();
    for (const k of paths.keys()) {
      const p0 = a.from.get(k) ?? 0;
      const q = prog.get(k) ?? 0;
      out.set(k, a.side === "together" ? p0 * q : p0 + (1 - p0) * q);
    }
    return out;
  }

  /** The joints' pose at t (driven values, else the steps' keyframes; both modes alike), parents carried. */
  private jointPose(t: number): Map<string, Mat> {
    const { jointsOnly } = this.caches();
    const resolved = this.extraJoints.length ? { ...jointsOnly, joints: this.joints } : jointsOnly;
    return poseAt(resolved, { t, joints: this.values, isolate: this.isolated });
  }

  /** The joints' pose with each part `share` of the way along its path. */
  private pathPose(progress: ReadonlyMap<string, number>, paths: ReadonlyMap<string, MotionPath>, t: number): Map<string, Mat> {
    const base = this.jointPose(t);
    const out = new Map(base);
    for (const [key, p] of progress) {
      if (!(p > 0)) continue;
      const m = paths.get(key);
      if (!m) continue;
      const d = m.distance * p;
      out.set(key, multiply(translation([m.dir[0] * d, m.dir[1] * d, m.dir[2] * d]), base.get(key) ?? identity()));
    }
    return out;
  }

  /**
   * The pose of the mode in force. R5-A: with a radial plan, both modes move each part along its one path (the
   * explode's): Explode all at once on one ease, Assemble step by step in step order; a pose kept across a switch
   * goes on from where each part was. Without a plan, the steps' own offsets (PB-1183's player, unchanged).
   */
  private modePose(): Map<string, Mat> {
    const paths = this.paths();
    if (paths) return this.pathPose(this.progressNow(paths), paths, this.t);
    const resolved = this.extraJoints.length ? { ...this.resolved, joints: this.joints } : this.resolved;
    const scope = this.scopeNow;
    const steps = poseAt(resolved, { t: this.t, joints: this.values, isolate: this.isolated });
    if (!scope) return steps;
    // a sub-assembly on its own: the steps move only its parts; the rest stay assembled (joint values hold)
    const base = poseAt(resolved, { t: 0, joints: this.values });
    const out = new Map(base);
    for (const [key, m] of steps) if (underScope(key, scope)) out.set(key, m);
    return out;
  }

  /**
   * R5-A: the pose at the end of a play toward `side` (every part home, or every part out: the same in both modes),
   * without changing the player: CadView fits its camera to it before a toggle's play.
   */
  endPose(side: MotionDirection): Map<string, Mat> {
    const t = side === "together" ? 0 : 1;
    const paths = this.paths();
    if (paths) return this.pathPose(new Map([...paths.keys()].map((k) => [k, t])), paths, t);
    const resolved = this.extraJoints.length ? { ...this.resolved, joints: this.joints } : this.resolved;
    return poseAt(resolved, { t, joints: this.values });
  }

  /**
   * Wave R3 gate: how far the part that travels farthest goes between together and apart in the mode in force
   * (mm, the level's frame; the scope applied). R5-A: one path per part, so the same in both modes. 0: nothing comes
   * apart, the one case the view's "nothing to explode in this model" note is for (R1-A M11).
   */
  reach(): number {
    const paths = this.paths();
    if (paths) {
      let d = 0;
      for (const m of paths.values()) d = Math.max(d, m.distance);
      return d;
    }
    const scope = this.scopeNow;
    const resolved = this.extraJoints.length ? { ...this.resolved, joints: this.joints } : this.resolved;
    const a = poseAt(resolved, { t: 0, joints: this.values });
    const b = poseAt(resolved, { t: 1, joints: this.values });
    let d = 0;
    for (const [key, m] of b) {
      if (scope && !underScope(key, scope)) continue;
      const o = a.get(key) ?? identity();
      d = Math.max(d, Math.hypot(m[12] - o[12], m[13] - o[13], m[14] - o[14]));
    }
    return d;
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
      step: this.isolated ?? stepAt(this.resolved, this.clock())?.id,
      playing: this.playing,
      loop: this.looping,
      isolate: this.isolated,
      joints,
      unknown: [...this.resolved.unknown],
      clip: this.clip ? { joints: this.clip.clip.joints, samples: this.clip.clip.samples.length, durationS: this.clip.clip.samples.at(-1)?.t ?? 0 } : undefined,
      explodeMode: this.explodeMode,
      ...(this.scopeNow ? { scope: this.scopeNow } : {}),
      ...(this.resolved.radial ? { radial: radialSummary(this.resolved.radial) } : {}),
      motion: { explode: this.explodeOnNow, assemble: this.assembleOnNow, direction: this.dir, speed: this.speed, anchored: Boolean(this.anchor), playing: this.moving(), durationS: this.playDurationS() / this.speed },
    };
  }

  /**
   * The step id the view state's `explode.step` holds (the gate's one type: a string step id, or null): the
   * isolated step, else the step in progress (or just finished) at t.
   */
  currentStep(): string | null {
    if (this.isolated) return this.isolated;
    if (this.held && this.held.t === this.t) return this.held.step;
    return stepAt(this.resolved, this.clock())?.id ?? null;
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
    this.notifyChange();
    return r;
  }

  private changeListeners = new Set<() => void>();
  /**
   * R3-B's handoff (applied by R3-A): called after every tick that moved something and after every command, so a
   * panel (the assembly timeline) can follow the player without polling. Returns the unsubscribe function.
   */
  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => void this.changeListeners.delete(cb);
  }

  private notifyChange() {
    for (const cb of this.changeListeners) {
      try {
        cb();
      } catch (e) {
        console.error("sequence change listener", e);
      }
    }
  }

  private runCommand(cmd: SequenceCommand): { ok: boolean; error?: string; held?: JointLimitFlag } {
    if (!cmd || typeof cmd !== "object") return { ok: false, error: "unknown sequence command" };
    // the steps' own commands play the steps (R2-B): a goto, a play, a loop, an isolate, a step explode or assemble
    const keep = (cmd.action === "play" || cmd.action === "loop") && cmd.keep === true;
    if (cmd.action === "goto" || ((cmd.action === "play" || cmd.action === "loop") && !keep) || cmd.action === "isolate" || ((cmd.action === "explode" || cmd.action === "assemble") && cmd.step !== undefined)) this.setMode("sequence");
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
      // ---- R5-A ----
      case "toggle": {
        if (cmd.explode !== undefined && typeof cmd.explode !== "boolean") return { ok: false, error: "toggle.explode must be true or false" };
        if (cmd.assemble !== undefined && typeof cmd.assemble !== "boolean") return { ok: false, error: "toggle.assemble must be true or false" };
        // both asked at once: the one turned on first (turning one on while the other goes off never sends the parts home)
        const order: ("explode" | "assemble")[] = cmd.assemble === false ? ["explode", "assemble"] : ["assemble", "explode"];
        for (const k of order) {
          const v = cmd[k];
          if (v === undefined) continue;
          if (k === "explode") this.setExplode(v);
          else this.setAssemble(v);
        }
        return { ok: true };
      }
      case "resume":
        return { ok: this.resume() };
      case "pause":
        this.pause();
        return { ok: true };
      case "speed":
        if (typeof cmd.x !== "number" || !Number.isFinite(cmd.x) || cmd.x <= 0) return { ok: false, error: `speed must be a positive number (${SPEEDS.join(", ")} on the timeline)` };
        this.setSpeed(cmd.x);
        return { ok: true };
      case "direction":
        if (cmd.to !== "together" && cmd.to !== "apart") return { ok: false, error: 'direction must be "together" (assemble, collapse) or "apart" (disassemble, explode)' };
        this.setDirection(cmd.to);
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
  // wave R3 gate: with a board in the plan, the parts that come off (its components; the board itself stays) and
  // the word for how (the timeline names "along the board normal", not "radial")
  if (plan.board) {
    let moving = 0;
    for (const m of plan.moves.values()) if (m.distance > 0) moving++;
    return { parts: moving, distanceMm: Math.round(distance * 10) / 10, ms: plan.ms, from, board: { components: plan.board.components } };
  }
  return { parts: plan.moves.size, distanceMm: Math.round(distance * 10) / 10, ms: plan.ms, from };
}
