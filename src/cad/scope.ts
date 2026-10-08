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
import type { Mat4 } from "@uhd/system/geometry.js";
import type { CadModel } from "./model";

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
  for (const c of shown.children ?? []) {
    const def = lookup(c.moduleDefId);
    if (!def || def.kind === "harness") continue;
    const entry = { id: c.id, name: c.name ?? def.name ?? c.id };
    const drawn = ownBody || model.bodies.some((b) => b.path[0] === c.id) || [...model.within.keys()].some((k) => k === c.id || k.startsWith(`${c.id}/`));
    (drawn ? placed : unplaced).push(entry);
  }
  const parts = placed.length + unplaced.length;
  return { ownBody, parts, placed, unplaced, loose: !ownBody && parts > 1 && placed.length <= 1 };
}
