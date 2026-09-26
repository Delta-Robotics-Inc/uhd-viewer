/**
 * Neutral view contract (PB-784). The canvas renders only these types; the
 * UHD adapter (./from-uhd.ts) produces them from a system ModuleDef.
 * Every id is a canonical path so layout and selection survive model edits.
 */

export type LinkState = "configured" | "partial" | "incompatible" | "unconfigured";
export type NodeKind = "module" | "group" | "harness";
export type Shape = "rect" | "circle" | "pill";

/** A child interface revealed when a link is opened (a slot and the leaf bound to it). */
export interface ViewChildPort {
  slotId: string;
  name: string;
  /** Leaf interface id on the module, e.g. "gnss_uart_tx". */
  leafId?: string;
  /** Pad or pin label, e.g. "TX". */
  pin?: string;
}

export interface ViewPort {
  /** Interface id on its module (or export id on a group/module boundary). */
  id: string;
  name: string;
  domain: string;
  /** Primary protocol type, used for signal-type classification and grouping. */
  protocol: string;
  roles: string[];
  children: ViewChildPort[];
  /** True when the port is a boundary export of a child interface. */
  exported?: { child: string; interfaceId: string };
}

export interface ViewNode {
  /** Canonical path, e.g. "stack/esc" or "arm_fl". */
  id: string;
  label: string;
  icon: string;
  kind: NodeKind;
  /** Parent node path when drawn inside an expanded module or group. */
  parent?: string;
  /** True when the node has children and is drawn expanded in place. */
  expanded?: boolean;
  ports: ViewPort[];
  shape: Shape;
  status: LinkState;
  /** UHD definition id, for the inspector. */
  defId?: string;
  manufacturer?: string;
  partNumber?: string;
  description?: string;
  category?: string;
  childCount: number;
  /** A boundary port of the drilled-into module, drawn at the canvas edge. */
  sheetPort?: boolean;
}

export interface ViewEndpoint {
  node: string;
  port: string;
}

export interface ViewChildLink {
  id: string;
  label: string;
  a: string;
  b: string;
  aPin?: string;
  bPin?: string;
  state: LinkState;
}

export interface ViewLink {
  id: string;
  source: ViewEndpoint;
  target: ViewEndpoint;
  name: string;
  domain: string;
  protocol: string;
  state: LinkState;
  children: ViewChildLink[];
  /** Pass-through from a boundary export to the child interface it exposes. */
  passThrough?: boolean;
  /** Ground return: drawn as ground symbols at both ports instead of a wire. */
  ground?: boolean;
  /** Harness node carrying the link, if any. */
  harness?: string;
  /**
   * A link carried by a harness is drawn as two segments through the harness
   * node: "a" (source → harness, carries the label) and "b" (harness → target).
   */
  segment?: "a" | "b";
  /** Stored link id (shared by both segments). */
  linkId: string;
  /** Child links are a stored override (remapped by the user). */
  manual?: boolean;
  diagnostics: string[];
}

export interface ViewModel {
  /** Breadcrumb labels for the level being viewed. */
  path: { id: string; label: string }[];
  nodes: ViewNode[];
  links: ViewLink[];
}
