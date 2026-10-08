/**
 * The host message protocol (README, "Host messages"): checking what arrives
 * over `postMessage`, and which origins a frame's parent may have. Nothing
 * here names a host.
 */
import type { ViewerEvent, ViewerHostMessage } from "../api";

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
    default:
      return undefined;
  }
}

/** A viewer → host event (for a host or a relay telling them from other messages). */
export const isViewerEvent = (data: unknown): data is ViewerEvent =>
  Boolean(data) && typeof data === "object" && ["uhd-viewer:ready", "uhd-viewer:selectionChanged", "uhd-viewer:openSource", "uhd-viewer:openArtifact", "uhd-viewer:openModule", "uhd-viewer:openPair"].includes((data as { type?: string }).type ?? "");

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
