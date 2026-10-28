/**
 * Host messages against the model: what a focus or a select names on which
 * drill level, and the viewer's selection as the host sees it (canonical
 * paths from the root). Pure functions, so they test without a page.
 */
import type { ChildModuleRef, ModuleDef } from "@uhd/types/index.js";
import type { ModuleLookup } from "@uhd/system/index.js";
import type { ViewerSelection } from "../api";
import type { ViewModel } from "../model/types";

/** A selection on the level being viewed (ids relative to it), as the canvas and inspector hold it. */
export type LevelSelection = { kind: "node" | "link"; id: string } | null;

/** The longest prefix of `path` that names instances, child by child, from `root`. */
export function instancePrefix(root: ModuleDef, lookup: ModuleLookup, path: string[]): string[] {
  const out: string[] = [];
  let def: ModuleDef | undefined = root;
  for (const id of path) {
    const ref: ChildModuleRef | undefined = def?.children?.find((c) => c.id === id);
    if (!ref) break;
    out.push(id);
    def = lookup(ref.moduleDefId);
    if (!def) break;
  }
  return out;
}

/**
 * Where to show a focused module: the current level when it is drawn there
 * (a child, or a child of a module expanded in place), else the level of its
 * parent. A path that stops naming instances is followed as far as it does;
 * the root (or nothing valid) shows the top level with nothing selected.
 */
export function focusTarget(
  root: ModuleDef,
  lookup: ModuleLookup,
  path: string,
  current: { drill: string[]; expanded: ReadonlySet<string> },
): { drill: string[]; selection: LevelSelection } {
  const valid = instancePrefix(root, lookup, path.split("/").filter(Boolean));
  if (!valid.length) return { drill: [], selection: null };
  const { drill } = current;
  if (drill.every((d, i) => valid[i] === d)) {
    const rel = valid.slice(drill.length);
    if (rel.length === 1 || (rel.length === 2 && current.expanded.has(rel[0]))) return { drill, selection: { kind: "node", id: rel.join("/") } };
  }
  return { drill: valid.slice(0, -1), selection: { kind: "node", id: valid[valid.length - 1] } };
}

/**
 * The drill path for `path`: as far as it names instances, and only through
 * modules with children of their own (a level shows a module's children).
 */
export function drillTarget(root: ModuleDef, lookup: ModuleLookup, path: string): string[] {
  const out: string[] = [];
  let def: ModuleDef | undefined = root;
  for (const id of path.split("/").filter(Boolean)) {
    const ref: ChildModuleRef | undefined = def?.children?.find((c) => c.id === id);
    const next: ModuleDef | undefined = ref ? lookup(ref.moduleDefId) : undefined;
    if (!next?.children?.length || next.kind === "harness") break;
    out.push(id);
    def = next;
  }
  return out;
}

/** A selection in the 3D view (by instance path), as the host sees it. */
export function cadHostSelection(
  sel: { body?: string; component?: string; harness?: string; mate?: string },
  defAt: (path: string[]) => ModuleDef | undefined,
): ViewerSelection | null {
  // a mate is named `owner/link`: its definition is the owner's, as for a link in the diagram
  if (sel.mate) return { kind: "link", id: sel.mate, ...withDef(defAt(sel.mate.split("/").slice(0, -1))?.id) };
  const path = sel.component ?? sel.harness ?? sel.body?.split("#")[0];
  if (path === undefined) return null;
  const def = defAt(path ? path.split("/") : []);
  return { kind: "node", id: path, ...withDef(def?.id) };
}

/**
 * What a host's select picks in the 3D view, by path from the root: the
 * selection it made on the diagram's level (a module or a link; nets are not
 * drawn in 3D), else the first id naming a module instance in full. `none`
 * for no ids; undefined when nothing applies.
 */
export function cadSelectTarget(
  root: ModuleDef,
  lookup: ModuleLookup,
  drill: string[],
  onLevel: LevelSelection | undefined,
  ids: string[],
): { kind: "node" | "link" | "none"; path: string } | undefined {
  if (onLevel === null) return { kind: "none", path: "" };
  if (onLevel) {
    const path = fullId(drill, onLevel.id);
    return onLevel.kind === "node" && path.includes(":") ? undefined : { kind: onLevel.kind, path };
  }
  for (const raw of ids) {
    if (raw.startsWith("link:")) continue;
    const parts = (raw.startsWith("node:") ? raw.slice(5) : raw).split("/").filter(Boolean);
    if (parts.length && instancePrefix(root, lookup, parts).length === parts.length) return { kind: "node", path: parts.join("/") };
  }
  return undefined;
}

/** A stored or derived link id as the view selects it: the line that draws it, or the derived link itself. */
export function selectableLink(vm: ViewModel, id: string): LevelSelection {
  if (vm.derived.some((d) => d.id === id)) return { kind: "link", id };
  const line = vm.links.find((l) => l.linkId === id || l.alsoIds?.includes(id));
  return line ? { kind: "link", id: line.linkId } : null;
}

/**
 * The lines a harness is drawn along on this level, when it has no card of
 * its own: a cable between two parts is one line with the harness as a region
 * along it, and the links that name a harness carry its region too. Empty for
 * a harness drawn as a card (and for anything else).
 */
export function harnessLines(vm: ViewModel, id: string): ViewModel["links"] {
  if (vm.nodes.some((n) => n.id === id)) return [];
  return vm.links.filter((l) => l.run?.id === id);
}

/**
 * A module selection as the diagram can show it: a harness drawn along its
 * lines (no card of its own) is selected as the line that carries its name
 * tab, so a row of the hierarchy or a host's focus on it selects and frames
 * something drawn. Anything else as it is.
 */
export function drawnSelection(vm: ViewModel, selection: LevelSelection): LevelSelection {
  if (selection?.kind !== "node") return selection;
  const lines = harnessLines(vm, selection.id);
  const line = lines.find((l) => l.run?.tab) ?? lines[0];
  return line ? { kind: "link", id: line.linkId } : selection;
}

/** The harness a selected line runs through (its path on the level), if any: its row in the hierarchy. */
export function selectedHarness(vm: ViewModel, selection: LevelSelection): string | undefined {
  if (selection?.kind !== "link") return undefined;
  return vm.links.find((l) => (l.linkId === selection.id || l.id === selection.id) && l.run)?.run?.id;
}

/** `id` relative to the level at `drill`: itself, and without the level's path when it starts with it. */
function relative(id: string, drill: string[]): string[] {
  const at = drill.join("/");
  if (!at) return [id];
  if (id.startsWith(`${at}/`)) return [id.slice(at.length + 1), id];
  // a net or boundary interface of the level: "board:v3v3" is ":v3v3" on the board's level
  if (id.startsWith(`${at}:`)) return [id.slice(at.length), id];
  return [id];
}

/**
 * The first of `ids` drawn on this level: a node (module instance path, net,
 * boundary port) or a link. `node:` and `link:` prefixes pick the kind. Ids
 * are canonical paths from the root (as `selectionChanged` reports them) or
 * relative to the level. Undefined when none is there; null for no ids.
 */
export function selectTarget(vm: ViewModel, drill: string[], ids: string[]): LevelSelection | undefined {
  if (!ids.length) return null;
  for (const raw of ids) {
    const kind = raw.startsWith("node:") ? "node" : raw.startsWith("link:") ? "link" : undefined;
    const id = kind ? raw.slice(5) : raw;
    for (const c of relative(id, drill)) {
      if (kind !== "link" && vm.nodes.some((n) => n.id === c)) return { kind: "node", id: c };
      // a harness drawn along its lines: the line with its name tab
      if (kind !== "link" && harnessLines(vm, c).length) return drawnSelection(vm, { kind: "node", id: c });
      if (kind !== "node") {
        const link = selectableLink(vm, c);
        if (link) return link;
      }
    }
  }
  return undefined;
}

/** A level id as a canonical path from the root. */
export function fullId(drill: string[], id: string): string {
  const at = drill.join("/");
  if (!at) return id;
  return id.startsWith(":") ? `${at}${id}` : `${at}/${id}`;
}

/**
 * The selection as the host sees it: canonical ids, and the definition of
 * the module selected (for a link, the module that declares it).
 */
export function hostSelection(vm: ViewModel, drill: string[], selection: LevelSelection, levelDefId?: string): ViewerSelection | null {
  if (!selection) return null;
  if (selection.kind === "node") {
    const node = vm.nodes.find((n) => n.id === selection.id);
    return { kind: "node", id: fullId(drill, selection.id), ...(node?.defId ? { defId: node.defId } : {}) };
  }
  return { kind: "link", id: fullId(drill, selection.id), ...withDef(linkOwner(vm, selection.id, levelDefId)) };
}

/** The definition that declares a level link: the module expanded in place that holds it, or the level's. */
export function linkOwner(vm: ViewModel, linkId: string, levelDefId?: string): string | undefined {
  const slash = linkId.lastIndexOf("/");
  if (slash < 0) return levelDefId;
  return vm.nodes.find((n) => n.id === linkId.slice(0, slash))?.defId ?? levelDefId;
}

const withDef = (defId?: string) => (defId ? { defId } : {});

/** Selections compare by content (the host hears each change once). */
export const selectionKey = (s: ViewerSelection | null) => (s ? `${s.kind}|${s.id}|${s.defId ?? ""}|${s.ids?.join(",") ?? ""}` : "");

/**
 * Whether the host hears the selection now: when it changed, and when a module or link was picked again while it
 * was selected (a click on it, a row of the hierarchy, a host's focus). A pick is a new `pick` (the controller's
 * state object, made anew by each pick, kept when nothing was picked); a rebuild or a view change makes none.
 * The host then knows the user chose it (D6: the Inspector comes back every time, also for the module already
 * selected), and two picks that arrive together (nothing, then the same module again) are still said.
 */
export function saySelection(sent: { key: string; pick: unknown }, now: { selection: ViewerSelection | null; pick: unknown }): boolean {
  if (selectionKey(now.selection) !== sent.key) return true;
  return now.selection !== null && now.pick !== sent.pick;
}
