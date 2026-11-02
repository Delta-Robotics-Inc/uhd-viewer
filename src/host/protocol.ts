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
/** DEFAULT (R2-A): a `uhd-viewer:historyGo` moves at most this many places (the history keeps 50). */
export const MAX_HISTORY_DELTA = 50;

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
      if (!(c && typeof c === "object" && !Array.isArray(c) && typeof c.action === "string")) return undefined;
      // R2-B's two commands (R2 integration): checked here, so a malformed one is refused at the door
      if (c.action === "mode" || c.action === "scope") return parseModeScope(c) ? { type: m.type, command: c as { action: string } } : undefined;
      return { type: m.type, command: c as { action: string } };
    }
    // the quality curve's settings (PB-1176): only the known keys, each in its range (wave 2 gate item 7)
    case "uhd-viewer:quality": {
      const config = parseQualityConfig(m.config);
      return config ? { type: m.type, config } : undefined;
    }
    // a check row clicked in the host's Inspector (gate R1, R1-E's D7): pin that finding's callout in the 3D view
    case "uhd-viewer:openFinding": {
      const short = (v: unknown): v is string => isString(v) && v.length > 0 && v.length <= 1024;
      if (!short(m.id) || !short(m.code)) return undefined;
      const path = m.path === undefined ? undefined : pathOf(m.path) ?? null;
      if (path === null || (path !== undefined && path.length > 1024)) return undefined;
      return path === undefined ? { type: m.type, id: m.id, code: m.code } : { type: m.type, id: m.id, code: m.code, path };
    }
    // R2-A (F1): a host header's back (-1) and forward (+1) through the viewer's own history
    case "uhd-viewer:historyGo":
      return Number.isInteger(m.delta) && m.delta !== 0 && Math.abs(m.delta as number) <= MAX_HISTORY_DELTA ? { type: m.type, delta: m.delta as number } : undefined;
    // R2-A: what a frame's parent takes (it answers `uhd-viewer:navigate`)
    case "uhd-viewer:hostCapabilities":
      if (m.navigate !== undefined && typeof m.navigate !== "boolean") return undefined;
      // R2 integration: `history: true` says the parent draws back and forward of its own (the view leaves out its pair)
      if (m.history !== undefined && typeof m.history !== "boolean") return undefined;
      return { type: m.type, ...(m.navigate !== undefined ? { navigate: m.navigate } : {}), ...(m.history !== undefined ? { history: m.history } : {}) };
    // the person takes everything back from the agents (PB-1196, D9)
    case "uhd-viewer:takeOver":
      return { type: m.type };
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

/**
 * A `uhd-viewer:navigate` event as a relay should pass it on (R2-A): the target is a module path or a model artifact
 * (strings of 1 to 1024 characters; a path may be "" for the root), `how` replace or newTab. Undefined otherwise.
 */
export function parseNavigateEvent(data: unknown): Extract<ViewerEvent, { type: "uhd-viewer:navigate" }> | undefined {
  if (!data || typeof data !== "object") return undefined;
  const m = data as Record<string, unknown>;
  const str = (v: unknown, empty = false): v is string => typeof v === "string" && v.length <= 1024 && (empty || v.length > 0) && !/[\u0000-\u001f]/.test(v);
  if (m.type !== "uhd-viewer:navigate" || (m.how !== "replace" && m.how !== "newTab")) return undefined;
  if (m.view !== undefined && m.view !== "3d") return undefined;
  if (m.from !== undefined && !str(m.from, true)) return undefined;
  const t = m.target as Record<string, unknown> | undefined;
  if (!t || typeof t !== "object") return undefined;
  let target: Extract<ViewerEvent, { type: "uhd-viewer:navigate" }>["target"];
  if ("module" in t) {
    if (!str(t.module, true)) return undefined;
    target = { module: t.module };
  } else {
    const a = t.model as Record<string, unknown> | undefined;
    if (!a || typeof a !== "object" || !str(a.defId) || !str(a.artifactId) || (a.path !== undefined && !str(a.path, true))) return undefined;
    target = { model: { defId: a.defId, artifactId: a.artifactId, ...(a.path !== undefined ? { path: a.path as string } : {}) } };
  }
  return { type: "uhd-viewer:navigate", target, how: m.how, ...(m.view ? { view: "3d" as const } : {}), ...(m.from !== undefined ? { from: m.from as string } : {}) };
}

/** A viewer → host event (for a host or a relay telling them from other messages). */
export const isViewerEvent = (data: unknown): data is ViewerEvent =>
  Boolean(data) && typeof data === "object" && ["uhd-viewer:ready", "uhd-viewer:selectionChanged", "uhd-viewer:openSource", "uhd-viewer:openArtifact", "uhd-viewer:openModule", "uhd-viewer:openPair", "uhd-viewer:inspect", "uhd-viewer:viewState", "uhd-viewer:presentation", "uhd-viewer:bridgeReply", "uhd-viewer:sequenceState", "uhd-viewer:presence", "uhd-viewer:navigate", "uhd-viewer:history", "uhd-viewer:export", "uhd-viewer:setting"].includes((data as { type?: string }).type ?? "");

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

/**
 * The quality curve's settings a host may send (PB-1176; wave 2 gate item 7), each in its range (DEFAULT ranges):
 * `enabled` true or false; `tauMs` (recovery time constant) 10 to 5000 ms; `budgetMs` (frame budget) 1 to 100 ms.
 * Anything else, or a value out of range, refuses the message.
 */
export const QUALITY_RANGES = { tauMs: [10, 5000], budgetMs: [1, 100] } as const;

export function parseQualityConfig(c: unknown): Record<string, unknown> | undefined {
  if (!c || typeof c !== "object" || Array.isArray(c)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c as Record<string, unknown>)) {
    if (k === "enabled") {
      if (typeof v !== "boolean") return undefined;
      out.enabled = v;
    } else if (k === "tauMs" || k === "budgetMs") {
      const [lo, hi] = QUALITY_RANGES[k];
      if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) return undefined;
      out[k] = v;
    } else return undefined;
  }
  return Object.keys(out).length ? out : undefined;
}

/** DEFAULT: a snapshot sent inline as a data URL is at most this many characters (about 6 MB of PNG). */
export const MAX_SNAPSHOT_DATA_URL = 8 * 1024 * 1024;

/** Hosts of VS Code webview resources (`asWebviewUri`): `https://file+.vscode-resource.vscode-cdn.net/...`. */
const WEBVIEW_HOST = /(^|\.)vscode-cdn\.net$|(^|\.)vscode-resource\.vscode-cdn\.net$/i;

/**
 * Image URLs a snapshot may name (wave 2 gate): a path on the page's own origin (relative, `/x`, or an absolute
 * URL whose origin is the page's), a `blob:` of the page, a VS Code webview resource (`vscode-webview-resource:`,
 * `vscode-resource:`, `https://*.vscode-cdn.net`), or a PNG data URL of at most `MAX_SNAPSHOT_DATA_URL` characters.
 * Never another site (the view would fetch it), never `//host` (protocol-relative).
 */
export function snapshotUrlAllowed(url: string, pageOrigin: string | undefined = typeof location === "undefined" ? undefined : location.origin): boolean {
  // browsers drop tabs and newlines (and trim control characters) before parsing a URL: `/<tab>/host` is `//host`
  // (gate 3). Nothing we serve has one, so any control character or space refuses the URL.
  if (/[\u0000- \u007f]/.test(url)) return false;
  if (/^data:/i.test(url)) return /^data:image\/png;base64,[A-Za-z0-9+/=]*$/.test(url) && url.length <= MAX_SNAPSHOT_DATA_URL;
  // a path on the page's origin; never `//host` nor `/\host` (browsers read a backslash as a slash: gate 3)
  if (/^(\.\/|\/(?![/\\]))/.test(url)) return !url.includes("\\");
  if (/^(vscode-webview-resource|vscode-resource):/i.test(url)) return true;
  if (/^blob:/i.test(url)) {
    try {
      return !!pageOrigin && new URL(url.slice(5)).origin === pageOrigin;
    } catch {
      return false;
    }
  }
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const u = new URL(url);
    return (!!pageOrigin && pageOrigin !== "null" && u.origin === pageOrigin) || (u.protocol === "https:" && WEBVIEW_HOST.test(u.hostname));
  } catch {
    return false;
  }
}

/** A `uhd-viewer:snapshot` message (PB-1180), checked; undefined for anything else. */
export function parseSnapshotMessage(m: Record<string, unknown>, pageOrigin?: string): ViewerSnapshotMessage | undefined {
  if (m.schema !== "protoboard.snapshot/v0" || typeof m.imageUrl !== "string" || typeof m.level !== "string" || typeof m.view !== "string") return undefined;
  if (!snapshotUrlAllowed(m.imageUrl, pageOrigin ?? (typeof location === "undefined" ? undefined : location.origin))) return undefined;
  const cam = m.camera as Record<string, unknown> | undefined;
  const vec = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x));
  if (cam !== undefined && !(cam && vec(cam.position) && vec(cam.target) && vec(cam.up))) return undefined;
  return { ...(m as object), type: "uhd-viewer:snapshot" } as ViewerSnapshotMessage;
}

/**
 * The sequence player's `mode` and `scope` commands (R2-B, H2; additive): `{ action: "mode", mode?: "radial" |
 * "sequence", instant?: boolean }` (absent mode: the player's DEFAULT, radial when a plan exists) and `{ action:
 * "scope", scope?: string, instant?: boolean }` (an instance path in the view's scope, at most 512 characters, no
 * control characters; absent: the whole assembly).
 */
export function parseModeScope(c: Record<string, unknown>): boolean {
  if (c.instant !== undefined && typeof c.instant !== "boolean") return false;
  if (c.action === "mode") return c.mode === undefined || c.mode === "radial" || c.mode === "sequence";
  if (c.action === "scope") return c.scope === undefined || (typeof c.scope === "string" && c.scope.length <= 512 && !/[\u0000-\u001f]/.test(c.scope));
  return false;
}
