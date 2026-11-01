/**
 * The on-disk journal of the op log (PB-1196, collaboration D4), as data:
 * the host (the `protoboard dev` server, the render service) mirrors every
 * committed entry to `.protoboard/local/scene-oplog.jsonl` (git-ignored),
 * one JSON object per line, with a checkpoint every so often and a size cap
 * (the writer is `packages/cli/src/dev/journal.ts` in protoboard-stack; it
 * keeps the newest checkpoint and what follows when the file grows past it).
 *
 *   {"t":"checkpoint", "schema":"uhd-viewer.store-checkpoint/v0", "epoch", "seq", "state", "versions", "nextId", "retired", "leases", ...}
 *   {"t":"entry", "epoch", "seq", "time", "actor", "batchId"?, "label", "ops", "inverse", "keys", "touched", "leaseToken"?, "undoOf"?}
 *
 * `replayJournal` rebuilds the store's state after a crash: the newest epoch,
 * from its newest checkpoint (or from an empty state), then every entry after
 * it in seq order. Pure: no file access here.
 */
import { applySets, type SetOp } from "./ops";
import { defaultViewState, type ViewState } from "./schema";
import type { StoreCheckpoint } from "./store";

export const JOURNAL_FILE = ".protoboard/local/scene-oplog.jsonl";

export interface JournalReplay {
  epoch: string;
  seq: number;
  state: ViewState;
  versions: Record<string, number>;
  /** The id counter to continue from (never reuse an id: the epoch changes anyway on a new store). */
  nextId: number;
  retired: string[];
  /** Entries applied after the checkpoint. */
  applied: number;
  /** Lines that could not be read or applied (index and why). */
  skipped: { line: number; why: string }[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Rebuild from journal lines (text lines or parsed objects). Undefined when the journal holds nothing usable. */
export function replayJournal(lines: (string | unknown)[]): JournalReplay | undefined {
  const skipped: JournalReplay["skipped"] = [];
  const rows: { i: number; o: Record<string, unknown> }[] = [];
  lines.forEach((l, i) => {
    if (typeof l === "string" && !l.trim()) return;
    try {
      const o = typeof l === "string" ? JSON.parse(l) : l;
      if (isObj(o) && (o.t === "entry" || o.t === "checkpoint") && typeof o.epoch === "string") rows.push({ i, o });
      else skipped.push({ line: i, why: "not a journal line" });
    } catch {
      skipped.push({ line: i, why: "not JSON (a torn last line?)" });
    }
  });
  if (!rows.length) return undefined;
  const epoch = rows[rows.length - 1].o.epoch as string;
  const mine = rows.filter((r) => r.o.epoch === epoch);
  const cps = mine.filter((r) => r.o.t === "checkpoint" && isObj(r.o.state) && Number.isInteger(r.o.seq));
  const cp = cps.length ? (cps[cps.length - 1].o as unknown as StoreCheckpoint) : undefined;
  let state: ViewState = cp ? ({ ...defaultViewState(cp.state.scope ?? ""), ...cp.state } as ViewState) : defaultViewState();
  const versions: Record<string, number> = cp ? { ...cp.versions } : {};
  let seq = cp ? cp.seq : 0;
  let applied = 0;
  const entries = mine
    .filter((r) => r.o.t === "entry" && Number.isInteger(r.o.seq) && (r.o.seq as number) > seq)
    .sort((a, b) => (a.o.seq as number) - (b.o.seq as number));
  let lastSeq = -1;
  for (const { i, o } of entries) {
    if (o.seq === lastSeq) continue; // a line written twice (a resend after a crash)
    lastSeq = o.seq as number;
    if (!Array.isArray(o.ops)) {
      skipped.push({ line: i, why: "an entry without ops" });
      continue;
    }
    const r = applySets(state, o.ops as SetOp[]);
    if ("error" in r) {
      skipped.push({ line: i, why: r.error });
      continue;
    }
    state = r.state;
    for (const k of Array.isArray(o.keys) ? (o.keys as string[]) : r.changed) versions[k] = (versions[k] ?? 0) + 1;
    seq = o.seq as number;
    applied++;
  }
  return { epoch, seq, state, versions, nextId: cp?.nextId ?? 1, retired: cp?.retired ?? [], applied, skipped };
}
