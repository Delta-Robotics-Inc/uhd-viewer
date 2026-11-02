/**
 * The menu for a right-click in empty space (R4-A, 2026-11-02). Kevin: "right-clicking in empty space in the void
 * should still open up the menu with universal options, not part-specific options, such as unisolate or show
 * everything. Something not specific to the model." Pure: what the menu lists for the view as it is now.
 */
import type { MenuItem } from "./target";
import { toggleTip, togglesOf, type MotionToggles } from "./toggles";

/** What the void menu needs to know about the view now. */
export interface VoidMenuInput {
  /** Paths hidden one by one (the view state's `visibility.hidden`). */
  hidden: number;
  /** An isolation is in force. */
  isolated: boolean;
  /** Apart at all (the explode's t > 0). */
  exploded: boolean;
  /** How the parts come apart now (the toolbar's two controls). */
  mode: "radial" | "sequence";
  /** R5-B: the toolbar's two independent toggles as shown. Absent: read from `exploded` and `mode` (./toggles.ts). */
  toggles?: MotionToggles;
  /** A section view is on. */
  section: boolean;
  /** The floor grid (R4-B's state), when it reports one. */
  grid?: { on: boolean };
  /** The scale reference (R4-B's state), when it reports one: on or off, and which object. */
  scaleRef?: { on: boolean; choice: string };
  /** Why the view cannot be captured here, or true when it can. */
  capture: true | string;
}

/** DEFAULT (R4-A): the void menu's title (the part menu's title names the part). */
export const VOID_MENU_TITLE = "View";

/**
 * The universal items, in order (R4-A): Show all, Unisolate (only while isolated), Fit, Reset view, Explode and
 * Assemble (R5-B: two checkbox items, as the toolbar's two independent toggles read now), Section view off (only while on), Grid, Scale reference,
 * Capture image. None of them names a part.
 */
export function voidMenuFor(o: VoidMenuInput): MenuItem[] {
  // R5-B: two checkbox items matching the toolbar's two independent toggles
  const t = o.toggles ?? togglesOf({ t: o.exploded ? 1 : 0, mode: o.mode });
  const items: MenuItem[] = [
    { id: "showAll", label: "Show all", icon: "eye", ...(o.hidden || o.isolated ? {} : { disabled: "Nothing is hidden or isolated" }) },
  ];
  if (o.isolated) items.push({ id: "unisolate", label: "Unisolate", icon: "focus" });
  items.push({ id: "fit", label: "Fit", icon: "scan", rule: true }, { id: "reset", label: "Reset view", icon: "rotate-ccw" });
  items.push(
    { id: "explode", label: toggleTip("explode"), icon: "move-diagonal", rule: true, checked: t.explode },
    { id: "assemble", label: toggleTip("assemble"), icon: "layers", checked: t.assemble },
  );
  if (o.section) items.push({ id: "sectionOff", label: "Section view off", icon: "scissors" });
  // the on/off items are checkboxes whether on or off (wave R4 gate: the role flipped between menuitem and menuitemcheckbox)
  let ruled = false;
  if (o.grid) {
    // wave R5 gate: a checkbox item is named by what it shows (its check mark says whether it is on), as Explode and
    // Assemble are; "Grid off" with a check mark read as "the grid is off"
    items.push({ id: "grid", label: "Grid", icon: "grid-3x3", rule: true, checked: o.grid.on });
    ruled = true;
  }
  if (o.scaleRef) {
    const what = o.scaleRef.choice ? ` (${o.scaleRef.choice})` : "";
    items.push({ id: "scaleRef", label: `Scale reference${what}`, icon: "ruler", ...(ruled ? {} : { rule: true }), checked: o.scaleRef.on });
  }
  items.push({ id: "capture", label: "Capture image", icon: "camera", rule: true, ...(o.capture === true ? {} : { disabled: o.capture }) });
  return items;
}
