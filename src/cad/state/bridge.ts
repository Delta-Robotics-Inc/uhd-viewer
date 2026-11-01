/**
 * The viewer's end of the live-tab bridge (PB-1178; docs/reference/viewer-bridge.md
 * in protoboard-stack). A host that relays an agent's batch (the dev page,
 * the VS Code webview) hands the envelope to `handleBridgeMessage`, which
 * applies it to the view store (./store.ts `applyBatch`: preconditions, the
 * op log, a resent batchId answered from memory) and returns the reply to
 * send back. Text in a batch is data: no op evaluates code or follows a
 * link, and the actor recorded is the one the host vouches for, never one
 * the batch names for itself.
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
  return {
    type: BRIDGE_REQUEST,
    id: data.id,
    batch: data.batch as unknown as Batch,
    actor: { kind: a.kind, id: a.id, ...(typeof a.session === "string" ? { session: a.session } : {}) },
    ...(data.observe === true ? { observe: true } : {}),
  };
}

/** Applies a bridge request to the store; the reply message to send back. */
export function handleBridgeMessage(store: ViewStore, request: BridgeRequest, extra: { observe?: () => unknown; view?: () => "3d" | "diagram" | undefined } = {}): BridgeReplyMessage {
  const reply = store.applyBatch(request.batch, request.actor, "bridge") as BridgeReplyMessage["reply"];
  const out: BridgeReplyMessage["reply"] = { ...reply };
  if (request.observe && extra.observe) {
    try {
      out.observation = extra.observe();
    } catch {
      // the 3D view is not mounted (the diagram is shown): the state still answers
    }
  }
  const view = extra.view?.();
  if (view) out.view = view;
  return { type: BRIDGE_REPLY, id: request.id, reply: out };
}
