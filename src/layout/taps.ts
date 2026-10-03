/**
 * Rail taps (PB-873): a supply rail drawn the way a schematic draws it.
 *
 * A rail joins most of a board (a 3V3 rail reaches 15–20 parts). Drawn as one
 * junction it pulls a line from every corner of the sheet. Drawn as a net
 * label at each place it is used, it reads at a glance: here the rail is
 * split into taps, one per cluster of parts (a part and the passives that
 * serve it, board-layout.ts), each joined only to the members of its cluster.
 * The taps carry the net's name and colour; the one with the most members
 * keeps the net's id, the others are `<net>~<cluster>` with `tapOf` set.
 *
 * Only the drawing changes: the inspector, the hierarchy and the findings
 * read the level's view model, where the net is one node.
 */
import type { ViewLink, ViewModel, ViewNode } from "../model/types";
import { boardClusters, functionGroup, type BoardNode } from "./board-layout";

/** A power net with at least this many members is drawn as taps. */
export const RAIL_TAP_MIN = 5;

const GROUP_RANK = ["power", "io", "mcu", "sensor", "output", "other"];
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

export function tapRails(vm: ViewModel): ViewModel {
  const top = vm.nodes.filter((n) => !n.parent && !n.sheetPort);
  const rails = top.filter((n) => n.kind === "net" && n.net && !n.net.ground && n.net.signal === "power");
  if (!rails.length) return vm;
  const ids = new Set(top.map((n) => n.id));
  const lines = vm.links.filter((l) => !l.passThrough && !l.ground && ids.has(l.source.node) && ids.has(l.target.node));
  const nodes: BoardNode[] = top.map((n) => ({ id: n.id, w: 0, h: 0, net: n.kind === "net", category: n.category, label: n.label }));
  const { clusterOf } = boardClusters(
    nodes,
    lines.map((l) => [l.source.node, l.target.node]),
  );
  const byId = new Map(top.map((n) => [n.id, n]));

  const retarget = new Map<string, string>();
  const replaced = new Map<string, ViewNode[]>();
  for (const rail of rails) {
    const own = lines.filter((l) => l.target.node === rail.id && clusterOf.has(l.source.node));
    if (own.length < RAIL_TAP_MIN) continue;
    const groups = new Map<string, ViewLink[]>();
    for (const l of own) {
      const c = clusterOf.get(l.source.node)!;
      groups.set(c, [...(groups.get(c) ?? []), l]);
    }
    if (groups.size < 2) continue;
    const rank = (c: string) => GROUP_RANK.indexOf(functionGroup(byId.get(c)?.category));
    const order = [...groups.keys()].sort((a, b) => groups.get(b)!.length - groups.get(a)!.length || rank(a) - rank(b) || natural(a, b));
    const taps: ViewNode[] = order.map((c, i) => {
      const ports = new Set(groups.get(c)!.map((l) => l.target.port));
      const id = i === 0 ? rail.id : `${rail.id}~${c}`;
      for (const l of groups.get(c)!) retarget.set(l.id, id);
      return { ...rail, id, ports: rail.ports.filter((p) => ports.has(p.id)), ...(i === 0 ? {} : { tapOf: rail.id }) };
    });
    // the net's own ports with no line here (a member drawn elsewhere) stay on the main junction
    const kept = new Set(taps.flatMap((t) => t.ports.map((p) => p.id)));
    taps[0] = { ...taps[0], ports: [...taps[0].ports, ...rail.ports.filter((p) => !kept.has(p.id))] };
    replaced.set(rail.id, taps);
  }
  if (!replaced.size) return vm;
  return {
    ...vm,
    nodes: vm.nodes.flatMap((n) => replaced.get(n.id) ?? [n]),
    links: vm.links.map((l) => (retarget.has(l.id) ? { ...l, target: { ...l.target, node: retarget.get(l.id)! } } : l)),
  };
}

/** The node a selection names for a drawn node: a tap's net. */
export const selectionId = (node: ViewNode | undefined, id: string) => node?.tapOf ?? id;
