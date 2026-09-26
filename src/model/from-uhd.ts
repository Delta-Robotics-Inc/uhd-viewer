/**
 * Adapter: UHD system ModuleDef → neutral view model.
 *
 * A level shows the children of one module. Children that have children of
 * their own are drawn expanded in place when listed in `expanded` (their
 * boundary ports are exports, joined to the inner ports by pass-through
 * lines); otherwise they are drawn as a single card with boundary ports.
 */
import type { InterfaceDef, ModuleDef } from "@uhd/types/index.js";
import {
  boundaryInterfaces,
  resolveExports,
  validateLinks,
  type LinkResult,
  type ModuleLookup,
} from "@uhd/system/index.js";
import type {
  LinkState,
  ViewChildPort,
  ViewLink,
  ViewModel,
  ViewNode,
  ViewPort,
} from "./types";

const CATEGORY_ICONS: Record<string, string> = {
  "flight-controller": "cpu",
  esc: "zap",
  motor: "rotate-cw",
  propeller: "fan",
  battery: "battery-full",
  receiver: "radio",
  video: "video",
  gnss: "satellite",
  structure: "hexagon",
};

function iconFor(def: ModuleDef): string {
  if (def.display?.icon) return def.display.icon;
  const words = [...(def.categories ?? []), ...(def.tags ?? [])].map((w) => w.toLowerCase());
  for (const word of words) {
    for (const [key, icon] of Object.entries(CATEGORY_ICONS)) {
      if (word.includes(key)) return icon;
    }
  }
  if (/esc/i.test(def.name)) return "zap";
  if (/battery|lipo/i.test(def.name)) return "battery-full";
  if (/receiver|elrs/i.test(def.name)) return "radio";
  if (/gnss|gps/i.test(def.name)) return "satellite";
  if (/motor/i.test(def.name)) return "rotate-cw";
  if (/prop/i.test(def.name)) return "fan";
  if (/air unit|camera|video/i.test(def.name)) return "video";
  if (/flight controller/i.test(def.name)) return "cpu";
  return "box";
}

function shapeFor(def: ModuleDef): "rect" | "circle" {
  if (def.display?.shape === "circle") return "circle";
  return /motor|propeller|\bprop\b/i.test(`${def.name} ${(def.categories ?? []).join(" ")} ${(def.tags ?? []).join(" ")}`) &&
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
    return ex
      ? toPort(iface, ex.childDef, { child: ex.from.child, interfaceId: ex.from.interfaceId })
      : toPort(iface, def);
  });
}

const isGround = (r: LinkResult) =>
  [r.a.iface, r.b.iface].every((i) => i.protocols.some((p) => p.type === "power" && p.roles.includes("ground")));

function toLink(r: LinkResult, prefix: string): ViewLink {
  const endpoint = (end: typeof r.link.a) =>
    "child" in end
      ? { node: prefix + end.child, port: end.interfaceId }
      : { node: prefix.replace(/\/$/, ""), port: end.interfaceId };
  return {
    id: prefix + r.link.id,
    source: endpoint(r.link.a),
    target: endpoint(r.link.b),
    name: r.link.name ?? r.link.id,
    domain: r.a.iface.domain,
    protocol: r.protocol,
    state: r.state,
    children: r.children.map((c, i) => ({
      id: `${prefix}${r.link.id}#${i}`,
      label: (c.a.slotId ?? c.a.leafId).toUpperCase(),
      a: c.a.slotId ?? c.a.leafId,
      b: c.b.slotId ?? c.b.leafId,
      aPin: c.a.pin,
      bPin: c.b.pin,
      state: r.state,
    })),
    ...(isGround(r) ? { ground: true } : {}),
    diagnostics: [...r.diagnostics.map((d) => d.message), ...r.unresolvedSlots.map((s) => `unresolved slot ${s}`)],
  };
}

const RANK: Record<LinkState, number> = { incompatible: 3, partial: 2, unconfigured: 1, configured: 0 };

function worst(states: LinkState[]): LinkState {
  return states.reduce<LinkState>((w, s) => (RANK[s] > RANK[w] ? s : w), "configured");
}

export interface BuildOptions {
  /** Child ids (at this level) drawn expanded in place. */
  expanded: Set<string>;
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
  const { def: level, path } = levelModule(root, drill, lookup);
  const nodes: ViewNode[] = [];
  const links: ViewLink[] = [];

  const nodeFor = (id: string, name: string | undefined, def: ModuleDef, parent?: string, expanded = false): ViewNode => ({
    id,
    label: (name ?? def.name).toUpperCase(),
    icon: iconFor(def),
    kind: def.kind ?? "module",
    ...(parent ? { parent } : {}),
    ...(expanded ? { expanded } : {}),
    ports: portsOf(def, lookup),
    shape: expanded ? "rect" : shapeFor(def),
    status: "configured",
    defId: def.id,
    manufacturer: def.manufacturer,
    partNumber: def.part_number,
    description: def.description,
    category: def.categories?.[0],
    childCount: def.children?.length ?? 0,
  });

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

  for (const ref of level.children ?? []) {
    const def = lookup(ref.moduleDefId);
    if (!def) continue;
    const expanded = opts.expanded.has(ref.id) && (def.children?.length ?? 0) > 0;
    nodes.push(nodeFor(ref.id, ref.name, def, undefined, expanded));
    if (!expanded) continue;

    for (const inner of def.children ?? []) {
      const innerDef = lookup(inner.moduleDefId);
      if (innerDef) nodes.push(nodeFor(`${ref.id}/${inner.id}`, inner.name, innerDef, ref.id));
    }
    links.push(...validateLinks(def, lookup).map((r) => toLink(r, `${ref.id}/`)));

    // pass-through lines from each boundary export to the child port it exposes
    const exports = def.exports?.length || def.kind === "group" ? resolveExports(def, lookup) : [];
    for (const ex of exports) {
      links.push({
        id: `${ref.id}:${ex.id}`,
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

  links.push(...validateLinks(level, lookup).map((r) => toLink(r, "")));

  // node status = worst state of the links touching it
  for (const node of nodes) {
    const touching = links.filter(
      (l) => !l.passThrough && (l.source.node === node.id || l.target.node === node.id || l.source.node.startsWith(`${node.id}/`) || l.target.node.startsWith(`${node.id}/`)),
    );
    node.status = touching.length ? worst(touching.map((l) => l.state)) : "unconfigured";
  }

  return { path, nodes, links };
}
