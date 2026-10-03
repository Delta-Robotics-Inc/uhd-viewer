/**
 * Board nets in the view model (PB-823; UHD docs/boards-and-nets.md).
 *
 * A net is a `Net` interface on the board itself (protocol `net`, not
 * exposed), joined to each pin on it by a stored membership link. Drawing a
 * line per membership would draw a star of N lines per net, most of them to
 * the same component; drawing every pair would be worse. Instead:
 *
 * - each net is a junction node (`:<net>`; `board:<net>` when the board is
 *   expanded in place);
 * - each component on the net gets one port for it, named for the net, and
 *   one grouped line to the junction whose children are its pins on the net;
 * - a ground net (a ground pin on it and no supply pin) is drawn as ground
 *   symbols at its members, like any ground link, unless GND wires are on;
 * - the functional links UHD derives over the nets (an I2C bus, a supply to
 *   its loads) are listed by name, and their state is carried by the grouped
 *   lines they run over, so a `bus_incomplete` or `harness_wiring` finding
 *   on one turns those lines red, as it does for a cable's lanes.
 */
import type { InterfaceDef, ModuleDef } from "@uhd/types/index.js";
import type { LinkResult, ModuleLookup } from "@uhd/system/index.js";
import { isNet } from "@uhd/protocols/net.js";
import { isNetMembership, netVoltageRange } from "@uhd/system/nets.js";
import { slotBindings } from "@uhd/system/connectors.js";
import type { LinkState, ViewChildPort, ViewDerived, ViewLink, ViewNode, ViewPort } from "./types";

const RANK: Record<LinkState, number> = { incompatible: 3, partial: 2, unconfigured: 1, configured: 0 };
const worst = (states: LinkState[]): LinkState => states.reduce<LinkState>((w, s) => (RANK[s] > RANK[w] ? s : w), "configured");

const hasPower = (i: InterfaceDef, role?: string) => i.protocols.some((p) => p.type === "power" && (!role || p.roles.includes(role)));
const isGroundPin = (i: InterfaceDef) => hasPower(i, "ground");
const isSupplyPin = (i: InterfaceDef) => hasPower(i, "input") || hasPower(i, "output");

/** Node id of a net: the canonical path of the net interface (`:<net>`, or `board:<net>` inside an expanded board). */
export const netNodeId = (prefix: string, net: string) => `${prefix.replace(/\/$/, "")}:${net}`;

/** Port id on a component for its connection to a net. */
export const netPortId = (net: string) => `net:${net}`;

const fmtV = (r: [number, number]) => (r[0] === r[1] ? `${r[0]} V` : `${r[0]}–${r[1]} V`);

/**
 * Label of a grouped membership line: the pin's name, or the distinct names
 * of several ("VDD/VDDIO"), or the first and how many others ("IOVDD +3").
 */
export function pinsLabel(names: string[]): string {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  const distinct = [...counts.keys()];
  if (distinct.length === 1) return distinct[0];
  if (distinct.length === 2) return distinct.join("/");
  return `${distinct[0]} +${distinct.length - 1}`;
}

export interface LevelNets {
  /** Junction nodes (ground nets left out unless `grounds`). */
  nodes: ViewNode[];
  /** One grouped line per component and net. */
  links: ViewLink[];
  /** Ports to add to the component nodes, by node id. */
  ports: Map<string, ViewPort[]>;
  derived: ViewDerived[];
  /** Membership link id (prefixed) → grouped line id. */
  owners: Map<string, string>;
  /** Derived link id (prefixed) → grouped line ids it runs over. */
  derivedOwners: Map<string, string[]>;
}

/**
 * The nets of `def` drawn at a level (`prefix` "" for the level module itself,
 * `<child>/` for a board expanded in place). `results` are the module's stored
 * link results, `derived` the links UHD derives from them.
 */
export function levelNets(
  def: ModuleDef,
  results: LinkResult[],
  derived: LinkResult[],
  lookup: ModuleLookup,
  prefix: string,
  opts: { grounds: boolean; parent?: string },
): LevelNets {
  const out: LevelNets = { nodes: [], links: [], ports: new Map(), derived: [], owners: new Map(), derivedOwners: new Map() };
  const nets = def.interfaces.filter(isNet);
  if (!nets.length) return out;
  const memberships = results.filter(isNetMembership);
  const childName = (id: string) => {
    const ref = def.children?.find((c) => c.id === id);
    return (ref?.name ?? (ref ? lookup(ref.moduleDefId)?.name : undefined) ?? id).toUpperCase();
  };

  for (const net of nets) {
    const mine = memberships.filter((r) => [r.a, r.b].some((e) => e.iface === net && e.ownerPath.length === 0));
    const members = mine.map((r) => {
      const pinEnd = r.a.iface === net ? r.link.b : r.link.a;
      const pin = r.a.iface === net ? r.b : r.a;
      return { r, child: "child" in pinEnd ? pinEnd.child : "", pin: pin.iface };
    });
    const pins = members.map((m) => m.pin);
    const ground = pins.some(isGroundPin) && !pins.some(isSupplyPin);
    const rail = pins.some((p) => hasPower(p)) || Boolean(net.parameters?.some((p) => p.id === "voltage"));
    const over = derived.filter((d) => d.derived?.nets?.includes(net.id));
    const leaf = pins.map((p) => p.protocols[0]?.type).find((t) => t && t !== "passive" && t !== "custom");
    const signal = ground ? "ground" : rail ? "power" : (over.find((d) => d.protocol !== "power")?.protocol ?? leaf ?? "custom");
    const range = netVoltageRange(net);
    const nodeId = netNodeId(prefix, net.id);
    const children = [...new Set(members.map((m) => m.child))];

    if (!ground || opts.grounds) {
      out.nodes.push({
        id: nodeId,
        label: (net.name ?? net.id).toUpperCase(),
        icon: ground ? "arrow-down-to-line" : "git-commit-horizontal",
        kind: "net",
        ...(opts.parent ? { parent: opts.parent } : {}),
        ports: children.map((c) => ({ id: c, name: childName(c), domain: "electrical", protocol: signal, roles: [], children: [] })),
        shape: "pill",
        status: "configured",
        childCount: 0,
        description: `Net ${net.name ?? net.id}: ${pins.length} pin${pins.length === 1 ? "" : "s"}${range ? `, ${fmtV(range)}` : ""}`,
        net: { id: net.id, name: net.name ?? net.id, signal, ...(range ? { voltage: fmtV(range) } : {}), ground, pins: pins.length },
      });
    }

    for (const child of children) {
      const group = members.filter((m) => m.child === child);
      const nodeOfChild = prefix + child;
      const portId = netPortId(net.id);
      const pinPorts: ViewChildPort[] = group.map((m) => ({
        slotId: m.pin.id,
        name: m.pin.name ?? m.pin.id,
        leafId: m.pin.id,
        ...(m.pin.pin !== undefined ? { pin: String(m.pin.pin) } : {}),
      }));
      const list = out.ports.get(nodeOfChild) ?? [];
      list.push({ id: portId, name: net.name ?? net.id, domain: "electrical", protocol: signal, roles: [], children: pinPorts });
      out.ports.set(nodeOfChild, list);

      const id = `${prefix}${net.id}.${child}`;
      const memberIds = group.map((m) => prefix + m.r.link.id);
      const state = worst(group.map((m) => m.r.state as LinkState));
      out.links.push({
        id,
        linkId: id,
        alsoIds: memberIds,
        source: { node: nodeOfChild, port: portId },
        target: { node: nodeId, port: child },
        name: pinsLabel(group.map((m) => m.pin.name ?? m.pin.id)),
        domain: "electrical",
        protocol: signal,
        state,
        children: group.map((m) => ({
          id: prefix + m.r.link.id,
          label: m.pin.name ?? m.pin.id,
          a: m.pin.id,
          b: net.name ?? net.id,
          ...(m.pin.pin !== undefined ? { aPin: String(m.pin.pin) } : {}),
          state: m.r.state as LinkState,
        })),
        ...(group.length > 1
          ? {
              lanes: group.map((m, i) => ({
                id: `${id}#${i}`,
                name: (m.pin.name ?? m.pin.id).toUpperCase(),
                domain: "electrical",
                protocol: signal,
                state: m.r.state as LinkState,
                children: [],
                conductors: [`${id}#c${i}`],
              })),
              conductors: group.map((m, i) => ({
                id: `${id}#c${i}`,
                label: String(m.pin.pin ?? m.pin.name ?? m.pin.id).toUpperCase(),
                protocol: signal,
                domain: "electrical",
                state: m.r.state as LinkState,
              })),
            }
          : {}),
        ...(ground ? { ground: true } : {}),
        net: { id: net.id, name: net.name ?? net.id },
        diagnostics: group.flatMap((m) => m.r.diagnostics.map((d) => d.message)),
      });
      for (const m of memberIds) out.owners.set(m, id);
    }
  }

  // functional links over the nets, by name, carried by the grouped lines they run over
  for (const d of derived) {
    if (!d.derived?.nets?.length) continue;
    // the lines it runs over, and every line carrying a pin of either end: a bus whose SDA landed on
    // another net shows that line too, where a line of its own would be missing
    const pinsOf = (e: LinkResult["a"]) => new Set([e.iface.id, ...Object.values(slotBindings(e.iface))]);
    const carrying = [d.a, d.b].flatMap((e) => {
      const pins = pinsOf(e);
      return out.links.filter((l) => l.source.node === prefix + (e.ownerPath[0] ?? "") && l.children.some((c) => pins.has(c.a))).map((l) => l.id);
    });
    const via = [...new Set([...d.derived.via.map((v) => out.owners.get(prefix + v)).filter((x): x is string => Boolean(x)), ...carrying])];
    const id = prefix + d.link.id;
    out.derivedOwners.set(id, via);
    const end = (e: LinkResult["a"]) => ({ node: prefix + (e.ownerPath[0] ?? ""), iface: e.path.slice(e.path.indexOf(":") + 1) });
    out.derived.push({
      id,
      name: d.link.name ?? d.link.id,
      protocol: d.protocol,
      state: d.state as LinkState,
      a: end(d.a),
      b: end(d.b),
      nets: d.derived.nets.map((n) => netNodeId(prefix, n)),
      via,
      children: d.children.map((c) => ({ a: c.a.slotId ?? c.a.leafId, aPin: c.a.pin, b: c.b.slotId ?? c.b.leafId, bPin: c.b.pin })),
      diagnostics: d.diagnostics.map((x) => x.message),
    });
    // the lines it runs over carry its state, as a cable's lanes carry the links derived through it
    for (const line of out.links.filter((l) => via.includes(l.id))) {
      if (RANK[d.state as LinkState] > RANK[line.state]) line.state = d.state as LinkState;
      for (const x of d.diagnostics) if (!line.diagnostics.includes(x.message)) line.diagnostics.push(x.message);
    }
  }
  return out;
}
