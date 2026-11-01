/**
 * Pure rules the 3D view applies to its state (PB-1178, PB-1137): which
 * drawn things a path names, the placeholder count, the up direction and the
 * assembly root. Kept apart from CadView so they test without a page, and so
 * `protoboard check` can apply the same root rule (handoffs.md, W2-A to the
 * core owner).
 */
import type { ModuleDef } from "@uhd/types/index.js";
import { glbFor } from "../model";
import type { Vec3 } from "./schema";

const pathOf = (key: string) => key.split("#")[0];

/** A drawn thing (a body's key, `path#artifact` for one body of several; a harness's path) is `path` or lies under it. */
export function matchesPath(key: string, path: string): boolean {
  const k = pathOf(key);
  if (path === "") return true;
  return k === path || k.startsWith(`${path}/`);
}

/** A drawn body holds what `path` names (a board's component inside its body): its path is an ancestor of `path`. */
export function holdsPath(key: string, path: string): boolean {
  const k = pathOf(key);
  return k === "" ? path !== "" : path.startsWith(`${k}/`);
}

/**
 * Whether a drawn thing is shown under isolation and hiding: with an
 * isolation it must be one of the isolated paths, lie under one, or hold one
 * (the board a component is drawn in); a hidden path hides it and what lies
 * under it.
 */
export function shownBy(key: string, isolation: string[] | null, hidden: string[]): boolean {
  if (hidden.some((p) => matchesPath(key, p))) return false;
  if (!isolation) return true;
  return isolation.some((p) => matchesPath(key, p) || holdsPath(key, p));
}

export interface PlaceholderSummary {
  /** Components drawn as stand-ins, or that the build says have no model of their own. */
  count: number;
  /** Components the view knows: drawn bodies and components, and those the build reports. */
  of: number;
  /** Their instance paths. */
  paths: string[];
  /** The line the view shows ("2 of 27 components are placeholders"), empty when none is. */
  line: string;
}

/** Diagnostic codes the model resolver (W1-B) reports for an instance without a model of its own. */
export const PLACEHOLDER_CODES = ["PB_MODEL_PLACEHOLDER", "PB_MODEL_MISSING"];

/**
 * "N of M components are placeholders" (handoffs.md, W1-B's rule): N is the
 * instances whose drawn model carries `extras.protoboard.placeholder` or that
 * the build reports as `PB_MODEL_PLACEHOLDER` / `PB_MODEL_MISSING`; M is the
 * components drawn, together with those.
 */
export function placeholderSummary(nodes: { instancePath: string; kind: string; placeholder: boolean }[], diagnostics: { code?: string; entity?: { kind?: string; id?: string } }[], inScope: (path: string) => string | undefined = (p) => p): PlaceholderSummary {
  const all = new Set<string>();
  const flagged = new Set<string>();
  for (const n of nodes) {
    if (n.kind === "harness") continue;
    all.add(n.instancePath);
    if (n.placeholder) flagged.add(n.instancePath);
  }
  for (const d of diagnostics) {
    if (!d.code || !PLACEHOLDER_CODES.includes(d.code) || d.entity?.kind !== "instance" || typeof d.entity.id !== "string") continue;
    const p = inScope(d.entity.id);
    if (p === undefined) continue;
    all.add(p);
    flagged.add(p);
  }
  const count = flagged.size;
  const of = all.size;
  return { count, of, paths: [...flagged].sort(), line: count ? `${count} of ${of} component${of === 1 ? " is a placeholder" : count === 1 ? "s is a placeholder" : "s are placeholders"}` : "" };
}

/**
 * The direction drawn up (PB-1137): `spatial.view.up` (as since PB-873), or
 * the shorthand `spatial.up`; a model built tilted (its root's +z along
 * (1, 1, 1)) opens upright with `"up": [1, 1, 1]`. Only for the whole
 * assembly: a module on its own is seen in its own coordinates. Normalised;
 * anything else is +z.
 */
export function viewUp(spatial: { up?: unknown; view?: { up?: unknown } } | undefined, scope: string): Vec3 {
  if (scope) return [0, 0, 1];
  const raw = spatial?.view?.up ?? spatial?.up;
  if (!Array.isArray(raw) || raw.length !== 3 || !raw.every((x) => typeof x === "number" && Number.isFinite(x))) return [0, 0, 1];
  const len = Math.hypot(raw[0], raw[1], raw[2]);
  if (len < 1e-9) return [0, 0, 1];
  return [raw[0] / len, raw[1] / len, raw[2] / len];
}

/**
 * The instance the assembly is placed from (PB-1137), one rule for the
 * viewer and `protoboard check`:
 * 1. `spatial.root` when it names an instance (a path from the top level);
 * 2. else the system itself when it has a body of its own (a board as the
 *    bundle's root);
 * 3. else the top-level module (not a harness) with the most interface
 *    frames, the first in declaration order on a tie.
 * Returns the path (`[]`: the system itself) and which rule chose it.
 */
export function assemblyRoot(system: ModuleDef, lookup: (id: string) => ModuleDef | undefined, spatialRoot?: string): { path: string[]; rule: "display" | "own-body" | "most-frames" | "none" } {
  if (spatialRoot) {
    const parts = spatialRoot.split("/").filter(Boolean);
    let def: ModuleDef | undefined = system;
    for (const id of parts) def = def ? lookup(def.children?.find((c) => c.id === id)?.moduleDefId ?? "") : undefined;
    if (def && parts.length) return { path: parts, rule: "display" };
  }
  if (glbFor(system)) return { path: [], rule: "own-body" };
  let best: { id: string; frames: number } | undefined;
  for (const c of system.children ?? []) {
    const def = lookup(c.moduleDefId);
    if (!def || def.kind === "harness") continue;
    const frames = def.interfaces.filter((i) => i.geometry?.frame).length;
    if (frames && (!best || frames > best.frames)) best = { id: c.id, frames };
  }
  return best ? { path: [best.id], rule: "most-frames" } : { path: [], rule: "none" };
}

/** A record id within the schema's 128 characters: a longer one keeps its head and an FNV-1a hash of the whole (DEFAULT). */
export function shortRecordId(id: string, max = 128): string {
  if (id.length <= max) return id;
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < id.length; i++) {
    a = Math.imul(a ^ id.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b ^ id.charCodeAt(id.length - 1 - i), 0x01000193) >>> 0;
  }
  const hash = `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
  return `${id.slice(0, max - hash.length - 1)}~${hash}`;
}
