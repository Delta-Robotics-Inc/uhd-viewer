/**
 * How the pointer and the keyboard act on the diagram: which tool is chosen
 * (select or pan), what a drag on the empty canvas does with it, and the
 * canvas's keys. No React and no DOM here, so the rules are tested as data.
 *
 * - Select (the default): a left-drag on the empty canvas draws a selection
 *   box; a middle-button drag pans; holding Space makes a left-drag pan,
 *   also one that starts on a module (modules are not dragged while it is held).
 * - Pan: a left-drag pans, also over modules (they are not dragged).
 * - With either tool, a right-drag pans, over the empty canvas, modules and
 *   links; a right-click that does not move (`rightPress`) opens the menu.
 * - The wheel and a pinch zoom with either tool.
 */

export type CanvasTool = "select" | "pan";

export interface InteractionState {
  tool: CanvasTool;
  /** Space is held: a left-drag pans while it is. */
  space: boolean;
}

export type InteractionAction = { type: "tool"; tool: CanvasTool } | { type: "toggle" } | { type: "space"; down: boolean } | { type: "blur" };

export const initialInteraction: InteractionState = { tool: "select", space: false };

export function interactionReducer(state: InteractionState, action: InteractionAction): InteractionState {
  switch (action.type) {
    case "tool":
      return state.tool === action.tool ? state : { ...state, tool: action.tool };
    case "toggle":
      return { ...state, tool: state.tool === "select" ? "pan" : "select" };
    case "space":
      return state.space === action.down ? state : { ...state, space: action.down };
    // a key released while the window was away never arrives
    case "blur":
      return state.space ? { ...state, space: false } : state;
  }
}

/** Mouse buttons: left, middle. */
const LEFT = 0;
const MIDDLE = 1;

export interface InteractionProps {
  /** `true`: every button pans; a list: only these buttons do. */
  panOnDrag: true | number[];
  /** A left-drag on the empty canvas draws a selection box. */
  selectionOnDrag: boolean;
  nodesDraggable: boolean;
  /** What the pointer looks like over the empty canvas. */
  cursor: "default" | "grab";
}

/** What React Flow is told for a state: the tool, and Space held over it. */
export function interactionProps(state: InteractionState): InteractionProps {
  if (state.tool === "pan") return { panOnDrag: true, selectionOnDrag: false, nodesDraggable: false, cursor: "grab" };
  // Space held: a left-drag that starts on a module pans too, as with the pan tool (PB-1037)
  if (state.space) return { panOnDrag: [LEFT, MIDDLE], selectionOnDrag: false, nodesDraggable: false, cursor: "grab" };
  return { panOnDrag: [MIDDLE], selectionOnDrag: true, nodesDraggable: true, cursor: "default" };
}

/** The right button: a drag with it pans, a click opens the menu. */
export const RIGHT = 2;
/** How far (px) the pointer may move with the right button down and still be a click. */
export const CLICK_SLOP = 4;

/** The right button held on the canvas: where it went down, and whether it has become a pan. */
export interface RightPress {
  x: number;
  y: number;
  panning: boolean;
}

export const rightPress = (x: number, y: number): RightPress => ({ x, y, panning: false });

/**
 * The press after the pointer moved to (x, y): a pan once it has gone further
 * than the slop from where it went down, and a pan from then on, also if it
 * comes back (a drag that returns to its start is still not a click).
 */
export function rightMove(press: RightPress, x: number, y: number, slop = CLICK_SLOP): RightPress {
  if (press.panning || Math.hypot(x - press.x, y - press.y) <= slop) return press;
  return { ...press, panning: true };
}

/** What letting go of the right button does: open the menu (a click) or nothing more (a pan, which already moved the view). */
export const rightRelease = (press: RightPress): "menu" | "pan" => (press.panning ? "pan" : "menu");

/** The tool toggle's two choices (Lucide icons), each with its key. */
export const TOOL_OPTIONS = [
  { id: "select", icon: "mouse-pointer-2", label: "Select", shortcut: "V" },
  { id: "pan", icon: "hand", label: "Pan", shortcut: "H" },
] as const satisfies readonly { id: CanvasTool; icon: string; label: string; shortcut: string }[];

/** What a key press asks of the canvas. */
export type CanvasCommand =
  | { type: "tool"; tool: CanvasTool }
  | { type: "selectAll" }
  | { type: "escape" }
  | { type: "fit" }
  | { type: "zoom"; by: "in" | "out" | "reset" }
  | { type: "nudge"; dx: number; dy: number };

export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/**
 * The canvas command of a key press, or undefined for a key the canvas
 * leaves alone. Keys with Ctrl or Cmd other than select-all are the host's
 * (an editor's own zoom, save, undo); Alt is never taken.
 */
export function canvasCommand(e: KeyLike, grid = 16): CanvasCommand | undefined {
  if (e.altKey) return undefined;
  const mod = Boolean(e.ctrlKey || e.metaKey);
  if (mod) return !e.shiftKey && e.key.toLowerCase() === "a" ? { type: "selectAll" } : undefined;
  const arrow = ARROWS[e.key];
  if (arrow) {
    const step = e.shiftKey ? grid * 4 : grid;
    // (`|| 0`: no negative zero in what a test compares)
    return { type: "nudge", dx: arrow[0] * step || 0, dy: arrow[1] * step || 0 };
  }
  switch (e.key) {
    case "Escape":
      return { type: "escape" };
    case "v":
    case "V":
      return { type: "tool", tool: "select" };
    case "h":
    case "H":
      return { type: "tool", tool: "pan" };
    case "f":
    case "F":
      return { type: "fit" };
    case "+":
    case "=":
      return { type: "zoom", by: "in" };
    case "-":
    case "_":
      return { type: "zoom", by: "out" };
    case "0":
      return { type: "zoom", by: "reset" };
    default:
      return undefined;
  }
}

/**
 * Keys typed into a field, or pressed on a control that uses them, are not the
 * canvas's: a menu, a dialog (the legend's popover), and a tree or list that walks its rows with the arrows and
 * filters as you type (the hierarchy panel). The canvas listens on the window
 * before them, so without this an arrow on a hierarchy row nudged the selected
 * module and a letter switched the tool (UI QA phase 3).
 */
export function typingTarget(target: { closest?: (selector: string) => unknown } | null | undefined): boolean {
  return Boolean(target?.closest?.("input, textarea, select, [contenteditable='true'], [role='menu'], [role='dialog'], [role='tree'], [role='listbox'], [role='grid']"));
}

/**
 * The nodes selected after React Flow's selection changes (a box drag, a
 * click with Shift, Ctrl or Cmd held, a plain click): what was selected, with
 * the changes applied, each named by `canonical` (a supply rail's taps are
 * the rail), once.
 */
export function applySelectChanges(selected: Iterable<string>, changes: readonly { id: string; selected: boolean }[], canonical: (id: string) => string = (id) => id): string[] {
  const next = new Set(selected);
  for (const c of changes) {
    if (c.selected) next.add(c.id);
    else next.delete(c.id);
  }
  return [...new Set([...next].map(canonical))];
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface FirstViewState {
  /** The viewport saved for this level (the user's last pan or zoom there). */
  saved?: Viewport;
  /** The saved viewport was put back since the canvas mounted. */
  restored: boolean;
  /** The user panned or zoomed since the canvas mounted (or a host moved the view to something). */
  moved: boolean;
  /** What is drawn: changes when modules come or go. */
  nodesKey: string;
  /** What was drawn at the last automatic fit (null: none yet). */
  fittedKey: string | null;
  /** The canvas has a size (a tab opened in the background has none yet). */
  sized: boolean;
  /** The canvas's size now and at the last automatic fit (`w×h`): a panel docked beside it or folded changes it. */
  size?: string;
  fittedSize?: string | null;
}

/**
 * What the canvas does with its view when it opens or its modules change:
 * a saved viewport is put back, once; with none, the diagram is fitted, and
 * fitted again when modules come or go or the canvas changes size (a panel
 * docked beside it opens or folds), until the user moves the view.
 */
export function firstView(s: FirstViewState): { kind: "restore"; viewport: Viewport } | { kind: "fit" } | { kind: "keep" } {
  if (!s.sized) return { kind: "keep" };
  if (s.saved) return s.restored ? { kind: "keep" } : { kind: "restore", viewport: s.saved };
  if (s.moved || !s.nodesKey) return { kind: "keep" };
  // the same modules in a canvas of the same size: the fit stands
  if (s.nodesKey === s.fittedKey && (s.size === undefined || s.size === s.fittedSize)) return { kind: "keep" };
  return { kind: "fit" };
}

export const validViewport = (v: unknown): v is Viewport => {
  const o = v as Viewport | null;
  return typeof o === "object" && o !== null && [o.x, o.y, o.zoom].every((n) => typeof n === "number" && Number.isFinite(n)) && o.zoom > 0;
};
