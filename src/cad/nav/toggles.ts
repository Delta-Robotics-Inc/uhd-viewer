/**
 * Explode and Assemble as two independent on/off toggles (R5-B, 2026-11-02). Kevin: "The explode and assembly buttons
 * are individual on and off toggles, not one or the other." and "If you switch mid animation, the assembly does not
 * autostart; you have to click play to continue."
 *
 * Pure: what the toolbar's two buttons and the void menu's two items show, and what a press asks of the motion
 * controller (R5-A's `MotionController`, ../sequence/motion.ts). A press only ever sets its own flag; CadView never
 * calls `play` (the controller decides: a switch while moving or paused mid-way leaves the pose paused). Both off:
 * the timeline panel closes.
 */

/** The two toggles, each on or off on its own. */
export interface MotionToggles {
  explode: boolean;
  assemble: boolean;
}

export type MotionToggle = keyof MotionToggles;

/** The view state's `explode` slice as the toggles read it (`on` and `assemble` once the slice carries them). */
export interface ExplodeSliceLike {
  t: number;
  mode?: "radial" | "sequence";
  step?: string | null;
  /** R5: the Explode toggle, written by the toolbar, the void menu, an agent's `explode` op. */
  on?: boolean;
  /** R5: the Assemble toggle. */
  assemble?: boolean;
}

/**
 * The toggles a view state shows. The explicit flags win; a state written before R5 (a saved view, an older host's
 * `explode {t, mode}`) reads as: Explode on when apart radially, Assemble on when apart in the steps (DEFAULT).
 */
export function togglesOf(ex: ExplodeSliceLike): MotionToggles {
  const apart = ex.t > 0;
  const mode = ex.mode ?? (ex.step ? "sequence" : "radial");
  return {
    explode: typeof ex.on === "boolean" ? ex.on : apart && mode === "radial",
    assemble: typeof ex.assemble === "boolean" ? ex.assemble : apart && mode === "sequence",
  };
}

/** A press on one toggle: that one flips, the other is left as it is. */
export function flipToggle(t: MotionToggles, which: MotionToggle): MotionToggles {
  return { ...t, [which]: !t[which] };
}

/** The timeline panel is wanted while either toggle is on; both off closes it. */
export function timelineOpenFor(t: MotionToggles): boolean {
  return t.explode || t.assemble;
}

/**
 * What the toolbar and the void menu call (R5-A's controller, ../sequence; the R5-B side of handoffs.md). Only the two
 * setters are the toggles' business; `play` is listed so tests can prove a toggle never reaches it.
 */
export interface ToggleController {
  setExplode(on: boolean): unknown;
  setAssemble(on: boolean): unknown;
  play?(...args: unknown[]): unknown;
}

/** Apply one press: flip `which` and hand the new flag to the controller (never `play`). Returns the new toggles. */
export function pressToggle(ctrl: ToggleController | null | undefined, now: MotionToggles, which: MotionToggle): MotionToggles {
  const next = flipToggle(now, which);
  if (ctrl) {
    if (which === "explode") ctrl.setExplode(next.explode);
    else ctrl.setAssemble(next.assemble);
  }
  return next;
}

/** The tooltips (Kevin's words for the two buttons). */
export const EXPLODE_TIP = "Explode";
export const ASSEMBLE_TIP = "Assemble";

/** A toggle's tooltip: its name only (DEFAULT, Kevin's words); on or off is the button's pressed state (`aria-pressed`). */
export function toggleTip(which: MotionToggle): string {
  return which === "explode" ? EXPLODE_TIP : ASSEMBLE_TIP;
}

