/**
 * The view's typed write verbs (collaboration D3: no code evaluation) and the
 * pure reducer under them. Every verb expands to `set` operations on one
 * top-level key (or one entry of it); applying them gives the new state and
 * the inverse (the values they replaced), so an undo is just another batch.
 *
 * Annotations (W3-B's records) are addressed per record: a `set` on
 * `["annotations", <id>]` puts in, replaces or (value undefined) removes the
 * record with that id, so each record has a version of its own
 * (`annotations.<id>`, PB-1196 "per-node versions"). The `annotate` verb makes
 * a record from typed fields; its id is issued by the store (the owner), never
 * chosen by the writer: a writer names its new record by a temporary `handle`
 * and the reply maps the handle to the id (collaboration D2).
 *
 * The lease and undo verbs (`claim`, `release`, `undo`) are the store's own
 * (./store.ts): they are not view state and never reach this reducer.
 */
import type { SetOp } from "../../api";
import { parseRecord } from "../annot/record";
import { WRITABLE_KEYS, checkValue, clone, defaultViewState, same, validName, type CameraState, type ExplodeState, type NamedView, type SectionPlane, type ViewSelection, type ViewState, type WritableKey } from "./schema";

export type { SetOp };

/** The fields an `annotate` verb may set (W3-B's record without id and author: those come from the store). */
export interface AnnotateFields {
  kind?: "callout" | "mark" | "arrow";
  ref?: string;
  point?: [number, number, number];
  to?: string;
  toPoint?: [number, number, number];
  shape?: string;
  title?: string;
  rows?: [string, string][];
  text?: string;
  tone?: string;
  visibility?: "on" | "hover" | "off";
  n?: number;
}

export type ViewOp =
  | SetOp
  | { op: "camera"; camera: CameraState }
  | { op: "select"; selection: ViewSelection }
  | { op: "highlight"; paths: string[] }
  | { op: "isolate"; paths: string[] | null }
  | { op: "hide"; paths: string[]; hidden?: boolean }
  | { op: "explode"; t: number; step?: string | null }
  | { op: "section"; sections: SectionPlane[] }
  | { op: "saveView"; name: string; view?: NamedView }
  | { op: "deleteView"; name: string }
  | { op: "applyView"; name: string }
  /** A new record (`handle`: the writer's name for it, mapped to the issued id in the reply), or a change to one (`id`). */
  | ({ op: "annotate"; handle?: string; id?: string } & AnnotateFields)
  | { op: "unannotate"; ids: string[] };

export const VIEW_OPS = ["set", "camera", "select", "highlight", "isolate", "hide", "explode", "section", "saveView", "deleteView", "applyView", "annotate", "unannotate"] as const;
/** The store's own verbs (leases and undo): one per batch, alone. */
export const STORE_OPS = ["claim", "release", "undo"] as const;

/** What the store lends the reducer for verbs that need the owner: issuing ids, naming the author. */
export interface OpContext {
  /** A new id, never used before in this view (the owner issues it). */
  issueId?: () => string;
  /** The author written into a record (`agent:<name>`, `user`, `host:<name>`). */
  author?: string;
  /** Out: handles mapped to the ids issued. */
  ids?: Record<string, string>;
  /**
   * Stamp `author` on every record a `set` writes (gate 3): an agent's batch cannot write a record that reads as
   * the person's (`author: "user"`) or another agent's; only the `annotate` verb stamped it before.
   */
  forceAuthor?: boolean;
}

/** Entry names that reach an object's prototype: never an entry of a keyed value (gate 3). */
const PROTO_KEYS = ["__proto__", "constructor", "prototype"];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const HANDLE = /^[\w.:-]{1,64}$/;

/** The record with `id` in an annotations list, or undefined. */
export const annotationById = (list: unknown[], id: string): Record<string, unknown> | undefined => list.find((x) => isObj(x) && x.id === id) as Record<string, unknown> | undefined;

/**
 * The `set` operations a verb stands for against `state`, or the reason it
 * cannot run. Nothing is applied here (an `annotate` with a handle takes an id
 * from `ctx.issueId`).
 */
export function expandOp(state: ViewState, raw: unknown, ctx: OpContext = {}): SetOp[] | { error: string } {
  if (!isObj(raw) || typeof raw.op !== "string") return { error: "an op needs an `op` name" };
  const op = raw as ViewOp;
  switch (op.op) {
    case "set": {
      const path = op.path as unknown;
      const parts = typeof path === "string" ? (path.includes(".") ? [path.slice(0, path.indexOf(".")), path.slice(path.indexOf(".") + 1)] : [path]) : path;
      if (!Array.isArray(parts) || parts.length < 1 || parts.length > 2 || !parts.every((p) => typeof p === "string")) return { error: "set.path must be a key or [key, entry]" };
      if (!(WRITABLE_KEYS as readonly string[]).includes(parts[0])) return { error: `"${parts[0]}" cannot be written (read-only or unknown)` };
      if (parts.length === 2 && !isObj((state as unknown as Record<string, unknown>)[parts[0]]) && parts[0] !== "namedViews" && parts[0] !== "annotations" && parts[0] !== "placements") return { error: `"${parts[0]}" has no entries to set one of` };
      if (parts.length === 2 && parts[0] === "annotations" && op.value !== undefined && !(isObj(op.value) && op.value.id === parts[1])) return { error: `set annotations.${parts[1]}: the record's id must be "${parts[1]}"` };
      if (parts.length === 2 && PROTO_KEYS.includes(parts[1] as string)) return { error: `set ${parts[0]}.${parts[1]}: not an entry name` };
      let value = clone(op.value);
      if (parts[0] === "annotations" && ctx.forceAuthor && ctx.author) {
        const stamp = (r: unknown) => (isObj(r) ? { ...r, author: ctx.author } : r);
        value = parts.length === 2 ? (value === undefined ? value : stamp(value)) : Array.isArray(value) ? value.map(stamp) : value;
      }
      return [{ op: "set", path: parts as SetOp["path"], value }];
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
    case "annotate":
      return expandAnnotate(state, op, ctx);
    case "unannotate": {
      if (!Array.isArray(op.ids) || !op.ids.length || !op.ids.every((x) => typeof x === "string")) return { error: "unannotate.ids must list the ids of records to remove" };
      const out: SetOp[] = [];
      for (const id of op.ids) {
        if (!annotationById(state.annotations, id)) return { error: `no annotation "${id}"` };
        out.push({ op: "set", path: ["annotations", id], value: undefined });
      }
      return out;
    }
    default:
      return { error: `unknown op "${(raw as { op: string }).op}" (known: ${VIEW_OPS.join(", ")}; alone in a batch: ${STORE_OPS.join(", ")})` };
  }
}

const ANNOTATE_FIELDS = ["kind", "ref", "point", "to", "toPoint", "shape", "title", "rows", "text", "tone", "visibility", "n"] as const;

/** `annotate`: a new record with an issued id, or fields changed on an existing one; normalised by W3-B's parser. */
function expandAnnotate(state: ViewState, op: { handle?: string; id?: string } & AnnotateFields, ctx: OpContext): SetOp[] | { error: string } {
  const fields = Object.fromEntries(ANNOTATE_FIELDS.filter((k) => (op as Record<string, unknown>)[k] !== undefined).map((k) => [k, clone((op as Record<string, unknown>)[k])]));
  const author = ctx.author ?? "user";
  let base: Record<string, unknown>;
  if (op.id !== undefined) {
    if (typeof op.id !== "string") return { error: "annotate.id must be the id of an existing record" };
    const have = annotationById(state.annotations, op.id);
    if (!have) return { error: `no annotation "${op.id}" (to make a new one, give a handle instead of an id)` };
    // the last writer's name goes with the text it wrote (collaboration D12: text carries its author)
    base = { ...clone(have), ...fields, id: op.id, author };
  } else {
    if (op.handle !== undefined && (typeof op.handle !== "string" || !HANDLE.test(op.handle))) return { error: "annotate.handle must be 1 to 64 letters, digits, '.', ':', '_' or '-'" };
    if (!ctx.issueId) return { error: "annotate: this writer cannot create records (no owner to issue an id)" };
    if (!fields.kind) return { error: "annotate needs kind: callout, mark or arrow" };
    if (typeof fields.ref !== "string") return { error: "annotate needs ref: the instance path it points at" };
    const id = ctx.issueId();
    if (op.handle && ctx.ids) ctx.ids[op.handle] = id;
    base = { ...(fields.kind === "mark" && fields.shape === undefined ? { shape: "ring" } : {}), ...fields, id, author };
  }
  const parsed = parseRecord(base);
  if ("error" in parsed) return { error: `annotate: ${parsed.error}` };
  return [{ op: "set", path: ["annotations", parsed.record.id], value: parsed.record }];
}

/** The key a write touches, for versions and preconditions: the top-level key, or `namedViews.<name>` / `annotations.<id>` for one entry. */
export const versionKey = (op: SetOp): string => (op.path.length === 2 && (op.path[0] === "namedViews" || op.path[0] === "annotations" || op.path[0] === "placements") ? `${op.path[0]}.${op.path[1]}` : op.path[0]);

export interface Applied {
  state: ViewState;
  /** The operations that put back what these replaced (in the order to apply them). */
  inverse: SetOp[];
  /** Keys whose value changed (`versionKey`; for annotations also `annotations` itself). */
  changed: string[];
}

const idsOf = (list: unknown): Map<string, string> => new Map((Array.isArray(list) ? list : []).filter((x) => isObj(x) && typeof x.id === "string").map((x) => [(x as { id: string }).id, JSON.stringify(x)]));

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
  const mark = (k: string) => {
    if (!changed.includes(k)) changed.push(k);
  };
  for (const s of sets) {
    const [key, entry] = s.path;
    const before = next[key];
    if (key === "annotations") {
      const list = Array.isArray(before) ? [...before] : [];
      if (entry === undefined) {
        inverse.unshift({ op: "set", path: [key], value: clone(list) });
        next[key] = clone(s.value);
        // a whole-list write changes the records whose JSON differs: each one's version moves
        const a = idsOf(list);
        const b = idsOf(s.value);
        for (const id of new Set([...a.keys(), ...b.keys()])) if (a.get(id) !== b.get(id)) mark(`annotations.${id}`);
        if (!same(list, s.value)) mark("annotations");
      } else {
        const i = list.findIndex((x) => isObj(x) && x.id === entry);
        const old = i >= 0 ? list[i] : undefined;
        inverse.unshift({ op: "set", path: [key, entry], value: clone(old) });
        if (s.value === undefined) {
          if (i >= 0) list.splice(i, 1);
        } else if (i >= 0) list[i] = clone(s.value);
        else list.push(clone(s.value));
        next[key] = list;
        if (!same(old, s.value)) {
          mark(`annotations.${entry}`);
          mark("annotations");
        }
      }
      touched.add(key);
      continue;
    }
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
    if (!same(entry === undefined ? before : (before as Record<string, unknown> | undefined)?.[entry], s.value)) mark(versionKey(s));
  }
  for (const key of touched) {
    const e = checkValue(key, next[key]);
    if (e) return { error: e };
  }
  return { state: next as unknown as ViewState, inverse, changed };
}

/** Expands and applies verbs in order (each sees the one before); the first that cannot run refuses them all. */
export function applyOps(state: ViewState, ops: unknown[], ctx: OpContext = {}): (Applied & { sets: SetOp[] }) | { error: string; index: number } {
  let s = state;
  const sets: SetOp[] = [];
  const inverse: SetOp[] = [];
  const changed: string[] = [];
  for (let i = 0; i < ops.length; i++) {
    const x = expandOp(s, ops[i], ctx);
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
