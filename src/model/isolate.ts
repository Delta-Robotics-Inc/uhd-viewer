/**
 * Isolating a legend entry (a signal type, a domain, a DRC state): the links
 * of that kind stay, with the interfaces and modules they touch; everything
 * else on the level fades. Pure functions of the level's view model, so the
 * result follows the model as it rebuilds and the drill level as it changes.
 */
import { classKey, type Classification } from "./classification";
import type { ViewLane, ViewLink, ViewModel, ViewNode } from "./types";

/** What stays at full strength while some legend entries are isolated. */
export interface Isolation {
  /** View link ids (`ViewLink.id`: each drawn line). */
  links: Set<string>;
  /** Node ids: the ends of those links, the nets of that kind, and the containers that hold either. */
  nodes: Set<string>;
  /** Ports as `node|port`: the ends of those links, and ports of that kind on a node that stays. */
  ports: Set<string>;
}

function laneKeys(lanes: ViewLane[] | undefined, mode: Classification, out: Set<string>) {
  for (const l of lanes ?? []) {
    out.add(classKey(l, mode));
    laneKeys(l.children, mode, out);
  }
}

/**
 * The legend entries a link belongs to: its own and, by signal type or
 * domain, those of what it carries (a cable with power and a UART is in both;
 * by DRC state a link has one state, its own).
 */
export function linkKeys(link: ViewLink, mode: Classification): Set<string> {
  const out = new Set([classKey(link, mode)]);
  if (mode === "drc") return out;
  laneKeys(link.lanes, mode, out);
  for (const c of link.conductors ?? []) out.add(classKey(c, mode));
  return out;
}

/** A net junction's own entry (what the net carries; its state is the worst of its lines). */
const netKey = (node: ViewNode, mode: Classification) => (node.net ? classKey({ domain: "electrical", protocol: node.net.signal, state: node.status }, mode) : undefined);

/** A port's entry: as its dot is coloured (the protocol and state of the link on it, else its own). */
function portKey(vm: ViewModel, node: ViewNode, port: ViewNode["ports"][number], mode: Classification): string {
  const on = vm.links.filter((l) => (l.source.node === node.id && l.source.port === port.id) || (l.target.node === node.id && l.target.port === port.id));
  const link = on.find((l) => !l.passThrough) ?? on[0];
  return classKey({ domain: port.domain, protocol: link?.protocol ?? port.protocol, state: link?.state }, mode);
}

/** Every legend entry the level has something of: its links (and what they carry) and its nets. */
export function presentKeys(vm: ViewModel, mode: Classification): Set<string> {
  const out = new Set<string>();
  for (const l of vm.links) for (const k of linkKeys(l, mode)) out.add(k);
  for (const n of vm.nodes) {
    const k = netKey(n, mode);
    if (k) out.add(k);
  }
  return out;
}

/** What stays when `keys` are isolated on the level; null when nothing is isolated. */
export function isolate(vm: ViewModel, mode: Classification, keys: ReadonlySet<string>): Isolation | null {
  if (!keys.size) return null;
  const has = (set: Iterable<string>) => {
    for (const k of set) if (keys.has(k)) return true;
    return false;
  };
  const links = new Set<string>();
  const nodes = new Set<string>();
  const ports = new Set<string>();
  for (const l of vm.links) {
    if (!has(linkKeys(l, mode))) continue;
    links.add(l.id);
    for (const end of [l.source, l.target]) {
      nodes.add(end.node);
      ports.add(`${end.node}|${end.port}`);
    }
  }
  const byId = new Map(vm.nodes.map((n) => [n.id, n]));
  // a ground return drawn as symbols ends on a net that has no junction on the level
  for (const id of [...nodes]) if (!byId.has(id)) nodes.delete(id);
  for (const n of vm.nodes) {
    const k = netKey(n, mode);
    if (k && keys.has(k)) nodes.add(n.id);
  }
  // a rail drawn as taps: the taps of a net that stays, and the net of a tap that stays
  for (const n of vm.nodes) if (n.tapOf && (nodes.has(n.tapOf) || nodes.has(n.id))) nodes.add(n.id).add(n.tapOf);
  // what holds something that stays, stays (a module expanded in place, a group)
  for (const id of [...nodes]) for (let p = byId.get(id)?.parent; p && !nodes.has(p); p = byId.get(p)?.parent) nodes.add(p);
  // on a node that stays, the ports of that kind stay too (an interface nothing is linked to yet)
  for (const id of nodes) {
    const n = byId.get(id);
    for (const p of n?.ports ?? []) if (keys.has(portKey(vm, n!, p, mode))) ports.add(`${id}|${p.id}`);
  }
  return { links, nodes, ports };
}

/**
 * A click on a legend entry: it becomes the one isolated; a click on the only
 * one isolated shows everything again. With `add` (a modifier key) it joins
 * or leaves the ones held.
 */
export function toggleIsolated(current: ReadonlySet<string>, key: string, add = false): Set<string> {
  if (add) {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  }
  return current.size === 1 && current.has(key) ? new Set() : new Set([key]);
}
