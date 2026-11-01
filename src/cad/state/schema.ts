/**
 * One view-state schema for the 3D view (PB-1178). The URL, the host
 * messages (`src/host/*`), `window.__cad` and the live-tab bridge all read
 * and write this one object, through the store in `./store.ts`.
 *
 * Units: millimetres, the root's coordinates (UHD: Z up). The camera is the
 * scene's own (CadView draws CAD coordinates directly; the glTF metres and Y
 * up are converted when a model loads, `cadWrapper` in ../scene.ts).
 *
 * Three kinds of field:
 * - live view state (camera, selection, visibility, sections, explode):
 *   per user, saved on a debounce to `.protoboard/local/viewer-state.json`
 *   by the host (./serialize.ts `liveState`), never committed;
 * - deliberate presentation (named views, annotations): written to the
 *   project's display file only on an explicit save (`presentation`);
 * - read-only facts the view reports (scope, loading, quality): set by the
 *   view itself, refused when a writer names them.
 */

import type { CameraState, ExplodeState, InterfaceDirection, LabelKind, LiveKey, LoadingFacts, NamedView, SectionPlane, Vec3, ViewSelection, ViewState, Visibility, WritableKey } from "../../api";

export type { CameraState, ExplodeState, InterfaceDirection, LabelKind, LiveKey, LoadingFacts, NamedView, SectionPlane, Vec3, ViewSelection, ViewState, Visibility, WritableKey };

export const VIEW_STATE_SCHEMA = "uhd-viewer.view-state/v1" satisfies ViewState["schema"];
/** Bumped when a field changes meaning; `parseViewState` migrates older ones. */
export const VIEW_STATE_VERSION = 1;

/** Top-level keys a writer may set. */
export const WRITABLE_KEYS = ["camera", "selection", "highlight", "isolation", "visibility", "direction", "sections", "explode", "namedViews", "annotations"] as const satisfies readonly WritableKey[];
/** Top-level keys only the view sets. */
export const READ_ONLY_KEYS = ["schema", "scope", "loading", "quality"] as const;

/** The live, per-user part (`.protoboard/local/viewer-state.json`, the webview's own state). */
export const LIVE_KEYS = ["camera", "selection", "highlight", "isolation", "visibility", "direction", "sections", "explode"] as const satisfies readonly LiveKey[];
/** The deliberate part (the display file, on an explicit save). */
export const PRESENTATION_KEYS = ["namedViews", "annotations"] as const;

export const DEFAULT_LABEL_KINDS: LabelKind[] = ["module", "harness"];

export function defaultViewState(scope = ""): ViewState {
  return {
    schema: VIEW_STATE_SCHEMA,
    scope,
    camera: null,
    selection: {},
    highlight: [],
    isolation: null,
    visibility: { labels: false, labelKinds: [...DEFAULT_LABEL_KINDS], frames: false, wires: true, hardware: true, findings: null, xray: false, hidden: [] },
    direction: "feature",
    sections: [],
    explode: { t: 0, step: null },
    namedViews: {},
    annotations: [],
    loading: { phase: "loading", total: 0, done: 0, failed: 0 },
    quality: { mode: null },
  };
}

// ---- checks (every write is checked before anything is applied) ---------------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(finite);
const isPath = (v: unknown): v is string => typeof v === "string" && v.length <= 512 && !/[\u0000-\u001f]/.test(v);
const LABEL_KINDS: LabelKind[] = ["module", "harness", "interface", "finding"];
const DIRECTIONS: InterfaceDirection[] = ["feature", "artifact", "procedural"];
/** Lists of paths are capped: a batch stays small (collaboration D14). */
export const MAX_PATHS = 2000;
export const MAX_NAMED_VIEWS = 100;
export const MAX_NAME = 80;

export function checkCamera(v: unknown): string | undefined {
  if (v === null) return undefined;
  if (!isObj(v)) return "camera must be an object or null";
  if (!isVec3(v.position) || !isVec3(v.target) || !isVec3(v.up)) return "camera needs position, target and up as [x, y, z] numbers";
  if (v.fov !== undefined && !(finite(v.fov) && v.fov > 0 && v.fov < 180)) return "camera.fov must be between 0 and 180 degrees";
  if (v.ortho !== undefined && !(isObj(v.ortho) && finite(v.ortho.zoom) && v.ortho.zoom > 0)) return "camera.ortho.zoom must be a positive number";
  const [a, b] = [v.position as Vec3, v.target as Vec3];
  if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) return "camera.position and camera.target must differ";
  if ((v.up as Vec3).every((x) => x === 0)) return "camera.up must not be zero";
  return undefined;
}

export function checkSelection(v: unknown): string | undefined {
  if (!isObj(v)) return "selection must be an object";
  for (const [k, x] of Object.entries(v)) {
    if (!["body", "iface", "component", "mate", "harness"].includes(k)) return `selection has an unknown key "${k}"`;
    if (x !== undefined && !isPath(x)) return `selection.${k} must be a path`;
  }
  return undefined;
}

const checkPaths = (name: string, v: unknown, nullable = false): string | undefined => {
  if (nullable && v === null) return undefined;
  if (!Array.isArray(v) || !v.every(isPath)) return `${name} must be a list of instance paths${nullable ? " or null" : ""}`;
  if (v.length > MAX_PATHS) return `${name} names more than ${MAX_PATHS} paths`;
  return undefined;
};

export function checkSection(v: unknown): string | undefined {
  if (!isObj(v)) return "a section must be an object";
  if (v.axis !== 0 && v.axis !== 1 && v.axis !== 2) return "section.axis must be 0, 1 or 2";
  if (!finite(v.at) || v.at < 0 || v.at > 1) return "section.at must be between 0 and 1";
  if (v.flip !== undefined && typeof v.flip !== "boolean") return "section.flip must be true or false";
  return undefined;
}

export function checkExplode(v: unknown): string | undefined {
  if (!isObj(v)) return "explode must be an object";
  if (!finite(v.t) || v.t < 0 || v.t > 1) return "explode.t must be between 0 and 1";
  const step = v.step;
  if (step !== null && step !== undefined && !(Number.isInteger(step) && (step as number) >= 0) && !(typeof step === "string" && step.length > 0 && step.length <= 200)) return "explode.step must be a step id, a step number or null";
  return undefined;
}

export function checkVisibility(v: unknown): string | undefined {
  if (!isObj(v)) return "visibility must be an object";
  for (const k of ["labels", "frames", "wires", "hardware", "xray"]) if (v[k] !== undefined && typeof v[k] !== "boolean") return `visibility.${k} must be true or false`;
  if (v.findings !== undefined && v.findings !== null && typeof v.findings !== "boolean") return "visibility.findings must be true, false or null";
  if (v.labelKinds !== undefined && !(Array.isArray(v.labelKinds) && v.labelKinds.every((k) => LABEL_KINDS.includes(k as LabelKind)))) return `visibility.labelKinds must list ${LABEL_KINDS.join(", ")}`;
  const unknown = Object.keys(v).filter((k) => !["labels", "labelKinds", "frames", "wires", "hardware", "findings", "xray", "hidden"].includes(k));
  if (unknown.length) return `visibility has unknown key(s) ${unknown.join(", ")}`;
  return v.hidden !== undefined ? checkPaths("visibility.hidden", v.hidden) : undefined;
}

export function checkNamedView(v: unknown): string | undefined {
  if (!isObj(v)) return "a named view must be an object";
  const cam = checkCamera(v.camera);
  if (cam || v.camera === null) return cam ?? "a named view needs a camera";
  if (v.explode !== undefined && checkExplode(v.explode)) return checkExplode(v.explode);
  if (v.sections !== undefined && (!Array.isArray(v.sections) || v.sections.some((s) => checkSection(s)))) return "namedView.sections must be section planes";
  if (v.hidden !== undefined && checkPaths("namedView.hidden", v.hidden)) return checkPaths("namedView.hidden", v.hidden);
  if (v.isolation !== undefined && checkPaths("namedView.isolation", v.isolation, true)) return checkPaths("namedView.isolation", v.isolation, true);
  if (v.by !== undefined && !(typeof v.by === "string" && v.by.length <= 120)) return "namedView.by must be a short text";
  return undefined;
}

export const validName = (n: unknown): n is string =>
  typeof n === "string" && n.trim().length > 0 && n.length <= MAX_NAME && !/[\u0000-\u001f]/.test(n) && !["__proto__", "constructor", "prototype"].includes(n); // not a key that reaches an object's prototype (wave 2 gate)

/** Checks a whole value for one top-level key; undefined when it is fine. */
export function checkValue(key: WritableKey, v: unknown): string | undefined {
  switch (key) {
    case "camera":
      return checkCamera(v);
    case "selection":
      return checkSelection(v);
    case "highlight":
      return checkPaths("highlight", v);
    case "isolation":
      return checkPaths("isolation", v, true);
    case "visibility":
      return checkVisibility(v);
    case "direction":
      return DIRECTIONS.includes(v as InterfaceDirection) ? undefined : `direction must be ${DIRECTIONS.join(", ")}`;
    case "sections":
      if (!Array.isArray(v) || v.length > 3) return "sections must be a list of at most 3 planes";
      return v.map(checkSection).find(Boolean);
    case "explode":
      return checkExplode(v);
    case "namedViews": {
      if (!isObj(v)) return "namedViews must be an object";
      if (Object.keys(v).length > MAX_NAMED_VIEWS) return `at most ${MAX_NAMED_VIEWS} named views`;
      for (const [n, x] of Object.entries(v)) {
        if (!validName(n)) return `named view "${n}" needs a name of 1 to ${MAX_NAME} characters`;
        const e = checkNamedView(x);
        if (e) return `named view "${n}": ${e}`;
      }
      return undefined;
    }
    case "annotations":
      return Array.isArray(v) && v.length <= 500 ? undefined : "annotations must be a list (at most 500)";
  }
}

/** A deep copy of plain data (state values are JSON). */
export const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
/** Same plain data. */
export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
