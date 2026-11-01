/**
 * The host message protocol (README, "Host messages"): checking what arrives
 * over `postMessage`, and which origins a frame's parent may have. Nothing
 * here names a host.
 */
import type { ViewState } from "../cad/state/schema";
import type { ViewerEvent, ViewerHostMessage, ViewerSnapshotMessage } from "../api";
import { BRIDGE_REQUEST, parseBridgeRequest } from "../cad/state/bridge";
import { parseViewerStateFile } from "../cad/state/serialize";

/** Every protocol message's type starts with this. */
export const PREFIX = "uhd-viewer:";

const isString = (v: unknown): v is string => typeof v === "string";
/** A path as a string ("arm_fl/motor"), or the same as a list of child ids. */
const pathOf = (v: unknown): string | undefined =>
  isString(v) ? v.replace(/^\/+|\/+$/g, "") : Array.isArray(v) && v.every(isString) ? v.join("/") : undefined;

/**
 * A host → viewer message, checked and normalised (a path given as a list of
 * child ids is joined); undefined for anything else.
 */
export function parseHostMessage(data: unknown): ViewerHostMessage | undefined {
  if (!data || typeof data !== "object") return undefined;
  const m = data as Record<string, unknown>;
  switch (m.type) {
    case "uhd-viewer:focus":
    case "uhd-viewer:drill": {
      const path = pathOf(m.path);
      return path === undefined ? undefined : { type: m.type, path };
    }
    case "uhd-viewer:select": {
      const ids = isString(m.ids) ? [m.ids] : Array.isArray(m.ids) && m.ids.every(isString) ? m.ids : undefined;
      if (!ids || (m.reveal !== undefined && typeof m.reveal !== "boolean")) return undefined;
      return m.reveal === false ? { type: m.type, ids, reveal: false } : { type: m.type, ids };
    }
    case "uhd-viewer:setView":
      return m.view === "diagram" || m.view === "3d" ? { type: m.type, view: m.view } : undefined;
    // the 3D view's state (PB-1178): its values are checked when the store applies them
    case "uhd-viewer:setViewState":
      return m.state && typeof m.state === "object" && !Array.isArray(m.state) ? { type: m.type, state: m.state as Partial<ViewState> } : undefined;
    case "uhd-viewer:restoreViewState": {
      const file = parseViewerStateFile(m.file);
      return file ? { type: m.type, file } : undefined;
    }
    case BRIDGE_REQUEST:
      return parseBridgeRequest(m);
    // the assembly sequence player (W2-C, PB-1183): the player checks the command itself
    case "uhd-viewer:sequence": {
      const c = m.command as Record<string, unknown> | undefined;
      return c && typeof c === "object" && !Array.isArray(c) && typeof c.action === "string" ? { type: m.type, command: c as { action: string } } : undefined;
    }
    // the quality curve's settings (PB-1176): numbers and switches only
    case "uhd-viewer:quality": {
      const c = m.config as Record<string, unknown> | undefined;
      if (!c || typeof c !== "object" || Array.isArray(c)) return undefined;
      const ok = Object.values(c).every((v) => typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)));
      return ok ? { type: m.type, config: c } : undefined;
    }
    // the host's last snapshot of the tab (PB-1180): an image to paint and the camera it was drawn with
    case "uhd-viewer:snapshot":
      return parseSnapshotMessage(m);
    default:
      return undefined;
  }
}

/**
 * Local telemetry (PB-1181, src/telemetry/): the viewer's session record, as
 * a window event of this type (`detail`: the record) and, in a frame, as a
 * message `{ type: TELEMETRY_EVENT, record }` posted to the parent over the
 * host channel. The host that writes it (the VS Code extension host,
 * `protoboard dev`) sanitises it again; this check is only the envelope.
 */
export const TELEMETRY_EVENT = "uhd-viewer:telemetry";

/** A telemetry message from the viewer: a record of a known schema, small enough to carry. */
export interface TelemetryMessage {
  type: typeof TELEMETRY_EVENT;
  record: { schema: "pb.render-session/v0" | "pb.crash/v0"; [key: string]: unknown };
}

/** Records larger than this (as JSON) are not relayed. */
export const MAX_TELEMETRY_BYTES = 64 * 1024;

/** The record when `data` is a telemetry message (or a bare record, as the window event's detail carries it); undefined otherwise. */
export function parseTelemetryMessage(data: unknown): TelemetryMessage | undefined {
  if (!data || typeof data !== "object") return undefined;
  const m = data as Record<string, unknown>;
  const record = (m.type === TELEMETRY_EVENT ? m.record : m) as Record<string, unknown> | undefined;
  if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
  if (record.schema !== "pb.render-session/v0" && record.schema !== "pb.crash/v0") return undefined;
  try {
    if (JSON.stringify(record).length > MAX_TELEMETRY_BYTES) return undefined;
  } catch {
    return undefined;
  }
  return { type: TELEMETRY_EVENT, record: record as TelemetryMessage["record"] };
}

/** A viewer → host event (for a host or a relay telling them from other messages). */
export const isViewerEvent = (data: unknown): data is ViewerEvent =>
  Boolean(data) && typeof data === "object" && ["uhd-viewer:ready", "uhd-viewer:selectionChanged", "uhd-viewer:openSource", "uhd-viewer:openArtifact", "uhd-viewer:openModule", "uhd-viewer:openPair", "uhd-viewer:inspect", "uhd-viewer:viewState", "uhd-viewer:presentation", "uhd-viewer:bridgeReply", "uhd-viewer:sequenceState"].includes((data as { type?: string }).type ?? "");

/**
 * `origin` is one of `allowed`: an exact origin, `scheme://*` (any origin
 * with that scheme), or `*` (any). An opaque origin ("null") matches only `*`.
 */
export function originAllowed(origin: string, allowed: readonly string[]): boolean {
  return allowed.some((a) => {
    if (a === "*") return true;
    if (origin === "null") return false;
    const wild = /^([a-z][a-z0-9+.-]*):\/\/\*$/i.exec(a);
    if (wild) return origin.toLowerCase().startsWith(`${wild[1].toLowerCase()}://`);
    return a.replace(/\/+$/, "") === origin;
  });
}

/** Origins from a comma-separated list (`a,b`), blanks dropped. */
export const originList = (value: string | null | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** Image URLs a snapshot may name: the host's server, a data or blob URL, a webview resource, or a relative path. */
const SNAPSHOT_URL = /^(https?:|data:image\/png;base64,|blob:|vscode-webview-resource:|vscode-resource:|\.\/|\/(?!\/))/i;

/** A `uhd-viewer:snapshot` message (PB-1180), checked; undefined for anything else. */
export function parseSnapshotMessage(m: Record<string, unknown>): ViewerSnapshotMessage | undefined {
  if (m.schema !== "protoboard.snapshot/v0" || typeof m.imageUrl !== "string" || typeof m.level !== "string" || typeof m.view !== "string") return undefined;
  if (!SNAPSHOT_URL.test(m.imageUrl)) return undefined;
  const cam = m.camera as Record<string, unknown> | undefined;
  const vec = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x));
  if (cam !== undefined && !(cam && vec(cam.position) && vec(cam.target) && vec(cam.up))) return undefined;
  return { ...(m as object), type: "uhd-viewer:snapshot" } as ViewerSnapshotMessage;
}
