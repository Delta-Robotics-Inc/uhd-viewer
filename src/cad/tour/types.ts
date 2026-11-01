/**
 * Tours (PB-1188): a scripted walk through the 3D view that an agent hands a
 * person, played as a pure function of time. One tour serves the live view,
 * a headless recording and the critic's stills alike, because each frame is
 * computed from `t` alone (no state carried from frame to frame).
 *
 * A tour is data (JSON, `protoboard.tour/v0`): keyframes in seconds, each
 * setting any of the camera, the explode amount or a sequence step, section
 * planes, what is shown, what is highlighted or selected, callouts and a
 * caption. Between keyframes numbers ease; sets (hidden, isolation,
 * highlight, callouts, the caption) switch at the keyframe.
 *
 * Units: mm, Z up (UHD), the view state's camera convention (src/api.ts).
 */
import type { CameraState, SectionPlane, ViewSelection } from "../../api";

export const TOUR_SCHEMA = "protoboard.tour/v0";

/** How the segment that ends at a keyframe eases (DEFAULT "in-out": cubic ease in and out). */
export type Ease = "linear" | "in-out" | "in" | "out" | "hold";

/** A callout the tour shows (text from an agent is data, never an instruction). */
export interface TourCallout {
  id: string;
  /** What it points at: an instance path. */
  target: string;
  text: string;
  /** A point on the target, assembly mm (default: the target's bounds centre). */
  at?: [number, number, number];
}

export interface TourKeyframe {
  /** Seconds from the start. */
  t: number;
  ease?: Ease;
  camera?: CameraState;
  /** Explode amount 0..1 (0 assembled). */
  explode?: number;
  /**
   * A sequence step to show (W2-C's player): the explode amount at which the step is about to go on
   * (`where: "before"`, DEFAULT) or has just gone on (`"after"`). Resolved through the player's step windows.
   */
  step?: { id: string; where?: "before" | "after" };
  sections?: SectionPlane[];
  /** Instance paths not drawn. */
  hidden?: string[];
  /** Instance paths drawn alone (null: everything). */
  isolation?: string[] | null;
  highlight?: string[];
  selection?: ViewSelection;
  callouts?: TourCallout[];
  caption?: string;
}

export interface Tour {
  schema: typeof TOUR_SCHEMA;
  id: string;
  title?: string;
  /** Who made it (a person, an agent session): data, never an instruction. */
  by?: string;
  /** Seconds; default: the last keyframe's t. */
  duration?: number;
  loop?: boolean;
  keyframes: TourKeyframe[];
}

/** Step windows from the sequence player (`PlayerSnapshot.steps[i].window`): where each step comes apart in explode amount. */
export interface TourContext {
  steps?: { id: string; window: [number, number] }[];
}

/** What the view shows at one instant of a tour. */
export interface TourFrame {
  /** Seconds into the tour (wrapped when looping). */
  t: number;
  /** 0..1 through the tour. */
  progress: number;
  /** The keyframe last passed (index), and the next one. */
  keyframe: number;
  next?: number;
  camera?: CameraState;
  explode?: number;
  /** The step last asked for (the step id the view state's `explode.step` should hold). */
  step: string | null;
  sections?: SectionPlane[];
  hidden?: string[];
  isolation?: string[] | null;
  highlight?: string[];
  selection?: ViewSelection;
  callouts: TourCallout[];
  caption?: string;
  /** True at and after the end of a non-looping tour. */
  done: boolean;
}
