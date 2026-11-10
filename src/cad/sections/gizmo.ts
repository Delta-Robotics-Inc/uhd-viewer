/**
 * The section view's tools in the 3D view (R2-B, 2026-11-02, Kevin's walkthrough G5): "when I click section view it
 * needs to ask me what face I want to create a section of; ... I can select a face, with the same highlight-face tech
 * that Bambu and Orca have; we can also create an offset, drag that plane forwards and backwards with a little
 * arrow, and set a distance".
 *
 * - Face pick: while on, the face under the pointer is highlighted (its B-rep face by the per-face id
 *   `_FEATURE_ID_0` where the sidecar has one, else the triangles of that mesh lying in the hit triangle's plane);
 *   a press on a highlighted face makes its plane the section plane (outward normal, offset 0, the side behind the
 *   face kept). A press elsewhere orbits as usual; Escape cancels (the toolbar routes it here).
 * - Plane and handle: while the section popover is open, the active plane shows as a thin outlined rectangle over
 *   the model's shadow on it, with an arrow along its normal at its centre. Dragging the arrow moves the plane
 *   along the normal (the offset, mm), the typed offset shows beside the arrow.
 *
 * Input: the tool listens on the canvas in the capture phase and takes a press only when it is its own (a press on
 * a highlighted face while picking, a press on the arrow), so orbiting, panning, the wheel and CadView's own picking
 * are untouched otherwise. A taken press is stopped before OrbitControls and CadView see it, so neither starts a
 * gesture or a selection.
 *
 * Units: world mm, Z up (the logical meshes' world matrices include `cadWrapper`'s metres-to-mm and Y-up-to-Z-up).
 * Drawing: overlay objects with shader materials that skip clipping (`clipping: false`), so the section's own
 * planes never cut the tool that moves them; drawn on top (no depth test) at a constant size on screen.
 *
 * Parity-neutral: the caps' stencil pass draws the whole scene (overlay included) once more, flipping a stencil bit
 * per fragment, so a flat sheet lying on the cut (the plane's fill, a highlighted face) would flip the bit over its
 * whole area and hatch it as if it were solid (seen headless on ClientX: the plane's rectangle came out hatched).
 * Every open sheet and line of the tool is therefore drawn twice, coincident: the two flips cancel; the closed
 * cone and dot flip an even number of times by themselves. Opacities are set per copy so the pair reads as asked.
 */
import * as THREE from "three";
import { pick, type Pick } from "../render/pick";
import { FEATURE_ID_ATTRIBUTE, featureIdAt, instancePathIn } from "../render/ids";
import { facePlane, offsetOf, offsetRange, planeFrame, withOffset, type ScopedSectionPlane } from "./planes";

/**
 * A face is planar when every corner lies within this distance of its mean plane (DEFAULT, mm; or 0.2 % of the face's
 * size when larger). A distance, not an angle: the view sidecar's quantized positions tilt small triangles of a flat
 * face by several degrees (seen on ClientX's panels), while their corners stay within a few hundredths of a mm.
 */
export const PLANAR_MM = 0.05;
/** Triangles of a mesh without face ids are in the hit's face when their normal is within this angle (DEFAULT, degrees)... */
export const COPLANAR_DEG = 5;
/** ...and their corners within this distance of the hit triangle's plane (DEFAULT, mm). */
export const COPLANAR_MM = 0.05;
/** The arrow's length on screen (DEFAULT, CSS px), the press radius around it (DEFAULT, CSS px). */
export const HANDLE_PX = 72;
export const HANDLE_HIT_PX = 12;
/** Shorter on screen than this share of HANDLE_PX, the arrow points at the eye: it is dragged by vertical travel (DEFAULT). */
export const SCREEN_DRAG_SHARE = 0.35;
/** A press on the canvas that moves farther than this is a drag (orbit), not a pick (DEFAULT, CSS px; CadView's own). */
export const CLICK_PX = 4;
/** A feature face that is not flat is still taken as flat when its coplanar part around the hit is this share of it (DEFAULT). */
export const FLAT_SHARE = 0.05;
/** At most this many triangles are read to gather one face (DEFAULT; a board's merged mesh is larger). */
export const FACE_MAX_TRIANGLES = 300_000;

/** The scene handle as far as the tool needs it (CadView's `SceneHandle`). */
export interface ToolScene {
  camera: THREE.PerspectiveCamera;
  controls: { target: THREE.Vector3; enabled: boolean };
  renderer: THREE.WebGLRenderer;
  root: THREE.Object3D;
  overlay: THREE.Group;
  invalidate: (what?: "scene" | "view" | "pose") => void;
  beforeRender: Set<(dt: number) => boolean | void>;
}

/** A face under the pointer: its triangles (world mm), plane and what names it. */
export interface FaceHit {
  /** Flat xyz triples, world mm. */
  triangles: Float32Array;
  /** Outward normal (unit, world) and a point on the face (its area-weighted centroid, or the hit point). */
  normal: THREE.Vector3;
  point: THREE.Vector3;
  /** Every corner lies within PLANAR_MM of the mean plane (not planar, a curved face: the plane is tangent at the hit). */
  planar: boolean;
  /** The part's instance path, the face id (feature id, or the hit triangle for a coplanar set), the body key. */
  path: string;
  face: number;
  body?: string;
  /** How the face was gathered. */
  source: "feature-id" | "coplanar";
  /** Area, mm². */
  areaMm2: number;
  /** The largest distance of a corner from the face's mean plane (mm): 0 for a flat face, more for a curved one. */
  spreadMm: number;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _n = new THREE.Vector3();

/** The world matrix a hit's triangles are in (an instance of an InstancedMesh included). */
function worldOf(mesh: THREE.Mesh, instance?: number): THREE.Matrix4 {
  mesh.updateWorldMatrix(true, false);
  const m = mesh.matrixWorld.clone();
  if (instance !== undefined && (mesh as THREE.InstancedMesh).isInstancedMesh) {
    const im = new THREE.Matrix4();
    (mesh as THREE.InstancedMesh).getMatrixAt(instance, im);
    m.multiply(im);
  }
  return m;
}

/** Corners of triangle t of a geometry in world mm (`world`), into a, b, c. */
function corners(g: THREE.BufferGeometry, t: number, world: THREE.Matrix4, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) {
  const p = g.getAttribute("position") as THREE.BufferAttribute;
  const idx = g.index;
  a.fromBufferAttribute(p, idx ? idx.getX(t * 3) : t * 3).applyMatrix4(world);
  b.fromBufferAttribute(p, idx ? idx.getX(t * 3 + 1) : t * 3 + 1).applyMatrix4(world);
  c.fromBufferAttribute(p, idx ? idx.getX(t * 3 + 2) : t * 3 + 2).applyMatrix4(world);
}

/**
 * The triangles of one face of `mesh`, world mm. With per-face ids (`_FEATURE_ID_0`, a sidecar of a STEP part) the
 * face is the triangles sharing the hit triangle's id; without them, or when that id covers a part that has no B-rep
 * faces (an STL part: one id for every triangle, ClientX's shell panels), the face is the triangles lying in the hit
 * triangle's plane. A feature face that is not flat (a cylinder) is reported as curved, its coplanar strip being a
 * small share of it (under `FLAT_SHARE`). The normal follows the triangles' winding (outward for a CAD export; a
 * mirrored matrix is taken into account; triangles wound the other way are turned to agree with the hit's).
 */
export function gatherFace(mesh: THREE.Mesh, triangle: number, instance?: number): Omit<FaceHit, "path" | "body"> | undefined {
  const g = mesh.geometry as THREE.BufferGeometry;
  const pos = g?.getAttribute("position");
  if (!pos) return undefined;
  const tris = (g.index ? g.index.count : pos.count) / 3;
  if (triangle < 0 || triangle >= tris) return undefined;
  const world = worldOf(mesh, instance);
  const mirrored = world.determinant() < 0;
  const feature = g.getAttribute(FEATURE_ID_ATTRIBUTE) ? featureIdAt(g, triangle) : undefined;
  // the hit triangle's plane
  corners(g, triangle, world, _a, _b, _c);
  const n0 = _b.clone().sub(_a).cross(_c.clone().sub(_a));
  if (n0.lengthSq() < 1e-18) return undefined;
  n0.normalize();
  if (mirrored) n0.negate();
  const d0 = n0.dot(_a);
  const cosTol = Math.cos((COPLANAR_DEG * Math.PI) / 180);
  const stride = Math.max(1, Math.ceil(tris / FACE_MAX_TRIANGLES));
  const coplanar = (t: number) => {
    if (t === triangle) return true;
    corners(g, t, world, _a, _b, _c);
    _n.copy(_b).sub(_a).cross(_c.clone().sub(_a));
    if (_n.lengthSq() < 1e-18) return false;
    _n.normalize();
    if (Math.abs(_n.dot(n0)) < cosTol) return false;
    return Math.abs(n0.dot(_a) - d0) <= COPLANAR_MM && Math.abs(n0.dot(_b) - d0) <= COPLANAR_MM && Math.abs(n0.dot(_c) - d0) <= COPLANAR_MM;
  };
  const sameFeature = (t: number) => featureIdAt(g, t) === feature;
  /** Triangles `keep` accepts: positions, the area-weighted normal, the centroid, the area, how flat. */
  const collect = (keep: (t: number) => boolean, all: boolean) => {
    const out: number[] = [];
    const sum = new THREE.Vector3();
    const centroid = new THREE.Vector3();
    let area = 0;
    let count = 0;
    for (let t = 0; t < tris; t += all || t === triangle ? 1 : stride) {
      if (!keep(t)) continue;
      corners(g, t, world, _a, _b, _c);
      _n.copy(_b).sub(_a).cross(_c.clone().sub(_a));
      const twice = _n.length();
      if (twice < 1e-12) continue;
      if (mirrored) _n.negate();
      if (_n.dot(n0) < 0) _n.negate();
      out.push(_a.x, _a.y, _a.z, _b.x, _b.y, _b.z, _c.x, _c.y, _c.z);
      sum.add(_n);
      centroid.addScaledVector(_a.clone().add(_b).add(_c), twice / 6);
      area += twice / 2;
      count++;
    }
    if (!out.length || area <= 0) return undefined;
    const normal = sum.lengthSq() > 1e-18 ? sum.normalize() : n0.clone();
    const c0 = centroid.divideScalar(area);
    // flat: every corner within PLANAR_MM (or 0.2 % of the face's size) of the mean plane through the centroid
    const tol = Math.max(PLANAR_MM, 0.002 * Math.sqrt(area));
    let spread = 0;
    for (let i = 0; i < out.length; i += 3) spread = Math.max(spread, Math.abs(normal.x * (out[i] - c0.x) + normal.y * (out[i + 1] - c0.y) + normal.z * (out[i + 2] - c0.z)));
    return { out, normal, c0, area, count, spread, planar: spread <= tol };
  };
  const result = (f: NonNullable<ReturnType<typeof collect>>, source: FaceHit["source"], face: number, planar = f.planar) => ({
    triangles: Float32Array.from(f.out),
    normal: planar ? f.normal : n0.clone(),
    point: planar ? f.c0 : new THREE.Vector3(),
    planar,
    face,
    source,
    areaMm2: Math.round(f.area * 100) / 100,
    spreadMm: Math.round(f.spread * 1000) / 1000,
  });
  if (feature !== undefined) {
    const byId = collect(sameFeature, true);
    if (byId?.planar) return result(byId, "feature-id", feature);
    // not flat: the triangles of that id lying in the hit's plane
    const flat = collect((t) => sameFeature(t) && coplanar(t), false);
    if (!byId || !flat) return byId ? result(byId, "feature-id", feature) : undefined;
    // an id that is the whole part (no B-rep faces), or a flat strip that is a good share of it: that plane is the face
    const wholePart = byId.count >= 0.9 * tris;
    if (wholePart || flat.area >= FLAT_SHARE * byId.area) return result(flat, "coplanar", triangle, true);
    return result(byId, "feature-id", feature, false);
  }
  const flat = collect(coplanar, false);
  return flat ? result(flat, "coplanar", triangle, true) : undefined;
}

/** The face a pick names (its triangles, plane and ids), or undefined for a pick on nothing face-like. */
export function faceOfPick(hit: Pick): FaceHit | undefined {
  const f = gatherFace(hit.object, hit.triangle, hit.instance);
  if (!f) return undefined;
  const bodyKey = hit.object.userData.bodyKey as string | undefined;
  const holder = bodyKey?.split("#")[0] ?? "";
  const child = (hit.object.userData.component as string | undefined) ?? hit.partInstanceId;
  const path = child === undefined ? holder : instancePathIn(holder, child);
  // a curved face: the plane is tangent at the point picked (DEFAULT)
  if (!f.planar) f.point = hit.point.clone();
  return { ...f, path, ...(bodyKey ? { body: bodyKey } : {}) };
}

/**
 * Where along a line (origin + s·dir) a ray passes closest (the handle's drag), in the line's units; undefined
 * when the ray runs along the line (the arrow points at the eye).
 */
export function rayLineParam(ray: THREE.Ray, origin: THREE.Vector3, dir: THREE.Vector3): number | undefined {
  const d = dir.clone().normalize();
  const r = ray.direction;
  const w = origin.clone().sub(ray.origin);
  const b = d.dot(r);
  const denom = 1 - b * b;
  if (denom < 1e-6) return undefined;
  // closest points of two lines: s on the handle's line
  return (b * w.dot(r) - w.dot(d)) / denom;
}

/** Distance (px) from a point to a segment on screen. */
export function segmentDistancePx(p: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2): number {
  const ab = b.clone().sub(a);
  const t = ab.lengthSq() > 0 ? Math.min(1, Math.max(0, p.clone().sub(a).dot(ab) / ab.lengthSq())) : 0;
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}

/** World mm per CSS pixel at `point` for a perspective camera and a canvas `heightPx` tall. */
export function mmPerPixel(camera: THREE.PerspectiveCamera, point: THREE.Vector3, heightPx: number): number {
  const dist = Math.max(1e-6, camera.position.distanceTo(point));
  return (2 * dist * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, heightPx);
}

/** A geometry with every triangle (or line segment) twice, coincident: it flips the caps' stencil bit an even number of times. */
export function doubled(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const flat = g.index ? g.toNonIndexed() : g;
  const p = flat.getAttribute("position").array as ArrayLike<number>;
  const out = new Float32Array(p.length * 2);
  out.set(p as Float32Array, 0);
  out.set(p as Float32Array, p.length);
  return new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(out, 3));
}

/** The opacity of each of two coincident copies that together read as `alpha`. */
export const halfAlpha = (alpha: number): number => 1 - Math.sqrt(1 - alpha);

/** A flat-colour material that ignores clipping planes and depth (the tool is always seen, never cut). */
function flat(color: THREE.ColorRepresentation, opacity = 1, depthTest = false): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity } },
    vertexShader: "void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }",
    fragmentShader: "uniform vec3 uColor; uniform float uOpacity; void main() { gl_FragColor = vec4( uColor, uOpacity ); }",
    transparent: opacity < 1,
    depthTest,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
    clipping: false,
  });
}

export interface SectionToolDeps {
  scene: ToolScene;
  /** The view state's planes now, and a write of a new list (one store batch). */
  planes: () => ScopedSectionPlane[];
  setPlanes: (list: ScopedSectionPlane[]) => void;
  /** The assembled bounds (mm): the planes' fractions and the outline's size. */
  bounds: () => THREE.Box3;
  /** The plane the outline and the handle show (DEFAULT the first). */
  active?: () => number;
  /** Accent colour of the outline, handle and face highlight (DEFAULT the scene accent). */
  accent?: string;
  /** Pick mode started or ended (the toolbar shows its state). */
  onPickChange?: (on: boolean) => void;
  /** The face under the pointer while picking (null: none), for the popover's status line. */
  onHover?: (face: FaceHit | null) => void;
}

/** The face pick, the plane outline and the drag handle on one scene. */
export class SectionTool {
  private picking = false;
  private shown = false;
  private hovered: FaceHit | null = null;
  private readonly group = new THREE.Group();
  private readonly highlight: THREE.Mesh;
  private readonly outline: THREE.LineSegments;
  private readonly fill: THREE.Mesh;
  private readonly shaft: THREE.LineSegments;
  private readonly head: THREE.Mesh;
  private readonly base: THREE.Mesh;
  private readonly label: HTMLDivElement | undefined;
  private frame: ReturnType<typeof planeFrame> | undefined;
  /**
   * A drag of the handle: along its 3D line (the pointer's ray's closest point on it), or, when the arrow points at
   * the eye and is short on screen, by the pointer's vertical travel (`screen`: mm per pixel at the plane, and the
   * sense: down brings the plane toward the viewer).
   */
  private drag: { pointer: number; start: number; startOffset: number; plane: number; origin: THREE.Vector3; dir: THREE.Vector3; screen?: { y: number; mmPerPx: number; sense: number } } | undefined;
  private press: { x: number; y: number; face: FaceHit } | undefined;
  private hot = false;
  private raf = 0;
  private lastMove: PointerEvent | undefined;
  private readonly el: HTMLElement;
  private readonly accent: THREE.Color;
  private readonly tick: (dt: number) => boolean | void;

  constructor(private deps: SectionToolDeps) {
    const s = deps.scene;
    this.el = s.renderer.domElement;
    this.accent = new THREE.Color(deps.accent ?? "#339fee");
    this.group.name = "section-tool";
    this.group.userData.noSection = true;
    this.group.userData.noBatch = true;
    this.group.renderOrder = 30;
    // the hovered face: translucent accent over the face (depth-tested against the model, a little in front)
    const hm = new THREE.MeshBasicMaterial({ color: this.accent, transparent: true, opacity: halfAlpha(0.45), depthWrite: false, side: THREE.DoubleSide, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    this.highlight = new THREE.Mesh(new THREE.BufferGeometry(), hm);
    this.highlight.visible = false;
    this.highlight.frustumCulled = false;
    this.highlight.renderOrder = 31;
    // the plane: an outline and a faint fill, unit square scaled per plane
    const square = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    // the outline's four edges as segments, each twice; the fill's two triangles, each twice
    const edges = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, -1, 0, 1, 1, 0, 1, 1, 0, -1, 1, 0, -1, 1, 0, -1, -1, 0], 3));
    square.dispose();
    this.outline = new THREE.LineSegments(doubled(edges), flat(this.accent, halfAlpha(0.9)));
    edges.dispose();
    this.fill = new THREE.Mesh(doubled(new THREE.PlaneGeometry(2, 2)), flat(this.accent, halfAlpha(0.05)));
    // the handle: a shaft, a cone head and a base dot along +z of its own frame (oriented to the plane's normal)
    this.shaft = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1], 3)), flat(this.accent));
    const cone = new THREE.ConeGeometry(0.09, 0.26, 20);
    cone.rotateX(Math.PI / 2);
    cone.translate(0, 0, 0.87);
    this.head = new THREE.Mesh(cone, flat(this.accent));
    this.base = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 8), flat(this.accent));
    for (const o of [this.outline, this.fill, this.shaft, this.head, this.base]) {
      o.frustumCulled = false;
      o.renderOrder = 32;
      o.matrixAutoUpdate = false;
    }
    this.group.add(this.highlight, this.fill, this.outline, this.shaft, this.head, this.base);
    this.group.visible = false;
    s.overlay.add(this.group);
    // the offset beside the arrow (DOM, so it reads at any zoom)
    const host = this.el.parentElement;
    if (host && typeof document !== "undefined") {
      this.label = document.createElement("div");
      this.label.className = "cad-section-offset";
      this.label.setAttribute("data-chrome", "toolbar");
      Object.assign(this.label.style, {
        position: "absolute",
        pointerEvents: "none",
        font: "500 11px var(--uhd-font-mono, ui-monospace, monospace)",
        padding: "1px 5px",
        borderRadius: "4px",
        background: "var(--uhd-surface-raised, #242424)",
        border: `1px solid #${this.accent.getHexString()}`,
        color: "var(--uhd-text, #e5e5e5)",
        display: "none",
        zIndex: "5",
        whiteSpace: "nowrap",
      } satisfies Partial<CSSStyleDeclaration>);
      host.appendChild(this.label);
    }
    // keep the handle a constant size on screen and the label beside it, every frame drawn
    this.tick = () => {
      this.layoutHandle();
      return false;
    };
    s.beforeRender.add(this.tick);
    this.el.addEventListener("pointerdown", this.onDown, true);
    this.el.addEventListener("pointermove", this.onMove);
    this.el.addEventListener("pointerleave", this.onLeave);
  }

  get isPicking(): boolean {
    return this.picking;
  }

  /** The face highlighted now (while picking). */
  get hoveredFace(): FaceHit | null {
    return this.hovered;
  }

  /** Show or hide the plane's outline and handle (the popover open). */
  setShown(on: boolean): void {
    this.shown = on;
    this.refresh();
  }

  startPick(): void {
    if (this.picking) return;
    this.picking = true;
    this.el.style.cursor = "crosshair";
    this.deps.onPickChange?.(true);
  }

  stopPick(): void {
    if (!this.picking) return;
    this.picking = false;
    this.press = undefined;
    this.el.style.cursor = "";
    this.setHover(null);
    this.deps.onPickChange?.(false);
  }

  /** The planes or the bounds changed: lay the outline and handle out again. */
  refresh(): void {
    const list = this.deps.planes();
    const i = Math.min(Math.max(0, this.deps.active?.() ?? 0), list.length - 1);
    const s = list[i];
    const box = this.deps.bounds();
    this.frame = s && !box.isEmpty() ? planeFrame(s, box) : undefined;
    const on = this.shown && Boolean(this.frame);
    for (const o of [this.outline, this.fill, this.shaft, this.head, this.base]) o.visible = on;
    this.group.visible = on || this.highlight.visible;
    if (this.frame) {
      const { centre, normal, u, v, half } = this.frame;
      const m = new THREE.Matrix4().makeBasis(u, v, normal).setPosition(centre);
      const plane = m.clone().multiply(new THREE.Matrix4().makeScale(half[0], half[1], 1));
      this.outline.matrix.copy(plane);
      this.fill.matrix.copy(plane);
      for (const o of [this.outline, this.fill]) o.matrixWorld.copy(o.matrix);
    }
    this.layoutHandle();
    this.deps.scene.invalidate("scene");
  }

  /** The handle at the plane's centre along its normal, HANDLE_PX long on screen; the label at its tip. */
  private layoutHandle(): void {
    const f = this.frame;
    const on = this.shown && Boolean(f);
    if (!f || !on) {
      if (this.label) this.label.style.display = "none";
      return;
    }
    const s = this.deps.scene;
    const h = this.el.clientHeight || 1;
    const len = HANDLE_PX * mmPerPixel(s.camera, f.handle, h);
    const scale = this.hot || this.drag ? 1.25 : 1;
    const m = new THREE.Matrix4().makeBasis(f.u, f.v, f.normal).setPosition(f.handle).multiply(new THREE.Matrix4().makeScale(len * scale, len * scale, len));
    for (const o of [this.shaft, this.head, this.base]) {
      o.matrix.copy(m);
      o.matrixWorld.copy(m);
    }
    if (this.label) {
      const tip = f.handle.clone().addScaledVector(f.normal, len * 1.15);
      const p = tip.project(s.camera);
      const w = this.el.clientWidth || 1;
      const x = ((p.x + 1) / 2) * w + this.el.offsetLeft;
      const y = ((1 - p.y) / 2) * h + this.el.offsetTop;
      const list = this.deps.planes();
      const plane = list[Math.min(Math.max(0, this.deps.active?.() ?? 0), list.length - 1)];
      const off = plane ? offsetOf(plane, this.deps.bounds()) : 0;
      this.label.textContent = `${off >= 0 ? "+" : ""}${off.toFixed(1)} mm`;
      // where the handle is on screen (CSS px in the canvas): scripts, tests and agents press it there
      const hs = this.handleOnScreen();
      if (hs) this.label.dataset.handle = [hs.a.x, hs.a.y, hs.b.x, hs.b.y].map((n) => Math.round(n)).join(",");
      this.label.style.left = `${Math.round(x + 8)}px`;
      this.label.style.top = `${Math.round(y - 10)}px`;
      this.label.style.display = p.z < 1 ? "block" : "none";
    }
  }

  /** The handle's ends on screen (CSS px within the canvas). */
  handleOnScreen(): { a: THREE.Vector2; b: THREE.Vector2 } | undefined {
    const f = this.frame;
    if (!f || !this.shown) return undefined;
    const s = this.deps.scene;
    const w = this.el.clientWidth || 1;
    const h = this.el.clientHeight || 1;
    const len = HANDLE_PX * mmPerPixel(s.camera, f.handle, h);
    const toPx = (v: THREE.Vector3) => {
      const p = v.clone().project(s.camera);
      return new THREE.Vector2(((p.x + 1) / 2) * w, ((1 - p.y) / 2) * h);
    };
    return { a: toPx(f.handle), b: toPx(f.handle.clone().addScaledVector(f.normal, len * 1.1)) };
  }

  private rayAt(e: { clientX: number; clientY: number }): THREE.Ray {
    const r = this.el.getBoundingClientRect();
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.deps.scene.camera);
    return rc.ray;
  }

  private nearHandle(e: { clientX: number; clientY: number }): boolean {
    const hs = this.handleOnScreen();
    if (!hs) return false;
    const r = this.el.getBoundingClientRect();
    return segmentDistancePx(new THREE.Vector2(e.clientX - r.left, e.clientY - r.top), hs.a, hs.b) <= HANDLE_HIT_PX;
  }

  /** The face under a pointer (the drawn model, what a section cut away skipped). */
  faceAt(e: { clientX: number; clientY: number }): FaceHit | undefined {
    const s = this.deps.scene;
    s.root.updateMatrixWorld();
    const hit = pick(this.rayAt(e), [s.root], { clippingPlanes: s.renderer.clippingPlanes, filter: (m) => m.userData.bodyKey !== undefined && !m.userData.noSection }); // wave R2 gate: "" is a body (a board's own level)
    return hit ? faceOfPick(hit) : undefined;
  }

  private setHover(face: FaceHit | null): void {
    this.hovered = face;
    const g = this.highlight.geometry;
    if (face) {
      // each triangle twice (parity-neutral, see the file comment)
      const two = new Float32Array(face.triangles.length * 2);
      two.set(face.triangles, 0);
      two.set(face.triangles, face.triangles.length);
      g.setAttribute("position", new THREE.BufferAttribute(two, 3));
      g.computeBoundingSphere();
      this.highlight.visible = true;
    } else this.highlight.visible = false;
    this.group.visible = this.highlight.visible || (this.shown && Boolean(this.frame));
    this.deps.onHover?.(face);
    this.deps.scene.invalidate("scene");
  }

  private onDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    // the handle first: a press on the arrow drags the plane
    if (this.nearHandle(e)) {
      const list = this.deps.planes();
      const i = Math.min(Math.max(0, this.deps.active?.() ?? 0), list.length - 1);
      const f = this.frame;
      if (!f || !list[i]) return;
      // an arrow pointing at the eye (shorter on screen than SCREEN_DRAG_SHARE of its length): drag by vertical travel
      const hs = this.handleOnScreen();
      const foreshortened = !hs || hs.a.distanceTo(hs.b) < HANDLE_PX * SCREEN_DRAG_SHARE;
      const t = foreshortened ? 0 : rayLineParam(this.rayAt(e), f.handle, f.normal);
      if (t === undefined) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      const cam = this.deps.scene.camera;
      const screen = foreshortened ? { y: e.clientY, mmPerPx: mmPerPixel(cam, f.handle, this.el.clientHeight || 1), sense: f.normal.dot(cam.position.clone().sub(f.handle)) >= 0 ? 1 : -1 } : undefined;
      // the drag runs along the line the handle had when it was taken (the handle follows the plane, the line does not)
      this.drag = { pointer: e.pointerId, start: t, startOffset: offsetOf(list[i], this.deps.bounds()), plane: i, origin: f.handle.clone(), dir: f.normal.clone(), ...(screen ? { screen } : {}) };
      this.deps.scene.controls.enabled = false;
      try {
        this.el.setPointerCapture(e.pointerId);
      } catch {
        /* a synthetic event has no capture */
      }
      window.addEventListener("pointermove", this.onDrag, true);
      window.addEventListener("pointerup", this.onUp, true);
      window.addEventListener("pointercancel", this.onUp, true);
      this.layoutHandle();
      this.deps.scene.invalidate("view");
      return;
    }
    // picking: a press on a highlighted face takes it (a press on nothing orbits as usual)
    if (this.picking) {
      const face = this.faceAt(e) ?? null;
      this.setHover(face);
      if (!face) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      this.choose(face);
    }
  };

  /** Make a face's plane the section plane: the active plane is replaced (or the first added). */
  choose(face: FaceHit): void {
    const list = this.deps.planes();
    const i = Math.min(Math.max(0, this.deps.active?.() ?? 0), Math.max(0, list.length - 1));
    const scope = list[0]?.scope;
    const next = facePlane(face.normal, face.point, this.deps.bounds(), { path: face.path, face: face.face, ...(face.body ? { body: face.body } : {}), planar: face.planar }, scope ? { scope } : undefined);
    const out = list.length ? list.map((x, j) => (j === i ? next : x)) : [next];
    this.deps.setPlanes(out);
    this.stopPick();
    this.refresh();
  }

  private onDrag = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointer) return;
    e.stopImmediatePropagation();
    const t = d.screen ? d.screen.sense * d.screen.mmPerPx * (e.clientY - d.screen.y) : rayLineParam(this.rayAt(e), d.origin, d.dir);
    if (t === undefined) return;
    const list = this.deps.planes();
    const s = list[d.plane];
    if (!s) return;
    const box = this.deps.bounds();
    // within the model's extent along the normal (beyond it the cut leaves nothing, or everything)
    const [lo, hi] = offsetRange(s, box);
    const offset = Math.min(hi, Math.max(lo, d.startOffset + (t - d.start)));
    this.deps.setPlanes(list.map((x, j) => (j === d.plane ? withOffset(x, offset, box) : x)));
    this.refresh();
  };

  private onUp = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointer) return;
    e.stopImmediatePropagation();
    this.drag = undefined;
    this.deps.scene.controls.enabled = true;
    try {
      this.el.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    window.removeEventListener("pointermove", this.onDrag, true);
    window.removeEventListener("pointerup", this.onUp, true);
    window.removeEventListener("pointercancel", this.onUp, true);
    this.layoutHandle();
    this.deps.scene.invalidate("view");
  };

  private onMove = (e: PointerEvent): void => {
    if (this.drag) return;
    this.lastMove = e;
    if (this.raf) return;
    // one pick per animation frame at most (DEFAULT)
    const run = () => {
      this.raf = 0;
      const m = this.lastMove;
      if (!m || m.buttons) return;
      const hot = this.nearHandle(m);
      if (hot !== this.hot) {
        this.hot = hot;
        this.el.style.cursor = hot ? "grab" : this.picking ? "crosshair" : "";
        this.layoutHandle();
        this.deps.scene.invalidate("view");
      }
      if (this.picking && !hot) {
        const face = this.faceAt(m) ?? null;
        if (!sameFace(face, this.hovered)) this.setHover(face);
      }
    };
    this.raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame(run) : (setTimeout(run, 16) as unknown as number);
  };

  private onLeave = (): void => {
    if (this.picking) this.setHover(null);
  };

  dispose(): void {
    this.stopPick();
    if (this.raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.raf);
    const s = this.deps.scene;
    s.beforeRender.delete(this.tick);
    this.el.removeEventListener("pointerdown", this.onDown, true);
    this.el.removeEventListener("pointermove", this.onMove);
    this.el.removeEventListener("pointerleave", this.onLeave);
    window.removeEventListener("pointermove", this.onDrag, true);
    window.removeEventListener("pointerup", this.onUp, true);
    window.removeEventListener("pointercancel", this.onUp, true);
    if (this.drag) s.controls.enabled = true;
    s.overlay.remove(this.group);
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose?.();
    });
    this.label?.remove();
    s.invalidate("scene");
  }
}

const sameFace = (a: FaceHit | null, b: FaceHit | null) => a === b || (!!a && !!b && a.path === b.path && a.face === b.face && a.body === b.body);
