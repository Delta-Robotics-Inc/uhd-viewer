/**
 * The viewer's end of the live-tab bridge (PB-1178; docs/reference/viewer-bridge.md
 * in protoboard-stack). A host that relays an agent's batch (the dev page,
 * the VS Code webview) hands the envelope to `handleBridgeMessage`, which
 * applies it to the view store (./store.ts `applyBatch`: preconditions, the
 * op log, a resent batchId answered from memory) and returns the reply to
 * send back. Text in a batch is data: no op evaluates code or follows a
 * link, and the actor recorded is the one the host vouches for, never one
 * the batch names for itself.
 *
 * PB-1196: a request may carry `since` ({epoch, seq}): the reply then carries
 * the log entries after it (`log`, at most `MAX_LOG_ENTRIES`), so the host
 * mirrors every committed write, the person's gestures included, into its
 * on-disk journal (`.protoboard/local/scene-oplog.jsonl`); and `checkpoint`
 * asks for a checkpoint of the store. Every reply carries the store's epoch
 * and presence (leases, intents, who holds the camera). A `busy` reply (the
 * person is mid-gesture) applied nothing: the host delivers it again.
 */
import { HUMAN, authorOf, type ViewStore } from "./store";
import type { Batch, BridgeReplyMessage, BridgeReplyPart, BridgeRequest, PlacementFacts, SetOp } from "../../api";

export type { BridgeReplyMessage, BridgeReplyPart, BridgeRequest, PlacementFacts };

export const BRIDGE_REQUEST = "uhd-viewer:bridge" satisfies BridgeRequest["type"];
export const BRIDGE_REPLY = "uhd-viewer:bridgeReply" satisfies BridgeReplyMessage["type"];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A bridge request, checked; undefined for anything else. */
export function parseBridgeRequest(data: unknown): BridgeRequest | undefined {
  if (!isObj(data) || data.type !== BRIDGE_REQUEST || typeof data.id !== "string" || data.id.length > 128) return undefined;
  if (!isObj(data.batch) || !isObj(data.actor)) return undefined;
  const a = data.actor;
  // the bridge carries agents and hosts; a person's gestures come from the view itself
  if ((a.kind !== "agent" && a.kind !== "host") || typeof a.id !== "string" || !a.id || a.id.length > 128) return undefined;
  if (a.session !== undefined && typeof a.session !== "string") return undefined;
  if (a.name !== undefined && (typeof a.name !== "string" || a.name.length > 64)) return undefined;
  const probe = parseProbe(data.probe);
  const since = isObj(data.since) && typeof data.since.epoch === "string" && data.since.epoch.length <= 64 && Number.isInteger(data.since.seq) && (data.since.seq as number) >= 0 ? { epoch: data.since.epoch, seq: data.since.seq as number } : undefined;
  return {
    type: BRIDGE_REQUEST,
    id: data.id,
    batch: data.batch as unknown as Batch,
    actor: { kind: a.kind, id: a.id, ...(typeof a.session === "string" ? { session: a.session } : {}), ...(typeof a.name === "string" ? { name: a.name.replace(/[\u0000-\u001f]/g, " ") } : {}) },
    ...(data.observe === true || data.observe === "components" ? { observe: data.observe } : {}),
    ...(since ? { since } : {}),
    ...(data.checkpoint === true ? { checkpoint: true } : {}),
    ...(probe ? { probe } : {}),
  };
}

/** DEFAULT (W4-D): pick probes one request may carry. */
export const MAX_PROBE_PICKS = 64;

function parseProbe(v: unknown): BridgeRequest["probe"] | undefined {
  if (!isObj(v)) return undefined;
  const picks = Array.isArray(v.picks)
    ? v.picks
        .filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === "number" && Number.isFinite(x) && x >= -1 && x <= 2))
        .slice(0, MAX_PROBE_PICKS)
    : undefined;
  if (!picks?.length && v.labels !== true) return undefined;
  return { ...(picks?.length ? { picks } : {}), ...(v.labels === true ? { labels: true } : {}) };
}

/** The page's scene helpers the bridge uses (the mounted 3D view sets them on the window's hub, ./hub.ts). */
interface SceneHelpers {
  observer?: (o?: { components?: boolean }) => unknown;
  pick?: (fx: number, fy: number) => unknown;
  labels?: () => unknown[];
  canvas?: () => { width: number; height: number };
  place?: (op: PlacementVerb, by: string) => { set: SetOp; facts: PlacementFacts } | { error: string };
}

/**
 * The placement verbs (PB-1187, W4-D's MCP `view_place_on_face` / `view_orient_by_face`): resolved in the page,
 * where the faces are (`hub.place`), into one `set` on `placements` before the store sees the batch, so the store
 * keeps checking, logging and fencing it like any write. `unplace` removes a part's placement.
 */
export type PlacementVerb =
  | { op: "placeOnFace"; part: string; face: number; target: string; targetFace: number; gap?: number; spinDeg?: number; align?: "centroid" | "project" }
  | { op: "orientByFace"; part: string; face: number; target: string; targetFace: number; flip?: boolean }
  | { op: "unplace"; part: string };
export const PLACEMENT_VERBS = ["placeOnFace", "orientByFace", "unplace"] as const;

const hubOf = (): SceneHelpers | undefined => (globalThis as unknown as Record<string, SceneHelpers | undefined>)[HUB_KEY];

/** The batch with its placement verbs resolved in the page, or the reason they cannot be. */
function expandPlacements(batch: Batch, by: string, helpers: SceneHelpers | undefined): { batch: Batch; facts: PlacementFacts[] } | { error: string; index: number } {
  if (!Array.isArray(batch.ops) || !batch.ops.some((o) => isObj(o) && (PLACEMENT_VERBS as readonly string[]).includes(o.op as string))) return { batch, facts: [] };
  const facts: PlacementFacts[] = [];
  const ops: unknown[] = [];
  for (const [index, o] of batch.ops.entries()) {
    if (!isObj(o) || !(PLACEMENT_VERBS as readonly string[]).includes(o.op as string)) {
      ops.push(o);
      continue;
    }
    if (typeof o.part !== "string" || !o.part || o.part.length > 512) return { error: `${o.op}.part must be an instance path`, index };
    if (o.op === "unplace") {
      ops.push({ op: "set", path: ["placements", o.part], value: undefined });
      continue;
    }
    if (!helpers?.place) return { error: `${o.op} needs the 3D view's faces: the 3D view is not shown (show it, or use the headless route)`, index };
    if (typeof o.target !== "string" || !Number.isInteger(o.face) || !Number.isInteger(o.targetFace)) return { error: `${o.op} needs part, face, target and targetFace (face ids from view_pick)`, index };
    const r = helpers.place(o as unknown as PlacementVerb, by);
    if ("error" in r) return { error: `${o.op}: ${r.error}`, index };
    ops.push(r.set);
    facts.push(r.facts);
  }
  return { batch: { ...batch, ops }, facts };
}

/** Applies a bridge request to the store; the reply message to send back. */
export function handleBridgeMessage(store: ViewStore, request: BridgeRequest, extra: { observe?: () => unknown; view?: () => "3d" | "diagram" | undefined } = {}): BridgeReplyMessage {
  const helpers = hubOf();
  // the person takes over through their own host (W4-D: the VS Code status bar chip): only a host actor may send it,
  // never an agent (the dev server's bridge mints agent actors only)
  const ops = Array.isArray(request.batch?.ops) ? request.batch.ops : [];
  if (request.actor.kind === "host" && ops.length === 1 && isObj(ops[0]) && ops[0].op === "takeOver") {
    const ended = store.takeOver(HUMAN);
    return { type: BRIDGE_REPLY, id: request.id, reply: { status: "applied", batchId: String(request.batch.batchId ?? ""), seq: store.seq, applied: [], changed: [], versions: store.versions(), released: ended.map((e) => e.id), epoch: store.epoch, presence: store.presence() } };
  }
  // a resend is answered from the store's memory: its placements are not computed again
  const expanded = typeof request.batch?.batchId === "string" && store.replied(request.batch.batchId) ? { batch: request.batch, facts: [] as PlacementFacts[] } : expandPlacements(request.batch, authorOf(request.actor), helpers);
  const reply = ("error" in expanded ? { status: "invalid", batchId: String(request.batch?.batchId ?? ""), seq: store.seq, error: expanded.error, index: expanded.index, epoch: store.epoch, presence: store.presence() } : store.applyBatch(expanded.batch, request.actor, "bridge")) as BridgeReplyMessage["reply"];
  const out: BridgeReplyMessage["reply"] = { ...reply };
  if (!("error" in expanded) && expanded.facts.length && reply.status === "applied") out.placements = expanded.facts;
  if (request.observe && extra.observe) {
    try {
      // "components": the parts drawn inside bodies too (a board's U3), from the window's observer when it has one
      const hub = request.observe === "components" ? (globalThis as unknown as Record<string, { observer?: (o?: { components?: boolean }) => unknown } | undefined>)[HUB_KEY] : undefined;
      out.observation = hub?.observer ? capNodes(hub.observer({ components: true })) : extra.observe();
    } catch {
      // the 3D view is not mounted (the diagram is shown): the state still answers
    }
  }
  if (request.probe) {
    // the critic's probes (W4-D): what is drawn at each point, and the label boxes, from the mounted 3D view
    const probe: NonNullable<BridgeReplyMessage["reply"]["probe"]> = {};
    if (request.probe.picks && helpers?.pick) {
      probe.picks = request.probe.picks.map((at) => {
        try {
          return { at, hit: helpers.pick!(at[0], at[1]) ?? null };
        } catch {
          return { at, hit: null };
        }
      });
    }
    if (request.probe.labels && helpers?.labels) {
      try {
        probe.labels = helpers.labels().slice(0, 500);
      } catch {
        probe.labels = [];
      }
    }
    if (helpers?.canvas) probe.canvas = helpers.canvas();
    out.probe = probe;
  }
  const view = extra.view?.();
  if (view) out.view = view;
  if (request.since) {
    // a new epoch (the page reloaded): everything this store has
    const from = request.since.epoch === store.epoch ? request.since.seq : 0;
    const entries = store.log(from);
    out.log = { epoch: store.epoch, entries: entries.slice(0, MAX_LOG_ENTRIES), ...(entries.length > MAX_LOG_ENTRIES ? { truncated: true as const } : {}) };
  }
  if (request.checkpoint) out.checkpoint = store.checkpoint();
  return { type: BRIDGE_REPLY, id: request.id, reply: out };
}

/** The window's view hub (./hub.ts keeps it under this key). */
const HUB_KEY = "__uhdViewHub";
/** DEFAULT: an observation with components carries at most this many nodes (a dense board has thousands of parts). */
export const MAX_OBSERVED_NODES = 4000;
const capNodes = (o: unknown): unknown => {
  const nodes = (o as { nodes?: unknown[] } | undefined)?.nodes;
  return Array.isArray(nodes) && nodes.length > MAX_OBSERVED_NODES ? { ...(o as object), nodes: nodes.slice(0, MAX_OBSERVED_NODES), nodesTruncated: nodes.length } : o;
};

/** Log entries one reply carries at most, the oldest first (DEFAULT; the host asks again from the last it got). */
export const MAX_LOG_ENTRIES = 200;

export const BRIDGE_REPLY_PART = "uhd-viewer:bridgeReplyPart" satisfies BridgeReplyPart["type"];
/** DEFAULT (W4-D): a reply part's slice of JSON text, under Chrome's 64 kB keepalive budget with room for its envelope. */
export const REPLY_PART_CHARS = 48 * 1024;
/** DEFAULT: the most parts one reply is cut into (with the default slice, about 12 MB of JSON). */
export const MAX_REPLY_PARTS = 256;

/**
 * A reply as one message when its JSON fits `maxChars`, else as parts in order (W4-D, wave 3 carry-forward: a
 * live tab's reply over 64 kB, a dense board's observation with components). The host posts each part as it
 * would a reply and joins them (`joinBridgeReply`); a reply over `MAX_REPLY_PARTS` parts is not cut (the host's
 * own size cap answers it).
 */
export function splitBridgeReply(message: BridgeReplyMessage, maxChars = REPLY_PART_CHARS): (BridgeReplyMessage | BridgeReplyPart)[] {
  const text = JSON.stringify(message);
  if (text.length <= maxChars) return [message];
  // each part's posted JSON (its slice escaped again, plus the envelope) stays under maxChars: slices are cut
  // greedily and shortened until their escaped length fits
  const room = Math.max(1024, maxChars - 256);
  const slices: string[] = [];
  for (let at = 0; at < text.length; ) {
    let len = Math.min(room, text.length - at);
    while (len > 64 && JSON.stringify(text.slice(at, at + len)).length > room) len = Math.floor(len * 0.85);
    slices.push(text.slice(at, at + len));
    at += len;
    if (slices.length > MAX_REPLY_PARTS) return [message];
  }
  const n = slices.length;
  return slices.map((data, i) => ({ type: BRIDGE_REPLY_PART, id: message.id, i, n, data }));
}

/** The reply from its parts (or a whole reply), or undefined when a part is missing, repeated or does not belong. */
export function joinBridgeReply(parts: (BridgeReplyMessage | BridgeReplyPart)[]): BridgeReplyMessage | undefined {
  if (parts.length === 1 && parts[0].type === BRIDGE_REPLY) return parts[0] as BridgeReplyMessage;
  const ps = parts.filter((p): p is BridgeReplyPart => p.type === BRIDGE_REPLY_PART);
  if (!ps.length || ps.length !== parts.length) return undefined;
  const { id, n } = ps[0];
  if (!Number.isInteger(n) || n < 1 || n > MAX_REPLY_PARTS || ps.length !== n || ps.some((p) => p.id !== id || p.n !== n || typeof p.data !== "string")) return undefined;
  const sorted = [...ps].sort((a, b) => a.i - b.i);
  if (sorted.some((p, i) => p.i !== i)) return undefined;
  try {
    const m = JSON.parse(sorted.map((p) => p.data).join("")) as BridgeReplyMessage;
    return m && m.type === BRIDGE_REPLY && m.id === id ? m : undefined;
  } catch {
    return undefined;
  }
}
