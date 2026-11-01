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

import type { CameraState, ExplodeState, InterfaceDirection, LabelKind, LiveKey, LoadingFacts, NamedView, SectionPlane, Vec3, ViewSelection, ViewState, ViewThemeChoice, Visibility, WritableKey } from "../../api";
import { parseRecord } from "../annot/record";

export type { CameraState, ExplodeState, InterfaceDirection, LabelKind, LiveKey, LoadingFacts, NamedView, SectionPlane, Vec3, ViewSelection, ViewState, ViewThemeChoice, Visibility, WritableKey };

export const VIEW_STATE_SCHEMA = "uhd-viewer.view-state/v1" satisfies ViewState["schema"];
/** Bumped when a field changes meaning; `parseViewState` migrates older ones. */
export const VIEW_STATE_VERSION = 1;

/** Top-level keys a writer may set. */
export const WRITABLE_KEYS = ["camera", "selection", "highlight", "isolation", "visibility", "direction", "sections", "explode", "placements", "theme", "namedViews", "annotations"] as const satisfies readonly WritableKey[];
/** Top-level keys only the view sets. */
export const READ_ONLY_KEYS = ["schema", "scope", "loading", "quality"] as const;

/** The live, per-user part (`.protoboard/local/viewer-state.json`, the webview's own state). */
export const LIVE_KEYS = ["camera", "selection", "highlight", "isolation", "visibility", "direction", "sections", "explode", "placements", "theme"] as const satisfies readonly LiveKey[];
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
    placements: {},
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
/** Lists of paths are capped: a batch stays small (collaboration D14). DEFAULT. */
export const MAX_PATHS = 2000;
/** DEFAULT. */
export const MAX_NAMED_VIEWS = 100;
/** DEFAULT. */
export const MAX_NAME = 80;
/**
 * Annotation caps (wave 2 gate; DEFAULT, the same as W3-B's renderer limits in `../annot/record.ts`): one record
 * at most 4096 bytes of JSON, at most 500 records, and 512 kB for the whole list.
 */
export const MAX_ANNOTATION_BYTES = 4096;
export const MAX_ANNOTATIONS = 500;
export const MAX_ANNOTATIONS_BYTES = 512 * 1024;
/** DEFAULT (W3-D's request, PB-1187): display-side placements one view keeps; a matrix is rigid within this. */
export const MAX_PLACEMENTS = 64;
export const RIGID_TOLERANCE = 1e-6;

/** A placement override: a rigid row-major 4x4 (rotation orthonormal with det +1, last row 0 0 0 1), who placed it, the faces. */
export function checkPlacement(v: unknown): string | undefined {
  if (!isObj(v)) return "a placement must be an object { matrix, by, faces? }";
  const m = v.matrix;
  if (!Array.isArray(m) || m.length !== 16 || !m.every(finite)) return "placement.matrix must be 16 finite numbers (row-major)";
  const r = (i: number, j: number) => m[i * 4 + j] as number;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      let dot = 0;
      for (let k = 0; k < 3; k++) dot += r(i, k) * r(j, k);
      if (Math.abs(dot - (i === j ? 1 : 0)) > RIGID_TOLERANCE) return "placement.matrix must be rigid (an orthonormal rotation)";
    }
  const det = r(0, 0) * (r(1, 1) * r(2, 2) - r(1, 2) * r(2, 1)) - r(0, 1) * (r(1, 0) * r(2, 2) - r(1, 2) * r(2, 0)) + r(0, 2) * (r(1, 0) * r(2, 1) - r(1, 1) * r(2, 0));
  if (Math.abs(det - 1) > RIGID_TOLERANCE) return "placement.matrix must not mirror (determinant +1)";
  if (Math.abs(m[12] as number) > RIGID_TOLERANCE || Math.abs(m[13] as number) > RIGID_TOLERANCE || Math.abs(m[14] as number) > RIGID_TOLERANCE || Math.abs((m[15] as number) - 1) > RIGID_TOLERANCE) return "placement.matrix's last row must be 0 0 0 1";
  if (typeof v.by !== "string" || !v.by || v.by.length > 120 || /[\u0000-\u001f]/.test(v.by)) return "placement.by must say who placed it (at most 120 characters)";
  // W4-D: `frame` names the scope a placement was made in when the root frame was unknown (DEFAULT); `method` says
  // which face primitive made it
  if (v.frame !== undefined && !isPath(v.frame)) return "placement.frame must be an instance path (the scope it was made in)";
  if (v.method !== undefined && (typeof v.method !== "string" || v.method.length > 40)) return "placement.method must be a short name";
  if (v.faces !== undefined) {
    const f = v.faces;
    if (!isObj(f) || !isPath(f.part) || !isPath(f.target) || !Number.isInteger(f.face) || !Number.isInteger(f.targetFace)) return "placement.faces must be { part, face, target, targetFace }";
  }
  return undefined;
}

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
  // an instance path (W3-C, PB-1186): at most 512 characters, no control characters (NUL included)
  if (v.scope !== undefined && !isPath(v.scope)) return "section.scope must be an instance path of at most 512 characters";
  return undefined;
}

export function checkExplode(v: unknown): string | undefined {
  if (!isObj(v)) return "explode must be an object";
  if (!finite(v.t) || v.t < 0 || v.t > 1) return "explode.t must be between 0 and 1";
  const step = v.step;
  // one type everywhere (wave 2 gate item 6): a step is its string id, never an index
  if (step !== null && step !== undefined && !(typeof step === "string" && step.length > 0 && step.length <= 200 && !/[\u0000-\u001f]/.test(step))) return "explode.step must be a step id (a string such as \"fit:arm_fl_mount\") or null";
  return undefined;
}

/**
 * The annotations list: each entry a record W3-B's renderer accepts (`parseRecord`: id, kind, ref, author),
 * within the caps; ids unique.
 */
export function checkAnnotations(v: unknown): string | undefined {
  if (!Array.isArray(v)) return "annotations must be a list of records";
  if (v.length > MAX_ANNOTATIONS) return `at most ${MAX_ANNOTATIONS} annotations`;
  let total = 0;
  const ids = new Set<string>();
  for (const [i, a] of v.entries()) {
    let size: number;
    try {
      size = JSON.stringify(a).length;
    } catch {
      return `annotations[${i}] is not plain JSON`;
    }
    if (size > MAX_ANNOTATION_BYTES) return `annotations[${i}] is ${size} bytes of JSON; one record is at most ${MAX_ANNOTATION_BYTES}`;
    total += size;
    const p = parseRecord(a);
    if ("error" in p) return `annotations[${i}]: ${p.error}`;
    if (ids.has(p.record.id)) return `annotations: the id "${p.record.id}" is used twice`;
    ids.add(p.record.id);
  }
  if (total > MAX_ANNOTATIONS_BYTES) return `annotations are ${total} bytes of JSON in all; at most ${MAX_ANNOTATIONS_BYTES}`;
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
    case "placements": {
      if (!isObj(v)) return "placements must be an object by instance path";
      if (Object.keys(v).length > MAX_PLACEMENTS) return `at most ${MAX_PLACEMENTS} placements`;
      for (const [p, x] of Object.entries(v)) {
        if (!isPath(p) || !validName(p.split("/").pop() ?? p)) return `placement "${p.slice(0, 40)}" needs an instance path`;
        const e = checkPlacement(x);
        if (e) return `placement "${p}": ${e}`;
      }
      return undefined;
    }
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
      return checkAnnotations(v);
    case "theme":
      // absent (undefined) follows the host
      return v === undefined || THEMES.includes(v as ViewThemeChoice) ? undefined : `theme must be ${THEMES.join(", ")}, or removed to follow the host`;
  }
}

const THEMES: ViewThemeChoice[] = ["light", "dark", "system"];

/** A deep copy of plain data (state values are JSON). */
export const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
/** Same plain data. */
export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
