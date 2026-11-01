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
import type { ViewStore } from "./store";
import type { Batch, BridgeReplyMessage, BridgeRequest } from "../../api";

export type { BridgeReplyMessage, BridgeRequest };

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
  const since = isObj(data.since) && typeof data.since.epoch === "string" && data.since.epoch.length <= 64 && Number.isInteger(data.since.seq) && (data.since.seq as number) >= 0 ? { epoch: data.since.epoch, seq: data.since.seq as number } : undefined;
  return {
    type: BRIDGE_REQUEST,
    id: data.id,
    batch: data.batch as unknown as Batch,
    actor: { kind: a.kind, id: a.id, ...(typeof a.session === "string" ? { session: a.session } : {}), ...(typeof a.name === "string" ? { name: a.name.replace(/[\u0000-\u001f]/g, " ") } : {}) },
    ...(data.observe === true || data.observe === "components" ? { observe: data.observe } : {}),
    ...(since ? { since } : {}),
    ...(data.checkpoint === true ? { checkpoint: true } : {}),
  };
}

/** Applies a bridge request to the store; the reply message to send back. */
export function handleBridgeMessage(store: ViewStore, request: BridgeRequest, extra: { observe?: () => unknown; view?: () => "3d" | "diagram" | undefined } = {}): BridgeReplyMessage {
  const reply = store.applyBatch(request.batch, request.actor, "bridge") as BridgeReplyMessage["reply"];
  const out: BridgeReplyMessage["reply"] = { ...reply };
  if (request.observe && extra.observe) {
    try {
      // "components": the parts drawn inside bodies too (a board's U3), from the window's observer when it has one
      const hub = request.observe === "components" ? (globalThis as unknown as Record<string, { observer?: (o?: { components?: boolean }) => unknown } | undefined>)[HUB_KEY] : undefined;
      out.observation = hub?.observer ? capNodes(hub.observer({ components: true })) : extra.observe();
    } catch {
      // the 3D view is not mounted (the diagram is shown): the state still answers
    }
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
