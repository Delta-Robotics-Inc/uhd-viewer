/**
 * The view-state store (PB-1178) and the collaboration design's first slice
 * (review-round-1/round-2-notes/multi-agent-collaboration.md D2-D9; PB-1196):
 *
 * - one mutable `ViewState`; every write goes through `dispatch` (the view's
 *   own gestures: last writer wins) or `applyBatch` (an agent, a host, the
 *   live-tab bridge: checked first, applied whole or not at all);
 * - an op log: each committed write appends `{seq, actor, batchId, label,
 *   ops, inverse, touched, leaseToken}`; `seq` is the document version and
 *   rises with every entry; each top-level key, each named view and each
 *   annotation record has a version of its own that rises when it changes;
 * - preconditions: a batch may carry `expectSeq` (it read the whole state
 *   at that seq) or `expectVersions` (the keys it read); a stale one is
 *   refused with what it missed, never applied on top;
 * - a resent `batchId` returns the first reply instead of applying twice;
 * - owner-issued ids (D2): an agent's new annotation gets an id from this
 *   store (`a.<epoch>.<n>`), never chosen by the writer and never reused: a
 *   removed id is retired, and a write that brings a retired id back is
 *   refused (an undo restoring its own record is the exception);
 * - leases with fencing tokens (D6, ./leases.ts): `claim`, `release`; a
 *   batch touching another actor's leased subtree is refused, a stale token
 *   is refused, and the person's edit inside a lease revokes it (DEFAULT);
 * - undo per actor (D7, DEFAULT per plan.md): `undo` appends the inverse of
 *   the actor's own last batch as a new entry, only while nothing it changed
 *   was changed again since;
 * - turn-taking (PB-1179, decisions 5 and 6; D9): an agent batch while the
 *   person is mid-gesture answers `busy` (nothing applied, nothing
 *   remembered: the bridge delivers it again); any input of the person takes
 *   the camera back, an agent may move it only after `handBackMs` (25 s,
 *   DEFAULT) without the person's input, and an agent that has not written
 *   for `handBackMs` hands the camera back;
 * - presence and intent (D8): `presence()` lists live leases, what each agent
 *   is working on and who holds the camera; every bridge reply carries it.
 *
 * A gesture repeated within a moment (a camera drag reports every few
 * frames) replaces its own last entry with a new seq instead of piling up:
 * seq numbers may then have gaps, and `missed` lists only the entries kept.
 */
import { annotationById, applyOps, applySets, freshLive, STORE_OPS, versionKey, type SetOp } from "./ops";
import { LIVE_KEYS, READ_ONLY_KEYS, clone, defaultViewState, same, type LiveKey, type ViewState } from "./schema";
import { createLeaseTable, intentsOf, touchedPaths, type LeaseTable } from "./leases";
import type { Actor, Batch, BatchReply, EndedLease, Lease, MissedEntry, Presence, RefusalReason, ViewControl } from "../../api";

export type { Actor, Batch, BatchReply, MissedEntry, Presence, ViewControl };

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
  /** Each changed key's version after this entry (an undo checks they are still these). */
  touched: Record<string, number>;
  /** The seq the writer had read (a batch's `expectSeq`), when it said. */
  baseSeq?: number;
  /** The fencing token the writer quoted. */
  leaseToken?: number;
  /** This entry undoes entry `undoOf`. */
  undoOf?: number;
  /** Entry `undoneBy` undid this one. */
  undoneBy?: number;
}

/** A write from outside the view: an agent through the bridge, a host. */
export interface StoreChange {
  state: ViewState;
  prev: ViewState;
  /** Where the change came from: "view" (the 3D view's own gestures), "bridge", "host", "restore", "scope", "facts", "url", "presence". */
  source: string;
  entry?: OpLogEntry;
}

/** A checkpoint of the store (the journal's restart point, PB-1196). */
export interface StoreCheckpoint {
  schema: "uhd-viewer.store-checkpoint/v0";
  epoch: string;
  seq: number;
  time: number;
  state: ViewState;
  versions: Record<string, number>;
  /** The next id number this epoch would issue. */
  nextId: number;
  retired: string[];
  leases: Lease[];
  fenceToken: number;
}

export interface ViewStore {
  get(): ViewState;
  /** The document version: the last entry's seq (0: nothing committed yet). */
  readonly seq: number;
  /** This store's owner epoch: issued ids carry it, and seq numbers restart when it changes (a reload). */
  readonly epoch: string;
  versions(): Record<string, number>;
  subscribe(listener: (change: StoreChange) => void): () => void;
  /**
   * The view's own writes (a click, a toggle, a camera move): applied as
   * they come, last writer wins. `gesture` names a repeated gesture whose
   * entries replace each other while it lasts. The person's edits revoke
   * agent leases they touch and take the camera back.
   */
  dispatch(ops: unknown[], meta?: { actor?: Actor; label?: string; gesture?: string; source?: string }): OpLogEntry | { error: string } | null;
  /** A checked write from outside (the bridge, a host): preconditions, leases, turn-taking, validation, the whole batch or nothing. */
  applyBatch(batch: Batch, actor: Actor, source?: string): BatchReply;
  /** Undo `actor`'s own last batch (the person's Ctrl+Z, an agent's `undo`); a reply as `applyBatch` gives. */
  undo(actor: Actor, meta?: { batchId?: string; source?: string }): BatchReply;
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
  /** Live leases, intents and who holds the camera (a hand-back that is due happens here). */
  presence(): Presence;
  /** The person is (or stops) dragging or otherwise mid-gesture: agent writes wait meanwhile. */
  setInteracting(on: boolean): void;
  /** The person takes everything back: every agent lease is revoked, the camera is theirs. */
  takeOver(by?: Actor): EndedLease[];
  /** A checkpoint for the journal. */
  checkpoint(): StoreCheckpoint;
  /** Whether a batch id was already answered (a resend gets the first reply): the bridge skips re-expanding it. */
  replied(batchId: string): boolean;
}

/** Options: the clock (tests), the turn-taking times. */
export interface StoreOptions {
  now?: () => number;
  /** DEFAULT 25 s (decisions 5 and 6, PB-1179): the user can change this. */
  handBackMs?: number;
  /** DEFAULT 600 ms: a human gesture this recent means the person is still dragging (the camera reports every 200 ms). */
  dragMs?: number;
  /** A fixed epoch (tests); default: the time and a random part. */
  epoch?: string;
  /**
   * Continue from a journal (wave 3 carry-forward; `replayJournal`): the id counter and the retired ids of the
   * epoch the journal holds, so a store restarted on the same epoch never issues or takes back an id it gave out.
   * With a different epoch the issued ids differ anyway (`a.<epoch>.<n>`); `retired` still keeps old ids out.
   */
  seed?: { nextId?: number; retired?: string[] };
}

const SCOPED: LiveKey[] = ["camera", "selection", "highlight", "isolation", "sections", "explode"];
/** Entries kept in memory; older ones drop (a batch older than that is refused as stale with what is left). DEFAULT. */
const LOG_CAP = 1000;
/** Replies remembered by batchId. DEFAULT. */
const REPLY_CAP = 256;
/** Gesture entries closer than this replace each other. DEFAULT. */
const GESTURE_MS = 1500;
/** DEFAULT (PB-1179, decisions 5 and 6). */
export const HAND_BACK_MS = 25_000;
/** DEFAULT (gate 3): a pointer held down longer than this no longer holds agents off (its pointer-up was lost). */
export const INTERACTING_STALE_MS = 30_000;
/** DEFAULT: how long a human camera gesture counts as "still dragging". */
export const DRAG_MS = 600;
/** DEFAULT: how soon the bridge delivers a `busy` batch again. */
export const BUSY_RETRY_MS = 250;
/** DEFAULT (D8): an agent's write shows as "working on" its paths this long. */
export const INTENT_MS = 30_000;
/** Retired ids remembered (beyond this the oldest are forgotten; ids still never repeat: the counter only rises). DEFAULT. */
const RETIRED_CAP = 5000;

const pick = (s: ViewState, keys: readonly LiveKey[]) => Object.fromEntries(keys.map((k) => [k, clone(s[k])])) as Partial<Pick<ViewState, LiveKey>>;
const sameActor = (a: Actor | null | undefined, b: Actor | null | undefined) => !!a && !!b && a.kind === b.kind && a.id === b.id;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const annotationIds = (list: unknown): string[] => (Array.isArray(list) ? list.filter(isObj).map((r) => r.id).filter((x): x is string => typeof x === "string") : []);

/** The author name an actor writes into a record: `agent:<name>`, `host:<id>`, `user`. */
export function authorOf(actor: Actor): string {
  if (actor.kind === "human") return "user";
  const name = (actor.name ?? actor.id.replace(/^agent:/, "")).replace(/[^\w .:-]/g, "").trim().slice(0, 40) || actor.id;
  return actor.kind === "agent" ? `agent:${name}` : `${actor.kind}:${name}`;
}

/**
 * A refusal's sentence, from owner-made facts only (collaboration D12, PB-1196): the lease id, the holder's actor id
 * (a session id the bridge minted) and the time. The holder's chosen name, its purpose and its roots are text an
 * agent wrote: they travel in `lease` as data with their author, never inside a message another agent reads.
 */
export function leasedMessage(l: Lease): string {
  return `lease ${l.id} of ${l.holder.kind} ${l.holder.id} covers a path this batch touches until ${new Date(l.expiresAt).toISOString()} (its roots and purpose are in \`lease\`, as data)`;
}

function newEpoch(now: number): string {
  let r = "";
  try {
    const a = new Uint8Array(4);
    globalThis.crypto.getRandomValues(a);
    r = [...a].map((x) => x.toString(36).padStart(2, "0")).join("").slice(0, 6);
  } catch {
    r = Math.random().toString(36).slice(2, 8);
  }
  return `${now.toString(36)}${r}`;
}

export function createViewStore(initial: Partial<ViewState> = {}, options: StoreOptions = {}): ViewStore {
  const now = options.now ?? (() => Date.now());
  const handBackMs = options.handBackMs ?? HAND_BACK_MS;
  const dragMs = options.dragMs ?? DRAG_MS;
  const epoch = options.epoch ?? newEpoch(now());
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
  /** Owner-issued ids: the counter only rises. */
  let nextId = Math.max(1, Math.floor(Number(options.seed?.nextId) || 1));
  /** Removed ids, never to come back as someone else's: id → when and by whom. */
  const retired = new Map<string, { seq: number; actor: Actor }>();
  for (const id of options.seed?.retired ?? []) if (typeof id === "string" && retired.size < RETIRED_CAP) retired.set(id, { seq: 0, actor: { ...SYSTEM } });
  const leases: LeaseTable = createLeaseTable(now);
  let interactingSince = 0;
  const control: ViewControl = { holder: null, since: now(), lastHumanAt: 0, lastAgentAt: 0, handBackMs, interacting: false };
  let lastHumanGestureAt = 0;
  /** What each agent wrote last (for intents). */
  const recent = new Map<string, { actor: Actor; roots: string[]; label: string; at: number }>();

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
  const issueId = () => `a.${epoch}.${nextId++}`;

  /** Commit applied writes: versions, log, retired ids, listeners. */
  const commit = (prev: ViewState, next: ViewState, sets: SetOp[], inverse: SetOp[], changed: string[], meta: { actor: Actor; label: string; batchId?: string; baseSeq?: number; gesture?: string; source: string; leaseToken?: number; undoOf?: number }): OpLogEntry => {
    state = next;
    // a repeated gesture replaces its own last entry (its inverse stays the first one's)
    let replaced: OpLogEntry | undefined;
    const t = now();
    if (meta.gesture && lastGesture && lastGesture.name === meta.gesture && lastGesture.actor === meta.actor.id && t - lastGesture.at < GESTURE_MS && entries.length && entries[entries.length - 1].label === meta.label && entries[entries.length - 1].actor.id === meta.actor.id) {
      replaced = entries.pop();
    }
    seq++;
    for (const k of changed) versions[k] = (versions[k] ?? 0) + 1;
    const keys = replaced ? [...new Set([...replaced.keys, ...changed])] : changed;
    const entry: OpLogEntry = {
      seq,
      time: t,
      actor: { ...meta.actor },
      ...(meta.batchId ? { batchId: meta.batchId } : {}),
      label: meta.label,
      ops: replaced ? mergeSets(replaced.ops, sets) : sets,
      inverse: replaced ? replaced.inverse : inverse,
      keys,
      touched: Object.fromEntries(keys.map((k) => [k, versions[k] ?? 0])),
      ...(meta.baseSeq !== undefined ? { baseSeq: meta.baseSeq } : {}),
      ...(meta.leaseToken !== undefined ? { leaseToken: meta.leaseToken } : {}),
      ...(meta.undoOf !== undefined ? { undoOf: meta.undoOf } : {}),
    };
    entries.push(entry);
    if (entries.length > LOG_CAP) entries = entries.slice(-LOG_CAP);
    for (const k of entry.keys) lastBy[k] = entry;
    lastGesture = meta.gesture ? { name: meta.gesture, actor: meta.actor.id, at: t } : undefined;
    // ids that left the list are retired; ids that came back (an undo) are not any more
    const before = new Set(annotationIds(prev.annotations));
    const after = new Set(annotationIds(next.annotations));
    for (const id of before) if (!after.has(id)) retired.set(id, { seq, actor: { ...meta.actor } });
    for (const id of after) retired.delete(id);
    while (retired.size > RETIRED_CAP) retired.delete(retired.keys().next().value as string);
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

  /** A due hand-back happens: the agent that held the camera and stopped writing gives it back. */
  const tick = () => {
    if (control.holder && control.holder.kind === "agent" && now() - control.lastAgentAt >= handBackMs) {
      control.holder = null;
      control.since = control.lastAgentAt + handBackMs;
      emit(state, "presence");
    }
  };
  // a pointer-down whose pointer-up never came (a lost capture, a window that lost focus) does not hold agents off
  // for ever: past INTERACTING_STALE_MS it no longer counts (gate 3)
  const interacting = () => (control.interacting && now() - interactingSince < INTERACTING_STALE_MS) || (lastHumanGestureAt > 0 && now() - lastHumanGestureAt < dragMs);

  const presence = (): Presence => {
    tick();
    const live = leases.live();
    return { epoch, seq, control: { ...control, holder: control.holder ? { ...control.holder } : null, interacting: interacting() }, leases: live, intents: intentsOf(live, [...recent.values()], now(), INTENT_MS) };
  };

  /** Every reply carries the epoch and presence (D8). */
  const withExtras = (r: BatchReply): BatchReply => ({ ...r, epoch, presence: presence() }) as BatchReply;

  /** The person's input: the camera is theirs, and their edits revoke agent leases they touch. */
  const humanInput = (sets: SetOp[], prev: ViewState, label: string, gesture?: string) => {
    const t = now();
    control.lastHumanAt = t;
    if (gesture) lastHumanGestureAt = t;
    const hadAgent = control.holder?.kind === "agent";
    control.holder = null;
    if (hadAgent) control.since = t;
    const paths = touchedPaths(sets, prev as unknown as Record<string, unknown>);
    const revoked = paths.length ? leases.revokeCovering(paths, HUMAN, `the person changed ${paths.map((p) => p || "the whole assembly").slice(0, 3).join(", ")} (${label})`) : [];
    if (hadAgent || revoked.length) emit(state, "presence");
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

  /** Ids a write brings back after they were retired (a newcomer must never take an old id). */
  const reborn = (prev: ViewState, next: ViewState): string[] => {
    const before = new Set(annotationIds(prev.annotations));
    return annotationIds(next.annotations).filter((id) => !before.has(id) && retired.has(id));
  };

  const refused = (id: string, reason: RefusalReason, rest: Partial<Extract<BatchReply, { status: "refused" }>> = {}): BatchReply => ({ status: "refused", batchId: id, seq, reason, missed: { from: seq + 1, to: seq, entries: [] }, ...rest }) as BatchReply;

  const undo = (actor: Actor, id: string, source: string, leaseToken?: number): BatchReply => {
    const e = [...entries].reverse().find((x) => sameActor(x.actor, actor) && x.ops.length && x.undoneBy === undefined && x.undoOf === undefined);
    if (!e) return refused(id, "nothing-to-undo", { message: "nothing of yours is left to undo in this view (the log keeps the last 1000 entries)" });
    const conflicts = Object.entries(e.touched)
      .filter(([k, v]) => (versions[k] ?? 0) !== v)
      .map(([k, v]) => ({ key: k, expected: v, current: versions[k] ?? 0, value: valueAt(k), ...(lastBy[k] ? { by: lastBy[k].actor, seq: lastBy[k].seq } : {}) }));
    if (conflicts.length) {
      const from = Math.min(...conflicts.map((c) => c.seq ?? seq));
      return refused(id, "stale-undo", { message: `your batch at seq ${e.seq} cannot be undone: what it changed was changed again since (see conflicts)`, missed: { from, to: seq, entries: missedSince(from - 1) }, conflicts });
    }
    const r = applySets(state, e.inverse);
    if ("error" in r) return { status: "invalid", batchId: id, seq, error: `undo: ${r.error}` };
    // an undo is a write like any other (gate 3): another's lease blocks it, a revoked or stale token of one's own
    // refuses it, and an agent's undo does not move the camera the person holds
    if (actor.kind === "agent" || actor.kind === "host") {
      const paths = touchedPaths(e.inverse, state as unknown as Record<string, unknown>);
      const other = leases.blocking(actor, paths);
      if (other) return refused(id, "leased", { lease: other, message: leasedMessage(other) });
      const fenced = leases.fence(actor, paths, leaseToken);
      if (fenced) return refused(id, fenced.reason, { ...(fenced.lease ? { lease: fenced.lease } : {}), message: fenced.message });
    }
    if (actor.kind === "agent" && e.inverse.some((s) => s.path[0] === "camera")) {
      tick();
      const until = control.lastHumanAt + handBackMs;
      if (control.lastHumanAt > 0 && now() < until) return refused(id, "view-held", { until, message: `the person used the view ${Math.round((now() - control.lastHumanAt) / 1000)} s ago; the camera is theirs until ${new Date(until).toISOString()}` });
    }
    if (!r.changed.length) return { status: "applied", batchId: id, seq, applied: [], changed: [], versions: { ...versions } };
    const entry = commit(state, r.state, e.inverse, e.ops, r.changed, { actor, label: `undo: ${e.label}`.slice(0, 120), batchId: id || undefined, source, undoOf: e.seq });
    e.undoneBy = entry.seq;
    return { status: "applied", batchId: id, seq, applied: e.inverse, changed: r.changed, versions: { ...versions } };
  };

  const valueAt = (k: string): unknown => {
    if (k.startsWith("namedViews.")) return clone(state.namedViews[k.slice("namedViews.".length)] ?? null);
    if (k.startsWith("annotations.")) return clone(annotationById(state.annotations, k.slice("annotations.".length)) ?? null);
    return clone((state as unknown as Record<string, unknown>)[k] ?? null);
  };

  const store: ViewStore = {
    get: () => state,
    get seq() {
      return seq;
    },
    get epoch() {
      return epoch;
    },
    versions: () => ({ ...versions }),
    subscribe(l) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    dispatch(ops, meta = {}) {
      const actor = meta.actor ?? HUMAN;
      const r = applyOps(state, ops, { issueId, author: authorOf(actor) });
      if ("error" in r) return { error: r.error };
      const back = reborn(state, r.state);
      if (back.length) return { error: `the id ${back[0]} was removed at seq ${retired.get(back[0])?.seq}; ids are never reused: give the record a new id` };
      const prev = state;
      if (actor.kind === "human") humanInput(r.sets, prev, meta.label ?? describe(r.sets), meta.gesture);
      if (!r.changed.length) return null;
      const label = meta.label ?? describe(r.sets);
      return commit(state, r.state, r.sets, r.inverse, r.changed, { actor, label, ...(meta.gesture ? { gesture: meta.gesture } : {}), source: meta.source ?? "view" });
    },
    applyBatch(batch, actor, source = "bridge") {
      const id = typeof batch?.batchId === "string" ? batch.batchId : "";
      const hit = id ? replies.get(id) : undefined;
      if (hit) return withExtras({ ...hit, duplicate: true } as BatchReply);
      const invalid = (error: string, index?: number): BatchReply => ({ status: "invalid", batchId: id, seq, error, ...(index !== undefined ? { index } : {}) });
      // 200: the bridge qualifies an agent's id (up to 128) by its session ("<session>:<batchId>")
      if (!id || id.length > 200 || !/^[\w.:-]+$/.test(id)) return withExtras(invalid("batchId must be 1 to 200 letters, digits, '.', ':', '_' or '-'"));
      const words = typeof batch.label === "string" ? batch.label.trim().split(/\s+/).filter(Boolean).length : 0;
      if (words < 3 || words > 8 || (batch.label as string).length > 120) return withExtras(remember(id, invalid("label must be 3 to 8 words")));
      if (!Array.isArray(batch.ops) || batch.ops.length > 200) return withExtras(remember(id, invalid("ops must be a list of at most 200 operations")));
      if (batch.leaseToken !== undefined && !(Number.isInteger(batch.leaseToken) && batch.leaseToken > 0)) return withExtras(remember(id, invalid("leaseToken must be the token a claim returned")));
      const own = batch.ops.find((o) => isObj(o) && (STORE_OPS as readonly string[]).includes(o.op as string)) as Record<string, unknown> | undefined;
      if (own && batch.ops.length > 1) return withExtras(remember(id, invalid(`${own.op} goes alone in its batch`, batch.ops.indexOf(own))));
      // the person is mid-gesture: an agent's write waits (the bridge delivers it again); nothing is remembered
      if (batch.ops.length && own?.op !== "release" && actor.kind === "agent" && interacting()) return withExtras({ status: "busy", batchId: id, seq, retryAfterMs: BUSY_RETRY_MS });
      // preconditions first: a stale writer learns what it missed before anything else
      if (batch.expectSeq !== undefined) {
        if (!Number.isInteger(batch.expectSeq) || batch.expectSeq < 0) return withExtras(remember(id, invalid("expectSeq must be a seq number")));
        if (batch.expectSeq !== seq) {
          return withExtras(remember(id, { status: "refused", batchId: id, seq, reason: "stale-seq", missed: { from: batch.expectSeq + 1, to: seq, entries: missedSince(batch.expectSeq) } }));
        }
      }
      if (batch.expectVersions !== undefined) {
        if (!batch.expectVersions || typeof batch.expectVersions !== "object" || Object.values(batch.expectVersions).some((v) => !Number.isInteger(v))) return withExtras(remember(id, invalid("expectVersions must map keys to version numbers")));
        const conflicts = Object.entries(batch.expectVersions)
          .filter(([k, v]) => (versions[k] ?? 0) !== v)
          .map(([k, v]) => ({ key: k, expected: v, current: versions[k] ?? 0, value: valueAt(k), ...(lastBy[k] ? { by: lastBy[k].actor, seq: lastBy[k].seq } : {}) }));
        if (conflicts.length) {
          const from = Math.min(...conflicts.map((c) => c.seq ?? seq));
          return withExtras(remember(id, { status: "refused", batchId: id, seq, reason: "stale-versions", missed: { from, to: seq, entries: missedSince(from - 1).filter((e) => e.keys.some((k) => conflicts.some((c) => c.key === k))) }, conflicts }));
        }
      }
      const withState = batch.state !== false;
      const stateOut = () => (withState ? { state: clone(state) } : {});
      // ---- the store's own verbs: leases and undo
      if (own?.op === "claim") {
        const c = leases.claim(actor, own.roots, own.purpose, own.ttlMs);
        if ("error" in c) return withExtras(remember(id, invalid(c.error, 0)));
        if ("refused" in c) return withExtras(remember(id, refused(id, "leased", { lease: c.refused, message: leasedMessage(c.refused) })));
        emit(state, "presence");
        return withExtras(remember(id, { status: "applied", batchId: id, seq, applied: [], changed: [], versions: { ...versions }, lease: c.lease, ...stateOut() } as BatchReply));
      }
      if (own?.op === "release") {
        if (own.lease !== undefined && typeof own.lease !== "string") return withExtras(remember(id, invalid("release.lease must be a lease id", 0)));
        const ended = leases.release(actor, own.lease as string | undefined);
        if (ended.length) emit(state, "presence");
        return withExtras(remember(id, { status: "applied", batchId: id, seq, applied: [], changed: [], versions: { ...versions }, released: ended.map((e) => e.id), ...stateOut() } as BatchReply));
      }
      if (own?.op === "undo") {
        const r = undo(actor, id, source, batch.leaseToken as number | undefined);
        return withExtras(remember(id, r.status === "applied" ? { ...r, ...stateOut() } : r));
      }
      if (!batch.ops.length) return withExtras(remember(id, { status: "read", batchId: id, seq, versions: { ...versions }, ...stateOut() }));
      const ids: Record<string, string> = {};
      // the ids this batch was issued (D2): an agent's new record must carry one of them
      const issuedNow = new Set<string>();
      const issueOne = () => {
        const x = issueId();
        issuedNow.add(x);
        return x;
      };
      const r = applyOps(state, batch.ops, { issueId: issueOne, author: authorOf(actor), ids, forceAuthor: actor.kind === "agent" });
      if ("error" in r) return withExtras(remember(id, invalid(r.error, r.index)));
      // D2 (wave 3 carry-forward): an agent never chooses a record's id. A record new to the list must carry an id
      // the view issued in this very batch (`annotate` with a handle); a `set` that brings in an id of its own is
      // refused. Hosts (the inspector, the display file) still write deterministic ids of their own.
      const back = reborn(state, r.state);
      if (back.length) return withExtras(remember(id, invalid(`the id ${back[0]} was removed at seq ${retired.get(back[0])?.seq}; ids are never reused (annotate with a handle gets a new one)`)));
      if (actor.kind === "agent") {
        const had = new Set(annotationIds(state.annotations));
        const chosen = annotationIds(r.state.annotations).filter((x) => !had.has(x) && !issuedNow.has(x));
        if (chosen.length) return withExtras(remember(id, invalid(`the view issues record ids: annotate with a handle to make a new record (an agent may not choose the id ${chosen[0]})`)));
      }
      // ---- leases: another actor's subtree is refused; a stale or missing token inside one's own is refused
      if (actor.kind === "agent" || actor.kind === "host") {
        const paths = touchedPaths(r.sets, state as unknown as Record<string, unknown>);
        const other = leases.blocking(actor, paths);
        if (other) return withExtras(remember(id, refused(id, "leased", { lease: other, message: `${leasedMessage(other)}; reads stay open` })));
        const fenced = leases.fence(actor, paths, batch.leaseToken);
        if (fenced) return withExtras(remember(id, refused(id, fenced.reason, { ...(fenced.lease ? { lease: fenced.lease } : {}), message: fenced.message })));
      }
      // ---- the camera: the person's for `handBackMs` after their last input
      const movesCamera = r.sets.some((s) => s.path[0] === "camera");
      if (movesCamera && actor.kind === "agent") {
        tick();
        const until = control.lastHumanAt + handBackMs;
        if (control.lastHumanAt > 0 && now() < until) return withExtras(remember(id, refused(id, "view-held", { until, message: `the person used the view ${Math.round((now() - control.lastHumanAt) / 1000)} s ago; the camera is theirs until ${new Date(until).toISOString()} (other writes go through)` })));
      }
      const before = state;
      if (r.changed.length) commit(state, r.state, r.sets, r.inverse, r.changed, { actor, label: batch.label.trim(), batchId: id, ...(batch.expectSeq !== undefined ? { baseSeq: batch.expectSeq } : {}), ...(batch.leaseToken !== undefined ? { leaseToken: batch.leaseToken } : {}), source });
      else state = r.state;
      if (batch.leaseToken !== undefined) leases.renew(actor, batch.leaseToken);
      if (actor.kind === "agent") {
        const t = now();
        if (movesCamera) {
          if (!sameActor(control.holder, actor)) control.since = t;
          control.holder = { ...actor };
        }
        if (sameActor(control.holder, actor)) control.lastAgentAt = t;
        const roots = touchedPaths(r.sets, before as unknown as Record<string, unknown>);
        recent.set(actor.id, { actor: { ...actor }, roots, label: batch.label.trim(), at: t });
        emit(state, "presence");
      }
      return withExtras(remember(id, { status: "applied", batchId: id, seq, applied: r.sets, changed: r.changed, versions: { ...versions }, ...(Object.keys(ids).length ? { ids } : {}), ...stateOut() }));
    },
    undo(actor, meta = {}) {
      return withExtras(undo(actor, meta.batchId ?? "", meta.source ?? "view"));
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
    presence,
    setInteracting(on) {
      if (control.interacting === on) return;
      control.interacting = on;
      if (on) {
        interactingSince = now();
        control.lastHumanAt = now();
        control.holder = null;
      } else control.lastHumanAt = now();
      emit(state, "presence");
    },
    takeOver(by = HUMAN) {
      const ended = leases.revokeAll(by);
      control.holder = null;
      control.lastHumanAt = now();
      control.since = now();
      emit(state, "presence");
      return ended;
    },
    replied: (batchId) => replies.has(batchId),
    checkpoint() {
      return { schema: "uhd-viewer.store-checkpoint/v0", epoch, seq, time: now(), state: clone(state), versions: { ...versions }, nextId, retired: [...retired.keys()], leases: leases.live(), fenceToken: leases.fenceToken };
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
/** The version key of a set (re-exported for hosts that list what a batch touches). */
export { versionKey };
