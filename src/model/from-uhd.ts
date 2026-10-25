/**
 * Adapter: UHD system ModuleDef → neutral view model.
 *
 * A level shows the children of one module. Children that have children of
 * their own are drawn expanded in place when listed in `expanded` (their
 * boundary ports are exports, joined to the inner ports by pass-through
 * lines); otherwise they are drawn as a single card with boundary ports.
 * Harness children (kind "harness") become harness nodes, and every link
 * they carry is drawn in two segments through them. System diagnostics
 * (checkSystem) are overlaid onto link state for DRC colouring.
 */
import type { ChildLink, InterfaceDef, InterfaceLink, ModuleDef } from "@uhd/types/index.js";
import {
  boundaryInterfaces,
  resolveExports,
  validateLinks,
  type LinkResult,
  type ModuleLookup,
  type ResolvedEndpoint,
} from "@uhd/system/index.js";
import { deriveLinks } from "@uhd/system/derive.js";
import type { SystemDiagnostic } from "@uhd/system/checks.js";
import { isConnector } from "@uhd/protocols/connector.js";
import { isNetMembership } from "@uhd/system/nets.js";
import { levelNets, type LevelNets } from "./nets";
import { isPlaceholder } from "../source/tolerant";
import type {
  LinkState,
  ViewChildPort,
  ViewConductor,
  ViewLane,
  ViewLink,
  ViewModel,
  ViewNode,
  ViewPort,
} from "./types";

/**
 * UHD taxonomy paths (UHD docs/taxonomy.md) and their icons, matched by whole
 * segments in the definition's category order, before the words below:
 * `actuator.motor_controller` (an ESC) is not under `actuator.motor`.
 */
const TAXONOMY_ICONS: [string, string][] = [
  ["actuator.motor_controller", "zap"],
  ["actuator.motor", "rotate-cw"],
  ["mechanical.propeller", "fan"],
  ["microcontroller.flight_controller", "cpu"],
  ["power.battery", "battery-full"],
  ["connectivity.wireless.video", "video"],
  ["sensor.gnss", "satellite"],
  ["mechanical.structure", "hexagon"],
  ["component.passive.capacitor", "battery-medium"],
];

const underPath = (path: string, root: string) => path === root || path.startsWith(`${root}.`);

/** Words in categories and tags (strap before battery: a battery strap is a strap). */
const CATEGORY_ICONS: Record<string, string> = {
  "flight-controller": "cpu",
  esc: "zap",
  motor: "rotate-cw",
  propeller: "fan",
  strap: "link",
  battery: "battery-full",
  receiver: "radio",
  video: "video",
  gnss: "satellite",
  structure: "hexagon",
  capacitor: "battery-medium",
};

function iconFor(def: ModuleDef): string {
  if (def.display?.icon) return def.display.icon;
  for (const path of def.categories ?? []) for (const [root, icon] of TAXONOMY_ICONS) if (underPath(path, root)) return icon;
  const words = [...(def.categories ?? []), ...(def.tags ?? [])].map((w) => w.toLowerCase());
  for (const word of words) {
    for (const [key, icon] of Object.entries(CATEGORY_ICONS)) {
      if (word.includes(key)) return icon;
    }
  }
  if (/esc/i.test(def.name)) return "zap";
  if (/battery strap|strap/i.test(def.name)) return "link";
  if (/battery|lipo/i.test(def.name)) return "battery-full";
  if (/capacitor/i.test(def.name)) return "battery-medium";
  if (/receiver|elrs/i.test(def.name)) return "radio";
  if (/gnss|gps/i.test(def.name)) return "satellite";
  if (/motor/i.test(def.name)) return "rotate-cw";
  if (/prop/i.test(def.name)) return "fan";
  if (/air unit|camera|video/i.test(def.name)) return "video";
  if (/flight controller/i.test(def.name)) return "cpu";
  return "box";
}

function shapeFor(def: ModuleDef): ViewNode["shape"] {
  if (def.kind === "harness") return "pill";
  if (def.display?.shape === "circle") return "circle";
  // a motor controller (taxonomy actuator.motor_controller) is not a motor
  const categories = (def.categories ?? []).filter((c) => !underPath(c, "actuator.motor_controller"));
  return /motor|propeller|\bprop\b/i.test(`${def.name} ${categories.join(" ")} ${(def.tags ?? []).join(" ")}`) &&
    !def.children?.length
    ? "circle"
    : "rect";
}

function childPorts(owner: ModuleDef | undefined, iface: InterfaceDef): ViewChildPort[] {
  if (!iface.slots?.length) return [];
  const profile = iface.profiles?.[0];
  return iface.slots.map((slot) => {
    const bound = profile?.bindings[slot.id];
    const leafId = typeof bound === "string" ? bound : Array.isArray(bound) ? bound[0] : undefined;
    const leaf = leafId ? owner?.interfaces.find((i) => i.id === leafId) : undefined;
    return {
      slotId: slot.id,
      name: leaf?.name ?? slot.id.toUpperCase(),
      leafId,
      pin: leaf?.pin !== undefined ? String(leaf.pin) : undefined,
    };
  });
}

function toPort(iface: InterfaceDef, owner: ModuleDef, exported?: ViewPort["exported"]): ViewPort {
  return {
    id: iface.id,
    name: iface.name ?? iface.id,
    domain: iface.domain,
    protocol: iface.protocols[0]?.type ?? "custom",
    roles: iface.protocols[0]?.roles ?? [],
    children: childPorts(owner, iface),
    ...(exported ? { exported } : {}),
  };
}

function portsOf(def: ModuleDef, lookup: ModuleLookup): ViewPort[] {
  const own = boundaryInterfaces(def, lookup);
  const exports = new Map(
    (def.exports?.length || def.kind === "group" ? resolveExports(def, lookup) : []).map((e) => [e.id, e]),
  );
  return own.map((iface) => {
    const ex = exports.get(iface.id);
    if (!ex) return toPort(iface, def);
    // a net port (UHD 0.3.0) exports the module's own net: no child behind it to draw a pass-through to
    return "child" in ex.from ? toPort(iface, ex.childDef, { child: ex.from.child, interfaceId: ex.from.interfaceId }) : toPort(iface, def);
  });
}

const isGround = (r: LinkResult) =>
  [r.a.iface, r.b.iface].every((i) => i.protocols.some((p) => p.type === "power" && p.roles.includes("ground")));

const RANK: Record<LinkState, number> = { incompatible: 3, partial: 2, unconfigured: 1, configured: 0 };

function worst(states: LinkState[]): LinkState {
  return states.reduce<LinkState>((w, s) => (RANK[s] > RANK[w] ? s : w), "configured");
}

/** Link ids whose child links are stored overrides. */
type Overrides = Record<string, ChildLink[]>;

function toLinks(r: LinkResult, prefix: string, harnessNode: string | undefined, manual: boolean): ViewLink[] {
  const endpoint = (end: typeof r.link.a) =>
    "child" in end
      ? { node: prefix + end.child, port: end.interfaceId }
      : { node: prefix.replace(/\/$/, ""), port: end.interfaceId };
  const linkId = prefix + r.link.id;
  const base: Omit<ViewLink, "id" | "source" | "target"> = {
    linkId,
    name: r.link.name ?? r.link.id,
    domain: r.a.iface.domain,
    protocol: r.protocol,
    state: r.state,
    children: r.children.map((c, i) => ({
      id: `${linkId}#${i}`,
      label: (c.a.slotId ?? c.a.leafId).toUpperCase(),
      a: c.a.slotId ?? c.a.leafId,
      b: c.b.slotId ?? c.b.leafId,
      aPin: c.a.pin,
      bPin: c.b.pin,
      state: r.state,
    })),
    ...(isGround(r) ? { ground: true } : {}),
    ...(manual ? { manual: true } : {}),
    diagnostics: [...r.diagnostics.map((d) => d.message), ...r.unresolvedSlots.map((s) => `unresolved slot ${s}`)],
  };
  const source = endpoint(r.link.a);
  const target = endpoint(r.link.b);
  // ground returns stay ground symbols at their ports rather than routing through the harness
  if (!harnessNode || isGround(r)) return [{ ...base, id: linkId, source, target }];
  return [
    { ...base, id: linkId, source, target: { node: harnessNode, port: `${r.link.id}:a` }, harness: harnessNode, segment: "a" },
    { ...base, id: `${linkId}~b`, source: { node: harnessNode, port: `${r.link.id}:b` }, target, harness: harnessNode, segment: "b" },
  ];
}

/** "UART5 (DJI)" → "UART5", "10V/12V BEC" → "10V/12V": a lane label short enough for the canvas. */
const shortName = (name: string) => name.split(/\s[(—-]|\s(?=[A-Z][a-z])/)[0].trim();

function leafProtocol(iface: InterfaceDef | undefined): string {
  const p = iface?.protocols[0];
  if (!p) return "custom";
  if (p.type === "power" && p.roles.includes("ground")) return "ground";
  return p.type;
}

/**
 * Signal type of a lane or conductor (signal classification): what the link it
 * belongs to carries (I2C, UART, power…), except that a ground is a ground.
 * Leaves alone are not enough: I2C's SCL and SDA are declared as digital lines.
 */
function signalOf(linkProtocol: string, leaf?: InterfaceDef): string {
  return leafProtocol(leaf) === "ground" ? "ground" : linkProtocol;
}

/** The leaf interface behind one position of a resolved connector end. */
function positionLeaf(end: ResolvedEndpoint, slot: string): InterfaceDef | undefined {
  const composed = end.composed?.[slot];
  if (composed) return composed.iface;
  const bound = end.iface.profiles?.[0]?.bindings[slot];
  const id = Array.isArray(bound) ? bound[0] : bound;
  return id ? end.owner.interfaces.find((i) => i.id === id) : undefined;
}

function laneOf(r: LinkResult): ViewLane {
  const names = [r.a.iface.name ?? r.a.iface.id, r.b.iface.name ?? r.b.iface.id].map(shortName);
  // a bundle is named for what it is ("UART", "I2C"), not which instance ("UART1"): it opens to show its signals
  const shortest = names.sort((x, y) => x.length - y.length)[0].toUpperCase();
  const name = r.children.length > 1 ? shortest.replace(/(?<=[A-Z])\d+$/, "") : shortest;
  const leafOf = (id?: string) => r.a.owner.interfaces.find((x) => x.id === id);
  return {
    id: r.link.id,
    name,
    domain: r.a.iface.domain,
    protocol: signalOf(r.protocol, r.a.iface),
    state: STATE_OF(r),
    children:
      r.children.length > 1
        ? r.children.map((c, i) => ({
            id: `${r.link.id}#${i}`,
            name: (c.a.slotId ?? c.a.leafId).replace(/^.*_/, "").toUpperCase(),
            domain: r.a.iface.domain,
            protocol: signalOf(r.protocol, leafOf(c.a.leafId)),
            state: STATE_OF(r),
            children: [],
          }))
        : [],
  };
}

const STATE_OF = (r: LinkResult): LinkState => r.state as LinkState;

export interface LevelLinks {
  links: ViewLink[];
  /** Harness children drawn as regions on links, not as nodes. */
  regionHarnesses: Set<string>;
  /** Stored or derived link id → the view link that draws it (for diagnostics). */
  owners: Map<string, string>;
  /** Every link UHD derives at this level (through cables and over nets). */
  derived: LinkResult[];
}

/**
 * The links of one level (PB-803/805). A harness with exactly two connector
 * ends becomes one link from part to part with the harness as a region along
 * it; its lanes are the links derived through its conductors and its
 * conductors are the mated positions. Logical links that name a harness get
 * the same region. Anything else keeps its own line.
 */
export function levelLinks(
  def: ModuleDef,
  results: LinkResult[],
  lookup: ModuleLookup,
  prefix: string,
  overrides: Overrides | undefined,
): LevelLinks {
  const derived = deriveLinks(def, lookup, results);
  const links: ViewLink[] = [];
  const consumed = new Set<string>();
  const regionHarnesses = new Set<string>();
  const owners = new Map<string, string>();
  const tabbed = new Set<string>();

  for (const ref of def.children ?? []) {
    const h = lookup(ref.moduleDefId);
    if (h?.kind !== "harness") continue;
    const ends = results.filter((r) => r.protocol === "connector" && [r.a, r.b].some((e) => e.owner === h && e.ownerPath[0] === ref.id));
    if (ends.length !== 2) continue;
    const part = (r: LinkResult) => (r.a.owner === h && r.a.ownerPath[0] === ref.id ? { end: r.link.b, res: r.b, first: false } : { end: r.link.a, res: r.a, first: true });
    const [r1, r2] = ends;
    const p1 = part(r1);
    const p2 = part(r2);
    const via = new Set([r1.link.id, r2.link.id]);
    const carried = derived.filter((d) => d.derived!.via.some((v) => via.has(v)));
    const lanes = carried.map(laneOf);
    const conductors: ViewConductor[] = r1.children.map((c, i) => {
      const slot = p1.first ? c.a.slotId : c.b.slotId;
      const leaf = slot ? positionLeaf(p1.res, slot) : undefined;
      const label = p1.res.iface.slots?.find((x) => x.id === slot)?.label ?? leaf?.name ?? slot ?? String(i + 1);
      // the derived link this conductor belongs to decides its DRC state
      const owner = leaf
        ? carried.find((d) => [d.a.iface.id, d.b.iface.id].includes(leaf.id) || d.children.some((ch) => ch.a.leafId === leaf.id || ch.b.leafId === leaf.id))
        : undefined;
      const id = `${r1.link.id}#${slot ?? i}`;
      if (owner && leaf) {
        // group the conductor under its lane, and under the lane's child when it carries one
        const lane = lanes.find((l) => l.id === owner.link.id)!;
        (lane.conductors ??= []).push(id);
        const k = owner.children.findIndex((ch) => ch.a.leafId === leaf.id || ch.b.leafId === leaf.id);
        if (k >= 0 && lane.children[k]) (lane.children[k].conductors ??= []).push(id);
      }
      return {
        id,
        label: label.toUpperCase(),
        protocol: owner ? signalOf(owner.protocol, leaf) : leafProtocol(leaf),
        domain: leaf?.domain ?? r1.a.iface.domain,
        state: owner ? STATE_OF(owner) : STATE_OF(r1),
      };
    });
    const states = [r1, r2, ...carried].map(STATE_OF);
    const state = states.reduce<LinkState>((w, x) => (RANK[x] > RANK[w] ? x : w), "configured");
    const protocols = [...new Set(lanes.map((l) => l.protocol))];
    const endpoint = (end: InterfaceLink["a"]) => ("child" in end ? { node: prefix + end.child, port: end.interfaceId } : { node: prefix.replace(/\/$/, ""), port: end.interfaceId });
    const id = prefix + r1.link.id;
    links.push({
      id,
      linkId: id,
      alsoIds: [prefix + r2.link.id],
      source: endpoint(p1.end),
      target: endpoint(p2.end),
      name: `${lanes.length} LINK${lanes.length === 1 ? "" : "S"}`,
      domain: r1.a.iface.domain,
      // the cable reads as the signal it carries (UART, I2C…), or as power when it only carries supply and return
      protocol: protocols.find((p) => p !== "power" && p !== "ground") ?? (protocols.includes("power") || protocols.includes("ground") ? "power" : protocols[0] ?? "custom"),
      state,
      children: lanes.map((l) => ({ id: l.id, label: l.name, a: l.name, b: l.name, state: l.state })),
      lanes,
      conductors,
      run: { id: prefix + ref.id, defId: h.id, name: (ref.name ?? h.name).toUpperCase(), icon: h.display?.icon ?? "cable", physical: true, tab: true },
      diagnostics: [...r1.diagnostics, ...r2.diagnostics, ...carried.flatMap((d) => d.diagnostics)].map((d) => d.message),
    });
    consumed.add(r1.link.id).add(r2.link.id);
    regionHarnesses.add(ref.id);
    for (const x of [r1, r2, ...carried]) owners.set(prefix + x.link.id, id);
  }

  for (const r of results) {
    // net memberships are drawn grouped, per component and net (./nets.ts)
    if (consumed.has(r.link.id) || isNetMembership(r)) continue;
    const harnessRef = r.link.harness ? def.children?.find((c) => c.id === r.link.harness) : undefined;
    const harnessDef = harnessRef ? lookup(harnessRef.moduleDefId) : undefined;
    const [view] = toLinks(r, prefix, undefined, Boolean(prefix === "" && overrides?.[r.link.id]));
    if (r.children.length > 1) {
      const leafOf = (id?: string) => r.a.owner.interfaces.find((x) => x.id === id);
      view.lanes = r.children.map((c, i) => ({
        id: `${view.id}#${i}`,
        name: (c.a.slotId ?? c.a.leafId).replace(/^.*_/, "").toUpperCase(),
        domain: r.a.iface.domain,
        protocol: signalOf(r.protocol, leafOf(c.a.leafId)),
        state: STATE_OF(r),
        children: [],
        conductors: [`${view.id}#c${i}`],
      }));
      view.conductors = r.children.map((c, i) => ({
        id: `${view.id}#c${i}`,
        label: (c.a.pin ?? c.a.slotId ?? c.a.leafId).toUpperCase(),
        protocol: signalOf(r.protocol, leafOf(c.a.leafId)),
        domain: r.a.iface.domain,
        state: STATE_OF(r),
      }));
    }
    if (harnessRef && harnessDef?.kind === "harness") {
      view.run = {
        id: prefix + harnessRef.id,
        defId: harnessDef.id,
        name: (harnessRef.name ?? harnessDef.name).toUpperCase(),
        icon: harnessDef.display?.icon ?? "cable",
        physical: false,
        tab: !tabbed.has(harnessRef.id),
      };
      tabbed.add(harnessRef.id);
      regionHarnesses.add(harnessRef.id);
    }
    owners.set(prefix + r.link.id, view.id);
    links.push(view);
  }
  return { links, regionHarnesses, owners, derived };
}

/**
 * Carry a check result on a link down to what is drawn inside it, so expanded
 * lanes and ribbon conductors follow the DRC classification too: a finding on
 * the link itself applies to all of them, one on a link derived through a
 * cable only to that lane (and its conductors).
 */
function overlayChildren(link: ViewLink, refId: string, state: LinkState) {
  const bump = (x: { state: LinkState }) => {
    if (RANK[state] > RANK[x.state]) x.state = state;
  };
  const all = (ls: ViewLane[]): ViewLane[] => ls.flatMap((l) => [l, ...all(l.children)]);
  const direct = link.linkId === refId || link.alsoIds?.includes(refId) || !link.run?.physical;
  const hit = direct ? all(link.lanes ?? []) : all((link.lanes ?? []).filter((l) => l.id === refId));
  hit.forEach(bump);
  const conductorIds = new Set(hit.flatMap((l) => l.conductors ?? []));
  for (const c of link.conductors ?? []) if (direct || conductorIds.has(c.id)) bump(c);
}

export interface BuildOptions {
  /** Child ids (at this level) drawn expanded in place. */
  expanded: Set<string>;
  /** Stored child-link overrides keyed by link id (top level). */
  overrides?: Overrides;
  /**
   * System diagnostics to overlay on link state. Refs are relative to the
   * root; findings of a board checked on its own (see App) carry its path
   * (`link:board/<id>`), so they overlay when that board is drilled into.
   */
  diagnostics?: SystemDiagnostic[];
  /** Draw ground nets as junctions with wires (GND wires on) rather than as ground symbols. */
  grounds?: boolean;
}

/** Apply child-link overrides to a module's stored links. */
export function withOverrides(def: ModuleDef, overrides: Overrides | undefined): ModuleDef {
  if (!overrides || !Object.keys(overrides).length) return def;
  return {
    ...def,
    links: (def.links ?? []).map((l: InterfaceLink) => (overrides[l.id] ? { ...l, childLinks: overrides[l.id] } : l)),
  };
}

/** Descend `drill` child ids from the root to find the module shown at this level. */
export function levelModule(root: ModuleDef, drill: string[], lookup: ModuleLookup): { def: ModuleDef; path: ViewModel["path"] } {
  let def = root;
  const path: ViewModel["path"] = [{ id: "", label: root.name }];
  for (const childId of drill) {
    const ref = def.children?.find((c) => c.id === childId);
    const next = ref ? lookup(ref.moduleDefId) : undefined;
    if (!ref || !next) break;
    path.push({ id: path.length > 1 ? `${path[path.length - 1].id}/${childId}` : childId, label: ref.name ?? next.name });
    def = next;
  }
  return { def, path };
}

export function buildView(root: ModuleDef, lookup: ModuleLookup, drill: string[], opts: BuildOptions): ViewModel {
  const { def: rawLevel, path } = levelModule(root, drill, lookup);
  const level = drill.length === 0 ? withOverrides(rawLevel, opts.overrides) : rawLevel;
  const nodes: ViewNode[] = [];
  const links: ViewLink[] = [];

  const nodeFor = (id: string, name: string | undefined, def: ModuleDef, parent?: string, expanded = false): ViewNode => ({
    id,
    label: (name ?? def.name).toUpperCase(),
    icon: iconFor(def),
    kind: def.kind ?? "module",
    ...(parent ? { parent } : {}),
    ...(expanded ? { expanded } : {}),
    // a harness shows its connector ends (PB-805); carried logical links add their own pairs
    ports: def.kind === "harness" ? def.interfaces.filter(isConnector).map((i) => toPort(i, def)) : portsOf(def, lookup),
    shape: expanded ? "rect" : shapeFor(def),
    status: "configured",
    defId: def.id,
    manufacturer: def.manufacturer,
    partNumber: def.part_number,
    description: def.description,
    category: def.categories?.[0],
    childCount: def.kind === "harness" ? 0 : (def.children?.length ?? 0),
    ...(isPlaceholder(def) ? { missing: true } : {}),
  });

  /** Harness ports: one in/out pair per carried link. */
  const addHarnessPorts = (node: ViewNode, results: LinkResult[]) => {
    for (const r of results) {
      if (r.link.harness !== node.id.split("/").pop() || isGround(r)) continue;
      for (const side of ["a", "b"] as const) {
        node.ports.push({
          id: `${r.link.id}:${side}`,
          name: r.link.name ?? r.link.id,
          domain: r.a.iface.domain,
          protocol: r.protocol,
          roles: [],
          children: [],
        });
      }
    }
  };

  // Sheet ports: the level module's own boundary, drawn at the canvas edges.
  if (drill.length > 0) {
    for (const port of portsOf(level, lookup)) {
      nodes.push({
        id: `@${port.id}`,
        label: port.name.toUpperCase(),
        icon: "arrow-right-left",
        kind: "module",
        ports: [{ ...port }],
        shape: "rect",
        status: "configured",
        childCount: 0,
        sheetPort: true,
      });
      if (port.exported) {
        links.push({
          id: `@${port.id}->${port.exported.child}`,
          linkId: `@${port.id}`,
          source: { node: `@${port.id}`, port: port.id },
          target: { node: port.exported.child, port: port.exported.interfaceId },
          name: port.name,
          domain: port.domain,
          protocol: port.protocol,
          state: "configured",
          children: [],
          passThrough: true,
          diagnostics: [],
        });
      }
    }
  }

  const levelResults = validateLinks(level, lookup);
  const top = levelLinks(level, levelResults, lookup, "", opts.overrides);
  const owners = new Map(top.owners);
  const grounds = opts.grounds ?? false;
  // board nets: junction nodes and grouped membership lines (./nets.ts)
  const netLevels: LevelNets[] = [levelNets(level, levelResults, top.derived, lookup, "", { grounds })];
  /** Link-scoped compositions (PB-805) are ports on their child for as long as the link exists. */
  const addComposedPorts = (results: LinkResult[], prefix: string) => {
    for (const r of results) {
      for (const [end, resolved] of [[r.link.a, r.a], [r.link.b, r.b]] as const) {
        if (!("child" in end) || !end.compose) continue;
        const node = nodes.find((n) => n.id === prefix + end.child);
        if (!node || node.ports.some((p) => p.id === end.interfaceId)) continue;
        node.ports.push({
          ...toPort(resolved.iface, resolved.owner),
          name: resolved.iface.name ?? end.interfaceId,
          children: Object.entries(resolved.composed ?? {}).map(([slotId, c]) => ({
            slotId,
            name: c.iface.name ?? c.iface.id,
            leafId: c.iface.id,
            pin: c.iface.pin !== undefined ? String(c.iface.pin) : undefined,
          })),
        });
      }
    }
  };

  for (const ref of level.children ?? []) {
    const def = lookup(ref.moduleDefId);
    if (!def) continue;
    const expanded = opts.expanded.has(ref.id) && (def.children?.length ?? 0) > 0 && def.kind !== "harness";
    if (def.kind === "harness" && top.regionHarnesses.has(ref.id)) continue;
    const node = nodeFor(ref.id, ref.name, def, undefined, expanded);
    if (def.kind === "harness") addHarnessPorts(node, levelResults);
    nodes.push(node);
    if (!expanded) continue;

    const innerResults = validateLinks(def, lookup);
    const innerLinks = levelLinks(def, innerResults, lookup, `${ref.id}/`, undefined);
    for (const [k, v] of innerLinks.owners) owners.set(k, v);
    netLevels.push(levelNets(def, innerResults, innerLinks.derived, lookup, `${ref.id}/`, { grounds, parent: ref.id }));
    for (const inner of def.children ?? []) {
      const innerDef = lookup(inner.moduleDefId);
      if (!innerDef) continue;
      if (innerDef.kind === "harness" && innerLinks.regionHarnesses.has(inner.id)) continue;
      const innerNode = nodeFor(`${ref.id}/${inner.id}`, inner.name, innerDef, ref.id);
      if (innerDef.kind === "harness") addHarnessPorts(innerNode, innerResults);
      nodes.push(innerNode);
    }
    addComposedPorts(innerResults, `${ref.id}/`);
    links.push(...innerLinks.links);

    // pass-through lines from each boundary export to the child port it exposes
    const exports = def.exports?.length || def.kind === "group" ? resolveExports(def, lookup) : [];
    for (const ex of exports) {
      // a net port's net is drawn as the sub-module's own junction, joined by its memberships
      if (!("child" in ex.from)) continue;
      links.push({
        id: `${ref.id}:${ex.id}`,
        linkId: `${ref.id}:${ex.id}`,
        source: { node: ref.id, port: ex.id },
        target: { node: `${ref.id}/${ex.from.child}`, port: ex.from.interfaceId },
        name: ex.name ?? ex.id,
        domain: ex.iface.domain,
        protocol: ex.iface.protocols[0]?.type ?? "custom",
        state: "configured",
        children: [],
        passThrough: true,
        diagnostics: [],
      });
    }
  }

  addComposedPorts(levelResults, "");
  links.push(...top.links);

  const derived: ViewModel["derived"] = [];
  const derivedOwners = new Map<string, string[]>();
  for (const n of netLevels) {
    nodes.push(...n.nodes);
    links.push(...n.links);
    derived.push(...n.derived);
    for (const [k, v] of n.owners) owners.set(k, v);
    for (const [k, v] of n.derivedOwners) derivedOwners.set(k, v);
    for (const [nodeId, ports] of n.ports) {
      const node = nodes.find((x) => x.id === nodeId);
      if (node) node.ports.push(...ports.filter((p) => !node.ports.some((q) => q.id === p.id)));
    }
  }

  // overlay system diagnostics on the links of this level: errors → incompatible, warnings → partial
  const levelPrefix = drill.length ? `${drill.join("/")}/` : "";
  for (const d of opts.diagnostics ?? []) {
    if (d.severity === "info") continue;
    const state: LinkState = d.severity === "error" ? "incompatible" : "partial";
    for (const ref of d.refs) {
      if (!ref.startsWith("link:") || !ref.startsWith(`link:${levelPrefix}`)) continue;
      const id = ref.slice(5 + levelPrefix.length);
      for (const x of derived.filter((x) => x.id === id)) {
        if (RANK[state] > RANK[x.state]) x.state = state;
        if (!x.diagnostics.includes(d.message)) x.diagnostics.push(d.message);
      }
      const targets = derivedOwners.get(id) ?? [owners.get(id) ?? id];
      for (const link of links.filter((l) => targets.includes(l.linkId))) {
        if (RANK[state] > RANK[link.state]) link.state = state;
        if (!link.diagnostics.includes(d.message)) link.diagnostics.push(d.message);
        overlayChildren(link, id, state);
      }
    }
  }

  // node status = worst state of the links touching it
  for (const node of nodes) {
    const touching = links.filter(
      (l) => !l.passThrough && (l.source.node === node.id || l.target.node === node.id || l.source.node.startsWith(`${node.id}/`) || l.target.node.startsWith(`${node.id}/`)),
    );
    node.status = touching.length ? worst(touching.map((l) => l.state)) : "unconfigured";
  }

  return { path, nodes, links, derived };
}
