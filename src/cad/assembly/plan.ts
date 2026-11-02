/**
 * How a board drawn as an assembly comes apart (R3-A, 2026-11-02). Pure: no three.js, unit-tested.
 *
 * - Explode (the radial mode, all at once): every component leaves along the board's normal, top-side parts up and
 *   bottom-side parts down, the board itself stays. Distances are staggered by height so tall parts clear short ones:
 *   parts fall into height tiers (DEFAULT `TIER_BOUNDS_MM`), and each tier lifts past the tallest part of every tier
 *   below it plus a gap, so chips, then passives and packages, then connectors and tall capacitors come off in layers.
 * - Assemble (the sequence mode): the same moves, one step per UHD group of the board (its sections and the groups
 *   inside them: power input, fan power, rails, MCU, USB, ...), in the board's own order; the board is the base.
 *
 * Units: mm, the level's CAD frame (UHD, Z up), as the sequence player's poses (../sequence/resolve.ts).
 */
import type { RadialMove, RadialPart } from "../explode";
import type { RadialPlan, ResolvedWithRadial } from "../sequence/player";
import type { ResolvedMember, ResolvedStep } from "../sequence/resolve";
import { DEFAULTS } from "../sequence/types";

export type V3 = [number, number, number];

/** DEFAULT (R3-A): height tiers (mm out of the board face): under 1 (0402/0603 chips), 2.5 (SOT, SOIC), 5 (modules, inductors), 10 (connectors), above. */
export const TIER_BOUNDS_MM = [1, 2.5, 5, 10] as const;
/** DEFAULT (R3-A): the gap between tiers and off the board face, as a share of the board's width, at least `LIFT_GAP_MIN_MM`
 * (6 mm on ClientX's 102 mm board: 4 % read as "barely moved" for the chips in the first live check). */
export const LIFT_GAP_SHARE = 0.06;
export const LIFT_GAP_MIN_MM = 2;

/** A component as the plan needs it: its key in the level (an instance path), side, height and box (level mm). */
export interface BoardPartInput {
  key: string;
  side: "top" | "bottom";
  height: number;
  box: [V3, V3];
}

/** A step's members: a UHD group (or section) of the board by its path prefix in the level, and its title. */
export interface BoardGroup {
  prefix: string;
  title: string;
  /** The section it belongs to (callout). */
  section?: string;
}

export function tierOf(height: number, bounds: readonly number[] = TIER_BOUNDS_MM): number {
  let k = 0;
  while (k < bounds.length && height > bounds[k]) k++;
  return k;
}

/** The gap of a board `span` mm wide (DEFAULT 6 % of it, at least 2 mm). */
export const liftGap = (span: number): number => Math.max(LIFT_GAP_MIN_MM, LIFT_GAP_SHARE * Math.max(0, span));

/**
 * How far each part travels at full explode (mm), per side: tier k lifts `gap + sum over the occupied tiers below
 * it of (their tallest part + gap)`, so a tier's lowest face ends above the highest face of every tier below it.
 */
export function liftDistances(parts: readonly BoardPartInput[], gap: number, bounds: readonly number[] = TIER_BOUNDS_MM): Map<string, number> {
  const out = new Map<string, number>();
  for (const side of ["top", "bottom"] as const) {
    const mine = parts.filter((p) => p.side === side);
    const tallest = new Map<number, number>();
    for (const p of mine) {
      const k = tierOf(p.height, bounds);
      tallest.set(k, Math.max(tallest.get(k) ?? 0, p.height));
    }
    const tiers = [...tallest.keys()].sort((a, b) => a - b);
    const lift = new Map<number, number>();
    let at = gap;
    for (const k of tiers) {
      lift.set(k, at);
      at += tallest.get(k)! + gap;
    }
    for (const p of mine) out.set(p.key, lift.get(tierOf(p.height, bounds))!);
  }
  return out;
}

const unit = (v: readonly number[]): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** Each part's move at full explode: along the board normal (top side) or against it (bottom side), its tier's lift. */
export function boardMoves(parts: readonly BoardPartInput[], normal: V3, span: number): Map<string, RadialMove> {
  const n = unit(normal);
  const down: V3 = [-n[0], -n[1], -n[2]];
  const lift = liftDistances(parts, liftGap(span));
  return new Map(parts.map((p) => [p.key, { dir: p.side === "top" ? n : down, distance: lift.get(p.key) ?? 0, from: "sequence" as const }]));
}

/** The group a part belongs to: the longest prefix that holds it; undefined when none does. */
export function groupOf(key: string, groups: readonly BoardGroup[]): BoardGroup | undefined {
  let best: BoardGroup | undefined;
  for (const g of groups) if ((g.prefix === "" || key === g.prefix || key.startsWith(`${g.prefix}/`)) && (!best || g.prefix.length > best.prefix.length)) best = g;
  return best;
}

const centreOf = (b: [V3, V3]): V3 => [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2, (b[0][2] + b[1][2]) / 2];

/**
 * The Assemble steps (assembly order): one per group that holds parts, in the groups' order; parts no group holds
 * come last ("Other parts"). Each member's move is its explode move.
 */
export function boardSteps(parts: readonly BoardPartInput[], groups: readonly BoardGroup[], moves: ReadonlyMap<string, RadialMove>, durationS = DEFAULTS.durationS): ResolvedStep[] {
  const by = new Map<string, BoardPartInput[]>();
  const other: BoardPartInput[] = [];
  for (const p of parts) {
    const g = groupOf(p.key, groups);
    if (!g) other.push(p);
    else by.set(g.prefix, [...(by.get(g.prefix) ?? []), p]);
  }
  const member = (p: BoardPartInput): ResolvedMember => {
    const m = moves.get(p.key);
    return { ref: p.key, dir: m?.dir ?? [0, 0, 1], distance: m?.distance ?? 0, pivot: centreOf(p.box), turns: 0, pitchMm: 0, delay: 0 };
  };
  const step = (id: string, title: string, list: BoardPartInput[], callout?: string): ResolvedStep => {
    const members = list.map(member);
    return { id, title, kind: "place", sequence: "main", depth: 0, members, durationS, ease: "cubic", links: [], ...(callout ? { callout } : {}), still: members.every((m) => m.distance === 0), planned: false };
  };
  const out: ResolvedStep[] = [];
  for (const g of groups) {
    const list = by.get(g.prefix);
    if (!list?.length) continue;
    out.push(step(`board:${g.prefix || "board"}`, g.title, list, `${g.section ? `${g.section}: ` : ""}${list.length} part${list.length === 1 ? "" : "s"}`));
  }
  if (other.length) out.push(step("board:other", "Other parts", other, `${other.length} part${other.length === 1 ? "" : "s"}`));
  return out;
}

/** Explode-time windows of steps (the last assembled first; still steps take no time): the rule of ../sequence/resolve.ts. */
export function windowsFor(steps: readonly ResolvedStep[]): [number, number][] {
  const weight = steps.map((s) => (s.still ? 0 : Math.max(0.05, s.durationS)));
  const total = weight.reduce((a, b) => a + b, 0) || 1;
  const out: [number, number][] = steps.map(() => [0, 0]);
  let at = 0;
  for (let i = steps.length - 1; i >= 0; i--) {
    out[i] = [at / total, (at + weight[i]) / total];
    at += weight[i];
  }
  return out;
}

export interface BoardPlan {
  steps: ResolvedStep[];
  moves: Map<string, RadialMove>;
  /** Radial parts (a scoped explode plans them again: the overrides keep their own moves). */
  parts: RadialPart[];
  overrides: Map<string, { direction?: V3; distance?: number }>;
}

/** A board's whole plan: moves, steps, and what a scoped explode needs. */
export function planBoard(parts: readonly BoardPartInput[], groups: readonly BoardGroup[], normal: V3, span: number): BoardPlan {
  const moves = boardMoves(parts, normal, span);
  const steps = boardSteps(parts, groups, moves);
  const overrides = new Map([...moves].map(([k, m]) => [k, { direction: m.dir, distance: m.distance }]));
  const radial: RadialPart[] = parts.map((p) => ({ key: p.key, centre: centreOf(p.box), facings: [], box: p.box }));
  return { steps, moves, parts: radial, overrides };
}

/**
 * The model's resolved sequence with a board's assembly in it: the board (`holder`, its body key) stays put in both
 * modes (it is the base), its components follow the board plan; everything else is as resolved.
 */
export function withBoard(resolved: ResolvedWithRadial, plan: BoardPlan, holder: string, up: V3 = [0, 0, 1]): ResolvedWithRadial {
  const generic = resolved.steps
    .map((s) => ({ ...s, members: s.members.filter((m) => m.ref !== holder) }))
    .filter((s) => s.members.length > 0);
  const steps = [...generic, ...plan.steps];
  const base: RadialPlan = resolved.radial ?? { moves: new Map(), centre: [0, 0, 0], radius: 0, ms: 0, parts: [], up };
  const moves = new Map(base.moves);
  moves.set(holder, { dir: base.up ?? up, distance: 0, from: "sequence" });
  for (const [k, m] of plan.moves) moves.set(k, m);
  const overrides = new Map(base.overrides ?? []);
  overrides.set(holder, { distance: 0 });
  for (const [k, o] of plan.overrides) overrides.set(k, o);
  const keys = new Set(plan.parts.map((p) => p.key));
  // wave R3 gate: the plan says a board is in it, so the timeline names the board's normal and counts its components
  const radial: RadialPlan = { ...base, moves, parts: [...(base.parts ?? []).filter((p) => !keys.has(p.key)), ...plan.parts], overrides, board: { holder, components: plan.parts.length } };
  return { ...resolved, steps, windows: windowsFor(steps), radial };
}
