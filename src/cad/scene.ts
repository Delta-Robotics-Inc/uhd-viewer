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
import { createGlbCache, type LoadedModel, type LoadOptions } from "./render/glbCache";
import { createFrameLoop, type Invalidation } from "./render/loop";
import { Batcher, isBatchable, lookOf, LOGICAL_LAYER, type SyncStats } from "./render/batch";
import { emitContextLost, emitFrame, frameListeners, type FrameEvent } from "./render/events";

export { onGlbLoad, onFrame, onContextLost, type GlbLoadEvent, type FrameEvent, type ContextLostEvent } from "./render/events";
export { LOGICAL_LAYER } from "./render/batch";
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
    glowStrong: accent.clone().multiplyScalar(0.22).getHex(),
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
   * Ask for a frame: "view" when only the camera moved, "scene" (default)
   * when anything else changed. Frames are drawn only when asked for.
   */
  invalidate: (what?: Invalidation) => void;
  /**
   * Called before each drawn frame with the frame time in seconds. Return
   * true while an animation runs (the next frame is drawn too); call
   * `invalidate()` from it when it changed the scene.
   */
  beforeRender: Set<(dt: number) => boolean | void>;
  /** This scene's frames ({ms, draws, triangles}); the module-wide `onFrame` hears every scene. */
  onFrame: (cb: (e: FrameEvent) => void) => () => void;
  /** This scene's WebGL context was lost. */
  onContextLost: (cb: () => void) => () => void;
  /** When set, scheduled frames are skipped and the caller draws with `renderOnce` (video capture). */
  manual: { on: boolean };
  /** Draw a frame now, synchronously (a capture reads the canvas in the same task). */
  renderOnce: () => void;
  /**
   * Compile the programs `objects` will need, without blocking (`compileAsync`),
   * before they are added to the scene: no frame stalls on a shader compile.
   */
  compile: (objects: THREE.Object3D[]) => Promise<void>;
  /** Draw counts and what the batcher did. */
  stats: () => SceneStats;
  /** The trees the batcher draws (the scene's children but its own and the camera). */
  logicalRoots: () => THREE.Object3D[];
}

let nextSceneId = 1;

/** Composites the multisampled scene target onto the canvas: tone mapping and output colour space, then over the background. */
function outputQuad(): { mesh: THREE.Mesh; camera: THREE.OrthographicCamera; material: THREE.ShaderMaterial } {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
  const material = new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: null }, background: { value: new THREE.Vector3() } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    // the target holds linear colour, premultiplied by coverage where nothing opaque was drawn; the background
    // is added after tone mapping, in the output colour space, as the canvas's own clear colour would be
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform vec3 background;
      varying vec2 vUv;
      void main() {
        vec4 c = texture2D(tDiffuse, vUv);
        float a = clamp(c.a, 0.0, 1.0);
        vec3 rgb = a > 0.0001 ? c.rgb / a : vec3(0.0);
        #ifdef TONE_MAPPING
          rgb = toneMapping(rgb);
        #endif
        rgb = linearToOutputTexel(vec4(rgb, 1.0)).rgb;
        gl_FragColor = vec4(mix(background, rgb, a), 1.0);
      }`,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  return { mesh, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), material };
}

export function createScene(container: HTMLElement, options: SceneOptions = {}): SceneHandle {
  const id = nextSceneId++;
  const created = performance.now();
  const aa: AntialiasMode = options.antialias ?? "native";
  const samples = aa === "msaa" ? Math.max(0, options.samples ?? 4) : 0;
  // preserveDrawingBuffer false (PB-1175): a capture draws and reads in one task (renderOnce)
  const renderer = new THREE.WebGLRenderer({ antialias: aa === "native", preserveDrawingBuffer: false });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
  grid.rotation.x = Math.PI / 2;
  grid.position.z = -0.5;
  scene.add(grid);
  /** New grid colours: a GridHelper bakes them into its vertices, so the grid is rebuilt in place. */
  const setGridColors = (major: string, minor: string) => {
    const next = new THREE.GridHelper(600, 60, major, minor);
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
  const batcher = options.batching === false ? null : new Batcher();
  if (batcher) scene.add(batcher.root);
  const logicalRoots = () => scene.children.filter((c) => c !== batcher?.root && c !== camera);

  // ---- the multisampled target and the output pass (aa "msaa") ----
  let target: THREE.WebGLRenderTarget | null = null;
  const quad = aa === "msaa" ? outputQuad() : null;
  const drawingSize = new THREE.Vector2();
  const ensureTarget = () => {
    renderer.getDrawingBufferSize(drawingSize);
    const w = Math.max(1, drawingSize.x);
    const h = Math.max(1, drawingSize.y);
    if (!target) {
      // half float keeps colour above 1 for the tone mapping (where the context can render to it)
      const half = renderer.extensions.has("EXT_color_buffer_float") || renderer.extensions.has("EXT_color_buffer_half_float");
      target = new THREE.WebGLRenderTarget(w, h, { samples, type: half ? THREE.HalfFloatType : THREE.UnsignedByteType, depthBuffer: true });
    } else if (target.width !== w || target.height !== h) target.setSize(w, h);
    if (target.samples !== samples) {
      target.samples = samples;
      target.dispose();
    }
    return target;
  };
  const bg = new THREE.Color();
  const clear = new THREE.Color();

  // ---- frames, drawn on demand ----
  const beforeRender = new Set<(dt: number) => boolean | void>();
  const frameSubs = new Set<(e: FrameEvent) => void>();
  const lostSubs = new Set<() => void>();
  let sceneDirty = true;
  let inFrame = false;
  let lost = false;
  const last = { ms: 0, draws: 0, triangles: 0 };

  const drawScene = () => {
    renderer.info.reset();
    if (!quad) {
      renderer.render(scene, camera);
      last.draws = renderer.info.render.calls;
      last.triangles = renderer.info.render.triangles;
      return;
    }
    const rt = ensureTarget();
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
    renderer.setRenderTarget(null);
    scene.background = background;
    renderer.setClearColor(clear, clearAlpha);
    const u = quad.material.uniforms;
    u.tDiffuse.value = rt.texture;
    const out = bg.getRGB(new THREE.Color(), renderer.outputColorSpace);
    (u.background.value as THREE.Vector3).set(out.r, out.g, out.b);
    renderer.render(quad.mesh, quad.camera);
  };

  const loop = createFrameLoop({
    frame: ({ dt, scene: changed }) => {
      if (lost) return false;
      inFrame = true;
      const t0 = performance.now();
      let again = false;
      try {
        // damping and auto-rotate move the camera here; OrbitControls says whether it did
        if (controls.update(dt)) again = true;
        if (controls.autoRotate) again = true;
        for (const f of beforeRender) if (f(dt) === true) again = true;
        const sync = changed || sceneDirty;
        sceneDirty = false;
        // a camera move needs the camera's matrices only; anything else, the whole tree (then the batches follow it)
        if (sync) scene.updateMatrixWorld();
        else camera.updateMatrixWorld(true);
        if (batcher && sync) batcher.sync(logicalRoots());
        // subtrees the batches draw entirely are not walked by the renderer at all (ClientX: 140k nodes)
        const skip = batcher?.pure ?? [];
        const was = skip.map((o) => o.visible);
        for (const o of skip) o.visible = false;
        try {
          drawScene();
        } finally {
          skip.forEach((o, i) => (o.visible = was[i]));
        }
      } finally {
        inFrame = false;
      }
      last.ms = performance.now() - t0;
      if (frameSubs.size || frameListeners()) {
        const e: FrameEvent = { scene: id, ms: last.ms, draws: last.draws, triangles: last.triangles };
        for (const cb of frameSubs) cb(e);
        emitFrame(e);
      }
      return again;
    },
  });
  /** Ask for a frame; inside a frame callback a scene change is picked up by this frame's batcher sync. */
  const invalidate = (what: Invalidation = "scene") => {
    if (what === "scene") sceneDirty = true;
    if (!inFrame) loop.invalidate(what);
  };
  controls.addEventListener("change", () => invalidate("view"));
  // a host that adds a model to the root (an artifact preview) needs no call of its own
  root.addEventListener("childadded", () => invalidate());
  root.addEventListener("childremoved", () => invalidate());

  const ro = new ResizeObserver(() => {
    renderer.setSize(container.clientWidth, container.clientHeight);
    camera.aspect = container.clientWidth / Math.max(1, container.clientHeight);
    camera.updateProjectionMatrix();
    invalidate("view");
  });
  ro.observe(container);

  const canvas = renderer.domElement;
  const onLost = (e: Event) => {
    // keep the chance of a restore; nothing is drawn until then
    e.preventDefault();
    lost = true;
    for (const cb of lostSubs) cb();
    emitContextLost({ scene: id, at: performance.now() - created });
  };
  const onRestored = () => {
    lost = false;
    target?.dispose();
    target = null;
    invalidate();
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

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
  const setGround = (box: THREE.Box3) => {
    if (box.isEmpty()) return;
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
      for (const o of own) await renderer.compileAsync(o, camera, scene);
    } catch (e) {
      console.warn("[cad] compileAsync:", e);
    }
    stub.dispose();
  };

  return {
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
        return loop.paused;
      },
      set on(v: boolean) {
        loop.paused = v;
        if (!v) invalidate();
      },
    },
    // what changed was said through invalidate(): a camera-only frame skips the batcher's sync
    renderOnce: () => loop.flush(1 / 30),
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
      invalidate();
    },
    dispose: () => {
      loop.dispose();
      ro.disconnect();
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      controls.dispose();
      batcher?.dispose();
      target?.dispose();
      quad?.material.dispose();
      quad?.mesh.geometry.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
