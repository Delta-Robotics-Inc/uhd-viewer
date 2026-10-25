/**
 * The right button on the diagram: a drag pans the view, a click (the pointer
 * moved no further than `CLICK_SLOP`) opens the canvas's menu where it was
 * let go. No DOM here: the canvas feeds it the pointer's events and does what
 * it returns, so the order browsers send them in is tested as data.
 *
 * Browsers send `contextmenu` at different moments: on Linux and macOS when
 * the button goes down (before anyone knows whether it will be a drag), on
 * Windows after it comes up. So the canvas never lets the browser's menu (or
 * a VS Code webview's) open over what has a menu of its own: `contextmenu`
 * is cancelled, and the menu opens on release, only when the press was a
 * click. A `contextmenu` with no right press behind it (the keyboard's menu
 * key, Shift+F10, Ctrl+click on a Mac) opens the menu at once.
 */
import { RIGHT, rightMove, rightPress, rightRelease, type RightPress, type Viewport } from "./interaction";

/** After a release, the `contextmenu` that Windows sends belongs to it for this long (ms). */
const AFTER_RELEASE = 500;

export interface RightDragHost<T> {
  viewport(): Viewport;
  setViewport(viewport: Viewport): void;
  /** A pan by the right button began. */
  panStart?(): void;
  /** A pan by the right button ended, at this viewport. */
  panEnd(viewport: Viewport): void;
  /** The canvas has a menu of its own for what is at this target (a module, a link, the empty canvas). */
  hasMenu(target: T): boolean;
  /** Open the canvas's menu for the target, at the pointer. */
  openMenu(target: T, x: number, y: number): void;
  /** The time now (ms); default `performance.now()`. */
  now?(): number;
}

export interface PointerLike<T> {
  button: number;
  /** The buttons held (a pointer move): a release the canvas did not see ends the press. */
  buttons?: number;
  x: number;
  y: number;
  target: T;
}

export interface RightDrag<T> {
  /** A button went down on the canvas: true when it is the right one (the press is the canvas's). */
  down(e: PointerLike<T>): boolean;
  /** The pointer moved: true while the press pans. */
  move(e: Omit<PointerLike<T>, "button" | "target">): boolean;
  /** A button came up: what the press was, if it was a right one. */
  up(e: PointerLike<T>): "menu" | "pan" | undefined;
  /** The browser asks to show its menu: true to cancel it (the canvas has its own, now or on release). */
  contextMenu(e: Omit<PointerLike<T>, "button">): boolean;
  /** Forget the press (the window lost focus). */
  cancel(): void;
  readonly panning: boolean;
}

export function createRightDrag<T>(host: RightDragHost<T>): RightDrag<T> {
  const now = host.now ?? (() => performance.now());
  let press: (RightPress & { start: Viewport; target: T }) | null = null;
  /** The last release: when, and whether the browser's menu that may follow it is cancelled (a pan, or a menu of the canvas's opened). */
  let released = { at: -Infinity, cancel: false };

  const finish = (x: number, y: number): "menu" | "pan" => {
    const p = press!;
    press = null;
    const what = rightRelease(p);
    const own = what === "menu" && host.hasMenu(p.target);
    released = { at: now(), cancel: what === "pan" || own };
    if (what === "pan") host.panEnd(host.viewport());
    else if (own) host.openMenu(p.target, x, y);
    return what;
  };

  return {
    down(e) {
      if (e.button !== RIGHT) return false;
      press = { ...rightPress(e.x, e.y), start: host.viewport(), target: e.target };
      return true;
    },
    move(e) {
      if (!press) return false;
      // the button came up where the canvas did not hear it (outside the window): the pan ends there, with no menu
      if (e.buttons !== undefined && (e.buttons & 2) === 0) {
        if (press.panning) finish(e.x, e.y);
        else press = null;
        return false;
      }
      const was = press.panning;
      press = { ...press, ...rightMove(press, e.x, e.y) };
      if (!press.panning) return false;
      if (!was) host.panStart?.();
      const { start } = press;
      host.setViewport({ x: start.x + (e.x - press.x), y: start.y + (e.y - press.y), zoom: start.zoom });
      return true;
    },
    up(e) {
      if (e.button !== RIGHT || !press) return undefined;
      return finish(e.x, e.y);
    },
    contextMenu(e) {
      // a press under way: the menu opens on release if it stays a click (Linux, macOS)
      if (press) return press.panning || host.hasMenu(press.target);
      // just after a release (Windows): it opened the menu then, or it was a pan
      if (now() - released.at < AFTER_RELEASE) {
        const { cancel } = released;
        released = { at: -Infinity, cancel: false };
        return cancel;
      }
      if (!host.hasMenu(e.target)) return false;
      host.openMenu(e.target, e.x, e.y);
      return true;
    },
    cancel() {
      press = null;
    },
    get panning() {
      return press?.panning ?? false;
    },
  };
}
