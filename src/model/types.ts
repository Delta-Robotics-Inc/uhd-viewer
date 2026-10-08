/**
 * Neutral view contract (PB-784). The canvas renders only these types; the
 * UHD adapter (./from-uhd.ts) produces them from a system ModuleDef.
 * Every id is a canonical path so layout and selection survive model edits.
 */

export type LinkState = "configured" | "partial" | "incompatible" | "unconfigured";
export type NodeKind = "module" | "group" | "harness" | "net";
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
  /** A board net (PB-823): drawn as a junction its members' grouped membership links meet at. */
  net?: ViewNet;
  /**
   * A rail drawn in several places (PB-873): this junction is a local tap of the
   * net junction with this id, joined to the members near it. Selecting a tap
   * selects the net.
   */
  tapOf?: string;
  /** The bundle does not hold this module's definition: a placeholder with the interfaces its links name. */
  missing?: boolean;
}

/** A net on a board (UHD `Net` interface, exposed: false), as a junction node. */
export interface ViewNet {
  /** Net interface id on the board, e.g. "v3v3". */
  id: string;
  name: string;
  /** What the net carries, for the signal classification: "power", "ground", "i2c", "digital"… */
  signal: string;
  /** Design voltage as stated on the net ("3.3 V", "2.5–5.5 V"). */
  voltage?: string;
  /** A ground net: drawn as ground symbols at its members unless GND wires are on. */
  ground: boolean;
  /** Pins on the net. */
  pins: number;
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

/**
 * One lane of an expanded link (PB-803/805): a child interface of the link,
 * or a link derived through a cable. A lane with its own children is itself a
 * bundle and can be opened in place.
 */
export interface ViewLane {
  id: string;
  name: string;
  domain: string;
  protocol: string;
  state: LinkState;
  children: ViewLane[];
  /** Conductor ids this lane carries (ribbon mode groups them under the lane). */
  conductors?: string[];
}

/** One physical conductor of a link, for ribbon (detailed) mode. */
export interface ViewConductor {
  id: string;
  label: string;
  /** Signal protocol of the conductor, for its colour ("power", "ground", "uart", …). */
  protocol: string;
  domain: string;
  /** DRC state of the connection this conductor carries. */
  state: LinkState;
}

/** The harness a link runs through, drawn as a region along its route. */
export interface ViewHarnessRun {
  /** Harness child path at this level. */
  id: string;
  /** Its UHD definition id (for the inspector: artifacts, thumbnail, CAD). */
  defId: string;
  name: string;
  icon: string;
  /** Carried by a physical cable (connector ends) rather than named on a logical link. */
  physical: boolean;
  /** Only the first link of a harness carries its name tab. */
  tab: boolean;
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
  /** Other stored link ids drawn by this link (the second half of a cable). */
  alsoIds?: string[];
  /** Lanes shown when the link is expanded (basic mode). */
  lanes?: ViewLane[];
  /** Conductors shown in ribbon (detailed) mode. */
  conductors?: ViewConductor[];
  /** Harness region along the route. */
  run?: ViewHarnessRun;
  /** Child links are a stored override (remapped by the user). */
  manual?: boolean;
  /** Grouped net membership (PB-823): one line from a component to a net, its pins as children. */
  net?: { id: string; name: string };
  diagnostics: string[];
}

/**
 * A functional link UHD derives over a board's nets (an I2C bus, a supply to
 * a load). It is not drawn as a line of its own: the membership lines it runs
 * over (`via`) carry its state, and the inspector lists it by name.
 */
export interface ViewDerived {
  /** Derived link id (long: the membership links it runs over), prefixed like stored link ids. */
  id: string;
  /** Its name, "I2C0 ↔ I2C": what the viewer shows instead of the id. */
  name: string;
  protocol: string;
  state: LinkState;
  a: { node: string; iface: string };
  b: { node: string; iface: string };
  /** Net node ids it runs over. */
  nets: string[];
  /** View link ids (grouped memberships) it runs over. */
  via: string[];
  /** Conductors: each slot (or pin) and the one it is wired to. */
  children: { a: string; aPin?: string; b: string; bPin?: string }[];
  diagnostics: string[];
}

export interface ViewModel {
  /** Breadcrumb labels for the level being viewed. */
  path: { id: string; label: string }[];
  nodes: ViewNode[];
  links: ViewLink[];
  /** Functional links derived over the level's nets (and nets of modules expanded in place). */
  derived: ViewDerived[];
}
