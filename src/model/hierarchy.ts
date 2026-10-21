/**
 * The hierarchy panel's model (PB-1042): the whole module tree of a system,
 * every level at once (the root, its sub-modules, their parts and harnesses),
 * with what each row shows (an icon by kind, the host's part mark, the worst
 * finding here or below), the filter, the rows on screen, the keyboard, and
 * how a row maps to the diagram's level and selection. Pure functions, so they
 * test without a page; viewer/hierarchy.tsx draws them.
 */
import type { ModuleDef } from "@uhd/types/index.js";
import type { ModuleLookup } from "@uhd/system/index.js";
import type { UhdBundleDiagnostic } from "@uhd/types/bundle.js";
import { isNet } from "@uhd/protocols/net.js";
import type { NodeMark } from "../api";
import type { ScopedDiagnostic } from "./diagnostics";
import { focusTarget, fullId, type LevelSelection } from "../host/targets";

/** What a row is: the same kinds as a host's own module tree. */
export type HierarchyKind = "system" | "assembly" | "group" | "part" | "board" | "enclosure" | "structure" | "harness" | "fasteners";

export type Severity = "error" | "warning" | "info";

export interface Findings {
  error: number;
  warning: number;
  info: number;
}

export interface HierarchyNode {
  /** Instance path from the root ("" is the root). */
  path: string;
  /** The parent's path; undefined for the root. */
  parent?: string;
  label: string;
  defId: string;
  /** The definition's own name, when the instance is named otherwise ("FB upper" is a "Resistor 1 MΩ"). */
  defName?: string;
  kind: HierarchyKind;
  /** A Lucide icon name for the kind. */
  icon: string;
  depth: number;
  quantity?: number;
  /** The host's mark for the definition (a part's status), as the diagram's dot shows it. */
  mark?: NodeMark;
  /** The bundle names the definition and does not hold it: drawn as a placeholder. */
  missing?: boolean;
  /** Findings on this module itself. */
  findings: Findings;
  /** The worst finding here or below. */
  worst?: Severity;
  /** The module has a level of its own (a module with children; not a harness). */
  drillable: boolean;
  /** A row of the panel's own that only holds others (`WIRING_PATH`): no module, nothing to select. */
  group?: boolean;
  /** In the wiring group: the module it belongs to ("Front-right arm"), since four "Prop nut" rows read alike. */
  where?: string;
  children: HierarchyNode[];
}

/** Icons by kind (Lucide names), matching a host tree's: a board, a package, a chip, a plug. */
export const KIND_ICON: Record<HierarchyKind, string> = {
  system: "circuit-board",
  assembly: "package",
  group: "folders",
  part: "microchip",
  board: "circuit-board",
  enclosure: "archive",
  structure: "layers",
  harness: "plug",
  fasteners: "wrench",
};

/** What a kind is called (tooltips, the accessible description). */
export const KIND_LABEL: Record<HierarchyKind, string> = {
  system: "System",
  assembly: "Assembly",
  group: "Group",
  part: "Part",
  board: "Board",
  enclosure: "Enclosure",
  structure: "Structure",
  harness: "Harness",
  fasteners: "Fastener stack",
};

/** A module that stands for a part nobody has chosen yet (the host marks it with a ring). */
export const BLANK_ICON = "circle-dashed";

const RANK: Record<Severity, number> = { info: 1, warning: 2, error: 3 };
const worse = (a: Severity | undefined, b: Severity | undefined): Severity | undefined => (!a ? b : !b ? a : RANK[b] > RANK[a] ? b : a);
const words = (def: ModuleDef) => [...(def.categories ?? []), ...(def.tags ?? [])].map((w) => w.toLowerCase());

/** What kind of module a definition is, from what the bundle says (its UHD kind, nets, children, categories). */
export function kindOf(def: ModuleDef | undefined, isRoot: boolean): HierarchyKind {
  if (isRoot) return "system";
  if (!def) return "part";
  if (def.kind === "harness") return def.fastenerStack?.length ? "fasteners" : "harness";
  if (def.kind === "group") return "group";
  if (def.interfaces?.some(isNet)) return "board";
  const w = words(def);
  if (w.some((x) => x.includes("enclosure"))) return "enclosure";
  if (w.some((x) => x === "mechanical.structure" || x.startsWith("mechanical.structure.") || x === "frame" || x === "structure")) return "structure";
  return def.children?.length ? "assembly" : "part";
}

export interface HierarchyOptions {
  /** The host's marks by definition id (`ViewerOptions.nodeMarks`). */
  marks?: Record<string, NodeMark>;
  /** The viewer's own checks (systemDiagnostics). */
  diagnostics?: readonly ScopedDiagnostic[];
  /** The producer's and the host's findings. */
  hostDiagnostics?: readonly UhdBundleDiagnostic[];
  /** Whether the definition is a placeholder for one the bundle lacks. */
  isMissing?: (def: ModuleDef) => boolean;
}

const MAX_DEPTH = 24;

/** The module tree from the root: `[root]`. A definition that names itself further down stops there. */
export function buildHierarchy(root: ModuleDef, lookup: ModuleLookup, options: HierarchyOptions = {}): HierarchyNode[] {
  const byPath = new Map<string, HierarchyNode>();
  const byDef = new Map<string, HierarchyNode[]>();
  const visit = (def: ModuleDef | undefined, path: string, label: string, defId: string, depth: number, parent: string | undefined, quantity: number | undefined, seen: ReadonlySet<string>): HierarchyNode => {
    const kind = kindOf(def, depth === 0);
    const mark = options.marks?.[defId];
    const node: HierarchyNode = {
      path,
      ...(parent !== undefined ? { parent } : {}),
      label,
      defId,
      ...(def && def.name !== label ? { defName: def.name } : {}),
      kind,
      icon: mark?.shape === "ring" ? BLANK_ICON : KIND_ICON[kind],
      depth,
      ...(quantity && quantity > 1 ? { quantity } : {}),
      ...(mark ? { mark } : {}),
      ...(def && options.isMissing?.(def) ? { missing: true } : {}),
      findings: { error: 0, warning: 0, info: 0 },
      drillable: false,
      children: [],
    };
    byPath.set(path, node);
    byDef.set(defId, [...(byDef.get(defId) ?? []), node]);
    if (def && def.kind !== "harness" && depth < MAX_DEPTH && !seen.has(def.id)) {
      const below = new Set(seen).add(def.id);
      for (const ref of def.children ?? []) {
        const child = lookup(ref.moduleDefId);
        const p = path ? `${path}/${ref.id}` : ref.id;
        node.children.push(visit(child, p, ref.name ?? child?.name ?? ref.id, ref.moduleDefId, depth + 1, path, ref.quantity, below));
      }
    }
    node.drillable = node.children.length > 0 && kind !== "harness" && kind !== "fasteners";
    return node;
  };
  const tree = visit(root, "", root.name, root.id, 0, undefined, undefined, new Set());

  // findings: on the module they are about, or the nearest module above that the tree has
  const nearest = (path: string): HierarchyNode => {
    let p = path;
    for (;;) {
      const n = byPath.get(p);
      if (n) return n;
      if (!p) return tree;
      p = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    }
  };
  const add = (n: HierarchyNode, s: Severity) => void (n.findings[s] += 1);
  for (const d of options.diagnostics ?? []) {
    const ref = d.refs.find((r) => !r.startsWith("link:")) ?? d.refs[0];
    add(ref === undefined ? nearest(d.scope) : nearest(modulePart(ref, d.scope)), d.severity);
  }
  for (const d of options.hostDiagnostics ?? []) {
    const e = d.entity;
    if (e?.kind === "definition") {
      const used = byDef.get(e.id);
      if (used?.length) for (const n of used) add(n, d.severity);
      else add(tree, d.severity);
    } else add(e ? nearest(modulePart(e.id, "")) : tree, d.severity);
  }
  const roll = (n: HierarchyNode): Severity | undefined => {
    let w: Severity | undefined = n.findings.error ? "error" : n.findings.warning ? "warning" : n.findings.info ? "info" : undefined;
    for (const c of n.children) w = worse(w, roll(c));
    if (w) n.worst = w;
    return w;
  };
  roll(tree);
  return [tree];
}

/** The module a canonical ref names: `board/u2:pin_14` → `board/u2`, `link:a/b/l1` → `a/b`, `:sda` on a scope → the scope. */
export function modulePart(ref: string, scope: string): string {
  if (ref.startsWith("link:")) {
    const id = ref.slice(5);
    return id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : scope;
  }
  const colon = ref.indexOf(":");
  return colon < 0 ? ref : colon === 0 ? scope : ref.slice(0, colon);
}

export function* walkHierarchy(nodes: readonly HierarchyNode[]): Generator<HierarchyNode> {
  for (const n of nodes) {
    yield n;
    yield* walkHierarchy(n.children);
  }
}

/** Every node by path. */
export const hierarchyIndex = (nodes: readonly HierarchyNode[]): Map<string, HierarchyNode> => new Map([...walkHierarchy(nodes)].map((n) => [n.path, n]));

/** The paths above `path`, root first ("" for the root itself has none). */
export function ancestorsOf(path: string): string[] {
  if (!path) return [];
  const parts = path.split("/");
  const out = [""];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

/**
 * The tree reduced to the rows that match `text` (every word, in the label,
 * the definition's name, the instance path, the definition id or the kind;
 * case-insensitive), with
 * the modules that lead to them. A matching module keeps its own children.
 * Returns the reduced tree and the paths to show open.
 */
export function filterHierarchy(nodes: readonly HierarchyNode[], text: string): { nodes: HierarchyNode[]; expanded: Set<string>; matches: Set<string> } {
  const ws = text.toLowerCase().split(/\s+/).filter(Boolean);
  const expanded = new Set<string>();
  const matches = new Set<string>();
  if (!ws.length) return { nodes: [...nodes], expanded, matches };
  const hay = (n: HierarchyNode) => [n.label, n.defName, n.path, n.defId, KIND_LABEL[n.kind]].join(" ").toLowerCase();
  const visit = (n: HierarchyNode): HierarchyNode | undefined => {
    // the children are looked at even below a module that matches: a match inside it opens it, and is not
    // left folded and dimmed under its parent (an arm that matches "motor" by its definition hid its motor)
    const kept = n.children.map(visit).filter((c): c is HierarchyNode => !!c);
    if (ws.every((w) => hay(n).includes(w))) {
      matches.add(n.path);
      if (kept.length) expanded.add(n.path);
      return n;
    }
    if (!kept.length) return undefined;
    expanded.add(n.path);
    return { ...n, children: kept };
  };
  return { nodes: nodes.map(visit).filter((n): n is HierarchyNode => !!n), expanded, matches };
}

/** One row on screen. */
export interface HierarchyRow {
  node: HierarchyNode;
  /** 1-based, as `aria-level` takes it. */
  level: number;
  /** Has rows below it (open or not). */
  branch: boolean;
  open: boolean;
  /** 1-based place among its siblings, and how many there are (`aria-posinset`, `aria-setsize`). */
  pos: number;
  size: number;
}

/** The rows on screen: every node whose ancestors are all open. */
export function visibleRows(nodes: readonly HierarchyNode[], expanded: ReadonlySet<string>): HierarchyRow[] {
  const out: HierarchyRow[] = [];
  const add = (list: readonly HierarchyNode[], level: number) => {
    list.forEach((n, i) => {
      const branch = n.children.length > 0;
      const open = branch && expanded.has(n.path);
      out.push({ node: n, level, branch, open, pos: i + 1, size: list.length });
      if (open) add(n.children, level + 1);
    });
  };
  add(nodes, 1);
  return out;
}

/** What a key does on the tree: where the focus goes, what opens or closes, and what is asked of the viewer. */
export interface TreeKeyResult {
  focus: string;
  expanded: Set<string>;
  action?: "select" | "drill";
}

/**
 * The tree's keyboard (WAI-ARIA tree pattern): Up and Down move, Home and End
 * go to the first and last row; Right opens a closed module, or moves to its
 * first child; Left closes an open one, or moves to its parent; Enter and
 * Space select the row (Enter on the row already selected drills into it,
 * when it has a level of its own); `*` opens every sibling. Undefined: the key
 * is not the tree's.
 */
export function treeKey(rows: readonly HierarchyRow[], focus: string, key: string, expanded: ReadonlySet<string>, selected?: string): TreeKeyResult | undefined {
  if (!rows.length) return undefined;
  let i = rows.findIndex((r) => r.node.path === focus);
  if (i < 0) i = 0;
  const row = rows[i];
  const next = new Set(expanded);
  const at = (j: number): TreeKeyResult => ({ focus: rows[Math.max(0, Math.min(rows.length - 1, j))].node.path, expanded: next });
  switch (key) {
    case "ArrowDown":
      return at(i + 1);
    case "ArrowUp":
      return at(i - 1);
    case "Home":
      return at(0);
    case "End":
      return at(rows.length - 1);
    case "ArrowRight":
      if (!row.branch) return at(i);
      if (!row.open) {
        next.add(row.node.path);
        return { focus: row.node.path, expanded: next };
      }
      return at(i + 1);
    case "ArrowLeft": {
      if (row.branch && row.open) {
        next.delete(row.node.path);
        return { focus: row.node.path, expanded: next };
      }
      const parent = row.node.parent;
      return parent !== undefined && rows.some((r) => r.node.path === parent) ? { focus: parent, expanded: next } : at(i);
    }
    case "*": {
      for (const r of rows) if (r.node.parent === row.node.parent && r.branch) next.add(r.node.path);
      return { focus: row.node.path, expanded: next };
    }
    case "Enter":
      return { focus: row.node.path, expanded: next, action: selected === row.node.path && row.node.drillable ? "drill" : "select" };
    case " ":
      return { focus: row.node.path, expanded: next, action: "select" };
    default:
      return undefined;
  }
}

/** The module path the diagram has selected, from its level and selection; undefined for none, a link or a net. */
export function selectedPath(drill: readonly string[], selection: LevelSelection): string | undefined {
  if (!selection || selection.kind !== "node") return undefined;
  const id = fullId([...drill], selection.id);
  // a net's junction or a boundary interface (`board:sda`, `@sda`): not a module
  if (id.includes(":") || id.split("/").some((p) => p.startsWith("@"))) return undefined;
  return id;
}

/**
 * Where a click on a row takes the diagram: the level that holds the module,
 * with it selected (the current level, when the module is drawn there; the
 * root row is the top level with nothing selected).
 */
export function rowTarget(
  root: ModuleDef,
  lookup: ModuleLookup,
  path: string,
  current: { drill: string[]; expanded: ReadonlySet<string> },
): { drill: string[]; selection: LevelSelection } {
  return focusTarget(root, lookup, path, current);
}

/** Where drilling into a row takes the diagram: its own level, nothing selected. */
export function drillInto(node: HierarchyNode): { drill: string[]; selection: LevelSelection } {
  return { drill: node.path ? node.path.split("/") : [], selection: null };
}

/** The paths to open so that `path` shows: its ancestors. */
export function revealPaths(expanded: ReadonlySet<string>, path: string | undefined): Set<string> {
  if (path === undefined) return expanded as Set<string>;
  const need = ancestorsOf(path).filter((p) => !expanded.has(p));
  if (!need.length) return expanded as Set<string>;
  return new Set([...expanded, ...need]);
}

/** What the panel keeps per tab: open or folded to its rail, its width, the open modules. */
export interface HierarchyPanelState {
  open: boolean;
  width: number;
  expanded: string[];
}

export const HIERARCHY_WIDTH = { min: 180, max: 520, default: 280 } as const;

/** A kept state, checked; anything malformed falls back to the default. */
export function panelState(v: unknown, fallbackOpen = true): HierarchyPanelState {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const width = typeof o.width === "number" && Number.isFinite(o.width) ? clampWidth(o.width) : HIERARCHY_WIDTH.default;
  const expanded = Array.isArray(o.expanded) ? o.expanded.filter((x): x is string => typeof x === "string").slice(0, 2000) : [""];
  return { open: typeof o.open === "boolean" ? o.open : fallbackOpen, width, expanded };
}

export const clampWidth = (w: number, room = Infinity) => Math.round(Math.max(HIERARCHY_WIDTH.min, Math.min(HIERARCHY_WIDTH.max, room, w)));

/** The row that holds the wiring and hardware (harnesses, cables, fastener stacks): not a module of the system. */
export const WIRING_PATH = "#wiring";
const WIRING_KINDS: ReadonlySet<HierarchyKind> = new Set(["harness", "fasteners"]);

/**
 * The tree as the panel shows it: the system's structure first, and its
 * wiring and hardware (every harness and fastener stack, wherever it sits)
 * folded into one group row at the bottom, `WIRING_PATH`. Without any, the
 * tree as it is.
 */
export function groupWiring(nodes: readonly HierarchyNode[]): HierarchyNode[] {
  const wiring: HierarchyNode[] = [];
  const strip = (n: HierarchyNode): HierarchyNode => {
    if (!n.children.some((c) => WIRING_KINDS.has(c.kind) || c.children.length)) return n;
    const kept: HierarchyNode[] = [];
    for (const c of n.children) {
      if (WIRING_KINDS.has(c.kind)) wiring.push({ ...c, where: n.label });
      else kept.push(strip(c));
    }
    return { ...n, children: kept, drillable: n.drillable };
  };
  const structure = nodes.map(strip);
  if (!wiring.length) return structure;
  let worst: Severity | undefined;
  for (const w of wiring) worst = worse(worst, w.worst);
  const group: HierarchyNode = {
    path: WIRING_PATH,
    label: "Wiring & hardware",
    defId: "",
    kind: "group",
    icon: "cable",
    depth: 0,
    findings: { error: 0, warning: 0, info: 0 },
    ...(worst ? { worst } : {}),
    drillable: false,
    group: true,
    children: wiring,
  };
  return [...structure, group];
}

/** The marks the tree shows, once each, in the order of their tones: a legend (the first sentence of a mark's label names it). */
export function markLegend(nodes: readonly HierarchyNode[]): { tone: NodeMark["tone"]; label: string }[] {
  const ORDER: NodeMark["tone"][] = ["neutral", "warning", "ok", "info", "error"];
  const seen = new Map<NodeMark["tone"], string>();
  for (const n of walkHierarchy(nodes)) {
    const m = n.mark;
    if (!m || m.shape === "ring" || seen.has(m.tone)) continue;
    const label = (m.label ?? "").split(/[.:]/)[0].trim();
    if (label && label.length <= 24) seen.set(m.tone, label);
  }
  return ORDER.filter((t) => seen.has(t)).map((tone) => ({ tone, label: seen.get(tone)! }));
}
