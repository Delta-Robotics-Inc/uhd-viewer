/**
 * The view-state store (PB-1178) and the first slice of the collaboration
 * design (review-round-1/round-2-notes/multi-agent-collaboration.md D3-D5):
 *
 * - one mutable `ViewState`; every write goes through `dispatch` (the view's
 *   own gestures: last writer wins) or `applyBatch` (an agent, a host, the
 *   live-tab bridge: checked first, applied whole or not at all);
 * - an op log: each committed write appends `{seq, actor, batchId, label,
 *   ops, inverse}`; `seq` is the document version and rises with every
 *   entry; each top-level key (and each named view) has a version of its
 *   own that rises when its value changes;
 * - preconditions: a batch may carry `expectSeq` (it read the whole state
 *   at that seq) or `expectVersions` (the keys it read); a stale one is
 *   refused with what it missed, never applied on top;
 * - a resent `batchId` returns the first reply instead of applying twice.
 *
 * A gesture repeated within a moment (a camera drag reports every few
 * frames) replaces its own last entry with a new seq instead of piling up:
 * seq numbers may then have gaps, and `missed` lists only the entries kept.
 */
import { applyOps, applySets, freshLive, type SetOp } from "./ops";
import { LIVE_KEYS, READ_ONLY_KEYS, clone, defaultViewState, same, type LiveKey, type ViewState } from "./schema";
import type { Actor, Batch, BatchReply, MissedEntry } from "../../api";

export type { Actor, Batch, BatchReply, MissedEntry };

export const HUMAN: Actor = { kind: "human", id: "user" };
export const SYSTEM: Actor = { kind: "system", id: "view" };

export interface OpLogEntry {
  seq: number;
  time: number;
  actor: Actor;
  batchId?: string;
  /** 3 to 8 words: what the batch does. */
  label: string;
  /** The `set` operations applied. */
  ops: SetOp[];
  /** What puts back the values they replaced. */
  inverse: SetOp[];
  /** The version keys whose value changed. */
  keys: string[];
  /** The seq the writer had read (a batch's `expectSeq`), when it said. */
  baseSeq?: number;
}

/** A write from outside the view: an agent through the bridge, a host. */
export interface StoreChange {
  state: ViewState;
  prev: ViewState;
  /** Where the change came from: "view" (the 3D view's own gestures), "bridge", "host", "restore", "scope", "facts", "url". */
  source: string;
  entry?: OpLogEntry;
}

export interface ViewStore {
  get(): ViewState;
  /** The document version: the last entry's seq (0: nothing committed yet). */
  readonly seq: number;
  versions(): Record<string, number>;
  subscribe(listener: (change: StoreChange) => void): () => void;
  /**
   * The view's own writes (a click, a toggle, a camera move): applied as
   * they come, last writer wins. `gesture` names a repeated gesture whose
   * entries replace each other while it lasts.
   */
  dispatch(ops: unknown[], meta?: { actor?: Actor; label?: string; gesture?: string; source?: string }): OpLogEntry | { error: string } | null;
  /** A checked write from outside (the bridge, a host): preconditions, validation, the whole batch or nothing. */
  applyBatch(batch: Batch, actor: Actor, source?: string): BatchReply;
  /** The entries after `since` (all kept, without it). */
  log(since?: number): OpLogEntry[];
  /** Read-only facts the view reports (scope is set by `enterScope`): no log entry, no seq. */
  setFacts(patch: Partial<Pick<ViewState, "loading" | "quality">>): void;
  /**
   * The view now shows `scope`: the live keys of the scope it showed are kept
   * aside, and the new scope's come back (kept from before, else restored
   * from a saved file, else fresh). Logged as a system entry.
   */
  enterScope(scope: string): void;
  /**
   * Saved live state per scope (`.protoboard/local/viewer-state.json`, a
   * webview's own state): the current scope's is applied now, the others
   * when the view shows them. Values a writer already set this session win.
   */
  restore(byScope: Record<string, Partial<Pick<ViewState, LiveKey>>>, source?: string): void;
  /** Every scope's live keys (the current one as it is now): what the host saves. */
  liveByScope(): Record<string, Partial<Pick<ViewState, LiveKey>>>;
}

const SCOPED: LiveKey[] = ["camera", "selection", "highlight", "isolation", "sections", "explode"];
/** Entries kept in memory; older ones drop (a batch older than that is refused as stale with what is left). */
const LOG_CAP = 1000;
const REPLY_CAP = 256;
/** Gesture entries closer than this replace each other. */
const GESTURE_MS = 1500;

const pick = (s: ViewState, keys: readonly LiveKey[]) => Object.fromEntries(keys.map((k) => [k, clone(s[k])])) as Partial<Pick<ViewState, LiveKey>>;

export function createViewStore(initial: Partial<ViewState> = {}, options: { now?: () => number } = {}): ViewStore {
  const now = options.now ?? (() => Date.now());
  let state: ViewState = { ...defaultViewState(initial.scope ?? ""), ...clone(initial) };
  let seq = 0;
  const versions: Record<string, number> = {};
  /** The entry that last changed each version key. */
  const lastBy: Record<string, OpLogEntry> = {};
  let entries: OpLogEntry[] = [];
  const replies = new Map<string, BatchReply>();
  const listeners = new Set<(c: StoreChange) => void>();
  /** Live keys of scopes not shown now. */
  const stash = new Map<string, Partial<Pick<ViewState, LiveKey>>>();
  /** Saved live keys not applied yet, per scope. */
  let saved: Record<string, Partial<Pick<ViewState, LiveKey>>> = {};
  /** Keys written this session per scope (a saved file does not override them). */
  const written = new Map<string, Set<string>>();
  let lastGesture: { name: string; actor: string; at: number } | undefined;

  const emit = (prev: ViewState, source: string, entry?: OpLogEntry) => {
    for (const l of [...listeners]) {
      try {
        l({ state, prev, source, ...(entry ? { entry } : {}) });
      } catch (e) {
        console.error("[view-state] a listener failed", e);
      }
    }
  };
  const markWritten = (keys: string[]) => {
    const set = written.get(state.scope) ?? new Set<string>();
    for (const k of keys) set.add(k.split(".")[0]);
    written.set(state.scope, set);
  };

  /** Commit applied writes: versions, log, listeners. */
  const commit = (prev: ViewState, next: ViewState, sets: SetOp[], inverse: SetOp[], changed: string[], meta: { actor: Actor; label: string; batchId?: string; baseSeq?: number; gesture?: string; source: string }): OpLogEntry => {
    state = next;
    // a repeated gesture replaces its own last entry (its inverse stays the first one's)
    let replaced: OpLogEntry | undefined;
    const t = now();
    if (meta.gesture && lastGesture && lastGesture.name === meta.gesture && lastGesture.actor === meta.actor.id && t - lastGesture.at < GESTURE_MS && entries.length && entries[entries.length - 1].label === meta.label && entries[entries.length - 1].actor.id === meta.actor.id) {
      replaced = entries.pop();
    }
    seq++;
    const entry: OpLogEntry = {
      seq,
      time: t,
      actor: { ...meta.actor },
      ...(meta.batchId ? { batchId: meta.batchId } : {}),
      label: meta.label,
      ops: replaced ? mergeSets(replaced.ops, sets) : sets,
      inverse: replaced ? replaced.inverse : inverse,
      keys: replaced ? [...new Set([...replaced.keys, ...changed])] : changed,
      ...(meta.baseSeq !== undefined ? { baseSeq: meta.baseSeq } : {}),
    };
    entries.push(entry);
    if (entries.length > LOG_CAP) entries = entries.slice(-LOG_CAP);
    for (const k of changed) versions[k] = (versions[k] ?? 0) + 1;
    for (const k of entry.keys) lastBy[k] = entry;
    lastGesture = meta.gesture ? { name: meta.gesture, actor: meta.actor.id, at: t } : undefined;
    markWritten(changed);
    emit(prev, meta.source, entry);
    return entry;
  };

  const missedSince = (from: number): MissedEntry[] => entries.filter((e) => e.seq > from).map((e) => ({ seq: e.seq, actor: e.actor, ...(e.batchId ? { batchId: e.batchId } : {}), label: e.label, keys: e.keys }));

  const remember = (batchId: string, reply: BatchReply) => {
    replies.set(batchId, reply);
    if (replies.size > REPLY_CAP) replies.delete(replies.keys().next().value as string);
    return reply;
  };

  const applyScopeValues = (values: Partial<Pick<ViewState, LiveKey>>, label: string, source: string, actor: Actor = SYSTEM) => {
    const sets: SetOp[] = Object.entries(values)
      .filter(([k]) => (LIVE_KEYS as readonly string[]).includes(k))
      .map(([k, v]) => ({ op: "set", path: [k as LiveKey], value: v }));
    if (!sets.length) return;
    const prev = state;
    const r = applySets(state, sets);
    if ("error" in r) {
      console.warn(`[view-state] ${label}: ${r.error}; left as it was`);
      return;
    }
    if (!r.changed.length) {
      state = r.state;
      return;
    }
    commit(prev, r.state, sets, r.inverse, r.changed, { actor, label, source });
  };

  const store: ViewStore = {
    get: () => state,
    get seq() {
      return seq;
    },
    versions: () => ({ ...versions }),
    subscribe(l) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    dispatch(ops, meta = {}) {
      const actor = meta.actor ?? HUMAN;
      const r = applyOps(state, ops);
      if ("error" in r) return { error: r.error };
      if (!r.changed.length) return null;
      const label = meta.label ?? describe(r.sets);
      return commit(state, r.state, r.sets, r.inverse, r.changed, { actor, label, ...(meta.gesture ? { gesture: meta.gesture } : {}), source: meta.source ?? "view" });
    },
    applyBatch(batch, actor, source = "bridge") {
      const id = typeof batch?.batchId === "string" ? batch.batchId : "";
      const hit = id ? replies.get(id) : undefined;
      if (hit) return { ...hit, duplicate: true };
      const invalid = (error: string, index?: number): BatchReply => ({ status: "invalid", batchId: id, seq, error, ...(index !== undefined ? { index } : {}) });
      // 200: the bridge qualifies an agent's id (up to 128) by its session ("<session>:<batchId>")
      if (!id || id.length > 200 || !/^[\w.:-]+$/.test(id)) return invalid("batchId must be 1 to 200 letters, digits, '.', ':', '_' or '-'");
      const words = typeof batch.label === "string" ? batch.label.trim().split(/\s+/).filter(Boolean).length : 0;
      if (words < 3 || words > 8 || (batch.label as string).length > 120) return remember(id, invalid("label must be 3 to 8 words"));
      if (!Array.isArray(batch.ops) || batch.ops.length > 200) return remember(id, invalid("ops must be a list of at most 200 operations"));
      // preconditions first: a stale writer learns what it missed before anything else
      if (batch.expectSeq !== undefined) {
        if (!Number.isInteger(batch.expectSeq) || batch.expectSeq < 0) return remember(id, invalid("expectSeq must be a seq number"));
        if (batch.expectSeq !== seq) {
          return remember(id, { status: "refused", batchId: id, seq, reason: "stale-seq", missed: { from: batch.expectSeq + 1, to: seq, entries: missedSince(batch.expectSeq) } });
        }
      }
      if (batch.expectVersions !== undefined) {
        if (!batch.expectVersions || typeof batch.expectVersions !== "object" || Object.values(batch.expectVersions).some((v) => !Number.isInteger(v))) return remember(id, invalid("expectVersions must map keys to version numbers"));
        const conflicts = Object.entries(batch.expectVersions)
          .filter(([k, v]) => (versions[k] ?? 0) !== v)
          .map(([k, v]) => {
            const [top, entry] = k.startsWith("namedViews.") ? ["namedViews", k.slice("namedViews.".length)] : [k, undefined];
            const value = entry !== undefined ? (state.namedViews[entry] ?? null) : ((state as unknown as Record<string, unknown>)[top] ?? null);
            return { key: k, expected: v, current: versions[k] ?? 0, value: clone(value), ...(lastBy[k] ? { by: lastBy[k].actor, seq: lastBy[k].seq } : {}) };
          });
        if (conflicts.length) {
          const from = Math.min(...conflicts.map((c) => c.seq ?? seq));
          return remember(id, { status: "refused", batchId: id, seq, reason: "stale-versions", missed: { from, to: seq, entries: missedSince(from - 1).filter((e) => e.keys.some((k) => conflicts.some((c) => c.key === k))) }, conflicts });
        }
      }
      const withState = batch.state !== false;
      if (!batch.ops.length) return remember(id, { status: "read", batchId: id, seq, versions: { ...versions }, ...(withState ? { state: clone(state) } : {}) });
      const r = applyOps(state, batch.ops);
      if ("error" in r) return remember(id, invalid(r.error, r.index));
      if (r.changed.length) commit(state, r.state, r.sets, r.inverse, r.changed, { actor, label: batch.label.trim(), batchId: id, ...(batch.expectSeq !== undefined ? { baseSeq: batch.expectSeq } : {}), source });
      else state = r.state;
      return remember(id, { status: "applied", batchId: id, seq, applied: r.sets, changed: r.changed, versions: { ...versions }, ...(withState ? { state: clone(state) } : {}) });
    },
    log: (since) => (since === undefined ? [...entries] : entries.filter((e) => e.seq > since)),
    setFacts(patch) {
      const prev = state;
      const next = { ...state };
      let any = false;
      for (const k of ["loading", "quality"] as const) {
        if (patch[k] !== undefined && !same(patch[k], state[k])) {
          (next as Record<string, unknown>)[k] = clone(patch[k]);
          any = true;
        }
      }
      if (!any) return;
      state = next;
      emit(prev, "facts");
    },
    enterScope(scope) {
      if (scope === state.scope) return;
      stash.set(state.scope, pick(state, SCOPED));
      const prev = state;
      state = { ...state, scope };
      const kept = stash.get(scope);
      const values = { ...freshLive(scope), ...(saved[scope] ?? {}), ...(kept ?? {}) };
      if (saved[scope]) delete saved[scope];
      emit(prev, "scope");
      applyScopeValues(values, `show ${scope || "the whole assembly"}`, "scope");
    },
    restore(byScope, source = "restore") {
      if (!byScope || typeof byScope !== "object") return;
      saved = { ...saved };
      for (const [scope, values] of Object.entries(byScope)) {
        if (!values || typeof values !== "object") continue;
        const done = written.get(scope) ?? new Set<string>();
        const fresh = Object.fromEntries(Object.entries(values).filter(([k]) => (LIVE_KEYS as readonly string[]).includes(k) && !done.has(k))) as Partial<Pick<ViewState, LiveKey>>;
        if (scope === state.scope) {
          // visibility and direction are the user's for every scope; the current scope's take them
          applyScopeValues(fresh, "restore the saved view", source);
        } else {
          // only the keys a scope keeps of its own; visibility and direction follow the user
          saved[scope] = Object.fromEntries(Object.entries(fresh).filter(([k]) => (SCOPED as string[]).includes(k)));
        }
      }
    },
    liveByScope() {
      const out: Record<string, Partial<Pick<ViewState, LiveKey>>> = {};
      for (const [s, v] of Object.entries(saved)) out[s] = clone(v);
      for (const [s, v] of stash) out[s] = clone(v);
      out[state.scope] = pick(state, LIVE_KEYS);
      return out;
    },
  };
  return store;
}

/** Later writes to the same path win; others are kept, in order. */
function mergeSets(a: SetOp[], b: SetOp[]): SetOp[] {
  const key = (s: SetOp) => s.path.join("\u0000");
  const out = new Map<string, SetOp>();
  for (const s of [...a, ...b]) {
    out.delete(key(s));
    out.set(key(s), s);
  }
  return [...out.values()];
}

/** A label for the view's own writes ("set camera", "set selection, explode"). */
function describe(sets: SetOp[]): string {
  const keys = [...new Set(sets.map((s) => s.path[0]))];
  return `set ${keys.join(", ")}`;
}

/** Keys only the view sets; a write naming them is refused (./ops.ts). */
export const readOnlyKeys = READ_ONLY_KEYS;
