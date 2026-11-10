/**
 * The view critic (PB-1188): `reviewView(observation, intent)` lists what an
 * agent should fix before it sends a capture to a person: the subject out of
 * frame, too small, hidden behind another part, cut away by a section or
 * hidden by isolation; labels overlapping each other or running off the
 * canvas; nothing selected to say what to look at; too many parts isolated;
 * the model exploded while measuring.
 *
 * Pure functions over `window.__cad.observe()` (plus the view state from
 * `__cad.get()`, the label boxes the annotation layer drew, and pick probes
 * the caller ran): nothing here touches the scene, so W3-A can run it in
 * the CLI as `view_review` on what the bridge returned. Occlusion needs one
 * pick per subject from the camera to the subject's bounds centre:
 * `reviewProbes` says where (fractions of the canvas), the caller picks
 * there (`__cad.pick(fx, fy)`), and passes the hits back in `picks`.
 *
 * Coordinates: bounds and the camera in assembly mm (Z up), label boxes in
 * CSS pixels from the canvas's top left.
 */

type Vec3 = [number, number, number];
type Bounds = [Vec3, Vec3];

export interface ReviewNode {
  id: string;
  instancePath: string;
  kind: string;
  bounds: Bounds | null;
  visible: boolean;
  placeholder?: boolean;
}

/** A label as drawn: its box (x, y, width, height, CSS px) and what it points at. */
export interface ReviewLabel {
  id: string;
  rect: [number, number, number, number];
  target?: string;
}

export interface ReviewPick {
  subject: string;
  /** Where the pick was made (fractions of the canvas from the top left). */
  at: [number, number];
  /** What the pick hit (`__cad.pick` result), null for nothing. */
  hit: { instancePath?: string } | null;
}

export interface ReviewObservation {
  nodes: ReviewNode[];
  camera: { position: Vec3; target: Vec3; up: Vec3; fov: number };
  selection?: Record<string, string | undefined>;
  /** The canvas in CSS px (DEFAULT 1440 x 900 when not given: the render service's default capture). */
  canvas?: { width: number; height: number };
  /** The view state (`__cad.get()`): highlight, isolation, sections, explode, hidden. */
  state?: {
    highlight?: string[];
    isolation?: string[] | null;
    sections?: { axis: 0 | 1 | 2; at: number; flip?: boolean }[];
    explode?: { t: number; step?: string | number | null };
    visibility?: { hidden?: string[] };
  };
  labels?: ReviewLabel[];
  picks?: ReviewPick[];
}

export interface ReviewIntent {
  /** What the capture is about: instance paths. */
  subject?: string | string[];
  /** The capture shows a measurement (assembly distances are only true assembled). */
  measuring?: boolean;
  /** DEFAULT 0.005: the subject must cover at least this share of the canvas. */
  minCoverage?: number;
  /** DEFAULT 24: and be at least this many pixels on its longer side. */
  minSidePx?: number;
  /** DEFAULT 6: more parts isolated than this is too many to read. */
  maxIsolated?: number;
  /** DEFAULT true when there is a subject: something should be selected or highlighted. */
  expectSelection?: boolean;
  /** DEFAULT 8: labels closer than this to the canvas edge are reported (info). */
  edgeMarginPx?: number;
}

export type ReviewCode =
  | "SUBJECT_NOT_FOUND"
  | "SUBJECT_HIDDEN"
  | "SUBJECT_NOT_IN_FRAME"
  | "SUBJECT_CLIPPED"
  | "SUBJECT_TOO_SMALL"
  | "SUBJECT_OCCLUDED"
  | "SUBJECT_NOT_ISOLATED"
  | "SECTION_HIDES_SUBJECT"
  | "SECTION_CUTS_SUBJECT"
  | "LABEL_OVERLAP"
  | "LABEL_OFF_CANVAS"
  | "LABEL_NEAR_EDGE"
  | "LABEL_COVERS_SUBJECT"
  | "NOTHING_SELECTED"
  | "TOO_MANY_ISOLATED"
  | "EXPLODED_WHILE_MEASURING"
  | "OCCLUSION_NOT_CHECKED";

export interface ReviewFinding {
  code: ReviewCode;
  severity: "error" | "warning" | "info";
  message: string;
  /** What to do about it. */
  fix: string;
  subject?: string;
  data?: Record<string, unknown>;
}

export const REVIEW_DEFAULTS = { canvas: { width: 1440, height: 900 }, minCoverage: 0.005, minSidePx: 24, maxIsolated: 6, edgeMarginPx: 8 } as const;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Inside `path` (itself or below it). */
export const within = (path: string, root: string) => root === "" || path === root || path.startsWith(`${root}/`);

/** The screen box of world bounds under a perspective camera (CSS px), and how much of it is in front of the camera. */
export interface Projected {
  /** [x, y, width, height] of the corners in front of the camera, CSS px (may extend past the canvas). */
  rect: [number, number, number, number] | null;
  /** The bounds centre on screen, fractions of the canvas (null: behind the camera). */
  centre: [number, number] | null;
  /** Corners behind the camera (0..8). */
  behind: number;
}

export function projectBounds(camera: ReviewObservation["camera"], canvas: { width: number; height: number }, b: Bounds): Projected {
  const f = unit(sub(camera.target, camera.position));
  const r = unit(cross(f, camera.up));
  const u = cross(r, f);
  const ty = Math.tan(((camera.fov || 45) * Math.PI) / 360);
  const tx = ty * (canvas.width / canvas.height);
  const proj = (p: Vec3): [number, number] | null => {
    const d = sub(p, camera.position);
    const z = dot(d, f);
    if (z <= 1e-6) return null;
    const x = dot(d, r) / z / tx;
    const y = dot(d, u) / z / ty;
    return [((x + 1) / 2) * canvas.width, ((1 - y) / 2) * canvas.height];
  };
  let behind = 0;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const cx of [b[0][0], b[1][0]])
    for (const cy of [b[0][1], b[1][1]])
      for (const cz of [b[0][2], b[1][2]]) {
        const p = proj([cx, cy, cz]);
        if (!p) behind++;
        else {
          xs.push(p[0]);
          ys.push(p[1]);
        }
      }
  const c = proj([(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2, (b[0][2] + b[1][2]) / 2]);
  return {
    rect: xs.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)] : null,
    centre: c ? [c[0] / canvas.width, c[1] / canvas.height] : null,
    behind,
  };
}

/** The union of the bounds of the nodes that make up a subject (the node itself, else everything under its path). */
export function subjectBounds(nodes: ReviewNode[], subject: string): { bounds: Bounds | null; nodes: ReviewNode[] } {
  const exact = nodes.filter((n) => n.instancePath === subject || n.id === subject);
  const set = exact.length ? exact : nodes.filter((n) => within(n.instancePath, subject));
  let b: Bounds | null = null;
  for (const n of set) {
    if (!n.bounds) continue;
    b = b ? [[Math.min(b[0][0], n.bounds[0][0]), Math.min(b[0][1], n.bounds[0][1]), Math.min(b[0][2], n.bounds[0][2])], [Math.max(b[1][0], n.bounds[1][0]), Math.max(b[1][1], n.bounds[1][1]), Math.max(b[1][2], n.bounds[1][2])]] : [[...n.bounds[0]], [...n.bounds[1]]];
  }
  return { bounds: b, nodes: set };
}

const subjectsOf = (intent: ReviewIntent) => (intent.subject === undefined ? [] : Array.isArray(intent.subject) ? intent.subject : [intent.subject]);
const canvasOf = (o: ReviewObservation) => o.canvas ?? REVIEW_DEFAULTS.canvas;

/** Where to pick to test each subject for occlusion: its bounds centre on screen (fractions of the canvas). */
export function reviewProbes(obs: ReviewObservation, intent: ReviewIntent): { subject: string; at: [number, number] }[] {
  const out: { subject: string; at: [number, number] }[] = [];
  for (const s of subjectsOf(intent)) {
    const { bounds } = subjectBounds(obs.nodes, s);
    if (!bounds) continue;
    const p = projectBounds(obs.camera, canvasOf(obs), bounds);
    if (p.centre && p.centre.every((v) => v >= 0 && v <= 1)) out.push({ subject: s, at: [Math.round(p.centre[0] * 1e4) / 1e4, Math.round(p.centre[1] * 1e4) / 1e4] });
  }
  return out;
}

const area = (r: [number, number, number, number]) => Math.max(0, r[2]) * Math.max(0, r[3]);
function overlap(a: [number, number, number, number], b: [number, number, number, number]): number {
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

/** The findings for a view about to be captured, worst first. */
export function reviewView(obs: ReviewObservation, intent: ReviewIntent = {}): ReviewFinding[] {
  const out: ReviewFinding[] = [];
  const canvas = canvasOf(obs);
  const st = obs.state ?? {};
  const subjects = subjectsOf(intent);
  const visibleNodes = obs.nodes.filter((n) => n.visible && n.bounds);
  const subjectRects = new Map<string, [number, number, number, number]>();

  for (const s of subjects) {
    const { bounds, nodes } = subjectBounds(obs.nodes, s);
    if (!nodes.length || !bounds) {
      out.push({ code: "SUBJECT_NOT_FOUND", severity: "error", subject: s, message: `"${s}" is not drawn in this view`, fix: "check the instance path (observe().nodes), or open the level that draws it" });
      continue;
    }
    const hiddenBy = (st.visibility?.hidden ?? []).find((h) => within(s, h));
    if (hiddenBy !== undefined) {
      out.push({ code: "SUBJECT_HIDDEN", severity: "error", subject: s, message: `"${s}" is hidden (by "${hiddenBy}")`, fix: "show it: remove it from visibility.hidden", data: { hiddenBy } });
      continue;
    }
    if (st.isolation && !st.isolation.some((p) => within(s, p) || within(p, s))) {
      out.push({ code: "SUBJECT_NOT_ISOLATED", severity: "error", subject: s, message: `"${s}" is outside the isolation (${st.isolation.length} part(s) drawn alone)`, fix: `add "${s}" to the isolation, or clear it` });
      continue;
    }
    if (nodes.every((n) => !n.visible)) {
      out.push({ code: "SUBJECT_HIDDEN", severity: "error", subject: s, message: `"${s}" is not visible`, fix: "show it (visibility, isolation, or the level it is drawn on)" });
      continue;
    }
    const p = projectBounds(obs.camera, canvas, bounds);
    const r = p.rect;
    const inside = r ? overlap(r, [0, 0, canvas.width, canvas.height]) : 0;
    if (!r || p.behind === 8 || inside === 0) {
      out.push({ code: "SUBJECT_NOT_IN_FRAME", severity: "error", subject: s, message: `"${s}" is outside the view`, fix: "frame it (camera on its bounds), then capture" });
      continue;
    }
    subjectRects.set(s, r);
    const shown = inside / Math.max(1e-9, area(r));
    if (p.behind > 0 || shown < 0.9)
      out.push({ code: "SUBJECT_CLIPPED", severity: "warning", subject: s, message: `only ${Math.round(Math.min(1, shown) * 100)} % of "${s}" is on the canvas`, fix: "pull the camera back or re-centre on the subject", data: { onCanvas: Math.round(shown * 1000) / 1000 } });
    const coverage = inside / (canvas.width * canvas.height);
    const minCov = intent.minCoverage ?? REVIEW_DEFAULTS.minCoverage;
    const minSide = intent.minSidePx ?? REVIEW_DEFAULTS.minSidePx;
    if (coverage < minCov || Math.max(r[2], r[3]) < minSide)
      out.push({ code: "SUBJECT_TOO_SMALL", severity: "warning", subject: s, message: `"${s}" covers ${(coverage * 100).toFixed(2)} % of the view (${Math.round(Math.max(r[2], r[3]))} px across)`, fix: "zoom in on it (frame its bounds), or crop the capture to it", data: { coverage: Math.round(coverage * 1e5) / 1e5, sidePx: Math.round(Math.max(r[2], r[3])) } });

    // sections: the first plane cuts (as the view does today); a plane is placed across the bounds of what is drawn
    const sec = st.sections?.[0];
    if (sec && visibleNodes.length) {
      const lo = Math.min(...visibleNodes.map((n) => n.bounds![0][sec.axis]));
      const hi = Math.max(...visibleNodes.map((n) => n.bounds![1][sec.axis]));
      const c = lo + sec.at * (hi - lo);
      // kept: the + side with flip, else the side away from the camera
      const keepPlus = sec.flip !== undefined ? sec.flip : obs.camera.position[sec.axis] < c;
      const [a, b] = [bounds[0][sec.axis], bounds[1][sec.axis]];
      const gone = keepPlus ? b < c : a > c;
      const cut = a < c && b > c;
      if (gone) out.push({ code: "SECTION_HIDES_SUBJECT", severity: "error", subject: s, message: `the section on axis ${"xyz"[sec.axis]} at ${Math.round(c * 100) / 100} mm removes "${s}"`, fix: "move or flip the section plane, or clear sections", data: { plane: c, keep: keepPlus ? "+" : "-" } });
      else if (cut) out.push({ code: "SECTION_CUTS_SUBJECT", severity: "info", subject: s, message: `the section cuts through "${s}"`, fix: "fine for an inside view; otherwise move the plane", data: { plane: c } });
    }

    // occlusion: the caller's pick at the subject's centre
    const probe = obs.picks?.find((q) => q.subject === s);
    if (probe) {
      const hit = probe.hit?.instancePath;
      if (hit === undefined) out.push({ code: "OCCLUSION_NOT_CHECKED", severity: "info", subject: s, message: `the pick at "${s}"'s centre hit nothing (a hole or a gap there)`, fix: "nothing to fix; occlusion is not known" });
      else if (!within(hit, s) && !within(s, hit)) out.push({ code: "SUBJECT_OCCLUDED", severity: "warning", subject: s, message: `"${s}" is behind "${hit}" from this camera`, fix: `turn the camera, hide or x-ray "${hit}", or isolate "${s}"`, data: { by: hit } });
    } else out.push({ code: "OCCLUSION_NOT_CHECKED", severity: "info", subject: s, message: `occlusion of "${s}" was not probed`, fix: "pick at reviewProbes() and pass the hits in `picks`" });
  }

  // selection
  const selected = Object.values(obs.selection ?? {}).filter((v) => v !== undefined && v !== "");
  const highlighted = st.highlight ?? [];
  if ((intent.expectSelection ?? subjects.length > 0) && !selected.length && !highlighted.length)
    out.push({ code: "NOTHING_SELECTED", severity: "warning", message: "nothing is selected or highlighted: the person cannot tell what to look at", fix: subjects.length ? `select or highlight ${subjects.map((s) => `"${s}"`).join(", ")}` : "select or highlight the part the message is about" });

  // isolation
  const maxIso = intent.maxIsolated ?? REVIEW_DEFAULTS.maxIsolated;
  if (st.isolation && st.isolation.length > maxIso)
    out.push({ code: "TOO_MANY_ISOLATED", severity: "warning", message: `${st.isolation.length} parts are isolated (more than ${maxIso})`, fix: "isolate only what the message is about, or show everything and highlight instead", data: { isolated: st.isolation.length } });

  // measuring on an exploded model
  if (intent.measuring && (st.explode?.t ?? 0) > 1e-3)
    out.push({ code: "EXPLODED_WHILE_MEASURING", severity: "error", message: `the model is exploded (t = ${st.explode!.t}) while a measurement is shown: distances between parts are not the assembled ones`, fix: "assemble (explode t = 0) before measuring or capturing a measurement" });

  // labels
  const labels = obs.labels ?? [];
  const margin = intent.edgeMarginPx ?? REVIEW_DEFAULTS.edgeMarginPx;
  for (let i = 0; i < labels.length; i++) {
    const a = labels[i];
    const inside = overlap(a.rect, [0, 0, canvas.width, canvas.height]);
    if (inside < area(a.rect) - 1e-6)
      out.push({ code: "LABEL_OFF_CANVAS", severity: inside === 0 ? "error" : "warning", subject: a.target, message: `label "${a.id}" ${inside === 0 ? "is off the canvas" : "runs off the canvas"}`, fix: "move the label inward, or reframe so its anchor is further from the edge", data: { label: a.id } });
    else if (a.rect[0] < margin || a.rect[1] < margin || a.rect[0] + a.rect[2] > canvas.width - margin || a.rect[1] + a.rect[3] > canvas.height - margin)
      out.push({ code: "LABEL_NEAR_EDGE", severity: "info", subject: a.target, message: `label "${a.id}" is within ${margin} px of the edge`, fix: "fine for a capture; it may be cropped by a viewer", data: { label: a.id } });
    for (let j = i + 1; j < labels.length; j++) {
      const b = labels[j];
      const o = overlap(a.rect, b.rect);
      if (o > 1) out.push({ code: "LABEL_OVERLAP", severity: "warning", message: `labels "${a.id}" and "${b.id}" overlap (${Math.round(o)} px²)`, fix: "spread the labels (leaders), drop one, or zoom so the anchors part", data: { labels: [a.id, b.id], px2: Math.round(o) } });
    }
    for (const [s, r] of subjectRects) {
      if (a.target === s) continue;
      const o = overlap(a.rect, r);
      if (o > 0.5 * area(a.rect) && o > 0.25 * area(r)) out.push({ code: "LABEL_COVERS_SUBJECT", severity: "warning", subject: s, message: `label "${a.id}" covers much of "${s}"`, fix: "move the label off the subject", data: { label: a.id } });
    }
  }

  const rank = { error: 0, warning: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** True when a view has no errors or warnings (infos allowed): ready to send. */
export const reviewPasses = (findings: ReviewFinding[]) => findings.every((f) => f.severity === "info");
