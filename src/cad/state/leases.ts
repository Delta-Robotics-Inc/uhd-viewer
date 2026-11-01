/**
 * Subtree leases with fencing tokens (PB-1196 first slice; collaboration D6
 * and D9). Pure bookkeeping: the store (./store.ts) owns one `LeaseTable` and
 * asks it, per batch, whether the paths the batch touches are free.
 *
 * - `claim(roots, purpose, ttl)` grants a lease when no other actor's live
 *   lease overlaps (one root is an ancestor of, or equal to, the other). The
 *   token rises with every grant in the view (a fencing token: Kleppmann 2016,
 *   Chubby 2006), so a paused holder whose lease ended cannot write with it.
 * - A holder's own overlapping lease is replaced (a renewal or a change of
 *   subtree), with a new token.
 * - Leases expire (`ttlMs`, DEFAULT 120 s, at most 10 min) unless the holder
 *   writes with its token, which extends it.
 * - A person's edit inside a leased subtree revokes the lease (DEFAULT,
 *   plan.md); "take over" revokes every agent lease.
 * - Ended leases are kept (the last 64) so a holder that quotes an old token,
 *   or writes in a subtree it once held without a live token, is told what
 *   happened instead of being let through.
 *
 * Paths are UHD instance paths ("" is the whole assembly; `a/b` is under `a`).
 */
import type { Actor, EndedLease, Intent, Lease, SetOp } from "../../api";

export type { EndedLease, Intent, Lease };

/** DEFAULT (collaboration D6): a lease lives 120 s unless renewed by a write that quotes its token. */
export const DEFAULT_LEASE_TTL_MS = 120_000;
/** DEFAULT: the longest a lease may be asked for. */
export const MAX_LEASE_TTL_MS = 600_000;
/** DEFAULT: the shortest. */
export const MIN_LEASE_TTL_MS = 1_000;
/** DEFAULT: roots one lease may name. */
export const MAX_LEASE_ROOTS = 32;
/** DEFAULT (D14: three to five agents per scene): live leases in one view. */
export const MAX_LEASES = 64;
/** Ended leases remembered. DEFAULT. */
const ENDED_KEPT = 64;

const norm = (p: string) => p.split("/").filter(Boolean).join("/");

/** `p` is `root` or under it ("" covers everything). */
export const covers = (root: string, p: string): boolean => {
  const r = norm(root);
  const q = norm(p);
  return r === "" || q === r || q.startsWith(`${r}/`);
};
/** Two subtrees overlap: one root covers the other. */
export const overlaps = (a: string, b: string): boolean => covers(a, b) || covers(b, a);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const sameActor = (a: Actor, b: Actor) => a.kind === b.kind && a.id === b.id;

/**
 * The instance paths a list of writes edits, against the state before it
 * (`before[key]`). Camera and selection are looking, not editing: they touch
 * no path (DEFAULT). Explode, sections, direction and named views change the
 * whole assembly's presentation: they touch "" (only a lease on the whole
 * assembly covers them). Highlight, isolation and hidden touch the paths added
 * or removed; an annotation touches its `ref` and its `to`, before and after.
 */
export function touchedPaths(sets: SetOp[], before: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const diff = (a: unknown, b: unknown) => {
    const x = new Set(Array.isArray(a) ? (a as string[]) : []);
    const y = new Set(Array.isArray(b) ? (b as string[]) : []);
    for (const p of x) if (!y.has(p)) out.add(norm(p));
    for (const p of y) if (!x.has(p)) out.add(norm(p));
  };
  const refsOf = (r: unknown) => (isObj(r) ? [r.ref, r.to].filter((x): x is string => typeof x === "string").map(norm) : []);
  const state = { ...before };
  for (const s of sets) {
    const [key, entry] = s.path;
    switch (key) {
      case "camera":
      case "selection":
        break;
      case "highlight":
      case "isolation":
        diff(state[key], s.value);
        break;
      case "visibility": {
        const vis = isObj(state.visibility) ? state.visibility : {};
        if (entry === "hidden") diff(vis.hidden, s.value);
        else if (entry === undefined) diff(vis.hidden, isObj(s.value) ? s.value.hidden : undefined);
        // labels, frames, wires, hardware, xray: how the view draws, not what is in the scene
        break;
      }
      case "placements": {
        // a placement moves the part it names
        if (entry !== undefined) out.add(norm(entry));
        else for (const p of new Set([...Object.keys(isObj(state.placements) ? state.placements : {}), ...Object.keys(isObj(s.value) ? s.value : {})])) out.add(norm(p));
        break;
      }
      case "annotations": {
        const list = Array.isArray(state.annotations) ? (state.annotations as unknown[]) : [];
        if (entry === undefined) {
          const a = new Map(list.filter(isObj).map((r) => [r.id, JSON.stringify(r)]));
          const b = new Map((Array.isArray(s.value) ? s.value : []).filter(isObj).map((r) => [r.id, JSON.stringify(r)]));
          for (const r of [...list, ...(Array.isArray(s.value) ? s.value : [])]) if (isObj(r) && a.get(r.id) !== b.get(r.id)) for (const p of refsOf(r)) out.add(p);
        } else {
          for (const p of refsOf(list.find((r) => isObj(r) && r.id === entry))) out.add(p);
          for (const p of refsOf(s.value)) out.add(p);
        }
        break;
      }
      default:
        // explode, sections, direction, namedViews
        out.add("");
    }
    // later writes in the same list see this one
    if (entry === undefined) state[key] = s.value;
  }
  return [...out];
}

export type ClaimResult = { lease: Lease } | { refused: Lease } | { error: string };

export interface LeaseTable {
  /** Live leases (expired ones are ended first). */
  live(): Lease[];
  ended(): EndedLease[];
  claim(holder: Actor, roots: unknown, purpose: unknown, ttlMs?: unknown): ClaimResult;
  /** Ends the holder's lease `id` (or all of the holder's). Returns what ended. */
  release(holder: Actor, id?: string): EndedLease[];
  /** Another actor's live lease covering one of `paths`, if any. */
  blocking(actor: Actor, paths: string[]): Lease | undefined;
  /**
   * Whether `actor` may write `paths` with `token`: undefined when it may; else the reason and the lease
   * concerned. A token must name a live lease of the actor; a write inside a subtree the actor holds or
   * held needs its live token.
   */
  fence(actor: Actor, paths: string[], token: number | undefined): { reason: "lease-revoked"; lease?: Lease | EndedLease; message: string } | undefined;
  /** The holder wrote with this token: extend its lease. */
  renew(actor: Actor, token: number): void;
  /** A person's edit at `paths`: every agent lease covering one is revoked. Returns the revoked. */
  revokeCovering(paths: string[], by: Actor, detail: string): EndedLease[];
  /** Every agent lease is revoked (the person took over). */
  revokeAll(by: Actor): EndedLease[];
  /** The highest token granted so far. */
  readonly fenceToken: number;
}

export function createLeaseTable(now: () => number = () => Date.now()): LeaseTable {
  let leases: Lease[] = [];
  let ended: EndedLease[] = [];
  let token = 0;
  let serial = 0;
  const end = (l: Lease, reason: EndedLease["reason"], by?: Actor, detail?: string): EndedLease => {
    const e: EndedLease = { ...l, endedAt: now(), reason, ...(by ? { by } : {}), ...(detail ? { detail } : {}) };
    ended.push(e);
    if (ended.length > ENDED_KEPT) ended = ended.slice(-ENDED_KEPT);
    return e;
  };
  const sweep = () => {
    const t = now();
    const gone = leases.filter((l) => l.expiresAt <= t);
    if (!gone.length) return;
    leases = leases.filter((l) => l.expiresAt > t);
    for (const l of gone) end(l, "expired");
  };
  const table: LeaseTable = {
    live() {
      sweep();
      return leases.map((l) => ({ ...l, roots: [...l.roots], holder: { ...l.holder } }));
    },
    ended: () => ended.map((e) => ({ ...e })),
    claim(holder, rootsRaw, purposeRaw, ttlRaw) {
      sweep();
      if (holder.kind !== "agent" && holder.kind !== "host") return { error: "only agents and hosts take leases (the person never needs one)" };
      if (!Array.isArray(rootsRaw) || !rootsRaw.length || rootsRaw.length > MAX_LEASE_ROOTS || !rootsRaw.every((r) => typeof r === "string" && r.length <= 512 && !/[\u0000-\u001f]/.test(r))) return { error: `claim.roots must list 1 to ${MAX_LEASE_ROOTS} instance paths ("" is the whole assembly)` };
      const purpose = typeof purposeRaw === "string" ? purposeRaw.replace(/[\u0000-\u001f]/g, " ").trim() : "";
      if (!purpose || purpose.length > 120) return { error: "claim.purpose must say in a few words what you will do there (at most 120 characters)" };
      const ttl = ttlRaw === undefined ? DEFAULT_LEASE_TTL_MS : Number(ttlRaw);
      if (!Number.isFinite(ttl) || ttl < MIN_LEASE_TTL_MS || ttl > MAX_LEASE_TTL_MS) return { error: `claim.ttlMs must be between ${MIN_LEASE_TTL_MS} and ${MAX_LEASE_TTL_MS}` };
      const roots = [...new Set((rootsRaw as string[]).map(norm))];
      const other = leases.find((l) => !sameActor(l.holder, holder) && l.roots.some((a) => roots.some((b) => overlaps(a, b))));
      if (other) return { refused: { ...other } };
      // the holder's own overlapping leases give way to the new one (a renewal, or a wider or narrower subtree);
      // capacity is checked first, so a refused claim keeps the old lease (gate 3)
      const replaced = leases.filter((l) => sameActor(l.holder, holder) && l.roots.some((a) => roots.some((b) => overlaps(a, b))));
      if (leases.length - replaced.length >= MAX_LEASES) return { error: `at most ${MAX_LEASES} live leases in one view` };
      for (const l of replaced) end(l, "released", holder, "replaced by a new claim");
      leases = leases.filter((l) => !replaced.includes(l));
      const t = now();
      const lease: Lease = { id: `lease-${++serial}`, token: ++token, holder: { ...holder }, roots, purpose, grantedAt: t, expiresAt: t + ttl, ttlMs: ttl };
      leases.push(lease);
      return { lease: { ...lease } };
    },
    release(holder, id) {
      sweep();
      const mine = leases.filter((l) => sameActor(l.holder, holder) && (id === undefined || l.id === id));
      leases = leases.filter((l) => !mine.includes(l));
      return mine.map((l) => end(l, "released", holder));
    },
    blocking(actor, paths) {
      sweep();
      return leases.find((l) => !sameActor(l.holder, actor) && paths.some((p) => l.roots.some((r) => covers(r, p))));
    },
    fence(actor, paths, given) {
      sweep();
      if (given !== undefined) {
        const live = leases.find((l) => l.token === given);
        if (!live || !sameActor(live.holder, actor)) {
          const old = ended.find((e) => e.token === given && sameActor(e.holder, actor));
          return { reason: "lease-revoked", ...(old ? { lease: old } : {}), message: old ? `lease ${old.id} (token ${given}) ${old.reason === "revoked" ? "was revoked by the person (see `lease.detail`)" : old.reason === "taken-over" ? "ended: the person took over" : old.reason}; re-observe, then claim again` : `token ${given} names no live lease of yours; claim again` };
        }
        // a live token covers only its own subtree: outside it, the usual rules hold
        const outside = paths.filter((p) => !live.roots.some((r) => covers(r, p)));
        if (!outside.length) return undefined;
        paths = outside;
      }
      // writing in a subtree this actor holds (under another live lease of its own) or held needs that live token
      const held = leases.find((l) => sameActor(l.holder, actor) && paths.some((p) => l.roots.some((r) => covers(r, p))));
      if (held) return { reason: "lease-revoked", lease: { ...held }, message: `you hold lease ${held.id} over this path: quote its leaseToken ${held.token}` };
      // the actor's latest ended lease there decides: released by the holder is a clean end; expired, revoked or taken over is not
      const was = [...ended].reverse().find((e) => sameActor(e.holder, actor) && paths.some((p) => e.roots.some((r) => covers(r, p))));
      if (was && was.reason !== "released" && !(was.detail === "replaced by a new claim")) return { reason: "lease-revoked", lease: was, message: `your lease ${was.id} over this path ${was.reason === "expired" ? "expired" : was.reason === "taken-over" ? "ended when the person took over" : "was revoked by the person (see `lease.detail`)"}; re-observe, then claim again before writing there` };
      return undefined;
    },
    renew(actor, given) {
      sweep();
      const l = leases.find((x) => x.token === given && sameActor(x.holder, actor));
      if (l) l.expiresAt = now() + l.ttlMs;
    },
    revokeCovering(paths, by, detail) {
      sweep();
      const hit = leases.filter((l) => l.holder.kind === "agent" && paths.some((p) => l.roots.some((r) => covers(r, p))));
      leases = leases.filter((l) => !hit.includes(l));
      // the token rises with the revocation too: no later grant reuses a number a revoked holder may still quote
      if (hit.length) token++;
      return hit.map((l) => end(l, "revoked", by, detail));
    },
    revokeAll(by) {
      sweep();
      const hit = leases.filter((l) => l.holder.kind === "agent");
      leases = leases.filter((l) => !hit.includes(l));
      if (hit.length) token++;
      return hit.map((l) => end(l, "taken-over", by));
    },
    get fenceToken() {
      return token;
    },
  };
  return table;
}

/** What each agent is doing: its live leases, then where it wrote in the last `recentMs`. */
export function intentsOf(leases: Lease[], recent: { actor: Actor; roots: string[]; label: string; at: number }[], now: number, recentMs: number): Intent[] {
  const out: Intent[] = leases.map((l) => ({ actor: { ...l.holder }, roots: [...l.roots], label: l.purpose, startedAt: l.grantedAt, from: "lease" as const }));
  for (const r of recent) {
    if (now - r.at > recentMs) continue;
    if (out.some((i) => i.from === "lease" && sameActor(i.actor, r.actor))) continue;
    out.push({ actor: { ...r.actor }, roots: r.roots.slice(0, 8), label: r.label, startedAt: r.at, from: "recent" });
  }
  return out;
}
