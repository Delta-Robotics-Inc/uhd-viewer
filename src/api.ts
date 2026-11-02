/**
 * The viewer's public contract for hosts (docs: protoboard-cli/docs/specs/uhd-boundary.md,
 * "The viewer contract"). A host gives the viewer a UHD bundle, may replace or
 * extend how artifact files resolve, may add diagnostics of its own, and may
 * take over saving the layout the user edits. Nothing here names a host.
 *
 * This file holds types only, so the published declarations stay small.
 */
import type { UhdBundle, UhdBundleDiagnostic } from "@uhd/types/bundle.js";
/** The live part of the 3D view's state the host saves per scope (`.protoboard/local/viewer-state.json`). */
export type ViewerLiveState = Partial<Pick<ViewState, LiveKey>>;
/** Named views and annotations: deliberate presentation, kept in the display file (`spatial.views`, `spatial.annotations`). */
export type ViewerPresentation = Pick<ViewState, "namedViews" | "annotations"> & {
  /**
   * The person asked to save the callouts too (W4-D: the toolbar's "Save callouts", collaboration D10): the host
   * writes `spatial.annotations` only when this is true; named views are saved either way.
   */
  saveAnnotations?: true;
};

/** URL for a definition's artifact file path, or undefined if it cannot be resolved. */
export type ArtifactResolver = (definitionId: string, filePath: string) => string | undefined;

/** A link's hand layout on one drill level. */
export interface LinkLayout {
  /** Pinned waypoints [x, y] in absolute canvas coordinates (the router passes through them in order). */
  waypoints?: [number, number][];
  /** Label + toggle position as a fraction along the route (0..1). */
  labelT?: number;
  /** Label on the other side of the line (below a horizontal stretch, left of a vertical one). */
  labelFlip?: boolean;
  /** Harness name tab position as a fraction along the route (absent: placed automatically). */
  tabT?: number;
  /** Tab on the same side as the label (it defaults to the opposite side). */
  tabFlip?: boolean;
}

/**
 * Layout edits made in the viewer, on top of the bundle's display hints.
 * Both maps are keyed by drill level (instance path joined with "/", "" = top).
 */
export interface ViewerLayout {
  /** Dragged node positions: top-level nodes absolute, nodes inside a container relative to it. */
  positions: Record<string, Record<string, { x: number; y: number }>>;
  /** Pinned waypoints and label/tab positions by link id. */
  links: Record<string, Record<string, LinkLayout>>;
}

/** A view of the diagram: the pan offset in pixels and the zoom factor. */
export interface ViewerViewport {
  x: number;
  y: number;
  zoom: number;
}

/** The tones a mark can take; each is a token of the theme (`--uhd-mark-<tone>`). */
export type NodeMarkTone = "neutral" | "info" | "ok" | "warning" | "error";

/** A host's mark on a module (`ViewerOptions.nodeMarks`). */
export interface NodeMark {
  tone: NodeMarkTone;
  /** What the mark means, for the tooltip. */
  label?: string;
  /** `"ring"`: the tone as a dashed ring instead of a filled dot, for a module that stands for something not chosen yet. Default: a dot. */
  shape?: "dot" | "ring";
}

export interface ViewerOptions {
  /** The bundle itself. Relative artifact paths resolve against `bundleUrl` when both are given. */
  bundle?: UhdBundle;
  /** Where to fetch the bundle from (used when `bundle` is not given). */
  bundleUrl?: string;
  /**
   * Replaces or extends artifact resolution. `fallback` is the default
   * resolver (the bundle's per-definition artifact bases).
   */
  resolveArtifact?: (definitionId: string, filePath: string, fallback: ArtifactResolver) => string | undefined;
  /**
   * Findings from the host, listed in the checks panel next to the bundle's
   * own. Like the bundle's, they describe the nominal build and are shown for
   * the nominal scenario only.
   */
  diagnostics?: UhdBundleDiagnostic[];
  /**
   * A mark per definition, by definition id: the dot in the corner of every
   * module card drawn from that definition takes the mark's tone and says its
   * label on hover. For what the host knows about a part and the bundle does
   * not (where it comes from, whether it was reviewed). A module with no mark
   * keeps the dot of its links' state.
   */
  nodeMarks?: Record<string, NodeMark>;
  /**
   * The layout edits to show (only used together with `onLayoutChange`). A
   * different layout passed later through `update` replaces the viewer's
   * current edits, for example after the host's saved layout changed on disk.
   * Passing back what `onLayoutChange` sent changes nothing.
   */
  layout?: ViewerLayout;
  /**
   * Called (debounced) with the whole edited layout after every change. When
   * given, the host owns the layout and the viewer stops keeping it in local
   * storage.
   */
  onLayoutChange?: (layout: ViewerLayout) => void;

  // ---- the host message channel (docs: README, "Host messages") ----------
  /** The viewer has a model on screen and takes host messages from now on. */
  onReady?: () => void;
  /** Every change of the selection, in the diagram or the 3D view (null: nothing selected). */
  onSelectionChanged?: (selection: ViewerSelection | null) => void;
  /**
   * The user asked to see where a module is defined (the inspector's OPEN
   * SOURCE, a node's context menu). Given: the viewer offers these actions.
   */
  onOpenSource?: (request: { defId: string; instancePath?: string }) => void;
  /**
   * The user picked an artifact file in the inspector. Given: the host opens
   * it; otherwise the viewer opens the file's URL in a new tab.
   */
  onOpenArtifact?: (request: { defId: string; artifactId: string }) => void;
  /**
   * The user asked to open a module on its own (a double-click on it, OPEN IN
   * NEW TAB in its context menu): `path` is its instance path from the root.
   * Given: double-click opens the module there (a host's new tab or window),
   * and expanding it in place moves to the context menu. Not given:
   * double-click expands the module in place. `view: "3d"` (PB-1072): a part
   * with nothing inside but a model of its own (a bought part), or a part
   * double-clicked in the 3D view, opens on its 3D view.
   */
  onOpenModule?: (request: { path: string; view?: "3d" }) => void;
  /**
   * The user asked for the pair view of a link (the inspector's pair
   * preview). Given: the host shows it (its own tab or window); otherwise
   * the viewer opens it over the diagram. `linkId` is the link as a
   * selection names it, `a` and `b` the instance paths of the two modules it
   * joins.
   */
  onOpenPair?: (request: { linkId: string; a: string; b: string }) => void;
  /**
   * The user asked to inspect a module (INSPECT in its context menu): `path`
   * is its instance path from the root. Given: the host shows it in an
   * inspector of its own; otherwise the viewer opens its own panel. The
   * module is selected either way (`onSelectionChanged` says so first).
   */
  onInspect?: (request: { path: string; defId?: string }) => void;
  /**
   * Where the user left the view of each drill level (keyed like the layout;
   * only used together with `onViewportChange`). A level with a viewport
   * opens on it; a level with none is fitted to the diagram.
   */
  viewports?: Record<string, ViewerViewport>;
  /**
   * Called with every level's viewport after the user pans or zooms (a fit
   * the user asks for drops that level's entry). When given, the host keeps
   * the viewports and the viewer stops keeping them in local storage.
   */
  onViewportChange?: (viewports: Record<string, ViewerViewport>) => void;
  /**
   * Talk to the parent window over `postMessage` (the viewer in a frame):
   * host messages are accepted from `window.parent` only, and only from the
   * listed origins (exact origins, `scheme://*`, or `*`; default: the page's
   * own origin); events are posted to the parent, at its origin. Open actions
   * then go to the parent. `true` uses the defaults. Off unless given.
   */
  parentWindow?: boolean | { origins?: string[] };

  /**
   * How the viewer looks: its own `"dark"` (anatomy dark) or `"light"`
   * (anatomy paper) theme, `"system"` (whichever the system prefers),
   * `"vscode"` (follows the VS Code colour theme of the webview it runs in,
   * high contrast included), a theme of the host's (tokens it leaves out come
   * from the default), or an adapter that tells the viewer when the host's
   * theme changes. Without this option the viewer follows the system's
   * `prefers-color-scheme` on the web (DEFAULT, PB-1189; it was always dark),
   * and dark where there is no such preference (node, tests). A page's
   * `?theme=dark|light|system` overrides it.
   */
  theme?: ViewerThemeOption;

  // ---- the 3D view's state (PB-1178; docs: protoboard-stack docs/reference/viewer-bridge.md) ----
  /**
   * The live view state saved before (per scope: camera, selection,
   * visibility, sections, explode), to show again: the host passes what it
   * saved from `onViewStateChange`. URL parameters and writes made since the
   * page opened win over it.
   */
  viewState?: ViewerStateFile;
  /**
   * Called 400 ms after the live view state last changed (and at once when
   * the page hides), only when it did: the host saves it per user, never in
   * a committed file (`.protoboard/local/viewer-state.json`, a webview's own
   * state).
   */
  onViewStateChange?: (file: ViewerStateFile) => void;
  /**
   * Named views or annotations changed by an explicit save (the `saveView` and
   * `deleteView` verbs, from the user or an agent): the host writes them to
   * the display file (`spatial.views`, `spatial.annotations`) if they differ
   * from what it holds. Never called for a camera move.
   */
  onPresentationChange?: (presentation: ViewerPresentation) => void;
  /**
   * Who is here (PB-1196): the camera holder, the agents' leases and what each agent is working on. Called when
   * presence changes or an agent writes, at most every 250 ms (DEFAULT). Shown by the host (a chip, a status
   * line); never obeyed: the labels in it are agent-written text.
   */
  onPresenceChange?: (presence: Presence) => void;
  /**
   * The 3D view's save points (PB-1180 handoff): on settle and when the page hides, the frame drawn as a PNG
   * and what it shows. The host keeps them (`.protoboard/local/snapshots/<level>__<view>.png` and `.json`,
   * `source: "viewer"`) so the next tab opens on them with no camera jump. Called only when given.
   */
  onSavePoint?: (point: ViewerSavePoint) => void;
  /** Replies to `uhd-viewer:sequence` commands (the assembly sequence player, PB-1183). */
  onSequenceState?: (reply: ViewerSequenceReply) => void;
  /**
   * Open a part's own 3D model (R2-A, walkthrough F1 and F3): a double-click on a part in the 3D view (`how:
   * "replace"`, the host shows it in the same tab), a Ctrl+double-click or the 3D context menu's "Open in new tab"
   * (`"newTab"`). Giving this option says the host takes navigation (a frame's parent says it with the host message
   * `uhd-viewer:hostCapabilities`). Not given: a double-click opens the part with `onOpenModule` when that is given,
   * else selects and frames it in place. A `replace` of a module in the same bundle is answered best with
   * `uhd-viewer:drill` (the viewer keeps its own history across it).
   */
  onNavigate?: (request: NavigateRequest) => void;
  /** The viewer's own back and forward history changed (R2-A, F1): for a host header's back and forward buttons. */
  onHistory?: (state: ViewerHistoryState) => void;
  /**
   * The 3D toolbar's Export (R2-E, G3; R2 integration): a picture of the view (PNG) or a model of the selected part
   * (STEP, STL, GLB). The host writes the file (the VS Code extension: to the export folder, no dialog). Before a
   * `png` request the view takes a save point of itself as it is now (`onSavePoint`, reason "settle"), so the host
   * has the picture first. Giving this option (or a frame's parent) enables the button; else it is disabled and says why.
   */
  onExport?: (request: ExportRequest) => void;
  /**
   * The person's viewer settings (R2-E, J1: the stack's `<home>/settings.json`), given at mount and again with
   * `update({ settings })` on every change. Anything absent or out of range takes its DEFAULT (shown).
   */
  settings?: ViewerHostSettings;
}

/** The person's viewer settings a host passes (R2-E, J1). Every field optional; the DEFAULT in brackets. */
export interface ViewerHostSettings {
  /** The host turns a `replace` navigate into a new tab when off (the host's own; the viewer only carries it) [true]. */
  openModelsInPlace?: boolean;
  /** The wheel zooms toward the pointer in the 3D view [true]. */
  zoomToCursor?: boolean;
  /** The model info card (G-code summary and legend, a CAD file's name and size) open when a view opens [true]; the person's own toolbar choice, kept in local storage, still wins. */
  modelInfo?: boolean;
  /** The long-hover tier of callouts and part tooltips, ms, 200 to 5000 [900]. */
  hoverLongDelayMs?: number;
}

/** What the 3D toolbar's Export asks the host for (R2-E, G3). */
export interface ExportRequest {
  format: "png" | "glb" | "step" | "stl";
  /** The part, by instance path from the root. Absent: the module the view shows (a `png` is always of the view). */
  target?: string;
}

/**
 * What a navigation opens (R2-A, F1 and F3): a module's own 3D level by its instance path from the root (a
 * sub-assembly; a bought part whose body GLB is its vendor model), or a model artifact of a part that has no body of
 * its own (named as `openArtifact` names it; `path` is the instance it was opened from).
 */
export type NavigateTarget = { module: string } | { model: { defId: string; artifactId: string; path?: string } };

/** A navigation the viewer asks its host for (`ViewerOptions.onNavigate`, the `uhd-viewer:navigate` event). */
export interface NavigateRequest {
  target: NavigateTarget;
  /** `replace`: show it in this tab (the default action); `newTab`: a tab of its own (Ctrl, the context menu). */
  how: "replace" | "newTab";
  /** The view to open it on: the 3D view always asks for "3d". */
  view?: "3d";
  /** The level the viewer shows now, by instance path from the root ("" the root): where Back returns. */
  from?: string;
}

/** One place in the viewer's own history (R2-A, F1). */
export interface ViewerHistoryEntry {
  /** The level, by instance path from the root ("" the root). */
  scope: string;
  /** What to call it (a module's name, the framed part's refdes or name). */
  label: string;
  /** How it was reached: opened, drilled into, a part framed, a part isolated. */
  kind: "open" | "drill" | "frame" | "isolate";
}

/** The viewer's back and forward history (`ViewerOptions.onHistory`, the `uhd-viewer:history` event). */
export interface ViewerHistoryState {
  index: number;
  length: number;
  canBack: boolean;
  canForward: boolean;
  entries: ViewerHistoryEntry[];
}

/** A save point the 3D view hands its host (`onSavePoint`). */
export interface ViewerSavePoint {
  /** The PNG as drawn (device pixels). */
  png: Blob;
  level: string;
  view: "3d";
  width: number;
  height: number;
  css: { width: number; height: number; dpr: number };
  camera: CameraState;
  viewState: ViewState;
  /** "settle" (every model in, the view at rest) or "hide" (the page went away). */
  reason: "settle" | "hide";
  takenAt: string;
}

/**
 * The host's last snapshot of a tab (`uhd-viewer:snapshot`, PB-1180): the 3D view paints it at once, scaled to
 * its height and centred, sets its camera exactly, and goes live under it with no jump.
 */
export interface ViewerSnapshotMessage {
  type: "uhd-viewer:snapshot";
  schema: "protoboard.snapshot/v0";
  view: string;
  level: string;
  imageUrl: string;
  camera?: CameraState;
  viewState?: Partial<ViewState>;
  bundleHash?: string;
  revision?: number;
  backend?: string;
  css?: { width: number; height: number; dpr: number };
  theme?: string;
  takenAt?: string;
  /** The hash of the bundle the host is about to load: when it differs from `bundleHash`, the view says it is updating. */
  currentBundleHash?: string;
}

/**
 * A command for the assembly sequence player (W2-C, `src/cad/sequence`); see `SequenceCommand` there. R2-B (H2) adds
 * two, checked by the host protocol: `{ action: "mode", mode?: "radial" | "sequence", instant?: boolean }` (Explode
 * all at once, or the steps) and `{ action: "scope", scope?: string, instant?: boolean }` (only the parts at or under
 * an instance path; absent: the whole assembly).
 */
export interface ViewerSequenceCommand {
  action: string;
  [key: string]: unknown;
}

/** R2-B's `mode` command (see `ViewerSequenceCommand`). */
export type ViewerSequenceModeCommand = { action: "mode"; mode?: "radial" | "sequence"; instant?: boolean };
/** R2-B's `scope` command (see `ViewerSequenceCommand`). */
export type ViewerSequenceScopeCommand = { action: "scope"; scope?: string; instant?: boolean };

export interface ViewerSequenceReply {
  type: "uhd-viewer:sequenceState";
  ok: boolean;
  error?: string;
  /** The player's snapshot: steps (ids, titles), t, the current step, playing, loop, joints. */
  state?: unknown;
}

/** A theme: values for the viewer's semantic tokens (docs: README, "Theming"). */
export interface ViewerTheme {
  id: string;
  label: string;
  scheme: "dark" | "light" | "high-contrast" | "high-contrast-light";
  /** Token values by token name (`accent`, `surface`, `textMuted`, …): any CSS value, `var(...)` included. */
  tokens: Partial<Record<string, string>>;
}

/** Where a host's theme comes from, when it can change while the viewer is open. */
export interface ViewerThemeAdapter {
  id: string;
  current(): ViewerTheme;
  subscribe?(onChange: (theme: ViewerTheme) => void): () => void;
}

export type ViewerThemeOption = "dark" | "light" | "system" | "vscode" | ViewerTheme | ViewerThemeAdapter;

/** What a view shows: the diagram or the assembled 3D model. */
export type ViewerView = "diagram" | "3d";

/**
 * A selection as the host sees it. Ids are canonical paths from the root
 * system: a module's instance path (`arm_fl/motor`), a link's owner path and
 * id (`stack/fc_esc`, as UHD's system checks name links).
 */
export interface ViewerSelection {
  kind: "node" | "link";
  id: string;
  /** The selected module's definition id (a link's: the module that declares it). */
  defId?: string;
  /**
   * Modules selected together (a selection box, Shift- or Ctrl-click, select all), two or more: every one, by
   * path from the root. `id` is the first of them.
   */
  ids?: string[];
  /**
   * 3D view only (R1-A, M2), present only when a component drawn inside a body (a part on a board) is picked: the
   * component's instance path from the root (`pcb/controller/usb/usbc`; `id` is the same path). A pick of a whole
   * body has none of these three.
   */
  component?: string;
  /** With `component`: the instance path of the body that draws it (`pcb`). */
  holder?: string;
  /** With `component`: that body's definition id. */
  holderDefId?: string;
}

/** Host → viewer messages (`window.postMessage`, or the handle's methods). */
export type ViewerHostMessage =
  /** Drill to the level that holds the module, select it and centre it. */
  | { type: "uhd-viewer:focus"; path: string }
  /**
   * Select on the current level (the first id that is there; none: clear the
   * selection). The diagram pans (zooming out only if it must) to bring the
   * selection into view when it is not; `reveal: false` leaves the view where it is.
   */
  | { type: "uhd-viewer:select"; ids: string[]; reveal?: boolean }
  /** Show the level of this instance path ("" is the root system). */
  | { type: "uhd-viewer:drill"; path: string }
  | { type: "uhd-viewer:setView"; view: ViewerView }
  /** Write the 3D view's state (writable keys of `ViewState`), as a host: last writer wins, logged as the host's. */
  | { type: "uhd-viewer:setViewState"; state: Partial<ViewState> }
  /** Saved live state to show again (`ViewerOptions.viewState`). */
  | { type: "uhd-viewer:restoreViewState"; file: ViewerStateFile }
  /** A live-tab bridge batch (an agent's, relayed by the host): the reply comes back as `uhd-viewer:bridgeReply`. */
  | BridgeRequest
  /** Run an assembly sequence command (goto, explode, assemble, play, loop, stop, isolate, joint, set, clip): reply `uhd-viewer:sequenceState`. */
  | { type: "uhd-viewer:sequence"; command: ViewerSequenceCommand }
  /** The host's last snapshot of this tab: painted at once, then the view goes live under it (PB-1180). */
  | ViewerSnapshotMessage
  /**
   * The 3D view's quality curve settings (PB-1176): `enabled`, `tauMs` (recovery), `budgetMs` (frame budget). The
   * VS Code settings `protoboard.viewer.settleTauMs` and an off switch map to these.
   */
  | { type: "uhd-viewer:quality"; config: Record<string, unknown> }
  /**
   * The person takes the view and the scene back from every agent at once (a "Take over" button, Esc): every
   * agent lease is revoked and the camera is the person's (PB-1196, collaboration D9).
   */
  | { type: "uhd-viewer:takeOver" }
  /**
   * Pin a finding's callout open in the 3D view (a check row clicked in the host's Inspector, after a `focus` on its
   * module): `id` is the view's finding id (`drc:<code>:<entity kind>:<entity id>`); when no finding has that id or
   * its repeats, the first finding with `code` that names `path` (from the root) or a part under it. The findings
   * layer is turned on. Ignored on the diagram.
   */
  | { type: "uhd-viewer:openFinding"; id: string; code: string; path?: string }
  /**
   * Move through the viewer's own history (R2-A, F1): `delta` -1 is Back, +1 Forward (an integer, -50 to 50, not
   * 0). A host header's back and forward buttons send it while `uhd-viewer:history` says `canBack` / `canForward`.
   */
  | { type: "uhd-viewer:historyGo"; delta: number }
  /**
   * What a frame's parent takes (R2-A): `navigate: true` says the host answers `uhd-viewer:navigate` (a library
   * host says it by giving `ViewerOptions.onNavigate`); false withdraws it.
   */
  | { type: "uhd-viewer:hostCapabilities"; navigate?: boolean; /** The parent draws back and forward of its own from `uhd-viewer:history`: the 3D view leaves out its in-page pair (R2 integration). */ history?: boolean };

/** Viewer → host events (posted to the parent window, or the options' callbacks). */
export type ViewerEvent =
  | { type: "uhd-viewer:ready" }
  | { type: "uhd-viewer:selectionChanged"; selection: ViewerSelection | null }
  | { type: "uhd-viewer:openSource"; defId: string; instancePath?: string }
  | { type: "uhd-viewer:openArtifact"; defId: string; artifactId: string }
  | { type: "uhd-viewer:openModule"; path: string; view?: "3d" }
  | { type: "uhd-viewer:openPair"; linkId: string; a: string; b: string }
  | { type: "uhd-viewer:inspect"; path: string; defId?: string }
  /** The live view state changed (400 ms after the last change): `ViewerOptions.onViewStateChange`. */
  | { type: "uhd-viewer:viewState"; file: ViewerStateFile }
  /** Named views or annotations were saved: `ViewerOptions.onPresentationChange`. */
  | { type: "uhd-viewer:presentation"; presentation: ViewerPresentation }
  /** The reply to a bridge batch. */
  | BridgeReplyMessage
  /** The reply to a sequence command. */
  | ViewerSequenceReply
  /** Leases, intents and who drives the camera changed ("agent X is working on U3"): for a chip near the part. */
  | { type: "uhd-viewer:presence"; presence: Presence }
  /** Open a part's own 3D model, in place or in a new tab (`ViewerOptions.onNavigate`; R2-A, F1 and F3). */
  | ({ type: "uhd-viewer:navigate" } & NavigateRequest)
  /** The viewer's own back and forward history (`ViewerOptions.onHistory`; R2-A, F1). */
  | ({ type: "uhd-viewer:history" } & ViewerHistoryState)
  /** The 3D toolbar's Export (`ViewerOptions.onExport`; R2-E, G3). */
  | ({ type: "uhd-viewer:export" } & ExportRequest);

export interface ViewerHandle {
  /**
   * Re-renders with changed options (a rebuilt bundle, new host diagnostics, a
   * changed layout). The change is merged into the current options; giving
   * `bundleUrl` without `bundle` drops a bundle given earlier and loads from
   * the URL.
   */
  update(options: Partial<ViewerOptions>): void;
  unmount(): void;
  /** Drill to the level that holds the module at `path`, select it and centre it. */
  focus(path: string): void;
  /**
   * Select on the current level: the first of `ids` drawn there (an empty list
   * clears the selection), brought into view unless `reveal` is false.
   */
  select(ids: string[], options?: { reveal?: boolean }): void;
  /** Show the level of an instance path ("" is the root system). */
  drill(path: string): void;
  setView(view: ViewerView): void;
  /**
   * Apply a host message object, as it arrives over `postMessage`. Returns
   * false when it is not a valid viewer message. Messages sent before the
   * model is on screen wait for it.
   */
  post(message: unknown): boolean;
  /** The 3D view's state now (camera, selection, visibility, sections, explode, named views, the facts). */
  viewState(): ViewState;
  /** Write view-state keys as the host (last writer wins); throws when a value is refused. */
  setViewState(state: Partial<ViewState>): void;
  /** Saved live state to show again (as `ViewerOptions.viewState`). */
  restoreViewState(file: ViewerStateFile): void;
  /** Apply a live-tab bridge request (an agent's batch the host relays); returns the reply to send back. */
  bridge(request: BridgeRequest): BridgeReplyMessage | undefined;
  /**
   * The same, as messages to post (W4-D): the reply whole when its JSON is under `maxChars` (DEFAULT 48 kB), else
   * in parts (`uhd-viewer:bridgeReplyPart`) the host posts in order and the dev server joins (a dense board's
   * observation with components stays under any one-request budget).
   */
  bridgeParts(request: BridgeRequest, maxChars?: number): (BridgeReplyMessage | BridgeReplyPart)[] | undefined;
  /** The named views and annotations (what an explicit save writes to the display file). */
  presentation(): ViewerPresentation;
  /** Run an assembly sequence command now (the 3D view must be shown); the player's reply. */
  sequence(command: ViewerSequenceCommand): ViewerSequenceReply;
}

// ---------------------------------------------------------------------------
// The 3D view's state (PB-1178): one schema for the URL, host messages, `window.__cad` and the live-tab bridge.
// Implemented in src/cad/state (the store, its verbs and op log); the types are part of the public contract.
// ---------------------------------------------------------------------------

export type Vec3 = [number, number, number];

/** The camera, in the root's coordinates (mm). `fov` (degrees, vertical) for a perspective camera; `ortho` for an orthographic one. */
export interface CameraState {
  position: Vec3;
  target: Vec3;
  up: Vec3;
  fov?: number;
  /** An orthographic camera: the zoom factor (DEFAULT: the view draws perspective only; kept so a saved state can say it). */
  ortho?: { zoom: number };
}

/** What is selected in the 3D view, by instance path (a body may carry `#artifact`). */
export interface ViewSelection {
  body?: string;
  iface?: string;
  /** A component drawn inside the selected body (a board's part), by instance path. */
  component?: string;
  /** A mate, by its link id (`owner/link`). */
  mate?: string;
  /** A routed wire harness, by instance path. */
  harness?: string;
}

/**
 * Kinds of 3D label. `refdes` and `mpn` (R2-A, applying R1-C's handoff): one label per placed component drawn inside
 * a body (a board's parts), titled by its reference designator or its manufacturer part number; R2-C renders them.
 */
export type LabelKind = "module" | "harness" | "interface" | "finding" | "refdes" | "mpn";
export type InterfaceDirection = "feature" | "artifact" | "procedural";

/** What is drawn. */
export interface Visibility {
  labels: boolean;
  labelKinds: LabelKind[];
  /** Every interface frame. */
  frames: boolean;
  wires: boolean;
  hardware: boolean;
  /** Findings pinned to the model; null: shown when a host sent some that land on it. */
  findings: boolean | null;
  xray: boolean;
  /** Instance paths not drawn (a body and everything under its path). */
  hidden: string[];
}

/**
 * A section plane: an axis of the assembly's frame, a position across its
 * bounds (0..1), and which side is kept (`flip`: the + side; unset: the side
 * away from the camera).
 */
export interface SectionPlane {
  axis: 0 | 1 | 2;
  at: number;
  flip?: boolean;
  /**
   * An instance path: the plane cuts only the bodies under it (PB-1186). DEFAULT: one scope per view, the
   * first plane's; at most 512 characters.
   */
  scope?: string;
  /**
   * R2-B (walkthrough G5), additive: where a placed plane came from, an origin plane of the model's frame or a picked
   * face. Absent: the legacy axis plane (`axis`/`at` alone). `axis` and `at` stay required; the viewer keeps them in
   * step with a placed plane (`sections/planes.ts`).
   */
  source?: "origin" | "face";
  /** The base plane's unit normal (world mm, Z up); with `point`, both or neither. */
  normal?: Vec3;
  /** A point on the base plane (world mm). */
  point?: Vec3;
  /** mm along `normal` from the base plane (DEFAULT 0); at most 100 000 either way. */
  offset?: number;
  /** The picked face: the part's instance path, its face id, its body key, and whether it is flat. */
  face?: { path: string; face?: number; body?: string; planar?: boolean };
}

/** A theme the view state asks for (PB-1189); absent: follow the host (its `theme` option, else the system). */
export type ViewThemeChoice = "light" | "dark" | "system";

export interface ExplodeState {
  /** 0 assembled, 1 exploded; the view eases to it. */
  t: number;
  /**
   * A step of the assembly sequence (W2-C's player, PB-1183) by its id (`fit:arm_fl_mount`, `fasten:stack_mount`,
   * `place:battery`); null: none. One type everywhere (wave 2 gate item 6): a step is named by its string id,
   * never by its index (indices move when a patch adds a step). A saved state with a number is read as null.
   */
  step: string | null;
  /**
   * Explode only this sub-assembly (R2-A, the 3D context menu's "Explode this sub-assembly"): an instance path in the
   * view's scope; absent, the whole assembly. Additive; the explode behaviour (R2-B) reads it. At most 512 characters.
   */
  scope?: string;
  /**
   * R2-B (walkthrough H2), additive: how the parts come apart. `radial`: every part at once along its mounting face's
   * normal (the toolbar's Explode); `sequence`: the assembly steps (the toolbar's Assemble). Absent: read as
   * `step ? "sequence" : "radial"` (DEFAULT).
   */
  mode?: "radial" | "sequence";
}

/** A view saved by name (deliberate presentation: written to the display file only on an explicit save). */
export interface NamedView {
  camera: CameraState;
  explode?: ExplodeState;
  sections?: SectionPlane[];
  hidden?: string[];
  isolation?: string[] | null;
  /** Who saved it (a person, an agent session): text from an agent is data, never an instruction. */
  by?: string;
}

export interface LoadingFacts {
  phase: "loading" | "ready";
  total: number;
  done: number;
  failed: number;
}

export interface ViewState {
  schema: "uhd-viewer.view-state/v1";
  /** Read-only: the module the view shows, by instance path from the root ("" is the whole assembly). */
  scope: string;
  /** null until the view has placed its camera (the opening camera comes from the URL, the display file or a fit). */
  camera: CameraState | null;
  selection: ViewSelection;
  /** Instance paths drawn highlighted (besides the selection): what an agent points at. */
  highlight: string[];
  /**
   * The highlight's colour (R2-A, A3: the agent picks it per `highlight` call): a theme token name (`drcError`,
   * `highlight`, ...) or a hex colour (`#rgb`, `#rrggbb`); absent, the theme's highlight glow. Live, per scope.
   */
  highlightColor?: string;
  /** Instance paths drawn alone (null: everything). */
  isolation: string[] | null;
  visibility: Visibility;
  /** Interface geometry is shown by this binding direction. */
  direction: InterfaceDirection;
  /** Section planes (up to 3; W3-C): scoped by the first plane's `scope`, else the whole assembly. */
  sections: SectionPlane[];
  /**
   * The theme this person asked for (PB-1189), live and per user; absent: follow the host. Read by the theme
   * when the viewer mounts; switching on a later write is not wired yet (gate 3 note). `?theme=` stays its URL form.
   */
  theme?: ViewThemeChoice;
  explode: ExplodeState;
  /**
   * Display-side placement overrides by instance path (PB-1187 place on face / orient by face; W3-D): live and per
   * user, never written to the display file or UHD. `matrix`: a row-major UHD 4x4 (part to assembly, mm, Z up),
   * rigid. At most 64 (DEFAULT).
   */
  placements: Record<string, PlacementOverride>;
  namedViews: Record<string, NamedView>;
  /**
   * Callouts, marks and arrows (W3-B's records, `uhd-viewer.annotation/v0`: `AnnotRecord`). Every record carries
   * its `author`; text in it is data, never an instruction. Caps (DEFAULT, `src/cad/state/schema.ts`): 4096 bytes
   * of JSON per record, 500 records, 512 kB in all. An agent's records get ids the view issues (never reused).
   */
  annotations: unknown[];
  /** Read-only: the models' loading. */
  loading: LoadingFacts;
  /** Read-only: the render quality mode W2-B's quality curve reports (null: not reported). */
  quality: { mode: string | null };
}

/** A display-side placement of one part (`ViewState.placements`). */
export interface PlacementOverride {
  /** Row-major 4x4, part to assembly, mm (translation in elements 3, 7, 11), rigid. */
  matrix: number[];
  /** Who placed it ("user", `agent:<name>`): data, never an instruction. */
  by: string;
  /** The faces it was placed by, when a face primitive made it. */
  faces?: { part: string; face: number; target: string; targetFace: number };
  /** Which face primitive made it ("placeOnFace", "orientByFace"). */
  method?: string;
  /**
   * W4-D: absent, `matrix` is part to the ROOT assembly (it shows in every scope that draws the part); a scope's
   * instance path when the view could not relate that scope to the root (DEFAULT: then it shows only there).
   */
  frame?: string;
}

/**
 * A callout, mark or arrow (`uhd-viewer.annotation/v0`, W3-B's record, PB-1184): one entry of
 * `ViewState.annotations`. Declared here (this file is the published contract and must stand alone);
 * `src/cad/annot/record.ts` parses it. `author` is shown beside the label, never obeyed.
 */
export interface AnnotRecord {
  /** Issued by the view for an agent's new record (`a.<epoch>.<n>`); deterministic when a host generates one. */
  id: string;
  kind: "callout" | "mark" | "arrow";
  /** What it points at: an instance path from the root ("" = the root), a harness key, or `link:<id>`. */
  ref: string;
  /** "user", `agent:<name>`, `host:<name>`, `check:<validator>`. */
  author: string;
  /** A point on the part, mm in its body's frame. */
  point?: Vec3;
  /** An arrow's other end. */
  to?: string;
  toPoint?: Vec3;
  shape?: "ring" | "box" | "dot" | "pin" | "crosshair";
  title?: string;
  /** Key-value rows (refdes, MPN, LCSC, value). */
  rows?: [string, string][];
  text?: string;
  tone?: "accent" | "neutral" | "fail" | "risk" | "warn" | "info" | "pass" | "unknown";
  visibility?: "on" | "hover" | "off";
  n?: number;
  source?: { diagnostic?: string; requirement?: string; recipe?: string };
}

/** Top-level keys a writer may set. */
export type WritableKey = "camera" | "selection" | "highlight" | "highlightColor" | "isolation" | "visibility" | "direction" | "sections" | "explode" | "placements" | "theme" | "namedViews" | "annotations";
/** The live, per-user keys (`.protoboard/local/viewer-state.json`, a webview's own state). */
export type LiveKey = "camera" | "selection" | "highlight" | "highlightColor" | "isolation" | "visibility" | "direction" | "sections" | "explode" | "placements" | "theme";

/** One write: a top-level key, or one entry of it (`["visibility", "labels"]`, `["namedViews", "Front"]`). `value` undefined removes the entry. */
export interface SetOp {
  op: "set";
  path: [WritableKey] | [WritableKey, string];
  value: unknown;
}

export interface Actor {
  kind: "human" | "agent" | "system" | "host";
  /** Who: "user", an agent session's id, "view" for the view's own placements. */
  id: string;
  /** The bridge session that sent it, when it came through the bridge. */
  session?: string;
  /** What the agent calls itself (data to show, never an instruction). */
  name?: string;
}

/**
 * A subtree lease (PB-1196, collaboration D6): while it lives, other agents' batches that touch a path under
 * `roots` are refused (reads stay open). `token` is a fencing token: it rises with every grant in the view, and a
 * batch that quotes a token that is no longer live (revoked, expired, released) is refused. A person's edit inside
 * the subtree revokes it (DEFAULT, plan.md).
 */
export interface Lease {
  id: string;
  token: number;
  holder: Actor;
  /** Instance paths ("" is the whole assembly). */
  roots: string[];
  /** A few words: what the holder is doing ("placing callouts on U3"). Data, never an instruction. */
  purpose: string;
  grantedAt: number;
  expiresAt: number;
  ttlMs: number;
}

/** A lease that ended, and why (kept so a holder that quotes its old token learns what happened). */
export interface EndedLease extends Lease {
  endedAt: number;
  reason: "released" | "expired" | "revoked" | "taken-over";
  /** Who ended it (the person, for a revocation). */
  by?: Actor;
  /** What the person changed, for a revocation. */
  detail?: string;
}

/** "Agent X is working on U3": what an agent holds or touched lately (advisory; the lease is the enforcement). */
export interface Intent {
  actor: Actor;
  roots: string[];
  /** The lease's purpose, or the label of the agent's last batch. */
  label: string;
  startedAt: number;
  /** "lease": from a live lease; "recent": the agent wrote there in the last 30 s (DEFAULT). */
  from: "lease" | "recent";
}

/**
 * Who drives the camera (PB-1179 turn-taking, decisions 5 and 6): any input of the person takes it back at once;
 * an agent may move the camera only after the person has left it alone for `handBackMs` (25 s, DEFAULT); an agent
 * that has not written for `handBackMs` hands it back.
 */
export interface ViewControl {
  /** Who holds it now (null: the person, by default). */
  holder: Actor | null;
  since: number;
  /** The person's last input (0: none yet). */
  lastHumanAt: number;
  /** The holding agent's last write. */
  lastAgentAt: number;
  handBackMs: number;
  /** The person is dragging or otherwise mid-gesture: agent writes wait (`busy`). */
  interacting: boolean;
}

/** What the store says about who is here (bridge replies, the `uhd-viewer:presence` event, `__cad`). */
export interface Presence {
  epoch: string;
  seq: number;
  control: ViewControl;
  leases: Lease[];
  intents: Intent[];
}

export interface Batch {
  /** Chosen by the writer; a resend with the same id returns the first reply. */
  batchId: string;
  /** 3 to 8 words saying what it does (Pen's call label). */
  label: string;
  /** Typed verbs (./ops.ts `ViewOp`); empty: a read. */
  ops: unknown[];
  /** The seq the writer read the whole state at: refused when anything was committed since. */
  expectSeq?: number;
  /** The versions of the keys the writer read or will touch: refused when any changed since. */
  expectVersions?: Record<string, number>;
  /** Return the state after the batch (default true). */
  state?: boolean;
  /** The fencing token of the writer's lease, when it writes inside a subtree it claimed. */
  leaseToken?: number;
}

export interface MissedEntry {
  seq: number;
  actor: Actor;
  batchId?: string;
  label: string;
  keys: string[];
}

/** Why a batch was refused. */
export type RefusalReason =
  | "stale-seq"
  | "stale-versions"
  /** Another actor's live lease covers a path the batch touches (`lease` names it). */
  | "leased"
  /** The batch quotes a lease token that is not live, or writes in a subtree it once claimed without its live token. */
  | "lease-revoked"
  /** The person used the view less than `handBackMs` ago: the camera is theirs (`until`). */
  | "view-held"
  /** Undo: what the batch changed was changed again since (`conflicts` say by whom). */
  | "stale-undo"
  /** Undo: this actor has nothing left to undo. */
  | "nothing-to-undo";

/** Fields every reply from a store with the PB-1196 slice may carry. */
export interface ReplyExtras {
  /** The store's owner epoch: seq numbers restart when it changes (a reload). */
  epoch?: string;
  /** Temporary handles mapped to the ids the view issued (`annotate` with `handle`). */
  ids?: Record<string, string>;
  /** The lease a `claim` granted. */
  lease?: Lease;
  /** The leases a `release` ended. */
  released?: string[];
  /** Live leases, intents and who drives the camera. */
  presence?: Presence;
  /** Log entries after the `since` the host asked for (journal mirroring). */
  log?: { epoch: string; entries: unknown[]; truncated?: true };
  /** A checkpoint, when the host asked for one. */
  checkpoint?: unknown;
}

export type BatchReply = (
  | { status: "applied"; batchId: string; seq: number; applied: SetOp[]; changed: string[]; versions: Record<string, number>; duplicate?: true; state?: ViewState }
  | { status: "read"; batchId: string; seq: number; versions: Record<string, number>; state?: ViewState; duplicate?: true }
  | {
      status: "refused";
      batchId: string;
      seq: number;
      reason: RefusalReason;
      /** What happened, in a sentence (data). */
      message?: string;
      /** The entries committed after what the writer read: re-observe, then decide again. */
      missed: { from: number; to: number; entries: MissedEntry[] };
      /** Per key that changed: what the writer expected, what it is now, its value, and who changed it last. */
      conflicts?: { key: string; expected: number; current: number; value: unknown; by?: Actor; seq?: number }[];
      /** The lease in the way (`leased`), or the one the token named (`lease-revoked`). */
      lease?: Lease | EndedLease;
      /** `view-held`: when the camera is the agent's to move again (ms since the epoch). */
      until?: number;
      duplicate?: true;
    }
  | { status: "invalid"; batchId: string; seq: number; error: string; index?: number; duplicate?: true }
  /** The person is mid-gesture: nothing was applied and nothing remembered; the bridge delivers it again after `retryAfterMs`. */
  | { status: "busy"; batchId: string; seq: number; retryAfterMs: number }
) &
  ReplyExtras;

export interface ViewerStateFile {
  schema: "protoboard.viewer-state/v0";
  /** The view-state schema of the values. */
  viewState: "uhd-viewer.view-state/v1";
  /** The scope shown last. */
  scope: string;
  /** Live keys per scope ("" is the whole assembly). */
  scopes: Record<string, Partial<Pick<ViewState, LiveKey>>>;
}

/** Host → viewer: a batch from an actor the host authenticated (a bridge session). */
export interface BridgeRequest {
  type: "uhd-viewer:bridge";
  /** The host's id for this delivery (echoed in the reply). */
  id: string;
  batch: Batch;
  actor: Actor;
  /** Also return what is drawn (`__cad.observe`): `true` without the parts drawn inside bodies, `"components"` with them (a board's U3). */
  observe?: boolean | "components";
  /** Return the log entries after this point (the host mirrors them to its journal). */
  since?: { epoch: string; seq: number };
  /** Return a checkpoint of the store too (the host's journal writes one every so often). */
  checkpoint?: boolean;
  /**
   * Probes the 3D view answers in the same reply (W4-D, the critic's pick probes): `picks` are `[fx, fy]` fractions
   * of the canvas from its top left (at most 64), answered with what `__cad.pick` hits there; `labels: true` adds the
   * drawn label boxes (`__cad.labels()`).
   */
  probe?: { picks?: [number, number][]; labels?: boolean };
}

/** What a placement verb did (`placeOnFace`, `orientByFace`), in the reply of the batch that carried it. */
export interface PlacementFacts {
  part: string;
  /** Part to the root assembly, row-major, mm (Z up). */
  matrix: number[];
  delta: number[];
  turnedDeg: number;
  movedMm: number;
}

export interface BridgeReplyMessage {
  type: "uhd-viewer:bridgeReply";
  id: string;
  reply: BatchReply & { observation?: unknown; view?: "3d" | "diagram"; probe?: { picks?: { at: [number, number]; hit: unknown }[]; labels?: unknown[]; canvas?: { width: number; height: number } }; placements?: PlacementFacts[] };
}

/**
 * One part of a bridge reply too large for one message (W4-D: a dense board's observation with components): the
 * reply's JSON cut into `n` slices; the host joins them in order (`joinBridgeReply`) before it answers the agent.
 */
export interface BridgeReplyPart {
  type: "uhd-viewer:bridgeReplyPart";
  id: string;
  /** This slice's index (0-based) and the number of slices. */
  i: number;
  n: number;
  /** The slice of the reply message's JSON text. */
  data: string;
}

