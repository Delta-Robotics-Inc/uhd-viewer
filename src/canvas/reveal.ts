/**
 * Bringing a host's selection into view (a host's select, such as a DRC
 * finding's Locate): where the selection is drawn, and the viewport that shows
 * it clear of the floating chrome, or none when it is in view already.
 */
import type { ComputedLayout } from "../layout/layout";
import type { ViewModel } from "../model/types";
import type { Pt } from "./routing";

/** A selection on the level, as the canvas holds it. */
export type RevealSelection = { kind: "node" | "link"; id: string };

export type Rect = { x0: number; y0: number; x1: number; y1: number };

/** Where a selection is drawn, in flow coordinates: a node's box, or every line of a link (a derived link: the lines it runs over). */
export function selectionBounds(vm: ViewModel, layout: ComputedLayout, selection: RevealSelection): Rect | undefined {
  const pts: Pt[] = [];
  if (selection.kind === "node") {
    const b = layout.boxes[selection.id];
    if (b) pts.push([b.x, b.y], [b.x + b.w, b.y + b.h]);
  } else {
    const derived = vm.derived.find((d) => d.id === selection.id);
    const ids = new Set(derived ? derived.via : [selection.id]);
    for (const l of vm.links) if (ids.has(l.linkId) || ids.has(l.id)) pts.push(...(layout.routes[l.id] ?? []));
  }
  if (!pts.length) return undefined;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** Where several lines are drawn together (a harness along the lines that carry it), in flow coordinates. */
export function linesBounds(layout: ComputedLayout, lineIds: readonly string[]): Rect | undefined {
  const pts = lineIds.flatMap((id) => layout.routes[id] ?? []);
  if (!pts.length) return undefined;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** The part of the pane clear of the floating chrome (the inspector too, when open). */
function clearView(pane: { width: number; height: number }, inspector: boolean): Rect {
  const left = 64;
  const top = 56;
  const bottom = 72;
  // the inspector card never takes more than the view minus the rail (narrow hosts)
  const right = inspector ? Math.max(64, Math.min(376, pane.width - left - 160)) : 64;
  return { x0: left, y0: top, x1: pane.width - right, y1: pane.height - bottom };
}

/**
 * The viewport that frames `rect`, as a module is framed when it is focused:
 * centred in the view clear of the floating chrome, zoomed to fit it, never
 * past `maxZoom`.
 */
export function frameViewport(
  rect: Rect,
  pane: { width: number; height: number },
  inspector: boolean,
  { maxZoom = 1, minZoom = 0.2 }: { maxZoom?: number; minZoom?: number } = {},
): { x: number; y: number; zoom: number } {
  const MARGIN = 24;
  const view = clearView(pane, inspector);
  const w = Math.max(1, view.x1 - view.x0 - 2 * MARGIN);
  const h = Math.max(1, view.y1 - view.y0 - 2 * MARGIN);
  const zoom = Math.max(minZoom, Math.min(maxZoom, w / Math.max(1, rect.x1 - rect.x0), h / Math.max(1, rect.y1 - rect.y0)));
  const cx = (rect.x0 + rect.x1) / 2;
  const cy = (rect.y0 + rect.y1) / 2;
  return { x: (view.x0 + view.x1) / 2 - cx * zoom, y: (view.y0 + view.y1) / 2 - cy * zoom, zoom };
}

/**
 * The viewport that shows `rect` clear of the floating chrome (the inspector
 * too, when open), or undefined when it is in view already. It keeps the zoom
 * and pans, zooming out only as far as the selection needs; never in.
 */
export function revealViewport(
  rect: Rect,
  viewport: { x: number; y: number; zoom: number },
  pane: { width: number; height: number },
  inspector: boolean,
  minZoom = 0.2,
): { x: number; y: number; zoom: number } | undefined {
  const MARGIN = 24;
  const view = clearView(pane, inspector);
  const z = viewport.zoom;
  const on = { x0: rect.x0 * z + viewport.x, y0: rect.y0 * z + viewport.y, x1: rect.x1 * z + viewport.x, y1: rect.y1 * z + viewport.y };
  if (on.x0 >= view.x0 && on.y0 >= view.y0 && on.x1 <= view.x1 && on.y1 <= view.y1) return undefined;
  const w = Math.max(1, view.x1 - view.x0 - 2 * MARGIN);
  const h = Math.max(1, view.y1 - view.y0 - 2 * MARGIN);
  const zoom = Math.max(minZoom, Math.min(z, w / Math.max(1, rect.x1 - rect.x0), h / Math.max(1, rect.y1 - rect.y0)));
  const cx = (rect.x0 + rect.x1) / 2;
  const cy = (rect.y0 + rect.y1) / 2;
  return { x: (view.x0 + view.x1) / 2 - cx * zoom, y: (view.y0 + view.y1) / 2 - cy * zoom, zoom };
}
