/**
 * The viewer's own back and forward (R2-A, walkthrough F1, 2026-11-02). Kevin: "there needs to be a back button;
 * forward and backwards". A place is where the person was: a level (the scope the 3D view shows) and, inside it,
 * what was framed (camera, selection, isolation). In-viewer navigations push a place: drilling into a sub-assembly
 * (a new scope arrives), framing a part from the hierarchy, a double-click that frames in place, the context menu's
 * Frame and Isolate. Back and forward restore the place: in the same level by writing the view state (camera,
 * selection, isolation), across levels by a drill the mount applies (`NavLink.apply`), the level's own camera then
 * coming back with it.
 *
 * One history per page (on the view hub), so it survives the 3D view remounting per level. The host mirrors it
 * (`uhd-viewer:history`) and can drive it (`uhd-viewer:historyGo`).
 */
import type { CameraState, ViewSelection, ViewerEvent, ViewerHistoryEntry, ViewerHistoryState, ViewerHostMessage } from "../../api";
import type { ViewHub } from "../state/hub";

/** DEFAULT (R2-A): places kept; the oldest drops past this. */
export const MAX_HISTORY = 50;

/** One place in the history: what `ViewerHistoryEntry` says, and the view to restore. */
export interface NavPlace extends ViewerHistoryEntry {
  camera?: CameraState | null;
  selection?: ViewSelection;
  isolation?: string[] | null;
}

/** The host channel as navigation uses it (set on the hub by `connectNav`). */
export interface NavLink {
  /** An event to the host (the options' callbacks and a frame's parent). */
  emit: (event: ViewerEvent) => void;
  /** A host message applied in this page (a drill when Back crosses levels). */
  apply?: (message: ViewerHostMessage) => void;
  /** The host answers `uhd-viewer:navigate` (it gave `onNavigate`). */
  navigates?: () => boolean;
  /**
   * The host draws back and forward of its own from `uhd-viewer:history` (it gave `onHistory`; the VS Code tab's
   * header): the 3D view then leaves out its in-page pair, so there is one set (R2 integration, DEFAULT).
   */
  historyButtons?: () => boolean;
}

const sameSel = (a?: ViewSelection, b?: ViewSelection) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});

export class NavHistory {
  private list: NavPlace[] = [];
  private at = -1;
  private listeners = new Set<() => void>();
  /** The place a `go` moves to, until the view has restored it (a level that must load first keeps it set). */
  going: NavPlace | null = null;
  /** Whether places of another level can be reached (a mount that applies drills). */
  canCross: () => boolean = () => false;
  /** The mounted 3D view's view now (camera, selection, isolation): kept on the current place before a move. */
  snapshot?: () => Partial<NavPlace>;
  /** What the next level to arrive was opened as (a part opened in place: kind "open", its name). */
  expect?: { scope: string; label: string; kind: NavPlace["kind"] };

  get index(): number {
    return this.at;
  }
  get length(): number {
    return this.list.length;
  }
  current(): NavPlace | undefined {
    return this.at >= 0 ? this.list[this.at] : undefined;
  }
  /** Every place (copies). */
  places(): NavPlace[] {
    return this.list.map((p) => ({ ...p }));
  }

  /**
   * A new place: the places ahead of the current one drop (as a browser does). A place equal to the current one
   * (same level, kind and selection) replaces it rather than stacking a duplicate.
   */
  push(place: NavPlace): void {
    const cur = this.current();
    if (cur && cur.scope === place.scope && cur.kind === place.kind && sameSel(cur.selection, place.selection) && JSON.stringify(cur.isolation ?? null) === JSON.stringify(place.isolation ?? null)) {
      this.list[this.at] = { ...cur, ...place };
      this.emit();
      return;
    }
    this.list = this.list.slice(0, this.at + 1);
    this.list.push({ ...place });
    if (this.list.length > MAX_HISTORY) this.list = this.list.slice(this.list.length - MAX_HISTORY);
    this.at = this.list.length - 1;
    this.going = null;
    this.emit();
  }

  /** Update the current place with the view as it is left (its camera, selection, isolation). */
  remember(patch: Partial<NavPlace>): void {
    const cur = this.current();
    if (!cur) return;
    this.list[this.at] = { ...cur, ...patch };
  }

  /** The index `delta` steps away that can be reached, or undefined (the ends; a level that cannot be reached). */
  target(delta: number, scopeNow?: string): number | undefined {
    if (!Number.isInteger(delta) || delta === 0) return undefined;
    const to = this.at + delta;
    if (to < 0 || to >= this.list.length) return undefined;
    if (scopeNow !== undefined && this.list[to].scope !== scopeNow && !this.canCross()) {
      // without a drill, only places of this level: skip to the nearest one that way
      const step = delta < 0 ? -1 : 1;
      for (let i = to; i >= 0 && i < this.list.length; i += step) if (this.list[i].scope === scopeNow) return i;
      return undefined;
    }
    return to;
  }

  /** Move `delta` places (Back -1, Forward +1): the place to restore, also left in `going`. */
  go(delta: number, scopeNow?: string): NavPlace | undefined {
    const to = this.target(delta, scopeNow);
    if (to === undefined) return undefined;
    // the place being left keeps the view as it is (Forward comes back to it)
    if (this.snapshot) this.remember(this.snapshot());
    this.at = to;
    this.going = { ...this.list[to] };
    this.emit();
    return this.going;
  }

  state(scopeNow?: string): ViewerHistoryState {
    return {
      index: this.at,
      length: this.list.length,
      canBack: this.target(-1, scopeNow) !== undefined,
      canForward: this.target(1, scopeNow) !== undefined,
      entries: this.list.map((p) => ({ scope: p.scope, label: p.label, kind: p.kind })),
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Tell listeners (the buttons, the host) the history changed. */
  emit(): void {
    for (const l of [...this.listeners]) l();
  }
}

/** The page's history (made on first use). */
export function navOf(hub: ViewHub): NavHistory {
  if (!hub.nav) {
    const nav = new NavHistory();
    nav.canCross = () => Boolean(hub.navLink?.apply);
    hub.nav = nav;
    // the host mirrors it (its header's back and forward)
    nav.subscribe(() => hub.navLink?.emit({ type: "uhd-viewer:history", ...nav.state(hub.store.get().scope) }));
  }
  return hub.nav;
}

/** Whether the host takes `uhd-viewer:navigate`: a library host's `onNavigate`, or a frame parent that said so. */
export const hostNavigates = (hub: ViewHub): boolean => Boolean(hub.navLink?.navigates?.() || hub.hostCaps?.navigate);

/** The host shows back and forward of its own (`onHistory`, or a frame's parent said `history: true`): no in-page pair. */
export const hostDrawsHistory = (hub: ViewHub): boolean => Boolean(hub.navLink?.historyButtons?.() || hub.hostCaps?.history);

/**
 * Connect navigation to the host channel (the mount calls it once; R2-A handoff to `src/viewer/mount.tsx`). Returns
 * the disconnect. The history is reported once at once, then on every change.
 */
export function connectNav(hub: ViewHub, link: NavLink): () => void {
  hub.navLink = link;
  const nav = navOf(hub);
  if (nav.length) link.emit({ type: "uhd-viewer:history", ...nav.state(hub.store.get().scope) });
  return () => {
    if (hub.navLink === link) hub.navLink = undefined;
  };
}

/**
 * The host messages navigation answers (the mount routes them here first; R2-A handoff): `uhd-viewer:historyGo`
 * moves through the history (the mounted 3D view restores the place), `uhd-viewer:hostCapabilities` records what a
 * frame's parent takes. Returns whether the message was one of them.
 */
export function navHostMessage(hub: ViewHub, message: ViewerHostMessage): boolean {
  if (message.type === "uhd-viewer:historyGo") {
    goBack(hub, message.delta);
    return true;
  }
  if (message.type === "uhd-viewer:hostCapabilities") {
    hub.hostCaps = { ...(message.navigate !== undefined ? { navigate: message.navigate } : {}), ...(message.history !== undefined ? { history: message.history } : {}) };
    return true;
  }
  return false;
}

/**
 * Back (-1) or forward (+1): the place moves, and the 3D view (which listens to the history) restores it; a place of
 * another level is reached by a drill (the level's view then restores the rest when it mounts).
 */
export function goBack(hub: ViewHub, delta: number): NavPlace | undefined {
  const nav = navOf(hub);
  const scope = hub.store.get().scope;
  const place = nav.go(delta, scope);
  if (place && place.scope !== scope) hub.navLink?.apply?.({ type: "uhd-viewer:drill", path: place.scope });
  return place;
}
