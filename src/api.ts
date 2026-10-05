/**
 * The viewer's public contract for hosts (docs: protoboard-cli/docs/specs/uhd-boundary.md,
 * "The viewer contract"). A host gives the viewer a UHD bundle, may replace or
 * extend how artifact files resolve, may add diagnostics of its own, and may
 * take over saving the layout the user edits. Nothing here names a host.
 *
 * This file holds types only, so the published declarations stay small.
 */
import type { UhdBundle, UhdBundleDiagnostic } from "@uhd/types/bundle.js";

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
   * double-click expands the module in place.
   */
  onOpenModule?: (request: { path: string }) => void;
  /**
   * The user asked for the pair view of a link (the inspector's pair
   * preview). Given: the host shows it (its own tab or window); otherwise
   * the viewer opens it over the diagram. `linkId` is the link as a
   * selection names it, `a` and `b` the instance paths of the two modules it
   * joins.
   */
  onOpenPair?: (request: { linkId: string; a: string; b: string }) => void;
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
  | { type: "uhd-viewer:setView"; view: ViewerView };

/** Viewer → host events (posted to the parent window, or the options' callbacks). */
export type ViewerEvent =
  | { type: "uhd-viewer:ready" }
  | { type: "uhd-viewer:selectionChanged"; selection: ViewerSelection | null }
  | { type: "uhd-viewer:openSource"; defId: string; instancePath?: string }
  | { type: "uhd-viewer:openArtifact"; defId: string; artifactId: string }
  | { type: "uhd-viewer:openModule"; path: string }
  | { type: "uhd-viewer:openPair"; linkId: string; a: string; b: string };

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
}
