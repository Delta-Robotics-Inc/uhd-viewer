/**
 * The motion controller (R5-A, 2026-11-02, Kevin's walkthrough): the toolbar's Explode and Assemble toggles and the
 * timeline's Play, Pause, speed and direction, over CadView's sequence player. No three.js and no React: CadView makes
 * one and hands it to the toolbar and the timeline panel; agents and hosts reach the same behaviour through the
 * player's commands (`toggle`, `resume`, `pause`, `speed`, `direction`).
 *
 * The rules live in the player (./player.ts): one explode path per part shared by both modes; Explode moves every part
 * at once, Assemble moves them step by step in step order; the two toggles are independent (both on: Assemble drives
 * the step order and Explode is its fully-out pose, which is the same pose); a toggle turned on from rest plays once,
 * a switch while the parts move (or are paused mid-way) keeps the pose and waits for Play; both off sends the parts home.
 *
 * Kevin's words: "The explode and assembly buttons are individual on and off toggles, not one or the other." "If you
 * switch mid animation, the assembly does not autostart; you have to click play to continue." "I want a speed
 * adjustment for assemblies/explodes." "You should be able to select direction of assembly."
 */
import type { ExplodeMode, MotionDirection, SequenceCommand, SequencePlayer } from "./player";
import { SPEEDS } from "./player";

/** What the toolbar and the panel show. `ready`: the player exists (the model has loaded and the sequence resolved). */
export interface MotionState {
  ready: boolean;
  explode: boolean;
  assemble: boolean;
  mode: ExplodeMode;
  direction: MotionDirection;
  speed: number;
  /** Something moves (a play, a play from a kept pose). */
  playing: boolean;
  /** The pose was kept across a switch; Play goes on from it. */
  anchored: boolean;
  /** The explode amount now (0 together, 1 apart). */
  t: number;
}

/** What the controller drives: CadView's player and its command runner (which resolves the player lazily and poses the model). */
export interface MotionSource {
  player: () => SequencePlayer | null;
  run: (cmd: SequenceCommand) => { ok: boolean; error?: string };
  /**
   * The person's write to the view state (CadView's HUMAN `write`), so the store's explode amount, mode and toggles
   * follow a command: `{ op: "explode", t, mode, step?, on, assemble }`. Absent: the view state is not written.
   */
  write?: (ops: unknown[], label: string) => void;
}

const OFF: MotionState = { ready: false, explode: false, assemble: false, mode: "radial", direction: "apart", speed: 1, playing: false, anchored: false, t: 0 };

export class MotionController {
  private listeners = new Set<() => void>();
  private attached: SequencePlayer | null = null;
  private off: (() => void) | null = null;
  private poll: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly source: MotionSource) {}

  /** The player's motion state (all off until the player exists). */
  state(): MotionState {
    const p = this.attach();
    if (!p) return OFF;
    return { ready: true, explode: p.explodeOn, assemble: p.assembleOn, mode: p.explodeMode, direction: p.direction, speed: p.speed, playing: Boolean(p.playing), anchored: p.anchored, t: p.t };
  }

  /** Called after every change (a tick that moved, any command, a controller call). Returns the unsubscribe function. */
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    this.attach();
    // the player is made lazily: until it exists, look for it now and then (DEFAULT 400 ms; stops once attached)
    if (!this.attached && this.poll === undefined && typeof setInterval !== "undefined")
      this.poll = setInterval(() => {
        if (this.attach()) this.emit();
      }, 400);
    return () => {
      this.listeners.delete(cb);
      if (!this.listeners.size) this.detach();
    };
  }

  // ---- the toolbar ----------------------------------------------------------------------------------------------------

  /** Explode on or off (independent of Assemble). */
  setExplode(on: boolean) {
    return this.command({ action: "toggle", explode: on }, on ? "explode on" : "explode off");
  }
  /** Assemble on or off (independent of Explode). */
  setAssemble(on: boolean) {
    return this.command({ action: "toggle", assemble: on }, on ? "assemble on" : "assemble off");
  }
  /**
   * Both toggles in one command (R5 gate: an agent's `explode {on, assemble}`): the player applies the one turned on
   * first. `write: false` leaves the view state alone (the caller's own write already says it).
   */
  setToggles(flags: { explode?: boolean; assemble?: boolean }, opts: { write?: boolean } = {}) {
    const label = [flags.explode !== undefined ? `explode ${flags.explode ? "on" : "off"}` : "", flags.assemble !== undefined ? `assemble ${flags.assemble ? "on" : "off"}` : ""].filter(Boolean).join(", ");
    return this.command({ action: "toggle", ...flags }, label || "toggles", opts.write !== false);
  }
  toggleExplode() {
    return this.setExplode(!this.state().explode);
  }
  toggleAssemble() {
    return this.setAssemble(!this.state().assemble);
  }

  // ---- the timeline panel -----------------------------------------------------------------------------------------------

  /** From where the parts are toward the direction's end (from a kept pose: each part from where it is). */
  play() {
    return this.command({ action: "resume" }, "play (timeline)");
  }
  pause() {
    return this.command({ action: "pause" }, "pause (timeline)");
  }
  togglePlay() {
    return this.state().playing ? this.pause() : this.play();
  }
  /** Speed (SPEEDS on the timeline: 0.25x to 4x; 1x is the R4 timing). */
  setSpeed(x: number) {
    return this.command({ action: "speed", x }, `speed ${x}x (timeline)`, false);
  }
  /** `together`: assemble (or collapse); `apart`: disassemble (or explode). Switching while moving pauses. */
  setDirection(d: MotionDirection) {
    return this.command({ action: "direction", to: d }, d === "together" ? "direction: together (timeline)" : "direction: apart (timeline)");
  }
  flipDirection() {
    return this.setDirection(this.state().direction === "together" ? "apart" : "together");
  }
  /** The next speed up (or down) the timeline's list. */
  stepSpeed(dir: 1 | -1) {
    const now = this.state().speed;
    const i = SPEEDS.findIndex((s) => Math.abs(s - now) < 1e-9);
    const at = i < 0 ? SPEEDS.findIndex((s) => s > now) : i + dir;
    const next = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, at < 0 ? SPEEDS.length - 1 : at))];
    return this.setSpeed(next);
  }

  // ---- inside -----------------------------------------------------------------------------------------------------------

  private command(cmd: SequenceCommand, label: string, writeBack = true): { ok: boolean; error?: string } {
    const r = this.source.run(cmd);
    const p = this.attach();
    if (r.ok && p && writeBack && this.source.write) {
      // the view state follows: where the parts are, the mode in force, the toggles (R5-B adds `on` and `assemble`)
      const step = p.explodeMode === "sequence" ? p.currentStep() : null;
      // R5 gate: the sub-assembly being exploded is kept (a write without `scope` clears it: the whole model came out)
      this.source.write([{ op: "explode", t: Math.min(1, Math.max(0, p.t)), mode: p.explodeMode, step, ...(p.scope ? { scope: p.scope } : {}), on: p.explodeOn, assemble: p.assembleOn }], label);
    }
    this.emit();
    return r;
  }

  private attach(): SequencePlayer | null {
    const p = this.source.player();
    if (p !== this.attached) {
      this.off?.();
      this.off = null;
      this.attached = p;
    }
    if (p && this.listeners.size && !this.off) this.off = p.onChange(() => this.emit());
    if (p && this.poll !== undefined) {
      clearInterval(this.poll);
      this.poll = undefined;
    }
    return p;
  }

  private detach() {
    this.off?.();
    this.off = null;
    this.attached = null;
    if (this.poll !== undefined) clearInterval(this.poll);
    this.poll = undefined;
  }

  private emit() {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch (e) {
        console.error("motion listener", e);
      }
    }
  }
}
