/**
 * A bundle that does not hold everything it names still draws.
 *
 * UHD's resolvers throw on a child whose definition is not in the bundle, and
 * on a link or an export that names an interface nobody has. A producer that
 * could not fetch some definitions (a library that was unreachable) writes
 * exactly such a bundle, and the viewer drew nothing at all for it.
 *
 * `tolerantSystem` gives the viewer a system the resolvers accept: a missing
 * definition is stood in for by a placeholder that has the interfaces its
 * parents' links and exports name, and a link or an export that still cannot
 * be resolved is left out. What was stood in for and what was left out is
 * returned, so the views can say so.
 */
import type { InterfaceDef, ModuleDef } from "@uhd/types/index.js";
import type { EndpointTarget } from "@uhd/types/module.js";
import { boundaryInterfaces, resolveEndpoint, type ModuleLookup } from "@uhd/system/index.js";
import { isNet } from "@uhd/protocols/net.js";

/** A definition the bundle names and does not hold. */
export interface MissingDefinition {
  /** The definition id the children name. */
  id: string;
  /** Where it is used: the parent definition and the child's id and label there. */
  usedBy: { parent: string; child: string; name?: string }[];
}

/** A link or an export left out because it could not be resolved. */
export interface LeftOut {
  kind: "link" | "export";
  /** The definition it was on. */
  on: string;
  id: string;
  /** The resolver's message. */
  why: string;
}

export interface TolerantSystem {
  root: ModuleDef;
  lookup: ModuleLookup;
  missing: MissingDefinition[];
  leftOut: LeftOut[];
}

const PLACEHOLDERS = new WeakSet<ModuleDef>();

/** Whether a definition is a placeholder for one the bundle does not hold. */
export function isPlaceholder(def: ModuleDef | undefined): boolean {
  return !!def && PLACEHOLDERS.has(def);
}

/** The interface ids one end of a link names on `child`'s boundary. */
function namedOn(end: EndpointTarget, child: string): string[] {
  if (!("child" in end) || end.child !== child) return [];
  if (!end.compose) return [end.interfaceId];
  // a composition's values are boundary interfaces, or paths below the child (which a placeholder cannot have)
  return Object.values(end.compose).filter((v) => !v.includes(":"));
}

export function tolerantSystem(root: ModuleDef, lookup: ModuleLookup): TolerantSystem {
  const missing = new Map<string, MissingDefinition>();
  const wanted = new Map<string, Map<string, InterfaceDef>>();

  // 1. what is missing, and the interfaces its parents name on it
  const seen = new Set<ModuleDef>();
  const walk = (def: ModuleDef) => {
    if (seen.has(def)) return;
    seen.add(def);
    for (const ref of def.children ?? []) {
      const child = lookup(ref.moduleDefId);
      if (child) {
        walk(child);
        continue;
      }
      const m = missing.get(ref.moduleDefId) ?? { id: ref.moduleDefId, usedBy: [] };
      m.usedBy.push({ parent: def.id, child: ref.id, ...(ref.name ? { name: ref.name } : {}) });
      missing.set(ref.moduleDefId, m);
      const ifaces = wanted.get(ref.moduleDefId) ?? new Map<string, InterfaceDef>();
      wanted.set(ref.moduleDefId, ifaces);
      const want = (id: string, like?: InterfaceDef) => {
        if (ifaces.has(id) && !like) return;
        // the other end's domain, so the line is drawn in its colour; no protocol is claimed
        ifaces.set(id, { id, name: id, domain: like?.domain ?? ifaces.get(id)?.domain ?? "electrical", exposed: true, protocols: [{ type: "custom", roles: [] }] });
      };
      for (const link of def.links ?? []) {
        for (const [end, other] of [[link.a, link.b], [link.b, link.a]] as const) {
          const ids = namedOn(end, ref.id);
          if (!ids.length) continue;
          let like: InterfaceDef | undefined;
          try {
            like = resolveEndpoint(def, other, lookup).iface;
          } catch {
            like = undefined;
          }
          for (const id of ids) want(id, "child" in end && end.compose ? undefined : like);
        }
      }
      for (const ex of def.exports ?? []) if ("child" in ex.from && ex.from.child === ref.id) want(ex.from.interfaceId);
      for (const u of ref.unconnected ?? []) want(u.interfaceId);
    }
  };
  walk(root);

  const placeholders = new Map<string, ModuleDef>();
  for (const [id, m] of missing) {
    const def: ModuleDef = {
      id,
      name: m.usedBy[0]?.name ?? id,
      description: `The definition "${id}" is not in this bundle. This is a placeholder with the interfaces its links name.`,
      interfaces: [...(wanted.get(id)?.values() ?? [])],
    };
    PLACEHOLDERS.add(def);
    placeholders.set(id, def);
  }
  const withPlaceholders: ModuleLookup = (id) => lookup(id) ?? placeholders.get(id);

  // 2. leave out what still cannot be resolved, children before their parents
  const leftOut: LeftOut[] = [];
  const cleaned = new Map<ModuleDef, ModuleDef>();
  const cleanLookup: ModuleLookup = (id) => {
    const d = withPlaceholders(id);
    return d && clean(d);
  };
  function clean(def: ModuleDef): ModuleDef {
    const done = cleaned.get(def);
    if (done) return done;
    cleaned.set(def, def); // a definition that holds itself is not followed twice
    for (const ref of def.children ?? []) cleanLookup(ref.moduleDefId);

    const why = (e: unknown) => (e instanceof Error ? e.message : String(e));
    const children = (def.children ?? []).filter((ref) => withPlaceholders(ref.moduleDefId));
    const exports = (def.exports ?? []).filter((ex) => {
      try {
        const from = ex.from;
        if (!("child" in from)) {
          // a net port (UHD 0.3.0): the module exports one of its own nets
          if (!def.interfaces.some((i) => i.id === from.interfaceId && isNet(i))) throw new Error(`"${from.interfaceId}" is not a net of "${def.id}"`);
          return true;
        }
        const ref = children.find((c) => c.id === from.child);
        const child = ref && cleanLookup(ref.moduleDefId);
        if (!child) throw new Error(`"${def.id}" has no child "${from.child}"`);
        if (!boundaryInterfaces(child, cleanLookup).some((i) => i.id === from.interfaceId)) throw new Error(`child "${from.child}" has no interface "${from.interfaceId}"`);
        return true;
      } catch (e) {
        leftOut.push({ kind: "export", on: def.id, id: ex.id, why: why(e) });
        return false;
      }
    });
    const base: ModuleDef = exports.length === (def.exports?.length ?? 0) ? def : { ...def, exports };
    const links = (def.links ?? []).filter((link) => {
      try {
        resolveEndpoint(base, link.a, cleanLookup);
        resolveEndpoint(base, link.b, cleanLookup);
        return true;
      } catch (e) {
        leftOut.push({ kind: "link", on: def.id, id: link.id, why: why(e) });
        return false;
      }
    });
    const out = links.length === (def.links?.length ?? 0) ? base : { ...base, links };
    if (PLACEHOLDERS.has(def) && out !== def) PLACEHOLDERS.add(out);
    cleaned.set(def, out);
    return out;
  }
  const cleanRoot = clean(root);
  return { root: cleanRoot, lookup: cleanLookup, missing: [...missing.values()], leftOut };
}
