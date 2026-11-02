/**
 * Sections (PB-1186): planes, hybrid caps and the cut as data.
 *
 * - The planes come from the view state's `sections` (`resolvePlanes`, ./planes.ts). A host puts them on the scene
 *   with `h.sections.set({ planes, scope })`; until CadView does, the scene also caps whatever planes CadView puts
 *   in `renderer.clippingPlanes` (the whole model).
 * - Live view: stencil caps every frame (./caps.ts).
 * - Settled view: the exact cut on the CPU (./slice.ts), a debounce after the last change of the planes or the
 *   model; the polylines are drawn on the cap (`sectionLine`) and returned by `observe()` as `sections`.
 *
 * Scope (a subtree, DEFAULT: one scope for every plane of a view): the planes clip only the meshes under the scope
 * roots (per-material clipping through the batcher's looks); otherwise they clip the whole model (the renderer's
 * global clipping planes).
 */
import * as THREE from "three";
import { instancePathIn, partInstanceIdOf } from "../render/ids";
import { shown } from "../render/pick";
import { slicePlane, type SectionCut, type SliceTarget } from "./slice";
import { HATCH_DEG, HATCH_MIN_PX, HATCH_MM, HATCH_SCREEN_PX, INK_ON_LIGHT, contrast, hatchAcross, hatchMaterial, inkFor, type HatchUniforms } from "./caps";
import { CAP_LINE_SHARE, DARK_CAP_SCENE, PAPER_CAP_SCENE, capTones, surfaceColour, type CapScene } from "./capColour";
import { capTriangles, meshIsClosed } from "./cpuCaps";
import { planeMeta, type PlaneMeta } from "./planes";

export { SectionCaps, HATCH_DEG, HATCH_MIN_PX, HATCH_MM, HATCH_SCREEN_PX, HATCH_LINE_PX, CAP_CLIP_TOLERANCE_MM, contrast, hatchAcross, hatchMaterial, inkFor, luminance } from "./caps";
export {
  capTones,
  capTonesLinear,
  capSceneParams,
  surfaceColour,
  isDarkGround,
  withLightness,
  lightness,
  CAP_SHIFT_TO_GROUND,
  CAP_LINE_DARKEN_DARK,
  CAP_LINE_DARKEN_PAPER,
  CAP_MIN_CONTRAST,
  CAP_CONTRAST_AIM,
  CAP_LINE_SHARE,
  DARK_CAP_SCENE,
  PAPER_CAP_SCENE,
  type CapScene,
} from "./capColour";
export { capTriangles, meshIsClosed } from "./cpuCaps";
export { slicePlane, sliceGeometry, chainSegments, clipSegment, WELD_MM, MAX_POINTS_PER_PART, type SectionCut, type PartCut, type SliceTarget } from "./slice";
export {
  resolvePlane,
  resolvePlanes,
  nextPlane,
  flipped,
  autoFlipOf,
  facePlane,
  originPlane,
  withOffset,
  withLegacy,
  offsetOf,
  offsetRange,
  planeFrame,
  isPlaced,
  dominantAxis,
  planeMeta,
  ORIGIN_PLANES,
  ORIGIN_INNER_SHARE,
  COPLANAR_KEEP_MM,
  MAX_SECTIONS,
  type PlacedPlaneFields,
  type PlaneMeta,
  type ResolvedPlane,
  type ScopedSectionPlane,
} from "./planes";

/** Wait after the last change of the planes or the model before the exact cut is computed (DEFAULT). */
export const SLICE_DEBOUNCE_MS = 250;

/** What `observe()` reports about sections. */
export interface SectionsReport {
  /**
   * Planes in force (world mm: n·p + constant = 0, n toward the kept side). R2-B, additive: where each came from
   * (`source`: the axis form, an origin plane, a picked face), its offset from its base plane (mm) and the face.
   */
  planes: ({ normal: [number, number, number]; constant: number } & Partial<PlaneMeta>)[];
  /** Instance paths the planes cut ("all": the whole model). */
  scope: string[] | "all";
  /** The exact cut per plane, once the view settled after the last change (null while it is being computed). */
  cuts: SectionCut[] | null;
  /** The live caps' last pass: planes capped, CPU ms of the pass, and (R4-C) the draw calls it made. */
  caps: { planes: number; ms: number; draws?: number };
  /** The caps' hatch (R2-B): spacing in model mm, angle, and the screen-space fallback (DEFAULTs in ./caps.ts). */
  hatch: { mm: number; deg: number; minPx: number; screenPx: number };
  /**
   * Parts whose mesh is open (not watertight), once the cut is computed (R2-B): their live cap may be speckled.
   * `cap: "cpu"`: filled from the closed cut chains instead; `"none"`: the cut does not close, no cap.
   */
  open: { instancePath: string; cap: "cpu" | "none"; note: string }[] | null;
}

export interface SectionsInput {
  /** World planes (mm): three.js planes, or `{ normal, constant }` (n·p + constant = 0, n toward the kept side). Empty: no section. */
  planes: (THREE.Plane | { normal: [number, number, number]; constant: number })[];
  /** Roots of the subtree the planes cut (null or absent: the whole model, unless `scopePaths` names some). */
  scope?: THREE.Object3D[] | null;
  /** Instance paths of the scope: the report names them, and without `scope` the scene finds the bodies under them. */
  scopePaths?: string[];
}

/** Planes as three.js planes (a host or an agent may pass plain `{ normal, constant }`). */
export function toPlanes(list: SectionsInput["planes"]): THREE.Plane[] {
  return list.map((p) => (p instanceof THREE.Plane ? p : new THREE.Plane(new THREE.Vector3(...p.normal).normalize(), p.constant)));
}

/** The bodies under instance paths: groups whose body key (`userData.key`, before any `#artifact`) is a path or below it. */
export function findScopeRoots(root: THREE.Object3D, paths: readonly string[]): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  root.traverse((o) => {
    const key = o.userData.key;
    if (typeof key !== "string") return;
    const path = key.split("#")[0];
    if (paths.some((p) => path === p || path.startsWith(`${p}/`))) out.push(o);
  });
  return out;
}

/** The instance path a logical mesh belongs to: the GLB node's `partInstanceId` within its body, else the body's own path. */
export function instancePathOfMesh(mesh: THREE.Object3D): string {
  let body: THREE.Object3D | undefined;
  for (let o: THREE.Object3D | null = mesh; o; o = o.parent) {
    if (typeof o.userData.key === "string") {
      body = o;
      break;
    }
    if (typeof o.userData.harness === "string" && !o.userData.key) return o.userData.harness as string;
    if (typeof o.userData.bodyKey === "string") return (o.userData.bodyKey as string).split("#")[0];
  }
  if (!body) return mesh.name || mesh.uuid;
  const path = (body.userData.key as string).split("#")[0];
  const id = partInstanceIdOf(mesh, body);
  return id ? instancePathIn(path, id.id) : path;
}

/** Meshes to cut: visible, lit surfaces under `roots` (lines, gizmos and see-through x-ray shells are not solids). */
export function sliceTargets(roots: THREE.Object3D[], filter?: (m: THREE.Mesh) => boolean): SliceTarget[] {
  const out: SliceTarget[] = [];
  for (const r of roots)
    r.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.geometry?.getAttribute("position") || !shown(m)) return;
      if (m.userData.noSection || m.userData.xray) return;
      const mat = m.material as THREE.Material;
      if (Array.isArray(mat) || !(mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) return;
      if (filter && !filter(m)) return;
      out.push({ mesh: m, instancePath: instancePathOfMesh(m) });
    });
  return out;
}

/** Each scene's sections report, found by its camera (observe() is handed the camera; ./render/observe.ts). */
export const sectionsByCamera = new WeakMap<THREE.Camera, () => SectionsReport | undefined>();

/** One scene's section state: the planes, their scope, the settled cut and its outline. */
export class SceneSections {
  private input: SectionsInput | undefined;
  /** Bumped by every change of the planes or the model: a cut computed for an older one is dropped. */
  private version = 0;
  private cutVersion = -1;
  private cuts: SectionCut[] | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The outline of the settled cut (world mm), drawn on the caps. */
  readonly outline = new THREE.Group();
  private lineMaterial = new THREE.LineBasicMaterial({ color: 0xd4d4d4, toneMapped: false, depthFunc: THREE.LessEqualDepth });
  /**
   * CPU caps of open meshes (R2-B): the cap tone with the hatch, over the live cap (drawn after it, unclipped). This
   * one holds the theme's tones; each cap mesh gets its own copy (R4-C: its part's tones, its plane's hatch direction).
   */
  private capMaterial = hatchMaterial({ color: 0x4a4640, side: THREE.DoubleSide, toneMapped: false, depthFunc: THREE.LessEqualDepth, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  private open: SectionsReport["open"] = null;
  /** The mesh each cut part's cap takes its colour from (the first logical mesh of that instance path). */
  private meshOf = new Map<string, THREE.Mesh>();
  /** Whether CPU caps take each part's colour (R4-C, DEFAULT on; as `SectionCaps.partColours`). */
  partColours = true;
  private tones: CapScene = DARK_CAP_SCENE;
  private sceneSet = false;
  caps: { planes: number; ms: number; draws?: number } = { planes: 0, ms: 0 };

  constructor(
    private deps: {
      /** The trees the cut walks (the scene's logical roots). */
      roots: () => THREE.Object3D[];
      /** The renderer's global planes (CadView's legacy whole-model section). */
      globalPlanes: () => readonly THREE.Plane[];
      /** Ask for a frame (the outline changed). */
      invalidate: () => void;
      /** The camera position, to lift the outline toward the viewer off the cap. */
      eye: () => THREE.Vector3;
      debounceMs?: number;
    },
  ) {
    this.outline.name = "section-outline";
    this.outline.renderOrder = 20;
    this.outline.matrixAutoUpdate = false;
    this.outline.userData.noSection = true;
  }

  /** Planes put on the scene by a host (`h.sections.set`); null: none set, the renderer's global planes are used. */
  set(input: SectionsInput | null): void {
    this.input = input ?? undefined;
    this.planesNow = input ? toPlanes(input.planes) : [];
    this.changed();
  }
  private planesNow: THREE.Plane[] = [];

  /** Planes in force now, and whether they are scoped. */
  planes(): { planes: THREE.Plane[]; scope: THREE.Object3D[] | null } {
    if (this.input) return { planes: this.planesNow, scope: this.input.scope?.length ? this.input.scope : null };
    return { planes: [...this.deps.globalPlanes()], scope: null };
  }

  get active(): boolean {
    return this.planes().planes.length > 0;
  }

  /** The planes or the model changed: drop the cut, compute again once things are quiet. */
  changed(): void {
    this.version++;
    this.cuts = null;
    if (this.outline.children.length) {
      this.clearOutline();
      this.deps.invalidate();
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.active) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.compute();
    }, this.deps.debounceMs ?? SLICE_DEBOUNCE_MS);
  }

  /** The global planes may have changed under us (CadView writes them directly): note a change when they did. */
  private lastGlobal = "";
  checkGlobal(): void {
    if (this.input) return;
    const key = this.deps
      .globalPlanes()
      .map((p) => `${p.normal.x},${p.normal.y},${p.normal.z},${p.constant}`)
      .join("|");
    if (key !== this.lastGlobal) {
      this.lastGlobal = key;
      this.changed();
    }
  }

  /** The exact cut now (synchronously); also what the debounce runs. */
  compute(): SectionCut[] {
    const { planes, scope } = this.planes();
    const roots = scope ?? this.deps.roots();
    const targets = sliceTargets(roots);
    const cuts = planes.map((p, i) => slicePlane(p, targets, { keep: planes.filter((_, j) => j !== i) }));
    this.cuts = cuts;
    this.cutVersion = this.version;
    // which parts are open meshes (R2-B): their caps come from the CPU cut where it closes
    const openPaths = new Set<string>();
    this.meshOf.clear();
    for (const t of targets) {
      if (!meshIsClosed(t.mesh.geometry)) openPaths.add(t.instancePath);
      if (!this.meshOf.has(t.instancePath)) this.meshOf.set(t.instancePath, t.mesh);
    }
    const open: NonNullable<SectionsReport["open"]> = [];
    for (const cut of cuts)
      for (const part of cut.parts) {
        if (!openPaths.has(part.instancePath) || open.some((o) => o.instancePath === part.instancePath)) continue;
        const fills = part.closed.some(Boolean);
        open.push({
          instancePath: part.instancePath,
          cap: fills ? "cpu" : "none",
          note: fills ? "open mesh: the cap is filled from the exact cut once the view settles; the live cap may be speckled" : "open mesh and the cut does not close: no cap",
        });
      }
    this.open = open;
    this.drawOutline(cuts, planes, openPaths);
    this.deps.invalidate();
    return cuts;
  }

  report(): SectionsReport | undefined {
    const { planes } = this.planes();
    if (!planes.length) return undefined;
    const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
    return {
      planes: planes.map((p) => {
        const meta = planeMeta.get(p);
        const normal: [number, number, number] = [r4(p.normal.x), r4(p.normal.y), r4(p.normal.z)];
        return { normal, constant: r4(p.constant), ...(meta ? { source: meta.source, ...(meta.offset !== undefined ? { offset: r4(meta.offset) } : {}), ...(meta.face ? { face: meta.face } : {}) } : {}) };
      }),
      scope: this.input?.scope?.length ? (this.input.scopePaths ?? []) : "all",
      cuts: this.cutVersion === this.version ? this.cuts : null,
      caps: { planes: this.caps.planes, ms: Math.round(this.caps.ms * 100) / 100, ...(this.caps.draws !== undefined ? { draws: this.caps.draws } : {}) },
      hatch: { mm: HATCH_MM, deg: HATCH_DEG, minPx: HATCH_MIN_PX, screenPx: HATCH_SCREEN_PX },
      open: this.cutVersion === this.version ? this.open : null,
    };
  }

  setLineColor(hex: string): void {
    this.lineMaterial.color.set(hex);
    // the CPU caps' hatch ink is the outline's ink (the theme's sectionLine)
    this.capMaterial.userData.hatch.uHatchInk.value.set(hex);
    // until the scene hands the cap tone over (`setCapColor`): the theme's cap for that ink (paper's dark ink, dark's light)
    if (!this.capSet) this.capMaterial.color.set(inkFor(hex) === INK_ON_LIGHT ? "#4a4640" : "#dcd7cd");
    // until the scene hands its background and lit tone over: the theme the ink belongs to (a dark ink is paper's)
    if (!this.sceneSet) this.tones = contrast(hex, "#000000") < contrast(hex, "#ffffff") ? PAPER_CAP_SCENE : DARK_CAP_SCENE;
  }
  private capSet = false;

  /** The scene's background and lit tone, the part tones of the CPU caps are derived against (as `SectionCaps`). */
  setSceneTones(tones: CapScene): void {
    this.sceneSet = true;
    this.tones = { ...tones };
  }

  /** The tones the CPU caps are derived against (tests, observe). */
  sceneTones(): CapScene {
    return { ...this.tones };
  }

  /**
   * The CPU cap material of one cut part on one plane (R4-C): a copy of the theme cap with its own hatch uniforms,
   * the plane's hatch direction, and each frame the tones of the part's surface (cached by colour). Without a mesh
   * to read, or with part colours off, the theme's tones.
   */
  private partCapMaterial(source: THREE.Mesh | undefined, normal: THREE.Vector3): THREE.MeshBasicMaterial & { userData: { hatch: HatchUniforms } } {
    const theme = this.capMaterial;
    const u = theme.userData.hatch;
    const own: HatchUniforms = {
      ...u,
      uHatchInk: { value: u.uHatchInk.value.clone() },
      uHatchShare: { value: u.uHatchShare.value },
      uHatchAcross: { value: hatchAcross(normal) },
    };
    const m = hatchMaterial({ color: theme.color.clone(), side: THREE.DoubleSide, toneMapped: false, depthFunc: THREE.LessEqualDepth, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }, own);
    const surface = new THREE.Color();
    let key = "";
    m.onBeforeRender = () => {
      if (!this.partColours || !source) {
        m.color.copy(theme.color);
        own.uHatchInk.value.copy(u.uHatchInk.value);
        own.uHatchShare.value = u.uHatchShare.value;
        key = "";
        return;
      }
      surfaceColour(source, new THREE.Color(this.tones.neutral), surface);
      const next = `${surface.getHexString()}|${this.tones.background}|${this.tones.neutral}`;
      if (next === key) return;
      key = next;
      const t = capTones(`#${surface.getHexString()}`, this.tones);
      m.color.set(t.fill);
      own.uHatchInk.value.set(t.line);
      own.uHatchShare.value = CAP_LINE_SHARE;
    };
    return m;
  }

  /** The cap tone of the CPU caps (the theme's sectionCap, as the live caps'). */
  setCapColor(hex: string): void {
    this.capSet = true;
    this.capMaterial.color.set(hex);
  }

  private clearOutline(): void {
    for (const c of [...this.outline.children]) {
      this.outline.remove(c);
      (c as THREE.LineSegments).geometry.dispose();
      // the CPU caps' own materials (R4-C); the outline's line material is shared
      const mat = (c as THREE.Mesh).material as THREE.Material;
      if (mat && mat !== this.lineMaterial && mat !== this.capMaterial) mat.dispose();
    }
  }

  private drawOutline(cuts: SectionCut[], planes: THREE.Plane[], openPaths: Set<string> = new Set()): void {
    this.clearOutline();
    const eye = this.deps.eye();
    cuts.forEach((cut, i) => {
      const p = planes[i];
      // CPU caps of open meshes, under the outline (R2-B)
      // one mesh per open part (R4-C: each in its own part's tones, with this plane's hatch direction)
      for (const part of cut.parts) {
        if (!openPaths.has(part.instancePath)) continue;
        const fill = capTriangles(part.polylines, part.closed, p.normal);
        if (!fill.length) continue;
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(fill, 3));
        const m = new THREE.Mesh(g, this.partCapMaterial(this.meshOf.get(part.instancePath), p.normal));
        m.frustumCulled = false;
        m.renderOrder = 19;
        m.userData.noSection = true;
        m.userData.noBatch = true;
        m.userData.capOf = part.instancePath;
        this.outline.add(m);
      }
      // lifted 0.02 mm off the cap toward the viewer, so the line is not lost in the cap's own depth
      const lift = p.distanceToPoint(eye) >= 0 ? 0.02 : -0.02;
      const dx = p.normal.x * lift;
      const dy = p.normal.y * lift;
      const dz = p.normal.z * lift;
      const pts: number[] = [];
      for (const part of cut.parts)
        part.polylines.forEach((pl, k) => {
          const n = pl.length;
          for (let j = 0; j + 1 < n + (part.closed[k] ? 1 : 0); j++) {
            const a = pl[j];
            const b = pl[(j + 1) % n];
            pts.push(a[0] + dx, a[1] + dy, a[2] + dz, b[0] + dx, b[1] + dy, b[2] + dz);
          }
        });
      if (!pts.length) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      const lines = new THREE.LineSegments(g, this.lineMaterial);
      lines.frustumCulled = false;
      lines.renderOrder = 20;
      lines.userData.noSection = true;
      lines.userData.noBatch = true;
      this.outline.add(lines);
    });
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.clearOutline();
    this.lineMaterial.dispose();
    this.capMaterial.dispose();
  }
}
