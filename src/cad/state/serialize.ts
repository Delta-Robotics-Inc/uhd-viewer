/**
 * The view state in and out (PB-1178): a versioned JSON form, the split
 * between what is saved per user and what is deliberate presentation, and the
 * URL parameters.
 *
 * - `liveState`: camera, selection, highlight, isolation, visibility,
 *   direction, sections, explode. The host saves it (after the viewer's
 *   400 ms debounce) to `.protoboard/local/viewer-state.json`, which git
 *   ignores, and a VS Code webview keeps it in its own state.
 * - `presentation`: named views and annotations. Written to the display file
 *   (`spatial.views`, `spatial.annotations`) only on an explicit save, so a
 *   camera drag never touches a committed file.
 */
import type { ViewerStateFile } from "../../api";
import { LIVE_KEYS, PRESENTATION_KEYS, VIEW_STATE_SCHEMA, VIEW_STATE_VERSION, WRITABLE_KEYS, checkValue, clone, type InterfaceDirection, type LabelKind, type LiveKey, type NamedView, type SectionPlane, type Vec3, type ViewSelection, type ViewState, type WritableKey } from "./schema";

/** The JSON form of a view state (all keys, read-only facts included, for an observer). */
export interface SerializedViewState extends Partial<ViewState> {
  schema: typeof VIEW_STATE_SCHEMA;
  version: number;
}

export function serializeViewState(state: ViewState): SerializedViewState {
  return { ...clone(state), schema: VIEW_STATE_SCHEMA, version: VIEW_STATE_VERSION };
}

/**
 * The writable keys of a serialized state that pass their checks; keys that
 * do not are listed in `dropped` (a file from an older or newer viewer
 * restores what it can). Read-only keys are ignored.
 */
export function parseViewState(data: unknown): { values: Partial<Pick<ViewState, WritableKey>>; dropped: string[] } | { error: string } {
  if (!data || typeof data !== "object" || Array.isArray(data)) return { error: "a view state must be an object" };
  const d = data as Record<string, unknown>;
  if (d.schema !== undefined && d.schema !== VIEW_STATE_SCHEMA) {
    // v1 is the first: anything else is not ours to guess at
    return { error: `unknown view-state schema ${String(d.schema)} (this viewer reads ${VIEW_STATE_SCHEMA})` };
  }
  const values: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const k of WRITABLE_KEYS) {
    if (!(k in d)) continue;
    let v = d[k];
    // a step saved by index (before the wave 2 gate's one type) is not a step id: read as none
    if (k === "explode" && v && typeof v === "object" && typeof (v as { step?: unknown }).step === "number") v = { ...(v as object), step: null };
    // visibility may be partial: fill it from the defaults' keys the caller keeps
    if (checkValue(k, v)) dropped.push(k);
    else values[k] = clone(v);
  }
  return { values: values as Partial<Pick<ViewState, WritableKey>>, dropped };
}

export function liveState(state: ViewState): Pick<ViewState, LiveKey> {
  return Object.fromEntries(LIVE_KEYS.map((k) => [k, clone(state[k])])) as Pick<ViewState, LiveKey>;
}

export function presentation(state: ViewState): Pick<ViewState, "namedViews" | "annotations"> {
  return Object.fromEntries(PRESENTATION_KEYS.map((k) => [k, clone(state[k])])) as Pick<ViewState, "namedViews" | "annotations">;
}

// ---- the per-user file -------------------------------------------------------

/** `.protoboard/local/viewer-state.json` (git-ignored): the live state per scope the viewer showed. */
export const VIEWER_STATE_FILE_SCHEMA = "protoboard.viewer-state/v0" satisfies ViewerStateFile["schema"];
export type { ViewerStateFile };



export function viewerStateFile(byScope: Record<string, Partial<Pick<ViewState, LiveKey>>>, scope: string): ViewerStateFile {
  return { schema: VIEWER_STATE_FILE_SCHEMA, viewState: VIEW_STATE_SCHEMA, scope, scopes: clone(byScope) };
}

/** The scopes of a saved file, each with only the keys that pass their checks; undefined for anything that is not one. */
export function parseViewerStateFile(data: unknown): ViewerStateFile | undefined {
  if (!data || typeof data !== "object") return undefined;
  const d = data as Partial<ViewerStateFile>;
  if (d.schema !== VIEWER_STATE_FILE_SCHEMA || d.viewState !== VIEW_STATE_SCHEMA || !d.scopes || typeof d.scopes !== "object") return undefined;
  const scopes: ViewerStateFile["scopes"] = {};
  for (const [scope, v] of Object.entries(d.scopes)) {
    const p = parseViewState(v);
    if ("error" in p) continue;
    scopes[scope] = Object.fromEntries(Object.entries(p.values).filter(([k]) => (LIVE_KEYS as readonly string[]).includes(k))) as Partial<Pick<ViewState, LiveKey>>;
  }
  return { schema: VIEWER_STATE_FILE_SCHEMA, viewState: VIEW_STATE_SCHEMA, scope: typeof d.scope === "string" ? d.scope : "", scopes };
}

// ---- the display file's presentation keys --------------------------------------

/** The named views and annotations a display file carries (`spatial.views`, `spatial.annotations`), the ones that pass their checks. */
export function presentationFromDisplay(display: { spatial?: Record<string, unknown> } | undefined): Pick<ViewState, "namedViews" | "annotations"> {
  const views = display?.spatial?.views;
  const namedViews: Record<string, NamedView> = {};
  if (views && typeof views === "object" && !Array.isArray(views)) {
    for (const [n, v] of Object.entries(views)) if (!checkValue("namedViews", { [n]: v })) namedViews[n] = clone(v as NamedView);
  }
  const ann = display?.spatial?.annotations;
  return { namedViews, annotations: Array.isArray(ann) ? clone(ann) : [] };
}

// ---- URL parameters ----------------------------------------------------------

/** How the view opens, from the URL: the camera by azimuth, elevation and distance about `up`, or exactly (`cam`). */
export interface UrlOpening {
  az?: number;
  el?: number;
  dist?: number;
  /** `cam=px,py,pz,tx,ty,tz[,ux,uy,uz]`: an exact camera (mm). */
  camera?: { position: Vec3; target: Vec3; up?: Vec3 };
  /** `view3d=<name>`: a named view of the display file (`view` is the page's: diagram or 3d). */
  view?: string;
  focus: boolean;
  present: boolean;
  /** `chrome=none` (document mode, PB-1109): the model alone, no toolbar, caption, notes or panels. */
  chrome?: "none";
  /** `panel=none`: no inspector panel. */
  panel?: "none";
  /** `zoom=<n>`: the opening fit comes `n` times closer (0.1 to 10). */
  zoom?: number;
}

const list = (v: string | null) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const num = (v: string | null) => (v !== null && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

/**
 * The view state the URL asks for (the parameters the 3D view always read:
 * explode, dir, labels, labelkinds, frames, wires, hardware, findings, xray,
 * section, at, flip, body, iface, mate, harness, component; and new ones:
 * hide, isolate, highlight), and how it opens (az, el, dist, cam, view3d,
 * focus, present). Only what the URL names is returned.
 */
export function fromUrlParams(params: URLSearchParams): { values: Partial<Pick<ViewState, WritableKey>>; visibility: Partial<ViewState["visibility"]>; opening: UrlOpening } {
  const values: Partial<Pick<ViewState, WritableKey>> = {};
  const visibility: Partial<ViewState["visibility"]> = {};
  if (params.has("explode")) values.explode = { t: (num(params.get("explode")) ?? 0) > 0 ? 1 : 0, step: null };
  const dir = params.get("dir");
  if (dir === "feature" || dir === "artifact" || dir === "procedural") values.direction = dir as InterfaceDirection;
  if (params.has("labels")) visibility.labels = params.get("labels") === "1";
  if (params.has("labelkinds")) visibility.labelKinds = list(params.get("labelkinds")).filter((k): k is LabelKind => ["module", "harness", "interface", "finding"].includes(k));
  if (params.has("frames")) visibility.frames = params.get("frames") === "1";
  if (params.has("wires")) visibility.wires = params.get("wires") !== "0";
  if (params.has("hardware")) visibility.hardware = params.get("hardware") !== "0";
  if (params.has("findings")) visibility.findings = params.get("findings") !== "0";
  if (params.has("xray")) visibility.xray = params.get("xray") === "1";
  if (params.has("hide")) visibility.hidden = list(params.get("hide"));
  const section = params.get("section");
  if (section) {
    const axis = Math.max(0, ["x", "y", "z"].indexOf(section)) as 0 | 1 | 2;
    const at = Math.min(1, Math.max(0, num(params.get("at")) ?? 0.5));
    const plane: SectionPlane = { axis, at, ...(params.get("flip") ? { flip: params.get("flip") === "1" } : {}) };
    values.sections = [plane];
  }
  const sel: ViewSelection = {};
  for (const k of ["body", "iface", "mate", "harness", "component"] as const) {
    const v = params.get(k);
    if (v !== null) sel[k] = v;
  }
  if (Object.keys(sel).length) values.selection = sel;
  if (params.has("isolate")) values.isolation = list(params.get("isolate"));
  if (params.has("highlight")) values.highlight = list(params.get("highlight"));
  const opening: UrlOpening = { focus: params.get("focus") === "1", present: params.get("present") === "1" };
  for (const k of ["az", "el", "dist"] as const) {
    const v = num(params.get(k));
    if (v !== undefined) opening[k] = v;
  }
  const cam = list(params.get("cam")).map(Number);
  if ((cam.length === 6 || cam.length === 9) && cam.every(Number.isFinite)) {
    opening.camera = { position: [cam[0], cam[1], cam[2]], target: [cam[3], cam[4], cam[5]], ...(cam.length === 9 ? { up: [cam[6], cam[7], cam[8]] as Vec3 } : {}) };
  }
  const view = params.get("view3d");
  if (view) opening.view = view;
  if (params.get("chrome") === "none") opening.chrome = "none";
  if (params.get("panel") === "none") opening.panel = "none";
  const zoom = num(params.get("zoom"));
  if (zoom !== undefined && zoom >= 0.1 && zoom <= 10) opening.zoom = zoom;
  return { values, visibility, opening };
}

/** URL parameters that open the view as `state` shows it (the 3D view's own; render knobs and `view` are the page's). */
export function toUrlParams(state: ViewState): URLSearchParams {
  const p = new URLSearchParams();
  const r = (n: number) => String(Math.round(n * 1000) / 1000);
  if (state.explode.t > 0) p.set("explode", "1");
  if (state.direction !== "feature") p.set("dir", state.direction);
  const v = state.visibility;
  if (v.labels) p.set("labels", "1");
  if (v.labelKinds.join(",") !== "module,harness") p.set("labelkinds", v.labelKinds.join(","));
  if (v.frames) p.set("frames", "1");
  if (!v.wires) p.set("wires", "0");
  if (!v.hardware) p.set("hardware", "0");
  if (v.findings !== null) p.set("findings", v.findings ? "1" : "0");
  if (v.xray) p.set("xray", "1");
  if (v.hidden.length) p.set("hide", v.hidden.join(","));
  const s = state.sections[0];
  if (s) {
    p.set("section", ["x", "y", "z"][s.axis]);
    p.set("at", r(s.at));
    if (s.flip !== undefined) p.set("flip", s.flip ? "1" : "0");
  }
  for (const [k, val] of Object.entries(state.selection)) if (val !== undefined) p.set(k, val);
  if (state.isolation) p.set("isolate", state.isolation.join(","));
  if (state.highlight.length) p.set("highlight", state.highlight.join(","));
  if (state.camera) p.set("cam", [...state.camera.position, ...state.camera.target, ...state.camera.up].map(r).join(","));
  return p;
}
