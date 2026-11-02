/**
 * Imperative three.js scene for the 3D view (PB-775). Units: mm, Z up.
 *
 * GLB artifacts are glTF (metres, Y up); each is wrapped in a group that
 * rotates +90° about X and scales ×1000, which returns it to the module's
 * own CAD coordinates — the coordinates UHD frames are written in.
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import type { GeometryFrame, InterfaceDef, ModuleDef } from "@uhd/types/index.js";
import type { Mat4 } from "@uhd/system/geometry.js";
import { param, traitParam } from "./model";
import type { Appearance } from "../source/source";
import { checkGlb, createGlbCache, type LoadedModel, type LoadOptions } from "./render/glbCache";
import { createFrameLoop, type Invalidation } from "./render/loop";
import { Batcher, isBatchable, lookOf, LOGICAL_LAYER, type SyncPolicy, type SyncStats } from "./render/batch";
import { emitContextLost, emitFrame, frameListeners, type FrameEvent, type FrameQuality } from "./render/events";
import { MAX_GLB_BYTES, MAX_SIDECAR_JSON_BYTES, normaliseSidecar, sidecarUrls } from "./render/sidecar";
import { boxesFromSidecar } from "./render/boxes";
import { QualityController, dprFor, type Availability, type Knob, type QualityConfig, type QualityState, type QualityStatus } from "./render/quality/controller";
import { Attention, focusRect, focusedBoxes, type AttentionKind, type AttentionSnapshot } from "./render/quality/attention";
import { CoarseTier, type CoarseStats } from "./render/quality/coarse";
import { buildMerged, disposeMerged, mergeable, type MergeInput, type MergeResult } from "./render/quality/merge";
import { GpuTimer, type TimerGl } from "./render/quality/gpuTimer";
import { ViewLifecycle, inVsCodeWebview, type LifecycleState, type ResumeResult, type Snapshot, type SuspendResult } from "./render/quality/lifecycle";
import { budgetFromPeriod, measureDisplayPeriod, runLiveViewBenchmark } from "./render/quality/benchmark";
import { DEFAULT_LOOK, EDGE_GLSL, EDGE_THRESHOLDS, ToonTwins, applyLookToUniforms, readSceneLook, toonUniforms, toonable, type SceneLook } from "./render/toon";
import { SECTION_LAYER } from "./render/batch";
import { SceneSections, SectionCaps, findScopeRoots, sectionsByCamera, toPlanes, type SectionsInput, type SectionsReport, type SectionCut } from "./sections";
import { resolveTokenColor, resolveTokenValue } from "../theme/resolveColor";

export { onGlbLoad, onFrame, onContextLost, type GlbLoadEvent, type FrameEvent, type FrameQuality, type ContextLostEvent } from "./render/events";
export { LOGICAL_LAYER, SECTION_LAYER } from "./render/batch";
export { readSceneLook, bandFactors, DEFAULT_LOOK, type SceneLook } from "./render/toon";
export type { SectionsInput, SectionsReport, SectionCut } from "./sections";
export type { LoadedModel } from "./render/glbCache";

/** The theme's colours for the scene, as `#rrggbb` (ThemeProvider's tokenColor). */
export interface SceneTheme {
  background: string;
  grid: string;
  gridMinor: string;
  accent: string;
  highlight: string;
}

/**
 * Highlight colours of one scene. The focus colours follow the theme's accent
 * and highlight tokens; the rest are data colours. Each scene owns its set, so
 * two viewers with different themes never share focus colours.
 */
export interface SceneColors {
  focus: number;
  counterpart: number;
  normal: number;
  xAxis: number;
  phase: number[];
  hint: number;
  /** The selected body's emissive glow, and a stronger one for a picked interface's body. */
  glow: number;
  glowStrong: number;
}

/** DEFAULT (R1-A, E1): wheel zoom toward the pointer. */
export const DEFAULT_ZOOM_TO_CURSOR = true;
/** DEFAULT (R1-A, A1): the highlight glow's share of the accent (emissive). */
export const HIGHLIGHT_GLOW = 0.5;

/** The neutral default theme's accent and highlight (the stylesheet defaults), used until a theme is read. */
export const DEFAULT_SCENE_ACCENT = "#339fee";
export const DEFAULT_SCENE_HIGHLIGHT = "#22d3ee";

/** Fresh scene colours for a theme's accent and highlight (the selected body glows a dim accent). */
export function sceneColors(theme: Pick<SceneTheme, "accent" | "highlight"> = { accent: DEFAULT_SCENE_ACCENT, highlight: DEFAULT_SCENE_HIGHLIGHT }): SceneColors {
  const accent = new THREE.Color(theme.accent);
  return {
    focus: accent.getHex(),
    counterpart: 0x38bdf8,
    normal: accent.getHex(),
    xAxis: new THREE.Color(theme.highlight).getHex(),
    phase: [0xe11d48, 0xfacc15, 0x38bdf8],
    hint: 0xa8a29e,
    glow: accent.clone().multiplyScalar(0.16).getHex(),
    // R1-A (A1): what an agent points at glows enough to see on a small part (0.22 read as no glow on the USB-C).
    // DEFAULT 0.5 of the accent; the selection itself is the solid accent surface (`focus`, M5)
    glowStrong: accent.clone().multiplyScalar(HIGHLIGHT_GLOW).getHex(),
  };
}

/** WCAG relative luminance of a colour (0 black … 1 white). */
export function relativeLuminance(c: THREE.Color): number {
  const srgb = c.clone().convertLinearToSRGB();
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(srgb.r) + 0.7152 * lin(srgb.g) + 0.0722 * lin(srgb.b);
}

const loader = new GLTFLoader();
// the view sidecars are meshopt-compressed (W1-A); the decoder is three's own copy (MIT, meshoptimizer).
// It instantiates WebAssembly at import: where a CSP forbids that, a sidecar fails to parse and the plain GLB is used.
loader.setMeshoptDecoder(MeshoptDecoder);
void Promise.resolve(MeshoptDecoder.ready).catch(() => undefined);

/**
 * The GLB cache shared by every view, keyed by content hash (./render/glbCache.ts):
 * `X.view.glb` when its sidecar is there, else `X.glb`; a re-export to the same
 * path is seen at the next generation (a new bundle, `__cad.refresh()`).
 */
export const glbCache = createGlbCache({ parse: (data, path) => loader.parseAsync(data, path) });

/** Load a GLB by URL (artifact URLs come from the viewer source's resolver), with its hash and sidecar. */
export function loadModel(url: string, options?: LoadOptions): Promise<LoadedModel | null> {
  return glbCache.load(url, options);
}

/**
 * Boxes for a GLB from its view sidecar's index alone (`X.view.json`; PB-1176, W2-C's "Show boxes"): one box per
 * node at its bounds, in the GLB's frame (wrap with `cadWrapper` like a GLB scene). Null when there is no sidecar.
 */
export async function loadBoxes(url: string): Promise<THREE.Group | null> {
  const urls = sidecarUrls(url);
  if (!urls) return null;
  try {
    const r = await fetch(urls.json, { cache: "no-cache" });
    if (!r.ok) return null;
    const text = await r.text();
    if (text.length > MAX_SIDECAR_JSON_BYTES) return null;
    const sc = normaliseSidecar(JSON.parse(text));
    return sc ? boxesFromSidecar(sc) : null;
  } catch {
    return null;
  }
}

/** Load a GLB by URL: the parsed glTF only (callers clone `gltf.scene`). */
export function loadGlb(url: string): Promise<GLTF | null> {
  return glbCache.load(url).then((m) => m?.gltf ?? null);
}

/** glTF (m, Y-up) back to CAD coordinates (mm, Z-up). */
export function cadWrapper(obj: THREE.Object3D): THREE.Group {
  const g = new THREE.Group();
  g.rotation.x = Math.PI / 2;
  g.scale.setScalar(1000);
  g.add(obj);
  return g;
}

export function toMatrix4(m: Mat4): THREE.Matrix4 {
  return new THREE.Matrix4().set(...(m as [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]));
}

// ---------------------------------------------------------------------------
// Materials by what the module is
// ---------------------------------------------------------------------------

/**
 * Surface for a module's body (or one named sub-body of its CAD), from, in
 * order: display hints for the definition (and part), the part's declared
 * material (UHD MaterialSpec), then neutral defaults by kind. Nothing here
 * knows a particular project.
 */
export function materialFor(def: ModuleDef, bodyPart: string, appearance?: Appearance): THREE.MeshStandardMaterial {
  const hint = { ...(appearance ?? {}), ...(appearance?.parts?.[bodyPart] ?? {}) };
  const base = fallbackAppearance(def, bodyPart);
  const a = { ...base, ...hint };
  const transparent = a.opacity !== undefined && a.opacity < 1;
  // one material per look, shared (PB-1175): highlight and x-ray are per mesh (userData), never edits of this material
  const key = `${a.color ?? "#8b8b8b"}|${a.roughness ?? 0.55}|${a.metalness ?? 0.1}|${transparent ? a.opacity : 1}`;
  let m = looks.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: new THREE.Color(a.color ?? "#8b8b8b"),
      roughness: a.roughness ?? 0.55,
      metalness: a.metalness ?? 0.1,
      ...(transparent ? { transparent: true, opacity: a.opacity, side: THREE.DoubleSide, depthWrite: false } : {}),
    });
    looks.set(key, m);
  }
  return m;
}
const looks = new Map<string, THREE.MeshStandardMaterial>();

/** Declared material first (UHD `domains[mechanical].material`), then what the part is. */
function fallbackAppearance(def: ModuleDef, bodyPart: string): Omit<Appearance, "parts"> {
  const mech = (def.domains ?? []).find((d) => d.domain === "mechanical") as { material?: { name?: string } } | undefined;
  const text = `${mech?.material?.name ?? ""} ${def.name} ${(def.tags ?? []).join(" ")} ${(def.categories ?? []).join(" ")}`.toLowerCase();
  // satin, not glossy: a flat plate under the key light otherwise shows a broad pale highlight (PB-873)
  if (/carbon/.test(text)) return { color: "#232326", roughness: 0.62, metalness: 0.08 };
  if (/alumin/.test(text)) return { color: "#9aa0a8", metalness: 0.8, roughness: 0.35 };
  if (/nylon|pa6|plastic|pla\b|abs\b/.test(text)) return { color: "#1c1c1c", roughness: 0.7 };
  if (/stainless|steel|screw|bolt|nut|fastener/.test(text)) return { color: "#c0c4cc", metalness: 0.85, roughness: 0.3 };
  if (bodyPart === "components") return { color: "#3f3f46" };
  if (/propeller|\bprop\b/.test(text)) return { color: "#e7e5e4", opacity: 0.6 };
  if (/battery|lipo/.test(text)) return { color: "#2d2f36", roughness: 0.6 };
  if (/esc|controller|driver|board|module|sensor|receiver|pcb/.test(text) && bodyPart !== "") return { color: "#1f3b2c" };
  if (/motor/.test(text)) return { color: "#9ca3af", metalness: 0.75, roughness: 0.3 };
  return { color: "#8b8b8b" };
}

const focusMaterials = new Map<number, THREE.MeshStandardMaterial>();
/** The highlight surface for a colour (one shared material per colour). */
export const focusMaterial = (color: number) => {
  let m = focusMaterials.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.6,
      roughness: 0.4,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    focusMaterials.set(color, m);
  }
  return m;
};

const hoverMaterials = new Map<number, THREE.MeshStandardMaterial>();
/**
 * The hover surface for a colour (R2-A, A3; one shared material per colour): the colour the hover rule derived from
 * the part's own (./nav/colour.ts `hoverColour`), lit a little less than the selection's surface so a hovered part
 * never reads as selected. Drawn just in front (polygon offset), as the selection is.
 */
export const hoverMaterial = (color: number) => {
  let m = hoverMaterials.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.25,
      roughness: 0.55,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    hoverMaterials.set(color, m);
  }
  return m;
};

/**
 * A part's own colour (R2-A, A3): the colour of the material covering most of its meshes' triangles (their base
 * material, before any highlight or x-ray variant), as an sRGB hex; undefined when none has a colour.
 */
export function ownColour(objects: THREE.Object3D[]): number | undefined {
  const weight = new Map<number, number>();
  for (const root of objects)
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || o.userData.feature) return;
      const base = (mesh.userData.baseMaterial ?? mesh.material) as THREE.Material | THREE.Material[];
      const mat = (Array.isArray(base) ? base[0] : base) as THREE.MeshStandardMaterial | undefined;
      if (!mat?.color) return;
      const g = mesh.geometry;
      const tris = g ? (g.index ? g.index.count : (g.attributes.position?.count ?? 0)) / 3 : 1;
      const n = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count : 1;
      const hex = mat.color.getHex();
      weight.set(hex, (weight.get(hex) ?? 0) + Math.max(1, tris) * n);
    });
  let best: number | undefined;
  let most = -1;
  for (const [hex, w] of weight) if (w > most) [best, most] = [hex, w];
  return best;
}

// ---------------------------------------------------------------------------
// Frames and procedural geometry (D3), in a module's CAD coordinates
// ---------------------------------------------------------------------------

/** Group whose local X/Y/Z are the frame's xAxis / (normal × xAxis) / normal, origin at the frame origin. */
export function frameGroup(frame: GeometryFrame): THREE.Group {
  const z = new THREE.Vector3(...frame.normal).normalize();
  let x = frame.xAxis ? new THREE.Vector3(...frame.xAxis) : Math.abs(z.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  x = x.sub(z.clone().multiplyScalar(x.dot(z))).normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  const g = new THREE.Group();
  g.matrixAutoUpdate = false;
  g.matrix.makeBasis(x, y, z).setPosition(...frame.origin);
  return g;
}

export function frameGizmo(frame: GeometryFrame, colors: SceneColors, size = 14): THREE.Group {
  const g = frameGroup(frame);
  const arrow = (dir: THREE.Vector3, color: number, len: number) => {
    const a = new THREE.ArrowHelper(dir, new THREE.Vector3(), len, color, len * 0.22, len * 0.12);
    (a.line.material as THREE.LineBasicMaterial).depthTest = false;
    (a.cone.material as THREE.MeshBasicMaterial).depthTest = false;
    a.renderOrder = 10;
    return a;
  };
  g.add(arrow(new THREE.Vector3(0, 0, 1), colors.normal, size));
  if (frame.xAxis) g.add(arrow(new THREE.Vector3(1, 0, 0), colors.xAxis, size * 0.6));
  // symmetry: tick marks every symmetryDeg
  if (frame.symmetryDeg) {
    const pts: THREE.Vector3[] = [];
    for (let a = 0; a < 360; a += frame.symmetryDeg) {
      const r = (a * Math.PI) / 180;
      pts.push(new THREE.Vector3(Math.cos(r) * size * 0.45, Math.sin(r) * size * 0.45, 0), new THREE.Vector3(Math.cos(r) * size * 0.7, Math.sin(r) * size * 0.7, 0));
    }
    const ticks = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: colors.xAxis, depthTest: false }));
    ticks.renderOrder = 10;
    g.add(ticks);
  }
  return g;
}

/**
 * D3: geometry derived from the interface's own parameters, placed at its
 * frame. Returns null when the generator has nothing to work with. `notes`
 * collects what the parameters could not say (e.g. pattern phase).
 */
export function proceduralGeometry(iface: InterfaceDef, generator: string, frame: GeometryFrame, color: number, notes: string[]): THREE.Object3D | null {
  const g = frameGroup(frame);
  const mat = focusMaterial(color);
  if (generator === "bolt_pattern") {
    const spacing = param(iface, "hole_spacing");
    const spacingY = param(iface, "hole_spacing_y") ?? spacing;
    const count = param(iface, "hole_count") ?? 4;
    const d = param(iface, "fastener_diameter") ?? 3;
    const shape = traitParam<string>(iface, "bolt_pattern", "shape") ?? "square";
    if (!spacing) return null;
    const holes: [number, number][] = [];
    if (shape === "circle") {
      notes.push("circle pattern phase is not a UHD parameter: holes drawn from 45°");
      for (let k = 0; k < count; k++) {
        const a = Math.PI / 4 + (k * 2 * Math.PI) / count;
        holes.push([(Math.cos(a) * spacing) / 2, (Math.sin(a) * spacing) / 2]);
      }
    } else {
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) holes.push([(sx * spacing) / 2, (sy * spacingY!) / 2]);
    }
    for (const [x, y] of holes) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(d / 2 + 0.6, 0.45, 10, 32), mat);
      ring.position.set(x, y, 0.3);
      g.add(ring);
      const pin = new THREE.Mesh(new THREE.CylinderGeometry(d / 2, d / 2, 6, 20), new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.35 }));
      pin.rotation.x = Math.PI / 2;
      pin.position.set(x, y, 3);
      g.add(pin);
    }
    const outline =
      shape === "circle"
        ? new THREE.EllipseCurve(0, 0, spacing / 2, spacing / 2).getPoints(64).map((p) => new THREE.Vector3(p.x, p.y, 0.3))
        : [
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, 1],
            [-1, -1],
          ].map(([sx, sy]) => new THREE.Vector3((sx * spacing) / 2, (sy * spacingY!) / 2, 0.3));
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(outline), new THREE.LineDashedMaterial({ color, dashSize: 1.5, gapSize: 1 })).computeLineDistances());
    return g;
  }
  if (generator === "shaft") {
    const d = param(iface, "shaft_diameter") ?? 5;
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(d / 2 + 0.2, d / 2 + 0.2, 12, 32, 1, true), mat);
    cyl.rotation.x = Math.PI / 2;
    cyl.position.z = 6;
    g.add(cyl);
    notes.push("shaft length is not a UHD parameter: drawn 12 mm");
    return g;
  }
  if (generator === "pad") {
    const pad = new THREE.Mesh(new THREE.BoxGeometry(4, 9, 0.4), mat);
    pad.position.z = 0.2;
    g.add(pad);
    notes.push("pad size/pitch are not UHD parameters: drawn as a generic 3-pad group");
    return g;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

/**
 * How the frame is antialiased (PB-1175):
 * - "msaa": the scene is drawn into a multisampled render target
 *   (`WebGLRenderTarget.samples`, so the sample count is a knob), then tone
 *   mapped and composited over the background onto the canvas;
 * - "native": the WebGL context's own antialiasing (fixed for the context's life);
 * - "none".
 */
export type AntialiasMode = "msaa" | "native" | "none";

export interface SceneOptions {
  /**
   * DEFAULT "native" (PB-1175): the multisampled target path cost more than the 1 ms the brief allows on the
   * drone (Intel UHD, d3d11: +1.5 to +4.5 ms per frame over native AA, phase-1/progress.md W1-C), so the
   * context antialiases; "msaa" (with `samples`) stays available as the knob wave 2 tunes.
   */
  antialias?: AntialiasMode;
  /** Samples for "msaa" (0 turns it off without changing the pipeline). */
  samples?: number;
  /** Draw through shared materials and instancing (./render/batch.ts). Default true. */
  batching?: boolean;
  /**
   * The interaction quality curve (PB-1176, ./render/quality/controller.ts). Default on. URL knobs for
   * measuring: `?quality=off`, `?qbudget=<ms>` (the display budget), `?qtau=<ms>` (the recovery constant),
   * `?qtrial=0` (no knob trials: every knob the curve engages stays).
   */
  quality?: Partial<QualityConfig>;
  /**
   * When the page is hidden, give the GL context back as well as stop drawing (restored from the CPU copies when
   * shown). DEFAULT true inside a VS Code webview, false elsewhere (the browser dev viewer).
   */
  freeGpuWhenHidden?: boolean;
  /** The matte toon bands (PB-1189, ./render/toon.ts). Default on; URL `?toon=0` for comparisons. */
  toon?: boolean;
  /** The ink pass (silhouettes and creases). Default on; URL `?edges=0`. The quality curve drops it while moving when over budget. */
  edges?: boolean;
  /**
   * Wheel zoom goes toward the point under the pointer (R1-A, E1). DEFAULT true (Kevin's walkthrough, 39:56); the view
   * option `zoomToCursor` (URL `?zoomToCursor=0`, a host's `hub.controls`) turns it off. Left drag orbits, right drag
   * pans, the wheel or middle drag zooms (OrbitControls' own mapping, confirmed and pinned in `createScene`).
   */
  zoomToCursor?: boolean;
}

/** The model's look (PB-1189): the toon bands and the ink, and what the theme set. */
export interface StyleApi {
  /** The look now: whether the bands and the ink are on, and the theme's values. */
  state: () => { toon: boolean; edges: boolean; edgesDrawn: boolean; look: SceneLook };
  setToon: (on: boolean) => void;
  setEdges: (on: boolean) => void;
}

/** Sections (PB-1186): the planes on this scene, the live caps and the settled cut (./sections). */
export interface SectionsApi {
  /**
   * Put planes on the scene (world mm; null: none, and the renderer's own global planes are used, which is how
   * CadView cut the whole model before). With `scope`, only the meshes under those roots are cut.
   */
  set: (input: SectionsInput | null) => void;
  /** Planes, scope, the settled cut (null until computed), the caps' last pass. Undefined: no section. */
  report: () => SectionsReport | undefined;
  /** Compute the exact cut now (it is also computed by itself once the view is quiet). */
  compute: () => SectionCut[];
}

export interface SceneStats {
  /** Frames drawn since the scene was created (only on change: idle adds none). */
  frames: number;
  /** The last frame: CPU ms, draw calls and triangles of the scene pass. */
  last: { ms: number; draws: number; triangles: number };
  /** The batcher's last sync (instances, instanced groups, shared materials, meshes drawn as themselves). */
  batch?: SyncStats;
  antialias: AntialiasMode;
  samples: number;
  geometries: number;
  programs: number;
}

/** An effect the quality curve may switch off while the view moves (edges, outline: W3-C registers them). */
export interface QualityEffect {
  name: string;
  setEnabled: (on: boolean) => void;
}

/** One frame as the quality curve saw it (the ring buffer `quality.samples()` keeps, for measuring). */
export interface QualitySampleRecord {
  t: number;
  cpuMs: number;
  gpuMs?: number;
  intervalMs?: number;
  active: boolean;
  flush: boolean;
  state: QualityState;
  knobs: Knob[];
  draws: number;
  triangles: number;
  dpr: number;
  inset: boolean;
}

/** The quality curve's state as a read-only view (W2-A surfaces it in the view state and the UI). */
export interface QualityReport extends QualityStatus {
  enabled: boolean;
  /** Which GPU timing the browser gives (EXT_disjoint_timer_query_webgl2). */
  gpuTimer: boolean;
  availability: Availability;
  coarse: CoarseStats;
  merge?: { meshes: number; members: number; triangles: number; ms: number };
  /** The focused parts are drawn at full pixel density in an inset while the rest is at a lower one. */
  inset: boolean;
  /** Knobs tried this scene that did not make frames cheaper (skipped until the scene changes). */
  skipped: Knob[];
  attention: AttentionSnapshot;
}

export interface QualityApi {
  /** The current state, knobs, bottleneck guess and what is available. */
  report: () => QualityReport;
  /** Every change of state or knobs. */
  onChange: (cb: (r: QualityReport) => void) => () => void;
  /** Change the configuration (budget, tau, enabled, ...). */
  configure: (c: Partial<QualityConfig>) => void;
  /** Load the coarse tiers of what is shown now (done by itself once a heavy scene is loaded). */
  prepareCoarse: () => Promise<CoarseStats>;
  /** The last frames (up to 2,000). */
  samples: () => QualitySampleRecord[];
  /** Register an effect the curve switches off first; returns its unregister. */
  registerEffect: (e: QualityEffect) => () => void;
}

export interface SceneHandle {
  /** One number per scene, for telemetry (several views can be open). */
  id: number;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  renderer: THREE.WebGLRenderer;
  root: THREE.Group;
  overlay: THREE.Group;
  dispose: () => void;
  frameAll: (box?: THREE.Box3) => void;
  /**
   * The model direction drawn up (default +z): the camera's up, the orbit
   * axis, the ground grid and the lights follow it (a display hint, PB-873).
   */
  setUp: (up: THREE.Vector3) => void;
  /** Put the ground grid under a box (the assembled model), across the up direction. */
  setGround: (box: THREE.Box3) => void;
  /** This scene's highlight colours (follow `setTheme`). */
  colors: SceneColors;
  /** The theme's background, grid and focus colours. */
  setTheme: (theme: SceneTheme) => void;
  /**
   * Ask for a frame: "view" when only the camera moved, "pose" when only placements of objects already drawn
   * changed (an explode tween, a sequence playing: the batcher rewrites matrices, no regrouping), "scene"
   * (default) when anything else changed (shown, hidden, recoloured, added). Frames are drawn only when asked for.
   */
  invalidate: (what?: Invalidation) => void;
  /**
   * Called before each drawn frame with the frame time in seconds. Return
   * true while an animation runs (the next frame is drawn too); call
   * `invalidate()` from it when it changed the scene.
   */
  beforeRender: Set<(dt: number) => boolean | void>;
  /** This scene's frames ({ms, draws, triangles, quality}); the module-wide `onFrame` hears every scene. */
  onFrame: (cb: (e: FrameEvent) => void) => () => void;
  /** This scene's WebGL context was lost (not when `suspend` gave it back on purpose). */
  onContextLost: (cb: () => void) => () => void;
  /** When set, scheduled frames are skipped and the caller draws with `renderOnce` (video capture). */
  manual: { on: boolean };
  /** Draw a frame now, synchronously, at full quality (a capture reads the canvas in the same task). */
  renderOnce: () => void;
  /**
   * Compile the programs `objects` will need, without blocking (`compileAsync`),
   * before they are added to the scene: no frame stalls on a shader compile.
   */
  compile: (objects: THREE.Object3D[]) => Promise<void>;
  /** Draw counts and what the batcher did. */
  stats: () => SceneStats;
  /** The trees the batcher draws (the scene's children but its own, the quality curve's and the camera). */
  logicalRoots: () => THREE.Object3D[];
  /** The interaction quality curve (PB-1176): read-only state, events and its configuration. */
  quality: QualityApi;
  /**
   * Attention foveation (PB-1176): set the selected, agent-focused or hovered keys (body keys or harness keys,
   * as CadView's `userData.bodyKey` / `userData.harness`). Those parts keep the fine tier and full pixel density
   * while the curve degrades the rest. Until a host sets "selected", lit (highlighted) meshes count as selected.
   */
  setAttention: (kind: AttentionKind, keys: Iterable<string>) => void;
  /** The attention sets now. */
  attention: () => AttentionSnapshot;
  /**
   * A PNG of the canvas each time the view settles (and before a suspend). The host keeps the latest as the
   * tab's picture: shown while the view is suspended, and at once when a tab comes back. Returns unsubscribe.
   */
  onSnapshot: (cb: (s: Snapshot) => void) => () => void;
  /** A snapshot now (drawn at full quality, read in the same task). */
  snapshot: () => Promise<Snapshot | undefined>;
  /** Stop drawing, after a snapshot; `freeGpu` also gives the GL context back (host's live-view budget). */
  suspend: (options?: { freeGpu?: boolean }) => Promise<SuspendResult>;
  /** Draw again (restoring the GL context when it was given back): one frame, then on demand. */
  resume: () => Promise<ResumeResult | undefined>;
  /** Suspended or live, and why. */
  lifecycle: () => LifecycleState;
  onLifecycle: (cb: (s: LifecycleState) => void) => () => void;
  /** The toon bands and the ink (PB-1189). */
  style: StyleApi;
  /** Section planes, caps and the cut as data (PB-1186). */
  sections: SectionsApi;
}

let nextSceneId = 1;

/**
 * Composites a scene target onto the canvas: tone mapping and output colour space, then over the background
 * (upscaled when the target is smaller); with `edges`, the ink pass (./render/toon.ts) over the result, from the
 * target's depth.
 */
function outputQuad(edges = false): { mesh: THREE.Mesh; camera: THREE.OrthographicCamera; material: THREE.ShaderMaterial } {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
  const material = new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: null },
      background: { value: new THREE.Vector3() },
      ...(edges
        ? {
            tDepth: { value: null },
            texel: { value: new THREE.Vector2(1, 1) },
            inkWidth: { value: 1 },
            cameraNear: { value: 1 },
            cameraFar: { value: 5000 },
            inkSilhouette: { value: new THREE.Vector3() },
            inkCrease: { value: new THREE.Vector3() },
            edgeThresholds: { value: new THREE.Vector2(EDGE_THRESHOLDS.silhouette, EDGE_THRESHOLDS.crease) },
          }
        : {}),
    },
    ...(edges ? { defines: { EDGES: "" } } : {}),
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    // the target holds linear colour, premultiplied by coverage where nothing opaque was drawn; the background
    // is added after tone mapping, in the output colour space, as the canvas's own clear colour would be
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform vec3 background;
      varying vec2 vUv;
      #ifdef EDGES
      ${EDGE_GLSL}
      #endif
      void main() {
        vec4 c = texture2D(tDiffuse, vUv);
        float a = clamp(c.a, 0.0, 1.0);
        vec3 rgb = a > 0.0001 ? c.rgb / a : vec3(0.0);
        #ifdef TONE_MAPPING
          rgb = toneMapping(rgb);
        #endif
        rgb = linearToOutputTexel(vec4(rgb, 1.0)).rgb;
        vec3 outColor = mix(background, rgb, a);
        #ifdef EDGES
          // the ink, in the output colour space (its uniforms are the tokens' sRGB values)
          vec4 ink = inkAt(vUv);
          outColor = mix(outColor, ink.rgb, ink.a);
        #endif
        gl_FragColor = vec4(outColor, 1.0);
      }`,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  return { mesh, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), material };
}

/**
 * Coarse tiers, shared by every scene (the fine geometries they stand in for are the GLB cache's templates,
 * shared too). Each coarse file goes through the same size and extension checks as any GLB.
 */
export const coarseTier = new CoarseTier({
  load: async (url) => {
    const r = await fetch(url, { cache: "no-cache" });
    if (!r.ok) throw new Error(`${r.status}`);
    const n = Number(r.headers.get("content-length"));
    if (Number.isFinite(n) && n > MAX_GLB_BYTES) throw new Error(`over the ${MAX_GLB_BYTES}-byte cap`);
    const data = await r.arrayBuffer();
    checkGlb(data);
    const path = url.split(/[?#]/)[0];
    return loader.parseAsync(data, path.slice(0, path.lastIndexOf("/") + 1));
  },
});

/** The one-second benchmark behind the host's `maxLiveViews` budget (./render/quality/benchmark.ts). */
export { runLiveViewBenchmark, liveViewsFor, viewsToSuspend, benchmarkKey, type LiveViewBenchmark, type LiveViews } from "./render/quality/benchmark";
export type { Snapshot, SuspendResult, ResumeResult, LifecycleState } from "./render/quality/lifecycle";
export type { Knob, QualityConfig, QualityStatus, QualityState, Availability } from "./render/quality/controller";
export type { AttentionKind, AttentionSnapshot } from "./render/quality/attention";

/** Triangles past which a loaded scene prepares its coarse tiers by itself (DEFAULT). */
const COARSE_PREWARM_TRIANGLES = 200_000;
/** Draws (instanced groups plus meshes drawn as themselves) from which merging unfocused parts can help (DEFAULT). */
const MERGE_MIN_DRAWS = 16;
/** A scene change this recent keeps the merge from being rebuilt (an explode tween changes the scene every frame). */
const MERGE_QUIET_MS = 250;
/** The foveal inset is drawn only while the focused parts cover at most this share of the view (DEFAULT). */
const INSET_MAX_FRACTION = 0.6;
/** Samples kept for measuring. */
const SAMPLE_RING = 2000;

/** Measurement and debugging handles of every live scene, by id (`window.__cadQuality`; not an API). */
const debugScenes = new Map<number, Record<string, unknown>>();
/**
 * `window.__cadQuality` is installed only behind a debug flag (the wave 2 gate): `?cadDebug` in the page URL (any
 * value), or `globalThis.__CAD_DEBUG__ = true` before the viewer loads. Measuring scripts add `cadDebug=1`.
 */
export function cadDebugEnabled(): boolean {
  if ((globalThis as { __CAD_DEBUG__?: unknown }).__CAD_DEBUG__ === true) return true;
  return typeof location !== "undefined" && new URLSearchParams(location.search).has("cadDebug");
}
if (typeof window !== "undefined" && cadDebugEnabled()) (window as unknown as Record<string, unknown>).__cadQuality = { scenes: debugScenes, benchmark: runLiveViewBenchmark };

/** The settle snapshot waits this long after the view comes to rest, then for an idle moment (DEFAULT, W3-C: read back right after a load it stalled the main thread 200-300 ms on ClientX while the GPU finished its uploads). */
const SETTLE_SNAPSHOT_DELAY_MS = 400;
/**
 * MSAA samples of the scene target while the ink pass is on (the target replaces the context's own antialiasing
 * then). DEFAULT 0: measured on the Intel UHD (ANGLE d3d11, 1440x900), 4 samples cost 7.3 ms a frame on the drone
 * and 7.5 ms on ClientX (the multisampled depth resolve the ink needs), 2 samples 5.4 ms, none 0.4 ms; the ink
 * covers the silhouettes the samples would smooth. `?edgeSamples=N` measures the others.
 */
const EDGE_SAMPLES = 0;

function urlFlag(name: string): boolean | undefined {
  if (typeof location === "undefined") return undefined;
  const v = new URLSearchParams(location.search).get(name);
  if (v === null) return undefined;
  return !(v === "0" || v === "off" || v === "false");
}

function urlQuality(): Partial<QualityConfig> {
  if (typeof location === "undefined") return {};
  const q = new URLSearchParams(location.search);
  const out: Partial<QualityConfig> = {};
  if (q.get("quality") === "off") out.enabled = false;
  const b = Number(q.get("qbudget"));
  if (q.has("qbudget") && Number.isFinite(b) && b > 0) out.budgetMs = b;
  const tau = Number(q.get("qtau"));
  if (q.has("qtau") && Number.isFinite(tau) && tau >= 0) out.tauMs = tau;
  // measuring only: keep every knob the curve engages (no trials)
  if (q.get("qtrial") === "0") out.trialFrames = 0;
  return out;
}

export function createScene(container: HTMLElement, options: SceneOptions = {}): SceneHandle {
  const id = nextSceneId++;
  const created = performance.now();
  const aa: AntialiasMode = options.antialias ?? "native";
  const samples = aa === "msaa" ? Math.max(0, options.samples ?? 4) : 0;
  // preserveDrawingBuffer false (PB-1175): a capture draws and reads in one task (renderOnce)
  // stencil: the section caps (PB-1186, ./sections/caps.ts) count crossings in one stencil bit
  const renderer = new THREE.WebGLRenderer({ antialias: aa === "native", preserveDrawingBuffer: false, stencil: true });
  // a scoped section clips through materials (./sections)
  renderer.localClippingEnabled = true;
  // the look (PB-1189): matte toon bands (the theme's tones exactly: no tone mapping) and the ink pass
  let toonOn = urlFlag("toon") ?? options.toon ?? true;
  let edgesWanted = urlFlag("edges") ?? options.edges ?? true;
  /** Samples of the scene target under the ink (measuring knob `?edgeSamples=N`). */
  const edgeSamples = (() => {
    const v = typeof location === "undefined" ? NaN : Number(new URLSearchParams(location.search).get("edgeSamples") ?? NaN);
    return Number.isFinite(v) && v >= 0 ? Math.min(8, Math.round(v)) : EDGE_SAMPLES;
  })();
  /** The quality curve's `effects` knob switches the ink off while the view moves over budget. */
  let edgesAllowed = true;
  let edgesDrawn = false;
  let look: SceneLook = { ...DEFAULT_LOOK };
  const toonU = toonUniforms();
  applyLookToUniforms(toonU, look);
  const twins = new ToonTwins(toonU);
  const setToneMapping = () => {
    renderer.toneMapping = toonOn ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
  };
  setToneMapping();
  renderer.toneMappingExposure = 1.05;
  const baseDpr = Math.min(window.devicePixelRatio, 2);
  // the canvas stays at this ratio: the quality curve lowers resolution in a render target, never by resizing the canvas
  renderer.setPixelRatio(baseDpr);
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // counts are read per frame (scene pass only), so they are not reset by each render call
  renderer.info.autoReset = false;
  container.appendChild(renderer.domElement);

  const colors = sceneColors();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a1a);
  // world matrices are brought up to date once per frame, before the batcher reads them
  scene.matrixWorldAutoUpdate = false;
  const camera = new THREE.PerspectiveCamera(32, container.clientWidth / container.clientHeight, 1, 5000);
  camera.up.set(0, 0, 1);
  camera.position.set(260, -330, 250);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 20);
  controls.enableDamping = true;
  // R1-A (E1): zoom toward the pointer (DEFAULT on; `options.zoomToCursor` / `setZoomToCursor` turn it off); the
  // buttons pinned to what Kevin asked for (left orbit, middle zoom, right pan), the same as OrbitControls' defaults
  controls.zoomToCursor = options.zoomToCursor ?? DEFAULT_ZOOM_TO_CURSOR;
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };

  const hemi = new THREE.HemisphereLight(0xf5f5f4, 0x1c1917, 1.4);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(200, -150, 400);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffedd5, 0.8);
  rim.position.set(-300, 250, 120);
  scene.add(rim);
  // a fill that travels with the camera, from below and beside it: the faces the key light leaves in shade (a
  // part's side walls, a board seen from below) get a tone of their own whichever way the model is turned,
  // and the faces the key already lights get next to nothing more
  const head = new THREE.DirectionalLight(0xffffff, 0);
  head.position.set(-0.8, -0.55, 0.6);
  camera.add(head);
  camera.add(head.target);
  head.target.position.set(0, 0, 0);
  scene.add(camera);
  /**
   * Light for the background the model is seen against (PB-946). On a dark
   * background a dark part (a black board, a cell in its sleeve) has to be
   * told from it by its lit faces: the sky's bounce is lifted so no face
   * falls to black, and the camera's fill gives the faces in shade a tone
   * of their own. On a light background the same part stands out
   * by itself, and that much light would wash pale parts out.
   */
  const lightFor = (background: THREE.Color) => {
    const dark = relativeLuminance(background) < 0.2;
    hemi.groundColor.setHex(dark ? 0x78716c : 0x1c1917);
    hemi.intensity = dark ? 1.7 : 1.4;
    head.intensity = dark ? 3.5 : 0.8;
    rim.intensity = dark ? 1.2 : 0.8;
  };
  lightFor(scene.background as THREE.Color);

  let grid = new THREE.GridHelper(600, 60, 0x3a3a3a, 0x262626);
  // the grid writes no depth: the ink pass would outline its lines
  (grid.material as THREE.Material).depthWrite = false;
  grid.rotation.x = Math.PI / 2;
  grid.position.z = -0.5;
  scene.add(grid);
  /** New grid colours: a GridHelper bakes them into its vertices, so the grid is rebuilt in place. */
  const setGridColors = (major: string, minor: string) => {
    const next = new THREE.GridHelper(600, 60, major, minor);
    (next.material as THREE.Material).depthWrite = false;
    next.position.copy(grid.position);
    next.quaternion.copy(grid.quaternion);
    next.scale.copy(grid.scale);
    next.visible = grid.visible;
    scene.remove(grid);
    grid.geometry.dispose();
    (grid.material as THREE.Material).dispose();
    grid = next;
    scene.add(grid);
  };

  const root = new THREE.Group();
  const overlay = new THREE.Group();
  scene.add(root, overlay);
  const batcher = options.batching === false ? null : new Batcher({ toon: toonU });
  if (batcher) {
    batcher.materials.setToon(toonOn);
    scene.add(batcher.root);
  }
  // merged meshes of unfocused parts (the quality curve's merge knob) are drawn from here
  const qualityRoot = new THREE.Group();
  qualityRoot.name = "quality";
  qualityRoot.matrixAutoUpdate = false;
  scene.add(qualityRoot);
  const logicalRoots = () => scene.children.filter((c) => c !== batcher?.root && c !== camera && c !== qualityRoot);

  // ---- the scene target and the output pass (aa "msaa", and a lowered pixel ratio) ----
  let target: THREE.WebGLRenderTarget | null = null;
  let quad: ReturnType<typeof outputQuad> | null = aa === "msaa" ? outputQuad() : null;
  /** The output pass with the ink (made on first use). */
  let edgeQuad: ReturnType<typeof outputQuad> | null = null;
  const inkSilhouette = new THREE.Vector3();
  const inkCrease = new THREE.Vector3();
  const srgbOf = (hex: string, out: THREE.Vector3) => {
    const c = new THREE.Color(hex).getRGB(new THREE.Color(), THREE.SRGBColorSpace);
    out.set(c.r, c.g, c.b);
  };
  srgbOf(look.silhouette, inkSilhouette);
  srgbOf(look.crease, inkCrease);

  // ---- sections (PB-1186): live stencil caps, the settled cut, its outline ----
  const caps = new SectionCaps();
  caps.setColor(look.cap);
  const sections = new SceneSections({
    roots: () => logicalRoots().filter((r) => r !== grid && r !== overlay),
    globalPlanes: () => renderer.clippingPlanes,
    invalidate: () => invalidate("view"),
    eye: () => camera.position,
  });
  // R2-B's hatch (R2 integration): the theme's cap tone and its section ink, not the luminance guess; the open-mesh
  // CPU caps take the same tone
  caps.setInk(look.capLine);
  sections.setCapColor(look.cap);
  sections.setLineColor(look.capLine);
  /** The outline is drawn in a pass of its own with no clipping (it lies on the planes). */
  const outlineHolder = new THREE.Scene();
  outlineHolder.matrixWorldAutoUpdate = false;
  outlineHolder.add(sections.outline);
  const stencilCamera = new THREE.PerspectiveCamera();
  const emptyScene = new THREE.Scene();
  emptyScene.matrixWorldAutoUpdate = false;
  const stencilSphere = new THREE.Sphere();
  /**
   * Hide, for one plane's stencil pass, what the plane does not cross: a closed part on one side of the plane adds
   * an even count (0 or 2) to every pixel, so leaving it out changes nothing but the cost (a board cut on ClientX
   * draws the board, not the enclosure). Returns what to show again.
   */
  const hideUncrossed = (plane: THREE.Plane): THREE.Object3D[] => {
    const hidden: THREE.Object3D[] = [];
    const test = (o: THREE.Mesh) => {
      if (!o.visible) return;
      const g = o.geometry;
      const bs = (o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh).boundingSphere : (g.boundingSphere ?? (g.computeBoundingSphere(), g.boundingSphere));
      if (!bs) return;
      stencilSphere.copy(bs).applyMatrix4(o.matrixWorld);
      if (!plane.intersectsSphere(stencilSphere)) {
        o.visible = false;
        hidden.push(o);
      }
    };
    if (batcher) {
      for (const c of batcher.root.children) test(c as THREE.Mesh);
      for (const m of batcher.own) test(m);
    }
    if (merged) for (const m of merged.meshes) test(m);
    return hidden;
  };
  /** Meshes the scoped section marked (`userData.sectionScoped`), to unmark. */
  let scopedMarked: THREE.Object3D[] = [];
  let scopeRoots: THREE.Object3D[] | null = null;
  let rootChanged = false;
  const markScope = () => {
    for (const o of scopedMarked) {
      delete o.userData.sectionScoped;
      o.layers.disable(SECTION_LAYER);
    }
    scopedMarked = [];
    if (!scopeRoots) return;
    for (const r of scopeRoots)
      r.traverse((o) => {
        if (!(o as THREE.Mesh).isMesh) return;
        o.userData.sectionScoped = true;
        scopedMarked.push(o);
      });
  };
  /** Caps and the settled outline for the planes in force, into the current target, after the scene pass. */
  const drawSections = (cam: THREE.Camera) => {
    const { planes, scope } = sections.planes();
    if (!planes.length) return;
    const saved = renderer.clippingPlanes;
    const background = scene.background;
    try {
      // the cap quad covers the cut: centred on the orbit target, as wide as the view is deep (stencil trims it)
      const r = Math.max(1000, 4 * camera.position.distanceTo(controls.target));
      caps.draw(
        renderer,
        cam,
        planes,
        new THREE.Sphere(controls.target, r),
        (material, plane) => {
          const gridShown = grid.visible;
          grid.visible = false;
          // flat overlays (callouts, markers, the section tool's sheets) are not solids: drawn into the stencil, a quad
          // across the cut flips its parity and its area came out hatched (R2-B's handoff, R2 integration)
          const overlayShown = overlay.visible;
          overlay.visible = false;
          const hidden = hideUncrossed(plane);
          scene.background = null;
          scene.overrideMaterial = material;
          try {
            if (scope) {
              material.clippingPlanes = planes;
              stencilCamera.copy(cam as THREE.PerspectiveCamera, false);
              stencilCamera.layers.set(SECTION_LAYER);
              renderer.render(scene, stencilCamera);
            } else {
              material.clippingPlanes = null;
              renderer.render(scene, cam);
            }
          } finally {
            scene.overrideMaterial = null;
            scene.background = background;
            grid.visible = gridShown;
            overlay.visible = overlayShown;
            for (const o of hidden) o.visible = true;
          }
        },
        (ps) => {
          if (scope) caps.fill.clippingPlanes = ps;
          else renderer.clippingPlanes = ps;
        },
      );
      sections.caps = caps.last;
      if (sections.outline.children.length) {
        renderer.clippingPlanes = [];
        const autoClear = renderer.autoClear;
        renderer.autoClear = false;
        renderer.render(outlineHolder, cam);
        renderer.autoClear = autoClear;
      }
    } finally {
      renderer.clippingPlanes = saved;
      caps.fill.clippingPlanes = null;
    }
  };
  const drawingSize = new THREE.Vector2();
  const ensureTarget = (scale: number, wantSamples: number) => {
    renderer.getDrawingBufferSize(drawingSize);
    const w = Math.max(1, Math.round(drawingSize.x * scale));
    const h = Math.max(1, Math.round(drawingSize.y * scale));
    if (!target) {
      // half float keeps colour above 1 for the tone mapping (where the context can render to it)
      const half = renderer.extensions.has("EXT_color_buffer_float") || renderer.extensions.has("EXT_color_buffer_half_float");
      // depth as a texture (the ink pass reads it) with a stencil bit for the section caps
      const depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedInt248Type);
      depthTexture.format = THREE.DepthStencilFormat;
      // the stencil is never resolved (the caps use it inside the multisampled buffer; resolving it is slow on D3D),
      // and the depth only once per frame, after the last pass (drawScene)
      target = new THREE.WebGLRenderTarget(w, h, { samples: wantSamples, type: half ? THREE.HalfFloatType : THREE.UnsignedByteType, depthBuffer: true, stencilBuffer: true, depthTexture, resolveStencilBuffer: false });
    } else if (target.width !== w || target.height !== h) target.setSize(w, h);
    if (target.samples !== wantSamples) {
      target.samples = wantSamples;
      target.dispose();
    }
    return target;
  };
  const bg = new THREE.Color();
  const clear = new THREE.Color();
  /** The foveal inset's camera: the scene camera narrowed to the focused parts' rectangle. */
  const insetCamera = new THREE.PerspectiveCamera();
  insetCamera.matrixAutoUpdate = true;

  // ---- the quality curve (PB-1176) ----
  const ctl = new QualityController({ ...(options.quality ?? {}), ...urlQuality() });
  const budgetFixed = options.quality?.budgetMs !== undefined || urlQuality().budgetMs !== undefined;
  /** The display period as measured (ms); measured again once the loads settle when the first try looked slow. */
  let displayPeriodMs = 1000 / 60;
  let periodTries = 0;
  const measureBudget = () => {
    periodTries++;
    void measureDisplayPeriod().then((p) => {
      displayPeriodMs = p;
      if (!budgetFixed) ctl.config.budgetMs = budgetFromPeriod(p);
    });
  };
  measureBudget();
  const attention = new Attention();
  const effects = new Set<QualityEffect>();
  const gpu = new GpuTimer(renderer.getContext() as unknown as TimerGl);
  /** What the knobs set now. */
  const knobsNow = { effectsOff: false, scale: 1, coarse: false, merge: false };
  let merged: MergeResult | undefined;
  let mergedKey = "";
  const mergeFailed = new Set<string>();
  let mergeUseful = false;
  let sceneVersion = 0;
  let lastExternal = -Infinity;
  let policyDirty = false;
  let focusBoxes: { key: string; boxes: THREE.Box3[] } | undefined;
  let lastInset = false;
  const ring: QualitySampleRecord[] = [];
  const changeSubs = new Set<(r: QualityReport) => void>();
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  let prewarmTimer: ReturnType<typeof setTimeout> | undefined;
  let prewarmedFor = "";
  /** The GLB cache generation the knob trials were judged on (a new model: judge again). */
  let trialsGeneration = -1;
  let manualOn = false;
  /** The state last reported to `quality.onChange` subscribers. */
  let reportedState: QualityState = "idle";
  let suspendedPause = false;
  const prevCamera = new THREE.Matrix4();

  const policy: SyncPolicy = {
    // unfocused parts draw their coarse stand-in while the coarse knob is engaged
    geometryOf: (m) => (knobsNow.coarse && !attention.focused(m) ? coarseTier.geometryFor(m.geometry) : undefined),
    exclude: (m) => !!merged?.members.has(m),
  };

  const availability = (): Availability => {
    const st = coarseTier.stats;
    return {
      effects: effects.size > 0 || (aa === "msaa" && samples > 0),
      baseDpr,
      coarse: !!batcher && coarseTier.available && st.coarseTriangles < 0.9 * st.fineTriangles,
      merge: !!batcher && mergeUseful,
    };
  };
  const report = (): QualityReport => ({
    ...ctl.status(),
    enabled: ctl.config.enabled,
    gpuTimer: gpu.available,
    availability: ctl.availability,
    coarse: { ...coarseTier.stats },
    ...(merged ? { merge: { meshes: merged.meshes.length, members: merged.members.size, triangles: merged.triangles, ms: Math.round(merged.ms * 10) / 10 } } : {}),
    inset: lastInset,
    skipped: ctl.skipped,
    attention: attention.snapshot(),
  });
  const notify = () => {
    reportedState = ctl.state;
    if (!changeSubs.size) return;
    const r = report();
    for (const cb of changeSubs) {
      try {
        cb(r);
      } catch (e) {
        console.warn("[cad] quality subscriber failed:", e);
      }
    }
  };
  /** Make the scene match the engaged knobs (the next frame draws with them). */
  const applyKnobs = () => {
    const ks = ctl.knobs;
    const effectsOff = ks.includes("effects");
    if (effectsOff !== knobsNow.effectsOff) for (const e of effects) e.setEnabled(!effectsOff);
    const coarse = ks.includes("coarse");
    const merge = ks.includes("merge");
    if (coarse !== knobsNow.coarse || merge !== knobsNow.merge) policyDirty = true;
    Object.assign(knobsNow, { effectsOff, scale: Math.min(1, dprFor(ks, baseDpr) / baseDpr), coarse, merge });
    notify();
  };
  const refreshAvailability = () => {
    if (ctl.setAvailability(availability()).changed) applyKnobs();
  };

  /** Merged meshes for the unfocused parts: built when the knob is on and the scene has been still for a moment. */
  const maintainMerge = (external: boolean, now: number): boolean => {
    const want = knobsNow.merge && !external && now - lastExternal >= MERGE_QUIET_MS;
    const keyNow = `${sceneVersion}|${attention.version}|${knobsNow.coarse ? coarseTier.version : "fine"}`;
    let changed = false;
    if (merged && (!want || keyNow !== mergedKey)) {
      disposeMerged(merged);
      merged = undefined;
      changed = true;
    }
    if (want && !merged && !mergeFailed.has(keyNow)) {
      const inputs: MergeInput[] = [];
      const walk = (o: THREE.Object3D, visible: boolean) => {
        const vis = visible && o.visible;
        if (!vis) return;
        if (mergeable(o) && !attention.focused(o)) inputs.push({ mesh: o, geometry: (knobsNow.coarse ? coarseTier.geometryFor(o.geometry) : undefined) ?? o.geometry });
        for (const c of o.children) walk(c, vis);
      };
      for (const r of logicalRoots()) walk(r, true);
      const built = inputs.length > 1 ? buildMerged(inputs) : undefined;
      if (built) {
        merged = built;
        mergedKey = keyNow;
        for (const m of built.meshes) qualityRoot.add(m);
        changed = true;
      } else mergeFailed.add(keyNow);
    }
    return changed;
  };

  /** The focused parts' screen rectangle, for the foveal inset (CSS px, bottom-left origin). */
  const insetRect = () => {
    if (knobsNow.scale >= 1) return undefined;
    const keyNow = `${sceneVersion}|${attention.version}`;
    if (!focusBoxes || focusBoxes.key !== keyNow) focusBoxes = { key: keyNow, boxes: focusedBoxes(logicalRoots(), attention) };
    if (!focusBoxes.boxes.length) return undefined;
    const w = container.clientWidth;
    const h = container.clientHeight;
    const r = focusRect(focusBoxes.boxes, camera, w, h);
    if (!r || r.w * r.h > INSET_MAX_FRACTION * w * h) return undefined;
    return r;
  };

  /** Load the coarse tiers of the models this scene shows. */
  const prepareCoarse = async (): Promise<CoarseStats> => {
    const inScene = new Set<THREE.BufferGeometry>();
    for (const r of logicalRoots()) r.traverse((o) => (o as THREE.Mesh).isMesh && inScene.add((o as THREE.Mesh).geometry));
    const models = glbCache.loaded().filter((m) => {
      // a body loaded at the coarse tier already draws it
      if (!m.sidecar?.coarse || m.tier === "coarse") return false;
      let hit = false;
      m.gltf.scene.traverse((o) => {
        if (!hit && (o as THREE.Mesh).isMesh && inScene.has((o as THREE.Mesh).geometry)) hit = true;
      });
      return hit;
    });
    const before = coarseTier.version;
    const stats = await coarseTier.prepare(models);
    if (coarseTier.version !== before) {
      refreshAvailability();
      if (knobsNow.coarse) {
        policyDirty = true;
        invalidate("view");
      }
    }
    return stats;
  };
  const schedulePrewarm = () => {
    if (prewarmTimer) clearTimeout(prewarmTimer);
    // a second after the last scene change: the loads have settled; light scenes never need the coarse tier
    prewarmTimer = setTimeout(() => {
      prewarmTimer = undefined;
      if (disposed) return;
      // the first measure ran while the models loaded (a busy page stretches the gaps): once more, now it is quiet
      if (periodTries < 2 && displayPeriodMs > 17.5) measureBudget();
      if (last.triangles < COARSE_PREWARM_TRIANGLES) return;
      // once per set of loaded models (a selection change is a scene change too, and needs nothing loaded)
      const loadedKey = `${glbCache.generation}|${glbCache.loaded().length}`;
      if (loadedKey === prewarmedFor) return;
      prewarmedFor = loadedKey;
      void prepareCoarse().catch(() => undefined);
    }, 1000);
  };

  // ---- frames, drawn on demand ----
  const beforeRender = new Set<(dt: number) => boolean | void>();
  const frameSubs = new Set<(e: FrameEvent) => void>();
  const lostSubs = new Set<() => void>();
  let sceneDirty = true;
  /** Placements changed (`invalidate("pose")`). */
  let poseDirty = false;
  let inFrame = false;
  let lost = false;
  let suspending = false;
  let disposed = false;
  const last = { ms: 0, draws: 0, triangles: 0 };

  /**
   * The scene pass: straight to the canvas, or through the target (msaa, a lowered pixel ratio, the ink pass) and
   * the output pass, then the foveal inset. Section caps follow the scene pass in the same target.
   */
  const drawScene = (inset: { x: number; y: number; w: number; h: number } | undefined) => {
    renderer.info.reset();
    fitNear();
    const scale = knobsNow.scale;
    const ink = edgesWanted && edgesAllowed;
    edgesDrawn = ink;
    if (aa !== "msaa" && scale >= 1 && !ink) {
      renderer.render(scene, camera);
      last.draws = renderer.info.render.calls;
      last.triangles = renderer.info.render.triangles;
      drawSections(camera);
      return;
    }
    const out = ink ? (edgeQuad ??= outputQuad(true)) : (quad ??= outputQuad());
    const rt = ensureTarget(scale, ink ? edgeSamples : aa === "msaa" && !knobsNow.effectsOff ? samples : 0);
    // a multisampled target is resolved after every render call: the depth only after the last one (below)
    rt.resolveDepthBuffer = false;
    const background = scene.background;
    const clearAlpha = renderer.getClearAlpha();
    renderer.getClearColor(clear);
    // the background is composited after tone mapping (as a canvas clear colour is), not drawn into the target
    if (background instanceof THREE.Color) bg.copy(background);
    else bg.setRGB(0, 0, 0);
    scene.background = null;
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    last.draws = renderer.info.render.calls;
    last.triangles = renderer.info.render.triangles;
    drawSections(camera);
    if (ink && rt.samples > 0) {
      // one resolve with the depth, for the ink pass (an empty render: three resolves at the end of each render)
      rt.resolveDepthBuffer = true;
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.render(emptyScene, camera);
      renderer.autoClear = autoClear;
    }
    renderer.setRenderTarget(null);
    renderer.setClearColor(clear, clearAlpha);
    const u = out.material.uniforms;
    u.tDiffuse.value = rt.texture;
    const outBg = bg.getRGB(new THREE.Color(), renderer.outputColorSpace);
    (u.background.value as THREE.Vector3).set(outBg.r, outBg.g, outBg.b);
    if (ink) {
      u.tDepth.value = rt.depthTexture;
      (u.texel.value as THREE.Vector2).set(1 / rt.width, 1 / rt.height);
      // ink width in target pixels: CSS px x the canvas's pixel ratio x the target's scale
      u.inkWidth.value = Math.max(1, look.inkWidth * baseDpr * scale);
      u.cameraNear.value = camera.near;
      u.cameraFar.value = camera.far;
      (u.inkSilhouette.value as THREE.Vector3).copy(inkSilhouette);
      (u.inkCrease.value as THREE.Vector3).copy(inkCrease);
    }
    renderer.render(out.mesh, out.camera);
    if (inset) {
      // the focused parts at full pixel density (attention foveation): the whole scene again inside their
      // rectangle, so what stands in front of them still hides them; depth is cleared there only
      // rectangle; a camera narrowed to it (a view offset) culls the meshes wholly outside it
      const calls = renderer.info.render.calls;
      const tris = renderer.info.render.triangles;
      const autoClear = renderer.autoClear;
      const cw = container.clientWidth;
      const chh = container.clientHeight;
      insetCamera.copy(camera, false);
      insetCamera.setViewOffset(cw, chh, inset.x, chh - inset.y - inset.h, inset.w, inset.h);
      insetCamera.updateMatrixWorld(true);
      renderer.autoClear = false;
      renderer.setViewport(inset.x, inset.y, inset.w, inset.h);
      renderer.setScissor(inset.x, inset.y, inset.w, inset.h);
      renderer.setScissorTest(true);
      renderer.clearDepth();
      // the ground grid stays as the low-resolution pass drew it: its fine lines would show the rectangle's edge
      const gridShown = grid.visible;
      grid.visible = false;
      renderer.render(scene, insetCamera);
      grid.visible = gridShown;
      // the caps inside the inset too (they are content, not an effect)
      drawSections(insetCamera);
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, cw, chh);
      renderer.autoClear = autoClear;
      last.draws += renderer.info.render.calls - calls;
      last.triangles += renderer.info.render.triangles - tris;
    }
    scene.background = background;
  };

  const cameraMoved = () => {
    const a = camera.matrixWorld.elements;
    const b = prevCamera.elements;
    // 1e-4 of the distance to the target, and as much in rotation
    const eps = 1e-4 * Math.max(1, camera.position.distanceTo(controls.target));
    let moved = false;
    for (let i = 0; i < 16; i++)
      if (Math.abs(a[i] - b[i]) > (i >= 12 && i <= 14 ? eps : 1e-4)) {
        moved = true;
        break;
      }
    prevCamera.copy(camera.matrixWorld);
    return moved;
  };

  const scheduleWake = () => {
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = undefined;
    const w = ctl.nextWakeAt();
    if (w === undefined || disposed) return;
    wakeTimer = setTimeout(onWake, Math.max(0, w - performance.now()));
  };
  /** The settle timer: release, then the recovery curve, then one full-quality frame (and the snapshot). */
  const onWake = () => {
    wakeTimer = undefined;
    if (disposed || manualOn || lifecycle.state.suspended) return;
    const d = ctl.tick(performance.now());
    if (d.changed) applyKnobs();
    if (d.final) {
      notify();
      if (lifecycle.wantsSnapshots && !lost) scheduleSettleSnapshot();
      if (d.changed) invalidate("scene");
    } else if (d.changed) invalidate("scene");
    scheduleWake();
  };

  /**
   * The settle snapshot, after the view has rested `SETTLE_SNAPSHOT_DELAY_MS` and then at an idle moment (W3-C):
   * taken at once it read the canvas back while the GPU was still busy with the loads (200-300 ms on the main
   * thread on ClientX). A new gesture cancels it.
   */
  let settleShotTimer: ReturnType<typeof setTimeout> | undefined;
  let settleShotIdle: number | undefined;
  const cancelSettleSnapshot = () => {
    if (settleShotTimer) clearTimeout(settleShotTimer);
    settleShotTimer = undefined;
    const cancelIdle = (globalThis as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
    if (settleShotIdle !== undefined && cancelIdle) cancelIdle(settleShotIdle);
    settleShotIdle = undefined;
  };
  const scheduleSettleSnapshot = () => {
    cancelSettleSnapshot();
    settleShotTimer = setTimeout(() => {
      settleShotTimer = undefined;
      const run = () => {
        settleShotIdle = undefined;
        if (disposed || manualOn || lost || lifecycle.state.suspended || ctl.state !== "idle") return;
        void lifecycle.snapshot("settle");
      };
      const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
      if (idle) settleShotIdle = idle(run, { timeout: 1000 });
      else run();
    }, SETTLE_SNAPSHOT_DELAY_MS);
  };

  /** A state change (idle to interacting) is reported once, not every frame. */
  const notifyState = () => {
    if (ctl.state === reportedState) return;
    reportedState = ctl.state;
    notify();
  };

  const loop = createFrameLoop({
    frame: ({ dt, scene: changed, pose, flush, interval }) => {
      if (lost) return false;
      inFrame = true;
      const t0 = performance.now();
      let again = false;
      let animating = false;
      let moved = false;
      let inset: ReturnType<typeof insetRect> = undefined;
      const swapped: [THREE.Mesh, THREE.BufferGeometry][] = [];
      const swappedMaterials: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [];
      try {
        // damping and auto-rotate move the camera here; OrbitControls says whether it did
        if (controls.update(dt)) again = true;
        if (controls.autoRotate) again = true;
        for (const f of beforeRender)
          if (f(dt) === true) {
            again = true;
            animating = true;
          }
        const external = changed || sceneDirty;
        // placements only (an explode tween, a sequence playing): matrices are rewritten, nothing regrouped
        const posed = !external && (pose === true || poseDirty);
        poseDirty = false;
        // sections: CadView may write the renderer's planes itself; a model that moved or changed needs a new cut
        sections.checkGlobal();
        if (sections.active && (posed || rootChanged)) {
          if (rootChanged && scopeRoots) markScope();
          sections.changed();
        }
        rootChanged = false;
        if (external || posed) {
          sceneVersion++;
          lastExternal = t0;
          if (glbCache.generation !== trialsGeneration) {
            trialsGeneration = glbCache.generation;
            ctl.forgetTrials();
          }
        }
        // a camera move needs the camera's matrices only; anything else, the whole tree (then the batches follow it)
        if (external || posed || policyDirty) scene.updateMatrixWorld();
        else camera.updateMatrixWorld(true);
        moved = cameraMoved();
        const mergeChanged = batcher ? maintainMerge(external || posed, t0) : false;
        const sync = external || policyDirty || mergeChanged;
        sceneDirty = false;
        policyDirty = false;
        if (batcher && posed && !sync) batcher.refreshMatrices();
        if (batcher && sync) {
          batcher.sync(logicalRoots(), policy);
          // merging helps when there are many draws; judged on a sync that is not itself merged
          if (!merged) {
            const useful = batcher.last.groups + batcher.last.native >= MERGE_MIN_DRAWS;
            if (useful !== mergeUseful) {
              mergeUseful = useful;
              refreshAvailability();
            }
          }
        }
        inset = insetRect();
        // meshes drawn as themselves show their coarse stand-in for this draw only (picking reads the fine one)
        if (knobsNow.coarse && batcher)
          for (const m of batcher.singles) {
            const g = policy.geometryOf!(m);
            if (g && g !== m.geometry) {
              swapped.push([m, m.geometry]);
              m.geometry = g;
            }
          }
        // meshes drawn as themselves draw their toon twin (PB-1189), clipped through it under a scoped section
        if (batcher && (toonOn || scopeRoots)) {
          const own = merged ? [...batcher.own, ...merged.meshes] : batcher.own;
          for (const m of own) {
            const mat = m.material;
            if (!toonable(mat)) continue;
            const scoped = !!scopeRoots && m.userData.sectionScoped === true;
            if (!toonOn && !scoped) continue;
            swappedMaterials.push([m, mat]);
            m.material = twins.of(mat, { toon: toonOn, clip: scoped ? batcher.materials.clipPlanes : null });
            if (scoped) m.layers.enable(SECTION_LAYER);
          }
        }
        // subtrees the batches draw entirely are not walked by the renderer at all (ClientX: 140k nodes)
        const skip = batcher?.pure ?? [];
        const was = skip.map((o) => o.visible);
        for (const o of skip) o.visible = false;
        gpu.begin();
        try {
          drawScene(inset);
        } finally {
          gpu.end();
          skip.forEach((o, i) => (o.visible = was[i]));
        }
      } finally {
        for (const [m, g] of swapped) m.geometry = g;
        for (const [m, mat] of swappedMaterials) m.material = mat;
        inFrame = false;
      }
      last.ms = performance.now() - t0;
      lastInset = !!inset;
      const gpuMs = gpu.poll();
      const active = moved || animating;
      if (!flush && !manualOn) {
        const d = ctl.frame({ t: t0, cpuMs: last.ms, ...(gpuMs !== undefined ? { gpuMs } : {}), ...(interval !== undefined ? { intervalMs: interval } : {}), active });
        if (d.changed) applyKnobs();
        else if (active && ctl.state === "interacting") notifyState();
        scheduleWake();
      }
      if (changed && !flush) schedulePrewarm();
      const st = ctl.status();
      const q: FrameQuality = {
        state: st.state,
        rung: st.rung,
        knobs: st.knobs,
        bottleneck: st.bottleneck,
        dpr: st.dpr,
        budgetMs: Math.round(st.budgetMs * 100) / 100,
        ...(gpuMs !== undefined ? { gpuMs: Math.round(gpuMs * 100) / 100 } : {}),
        ...(interval !== undefined ? { intervalMs: Math.round(interval * 100) / 100 } : {}),
        ...(inset ? { inset: true } : {}),
      };
      ring.push({ t: t0, cpuMs: last.ms, ...(gpuMs !== undefined ? { gpuMs } : {}), ...(interval !== undefined ? { intervalMs: interval } : {}), active, flush: !!flush, state: st.state, knobs: st.knobs, draws: last.draws, triangles: last.triangles, dpr: st.dpr, inset: !!inset });
      if (ring.length > SAMPLE_RING) ring.splice(0, ring.length - SAMPLE_RING);
      if (frameSubs.size || frameListeners()) {
        const e: FrameEvent = { scene: id, ms: last.ms, draws: last.draws, triangles: last.triangles, quality: q };
        for (const cb of frameSubs) cb(e);
        emitFrame(e);
      }
      return again;
    },
  });
  /** Ask for a frame; inside a frame callback a scene change is picked up by this frame's batcher sync. */
  const invalidate = (what: Invalidation = "scene") => {
    if (what === "scene") sceneDirty = true;
    else if (what === "pose") poseDirty = true;
    if (!inFrame) loop.invalidate(what);
  };
  controls.addEventListener("change", () => invalidate("view"));
  // the gesture cannot settle while a pointer holds the view
  controls.addEventListener("start", () => {
    cancelSettleSnapshot();
    if (manualOn) return;
    if (ctl.pointer(true, performance.now()).changed) applyKnobs();
    notifyState();
    scheduleWake();
  });
  controls.addEventListener("end", () => {
    if (manualOn) return;
    ctl.pointer(false, performance.now());
    scheduleWake();
  });
  // a host that adds a model to the root (an artifact preview) needs no call of its own
  root.addEventListener("childadded", () => {
    rootChanged = true;
    invalidate();
  });
  root.addEventListener("childremoved", () => {
    rootChanged = true;
    invalidate();
  });
  attention.onChange(() => {
    focusBoxes = undefined;
    // what a knob does depends on what is focused (the inset, what is merged): judge them again
    ctl.forgetTrials();
    if (knobsNow.coarse || knobsNow.merge) {
      policyDirty = true;
      invalidate("view");
    }
    notify();
  });

  const ro = new ResizeObserver(() => {
    renderer.setSize(container.clientWidth, container.clientHeight);
    camera.aspect = container.clientWidth / Math.max(1, container.clientHeight);
    camera.updateProjectionMatrix();
    invalidate("view");
  });
  ro.observe(container);

  const canvas = renderer.domElement;
  let restored: ((ok: boolean) => void) | undefined;
  /** The 5 s wait for a restored context (cleared on dispose). */
  let restoreTimer: ReturnType<typeof setTimeout> | undefined;
  const onLost = (e: Event) => {
    // keep the chance of a restore; nothing is drawn until then
    e.preventDefault();
    lost = true;
    gpu.reset();
    // given back on purpose (suspend): not a crash
    if (suspending) return;
    for (const cb of lostSubs) cb();
    emitContextLost({ scene: id, at: performance.now() - created });
  };
  const onRestored = () => {
    lost = false;
    target?.dispose();
    target = null;
    gpu.reset();
    restored?.(true);
    restored = undefined;
    invalidate();
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  // ---- snapshot, suspend and resume (PB-1176) ----
  const setPaused = () => {
    loop.paused = manualOn || suspendedPause;
  };
  /** Drop every knob and draw now, synchronously. */
  const renderFull = () => {
    if (ctl.reset().changed) applyKnobs();
    loop.flush(1 / 30);
  };
  const lifecycle = new ViewLifecycle(
    {
      renderFull,
      read: () => new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), "image/png")),
      size: () => {
        renderer.getDrawingBufferSize(drawingSize);
        return { width: drawingSize.x, height: drawingSize.y };
      },
      frames: () => loop.frames,
      pause: (on) => {
        suspendedPause = on;
        setPaused();
        if (on) {
          if (wakeTimer) clearTimeout(wakeTimer);
          wakeTimer = undefined;
          ctl.reset();
          applyKnobs();
        }
      },
      ...(renderer.extensions.has("WEBGL_lose_context")
        ? {
            loseContext: () => {
              suspending = true;
              // the merged meshes and the target are rebuilt from the CPU side after the restore
              disposeMerged(merged);
              merged = undefined;
              renderer.forceContextLoss();
              return true;
            },
            restoreContext: () =>
              new Promise<boolean>((resolve) => {
                if (!renderer.getContext().isContextLost()) {
                  suspending = false;
                  resolve(true);
                  return;
                }
                restoreTimer = setTimeout(() => {
                  restoreTimer = undefined;
                  restored = undefined;
                  suspending = false;
                  resolve(false);
                }, 5000);
                restored = (ok) => {
                  if (restoreTimer) clearTimeout(restoreTimer);
                  restoreTimer = undefined;
                  suspending = false;
                  resolve(ok);
                };
                renderer.forceContextRestore();
              }),
          }
        : {}),
      warm: async () => {
        if (batcher) {
          scene.updateMatrixWorld();
          batcher.sync(logicalRoots(), policy);
          await renderer.compileAsync(batcher.root, camera, scene).catch(() => undefined);
        }
      },
      contextLost: () => lost,
      now: () => performance.now(),
    },
    { freeGpuWhenHidden: options.freeGpuWhenHidden ?? inVsCodeWebview() },
  );
  const onVisibility = () => {
    if (typeof document === "undefined") return;
    if (document.visibilityState === "hidden") void lifecycle.suspend({ reason: "hidden" });
    else void lifecycle.resume({ reason: "hidden" });
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);

  const upAxis = new THREE.Vector3(0, 0, 1);
  const lights: [THREE.Object3D, THREE.Vector3][] = [
    [key, key.position.clone()],
    [rim, rim.position.clone()],
  ];
  const gridBase = grid.quaternion.clone();
  const setUp = (up: THREE.Vector3) => {
    upAxis.copy(up).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), upAxis);
    camera.up.copy(upAxis);
    // OrbitControls keeps the rotation from camera.up to +y from its construction
    const c = controls as unknown as { _quat: THREE.Quaternion; _quatInverse: THREE.Quaternion };
    c._quat.setFromUnitVectors(upAxis, new THREE.Vector3(0, 1, 0));
    c._quatInverse.copy(c._quat).invert();
    for (const [light, base] of lights) light.position.copy(base).applyQuaternion(q);
    grid.quaternion.copy(q).multiply(gridBase);
    grid.position.copy(upAxis).multiplyScalar(-0.5);
    invalidate();
  };
  /** The model's bounds (the ground box): the near plane is fitted to it (R1-E's C1 handoff). */
  const modelBounds = new THREE.Box3();
  /**
   * The near plane fitted to the model each frame (R1-A for R1-E's C1, board z-fighting): half the gap between the
   * camera and the model's bounding sphere, at least 1 mm and at most 5 % of the distance to the target (DEFAULT).
   * With a fixed 1 mm near plane a 24-bit depth step at 600 mm is 0.021 mm, coarser than a board's layer gaps; at
   * a 30 mm near plane it is 0.0007 mm. Inside the bounds it stays 1 mm.
   */
  const fitNear = () => {
    let near = 1;
    if (!modelBounds.isEmpty()) {
      const sphere = modelBounds.getBoundingSphere(new THREE.Sphere());
      const gap = camera.position.distanceTo(sphere.center) - sphere.radius;
      near = nearPlaneFor(gap, camera.position.distanceTo(controls.target));
    }
    if (Math.abs(near - camera.near) > 1e-6) {
      camera.near = near;
      camera.updateProjectionMatrix();
    }
  };
  const setGround = (box: THREE.Box3) => {
    if (box.isEmpty()) return;
    modelBounds.copy(box);
    // the lowest point of the box along up, half a millimetre below it
    const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
    const low = Math.min(...corners.map((c) => c.dot(upAxis)));
    const c = box.getCenter(new THREE.Vector3());
    grid.position.copy(c.sub(upAxis.clone().multiplyScalar(c.dot(upAxis) - low + 0.5)));
    invalidate();
  };

  const frameAll = (box?: THREE.Box3) => {
    const b = box ?? new THREE.Box3().setFromObject(root);
    if (b.isEmpty()) return;
    const c = b.getCenter(new THREE.Vector3());
    const r = b.getSize(new THREE.Vector3()).length() / 2;
    const dir = camera.position.clone().sub(controls.target).normalize();
    controls.target.copy(c);
    camera.position.copy(c.clone().add(dir.multiplyScalar(r / Math.sin((camera.fov * Math.PI) / 360))));
    invalidate("view");
  };

  /** Programs for the objects' looks (instanced, shared) and for what is drawn as itself, compiled off the main path. */
  const compile = async (objects: THREE.Object3D[]) => {
    const tmp = new THREE.Scene();
    const looks = new Set<THREE.Material>();
    const own: THREE.Object3D[] = [];
    const stub = new THREE.BufferGeometry();
    stub.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
    stub.setAttribute("normal", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    stub.setAttribute("instanceEmissive", new THREE.InstancedBufferAttribute(new Float32Array(3), 3));
    for (const obj of objects)
      obj.traverse((o) => {
        if (batcher && isBatchable(o)) {
          const m = batcher.materials.get(lookOf(o, o.material as THREE.MeshStandardMaterial));
          if (looks.has(m)) return;
          looks.add(m);
          const inst = new THREE.InstancedMesh(stub, m, 1);
          inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(3), 3);
          tmp.add(inst);
        } else if ((o as THREE.Mesh).isMesh || (o as THREE.Line).isLine) own.push(o);
      });
    try {
      if (tmp.children.length) await renderer.compileAsync(tmp, camera, scene);
      for (const o of own) {
        // the toon twin is what will be drawn (PB-1189)
        const mesh = o as THREE.Mesh;
        const prev = mesh.material;
        if (toonOn && mesh.isMesh && toonable(prev)) mesh.material = twins.of(prev, { toon: true });
        try {
          await renderer.compileAsync(o, camera, scene);
        } finally {
          mesh.material = prev;
        }
      }
    } catch (e) {
      console.warn("[cad] compileAsync:", e);
    }
    stub.dispose();
  };

  const quality: QualityApi = {
    report,
    onChange: (cb) => {
      changeSubs.add(cb);
      return () => void changeSubs.delete(cb);
    },
    configure: (c) => {
      Object.assign(ctl.config, c);
      if (!ctl.config.enabled && ctl.reset().changed) {
        applyKnobs();
        invalidate("scene");
      }
    },
    prepareCoarse,
    samples: () => ring.slice(),
    registerEffect: (e) => {
      effects.add(e);
      e.setEnabled(!knobsNow.effectsOff);
      refreshAvailability();
      return () => {
        effects.delete(e);
        e.setEnabled(true);
        refreshAvailability();
      };
    },
  };

  const setLook = (next: SceneLook) => {
    look = next;
    applyLookToUniforms(toonU, look);
    srgbOf(look.silhouette, inkSilhouette);
    srgbOf(look.crease, inkCrease);
    caps.setColor(look.cap);
    caps.setInk(look.capLine);
    sections.setCapColor(look.cap);
    sections.setLineColor(look.capLine);
  };
  const style: StyleApi = {
    state: () => ({ toon: toonOn, edges: edgesWanted, edgesDrawn, look: { ...look, bands: [...look.bands] as SceneLook["bands"] } }),
    setToon: (on) => {
      if (on === toonOn) return;
      toonOn = on;
      setToneMapping();
      batcher?.materials.setToon(on);
      invalidate("scene");
    },
    setEdges: (on) => {
      if (on === edgesWanted) return;
      edgesWanted = on;
      invalidate("view");
    },
  };
  // the ink is the first thing the quality curve drops while the view moves over budget (PB-1176's `effects` rung)
  const offEdgesEffect = quality.registerEffect({
    name: "edges",
    setEnabled: (on) => {
      if (on === edgesAllowed) return;
      edgesAllowed = on;
      invalidate("view");
    },
  });
  const sectionsApi: SectionsApi = {
    set: (input) => {
      // a scope by instance path (an agent's request): the bodies under it
      const scope = input?.scope?.length ? [...input.scope] : input?.scopePaths?.length ? findScopeRoots(root, input.scopePaths) : [];
      if (input && !input.scope?.length && input.scopePaths?.length && !scope.length) console.warn(`[cad] section scope ${input.scopePaths.join(", ")}: nothing under it is drawn; cutting nothing`);
      scopeRoots = scope.length ? scope : null;
      markScope();
      const planes = input ? toPlanes(input.planes) : [];
      batcher?.materials.setClipPlanes(scopeRoots ? planes : []);
      // unscoped planes cut everything: the renderer's global planes (picking reads them too)
      renderer.clippingPlanes = scopeRoots ? [] : [...planes];
      sections.set(input && planes.length ? { ...input, planes, scope: scopeRoots } : null);
      invalidate("scene");
    },
    report: () => sections.report(),
    compute: () => sections.compute(),
  };
  sectionsByCamera.set(camera, () => sections.report());
  // the ink pass's program, compiled off the main path now: compiled on first use it cost the first frame after a
  // load ~80 ms on ANGLE d3d11 (W3-C's profile)
  if (edgesWanted) {
    edgeQuad ??= outputQuad(true);
    void renderer.compileAsync(edgeQuad.mesh, edgeQuad.camera).catch(() => undefined);
  }

  const handle: SceneHandle = {
    id,
    scene,
    camera,
    controls,
    renderer,
    root,
    overlay,
    frameAll,
    setUp,
    setGround,
    invalidate,
    beforeRender,
    onFrame: (cb) => {
      frameSubs.add(cb);
      return () => void frameSubs.delete(cb);
    },
    onContextLost: (cb) => {
      lostSubs.add(cb);
      return () => void lostSubs.delete(cb);
    },
    manual: {
      get on() {
        return manualOn;
      },
      set on(v: boolean) {
        manualOn = v;
        // a capture driver draws every frame itself, at full quality
        if (v && ctl.reset().changed) applyKnobs();
        setPaused();
        if (!v) invalidate();
      },
    },
    // what changed was said through invalidate(): a camera-only frame skips the batcher's sync; a capture is
    // never a degraded frame (the knobs drop first)
    renderOnce: () => {
      if (ctl.reset().changed) applyKnobs();
      loop.flush(1 / 30);
    },
    compile,
    stats: () => ({
      frames: loop.frames,
      last: { ...last },
      ...(batcher ? { batch: { ...batcher.last } } : {}),
      antialias: aa,
      samples,
      geometries: renderer.info.memory.geometries,
      programs: renderer.info.programs?.length ?? 0,
    }),
    logicalRoots,
    colors,
    setTheme: (theme) => {
      scene.background = new THREE.Color(theme.background);
      lightFor(scene.background as THREE.Color);
      setGridColors(theme.grid, theme.gridMinor);
      Object.assign(colors, sceneColors(theme));
      // the look's tokens (PB-1189) are read from the themed element the scene sits in: CadView and ModelView pass
      // only the colours above, so nothing changes for them
      setLook(readSceneLook((t) => (t === "inkWidth" ? resolveTokenValue(container, t) : resolveTokenColor(container, t))));
      invalidate();
    },
    quality,
    setAttention: (kind, keys) => void attention.set(kind, keys),
    attention: () => attention.snapshot(),
    onSnapshot: (cb) => lifecycle.onSnapshot(cb),
    snapshot: () => lifecycle.snapshot("request"),
    suspend: (o = {}) => lifecycle.suspend({ ...o, reason: "host" }),
    resume: () => lifecycle.resume({ reason: "host" }),
    lifecycle: () => lifecycle.state,
    onLifecycle: (cb) => lifecycle.onState(cb),
    style,
    sections: sectionsApi,
    dispose: () => {
      disposed = true;
      loop.dispose();
      ro.disconnect();
      if (wakeTimer) clearTimeout(wakeTimer);
      if (prewarmTimer) clearTimeout(prewarmTimer);
      cancelSettleSnapshot();
      // a restore still waited for: settle it now, and drop its 5 s timer (the wave 2 gate)
      if (restoreTimer) clearTimeout(restoreTimer);
      restoreTimer = undefined;
      restored?.(false);
      restored = undefined;
      offEdgesEffect();
      sections.dispose();
      caps.dispose();
      sectionsByCamera.delete(camera);
      edgeQuad?.material.dispose();
      edgeQuad?.mesh.geometry.dispose();
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      controls.dispose();
      batcher?.dispose();
      disposeMerged(merged);
      merged = undefined;
      gpu.dispose();
      target?.dispose();
      quad?.material.dispose();
      quad?.mesh.geometry.dispose();
      // the toon twins of the materials drawn as themselves (W4-D, wave 3 carry-forward)
      twins.dispose();
      renderer.dispose();
      // give the GL context back now rather than when the canvas is collected: browsers cap live contexts (the wave 2 gate)
      renderer.forceContextLoss();
      renderer.domElement.remove();
      debugScenes.delete(id);
    },
  };
  refreshAvailability();
  debugScenes.set(id, {
    handle,
    report,
    samples: () => ring.slice(),
    configure: quality.configure,
    setAttention: handle.setAttention,
    snapshot: handle.snapshot,
    suspend: handle.suspend,
    resume: handle.resume,
    prepareCoarse,
    manual: (on: boolean) => (handle.manual.on = on),
    style,
    sections: sectionsApi,
  });
  return handle;
}

// ---------------------------------------------------------------------------
// Camera rules (R1-A: M1 keep the camera across a hot swap, M11 explode envelope, E3 look along normal)
// ---------------------------------------------------------------------------

/** DEFAULT (R1-A, M1): a hot swap refits only when the model's size changes by more than this factor. */
export const REFIT_RATIO = 2;
/** DEFAULT (R1-A, M11): below this travel (mm) an explode moves nothing and the camera stays. */
export const EXPLODE_STILL_MM = 0.5;

/**
 * Whether a model that arrives again (a rebuild's hot swap, a remount) is refitted (R1-A, M1): only on a first
 * load (`previous` unknown and the camera not yet placed) or when its size (bounds diagonal) changed by more than
 * `ratio`. A camera already placed (by the person, a host, a restored state) is kept otherwise.
 */
export function needsRefit(previous: THREE.Box3 | null | undefined, next: THREE.Box3, placed: boolean, ratio = REFIT_RATIO): boolean {
  if (next.isEmpty()) return false;
  if (!previous || previous.isEmpty()) return !placed;
  const a = previous.getSize(new THREE.Vector3()).length();
  const b = next.getSize(new THREE.Vector3()).length();
  if (a <= 1e-9) return b > 1e-9;
  const k = b / a;
  return k > ratio || k < 1 / ratio;
}

/**
 * Where the camera goes as the model comes apart or together (R1-A, M11): nothing moves (`moved` under
 * EXPLODE_STILL_MM), the camera stays (null). Otherwise the view is kept as the person framed it and only scaled:
 * the target follows the change of the model's centre, the distance grows or shrinks with its bounding radius
 * (clamped to 0.25x to 4x). It never refits from scratch, so a close-up stays a close-up.
 */
export function explodeCamera(input: { from: THREE.Box3; to: THREE.Box3; moved: number; position: THREE.Vector3; target: THREE.Vector3 }): { position: THREE.Vector3; target: THREE.Vector3 } | null {
  const { from, to, moved, position, target } = input;
  if (!(moved >= EXPLODE_STILL_MM) || from.isEmpty() || to.isEmpty()) return null;
  const ra = from.getBoundingSphere(new THREE.Sphere()).radius;
  const rb = to.getBoundingSphere(new THREE.Sphere()).radius;
  const k = ra > 1e-9 ? Math.min(4, Math.max(0.25, rb / ra)) : 1;
  const shift = to.getCenter(new THREE.Vector3()).sub(from.getCenter(new THREE.Vector3()));
  const t = target.clone().add(shift);
  return { target: t, position: t.clone().add(position.clone().sub(target).multiplyScalar(k)) };
}

/**
 * The outward normal of a part's largest face (R1-A, E3), in world space: its own box (in the frame `toWorld`
 * takes it from) is flattest across one axis, and the largest face lies across it. Of the two sides, the one
 * facing `towardCamera` (camera minus target), so the view turns the least.
 */
export function dominantNormal(localBox: THREE.Box3, toWorld: THREE.Matrix4, towardCamera: THREE.Vector3): THREE.Vector3 {
  const size = localBox.getSize(new THREE.Vector3());
  const axis = size.x <= size.y && size.x <= size.z ? 0 : size.y <= size.z ? 1 : 2;
  const n = new THREE.Vector3().setComponent(axis, 1).applyMatrix3(new THREE.Matrix3().getNormalMatrix(toWorld)).normalize();
  if (n.lengthSq() === 0) return new THREE.Vector3(0, 0, 1);
  return n.dot(towardCamera) < 0 ? n.negate() : n;
}

/** The world normal of one triangle of a mesh (an instance of an InstancedMesh with `instance`), facing `toward`. */
export function triangleNormal(mesh: THREE.Mesh, triangle: number, toward: THREE.Vector3, instance?: number): THREE.Vector3 | undefined {
  const g = mesh.geometry as THREE.BufferGeometry | undefined;
  const pos = g?.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (!g || !pos) return undefined;
  const idx = g.index;
  if (triangle < 0 || triangle * 3 + 2 >= (idx ? idx.count : pos.count)) return undefined;
  const v = [0, 1, 2].map((i) => (idx ? idx.getX(triangle * 3 + i) : triangle * 3 + i));
  if (v.some((i) => !Number.isInteger(i) || i < 0 || i >= pos.count)) return undefined;
  const world = mesh.matrixWorld.clone();
  if (instance !== undefined && (mesh as THREE.InstancedMesh).isInstancedMesh) {
    const im = new THREE.Matrix4();
    (mesh as THREE.InstancedMesh).getMatrixAt(instance, im);
    world.multiply(im);
  }
  const [a, b, c] = v.map((i) => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(world));
  const n = b.clone().sub(a).cross(c.clone().sub(a));
  if (n.lengthSq() < 1e-18) return undefined;
  n.normalize();
  return n.dot(toward) < 0 ? n.negate() : n;
}

/**
 * The direction a part's surface mostly faces (gate R1, E3): the principal axis of its triangles' area-weighted
 * normals (sign-free n n^T, so a plate's two faces agree), in world space, facing `toward`. A part modelled in its
 * assembly's frame (ClientX's shell panels: their own box is not square to the panel) is faced square this way, where
 * its box's flattest axis is a diagonal through the shell. At most `maxTriangles` triangles are read (a stride
 * beyond, DEFAULT 200,000). Undefined when the objects have no area.
 */
export function principalNormal(objects: THREE.Object3D[], toward: THREE.Vector3, maxTriangles = 200_000): THREE.Vector3 | undefined {
  const c = [0, 0, 0, 0, 0, 0];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3(), n = new THREE.Vector3();
  const meshes: THREE.Mesh[] = [];
  // hidden meshes too: under the batcher a body's own meshes are not drawn themselves
  for (const o of objects) o.traverse((x) => { if ((x as THREE.Mesh).isMesh) meshes.push(x as THREE.Mesh); });
  let total = 0;
  for (const m of meshes) {
    const pos = m.geometry?.getAttribute("position");
    if (pos) total += (m.geometry.index ? m.geometry.index.count : pos.count) / 3;
  }
  if (!total) return undefined;
  const stride = Math.max(1, Math.ceil(total / maxTriangles));
  for (const m of meshes) {
    const g = m.geometry;
    const pos = g.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!pos) continue;
    m.updateWorldMatrix(true, false);
    const idx = g.index;
    const count = (idx ? idx.count : pos.count) / 3;
    const at = (i: number) => (idx ? idx.getX(i) : i);
    for (let t = 0; t < count; t += stride) {
      a.fromBufferAttribute(pos, at(t * 3)).applyMatrix4(m.matrixWorld);
      b.fromBufferAttribute(pos, at(t * 3 + 1)).applyMatrix4(m.matrixWorld);
      d.fromBufferAttribute(pos, at(t * 3 + 2)).applyMatrix4(m.matrixWorld);
      n.subVectors(b, a).cross(d.sub(a));
      const l = n.length();
      if (!(l > 0)) continue;
      // area-weighted: n n^T / |n| (|n| is twice the area)
      const w = 1 / l;
      c[0] += n.x * n.x * w; c[1] += n.x * n.y * w; c[2] += n.x * n.z * w;
      c[3] += n.y * n.y * w; c[4] += n.y * n.z * w; c[5] += n.z * n.z * w;
    }
  }
  if (!(c[0] + c[3] + c[5] > 0)) return undefined;
  const v = new THREE.Vector3(c[0] >= c[3] && c[0] >= c[5] ? 1 : 0.01, c[3] > c[0] && c[3] >= c[5] ? 1 : 0.02, c[5] > c[0] && c[5] > c[3] ? 1 : 0.03);
  for (let k = 0; k < 64; k++) {
    const x = c[0] * v.x + c[1] * v.y + c[2] * v.z, y = c[1] * v.x + c[3] * v.y + c[4] * v.z, z = c[2] * v.x + c[4] * v.y + c[5] * v.z;
    v.set(x, y, z);
    if (!(v.lengthSq() > 0)) return undefined;
    v.normalize();
  }
  return v.dot(toward) < 0 ? v.negate() : v;
}

/**
 * The camera looking at `target` along `normal` (from its outside), at the distance it is now (R1-A, E3). Straight
 * along the up axis the orbit would lose its heading, so the view keeps a sliver of its current heading there.
 */
export function lookAlong(target: THREE.Vector3, position: THREE.Vector3, normal: THREE.Vector3, up: THREE.Vector3): THREE.Vector3 {
  const distance = Math.max(1e-6, position.distanceTo(target));
  const n = normal.clone().normalize();
  const u = up.clone().normalize();
  if (Math.abs(n.dot(u)) > 0.9995) {
    const heading = position.clone().sub(target);
    heading.addScaledVector(u, -heading.dot(u));
    if (heading.lengthSq() < 1e-12) heading.set(1, 0, 0).addScaledVector(u, -u.x);
    n.addScaledVector(heading.normalize(), 0.02).normalize();
  }
  return target.clone().addScaledVector(n, distance);
}

/** Ease in and out (cubic). */
export const easeInOut = (k: number) => (k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2);

/**
 * A point on the way from one camera pose to another (R1-A, E3): the direction from the target turns along the
 * sphere (no swing through the model), the distance and the target move straight, both eased by `k` (0 to 1).
 */
export function cameraBetween(from: { position: THREE.Vector3; target: THREE.Vector3 }, to: { position: THREE.Vector3; target: THREE.Vector3 }, k: number): { position: THREE.Vector3; target: THREE.Vector3 } {
  const t = easeInOut(Math.min(1, Math.max(0, k)));
  const d0 = from.position.clone().sub(from.target);
  const d1 = to.position.clone().sub(to.target);
  const r = THREE.MathUtils.lerp(d0.length(), d1.length(), t);
  const q = new THREE.Quaternion().setFromUnitVectors(d0.clone().normalize(), d1.clone().normalize());
  const dir = d0.clone().normalize().applyQuaternion(new THREE.Quaternion().slerp(q, t));
  const target = from.target.clone().lerp(to.target, t);
  return { target, position: target.clone().addScaledVector(dir, r) };
}

/**
 * The near plane for a camera `gap` mm from the model's bounding sphere and `distance` mm from its target (R1-A for
 * R1-E's C1): half the gap, clamped to [1, 5 % of the distance] (DEFAULT); 1 mm when the camera is inside the bounds.
 */
export function nearPlaneFor(gap: number, distance: number): number {
  if (!(gap > 2) || !Number.isFinite(distance)) return 1;
  return Math.max(1, Math.min(0.5 * gap, 0.05 * distance));
}
