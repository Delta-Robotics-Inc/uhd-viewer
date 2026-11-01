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
export type ViewerPresentation = Pick<ViewState, "namedViews" | "annotations">;

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
   * How the viewer looks: its own `"dark"` (default) or `"light"` theme,
   * `"system"` (whichever the system prefers), `"vscode"` (follows the VS Code
   * colour theme of the webview it runs in, high contrast included), a theme
   * of the host's (tokens it leaves out come from the default), or an adapter
   * that tells the viewer when the host's theme changes.
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
   * The 3D view's save points (PB-1180 handoff): on settle and when the page hides, the frame drawn as a PNG
   * and what it shows. The host keeps them (`.protoboard/local/snapshots/<level>__<view>.png` and `.json`,
   * `source: "viewer"`) so the next tab opens on them with no camera jump. Called only when given.
   */
  onSavePoint?: (point: ViewerSavePoint) => void;
  /** Replies to `uhd-viewer:sequence` commands (the assembly sequence player, PB-1183). */
  onSequenceState?: (reply: ViewerSequenceReply) => void;
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

/** A command for the assembly sequence player (W2-C, `src/cad/sequence`); see `SequenceCommand` there. */
export interface ViewerSequenceCommand {
  action: string;
  [key: string]: unknown;
}

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
  | { type: "uhd-viewer:quality"; config: Record<string, unknown> };

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
  | ViewerSequenceReply;

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

export type LabelKind = "module" | "harness" | "interface" | "finding";
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
}

export interface ExplodeState {
  /** 0 assembled, 1 exploded; the view eases to it. */
  t: number;
  /**
   * A step of the assembly sequence (W2-C's player, PB-1183): its id (`fit:arm_fl_mount`, `fasten:stack_mount`,
   * `place:battery`) or its index in the player's steps; null: none. Informational today: the player's own
   * commands (`uhd-viewer:sequence`, `__cad.set({ step })`) move to a step.
   */
  step: string | number | null;
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
  /** Instance paths drawn alone (null: everything). */
  isolation: string[] | null;
  visibility: Visibility;
  /** Interface geometry is shown by this binding direction. */
  direction: InterfaceDirection;
  /** Section planes; the view cuts with the first today. */
  sections: SectionPlane[];
  explode: ExplodeState;
  namedViews: Record<string, NamedView>;
  /** Placeholder for W3-B's callouts and marks (records with author and source). */
  annotations: unknown[];
  /** Read-only: the models' loading. */
  loading: LoadingFacts;
  /** Read-only: the render quality mode W2-B's quality curve reports (null: not reported). */
  quality: { mode: string | null };
}

/** Top-level keys a writer may set. */
export type WritableKey = "camera" | "selection" | "highlight" | "isolation" | "visibility" | "direction" | "sections" | "explode" | "namedViews" | "annotations";
/** The live, per-user keys (`.protoboard/local/viewer-state.json`, a webview's own state). */
export type LiveKey = "camera" | "selection" | "highlight" | "isolation" | "visibility" | "direction" | "sections" | "explode";

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
}

export interface MissedEntry {
  seq: number;
  actor: Actor;
  batchId?: string;
  label: string;
  keys: string[];
}

export type BatchReply =
  | { status: "applied"; batchId: string; seq: number; applied: SetOp[]; changed: string[]; versions: Record<string, number>; duplicate?: true; state?: ViewState }
  | { status: "read"; batchId: string; seq: number; versions: Record<string, number>; state?: ViewState; duplicate?: true }
  | {
      status: "refused";
      batchId: string;
      seq: number;
      reason: "stale-seq" | "stale-versions";
      /** The entries committed after what the writer read: re-observe, then decide again. */
      missed: { from: number; to: number; entries: MissedEntry[] };
      /** Per key that changed: what the writer expected, what it is now, its value, and who changed it last. */
      conflicts?: { key: string; expected: number; current: number; value: unknown; by?: Actor; seq?: number }[];
      duplicate?: true;
    }
  | { status: "invalid"; batchId: string; seq: number; error: string; index?: number; duplicate?: true };

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
  /** Also return what is drawn (`__cad.observe`, without components). */
  observe?: boolean;
}

export interface BridgeReplyMessage {
  type: "uhd-viewer:bridgeReply";
  id: string;
  reply: BatchReply & { observation?: unknown; view?: "3d" | "diagram" };
}

