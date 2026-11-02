/**
 * The assembly timeline's model (R3-B, 2026-11-02, Kevin's chosen concept, image 1's bottom panel): what the panel
 * draws, derived from the sequence player (./sequence) and, when a sweep was run, the interference report. Pure
 * functions, no React and no DOM, so the tests check them in node.
 *
 * The time axis: the panel shows ASSEMBLY, left to right: x = 0 is everything apart (explode amount t = 1), x = 1 is
 * the model together (t = 0). So x = 1 - t, and a step's chip runs from where its parts start going on (its explode
 * window's end) to where they are on (its window's start). Playing "assemble" moves the playhead right.
 */
import type { JointLimitFlag } from "../sequence/types";
import type { ResolvedJoint, ResolvedSequence } from "../sequence/resolve";
import type { ExplodeMode, PlayerSnapshot } from "../sequence/player";

/** Explode amount (0 together, 1 apart) to the panel's axis (0 apart, 1 together), and back. */
export const axisOf = (t: number): number => 1 - Math.min(1, Math.max(0, t));
export const tOfAxis = (x: number): number => 1 - Math.min(1, Math.max(0, x));

export interface TimelineStep {
  id: string;
  title: string;
  kind: string;
  /** 1-based number among the steps that take time (still steps are not numbered and not drawn). */
  n: number;
  /** Where on the axis its parts start going on and are on (0..1). */
  x0: number;
  x1: number;
  members: number;
  depth: number;
  ease: "cubic" | "linear";
  /** Keyframe values the hard stops held in this step. */
  limits?: JointLimitFlag[];
}

export interface JointKey {
  /** Axis position where the joint reaches `value` (the end of the step that carries the keyframe; 0 for rest). */
  x: number;
  value: number;
  /** The step that carries it (absent: the rest pose, fully apart). */
  step?: string;
  /** The keyframe asked beyond a stop and held there. */
  held?: JointLimitFlag;
}

export interface JointSegment {
  /** The step the joint moves in, and where on the axis. */
  step: string;
  x0: number;
  x1: number;
  from: number;
  to: number;
  ease: "cubic" | "linear";
}

export interface TimelineJoint {
  id: string;
  type: "revolute" | "slider";
  /** "°" (revolute) or "mm" (slider). */
  unit: string;
  min?: number;
  max?: number;
  rest: number;
  keys: JointKey[];
  segments: JointSegment[];
}

export interface TimelineModel {
  steps: TimelineStep[];
  joints: TimelineJoint[];
  /** Seconds the whole assembly takes at speed 1. */
  durationS: number;
  source: ResolvedSequence["source"];
}

const unitOf = (type: string) => (type === "slider" ? "mm" : "°");

/** Steps and joints of a resolved sequence, laid out on the assembly axis. */
export function timelineModel(resolved: Pick<ResolvedSequence, "steps" | "windows" | "joints" | "source">, extraJoints: readonly ResolvedJoint[] = []): TimelineModel {
  const steps: TimelineStep[] = [];
  let n = 0;
  resolved.steps.forEach((s, i) => {
    if (s.still) return;
    const [a, b] = resolved.windows[i] ?? [0, 0];
    steps.push({ id: s.id, title: s.title, kind: s.kind, n: ++n, x0: axisOf(b), x1: axisOf(a), members: s.members.length, depth: s.depth, ease: s.ease, ...(s.limits?.length ? { limits: s.limits } : {}) });
  });
  steps.sort((p, q) => p.x0 - q.x0 || p.n - q.n);
  const all = [...resolved.joints, ...extraJoints.filter((j) => !resolved.joints.some((r) => r.id === j.id))];
  const joints: TimelineJoint[] = all.map((j) => {
    const keys: JointKey[] = [{ x: 0, value: j.rest }];
    const segments: JointSegment[] = [];
    // in assembly order, each keyframed step moves the joint from where it was to its value while the step goes on
    const ordered = resolved.steps.map((s, i) => ({ s, w: resolved.windows[i] ?? [0, 0] })).sort((p, q) => q.w[1] - p.w[1]);
    let value = j.rest;
    for (const { s, w } of ordered) {
      const v = s.joints?.[j.id];
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      const x0 = axisOf(w[1]);
      const x1 = axisOf(w[0]);
      const held = s.limits?.find((f) => f.joint === j.id);
      segments.push({ step: s.id, x0, x1, from: value, to: v, ease: s.ease });
      keys.push({ x: x1, value: v, step: s.id, ...(held ? { held } : {}) });
      value = v;
    }
    return { id: j.id, type: j.type, unit: unitOf(j.type), min: j.min, max: j.max, rest: j.rest, keys, segments };
  });
  const durationS = Math.max(0.1, resolved.steps.reduce((sum, s) => sum + (s.still ? 0 : (s as { durationS?: number }).durationS ?? 0), 0));
  return { steps, joints, durationS, source: resolved.source };
}

/** The step whose chip holds axis position x (the first one when chips touch), else the last one started. */
export function stepIndexAt(steps: readonly TimelineStep[], x: number, current?: string | null): number {
  if (current) {
    const i = steps.findIndex((s) => s.id === current);
    if (i >= 0) return i;
  }
  let best = -1;
  steps.forEach((s, i) => {
    if (x >= s.x0 - 1e-9 && x <= s.x1 + 1e-9 && best < 0) best = i;
  });
  if (best >= 0) return best;
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i].x0 <= x) return i;
  return steps.length ? 0 : -1;
}

/** Each chip's state: done (on), the current one, or still to come. */
export function chipState(i: number, current: number, x: number, step: TimelineStep): "done" | "current" | "todo" {
  if (i === current) return "current";
  return step.x1 <= x + 1e-9 ? "done" : "todo";
}

/** The step before or after the current one (keyboard Left/Right, the panel's step buttons); undefined at an end. */
export function neighbourStep(steps: readonly TimelineStep[], current: number, dir: -1 | 1): TimelineStep | undefined {
  if (!steps.length) return undefined;
  if (current < 0) return dir > 0 ? steps[0] : undefined;
  return steps[current + dir];
}

/** A number as the panel shows it: up to one decimal, no trailing zero. */
export const num = (v: number): string => {
  const r = Math.round(v * 10) / 10;
  return Object.is(r, -0) ? "0" : String(r);
};

/** "In-out" for the cubic ease the sequence uses, "linear" for linear (the label's words). */
export const easeName = (ease: "cubic" | "linear"): string => (ease === "linear" ? "linear" : "ease in-out");

/**
 * The joint row's label: type, range in degrees or mm, easing, clip. With a keyframe moving it: the active (or the
 * first) segment, "revolute 0° → 90° · ease in-out"; without: its stops and where it is now.
 */
export function jointLabel(j: TimelineJoint, x: number, now: number | undefined, clip?: { joints: readonly string[] }): string {
  const parts: string[] = [j.type];
  const seg = j.segments.find((s) => x >= s.x0 - 1e-9 && x <= s.x1 + 1e-9) ?? j.segments[0];
  if (seg) parts.push(`${num(seg.from)}${j.unit} → ${num(seg.to)}${j.unit}`, easeName(seg.ease));
  else {
    const range = j.min !== undefined || j.max !== undefined ? `${j.min !== undefined ? num(j.min) : "−∞"}${j.unit} … ${j.max !== undefined ? num(j.max) : "∞"}${j.unit}` : "no stops";
    parts.push(range, `rest ${num(j.rest)}${j.unit}`);
  }
  if (now !== undefined && Math.abs(now - (seg ? seg.to : j.rest)) > 0.05) parts.push(`now ${num(now)}${j.unit}`);
  if (clip?.joints.includes(j.id)) parts.push("clip");
  return parts.join(" · ");
}

/** The active segment of a joint at x (drawn in the accent), if any. */
export const activeSegment = (j: TimelineJoint, x: number): JointSegment | undefined => j.segments.find((s) => x > s.x0 + 1e-9 && x < s.x1 - 1e-9);

// ---- contacts from the interference sweep ----------------------------------------------------------------------

/**
 * One contact on the CONTACTS track. The panel's input shape (a host or the bundle may pass these directly), or
 * made from a `protoboard interference --json` report (`contactsFromReport`).
 */
export interface TimelineContact {
  /** Stable id (keyframe + pair). */
  id: string;
  /** Explode amount of the keyframe it was found at (0 together, 1 apart). */
  t: number;
  /** Instance paths of the two bodies. */
  a: string;
  b: string;
  /** "interference": they overlap; "contact": they touch (within the sweep's contact depth). */
  status: "interference" | "contact";
  depthMm?: number;
  /** The keyframe's id and label ("step:fasten:top_plate_mount", "just before …"). */
  keyframe?: string;
  label?: string;
  /** Explode amount where it is last seen (its span on the track runs from `t` to here); absent: one moment. */
  tEnd?: number;
  /** Keyframes it shows at. */
  keyframes?: number;
  /** Where it came from: the sweep (`protoboard interference`), or a host's own check. */
  from?: "sweep" | "host";
}

/** The `protoboard.interference/v0` report as far as the panel reads it (packages/core/src/mates/interference.ts). */
export interface InterferenceReportLike {
  schema?: string;
  keyframes: { id: string; label?: string; t: number; hits: { a: string; b: string; status: "interference" | "contact"; depthMm?: number; intended?: string }[] }[];
  truncated?: string;
}

/**
 * The contacts of a sweep report, one per pair of bodies: each pair that touches or overlaps where no mate intends it
 * (an intended contact is two mated faces touching, not an event: DEFAULT left out), placed where it first happens in
 * assembly order (`t`) and spanning to where it is last seen (`tEnd`). The drone's sweep has 2,454 hits over 31
 * keyframes but 10 such pairs: one marker each, not one per keyframe (DEFAULT).
 */
export function contactsFromReport(report: InterferenceReportLike | undefined): TimelineContact[] {
  if (!report || !Array.isArray(report.keyframes)) return [];
  const byPair = new Map<string, TimelineContact>();
  const seenAt = new Map<string, Set<string>>();
  for (const k of report.keyframes) {
    if (!k || typeof k.t !== "number" || !Array.isArray(k.hits)) continue;
    const t = Math.min(1, Math.max(0, k.t));
    for (const h of k.hits) {
      if (!h || h.intended || typeof h.a !== "string" || typeof h.b !== "string") continue;
      const id = [h.a, h.b].sort().join("|");
      const status = h.status === "contact" ? "contact" : "interference";
      const depth = typeof h.depthMm === "number" ? h.depthMm : undefined;
      const at = seenAt.get(id) ?? new Set<string>();
      at.add(k.id);
      seenAt.set(id, at);
      const was = byPair.get(id);
      if (!was) {
        byPair.set(id, { id, t, tEnd: t, a: h.a, b: h.b, status, ...(depth !== undefined ? { depthMm: depth } : {}), keyframe: k.id, ...(k.label ? { label: k.label } : {}), from: "sweep" });
        continue;
      }
      // first in assembly order is the largest explode amount
      if (t > was.t) Object.assign(was, { t, keyframe: k.id, ...(k.label ? { label: k.label } : {}) });
      was.tEnd = Math.min(was.tEnd ?? t, t);
      if (status === "interference") was.status = "interference";
      if (depth !== undefined && depth > (was.depthMm ?? -Infinity)) was.depthMm = depth;
    }
  }
  for (const [id, c] of byPair) c.keyframes = seenAt.get(id)?.size ?? 1;
  return [...byPair.values()].sort((p, q) => axisOf(p.t) - axisOf(q.t) || p.id.localeCompare(q.id));
}

/** Contacts given directly or as a report (the panel's `contacts` prop takes either). */
export function contactsOf(input: readonly TimelineContact[] | InterferenceReportLike | undefined | null): TimelineContact[] | undefined {
  if (!input) return undefined;
  if (Array.isArray(input)) return input.filter((c) => c && typeof c.t === "number" && typeof c.a === "string" && typeof c.b === "string");
  return contactsFromReport(input as InterferenceReportLike);
}

/** A part's short name from its instance path ("arm_fl/prop" → "prop"). */
export const shortName = (path: string): string => path.split("#")[0].split("/").filter(Boolean).pop() ?? path;

/** The marker's words: "prop touches camera hood · t 7.55 s · from sweep" (t in seconds into the assembly). */
export function contactText(c: TimelineContact, durationS: number): string {
  const verb = c.status === "contact" ? "touches" : "overlaps";
  const depth = c.status === "interference" && c.depthMm !== undefined ? ` ${num(c.depthMm)} mm` : "";
  return `${shortName(c.a).replace(/_/g, " ")} ${verb} ${shortName(c.b).replace(/_/g, " ")}${depth} · t ${(axisOf(c.t) * durationS).toFixed(2)} · from ${c.from ?? "sweep"}`;
}

// ---- the header --------------------------------------------------------------------------------------------------

export interface HeaderState {
  mode: ExplodeMode;
  /** The explode amount now (the eased one the parts are at). */
  t: number;
  step?: string | null;
  speed: number;
  playing: boolean;
  radial?: PlayerSnapshot["radial"];
}

/** The title line and its subline (image 1: "STEP 6 / 9 · FASTEN TOP PLATE", "fasten:top_plate · 4x M3 · t = 5.62 · 1.0x"). */
export function headerText(m: TimelineModel | undefined, s: HeaderState): { title: string; sub: string } {
  const x = axisOf(s.t);
  const secs = `t = ${(x * (m?.durationS ?? 0)).toFixed(2)} · ${s.speed.toFixed(1)}x`;
  if (s.mode === "radial") {
    // wave R3 gate: a board drawn as an assembly comes apart along its normal (its components; the board stays)
    const board = s.radial?.board;
    const noun = board ? "component" : "part";
    const parts = s.radial ? `${s.radial.parts} ${noun}${s.radial.parts === 1 ? "" : "s"} · ${num(s.radial.distanceMm * s.t)} mm out` : "every part";
    return { title: `Explode · all parts at once`, sub: `${board ? "along the board normal" : "radial"} · ${parts} · amount ${s.t.toFixed(2)}` };
  }
  if (!m || !m.steps.length) return { title: "No assembly steps", sub: "this model has no sequence to play" };
  const i = stepIndexAt(m.steps, x, s.step);
  const step = m.steps[i];
  if (!step) return { title: "Assembled", sub: secs };
  const together = x >= 1 - 1e-6 && !s.playing;
  return {
    title: together ? `Assembled · ${m.steps.length} step${m.steps.length === 1 ? "" : "s"}` : `Step ${step.n} / ${m.steps.length} · ${step.title}`,
    sub: `${step.id} · ${step.members} part${step.members === 1 ? "" : "s"} · ${secs}`,
  };
}

/** The chip after the explode slider: a replay clip ("replay loop · 12 joints × 120 samples · 5.8 KB"), else what plays. */
export function chipText(snap: Pick<PlayerSnapshot, "clip" | "explodeMode" | "radial" | "steps" | "source" | "joints">, loop: boolean): string {
  if (snap.clip) {
    const kb = (snap.clip.joints.length * snap.clip.samples * 4) / 1024;
    return `replay${loop ? " loop" : ""} · ${snap.clip.joints.length} joint${snap.clip.joints.length === 1 ? "" : "s"} × ${snap.clip.samples} samples · ${kb.toFixed(1)} KB`;
  }
  if (snap.explodeMode === "radial" && snap.radial) return snap.radial.board ? `board normal · ${snap.radial.parts} components · ${num(snap.radial.distanceMm)} mm` : `radial · ${snap.radial.parts} parts · ${num(snap.radial.distanceMm)} mm`;
  const steps = snap.steps.filter((s) => !s.still).length;
  const joints = Object.keys(snap.joints).length;
  const from = snap.source === "file" ? "built sequence" : snap.source === "generated" ? "from the mates" : "planned";
  return `${loop ? "loop · " : ""}${steps} step${steps === 1 ? "" : "s"} · ${joints} joint${joints === 1 ? "" : "s"} · ${from}`;
}

// ---- when the panel shows -----------------------------------------------------------------------------------------

/**
 * DEFAULT (R3-B): the panel shows while Explode or Assemble is on: the toolbar asked for it (`requested`), the parts
 * are apart (the view state's amount or the player's eased one), or a play runs; and for `LINGER_MS` after they come
 * back together, so the end of an assembly is seen before the panel goes. Both off and at rest: hidden.
 */
export const LINGER_MS = 1200;
export function timelineWanted(s: { requested?: boolean; storeT: number; playerT?: number; playing?: boolean }): boolean {
  return Boolean(s.requested) || s.storeT > 0 || (s.playerT ?? 0) > 1e-4 || Boolean(s.playing);
}

// ---- the keyboard ---------------------------------------------------------------------------------------------------

export type TimelineKey = "toggle" | "prev" | "next" | null;
/** Space plays or pauses; Left and Right go to the previous and next step (when the panel has focus and the key is not a slider's). */
export function keyAction(key: string, target: { tagName?: string; type?: string } | null): TimelineKey {
  const tag = target?.tagName?.toLowerCase();
  if (tag === "input" && target?.type === "range" && (key === "ArrowLeft" || key === "ArrowRight")) return null;
  if (tag === "input" && target?.type !== "range") return null;
  // a focused button takes Space itself (play, loop, collapse): the panel does not take it twice
  if (tag === "button" && (key === " " || key === "Spacebar" || key === "Enter")) return null;
  if (key === " " || key === "Spacebar") return "toggle";
  if (key === "ArrowLeft") return "prev";
  if (key === "ArrowRight") return "next";
  return null;
}

// ---- the collapsed state, remembered per viewer ---------------------------------------------------------------------

/** DEFAULT: one key for every viewer on this origin (the app, `protoboard dev`, a VS Code webview each have their own). */
export const COLLAPSED_KEY = "uhd-viewer.timeline.collapsed";
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
const storageOf = (s?: Storage | null): Storage | null => {
  if (s !== undefined) return s;
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};
export function loadCollapsed(storage?: Storage | null): boolean {
  try {
    return storageOf(storage)?.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}
export function saveCollapsed(on: boolean, storage?: Storage | null): void {
  try {
    storageOf(storage)?.setItem(COLLAPSED_KEY, on ? "1" : "0");
  } catch {
    /* private mode or a webview without storage: the choice lasts this session */
  }
}
