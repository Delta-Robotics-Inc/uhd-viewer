/**
 * What a press-and-release on the 3D canvas does (R5-B, 2026-11-02). Pure, so the rule is tested without a scene.
 *
 * Kevin: "Clicking the void should deselect callouts." A click is a press whose pointer never wandered more than
 * `CLICK_TOLERANCE_PX` (the rule CadView had since R1-C: a drag, even one that ends where it began, orbits or pans and
 * changes nothing). A click on empty space clears the part selection (as before) and now also the selected callouts:
 * the pinned finding cards and the Findings control's current finding. A right-click on empty space keeps both and
 * opens the view's menu (R4-A DEFAULT, ./void.ts). With the Measure tool on, a click is the tool's.
 */

/** A press that wanders further than this (CSS px) is a drag, not a click (DEFAULT since R1-C). */
export const CLICK_TOLERANCE_PX = 4;

export type ReleaseAction =
  /** A drag (orbit, pan): nothing is selected or cleared. */
  | "drag"
  /** The Measure tool takes the click (a left click picks a point; any other button does nothing). */
  | "measure"
  /** A right-click on empty space: the view's menu; the selection and the callouts stay (R4-A DEFAULT). */
  | "voidMenu"
  /** A click on empty space: the part selection and the selected callouts are cleared (R5-B). */
  | "deselect"
  /** A click on something: it is selected (a right-click also opens its menu). */
  | "select";

export interface Release {
  /** The furthest the pointer got from where it was pressed, CSS px (the release point included). */
  far: number;
  /** `PointerEvent.button` of the press: 0 left, 1 middle, 2 right. */
  button: number;
  /** The Measure tool is on. */
  measuring: boolean;
  /** Something was under the pointer (a part, a component, a harness, a mate). */
  hit: boolean;
}

/** What a release does (CadView's canvas `pointerup`). */
export function releaseAction(r: Release): ReleaseAction {
  if (r.far > CLICK_TOLERANCE_PX) return "drag";
  if (r.measuring) return "measure";
  if (r.hit) return "select";
  // DEFAULT (R5-B): a middle click on empty space clears as a left click does (it cleared the parts before too)
  return r.button === 2 ? "voidMenu" : "deselect";
}

/** The selected callouts: the finding cards pinned open, and the Findings control's current finding. */
export interface CalloutSelection {
  open: ReadonlySet<string>;
  current?: string;
}

/** True when a void click has callouts to clear (so a click with none selected changes no React state). */
export function hasCalloutSelection(s: CalloutSelection): boolean {
  return s.open.size > 0 || s.current !== undefined;
}
