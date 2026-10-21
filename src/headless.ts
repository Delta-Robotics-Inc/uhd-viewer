/**
 * Headless layout (PB-1007): the viewer's diagram layout without a browser,
 * for hosts that check or write a project's layout (`protoboard layout`).
 *
 *   import { diagramLevels, measureLevel, proposeLevel } from "@deltarobotics/uhd-viewer/headless";
 *
 * Everything here computes what the viewer would draw for a level: the same
 * model (`buildView`, rail taps), the same layout and routes
 * (`computeLayout`), from the bundle and its display hints. No React, no DOM.
 */
import type { UhdBundle } from "@uhd/types/bundle.js";
import type { ModuleDef } from "@uhd/types/index.js";
import type { ModuleLookup } from "@uhd/system/index.js";
import { sourceFromBundle, type DisplayConfig } from "./source/source";
import { buildView, levelModule } from "./model/from-uhd";
import { tapRails } from "./layout/taps";
import { arrangeLevel, computeLayout, type ComputedLayout, type LevelLayout } from "./layout/layout";
import { layoutFindings, measureLayout, LAYOUT_LIMITS, type LayoutFinding, type LayoutMetrics } from "./layout/metrics";
import type { ViewModel } from "./model/types";

export { LAYOUT_LIMITS, layoutFindings, measureLayout };
export type { LayoutFinding, LayoutMetrics, LevelLayout };

/** A level of the diagram: the inside of one module, keyed by its instance path ("" = the top level). */
export interface DiagramLevel {
  level: string;
  /** The module's name. */
  label: string;
  /** The level holds a board's nets (laid out as a schematic sheet, board-layout.ts). */
  board: boolean;
}

/** A level layout with the nodes the layout step must not move (PB-1007; the viewer ignores the list). */
export type PinnedLevelLayout = LevelLayout & { pinned?: string[] };

interface Loaded {
  system: ModuleDef;
  lookup: ModuleLookup;
  display: DisplayConfig;
}

function load(bundle: UhdBundle): Loaded {
  const src = sourceFromBundle(bundle, "bundle.json");
  const nominal = src.scenarios[0];
  return { system: nominal.system, lookup: nominal.lookup, display: src.display };
}

/** Every level of the diagram, top first: the top level and the inside of every module that has modules in it. */
export function diagramLevels(bundle: UhdBundle, maxDepth = 4): DiagramLevel[] {
  const { system, lookup } = load(bundle);
  const out: DiagramLevel[] = [];
  const walk = (def: ModuleDef, path: string[], label: string) => {
    const children = def.children ?? [];
    if (!children.length) return;
    const board = (def.interfaces ?? []).some((i) => (i as { protocol?: { type?: string } }).protocol?.type === "Net" || (i as { kind?: string }).kind === "net");
    out.push({ level: path.join("/"), label, board: board || isBoardLevel(system, lookup, path) });
    if (path.length >= maxDepth) return;
    for (const c of children) {
      const next = lookup(c.moduleDefId);
      if (!next || next.kind === "harness") continue;
      walk(next, [...path, c.id], c.name ?? next.name);
    }
  };
  walk(system, [], system.name);
  return out;
}

/** Whether a level draws net junctions (a board): what the viewer's own view model says. */
function isBoardLevel(system: ModuleDef, lookup: ModuleLookup, drill: string[]): boolean {
  try {
    return buildView(system, lookup, drill, { expanded: new Set() }).nodes.some((n) => n.kind === "net");
  } catch {
    return false;
  }
}

export interface LevelOptions {
  /** The level's layout to use: the display file's when undefined; null for none (the automatic layout). */
  layout?: LevelLayout | null;
  /** Modules drawn expanded in place (default: the display file's `diagram.expanded`). */
  expanded?: string[];
  /** Lay a level without a layout out the way the viewer did before PB-1007 (one row), to compare. */
  legacy?: boolean;
}

export interface MeasuredLevel {
  level: string;
  /** Whether the layout measured is a saved one (from the display file or given). */
  saved: boolean;
  metrics: LayoutMetrics;
  findings: LayoutFinding[];
  /** What the viewer draws: the model and the computed layout. */
  view: ViewModel;
  layout: ComputedLayout;
}

/** The display hints of a bundle: its `display`, as the viewer reads it. */
export function displayOf(bundle: UhdBundle): DisplayConfig {
  return (bundle.display ?? {}) as DisplayConfig;
}

/** Lay a level out as the viewer would, and measure it. */
export function measureLevel(bundle: UhdBundle, level: string, opts: LevelOptions = {}): MeasuredLevel {
  const { system, lookup, display } = load(bundle);
  const drill = level ? level.split("/") : [];
  const known = levelModule(system, drill, lookup);
  if (known.path.length !== drill.length + 1) throw new Error(`no level "${level}" (levels are instance paths of modules with modules inside)`);
  const expanded = new Set(opts.expanded ?? display.diagram?.expanded ?? []);
  const vm = tapRails(buildView(system, lookup, drill, { expanded }));
  const hand = opts.layout === null ? undefined : (opts.layout ?? display.diagram?.layouts?.[level]);
  const layout = computeLayout(vm, hand, {}, false, undefined, undefined, { legacy: opts.legacy });
  const metrics = measureLayout(vm, layout);
  return { level, saved: !!hand, metrics, findings: layoutFindings(metrics), view: vm, layout };
}

/**
 * A display-file level that holds a computed layout: every node's position
 * (top-level nodes absolute, nodes inside an expanded module relative to
 * it), as the viewer writes them.
 */
export function levelLayoutOf(vm: ViewModel, layout: ComputedLayout): LevelLayout {
  const nodes: LevelLayout["nodes"] = {};
  const byId = new Map(vm.nodes.map((n) => [n.id, n]));
  for (const n of [...vm.nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    const b = layout.boxes[n.id];
    if (!b) continue;
    // a rail's taps are drawn from the net: they are placed again from it, never saved
    if (n.tapOf) continue;
    const p = n.parent ? layout.boxes[n.parent] : undefined;
    nodes[n.id] = p && byId.get(n.parent!) ? { x: b.x - p.x, y: b.y - p.y } : { x: b.x, y: b.y };
    // a module expanded in place keeps the size it was laid out at (else the viewer takes the layout as made
    // for its collapsed card, and moves what is beside and below it)
    if (n.expanded) Object.assign(nodes[n.id], { w: b.w, h: b.h });
  }
  return { nodes };
}

export interface ProposeOptions extends LevelOptions {
  /**
   * "default": the level laid out afresh (the viewer's automatic layout);
   * "tidy": the saved layout's arrangement kept as the starting point, and
   * what reads badly (strips, overlaps, crossings) fixed.
   */
  mode?: "default" | "tidy";
  /** Nodes that keep their saved positions (added to the level's own `pinned`). */
  pinned?: string[];
}

export interface Proposal {
  level: string;
  /** The level as it is drawn now. */
  before: MeasuredLevel;
  /** The level with the proposed layout. */
  after: MeasuredLevel;
  /** What to write to `diagram.layouts[level]`. */
  layout: PinnedLevelLayout;
  /** Whether the proposal reads clearly better than what is there (`readsBetter`). */
  better: boolean;
}

/**
 * A layout for a level: afresh, or tidied from the saved one; pinned nodes
 * keep their saved positions. Links whose ends moved lose their saved
 * waypoints (they were drawn for the old places); labels and tabs stay.
 */
export function proposeLevel(bundle: UhdBundle, level: string, opts: ProposeOptions = {}): Proposal {
  const before = measureLevel(bundle, level, opts);
  const saved: PinnedLevelLayout | undefined = opts.layout === null ? undefined : (opts.layout ?? (displayOf(bundle).diagram?.layouts?.[level] as PinnedLevelLayout | undefined));
  const pinned = [...new Set([...(saved?.pinned ?? []), ...(opts.pinned ?? [])])].filter((id) => saved?.nodes[id]?.x !== undefined).sort();
  const fixed: Record<string, { x: number; y: number }> = {};
  for (const id of pinned) fixed[id] = { x: saved!.nodes[id].x!, y: saved!.nodes[id].y! };
  // the starting arrangement: for a tidy, where the cards are drawn now
  const seed = opts.mode === "tidy" ? Object.fromEntries(Object.entries(before.layout.boxes).map(([id, b]) => [id, { x: b.x + b.w / 2, y: b.y + b.h / 2 }])) : undefined;
  // a tidy keeps the sizes set by hand; a fresh layout gives every card its own size again
  const keepSizes = opts.mode === "tidy" ? saved : undefined;
  const fresh = arrangeLevel(before.view, { fixed, seed }, keepSizes);
  // the arrangement as a hand layout, laid out once more so the saved positions are exactly what is drawn
  const draft = measureLevel(bundle, level, { ...opts, layout: { ...fresh, ...(keepSizes?.ports ? { ports: keepSizes.ports } : {}) } });
  const layout: PinnedLevelLayout = levelLayoutOf(draft.view, draft.layout);
  for (const id of pinned) layout.nodes[id] = { ...fixed[id] };
  // sizes and port sides set by hand stay; waypoints only where neither end moved
  if (keepSizes) for (const [id, n] of Object.entries(saved?.nodes ?? {})) if (layout.nodes[id] && (n.w !== undefined || n.h !== undefined)) layout.nodes[id] = { ...layout.nodes[id], ...(n.w !== undefined ? { w: n.w } : {}), ...(n.h !== undefined ? { h: n.h } : {}) };
  if (keepSizes?.ports) layout.ports = { ...keepSizes.ports };
  const moved = (id: string) => !pinned.includes(id.split("/")[0]);
  const links: NonNullable<LevelLayout["links"]> = {};
  for (const [id, l] of Object.entries(saved?.links ?? {})) {
    const link = before.view.links.find((x) => x.id === id);
    const keep = link && !moved(link.source.node) && !moved(link.target.node);
    const { waypoints, ...rest } = l;
    const next = keep && waypoints ? { ...rest, waypoints } : rest;
    if (Object.keys(next).length) links[id] = next;
  }
  if (Object.keys(links).length) layout.links = links;
  if (pinned.length) layout.pinned = pinned;
  const refined = before.view.nodes.some((n) => n.kind === "net") ? layout : refine(bundle, level, opts, layout, pinned);
  const after = measureLevel(bundle, level, { ...opts, layout: refined });
  return { level, before, after, layout: refined, better: readsBetter(after.metrics, before.metrics) };
}

/** Swaps tried at most when refining a level (the same count every run: the result does not depend on the machine). */
export const REFINE_BUDGET = 120;
/** Levels with more cards than this keep the grid's arrangement (each try routes the whole level). */
export const REFINE_MAX_CARDS = 16;

/**
 * Refine a proposed layout on what the viewer actually draws: swap two
 * cards' places (centre for centre) while that lowers the routed crossings,
 * overlaps or line length (`reads`), up to REFINE_BUDGET tries. Pinned cards
 * stay. Deterministic: pairs in id order, the first improvement taken.
 */
function refine(bundle: UhdBundle, level: string, opts: LevelOptions, start: PinnedLevelLayout, pinned: string[]): PinnedLevelLayout {
  const ids = Object.keys(start.nodes)
    .filter((id) => !id.includes("/") && !pinned.includes(id))
    .sort();
  if (ids.length < 3 || ids.length > REFINE_MAX_CARDS) return start;
  let best = start;
  let m = measureLevel(bundle, level, { ...opts, layout: best });
  let score = reads(m.metrics);
  let tries = 0;
  let improved = true;
  while (improved && tries < REFINE_BUDGET) {
    improved = false;
    for (let i = 0; i < ids.length && tries < REFINE_BUDGET; i++)
      for (let j = i + 1; j < ids.length && tries < REFINE_BUDGET; j++) {
        const a = m.layout.boxes[ids[i]];
        const b = m.layout.boxes[ids[j]];
        if (!a || !b) continue;
        const snap = (v: number) => Math.round(v / 16) * 16;
        const nodes = { ...best.nodes };
        nodes[ids[i]] = { ...nodes[ids[i]], x: snap(b.x + b.w / 2 - a.w / 2), y: snap(b.y + b.h / 2 - a.h / 2) };
        nodes[ids[j]] = { ...nodes[ids[j]], x: snap(a.x + a.w / 2 - b.w / 2), y: snap(a.y + a.h / 2 - b.h / 2) };
        const next: PinnedLevelLayout = { ...best, nodes };
        tries++;
        const nm = measureLevel(bundle, level, { ...opts, layout: next });
        const ns = reads(nm.metrics);
        if (ns < score - 1e-6) {
          best = next;
          m = nm;
          score = ns;
          improved = true;
        }
      }
  }
  return best;
}



/**
 * Whether layout `a` reads clearly better than `b`: fewer problems (warnings,
 * then overlaps, the strip's excess, crossings, lines under cards), or as
 * few and lines a quarter shorter. A layout with nothing to fix is not
 * replaced for a few pixels of line.
 */
export function readsBetter(a: LayoutMetrics, b: LayoutMetrics): boolean {
  const problems = (m: LayoutMetrics) => [
    layoutFindings(m).filter((x) => x.severity === "warning").length,
    m.overlaps,
    Math.max(0, m.strip - LAYOUT_LIMITS.strip(m.cards)),
    m.crossings,
    m.underCards,
  ];
  const pa = problems(a);
  const pb = problems(b);
  for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i];
  return a.length < 0.75 * b.length;
}

/** A score for comparing two layouts of one level: lower reads better. */
export function reads(m: LayoutMetrics): number {
  const f = layoutFindings(m).filter((x) => x.severity === "warning").length;
  return f * 1e9 + m.overlaps * 1e7 + Math.max(0, m.strip - LAYOUT_LIMITS.strip(m.cards)) * 1e6 + m.crossings * 1e4 + m.underCards * 1e3 + m.length / 100;
}
