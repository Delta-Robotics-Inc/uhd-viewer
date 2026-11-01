/**
 * The view's typed write verbs (collaboration D3: no code evaluation) and the
 * pure reducer under them. Every verb expands to `set` operations on one
 * top-level key (or one entry of it); applying them gives the new state and
 * the inverse (the values they replaced), so an undo is just another batch.
 */
import type { SetOp } from "../../api";
import { WRITABLE_KEYS, checkValue, clone, defaultViewState, same, validName, type CameraState, type ExplodeState, type NamedView, type SectionPlane, type ViewSelection, type ViewState, type WritableKey } from "./schema";

export type { SetOp };

export type ViewOp =
  | SetOp
  | { op: "camera"; camera: CameraState }
  | { op: "select"; selection: ViewSelection }
  | { op: "highlight"; paths: string[] }
  | { op: "isolate"; paths: string[] | null }
  | { op: "hide"; paths: string[]; hidden?: boolean }
  | { op: "explode"; t: number; step?: string | number | null }
  | { op: "section"; sections: SectionPlane[] }
  | { op: "saveView"; name: string; view?: NamedView }
  | { op: "deleteView"; name: string }
  | { op: "applyView"; name: string };

export const VIEW_OPS = ["set", "camera", "select", "highlight", "isolate", "hide", "explode", "section", "saveView", "deleteView", "applyView"] as const;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The `set` operations a verb stands for against `state`, or the reason it
 * cannot run. Nothing is applied here.
 */
export function expandOp(state: ViewState, raw: unknown): SetOp[] | { error: string } {
  if (!isObj(raw) || typeof raw.op !== "string") return { error: "an op needs an `op` name" };
  const op = raw as ViewOp;
  switch (op.op) {
    case "set": {
      const path = op.path as unknown;
      const parts = typeof path === "string" ? (path.includes(".") ? [path.slice(0, path.indexOf(".")), path.slice(path.indexOf(".") + 1)] : [path]) : path;
      if (!Array.isArray(parts) || parts.length < 1 || parts.length > 2 || !parts.every((p) => typeof p === "string")) return { error: "set.path must be a key or [key, entry]" };
      if (!(WRITABLE_KEYS as readonly string[]).includes(parts[0])) return { error: `"${parts[0]}" cannot be written (read-only or unknown)` };
      if (parts.length === 2 && !isObj((state as unknown as Record<string, unknown>)[parts[0]]) && parts[0] !== "namedViews") return { error: `"${parts[0]}" has no entries to set one of` };
      return [{ op: "set", path: parts as SetOp["path"], value: clone(op.value) }];
    }
    case "camera":
      return [{ op: "set", path: ["camera"], value: clone(op.camera) }];
    case "select":
      return [{ op: "set", path: ["selection"], value: clone(op.selection ?? {}) }];
    case "highlight":
      return [{ op: "set", path: ["highlight"], value: clone(op.paths) }];
    case "isolate":
      return [{ op: "set", path: ["isolation"], value: op.paths === null ? null : clone(op.paths) }];
    case "hide": {
      if (!Array.isArray(op.paths)) return { error: "hide.paths must be a list of instance paths" };
      const now = new Set(state.visibility.hidden);
      for (const p of op.paths) op.hidden === false ? now.delete(p) : now.add(p);
      return [{ op: "set", path: ["visibility", "hidden"], value: [...now] }];
    }
    case "explode":
      return [{ op: "set", path: ["explode"], value: { t: op.t, step: op.step ?? null } }];
    case "section":
      return [{ op: "set", path: ["sections"], value: clone(op.sections) }];
    case "saveView": {
      if (!validName(op.name)) return { error: "saveView needs a name of 1 to 80 characters" };
      const view: NamedView | undefined = op.view
        ? clone(op.view)
        : state.camera
          ? { camera: clone(state.camera), explode: clone(state.explode), sections: clone(state.sections), hidden: [...state.visibility.hidden], isolation: state.isolation ? [...state.isolation] : null }
          : undefined;
      if (!view) return { error: "saveView: the view has no camera yet (nothing is drawn)" };
      return [{ op: "set", path: ["namedViews", op.name], value: view }];
    }
    case "deleteView":
      if (!state.namedViews[op.name]) return { error: `no named view "${op.name}"` };
      return [{ op: "set", path: ["namedViews", op.name], value: undefined }];
    case "applyView": {
      const v = state.namedViews[op.name];
      if (!v) return { error: `no named view "${op.name}"` };
      const out: SetOp[] = [{ op: "set", path: ["camera"], value: clone(v.camera) }];
      if (v.explode) out.push({ op: "set", path: ["explode"], value: clone(v.explode) as ExplodeState });
      if (v.sections) out.push({ op: "set", path: ["sections"], value: clone(v.sections) });
      if (v.hidden) out.push({ op: "set", path: ["visibility", "hidden"], value: [...v.hidden] });
      if (v.isolation !== undefined) out.push({ op: "set", path: ["isolation"], value: v.isolation ? [...v.isolation] : null });
      return out;
    }
    default:
      return { error: `unknown op "${(raw as { op: string }).op}" (known: ${VIEW_OPS.join(", ")})` };
  }
}

/** The key a write touches, for versions and preconditions: the top-level key, or `namedViews.<name>` for one view. */
export const versionKey = (op: SetOp): string => (op.path[0] === "namedViews" && op.path.length === 2 ? `namedViews.${op.path[1]}` : op.path[0]);

export interface Applied {
  state: ViewState;
  /** The operations that put back what these replaced (in the order to apply them). */
  inverse: SetOp[];
  /** Keys whose value changed (`versionKey`). */
  changed: string[];
}

/**
 * Applies `set` operations to a state (a new object; the input is not
 * changed). Every touched top-level value is checked after the writes; one
 * bad value refuses the whole list (nothing is partly applied).
 */
export function applySets(state: ViewState, sets: SetOp[]): Applied | { error: string } {
  const next = { ...state } as unknown as Record<string, unknown>;
  const inverse: SetOp[] = [];
  const touched = new Set<WritableKey>();
  const changed: string[] = [];
  for (const s of sets) {
    const [key, entry] = s.path;
    const before = next[key];
    if (entry === undefined) {
      inverse.unshift({ op: "set", path: [key], value: clone(before) });
      next[key] = clone(s.value);
    } else {
      const obj = { ...((before as Record<string, unknown>) ?? {}) };
      inverse.unshift({ op: "set", path: [key, entry], value: clone(obj[entry]) });
      if (s.value === undefined) delete obj[entry];
      else obj[entry] = clone(s.value);
      next[key] = obj;
    }
    touched.add(key);
    const vk = versionKey(s);
    if (!same(entry === undefined ? before : (before as Record<string, unknown> | undefined)?.[entry], s.value) && !changed.includes(vk)) changed.push(vk);
  }
  for (const key of touched) {
    const e = checkValue(key, next[key]);
    if (e) return { error: e };
  }
  return { state: next as unknown as ViewState, inverse, changed };
}

/** Expands and applies verbs in order (each sees the one before); the first that cannot run refuses them all. */
export function applyOps(state: ViewState, ops: unknown[]): (Applied & { sets: SetOp[] }) | { error: string; index: number } {
  let s = state;
  const sets: SetOp[] = [];
  const inverse: SetOp[] = [];
  const changed: string[] = [];
  for (let i = 0; i < ops.length; i++) {
    const x = expandOp(s, ops[i]);
    if ("error" in x) return { error: x.error, index: i };
    const r = applySets(s, x);
    if ("error" in r) return { error: r.error, index: i };
    s = r.state;
    sets.push(...x);
    inverse.unshift(...r.inverse);
    for (const c of r.changed) if (!changed.includes(c)) changed.push(c);
  }
  return { state: s, sets, inverse, changed };
}

/** A fresh state's values for the keys a scope keeps of its own (live keys), for a scope seen for the first time. */
export const freshLive = (scope: string) => {
  const d = defaultViewState(scope);
  return { camera: d.camera, selection: d.selection, highlight: d.highlight, isolation: d.isolation, sections: d.sections, explode: d.explode };
};
