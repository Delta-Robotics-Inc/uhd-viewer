/**
 * The page's view store (PB-1178): one per window, made on first use from
 * the page's URL, so the 3D view, the host handle, the host messages and the
 * live-tab bridge share it. The 3D view mounts and unmounts as the user
 * switches views and modules; the store outlives it (`enterScope` keeps each
 * module's camera and selection), so a bridge batch sent while the diagram
 * is shown still lands and shows when the 3D view comes back.
 *
 * DEFAULT: one store per window. A page holding several viewers (none does
 * today: the VS Code tabs are a window each, `protoboard dev` shows one)
 * would share it; a viewer of its own would pass its own store to CadView.
 */
import { createViewStore, type Actor, type ViewStore } from "./store";
import { fromUrlParams, type UrlOpening } from "./serialize";
import type { WritableKey } from "./schema";
import type { PlacementFacts, SetOp, ViewerSavePoint, ViewerSequenceCommand, ViewerSequenceReply, ViewerSnapshotMessage } from "../../api";
import type { PlacementVerb } from "./bridge";

export interface ViewHub {
  store: ViewStore;
  /** How the URL asked the view to open (read once). */
  opening: UrlOpening;
  /** What the 3D view draws, as data, while it is mounted (`__cad.observe`). */
  observer?: (opts?: { components?: boolean }) => unknown;
  /** Which view the page shows, when the shell reports it. */
  view?: "3d" | "diagram";
  /** The mounted 3D view's sequence player (W2-C), for host commands. */
  sequence?: (command: ViewerSequenceCommand) => ViewerSequenceReply;
  /** The host's snapshot of a tab (PB-1180), kept until the 3D view of that level opens and goes live. */
  snapshot?: ViewerSnapshotMessage;
  /** The 3D view listens for a snapshot that arrives after it mounted. */
  onSnapshot?: (s: ViewerSnapshotMessage) => void;
  /** The mounted 3D view's quality curve (W2-B): configure it, read its report. */
  quality?: (config: Record<string, unknown>) => unknown;
  /** The host keeps save points (`ViewerOptions.onSavePoint`). */
  savePoint?: (p: ViewerSavePoint) => void;
  /** What the mounted 3D view draws at a point (`__cad.pick`): the bridge's pick probes (W4-D, the critic). */
  pick?: (fx: number, fy: number) => unknown;
  /** The drawn label boxes (`__cad.labels()`): the bridge's label probe (W4-D). */
  labels?: () => unknown[];
  /** The 3D canvas in CSS px (the critic measures label boxes against it). */
  canvas?: () => { width: number; height: number };
  /** The person's explicit "Save callouts" (W4-D, D10): the host writes the annotations to the display file. */
  saveCallouts?: () => void;
  /** Resolves a placement verb against the scene's faces (W4-D, PB-1187): one `set` on `placements` and its facts. */
  place?: (op: PlacementVerb, by: string) => { set: SetOp; facts: PlacementFacts } | { error: string };
}

const KEY = "__uhdViewHub";
export const URL_ACTOR: Actor = { kind: "system", id: "url" };

/** The view store of this window (made from `location.search` the first time). */
export function viewHub(win: { location?: { search?: string } } | undefined = typeof window === "undefined" ? undefined : window): ViewHub {
  const holder = (win ?? globalThis) as unknown as Record<string, ViewHub | undefined>;
  const have = holder[KEY];
  if (have) return have;
  const hub = makeHub(new URLSearchParams(win?.location?.search ?? ""));
  holder[KEY] = hub;
  return hub;
}

/** A hub from URL parameters (tests and hosts that keep their own). */
export function makeHub(params: URLSearchParams): ViewHub {
  const store = createViewStore();
  const { values, visibility, opening } = fromUrlParams(params);
  const ops = [
    ...Object.entries(values).map(([k, v]) => ({ op: "set" as const, path: [k as WritableKey] as [WritableKey], value: v })),
    ...Object.entries(visibility).map(([k, v]) => ({ op: "set" as const, path: ["visibility", k] as [WritableKey, string], value: v })),
  ];
  if (ops.length) {
    const r = store.dispatch(ops, { actor: URL_ACTOR, label: "open as the URL asks", source: "url" });
    if (r && "error" in r) console.warn(`[view-state] the URL's view parameters were not taken: ${r.error}`);
  }
  return { store, opening };
}

/** Forget this window's hub (tests). */
export function resetViewHub(win: unknown = typeof window === "undefined" ? undefined : window): void {
  delete ((win ?? globalThis) as Record<string, unknown>)[KEY];
}
