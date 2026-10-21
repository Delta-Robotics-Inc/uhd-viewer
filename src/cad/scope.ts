/**
 * The 3D view of one module (PB-897): a system's view shows the whole
 * assembly, a module's shows that module alone, in its own coordinates. The
 * model is then built from the module's definition, so every path in it is
 * relative to the module; a host's paths, the display hints and the findings
 * are all written from the root. These functions translate between the two,
 * and say what a view shows and what it leaves out.
 */
import type { ModuleDef } from "@uhd/types/index.js";
import type { ModuleLookup } from "@uhd/system/index.js";
import type { Assembly, GeometryManifest, Mat4 } from "@uhd/system/geometry.js";
import { buildCadModel, defAt, withUnplacedInRow, type CadModel } from "./model";

/** A path from the root as a path inside `scope` ("" is the scope's own module); undefined when it is outside. */
export function intoScope(path: string, scope: string): string | undefined {
  if (!scope) return path;
  if (path === scope) return "";
  return path.startsWith(`${scope}/`) ? path.slice(scope.length + 1) : undefined;
}

/** A path inside `scope` as a path from the root. */
export function outOfScope(path: string, scope: string): string {
  if (!scope) return path;
  return path ? `${scope}/${path}` : scope;
}

/**
 * A finding's reference from the root (`board/u2:pin_14`, `board:sda`,
 * `link:board/<id>`) as one inside `scope`; undefined when it names
 * something outside.
 */
export function scopeRef(ref: string, scope: string): string | undefined {
  if (!scope) return ref;
  if (ref.startsWith("link:")) {
    const id = ref.slice(5);
    return id.startsWith(`${scope}/`) ? `link:${id.slice(scope.length + 1)}` : undefined;
  }
  const colon = ref.indexOf(":");
  const modules = colon < 0 ? ref : ref.slice(0, colon);
  const rest = colon < 0 ? "" : ref.slice(colon);
  const inside = intoScope(modules, scope);
  return inside === undefined ? undefined : `${inside}${rest}`;
}

/** The display hints' placements (keyed by path from the root, `#body` kept) that lie inside `scope`, re-keyed to it. */
export function scopedPlacements<T extends { matrix: Mat4; note?: string }>(placements: Record<string, T> | undefined, scope: string): { path: string[]; matrix: Mat4; note: string }[] {
  const out: { path: string[]; matrix: Mat4; note: string }[] = [];
  for (const [key, h] of Object.entries(placements ?? {})) {
    // a hint that places the scope's own module says where it sits in its parent: not needed to show it alone
    const inside = scope ? (key.startsWith(`${scope}/`) ? key.slice(scope.length + 1) : undefined) : key;
    if (inside === undefined) continue;
    out.push({ path: inside.split("/"), matrix: h.matrix, note: h.note ?? "placed by a display hint" });
  }
  return out;
}

/** The display hints' assembly root (a path from the root) inside `scope`; undefined when it is not, or none is given. */
export function scopedRoot(root: string | undefined, scope: string): string[] | undefined {
  if (!root) return undefined;
  const inside = intoScope(root, scope);
  return inside ? inside.split("/") : undefined;
}

/** The modules above `scope`, nearest first, as paths from the root (`""` is the root). */
export function ancestorsOf(scope: string): string[] {
  if (!scope) return [];
  const parts = scope.split("/");
  const out: string[] = [];
  for (let n = parts.length - 1; n >= 0; n--) out.push(parts.slice(0, n).join("/"));
  return out;
}

/** A path inside the module at `rel` (a path in the model), or undefined when it lies outside it. */
function strip(path: string[], rel: string[]): string[] | undefined {
  if (path.length < rel.length) return undefined;
  for (let i = 0; i < rel.length; i++) if (path[i] !== rel[i]) return undefined;
  return path.slice(rel.length);
}

/** A body key (`a/b#artifact`) inside the module at `rel`, re-keyed to it; undefined when outside. */
function stripKey(key: string, rel: string[]): string | undefined {
  const hash = key.indexOf("#");
  const path = hash < 0 ? key : key.slice(0, hash);
  const inside = strip(path ? path.split("/") : [], rel);
  return inside === undefined ? undefined : inside.join("/") + (hash < 0 ? "" : key.slice(hash));
}

/** A link id (prefixed with the path of the module that declares it) inside the module at `rel`; undefined when declared outside. */
function stripLink(linkId: string, rel: string[]): string | undefined {
  const prefix = `${rel.join("/")}/`;
  return linkId.startsWith(prefix) ? linkId.slice(prefix.length) : undefined;
}

/**
 * A model of an ancestor cut down to the module at `rel` (its path inside
 * the ancestor) and re-keyed to it (PB-1040): what a module with no assembly
 * of its own shows, its parts where the ancestor's assembly puts them. The
 * matrices stay in the ancestor's coordinates (the view fits what is drawn);
 * mates, routes and hardware are kept only when both of their ends lie in
 * the module, and harnesses when they are in it.
 */
export function borrowModel(model: CadModel, rel: string[], from: string): CadModel {
  const bodies = model.bodies.flatMap((b) => {
    const path = strip(b.path, rel);
    const key = stripKey(b.key, rel);
    return path === undefined || key === undefined ? [] : [{ ...b, path, key }];
  });
  const defs = new Map<string, ModuleDef>();
  for (const [k, d] of model.defs) {
    const key = stripKey(k, rel);
    if (key !== undefined) defs.set(key, d);
  }
  const within = new Map<string, string>();
  for (const [k, v] of model.within) {
    const key = stripKey(k, rel);
    const holder = stripKey(v, rel);
    if (key !== undefined && holder !== undefined) within.set(key, holder);
  }
  const a = model.assembly;
  const ends = <E extends { path: string[] }>(e: E): E | undefined => {
    const path = strip(e.path, rel);
    return path === undefined ? undefined : { ...e, path };
  };
  const assembly: Assembly = {
    instances: a.instances.flatMap((i) => {
      const path = strip(i.path, rel);
      return path === undefined ? [] : [{ ...i, path }];
    }),
    placements: a.placements.flatMap((p) => {
      const path = strip(p.path, rel);
      const key = stripKey(p.key, rel);
      return path === undefined || key === undefined ? [] : [{ ...p, path, key, ...(p.via !== undefined ? { via: stripLink(p.via, rel) ?? p.via } : {}) }];
    }),
    mates: a.mates.flatMap((m) => {
      const ea = ends(m.a);
      const eb = ends(m.b);
      const linkId = stripLink(m.linkId, rel);
      return ea && eb && linkId !== undefined ? [{ ...m, linkId, a: ea, b: eb, ...(m.harnessPath ? { harnessPath: strip(m.harnessPath, rel) ?? m.harnessPath } : {}) }] : [];
    }),
    routes: a.routes.flatMap((r) => {
      const ea = ends(r.a);
      const eb = ends(r.b);
      const linkId = stripLink(r.linkId, rel);
      return ea && eb && linkId !== undefined ? [{ ...r, linkId, a: ea, b: eb }] : [];
    }),
    hardware: a.hardware.flatMap((h) => {
      const structure = stripKey(h.structure, rel);
      const mounted = stripKey(h.mounted, rel);
      const harness = strip(h.harness.split("/"), rel);
      return structure !== undefined && mounted !== undefined && harness !== undefined ? [{ ...h, structure, mounted, harness: harness.join("/") }] : [];
    }),
    harnesses: a.harnesses.flatMap((h) => {
      const path = strip(h.path, rel);
      const key = stripKey(h.key, rel);
      return path === undefined || key === undefined ? [] : [{ ...h, path, key, via: stripLink(h.via, rel) ?? h.via, ends: h.ends.map((e) => ({ ...e, linkId: stripLink(e.linkId, rel) ?? e.linkId })) }];
    }),
    unrouted: a.unrouted.flatMap((u) => {
      const linkId = stripLink(u.linkId, rel);
      return linkId === undefined ? [] : [{ ...u, linkId }];
    }),
    issues: [],
  };
  return { assembly, bodies, defs, manifests: model.manifests, within, placedBy: { kind: "ancestor", from } };
}

export interface Unplaced {
  /** Child id in the shown module. */
  id: string;
  name: string;
}

/** What a 3D view shows of a module, and what it does not. */
export interface ShownSummary {
  /** The module has a body of its own (a board's `board.glb`): it is drawn as that body, its children in it. */
  ownBody: boolean;
  /** The module's direct children that are parts (harnesses are drawn as cables and hardware, not counted). */
  parts: number;
  /** Those of them that are drawn: placed, or inside the module's own body. */
  placed: Unplaced[];
  /** Those that are not: nothing says where they sit. */
  unplaced: Unplaced[];
  /** Those of `placed` that nothing places either, drawn beside the others (PB-1040). */
  inRow: Unplaced[];
  /**
   * Nothing joins the module's parts: it has no body of its own, more than
   * one part, and no mate or hint places a second one. What would be drawn
   * is one part on its own, which is not a picture of the module.
   */
  loose: boolean;
}

export function shownSummary(model: CadModel, shown: ModuleDef, lookup: ModuleLookup): ShownSummary {
  const ownBody = model.bodies.some((b) => b.path.length === 0 && !!b.glb);
  const placed: Unplaced[] = [];
  const unplaced: Unplaced[] = [];
  const inRow: Unplaced[] = [];
  for (const c of shown.children ?? []) {
    const def = lookup(c.moduleDefId);
    if (!def || def.kind === "harness") continue;
    const entry = { id: c.id, name: c.name ?? def.name ?? c.id };
    const mine = model.bodies.filter((b) => b.path[0] === c.id);
    const drawn = ownBody || mine.length > 0 || [...model.within.keys()].some((k) => k === c.id || k.startsWith(`${c.id}/`));
    (drawn ? placed : unplaced).push(entry);
    if (!ownBody && mine.length && mine.every((b) => b.row)) inRow.push(entry);
  }
  const parts = placed.length + unplaced.length;
  const reallyPlaced = placed.length - inRow.length;
  return { ownBody, parts, placed, unplaced, inRow, loose: !ownBody && parts > 1 && reallyPlaced <= 1 && !inRow.length };
}

/**
 * The model a 3D view draws of the module at `at` (a path from the root;
 * `""` is the root), PB-897 and PB-1040:
 *
 * 1. the module's own assembly: its mates and the display hints inside it;
 * 2. when that leaves parts unplaced and the module has no body of its own,
 *    the nearest ancestor whose assembly places more of them: its assembly,
 *    cut down to the module (`borrowModel`);
 * 3. what nothing places but has a model is drawn beside the rest, in a row
 *    (`withUnplacedInRow`), and the view says so.
 *
 * The root's view is its own assembly, as before.
 */
export function scopedModel(
  system: ModuleDef,
  lookup: ModuleLookup,
  manifests: Map<string, GeometryManifest>,
  display: { placements?: Record<string, { matrix: Mat4; note?: string }>; root?: string },
  at: string,
): CadModel {
  const shown = (at ? defAt(system, lookup, at.split("/")) : undefined) ?? system;
  const scope = shown === system ? "" : at;
  const build = (def: ModuleDef, where: string) => buildCadModel(def, lookup, manifests, scopedPlacements(display.placements, where), scopedRoot(display.root, where));
  const own = build(shown, scope);
  if (!scope) return own;
  const first = shownSummary(own, shown, lookup);
  let best = own;
  if (!first.ownBody && first.unplaced.length) {
    for (const from of ancestorsOf(scope)) {
      const def = from ? defAt(system, lookup, from.split("/")) : system;
      if (!def) continue;
      const borrowed = borrowModel(build(def, from), intoScope(scope, from)!.split("/"), from);
      if (shownSummary(borrowed, shown, lookup).placed.length > first.placed.length) {
        best = borrowed;
        break;
      }
    }
  }
  return withUnplacedInRow(best, shown, lookup) ?? best;
}
