/**
 * The callout and DRC marker layer (PB-1184). Two halves:
 *
 * - in the scene (`group`, added to the scene handle's overlay group):
 *   anchor dots and severity markers as camera-facing sprites of a constant
 *   pixel size, depth-tested, so the GPU hides a dot behind geometry with no
 *   test of ours; a 30 % "ghost" copy without depth test shows where a hidden
 *   one is. Rings, boxes and crosshairs are lines, depth-tested the same way;
 *   a ring sits on the camera side of its part's bounding sphere so the part
 *   itself (a board under a chip) never cuts it.
 * - on the page (`root`): label sheets, option A leaders (./leader.ts),
 *   arrows, pins, hover targets for the markers and presence chips. Only open
 *   labels are tested for occlusion (a ray from the camera to the anchor
 *   against every drawn part but the anchored one, three-mesh-bvh): a label
 *   whose anchor is hidden retracts (its leader is never drawn through the
 *   part) and its anchor shows as a ghost.
 *
 * Everything is recomputed from the records on each frame the view draws
 * (render on demand: frames are drawn only when something moved), so a label
 * follows its part through explode, a camera move and a hot swap. The reveal
 * (intent, leader scan, card unfold) runs as CSS transitions, so it needs no
 * frames of its own. Text from records is set with textContent only.
 */
import * as THREE from "three";
import { authorLabel, type AnnotRecord } from "./record";
import { anchorKey, findingSummary, type DrcMarker } from "./drc";
import type { FindingAnchors, FindingSeverity } from "./findings-anchors";
import { leaderPath, polylineLength, type Box, type Pt } from "./leader";
import { placeLabels, screenBox, type PlaceItem } from "./place";
import { anchorOnPart, markerPx, surfacePoint, towardCamera, worldPerPx, type PartHit } from "./resolve";
import { CALLOUT_RADIUS_PX, DRC_COLOURS, LEADER_PX, LONG_HOVER_MS, REVEAL_MS, SEVERITY_VAR, drawMarker, ensureAnnotStyles, markerSvg, svgNode } from "./style";
import { attachWheelForward, canvasIn } from "./wheel";

/**
 * Break opportunities in long tokens (walkthrough M10): a zero-width space after "/", "." and "_" so an instance
 * path ("pcb/controller/sensors/i2c0_sda.ps.pin_4") wraps at its separators instead of being clipped mid-token.
 * Text only (set with textContent); the aria-label keeps the plain string.
 */
export const breakable = (s: string): string => s.replace(/([/._])(?=\S)/g, "$1\u200b");

export { svgNode } from "./style";

export interface AnnotHost {
  /** The part a ref names (null: nothing drawn holds it: the record is an orphan). */
  resolve(ref: string): PartHit | null;
  /** The nearest hit on `roots` along a world ray (the part's own surface). */
  pickOn(ray: THREE.Ray, roots: THREE.Object3D[]): THREE.Vector3 | undefined;
  /**
   * The nearest drawn part along a world ray (occlusion): the mesh hit and the distance. `prepare` is called
   * once per frame before the rays of that frame (the host can gather the drawn meshes once).
   */
  firstHit(ray: THREE.Ray, maxDistance?: number, exclude?: Set<THREE.Object3D>): { object: THREE.Object3D; distance: number; point: THREE.Vector3 } | undefined;
  prepare?: () => void;
  onFinding?: (id: string, action: "open" | "close" | "hover") => void;
  /**
   * A click on a marker or its card (walkthrough D3: "click opens the inspector"): the host shows the finding's
   * detail in the Inspector (the view sends its `uhd-viewer:inspect` message for `ref`; R1-E wires the Inspector).
   */
  onInspect?: (findingId: string, ref: string | undefined) => void;
  onLookAt?: (ref: string) => void;
  onDismiss?: (recordId: string) => void;
}

/** A chip near a part: who is working there (W3-A's presence intents). */
export interface PresenceChip {
  /** Who: "claude", an agent session name. */
  who: string;
  ref: string;
  /** "is working on" (default), "is looking at" ... (shown as given, plain text). */
  intent?: string;
  /** What it is doing (the lease's purpose or its last batch's label): the chip's tooltip. */
  label?: string;
}

export interface AnnotInput {
  records: AnnotRecord[];
  markers: DrcMarker[];
  /** Findings whose cards are pinned open (a click, the control, "open all"). */
  open: Set<string>;
  presence: PresenceChip[];
  /** Ghost copies of hidden markers and dots (the control's toggle). */
  ghosts: boolean;
  /** Reveal animations (off in document mode and with reduced motion: labels show at once). */
  motion: boolean;
  /**
   * Whether markers may look for their part's surface now (default true). Finding it raycasts the part, which builds
   * its BVH: on ClientX 11 builds, 177 ms, in the middle of the model's load, which put time to settled from 2.35 s
   * to 2.8-3.1 s (wave R1 gate). The host passes false until the view has settled; a marker without its own point
   * and not yet anchored waits until then (DEFAULT).
   */
  anchorParts?: boolean;
}

export interface AnnotStatus {
  id: string;
  kind: "callout" | "mark" | "arrow" | "finding";
  status: "placed" | "pinned" | "occluded" | "offscreen" | "orphan" | "hidden";
  anchorPx?: [number, number];
  labelBox?: Box;
  /** What it points at (instance path from the shown module). */
  ref?: string;
}

/** DEFAULT (gate R1): after the host allows it (the view settled), markers wait this long before looking for their part's surface; a frame drawn later anchors at once. */
export const ANCHOR_DELAY_MS = 400;

/** DEFAULT (PB-1184): open callouts above this many collapse to numbered pins (round 1 said about 8; 12 is the brief's drone test). */
export const MAX_OPEN_CALLOUTS = 12;
/**
 * DEFAULT: while the camera keeps moving, the occlusion test runs on at most this many open labels per frame (the
 * ones tested longest ago, and any new one); once the camera stops, on all of them (the view draws a frame more).
 */
export const OCCLUSION_PER_FRAME = 3;
/**
 * Where on a part a label's anchor may sit (fractions of its box from the centre, DEFAULT): the centre first, then
 * points toward its corners and faces. The first one the camera sees on the part itself is the anchor ("slides to
 * a visible point of the same part"); none seen: the part is hidden and its label retracts.
 */
export const ANCHOR_CANDIDATES: [number, number, number][] = [
  [0, 0, 0],
  [0, 0, 0.45],
  [0.3, 0.3, 0.3],
  [-0.3, 0.3, 0.3],
  [0.3, -0.3, 0.3],
  [-0.3, -0.3, 0.3],
  [0.4, 0, 0],
  [-0.4, 0, 0],
  [0, 0.4, 0],
  [0, -0.4, 0],
  [0.3, 0.3, -0.3],
  [-0.3, -0.3, -0.3],
  // the edges of a flat part peeking out (a flight controller under its top plate)
  [0.47, 0.47, 0.5],
  [-0.47, 0.47, 0.5],
  [0.47, -0.47, 0.5],
  [-0.47, -0.47, 0.5],
  [0.47, 0, 0.5],
  [-0.47, 0, 0.5],
  [0, 0.47, 0.5],
  [0, -0.47, 0.5],
];
/** DEFAULT: dot and marker sizes in CSS px. */
export const DOT_PX = 7;
/**
 * A DRC marker's smallest size on screen (walkthrough D1: markers were tiny on a busy board). It grows with the
 * part's size on screen (resolve.ts markerPx) up to MARKER_MAX_PX. DEFAULT 16 and 26 px (R1-C).
 */
export const MARKER_PX = 16;
export const MARKER_MAX_PX = 26;
/** The marker's stem: from the dot on the part's surface up to the marker, in CSS px (walkthrough D1). DEFAULT 12 (R1-C). */
export const STEM_PX = 12;
/** The terminal dot where the stem meets the part. DEFAULT 5 px (R1-C). */
export const TERMINAL_DOT_PX = 5;

interface LabelView {
  id: string;
  kind: "callout" | "finding";
  el: HTMLDivElement;
  path: SVGPathElement;
  content: string;
  w: number;
  h: number;
  slot?: string;
  shown: boolean;
  removeTimer?: ReturnType<typeof setTimeout>;
  seen: boolean;
}

interface SpritePair {
  key: string;
  live: THREE.Sprite;
  ghost: THREE.Sprite;
  tex: string;
}

const SVGNS = "http://www.w3.org/2000/svg";
const texCache = new Map<string, THREE.CanvasTexture>();

function spriteTexture(kind: "dot" | FindingSeverity, colour: string, count = 1): THREE.CanvasTexture {
  const key = `${kind}|${colour}|${count}`;
  let t = texCache.get(key);
  if (t) return t;
  const px = 64;
  const canvas = typeof document !== "undefined" ? document.createElement("canvas") : undefined;
  if (canvas) {
    canvas.width = canvas.height = px;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      if (kind === "dot") {
        ctx.beginPath();
        ctx.arc(px / 2, px / 2, px / 2 - 6, 0, Math.PI * 2);
        ctx.fillStyle = colour;
        ctx.fill();
        ctx.lineWidth = 6;
        ctx.strokeStyle = "rgba(10,10,10,0.85)";
        ctx.stroke();
      } else drawMarker(ctx, kind, colour, px, count);
    }
  }
  t = new THREE.CanvasTexture(canvas ?? (undefined as unknown as HTMLCanvasElement));
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 1;
  texCache.set(key, t);
  return t;
}

function makeSprite(tex: THREE.Texture, depth: boolean): THREE.Sprite {
  const m = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: depth, depthWrite: false, sizeAttenuation: false, opacity: depth ? 1 : 0.3, toneMapped: false });
  const s = new THREE.Sprite(m);
  s.renderOrder = depth ? 20 : 19;
  s.userData.noBatch = true;
  s.userData.annot = true;
  s.frustumCulled = false;
  return s;
}

/** A CSS colour as a hex string THREE and canvas both read (resolves oklch and variables through the canvas). */
let probe: CanvasRenderingContext2D | null | undefined;
export function cssColour(el: Element | null, varName: string, fallback: string): string {
  if (!el || typeof document === "undefined" || typeof getComputedStyle === "undefined") return fallback;
  const span = document.createElement("span");
  span.style.color = `var(${varName}, ${fallback})`;
  span.style.display = "none";
  el.appendChild(span);
  const css = getComputedStyle(span).color;
  span.remove();
  if (probe === undefined) probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!probe || !css) return fallback;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = "#000";
  probe.fillStyle = css;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

export class AnnotLayer {
  readonly root: HTMLDivElement;
  readonly group = new THREE.Group();
  private svg: SVGSVGElement;
  private host: AnnotHost;
  private input: AnnotInput = { records: [], markers: [], open: new Set(), presence: [], ghosts: true, motion: true };
  private labels = new Map<string, LabelView>();
  private dots = new Map<string, SpritePair>();
  private markerSprites = new Map<string, SpritePair>();
  private hits = new Map<string, HTMLButtonElement>();
  private lines = new Map<string, THREE.Object3D>();
  private pins = new Map<string, HTMLButtonElement>();
  private chips = new Map<string, HTMLDivElement>();
  private arrows = new Map<string, { line: SVGPathElement; head: SVGPathElement }>();
  private hovered: string | undefined;
  private hoverTimer: ReturnType<typeof setTimeout> | undefined;
  /** The hover tier of the hovered marker's card (walkthrough D3): the title only, then the one-line description. */
  private hoverTier: "short" | "long" = "short";
  private longTimer: ReturnType<typeof setTimeout> | undefined;
  /** A marker's point on its part, in its body's frame (found once; follows explode and moves), by marker key. */
  private markerAnchors = new Map<string, { local: THREE.Vector3; obj: string }>();
  private anchorTimer: ReturnType<typeof setTimeout> | undefined;
  /** When markers may look for their part's surface (gate R1): ANCHOR_DELAY_MS after the view first allowed it. */
  private anchorAt: number | undefined;
  private stems = new Map<string, THREE.Mesh>();
  private drawnMarkers = 0;
  private wheelOff: () => void;
  /** Where wheel events over labels go (the renderer's canvas; found in the container when unset). */
  wheelTarget: EventTarget | undefined;
  private occluded = new Map<string, boolean>();
  /** A callout's anchor as last found: in its body's frame (so it follows the part between tests), and which candidate. */
  private anchorCache = new Map<string, { local: THREE.Vector3; idx: number }>();
  /** The last frame's placement input and result (`__cad.annotations()` debugging). */
  debug: { items: PlaceItem[]; pinned: string[]; nan?: unknown[] } = { items: [], pinned: [] };
  private nan: unknown[] = [];
  private testedAt = new Map<string, number>();
  /** The camera position the last full occlusion pass ran at. */
  private fullKey = "";
  private lastCamera = "";
  private status: AnnotStatus[] = [];
  /** Draw the next frame's labels in place, with no reveal (stills, captures). */
  snap = false;
  /** Screen areas labels keep off (floating chrome, the inspector). */
  margins = { top: 56, bottom: 60, left: 52, right: 16 };
  obstacles: Box[] = [];
  colours = { accent: "#5aa9ff", dark: true, drc: Object.fromEntries(Object.entries(DRC_COLOURS).map(([k, v]) => [k, v.dark])) as Record<FindingSeverity, string> };
  /** Placement times (ms) of recent frames: the measurement the brief asks for. */
  readonly times: { place: number[]; occlusion: number[]; total: number[] } = { place: [], occlusion: [], total: [] };

  constructor(container: HTMLElement, host: AnnotHost) {
    ensureAnnotStyles(container.ownerDocument);
    this.host = host;
    this.root = container.ownerDocument.createElement("div");
    this.root.className = "cad-annot";
    this.svg = container.ownerDocument.createElementNS(SVGNS, "svg");
    this.svg.classList.add("annot-ink");
    this.root.appendChild(this.svg);
    container.appendChild(this.root);
    this.group.name = "annotations";
    this.group.userData.noBatch = true;
    this.root.addEventListener("keydown", (e) => this.onKey(e));
    // wheel over a sheet, pin or marker zooms the view (walkthrough D2): forwarded to the canvas's controls
    this.wheelOff = attachWheelForward(this.root, () => this.wheelTarget ?? canvasIn(container));
  }

  /** Read the theme's colours (call when the theme changes). */
  refreshColours(dark: boolean) {
    const el = this.root;
    this.colours = {
      accent: cssColour(el, "--uhd-callout-dot", cssColour(el, "--uhd-accent", dark ? "#5aa9ff" : "#1d5fd1")),
      dark,
      drc: Object.fromEntries(Object.entries(DRC_COLOURS).map(([k, v]) => [k, cssColour(el, SEVERITY_VAR[k as FindingSeverity], dark ? v.dark : v.light)])) as Record<FindingSeverity, string>,
    };
    // textures are keyed by colour: new ones are made as markers are drawn
    for (const p of [...this.dots.values(), ...this.markerSprites.values()]) p.tex = "";
    for (const o of this.lines.values()) o.traverse((x) => ((x as THREE.Line).material as THREE.LineBasicMaterial | undefined)?.color?.set(this.lineColour(x.userData.tone)));
  }

  private lineColour(tone: string | undefined) {
    return tone && tone in this.colours.drc ? this.colours.drc[tone as FindingSeverity] : tone === "neutral" ? "#8b949e" : this.colours.accent;
  }

  setInput(input: AnnotInput) {
    this.input = input;
    if (input.anchorParts === false) this.anchorAt = undefined;
    else if (input.anchorParts === true) this.anchorAt ??= performance.now() + ANCHOR_DELAY_MS;
    this.fullKey = "";
  }

  /** What each record and finding card did on the last frame (agents read it: no screenshot needed). */
  report(): AnnotStatus[] {
    return this.status.map((s) => ({ ...s }));
  }

  /** Median, 95th percentile and max of the recent placement times (ms). */
  timing() {
    const q = (xs: number[], f: number) => {
      if (!xs.length) return 0;
      const s = [...xs].sort((a, b) => a - b);
      return Math.round(s[Math.min(s.length - 1, Math.floor(f * s.length))] * 1000) / 1000;
    };
    const pack = (xs: number[]) => ({ n: xs.length, median: q(xs, 0.5), p95: q(xs, 0.95), max: q(xs, 1) });
    return { place: pack(this.times.place), occlusion: pack(this.times.occlusion), total: pack(this.times.total) };
  }

  // ---------------------------------------------------------------------------------------------

  /** Lay out and draw; call on every frame the view draws. Returns true while a frame more is needed. */
  update(camera: THREE.PerspectiveCamera, width: number, height: number): boolean {
    const t0 = performance.now();
    const doc = this.root.ownerDocument;
    camera.updateMatrixWorld();
    const camKey = `${camera.matrixWorld.elements.map((x) => x.toFixed(4)).join(",")}|${width}x${height}`;
    const cameraMoved = camKey !== this.lastCamera;
    this.lastCamera = camKey;
    const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    const toPx = (p: THREE.Vector3): [number, number, boolean] => {
      const v = p.clone().project(camera);
      // in front of the camera (the far plane does not hide a label: the view may set it after a camera move)
      const on = p.clone().sub(camPos).dot(forward) > camera.near * 0.5;
      return [((v.x + 1) / 2) * width, ((1 - v.y) / 2) * height, on];
    };
    const status: AnnotStatus[] = [];
    const keepDots = new Set<string>();
    const keepLines = new Set<string>();
    const keepLabels = new Set<string>();
    const keepPins = new Set<string>();
    const keepArrows = new Set<string>();
    const motion = this.input.motion && !this.snap;

    // ---- records: resolve every anchor ----------------------------------------------------------
    interface Live {
      id: string;
      kind: "callout" | "finding";
      anchor: THREE.Vector3;
      hit?: PartHit;
      /** Find a visible point on the part (a callout with no point of its own). */
      search?: boolean;
      px: [number, number];
      part?: Box;
      own: THREE.Object3D[];
      tone: string;
      title: string;
      rows: [string, string][];
      text?: string;
      by?: string;
      severity?: FindingSeverity;
      priority: number;
      ref?: string;
      n?: number;
      /** A finding card's one-line description (the long hover tier) and its hint. */
      description?: string;
      hint?: string;
      /** The finding a card shows (a click on the card pins it and opens it in the Inspector). */
      finding?: string;
    }
    const open: Live[] = [];
    const partBox = (hit: PartHit): Box | undefined => {
      const b = hit.box;
      if (b.isEmpty()) return undefined;
      const corners: Pt[] = [];
      for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) corners.push(toPx(new THREE.Vector3(x, y, z)) as unknown as Pt);
      return screenBox(corners.map((c) => [c[0], c[1]]));
    };
    const pickOn = (ray: THREE.Ray, roots: THREE.Object3D[]) => this.host.pickOn(ray, roots);
    let pinNo = 0;
    for (const r of this.input.records) {
      if (r.visibility === "off") {
        status.push({ id: r.id, kind: r.kind, status: "hidden" });
        continue;
      }
      const hit = this.host.resolve(r.ref);
      if (!hit) {
        status.push({ id: r.id, kind: r.kind, status: "orphan" });
        continue;
      }
      if (hit.hidden || hit.box.isEmpty()) {
        status.push({ id: r.id, kind: r.kind, status: "hidden" });
        continue;
      }
      const cachedAnchor = r.kind === "callout" && !r.point ? this.anchorCache.get(`r:${r.id}`) : undefined;
      let anchor = r.point ? new THREE.Vector3(...r.point).applyMatrix4(hit.frame) : cachedAnchor ? cachedAnchor.local.clone().applyMatrix4(hit.frame) : surfacePoint(camera, hit, pickOn);
      if (![anchor.x, anchor.y, anchor.z].every(Number.isFinite)) {
        // never draw at NaN: the box centre, and look again next frame
        this.nan.push({ id: r.id, cached: !!cachedAnchor, box: [hit.box.min.toArray(), hit.box.max.toArray()], frame: [...hit.frame.elements] });
        this.anchorCache.delete(`r:${r.id}`);
        anchor = hit.box.getCenter(new THREE.Vector3());
      }
      const [x, y, on] = toPx(anchor);
      const tone = r.tone ?? "accent";
      if (r.kind === "mark") {
        this.drawMark(r, hit, anchor, camera, height, tone, keepLines, keepDots);
        status.push({ id: r.id, kind: "mark", status: on ? "placed" : "offscreen", anchorPx: [Math.round(x), Math.round(y)] });
        if (r.shape === "pin") {
          pinNo++;
          this.pinAt(`m:${r.id}`, x, y, String(r.n ?? pinNo), r.title ?? r.ref, keepPins, on);
        }
        continue;
      }
      if (r.kind === "arrow") {
        const other = r.to !== undefined ? this.host.resolve(r.to) : null;
        if (!other) {
          status.push({ id: r.id, kind: "arrow", status: "orphan" });
          continue;
        }
        const b = r.toPoint ? new THREE.Vector3(...r.toPoint).applyMatrix4(other.frame) : surfacePoint(camera, other, pickOn);
        const [bx, by, bon] = toPx(b);
        this.dotAt(`a0:${r.id}`, anchor, camera, height, keepDots);
        this.arrowAt(r.id, [x, y], [bx, by], tone, keepArrows, on && bon);
        status.push({ id: r.id, kind: "arrow", status: on && bon ? "placed" : "offscreen", anchorPx: [Math.round(x), Math.round(y)] });
        continue;
      }
      // a callout: its anchor dot in the scene (placed after the visible-point search), its label on the page
      if (!on || x < -20 || y < -20 || x > width + 20 || y > height + 20) {
        this.dotAt(`c:${r.id}`, anchor, camera, height, keepDots);
        status.push({ id: r.id, kind: "callout", status: "offscreen", anchorPx: [Math.round(x), Math.round(y)] });
        continue;
      }
      open.push({
        id: `r:${r.id}`,
        kind: "callout",
        anchor,
        hit,
        search: !r.point,
        px: [x, y],
        part: partBox(hit),
        own: hit.objects,
        tone,
        title: r.title ?? r.ref,
        rows: r.rows ?? [],
        ...(r.text ? { text: r.text } : {}),
        by: authorLabel(r.author),
        priority: r.visibility === "hover" ? -1 : r.author === "user" ? 2 : 1,
        ref: r.ref,
        ...(r.n ? { n: r.n } : {}),
      });
    }

    // ---- DRC markers: on the part's surface, a stem up to the marker, a hover target, a card ---------
    // walkthrough D1: the marker is attached to the part (a dot on its surface, a short stem), not floating over its
    // bounds; D3: hover tiers (title, then the one-line description), a click pins the card with its raw rows
    const keepMarkers = new Set<string>();
    const keepStems = new Set<string>();
    // gate R1: finding a part's surface raycasts it (a BVH build, ~16 ms a part on ClientX's board): not while the
    // model loads, and only ANCHOR_DELAY_MS after it settled, all markers in one frame (markers drawn a few per frame
    // showed a screen-filling marker glyph in the frames between; not root-caused, R2)
    let anchorsWaiting = false;
    const now = performance.now();
    this.input.markers.forEach((m, index) => {
      const ref = m.anchor.component ?? m.anchor.body;
      const hit = this.host.resolve(ref) ?? (m.anchor.component ? this.host.resolve(m.anchor.body) : null);
      if (!hit || hit.hidden || hit.box.isEmpty()) return;
      if (!m.anchor.local && this.markerAnchors.get(m.key)?.obj !== (hit.objects[0]?.uuid ?? "")) {
        if (this.input.anchorParts === false) return;
        // a host that says when (anchorParts given): the wait, counted from when it allowed it (setInput), so a frame
        // drawn later (a capture's single frame) anchors at once; none (a test, a bare layer): at once
        if (this.anchorAt !== undefined && now < this.anchorAt) {
          anchorsWaiting = true;
          return;
        }
      }
      const p = this.markerSurface(m, hit, camera);
      keepMarkers.add(m.key);
      const box = partBox(hit);
      const size = markerPx(box ? Math.hypot(box.w, box.h) : undefined, MARKER_PX, MARKER_MAX_PX) + (this.hovered === m.key ? 4 : 0);
      const head = this.markerAt(m, p, camera, height, size, keepDots, keepStems);
      const [x, y, on] = toPx(head);
      this.hitAt(m, x, y, on, index, size);
      const pinnedFinding = m.findings.find((f) => this.input.open.has(f.id));
      const showCard = pinnedFinding ?? (this.hovered === m.key ? m.findings[0] : undefined);
      if (showCard && on) {
        const card = findingSummary(showCard);
        const tier = pinnedFinding ? "pinned" : this.hoverTier;
        const more: [string, string][] = m.findings.length > 1 ? [["MORE", `${m.findings.length - 1} more at this point`]] : [];
        open.push({
          id: `f:${m.key}`,
          kind: "finding",
          anchor: head,
          px: [x, y],
          ...(box ? { part: box } : {}),
          own: hit.objects,
          tone: showCard.severity,
          severity: showCard.severity,
          title: card.title,
          // the raw rows (AT path, BY validator, MORE n) and the full message only when pinned (walkthrough D3)
          rows: tier === "pinned" ? [...card.rows, ...more] : [],
          ...(tier === "pinned" ? { text: card.text } : {}),
          ...(tier === "long" && card.description ? { description: card.description, hint: "Click for details" } : {}),
          priority: this.hovered === m.key ? 5 : 3,
          ref,
          finding: showCard.id,
        });
      }
    });
    if (anchorsWaiting && !this.anchorTimer) {
      // a frame when the wait is over (the view renders on demand). A scene frame: the markers' sprites are added in
      // it, and a view-only frame draws the scene as it was grouped (they were not drawn, or drawn unplaced)
      this.anchorTimer = setTimeout(() => {
        this.anchorTimer = undefined;
        if (this.onSceneChange) this.onSceneChange();
        else this.onChange?.();
      }, Math.max(0, (this.anchorAt ?? now) - now) + 1);
    }
    for (const [k, pair] of this.markerSprites) if (!keepMarkers.has(k)) this.dropSprite(this.markerSprites, k, pair);
    for (const k of [...this.markerAnchors.keys()]) if (!keepMarkers.has(k)) this.markerAnchors.delete(k);
    this.drawnMarkers = keepMarkers.size;
    for (const [k, mesh] of this.stems)
      if (!keepStems.has(k)) {
        this.group.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        this.stems.delete(k);
      }
    for (const [k, b] of this.hits)
      if (!keepMarkers.has(k)) {
        b.remove();
        this.hits.delete(k);
      }

    // ---- occlusion: open labels only ------------------------------------------------------------
    const tOcc = performance.now();
    // a full pass (every open label, every candidate) for a still, and once per camera position after it stops;
    // otherwise a few labels per frame, the ones tested longest ago (a label seen for the first time always)
    const all = this.snap || (!cameraMoved && this.fullKey !== camKey);
    let pendingTest = false;
    let tested = false;
    const budget = new Set(
      open
        .filter((l) => this.occluded.has(l.id))
        .sort((a, b) => (this.testedAt.get(a.id) ?? 0) - (this.testedAt.get(b.id) ?? 0))
        .slice(0, all ? open.length : OCCLUSION_PER_FRAME)
        .map((l) => l.id),
    );
    const ownOf = (l: Live) => {
      const set = new Set<THREE.Object3D>();
      for (const o of l.own) o.traverse((x) => set.add(x));
      return set;
    };
    // the cap first (W4-D, wave 3 carry-forward): labels in priority order, and no occlusion test is spent on a
    // callout once MAX_OPEN_CALLOUTS visible ones are known (the rest collapse to pins anyway); it keeps its last result
    open.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
    let openCallouts = 0;
    for (const l of open) {
      if (l.kind === "callout" && openCallouts >= MAX_OPEN_CALLOUTS) continue;
      const fresh = !this.occluded.has(l.id);
      if (!fresh && !budget.has(l.id)) {
        if (l.kind === "callout" && !this.occluded.get(l.id)) openCallouts++;
        if (cameraMoved) pendingTest = true;
        continue;
      }
      // a test made while moving is redone once the camera stops (all candidates): the view draws one frame more
      if (!all && cameraMoved) pendingTest = true;
      this.testedAt.set(l.id, t0);
      if (!tested) this.host.prepare?.();
      tested = true;
      const own = ownOf(l);
      if (l.search && l.hit) {
        // the first candidate point the camera sees on the part itself (the last one that worked first)
        const prev = this.anchorCache.get(l.id)?.idx ?? 0;
        const b = l.hit.box;
        const c = b.getCenter(new THREE.Vector3());
        const half = b.getSize(new THREE.Vector3()).multiplyScalar(0.5);
        // while the camera moves, the first four candidates (and the last one that worked); all of them once it stops
        const order = [prev, ...ANCHOR_CANDIDATES.map((_, i) => i).filter((i) => i !== prev)].slice(0, all ? ANCHOR_CANDIDATES.length : 4);
        let found: { point: THREE.Vector3; idx: number } | undefined;
        for (const idx of order) {
          const k = ANCHOR_CANDIDATES[idx];
          const target = new THREE.Vector3(c.x + k[0] * half.x * 2, c.y + k[1] * half.y * 2, c.z + k[2] * half.z * 2);
          const dir = target.clone().sub(camPos);
          if (dir.lengthSq() < 1e-9) continue;
          const ray = new THREE.Ray(camPos.clone(), dir.normalize());
          // the part's own surface along the ray, then anything else nearer than it (only parts whose bounds come nearer)
          const mine = this.host.pickOn(ray, l.own);
          if (!mine) continue;
          const dOwn = camPos.distanceTo(mine);
          if (!this.host.firstHit(ray, dOwn - Math.max(0.2, dOwn * 0.002), own)) {
            found = { point: mine.clone(), idx };
            break;
          }
        }
        const inv = l.hit.frame.clone().invert();
        if (found) {
          l.anchor = found.point;
          this.anchorCache.set(l.id, { local: found.point.clone().applyMatrix4(inv), idx: found.idx });
          this.occluded.set(l.id, false);
        } else {
          this.anchorCache.set(l.id, { local: l.anchor.clone().applyMatrix4(inv), idx: 0 });
          this.occluded.set(l.id, true);
        }
        const [x, y] = toPx(l.anchor);
        l.px = [x, y];
      } else {
        const d = camPos.distanceTo(l.anchor);
        // a hit nearer than the anchor by more than 1 % of the distance (or 0.5 mm), on a part that is not the anchored one
        const h = this.host.firstHit(new THREE.Ray(camPos.clone(), l.anchor.clone().sub(camPos).normalize()), d - Math.max(0.5, d * 0.01), own);
        this.occluded.set(l.id, !!h);
      }
      if (l.kind === "callout" && !this.occluded.get(l.id)) openCallouts++;
    }
    if (all) this.fullKey = camKey;
    // a ring around a part whose label found no visible point: only its ghost shows (the part is hidden)
    const hiddenRefs = new Set(open.filter((l) => l.ref !== undefined && this.occluded.get(l.id)).map((l) => l.ref!));
    for (const [k, o] of this.lines)
      if (k.startsWith("ring:"))
        o.children.forEach((c, i) => {
          if (i < 2) c.visible = !hiddenRefs.has(o.userData.ref);
        });
    for (const l of open) if (l.kind === "callout") this.dotAt(`c:${l.id.slice(2)}`, l.anchor, camera, height, keepDots);
    const occMs = performance.now() - tOcc;

    // ---- cap, then place --------------------------------------------------------------------------
    open.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
    const visible = open.filter((l) => !this.occluded.get(l.id));
    const callouts = visible.filter((l) => l.kind === "callout");
    const over = new Set(callouts.slice(MAX_OPEN_CALLOUTS).map((l) => l.id));
    const toPlace = visible.filter((l) => !over.has(l.id));
    // sizes: from the DOM, read once per content change
    for (const l of toPlace) this.labelView(l, doc);
    const tPlace = performance.now();
    const items: PlaceItem[] = toPlace.map((l) => {
      const v = this.labels.get(l.id)!;
      return { id: l.id, anchor: l.px, w: v.w, h: v.h, ...(l.part ? { part: l.part } : {}), priority: l.priority, ...(v.slot ? { prev: v.slot } : {}) };
    });
    const solved = placeLabels(items, { width, height, margins: this.margins, obstacles: this.obstacles });
    this.debug = { items, pinned: solved.pinned, ...(this.nan.length ? { nan: this.nan.slice(-4) } : {}) };
    const placeMs = performance.now() - tPlace;

    // ---- draw labels ------------------------------------------------------------------------------
    for (const l of open) {
      const v = this.labels.get(l.id);
      const s = solved.placed.get(l.id);
      const recordId = l.id.startsWith("r:") ? l.id.slice(2) : undefined;
      if (this.occluded.get(l.id)) {
        if (v) this.hideLabel(v, motion);
        keepLabels.add(l.id);
        if (recordId) status.push({ id: recordId, kind: "callout", status: "occluded", anchorPx: [Math.round(l.px[0]), Math.round(l.px[1])] });
        continue;
      }
      if (!v || !s) {
        if (v) this.hideLabel(v, motion);
        keepLabels.add(l.id);
        // no legal place (or over the cap): a numbered pin with the title as its tooltip
        pinNo++;
        this.pinAt(l.id, l.px[0], l.px[1], String(l.n ?? pinNo), l.title, keepPins, true);
        if (recordId) status.push({ id: recordId, kind: "callout", status: "pinned", anchorPx: [Math.round(l.px[0]), Math.round(l.px[1])] });
        continue;
      }
      keepLabels.add(l.id);
      v.slot = s.slot;
      v.el.style.transform = `translate(${s.box.x.toFixed(1)}px, ${s.box.y.toFixed(1)}px)`;
      v.el.classList.toggle("side-l", s.side < 0);
      // the shelf tucks under the card's rounded corner (walkthrough D4: the app's radius, not a square shelf)
      const pts = s.leader.points.slice();
      const sh = pts[pts.length - 2];
      pts[pts.length - 1] = [sh[0] + s.side * Math.min(CALLOUT_RADIUS_PX + 2, s.box.w / 2), sh[1]];
      v.path.setAttribute("d", leaderPath({ ...s.leader, points: pts }));
      v.path.setAttribute("class", `annot-leader tone-${l.tone}`);
      this.showLabel(v, motion, polylineLength(s.leader.points));
      if (recordId) status.push({ id: recordId, kind: "callout", status: "placed", ...(l.ref !== undefined ? { ref: l.ref } : {}), anchorPx: [Math.round(l.px[0]), Math.round(l.px[1])], labelBox: { x: Math.round(s.box.x), y: Math.round(s.box.y), w: Math.round(s.box.w), h: Math.round(s.box.h) } });
      else status.push({ id: l.id.slice(2), kind: "finding", status: "placed", ...(l.ref !== undefined ? { ref: l.ref } : {}), anchorPx: [Math.round(l.px[0]), Math.round(l.px[1])], labelBox: { x: Math.round(s.box.x), y: Math.round(s.box.y), w: Math.round(s.box.w), h: Math.round(s.box.h) } });
    }
    for (const [id, v] of this.labels) if (!keepLabels.has(id)) this.hideLabel(v, motion, true);
    const live = new Set(open.map((l) => l.id));
    for (const id of [...this.occluded.keys()]) if (!live.has(id)) this.occluded.delete(id);
    for (const id of [...this.anchorCache.keys()]) if (!live.has(id)) this.anchorCache.delete(id);
    for (const id of [...this.testedAt.keys()]) if (!live.has(id)) this.testedAt.delete(id);
    for (const [id, p] of this.pins)
      if (!keepPins.has(id)) {
        p.remove();
        this.pins.delete(id);
      }
    for (const [id, a] of this.arrows)
      if (!keepArrows.has(id)) {
        a.line.remove();
        a.head.remove();
        this.arrows.delete(id);
      }
    for (const [k, pair] of this.dots) if (!keepDots.has(k)) this.dropSprite(this.dots, k, pair);
    for (const [k, o] of this.lines)
      if (!keepLines.has(k)) {
        this.group.remove(o);
        o.traverse((x) => {
          (x as THREE.Line).geometry?.dispose();
          ((x as THREE.Line).material as THREE.Material | undefined)?.dispose();
        });
        this.lines.delete(k);
      }

    // ---- presence chips ("claude is working on U3") ------------------------------------------------
    const keepChips = new Set<string>();
    for (const p of this.input.presence) {
      const hit = this.host.resolve(p.ref);
      if (!hit) continue;
      const box = partBox(hit);
      if (!box) continue;
      const key = `${p.who}|${p.ref}`;
      keepChips.add(key);
      let chip = this.chips.get(key);
      if (!chip) {
        chip = doc.createElement("div");
        chip.className = "annot-chip";
        this.root.appendChild(chip);
        this.chips.set(key, chip);
      }
      chip.textContent = `${p.who} ${p.intent ?? "is working on"} ${p.ref.split("/").pop()}`;
      chip.title = p.label ?? "";
      // above the part's box, else below it, never over a label
      const cw = chip.offsetWidth || 140;
      const x = Math.max(4, Math.min(width - cw - 4, box.x));
      const labelBoxes = [...solved.placed.values()].map((p) => p.box);
      const fits = (y: number) => !labelBoxes.some((b) => x < b.x + b.w && b.x < x + cw && y < b.y + b.h && b.y < y + 18);
      const y = [box.y - 22, box.y + box.h + 4, box.y + 4].find((v) => v >= 4 && v <= height - 22 && fits(v));
      chip.style.display = y === undefined ? "none" : "";
      chip.style.transform = `translate(${x.toFixed(0)}px, ${(y ?? 0).toFixed(0)}px)`;
    }
    for (const [k, c] of this.chips)
      if (!keepChips.has(k)) {
        c.remove();
        this.chips.delete(k);
      }

    this.snap = false;
    this.status = status;
    const total = performance.now() - t0;
    if (open.length || this.input.records.length) {
      push(this.times.place, placeMs);
      push(this.times.occlusion, occMs);
      push(this.times.total, total);
    }
    return pendingTest;
  }

  // ---- pieces ---------------------------------------------------------------------------------

  private sprite(map: Map<string, SpritePair>, key: string, kind: "dot" | FindingSeverity, colour: string, count = 1): SpritePair {
    let pair = map.get(key);
    const texKey = `${kind}|${colour}|${count}`;
    if (!pair) {
      const tex = spriteTexture(kind, colour, count);
      pair = { key, live: makeSprite(tex, true), ghost: makeSprite(tex, false), tex: texKey };
      this.group.add(pair.ghost, pair.live);
      map.set(key, pair);
    } else if (pair.tex !== texKey) {
      const tex = spriteTexture(kind, colour, count);
      (pair.live.material as THREE.SpriteMaterial).map = tex;
      (pair.ghost.material as THREE.SpriteMaterial).map = tex;
      pair.tex = texKey;
    }
    return pair;
  }

  private dropSprite(map: Map<string, SpritePair>, key: string, pair: SpritePair) {
    this.group.remove(pair.live, pair.ghost);
    pair.live.material.dispose();
    pair.ghost.material.dispose();
    map.delete(key);
  }

  private placeSprite(pair: SpritePair, p: THREE.Vector3, camera: THREE.PerspectiveCamera, height: number, px: number) {
    // a camera-facing quad of `px` CSS px, moved toward the camera by its own radius so a tilted surface does not cut it
    const at = towardCamera(p, camera, px / 2 + 1, height);
    const s = (px * 2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, height);
    for (const sp of [pair.live, pair.ghost]) {
      sp.position.copy(at);
      sp.scale.set(s, s, 1);
    }
    pair.ghost.visible = this.input.ghosts;
  }

  private dotAt(key: string, p: THREE.Vector3, camera: THREE.PerspectiveCamera, height: number, keep: Set<string>) {
    keep.add(key);
    this.placeSprite(this.sprite(this.dots, key, "dot", this.colours.accent), p, camera, height, DOT_PX);
  }

  /**
   * A marker's point on its part (walkthrough D1): the finding's own point when it has one, else the part's surface
   * nearest its bounds' top centre (resolve.ts anchorOnPart), found once and kept in the body's frame so it follows
   * explode and moves without sliding while the camera orbits; looked for again when the part's object changes.
   */
  private markerSurface(m: DrcMarker, hit: PartHit, camera: THREE.PerspectiveCamera): THREE.Vector3 {
    if (m.anchor.local) return new THREE.Vector3(...m.anchor.local).applyMatrix4(hit.frame);
    const obj = hit.objects[0]?.uuid ?? "";
    const cached = this.markerAnchors.get(m.key);
    if (cached && cached.obj === obj) {
      const p = cached.local.clone().applyMatrix4(hit.frame);
      if ([p.x, p.y, p.z].every(Number.isFinite)) return p;
    }
    let p = anchorOnPart(camera, hit, (ray, roots) => this.host.pickOn(ray, roots));
    if (![p.x, p.y, p.z].every(Number.isFinite)) p = hit.box.getCenter(new THREE.Vector3());
    else this.markerAnchors.set(m.key, { local: p.clone().applyMatrix4(hit.frame.clone().invert()), obj });
    return p;
  }

  /**
   * Draws a marker as a pin (walkthrough D1): a terminal dot on the part's surface, a stem `STEM_PX` long straight up
   * the screen, and the severity marker on top; each depth-tested (the ghost copies show hidden ones). Returns the
   * marker's centre in the world (the hover target and the card's leader start there).
   */
  private markerAt(m: DrcMarker, p: THREE.Vector3, camera: THREE.PerspectiveCamera, height: number, px: number, keepDots: Set<string>, keepStems: Set<string>): THREE.Vector3 {
    const colour = this.colours.drc[m.severity];
    keepDots.add(`t:${m.key}`);
    this.placeSprite(this.sprite(this.dots, `t:${m.key}`, "dot", colour), p, camera, height, TERMINAL_DOT_PX);
    const base = towardCamera(p, camera, 1, height);
    const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    const perPx = worldPerPx(camera, camPos.distanceTo(base), height);
    // the screen's up in the world (the camera's own y axis)
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    const head = base.clone().addScaledVector(up, perPx * (STEM_PX + px / 2));
    this.placeSprite(this.sprite(this.markerSprites, m.key, m.severity, colour, m.findings.length), head, camera, height, px);
    // the stem: a camera-facing quad LEADER_PX wide (a WebGL line is 1 px whatever its width), depth-tested
    keepStems.add(m.key);
    let stem = this.stems.get(m.key);
    if (!stem) {
      stem = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: colour, depthTest: true, depthWrite: false, transparent: true, toneMapped: false }));
      stem.renderOrder = 20;
      stem.frustumCulled = false;
      stem.userData.noBatch = true;
      stem.userData.annot = true;
      this.group.add(stem);
      this.stems.set(m.key, stem);
    }
    (stem.material as THREE.MeshBasicMaterial).color.set(colour);
    stem.position.copy(base).addScaledVector(up, (perPx * STEM_PX) / 2);
    stem.quaternion.setFromRotationMatrix(new THREE.Matrix4().extractRotation(camera.matrixWorld));
    stem.scale.set(perPx * LEADER_PX, perPx * STEM_PX, 1);
    stem.updateMatrixWorld();
    return head;
  }

  /** A mark: ring (a circle on the camera side of the part's bounding sphere), box (its bounds), crosshair, dot. */
  private drawMark(r: AnnotRecord, hit: PartHit, anchor: THREE.Vector3, camera: THREE.PerspectiveCamera, height: number, tone: string, keepLines: Set<string>, keepDots: Set<string>) {
    const shape = r.shape ?? "ring";
    if (shape === "dot" || shape === "pin") {
      this.dotAt(`m:${r.id}`, anchor, camera, height, keepDots);
      return;
    }
    const key = `${shape}:${r.id}`;
    keepLines.add(key);
    let obj = this.lines.get(key);
    const colour = this.lineColour(tone);
    if (!obj) {
      obj = shape === "ring" ? ringObject(colour) : shape === "box" ? boxObject(colour) : crossObject(colour);
      obj.traverse((x) => (x.userData.tone = tone));
      obj.userData.ref = r.ref;
      this.group.add(obj);
      this.lines.set(key, obj);
    }
    const sphere = hit.box.getBoundingSphere(new THREE.Sphere());
    const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    if (shape === "ring") {
      const d = camPos.distanceTo(sphere.center);
      const front = Math.min(sphere.radius, d * 0.5);
      // on the camera side of the sphere, the radius scaled so it looks the size of the sphere plus 8 px
      const at = sphere.center.clone().add(camPos.clone().sub(sphere.center).normalize().multiplyScalar(front));
      const dAt = camPos.distanceTo(at);
      const perPx = worldPerPx(camera, dAt, height);
      const radius = (sphere.radius * dAt) / Math.max(1e-6, d) + 8 * perPx;
      obj.position.copy(at);
      obj.quaternion.copy(camera.quaternion);
      obj.scale.setScalar(radius);
      // the second loop 1 px out: a 2 px line
      const outer = obj.children[1];
      if (outer) outer.scale.setScalar(1 + perPx / Math.max(1e-6, radius));
      const ghost = obj.children[2];
      if (ghost) ghost.visible = this.input.ghosts;
    } else if (shape === "box") {
      const b = hit.box;
      obj.position.copy(b.getCenter(new THREE.Vector3()));
      obj.scale.copy(b.getSize(new THREE.Vector3()).max(new THREE.Vector3(1e-3, 1e-3, 1e-3)));
    } else {
      obj.position.copy(anchor);
      obj.scale.setScalar(Math.max(sphere.radius, worldPerPx(camera, camPos.distanceTo(anchor), height) * 12));
    }
    obj.updateMatrixWorld(true);
  }

  private labelView(l: { id: string; kind: "callout" | "finding"; title: string; rows: [string, string][]; text?: string; description?: string; hint?: string; by?: string; tone: string; severity?: FindingSeverity; ref?: string; finding?: string }, doc: Document): LabelView {
    const content = JSON.stringify([l.title, l.rows, l.text, l.description, l.hint, l.by, l.tone]);
    let v = this.labels.get(l.id);
    if (!v) {
      const el = doc.createElement("div");
      el.setAttribute("role", "note");
      const path = doc.createElementNS(SVGNS, "path") as SVGPathElement;
      path.setAttribute("pathLength", "1");
      path.style.strokeDasharray = "1";
      path.style.strokeDashoffset = "1";
      this.svg.appendChild(path);
      this.root.appendChild(el);
      v = { id: l.id, kind: l.kind, el, path, content: "", w: 0, h: 0, shown: false, seen: false };
      el.className = "annot-sheet closed";
      this.labels.set(l.id, v);
    }
    if (v.removeTimer) {
      clearTimeout(v.removeTimer);
      v.removeTimer = undefined;
    }
    if (v.content !== content) {
      v.content = content;
      const el = v.el;
      el.replaceChildren();
      const title = doc.createElement("div");
      title.className = "annot-title";
      if (l.severity) title.prepend(svgNode(markerSvg(l.severity, 12)));
      const tt = doc.createElement("span");
      tt.className = "annot-title-text";
      tt.textContent = breakable(l.title);
      title.append(tt);
      el.appendChild(title);
      if (l.description) {
        const d = doc.createElement("div");
        d.className = "annot-desc";
        d.textContent = breakable(l.description);
        el.appendChild(d);
      }
      if (l.rows.length) {
        const grid = doc.createElement("div");
        grid.className = "annot-rows";
        for (const [k, val] of l.rows) {
          const kk = doc.createElement("span");
          kk.className = "annot-k";
          kk.textContent = k;
          const vv = doc.createElement("span");
          vv.className = "annot-v";
          vv.textContent = breakable(val);
          grid.append(kk, vv);
        }
        el.appendChild(grid);
      }
      if (l.text) {
        const t = doc.createElement("div");
        t.className = "annot-text";
        t.textContent = breakable(l.text);
        el.appendChild(t);
      }
      if (l.hint) {
        const hnt = doc.createElement("div");
        hnt.className = "annot-hint";
        hnt.textContent = l.hint;
        el.appendChild(hnt);
      }
      if (l.by) {
        const by = doc.createElement("div");
        by.className = "annot-by";
        by.textContent = `by ${l.by}`;
        el.appendChild(by);
      }
      el.setAttribute("aria-label", [l.title, l.description ?? "", ...l.rows.map(([a, b]) => `${a} ${b}`), l.text ?? ""].filter(Boolean).join(", "));
      el.dataset.tone = l.tone;
      el.classList.remove(...[...el.classList].filter((c) => c.startsWith("tone-")));
      el.classList.add(`tone-${l.tone}`);
      if (l.ref || l.finding) {
        el.onclick = (e) => {
          if (e.detail === 2 && l.ref) this.host.onLookAt?.(l.ref);
          // a click on a finding's card pins it and opens its detail in the Inspector (walkthrough D3)
          else if (e.detail === 1 && l.finding) this.inspect(l.finding, l.ref);
        };
        el.style.cursor = l.finding ? "pointer" : "";
      }
      // its size, read once per content change (labels are laid out off-screen until placed)
      const was = el.style.transform;
      el.style.transform = "translate(-10000px, -10000px)";
      const closed = el.classList.contains("closed");
      el.classList.remove("closed");
      v.w = Math.ceil(el.offsetWidth) || 140;
      v.h = Math.ceil(el.offsetHeight) || 40;
      if (closed) el.classList.add("closed");
      el.style.transform = was;
    }
    return v;
  }

  private showLabel(v: LabelView, motion: boolean, _length: number) {
    if (v.shown) return;
    v.shown = true;
    const anim = motion && v.seen === false ? true : motion;
    v.seen = true;
    if (!anim) {
      v.el.classList.remove("closed", "reveal");
      v.path.classList.remove("reveal", "retract");
      v.path.style.strokeDashoffset = "0";
      v.path.style.display = "";
      return;
    }
    // the leader scans out after the intent delay, then the card unfolds (CSS transitions; ./style.ts REVEAL_MS)
    v.path.style.display = "";
    v.path.classList.remove("retract");
    v.path.classList.add("reveal");
    v.el.classList.add("reveal");
    void v.el.offsetWidth;
    v.path.style.strokeDashoffset = "0";
    v.el.classList.remove("closed");
  }

  private hideLabel(v: LabelView, motion: boolean, remove = false) {
    if (v.shown) {
      v.shown = false;
      v.el.classList.remove("reveal");
      v.el.classList.add("closed");
      v.path.classList.remove("reveal");
      if (motion) {
        v.path.classList.add("retract");
        v.path.style.strokeDashoffset = "1";
      } else {
        v.path.style.strokeDashoffset = "1";
        v.path.style.display = "none";
      }
    } else if (!motion) v.path.style.display = "none";
    if (remove && !v.removeTimer) {
      v.removeTimer = setTimeout(
        () => {
          v.el.remove();
          v.path.remove();
          this.labels.delete(v.id);
        },
        motion ? REVEAL_MS.retract + 20 : 0,
      );
    }
  }

  private pinAt(key: string, x: number, y: number, label: string, title: string, keep: Set<string>, on: boolean) {
    keep.add(key);
    let b = this.pins.get(key);
    if (!b) {
      b = this.root.ownerDocument.createElement("button");
      b.className = "annot-pin";
      b.type = "button";
      this.root.appendChild(b);
      this.pins.set(key, b);
    }
    b.textContent = label;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.style.display = on ? "" : "none";
    b.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  }

  private arrowAt(id: string, a: [number, number], b: [number, number], tone: string, keep: Set<string>, on: boolean) {
    keep.add(id);
    let v = this.arrows.get(id);
    if (!v) {
      const line = this.root.ownerDocument.createElementNS(SVGNS, "path") as SVGPathElement;
      const head = this.root.ownerDocument.createElementNS(SVGNS, "path") as SVGPathElement;
      this.svg.append(line, head);
      v = { line, head };
      this.arrows.set(id, v);
    }
    v.line.setAttribute("class", `annot-arrow tone-${tone}`);
    v.head.setAttribute("class", `annot-arrowhead tone-${tone}`);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    v.line.style.display = v.head.style.display = on && len > 12 ? "" : "none";
    if (len <= 12) return;
    const ux = (b[0] - a[0]) / len;
    const uy = (b[1] - a[1]) / len;
    const tip: Pt = [b[0] - ux * 6, b[1] - uy * 6];
    const base: Pt = [tip[0] - ux * 8, tip[1] - uy * 8];
    v.line.setAttribute("d", `M${a[0].toFixed(1)},${a[1].toFixed(1)} L${base[0].toFixed(1)},${base[1].toFixed(1)}`);
    v.head.setAttribute("d", `M${tip[0].toFixed(1)},${tip[1].toFixed(1)} L${(base[0] - uy * 4).toFixed(1)},${(base[1] + ux * 4).toFixed(1)} L${(base[0] + uy * 4).toFixed(1)},${(base[1] - ux * 4).toFixed(1)} Z`);
  }

  /** A focusable, hoverable target over a marker (the markers are a roving-tabindex list, worst first). */
  private hitAt(m: DrcMarker, x: number, y: number, on: boolean, index: number, px = MARKER_PX) {
    let b = this.hits.get(m.key);
    if (!b) {
      b = this.root.ownerDocument.createElement("button");
      b.type = "button";
      b.className = "annot-hit";
      b.dataset.key = m.key;
      const key = m.key;
      b.addEventListener("pointerenter", () => this.hover(key));
      b.addEventListener("focus", () => this.hover(key, true));
      b.addEventListener("pointerleave", () => this.hover(undefined));
      b.addEventListener("blur", () => this.hover(undefined));
      b.addEventListener("click", () => {
        const marker = this.input.markers.find((x) => x.key === key);
        const f = marker?.findings[0];
        if (!f) return;
        // a click pins the card (or unpins it) and, pinning, asks the host to open the finding in the Inspector (D3)
        if (this.input.open.has(f.id)) this.host.onFinding?.(f.id, "close");
        else this.inspect(f.id, marker?.anchor.component ?? marker?.anchor.body);
      });
      this.root.appendChild(b);
      this.hits.set(m.key, b);
    }
    const f = m.findings[0];
    b.setAttribute("aria-label", `${f.severity}: ${f.code.replace(/_/g, " ")}${f.entity ? `, ${f.entity.id}` : ""}${m.findings.length > 1 ? `, and ${m.findings.length - 1} more` : ""}`);
    b.tabIndex = index === 0 ? 0 : -1;
    b.style.color = this.colours.drc[m.severity];
    b.classList.toggle("pinned", m.findings.some((x) => this.input.open.has(x.id)));
    b.style.display = on ? "" : "none";
    // the target covers the marker as drawn (it grows with the part, walkthrough D1), never under 22 px
    const t = Math.max(22, px + 6);
    b.style.width = b.style.height = `${t}px`;
    b.style.margin = `${-t / 2}px 0 0 ${-t / 2}px`;
    b.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  }

  /** Pins a finding's card and asks the host to open its detail in the Inspector (walkthrough D3). */
  private inspect(findingId: string, ref: string | undefined) {
    if (!this.input.open.has(findingId)) this.host.onFinding?.(findingId, "open");
    this.host.onInspect?.(findingId, ref);
  }

  /** Hover or focus: the card opens after the intent delay (focus opens at once). */
  private hover(key: string | undefined, now = false) {
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    if (this.longTimer) clearTimeout(this.longTimer);
    this.hoverTimer = this.longTimer = undefined;
    if (key === undefined) {
      this.hoverTier = "short";
      if (this.hovered === undefined) return;
      this.hovered = undefined;
      this.onChange?.();
      return;
    }
    // hover tiers (walkthrough D3): the title after the intent delay, the one-line description after LONG_HOVER_MS;
    // keyboard focus shows both at once
    const go = () => {
      this.hovered = key;
      this.hoverTier = now ? "long" : "short";
      const f = this.input.markers.find((m) => m.key === key)?.findings[0];
      if (f) this.host.onFinding?.(f.id, "hover");
      this.onChange?.();
    };
    // the CSS reveal carries the intent delay itself; the timer only avoids re-laying out for a pointer passing over
    if (now) go();
    else {
      this.hoverTimer = setTimeout(go, Math.min(40, REVEAL_MS.intent));
      this.longTimer = setTimeout(() => {
        this.longTimer = undefined;
        if (this.hovered !== key) return;
        this.hoverTier = "long";
        this.onChange?.();
      }, LONG_HOVER_MS);
    }
  }

  /** Markers drawn on the last frame (their part resolved and shown in this view): 0 lets the Findings control say so. */
  markersDrawn(): number {
    return this.drawnMarkers;
  }

  /** The hovered marker and its tier (tests, `__cad.annotations()`). */
  hoverState(): { key: string | undefined; tier: "short" | "long" } {
    return { key: this.hovered, tier: this.hoverTier };
  }

  /** Called when the layer needs a frame (a hover changed): the view invalidates. */
  onChange?: () => void;
  /** Asks the host for a frame that regroups the scene (objects added): the marker anchoring's frame (gate R1). */
  onSceneChange?: () => void;

  private onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (!t.classList?.contains("annot-hit")) return;
    const list = [...this.hits.values()].filter((b) => b.style.display !== "none");
    const i = list.indexOf(t as HTMLButtonElement);
    const move = (d: number) => {
      const next = list[(i + d + list.length) % list.length];
      if (!next) return;
      list.forEach((b) => (b.tabIndex = -1));
      next.tabIndex = 0;
      next.focus();
    };
    if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "n") move(1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "p") move(-1);
    else if (e.key === "Escape") {
      const f = this.input.markers.find((m) => m.key === t.dataset.key)?.findings[0];
      if (f && this.input.open.has(f.id)) this.host.onFinding?.(f.id, "close");
      (t as HTMLButtonElement).blur();
    } else return;
    e.preventDefault();
  }

  /** Which marker key a finding is drawn at (the control's "Look at"). */
  static markerOf(markers: DrcMarker[], f: FindingAnchors): DrcMarker | undefined {
    return markers.find((m) => m.findings.includes(f)) ?? markers.find((m) => f.anchors.some((a) => anchorKey(a) === m.key));
  }

  dispose() {
    if (this.anchorTimer) clearTimeout(this.anchorTimer);
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    if (this.longTimer) clearTimeout(this.longTimer);
    this.wheelOff();
    for (const v of this.labels.values()) if (v.removeTimer) clearTimeout(v.removeTimer);
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const x = o as THREE.Line | THREE.Sprite;
      if ((x as THREE.Line).geometry && !(x as THREE.Sprite).isSprite) (x as THREE.Line).geometry.dispose();
      (x.material as THREE.Material | undefined)?.dispose?.();
    });
    this.root.remove();
  }
}

const push = (xs: number[], v: number) => {
  xs.push(v);
  if (xs.length > 600) xs.shift();
};

function loop(segments: number): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a), Math.sin(a), 0));
  }
  return new THREE.BufferGeometry().setFromPoints(pts);
}

const lineMat = (colour: string, depth: boolean, opacity = 1) => new THREE.LineBasicMaterial({ color: colour, depthTest: depth, depthWrite: false, transparent: opacity < 1, opacity, toneMapped: false });

/** A ring: two loops 1 px apart (a 2 px line, depth-tested) and a faint ghost loop that ignores depth. */
function ringObject(colour: string): THREE.Object3D {
  const g = new THREE.Group();
  const inner = new THREE.LineLoop(loop(96), lineMat(colour, true));
  const outer = new THREE.LineLoop(loop(96), lineMat(colour, true));
  const ghost = new THREE.LineLoop(loop(96), new THREE.LineDashedMaterial({ color: colour, depthTest: false, depthWrite: false, transparent: true, opacity: 0.28, dashSize: 0.06, gapSize: 0.05, toneMapped: false }));
  ghost.computeLineDistances();
  for (const o of [inner, outer, ghost]) {
    o.renderOrder = o === ghost ? 18 : 21;
    o.frustumCulled = false;
  }
  g.add(inner, outer, ghost);
  return g;
}

/** A part's bounds as a unit box's 12 edges (scaled to the box each frame). */
function boxObject(colour: string): THREE.Object3D {
  const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
  const l = new THREE.LineSegments(geo, lineMat(colour, true));
  l.renderOrder = 21;
  l.frustumCulled = false;
  return l;
}

function crossObject(colour: string): THREE.Object3D {
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, -1),
    new THREE.Vector3(0, 0, 1),
  ]);
  const l = new THREE.LineSegments(geo, lineMat(colour, true));
  l.renderOrder = 21;
  l.frustumCulled = false;
  return l;
}
