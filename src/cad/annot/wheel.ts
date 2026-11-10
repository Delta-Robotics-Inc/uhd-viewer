/**
 * Wheel over a callout, a marker or an exploded-view label zooms the view (R1-C, review item D2). The sheets,
 * pins, marker targets and labels take pointer events (hover, click), so a wheel over one stopped there and never
 * reached the canvas's OrbitControls: Kevin saw the zoom hold for 6 s while the pointer sat on a callout. The layer
 * listens for `wheel` on its own root (events from every child bubble to it), cancels the page's scroll, and
 * dispatches a copy of the event on the renderer's canvas, so the controls zoom exactly as they would have (same
 * deltas, mode, pointer position for zoom-to-cursor, modifier keys for a pinch). Hover and click stay on the
 * sheets.
 */

/** The fields of a WheelEvent the controls read, as an init dict for a copy. */
export function wheelInit(e: WheelEvent): WheelEventInit {
  return {
    bubbles: true,
    cancelable: true,
    composed: true,
    deltaX: e.deltaX,
    deltaY: e.deltaY,
    deltaZ: e.deltaZ,
    deltaMode: e.deltaMode,
    clientX: e.clientX,
    clientY: e.clientY,
    screenX: e.screenX,
    screenY: e.screenY,
    ctrlKey: e.ctrlKey,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
    buttons: e.buttons,
  };
}

type WheelCtor = new (type: string, init: WheelEventInit) => Event;

/** Re-dispatches `e` on `target` (a copy: a dispatched event cannot be sent again) and stops the original. */
export function forwardWheel(e: WheelEvent, target: EventTarget | null | undefined, Ctor?: WheelCtor): boolean {
  if (!target || e.target === target) return false;
  const C = Ctor ?? ((globalThis as { WheelEvent?: WheelCtor }).WheelEvent as WheelCtor | undefined);
  if (!C) return false;
  // the page must not scroll under the view, and the host's own wheel listeners see one event (the copy), not two
  e.preventDefault();
  e.stopPropagation();
  target.dispatchEvent(new C("wheel", wheelInit(e)));
  return true;
}

/**
 * Listens for wheel events on `el` (not passive: the page scroll is cancelled) and forwards them to `target()`,
 * read at event time (the canvas may be replaced). Returns the remover.
 */
export function attachWheelForward(el: EventTarget, target: () => EventTarget | null | undefined, Ctor?: WheelCtor): () => void {
  const on = (e: Event) => void forwardWheel(e as WheelEvent, target(), Ctor);
  el.addEventListener("wheel", on, { passive: false });
  return () => el.removeEventListener("wheel", on);
}

/** The renderer's canvas in a view container (createScene appends it as a direct child). */
export function canvasIn(container: Element | null | undefined): HTMLCanvasElement | null {
  if (!container) return null;
  for (const c of Array.from(container.children)) if (c.tagName === "CANVAS") return c as HTMLCanvasElement;
  return container.querySelector("canvas");
}
