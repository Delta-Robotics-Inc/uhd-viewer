/**
 * `tourAt(tour, t)`: what the view shows `t` seconds into a tour (PB-1188),
 * a pure function of time. Numbers ease between the keyframes that set them
 * (each property is its own track, so a keyframe may set only the camera);
 * sets switch at the keyframe that sets them.
 *
 * The explode track is a motion clip of W2-C's sequence player
 * (`ClipRecorder` records the keyframes' explode amounts, `sampleClip`
 * interpolates them), so a tour and a recorded motion share one sampler; a
 * keyframe that names a sequence step is turned into an explode amount
 * through the player's step windows (`PlayerSnapshot.steps[i].window`:
 * [assembled, apart]).
 */
import type { CameraState, SectionPlane, SetOp, Vec3 } from "../../api";
import { ClipRecorder, sampleClip, type MotionClip } from "../sequence/player";
import { TOUR_SCHEMA, type Ease, type Tour, type TourCallout, type TourContext, type TourFrame, type TourKeyframe } from "./types";

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Easing of a segment's fraction. */
export function ease(kind: Ease | undefined, x: number): number {
  const k = clamp01(x);
  switch (kind ?? "in-out") {
    case "linear":
      return k;
    case "in":
      return k * k * k;
    case "out":
      return 1 - (1 - k) ** 3;
    case "hold":
      return k < 1 ? 0 : 1;
    default:
      return k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
  }
}

/** The tour's length in seconds. */
export const tourDuration = (tour: Tour) => Math.max(tour.duration ?? 0, tour.keyframes.at(-1)?.t ?? 0);

/** A keyframe's explode amount: its own, else its step through the player's windows (before: apart, after: on). */
export function explodeOf(k: TourKeyframe, ctx: TourContext = {}): number | undefined {
  if (typeof k.explode === "number") return clamp01(k.explode);
  if (!k.step) return undefined;
  const w = ctx.steps?.find((s) => s.id === k.step!.id)?.window;
  if (!w) return undefined;
  return (k.step.where ?? "before") === "before" ? w[1] : w[0];
}

/** The keyframes' explode amounts as a motion clip (joint-free; `x` is the explode amount), and its time offset. */
export function explodeClip(tour: Tour, ctx: TourContext = {}): { clip: MotionClip; t0: number; eases: (Ease | undefined)[] } | undefined {
  const rec = new ClipRecorder([]);
  const eases: (Ease | undefined)[] = [];
  let t0: number | undefined;
  for (const k of tour.keyframes) {
    const x = explodeOf(k, ctx);
    if (x === undefined) continue;
    t0 ??= k.t;
    rec.sample(k.t, {}, x);
    eases.push(k.ease);
  }
  if (t0 === undefined) return undefined;
  return { clip: rec.finish(false), t0, eases };
}

/** The segment of a track around `t`: the keyframe at or before it and the one after (both setting the property). */
function around<T>(keys: TourKeyframe[], t: number, get: (k: TourKeyframe) => T | undefined): { a?: { k: TourKeyframe; v: T }; b?: { k: TourKeyframe; v: T } } {
  let a: { k: TourKeyframe; v: T } | undefined;
  let b: { k: TourKeyframe; v: T } | undefined;
  for (const k of keys) {
    const v = get(k);
    if (v === undefined) continue;
    if (k.t <= t) a = { k, v };
    else {
      b = { k, v };
      break;
    }
  }
  return { a, b };
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const lerpV = (a: Vec3, b: Vec3, k: number): Vec3 => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
const lenV = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const subV = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const r4v = (v: Vec3): Vec3 => [r4(v[0]), r4(v[1]), r4(v[2])];

/** Spherical interpolation of two directions (unit or not; the result is unit). */
function slerpDir(a: Vec3, b: Vec3, k: number): Vec3 {
  const la = lenV(a) || 1;
  const lb = lenV(b) || 1;
  const u: Vec3 = [a[0] / la, a[1] / la, a[2] / la];
  const v: Vec3 = [b[0] / lb, b[1] / lb, b[2] / lb];
  const d = Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]));
  const th = Math.acos(d);
  if (th < 1e-6) return u;
  if (Math.PI - th < 1e-6) {
    // opposite: go round through any perpendicular
    const lin = lerpV(u, v, k);
    return lenV(lin) > 1e-9 ? r4v(lin.map((x) => x / lenV(lin)) as Vec3) : u;
  }
  const s = Math.sin(th);
  const wa = Math.sin((1 - k) * th) / s;
  const wb = Math.sin(k * th) / s;
  return [u[0] * wa + v[0] * wb, u[1] * wa + v[1] * wb, u[2] * wa + v[2] * wb];
}

/**
 * Camera between two keyframes: the target moves straight, the eye swings
 * round it (direction slerped, distance eased geometrically), so a move
 * between two views orbits instead of cutting through the model.
 */
export function cameraBetween(a: CameraState, b: CameraState, k: number): CameraState {
  const target = lerpV(a.target, b.target, k);
  const oa = subV(a.position, a.target);
  const ob = subV(b.position, b.target);
  const da = lenV(oa) || 1;
  const db = lenV(ob) || 1;
  const dir = slerpDir(oa, ob, k);
  const d = da * (db / da) ** k;
  const up = slerpDir(a.up, b.up, k);
  return {
    position: r4v([target[0] + dir[0] * d, target[1] + dir[1] * d, target[2] + dir[2] * d]),
    target: r4v(target),
    up: r4v(up),
    ...(a.fov !== undefined || b.fov !== undefined ? { fov: r4(lerp(a.fov ?? b.fov ?? 45, b.fov ?? a.fov ?? 45, k)) } : {}),
  };
}

/** Sections between keyframes: the same planes (count and axes) slide; otherwise they switch at the keyframe. */
function sectionsBetween(a: SectionPlane[], b: SectionPlane[], k: number): SectionPlane[] {
  if (a.length !== b.length || a.some((p, i) => p.axis !== b[i].axis)) return k >= 1 ? b : a;
  return a.map((p, i) => ({ ...p, at: r4(lerp(p.at, b[i].at, k)) }));
}

/** The latest value of a set-valued property at or before t. */
function latest<T>(keys: TourKeyframe[], t: number, get: (k: TourKeyframe) => T | undefined): T | undefined {
  let v: T | undefined;
  for (const k of keys) {
    if (k.t > t) break;
    const x = get(k);
    if (x !== undefined) v = x;
  }
  return v;
}

/**
 * What the view shows `time` seconds into `tour` (wrapped when it loops,
 * held at the end otherwise). Pure: the same tour, time and context always
 * give the same frame.
 */
export function tourAt(tour: Tour, time: number, ctx: TourContext = {}): TourFrame {
  const keys = tour.keyframes;
  const D = tourDuration(tour);
  const done = !tour.loop && time >= D;
  const t = D <= 0 ? 0 : tour.loop ? ((time % D) + D) % D : Math.min(D, Math.max(0, time));
  let keyframe = 0;
  keys.forEach((k, i) => {
    if (k.t <= t) keyframe = i;
  });
  const frame: TourFrame = { t: r4(t), progress: D > 0 ? r4(t / D) : 1, keyframe, ...(keyframe + 1 < keys.length ? { next: keyframe + 1 } : {}), step: null, callouts: [], done };

  const seg = <T>(get: (k: TourKeyframe) => T | undefined, mix: (a: T, b: T, k: number) => T): T | undefined => {
    const { a, b } = around(keys, t, get);
    if (!a) return b?.v;
    if (!b) return a.v;
    return mix(a.v, b.v, ease(b.k.ease, (t - a.k.t) / Math.max(1e-9, b.k.t - a.k.t)));
  };

  const camera = seg((k) => k.camera, cameraBetween);
  if (camera) frame.camera = camera;

  // explode: the keyframes as a motion clip, sampled at an eased time within the segment
  const ec = explodeClip(tour, ctx);
  if (ec) {
    const s = ec.clip.samples;
    const local = t - ec.t0;
    let i = 0;
    while (i < s.length - 1 && s[i + 1].t <= local) i++;
    let at = local;
    if (i < s.length - 1 && local >= s[i].t) {
      const f = (local - s[i].t) / Math.max(1e-9, s[i + 1].t - s[i].t);
      at = s[i].t + ease(ec.eases[i + 1], f) * (s[i + 1].t - s[i].t);
    }
    const x = sampleClip(ec.clip, Math.max(0, at)).x;
    if (x !== undefined) frame.explode = r4(x);
  }
  const step = latest(keys, t, (k) => k.step?.id ?? (k.explode !== undefined ? null : undefined));
  frame.step = step ?? null;

  const sections = seg((k) => k.sections, sectionsBetween);
  if (sections) frame.sections = sections;
  const hidden = latest(keys, t, (k) => k.hidden);
  if (hidden) frame.hidden = hidden;
  const isolation = latest(keys, t, (k) => k.isolation);
  if (isolation !== undefined) frame.isolation = isolation;
  const highlight = latest(keys, t, (k) => k.highlight);
  if (highlight) frame.highlight = highlight;
  const selection = latest(keys, t, (k) => k.selection);
  if (selection) frame.selection = selection;
  frame.callouts = latest(keys, t, (k) => k.callouts) ?? [];
  const caption = latest(keys, t, (k) => k.caption);
  if (caption !== undefined) frame.caption = caption;
  return frame;
}

/** Evenly spaced sample times over a tour (n >= 2: start and end included), for stills and contact sheets. */
export function tourSampleTimes(tour: Tour, n: number): number[] {
  const D = tourDuration(tour);
  if (n <= 1) return [0];
  return Array.from({ length: n }, (_, i) => r4((D * i) / (n - 1)));
}

/**
 * The view-state writes for a frame (src/api.ts `SetOp`, applied with
 * `store.applyBatch` / `__cad.apply` / the bridge), so a tour drives the
 * same state a person or an agent writes. Callouts and the caption are not
 * view-state keys: they travel in the frame for the annotation layer (W3-B).
 */
export function tourOps(frame: TourFrame): SetOp[] {
  const ops: SetOp[] = [];
  if (frame.camera) ops.push({ op: "set", path: ["camera"], value: frame.camera });
  if (frame.explode !== undefined || frame.step !== null) ops.push({ op: "set", path: ["explode"], value: { t: frame.explode ?? 0, step: frame.step } });
  if (frame.sections) ops.push({ op: "set", path: ["sections"], value: frame.sections });
  if (frame.hidden) ops.push({ op: "set", path: ["visibility", "hidden"], value: frame.hidden });
  if (frame.isolation !== undefined) ops.push({ op: "set", path: ["isolation"], value: frame.isolation });
  if (frame.highlight) ops.push({ op: "set", path: ["highlight"], value: frame.highlight });
  if (frame.selection) ops.push({ op: "set", path: ["selection"], value: frame.selection });
  return ops;
}

// ---------------------------------------------------------------------------
// authoring and validation
// ---------------------------------------------------------------------------

/** A view-state snapshot a tour is authored from (`__cad.get()`, `handle.viewState()`, a named view). */
export interface TourSnapshot {
  state: { camera?: CameraState | null; explode?: { t: number; step?: string | number | null }; sections?: SectionPlane[]; isolation?: string[] | null; highlight?: string[]; selection?: TourKeyframe["selection"]; visibility?: { hidden?: string[] } };
  /** Seconds to move here from the previous snapshot (DEFAULT 2.5) and to stay (DEFAULT 1.5). */
  moveS?: number;
  holdS?: number;
  caption?: string;
  callouts?: TourCallout[];
  ease?: Ease;
}

/** DEFAULT seconds for a snapshot tour. */
export const DEFAULT_MOVE_S = 2.5;
export const DEFAULT_HOLD_S = 1.5;

/** A tour from view-state snapshots: each is reached (move) and then held, in order. */
export function tourFromSnapshots(id: string, snapshots: TourSnapshot[], opts: { title?: string; by?: string; loop?: boolean } = {}): Tour {
  const keyframes: TourKeyframe[] = [];
  let t = 0;
  snapshots.forEach((s, i) => {
    if (i > 0) t += s.moveS ?? DEFAULT_MOVE_S;
    const st = s.state;
    const k: TourKeyframe = { t: r4(t), ...(s.ease ? { ease: s.ease } : {}) };
    if (st.camera) k.camera = st.camera;
    if (st.explode) {
      k.explode = st.explode.t;
      if (typeof st.explode.step === "string") k.step = { id: st.explode.step };
    }
    if (st.sections) k.sections = st.sections;
    if (st.isolation !== undefined) k.isolation = st.isolation;
    if (st.highlight) k.highlight = st.highlight;
    if (st.selection) k.selection = st.selection;
    if (st.visibility?.hidden) k.hidden = st.visibility.hidden;
    if (s.caption !== undefined) k.caption = s.caption;
    if (s.callouts) k.callouts = s.callouts;
    keyframes.push(k);
    const hold = s.holdS ?? DEFAULT_HOLD_S;
    if (hold > 0) {
      t += hold;
      keyframes.push({ ...k, t: r4(t), ease: "hold", caption: undefined, callouts: undefined });
    }
  });
  // a held copy repeats the values: drop what it does not need to repeat (sets carry over by themselves)
  for (const k of keyframes) {
    if (k.caption === undefined) delete k.caption;
    if (k.callouts === undefined) delete k.callouts;
  }
  return { schema: TOUR_SCHEMA, id, ...(opts.title ? { title: opts.title } : {}), ...(opts.by ? { by: opts.by } : {}), ...(opts.loop ? { loop: true } : {}), keyframes };
}

/** DEFAULT limits on a tour handed over as data. */
export const TOUR_LIMITS = { keyframes: 256, durationS: 600, text: 500, callouts: 32, paths: 512 } as const;

const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x));
const isPaths = (v: unknown) => Array.isArray(v) && v.length <= TOUR_LIMITS.paths && v.every((p) => typeof p === "string" && p.length <= 512);
const isText = (v: unknown) => typeof v === "string" && v.length <= TOUR_LIMITS.text;
const EASES: Ease[] = ["linear", "in-out", "in", "out", "hold"];

/** Check and normalise a tour handed over as JSON (keyframes sorted by t); throws with the reason when refused. */
export function parseTour(raw: unknown): Tour {
  if (!raw || typeof raw !== "object") throw new Error("a tour is an object");
  const r = raw as Partial<Tour>;
  if (r.schema !== TOUR_SCHEMA) throw new Error(`schema must be ${TOUR_SCHEMA}`);
  if (typeof r.id !== "string" || !r.id || r.id.length > 200) throw new Error("id must be a short string");
  if (r.title !== undefined && !isText(r.title)) throw new Error("title is too long or not text");
  if (r.by !== undefined && !isText(r.by)) throw new Error("by is too long or not text");
  if (r.duration !== undefined && !(typeof r.duration === "number" && r.duration >= 0 && r.duration <= TOUR_LIMITS.durationS)) throw new Error(`duration must be 0..${TOUR_LIMITS.durationS} s`);
  if (!Array.isArray(r.keyframes) || !r.keyframes.length || r.keyframes.length > TOUR_LIMITS.keyframes) throw new Error(`keyframes: 1 to ${TOUR_LIMITS.keyframes}`);
  const keyframes = r.keyframes.map((k, i) => {
    const at = `keyframes[${i}]`;
    if (!k || typeof k !== "object") throw new Error(`${at} is not an object`);
    if (!(typeof k.t === "number" && k.t >= 0 && k.t <= TOUR_LIMITS.durationS)) throw new Error(`${at}.t must be 0..${TOUR_LIMITS.durationS} s`);
    if (k.ease !== undefined && !EASES.includes(k.ease)) throw new Error(`${at}.ease must be one of ${EASES.join(", ")}`);
    if (k.camera !== undefined && !(k.camera && isVec3(k.camera.position) && isVec3(k.camera.target) && isVec3(k.camera.up))) throw new Error(`${at}.camera needs position, target and up`);
    if (k.explode !== undefined && !(typeof k.explode === "number" && k.explode >= 0 && k.explode <= 1)) throw new Error(`${at}.explode must be 0..1`);
    if (k.step !== undefined && !(k.step && typeof k.step.id === "string" && k.step.id.length > 0 && k.step.id.length <= 200 && (k.step.where === undefined || k.step.where === "before" || k.step.where === "after"))) throw new Error(`${at}.step needs a step id`);
    if (k.sections !== undefined && !(Array.isArray(k.sections) && k.sections.length <= 3 && k.sections.every((s) => s && [0, 1, 2].includes(s.axis) && typeof s.at === "number" && s.at >= 0 && s.at <= 1))) throw new Error(`${at}.sections: up to 3 planes, axis 0..2, at 0..1`);
    for (const key of ["hidden", "highlight"] as const) if (k[key] !== undefined && !isPaths(k[key])) throw new Error(`${at}.${key} must be instance paths`);
    if (k.isolation !== undefined && k.isolation !== null && !isPaths(k.isolation)) throw new Error(`${at}.isolation must be instance paths or null`);
    if (k.caption !== undefined && !isText(k.caption)) throw new Error(`${at}.caption is too long or not text`);
    if (k.callouts !== undefined) {
      if (!Array.isArray(k.callouts) || k.callouts.length > TOUR_LIMITS.callouts) throw new Error(`${at}.callouts: at most ${TOUR_LIMITS.callouts}`);
      for (const c of k.callouts) if (!(c && typeof c.id === "string" && c.id.length <= 200 && typeof c.target === "string" && c.target.length <= 512 && isText(c.text) && (c.at === undefined || isVec3(c.at)))) throw new Error(`${at}.callouts need id, target and text`);
    }
    return k as TourKeyframe;
  });
  keyframes.sort((a, b) => a.t - b.t);
  return { ...(r as Tour), keyframes };
}

/** The tour as JSON text an agent can hand over (stable key order from the object). */
export const serializeTour = (tour: Tour) => JSON.stringify(tour, null, 2);
