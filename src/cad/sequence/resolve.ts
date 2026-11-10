/**
 * The assembly sequence resolved against a loaded model, and the pose at any
 * point of it (PB-1183). Pure: no three.js, no raycasts, so it is unit-tested
 * like explode.ts.
 *
 * - `resolveSequence(input, file)`: frame references become world axes at the
 *   assembled pose, groups expand, "auto" distances become mm (rank × gap),
 *   planned steps (no mate) take the stack planner's rises, nested
 *   sub-assemblies are flattened in assembly order.
 * - `poseAt(resolved, state)`: per part, a world-space delta matrix
 *   (column-major, three.js `Matrix4.elements` order) to apply on top of the
 *   assembled placement. `t` is the explode amount, 0 assembled and 1 fully
 *   exploded; exploding plays the steps backwards (last assembled, first out).
 *   Joint values pose the assembled tree first; explode offsets are applied on
 *   top, and every part rides on its parent's delta (lid screws with the lid).
 *
 * Coordinates are UHD's (mm, Z up), the assembly root's frame; the viewer's
 * own boundary converts (CadView keeps CAD coordinates under its Z-up wrapper).
 */
import { flattenSequence, placementKey, structureEnd, worldFrameOf } from "./generate";
import { expandRefs } from "./patch";
import { DEFAULTS, type FrameRef, type JointDef, type JointLimitFlag, type Motion, type SeqStep, type SequenceDefaults, type SequenceFile, type Vec3 } from "./types";
import type { Assembly, Mat4, MateEdge } from "./uhd";

/** Column-major 4x4 (three.js order). */
export type Mat = Float64Array;

export interface ResolveInput {
  /** The model's assembly (the viewer's `model.assembly`): placements, mates and hardware in the viewer's root frame. */
  assembly: Assembly;
  /** mm per stacking rank for "auto" distances (the view's explode step). */
  gap: number;
  /** Display up axis (default +Z). */
  up?: Vec3;
  /** Stack planner rises (mm along up) for parts the sequence leaves to the planner, by part ref. */
  planned?: ReadonlyMap<string, number>;
  /** Named bodies of one artifact that come apart (`<body>::<node>`): world direction and distance, riding on their body. */
  parts?: readonly { ref: string; body: string; dir: Vec3; distance: number }[];
  /** Flatten nested sub-assemblies ("all", default) or fit each as one unit ("one"). */
  levels?: "all" | "one";
}

export interface ResolvedMember {
  ref: string;
  parent?: string;
  /** Unit world direction it leaves along. */
  dir: Vec3;
  /** mm travelled when fully out. */
  distance: number;
  /** A point on its own axis (world), for turning. */
  pivot: Vec3;
  /** Signed turns while backing out (positive loosens a right-hand thread), 0 for none. */
  turns: number;
  pitchMm: number;
  /** Share of the step before this member starts (stagger). */
  delay: number;
}

export interface ResolvedStep {
  id: string;
  title: string;
  kind: SeqStep["kind"];
  /** The sequence it comes from ("main" or a sub-assembly) and its nesting depth. */
  sequence: string;
  depth: number;
  members: ResolvedMember[];
  durationS: number;
  ease: "cubic" | "linear";
  links: string[];
  camera?: SeqStep["camera"];
  callout?: string;
  /** Nothing moves in it (a planned part that lies over nothing): it takes no time when played. */
  still: boolean;
  /** Ordered and spaced by the stack planner (no mate places its part). */
  planned: boolean;
  /** Joint keyframes this step leaves once assembled, already held at the stops (PB-1185). */
  joints?: Record<string, number>;
  /** Keyframe values the stops held (from the built file and found here): the step API's limit flag. */
  limits?: JointLimitFlag[];
}

export interface ResolvedJoint {
  id: string;
  type: "revolute" | "slider";
  part: string;
  origin: Vec3;
  axis: Vec3;
  min?: number;
  max?: number;
  rest: number;
  limitsFrom?: string;
  /** Set when the authored rest lay beyond a stop and is held there (PB-1185). */
  limited?: JointLimitFlag;
}

export interface ResolvedSequence {
  /** ASSEMBLY order. */
  steps: ResolvedStep[];
  /** Every moving part's parent (hierarchical offsets). */
  parents: Map<string, string>;
  joints: ResolvedJoint[];
  defaults: SequenceDefaults;
  /** Where it came from: a built file, the viewer's own generator, or the stack planner alone (a bare GLB). */
  source: "file" | "generated" | "planner";
  /** Member refs the model does not have (a stale file); left out. */
  unknown: string[];
  /** Explode-time window of each step, [start, end] in 0..1, in ASSEMBLY order. */
  windows: [number, number][];
}

// ---- small vector and matrix helpers (column-major) ------------------------

const norm = (v: readonly number[]): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
export const identity = (): Mat => new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
export function multiply(a: Mat, b: Mat): Mat {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}
export const translation = (v: readonly number[]): Mat => new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, v[0], v[1], v[2], 1]);
/** Rotation by `deg` about the line through `p` along unit `axis` (right-hand rule). */
export function rotationAbout(axis: Vec3, p: readonly number[], deg: number): Mat {
  const a = (deg * Math.PI) / 180;
  const [x, y, z] = axis;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const t = 1 - c;
  // column-major rotation
  const r = new Float64Array([t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0, t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0, t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0, 0, 0, 0, 1]);
  return multiply(translation(p), multiply(r, translation([-p[0], -p[1], -p[2]])));
}
/** A point through a column-major matrix. */
export const applyPoint = (m: Mat, p: readonly number[]): Vec3 => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
const rowTranslation = (m: Mat4): Vec3 => [m[3], m[7], m[11]];

const endKey = (e: MateEdge["a"]) => placementKey(e.path, e.frame.artifact);

/** A frame reference as a world origin and unit axis at the assembled pose; undefined when the model cannot place it. */
export function resolveFrame(asm: Assembly, ref: FrameRef, up: Vec3): { origin: Vec3; axis: Vec3 } | undefined {
  if (ref === "up") return { origin: [0, 0, 0], axis: norm(up) };
  if ("world" in ref) return { origin: [0, 0, 0], axis: norm(ref.world) };
  // a mate line (PB-1185): a point and a direction, assembly mm, Z up
  if ("at" in ref) return { origin: [ref.at[0], ref.at[1], ref.at[2]], axis: norm(ref.axis) };
  const m = asm.mates.find((x) => x.linkId === ref.mate);
  if (!m) return undefined;
  const placement = new Map(asm.placements.map((p) => [p.key, p]));
  const mover = [m.a, m.b].find((e) => placement.get(endKey(e))?.via === m.linkId);
  const end =
    ref.end === "a" ? m.a : ref.end === "b" ? m.b : ref.end === "structure" ? structureEnd(m) : ref.end === "child" ? (mover ?? m.b) : mover ? (mover === m.a ? m.b : m.a) : structureEnd(m);
  const pl = placement.get(endKey(end));
  if (!pl) return undefined;
  const w = worldFrameOf(pl.matrix, end.frame);
  return { origin: w.origin as Vec3, axis: norm(w.normal) };
}

/** Explode-time windows: the last assembled step first; still steps take no time. */
export function windowsOf(steps: readonly ResolvedStep[]): [number, number][] {
  const weight = steps.map((s) => (s.still ? 0 : Math.max(0.05, s.durationS)));
  const total = weight.reduce((a, b) => a + b, 0) || 1;
  const out: [number, number][] = steps.map(() => [0, 0]);
  let at = 0;
  for (let i = steps.length - 1; i >= 0; i--) {
    out[i] = [at / total, (at + weight[i]) / total];
    at += weight[i];
  }
  return out;
}

/**
 * Resolve a sequence file against the model. `source` says where the file
 * came from (recorded on the result).
 */
export function resolveSequence(input: ResolveInput, file: SequenceFile, source: ResolvedSequence["source"] = "file"): ResolvedSequence {
  const asm = input.assembly;
  const up = norm(input.up ?? [0, 0, 1]);
  const defaults = { ...DEFAULTS, ...(file.defaults ?? {}) };
  const placement = new Map(asm.placements.map((p) => [p.key, p]));
  const hwIndex = new Map<string, number>();
  {
    const counters = new Map<string, number>();
    asm.hardware.forEach((h, i) => {
      const base = `${h.harness}/${h.child}`;
      const n = (counters.get(base) ?? 0) + 1;
      counters.set(base, n);
      hwIndex.set(`${base}#${n}`, i);
    });
  }
  const partsByRef = new Map((input.parts ?? []).map((p) => [p.ref, p]));
  const known = (ref: string) => placement.has(ref) || hwIndex.has(ref) || partsByRef.has(ref) || (input.planned?.has(ref) ?? false);
  const pivotOf = (ref: string): Vec3 => {
    const hw = hwIndex.get(ref);
    if (hw !== undefined) return rowTranslation(asm.hardware[hw].matrix);
    const pl = placement.get(ref);
    return pl ? rowTranslation(pl.matrix) : [0, 0, 0];
  };
  const parents = new Map<string, string>();
  const unknown: string[] = [];
  const steps: ResolvedStep[] = [];
  // joints: authored ones (and those mates add) from every sequence in the file, rest held at the stops
  const joints: ResolvedJoint[] = [];
  for (const seq of file.sequences)
    for (const j of seq.joints ?? []) {
      const r = resolveJoint(asm, j, up);
      if (r) joints.push(r);
    }
  const flat = flattenSequence(file, file.main, input.levels ?? "all");
  const named = new Set<string>();
  for (const { step, sequence, depth } of flat) {
    const seq = file.sequences.find((s) => s.id === sequence)!;
    const members: ResolvedMember[] = [];
    const refs = step.members.flatMap((m) => (m.ref.startsWith("@") ? expandRefs(seq, [m.ref]).map((ref) => ({ ...m, ref })) : [m]));
    refs.forEach((m) => {
      if (!known(m.ref)) {
        if (!unknown.includes(m.ref)) unknown.push(m.ref);
        return;
      }
      named.add(m.ref);
      const motion: Motion = { along: "up", distance: "auto", ...(step.motion ?? {}), ...(m.motion ?? {}) } as Motion;
      const frame = resolveFrame(asm, motion.along, up) ?? { origin: [0, 0, 0] as Vec3, axis: up };
      let dir = motion.axis === "-normal" ? (frame.axis.map((x) => -x) as Vec3) : frame.axis;
      let distance: number;
      if (step.plan === "stack") {
        // the planner's rise along up (0: it lies over nothing and stays)
        dir = up;
        distance = typeof motion.distance === "number" ? motion.distance : (input.planned?.get(m.ref) ?? 0);
      } else if (typeof motion.distance === "number") distance = motion.distance;
      else distance = (m.rank !== undefined ? Math.abs(m.rank) : 1) * input.gap * (step.kind === "insert" ? 1.6 : 1);
      const pitch = motion.pitchMm ?? 0;
      const turns = motion.turns && pitch > 0 ? Math.min(motion.turns, defaults.maxTurns) * (motion.hand === "left" ? -1 : 1) : 0;
      if (m.parent && known(m.parent)) parents.set(m.ref, m.parent);
      members.push({ ref: m.ref, parent: m.parent, dir, distance, pivot: pivotOf(m.ref), turns, pitchMm: pitch, delay: 0 });
    });
    const durationS = step.durationS ?? defaults.durationS;
    const stagger = step.stagger ?? 0;
    if (stagger > 0 && members.length > 1) {
      const share = Math.min(0.5, (stagger * (members.length - 1)) / durationS);
      members.forEach((mm, k) => (mm.delay = (share * k) / (members.length - 1)));
    }
    // joint keyframes, held at the stops and flagged (a file written by another tool is held too)
    const keyed = step.joints ? holdKeyframes(joints, step.joints) : undefined;
    const limits = [...(step.limits ?? []), ...(keyed?.flags ?? [])];
    steps.push({
      id: step.id,
      title: step.title,
      kind: step.kind,
      sequence,
      depth,
      members,
      durationS,
      ease: step.ease ?? "cubic",
      links: step.links ?? [],
      camera: step.camera,
      callout: step.callout,
      still: members.every((x) => x.distance === 0 && x.turns === 0) && !keyed,
      planned: step.plan === "stack",
      ...(keyed ? { joints: keyed.values } : {}),
      ...(limits.length ? { limits } : {}),
    });
  }
  // what the file leaves out but the view still moves: planned parts (row bodies) and named bodies of one artifact
  for (const [ref, rise] of input.planned ?? []) {
    if (named.has(ref)) continue;
    steps.push({ id: `place:${ref}`, title: `Place the ${ref}`, kind: "place", sequence: file.main, depth: 0, members: [{ ref, dir: up, distance: rise, pivot: pivotOf(ref), turns: 0, pitchMm: 0, delay: 0 }], durationS: defaults.durationS, ease: "cubic", links: [], still: rise === 0, planned: true });
  }
  for (const p of input.parts ?? []) {
    if (named.has(p.ref)) continue;
    // a named body comes off right after its own body is in place (a lid onto its case)
    const at = steps.findIndex((s) => s.members.some((m) => m.ref === p.body));
    const step: ResolvedStep = { id: `fit:${p.ref}`, title: `Fit the ${p.ref.split("::").pop()}`, kind: "place", sequence: file.main, depth: 0, members: [{ ref: p.ref, parent: p.body, dir: norm(p.dir), distance: p.distance, pivot: [0, 0, 0], turns: 0, pitchMm: 0, delay: 0 }], durationS: defaults.durationS, ease: "cubic", links: [], still: p.distance === 0, planned: false };
    if (placement.has(p.body) || partsByRef.has(p.body)) parents.set(p.ref, p.body);
    if (at >= 0) steps.splice(at + 1, 0, step);
    else steps.push(step);
  }
  orderPlanned(steps);
  return { steps, parents, joints, defaults, source, unknown, windows: windowsOf(steps) };
}

/** Planned steps (stack planner) take the planner's order among themselves: lowest rise first in assembly order. */
function orderPlanned(steps: ResolvedStep[]) {
  const slots = steps.map((s, i) => (s.planned ? i : -1)).filter((i) => i >= 0);
  const rise = (s: ResolvedStep) => Math.max(0, ...s.members.map((m) => m.distance));
  const planned = slots.map((i) => steps[i]).sort((a, b) => rise(a) - rise(b) || a.id.localeCompare(b.id));
  slots.forEach((i, k) => (steps[i] = planned[k]));
}

/** A joint definition against the model; a rest beyond a stop is held there and flagged. */
export function resolveJoint(asm: Assembly, j: JointDef, up: Vec3): ResolvedJoint | undefined {
  const f = resolveFrame(asm, j.along, up);
  if (!f) return undefined;
  const asked = j.rest ?? 0;
  const rest = clampJoint(j, asked);
  const limited = j.limited ?? (rest !== asked ? { joint: j.id, asked, held: rest, stop: rest < asked ? ("max" as const) : ("min" as const) } : undefined);
  return { id: j.id, type: j.type, part: j.part, origin: f.origin, axis: f.axis, min: j.min, max: j.max, rest, limitsFrom: j.limitsFrom, ...(limited ? { limited } : {}) };
}

/** A step's joint keyframes held at the joints' stops, with a flag per value that moved; unknown joints are left out. */
export function holdKeyframes(joints: readonly ResolvedJoint[], asked: Readonly<Record<string, number>>): { values: Record<string, number>; flags: JointLimitFlag[] } {
  const values: Record<string, number> = {};
  const flags: JointLimitFlag[] = [];
  for (const [id, v] of Object.entries(asked)) {
    const j = joints.find((x) => x.id === id);
    if (!j || typeof v !== "number" || !Number.isFinite(v)) continue;
    const held = clampJoint(j, v);
    values[id] = held;
    if (held !== v) flags.push({ joint: id, asked: v, held, stop: held < v ? "max" : "min" });
  }
  return { values, flags };
}

/**
 * An ad-hoc joint on a mate (no limits): the part the mate placed turns about
 * (revolute) or slides along (slider) the parent end's frame normal. Limits
 * come only from the sequence (authored); UHD states none today.
 */
export function jointOnMate(asm: Assembly, linkId: string, type: "revolute" | "slider", up: Vec3 = [0, 0, 1]): ResolvedJoint | undefined {
  const mover = asm.placements.find((p) => p.via === linkId);
  if (!mover) return undefined;
  return resolveJoint(asm, { id: linkId, type, part: mover.key, along: { mate: linkId, end: "parent" } }, up);
}

/** A joint value held within its hard stops (min and max where stated). */
export function clampJoint(j: Pick<ResolvedJoint, "min" | "max">, value: number): number {
  let v = value;
  if (j.min !== undefined) v = Math.max(j.min, v);
  if (j.max !== undefined) v = Math.min(j.max, v);
  return v;
}

/** A step's ease of its local progress u (0..1): cubic in and out (the radial explode's too), or linear. */
export const easeStep = (u: number, kind: "cubic" | "linear"): number => ease(u, kind);
const ease = (u: number, kind: "cubic" | "linear"): number => (kind === "linear" ? u : u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2);

/** How far out a step is (0 in, 1 out) at explode amount t. */
export function stepOut(resolved: ResolvedSequence, index: number, t: number): number {
  const [a, b] = resolved.windows[index];
  if (b <= a) return t > a || t >= 1 ? 1 : 0;
  return Math.min(1, Math.max(0, (t - a) / (b - a)));
}

/** One member's own delta at its (eased) out amount u. */
export function memberDelta(m: ResolvedMember, u: number, unscrewShare: number): Mat {
  if (u <= 0) return identity();
  const lead = Math.abs(m.turns) * m.pitchMm;
  let travel: number;
  let deg = 0;
  if (m.turns !== 0) {
    // back out at the thread's lead while turning, then lift the rest of the way
    const a = Math.min(0.9, Math.max(0.05, unscrewShare));
    const p = Math.min(1, u / a);
    deg = m.turns * 360 * p;
    travel = u <= a ? lead * p : lead + Math.max(0, m.distance - lead) * ((u - a) / (1 - a));
  } else travel = m.distance * u;
  const move = translation([m.dir[0] * travel, m.dir[1] * travel, m.dir[2] * travel]);
  return deg ? multiply(move, rotationAbout(m.dir, m.pivot, deg)) : move;
}

export interface PoseState {
  /** Explode amount: 0 assembled, 1 fully exploded. */
  t: number;
  /** Joint values by joint id (degrees or mm), clamped to their stops. */
  joints?: Readonly<Record<string, number>>;
  /** Only this step moves (its local progress is `t`); the rest stays assembled. */
  isolate?: string;
}

/**
 * Per part, the world-space delta to apply on top of its assembled placement
 * (column-major). Parts that do not move are left out. Joint deltas first,
 * then explode offsets, each on top of the part's parent's delta.
 */
export function poseAt(resolved: ResolvedSequence, state: PoseState): Map<string, Mat> {
  const own = new Map<string, Mat>();
  const t = Math.min(1, Math.max(0, state.t));
  resolved.steps.forEach((step, i) => {
    let u: number;
    if (state.isolate !== undefined) u = step.id === state.isolate ? t : 0;
    else u = stepOut(resolved, i, t);
    if (u <= 0) return;
    const maxDelay = Math.max(0, ...step.members.map((m) => m.delay));
    for (const m of step.members) {
      const local = maxDelay > 0 ? Math.min(1, Math.max(0, (u - m.delay) / (1 - maxDelay))) : u;
      const e = ease(local, step.ease);
      if (e <= 0) continue;
      own.set(m.ref, memberDelta(m, e, resolved.defaults.unscrewShare));
    }
  });
  const jointDelta = new Map<string, Mat>();
  const keyed = jointKeyframesAt(resolved, t, state.isolate);
  for (const j of resolved.joints) {
    const v = state.joints?.[j.id] ?? keyed?.[j.id];
    if (v === undefined) continue;
    const q = clampJoint(j, v) - j.rest;
    if (!q) continue;
    jointDelta.set(j.part, j.type === "revolute" ? rotationAbout(j.axis, j.origin, q) : translation(j.axis.map((x) => x * q)));
  }
  const out = new Map<string, Mat>();
  const visiting = new Set<string>();
  const total = (ref: string): Mat | undefined => {
    if (out.has(ref)) return out.get(ref);
    if (visiting.has(ref)) return undefined; // a cycle in parents: ignore the rest of the chain
    visiting.add(ref);
    const parent = resolved.parents.get(ref);
    const p = parent ? total(parent) : undefined;
    const jd = jointDelta.get(ref);
    const od = own.get(ref);
    visiting.delete(ref);
    if (!p && !jd && !od) return undefined;
    let m = p ?? identity();
    if (jd) m = multiply(m, jd);
    if (od) m = multiply(m, od);
    out.set(ref, m);
    return m;
  };
  const refs = new Set<string>([...own.keys(), ...jointDelta.keys(), ...resolved.parents.keys()]);
  for (const r of refs) total(r);
  return out;
}

/**
 * Joint values the steps' keyframes give at explode amount t (PB-1185): from rest, each keyframed step moves its
 * joints toward its value as the step goes in (assembly order), so assembled shows the last keyframe and fully
 * apart shows rest. Undefined when no step carries a keyframe (the common case costs one pass over the steps).
 */
export function jointKeyframesAt(resolved: ResolvedSequence, t: number, isolate?: string): Record<string, number> | undefined {
  let out: Record<string, number> | undefined;
  resolved.steps.forEach((step, i) => {
    if (!step.joints) return;
    out ??= Object.fromEntries(resolved.joints.map((j) => [j.id, j.rest]));
    const u = isolate !== undefined ? (step.id === isolate ? t : 0) : stepOut(resolved, i, t);
    const inAmount = 1 - ease(u, step.ease);
    for (const [id, v] of Object.entries(step.joints)) if (id in out) out[id] = out[id] + (v - out[id]) * inAmount;
  });
  return out;
}

/** Explode amount at which `step` is about to be assembled (everything from it on is out). */
export function tBefore(resolved: ResolvedSequence, step: string): number | undefined {
  const i = resolved.steps.findIndex((s) => s.id === step);
  return i < 0 ? undefined : resolved.windows[i][1];
}
/** Explode amount at which `step` has just been assembled. */
export function tAfter(resolved: ResolvedSequence, step: string): number | undefined {
  const i = resolved.steps.findIndex((s) => s.id === step);
  return i < 0 ? undefined : resolved.windows[i][0];
}
/** The step in progress (or last finished) at explode amount t, in assembly order. */
export function stepAt(resolved: ResolvedSequence, t: number): ResolvedStep | undefined {
  let best: ResolvedStep | undefined;
  resolved.steps.forEach((s, i) => {
    const [a, b] = resolved.windows[i];
    if (t >= a - 1e-9 && t <= b + 1e-9 && !s.still) best ??= s;
  });
  return best;
}
