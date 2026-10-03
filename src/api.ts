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
}

export interface ViewerHandle {
  /**
   * Re-renders with changed options (a rebuilt bundle, new host diagnostics, a
   * changed layout). The change is merged into the current options; giving
   * `bundleUrl` without `bundle` drops a bundle given earlier and loads from
   * the URL.
   */
  update(options: Partial<ViewerOptions>): void;
  unmount(): void;
}
