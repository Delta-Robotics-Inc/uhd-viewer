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

export { SectionCaps } from "./caps";
export { slicePlane, sliceGeometry, chainSegments, clipSegment, WELD_MM, MAX_POINTS_PER_PART, type SectionCut, type PartCut, type SliceTarget } from "./slice";
export { resolvePlane, resolvePlanes, nextPlane, flipped, MAX_SECTIONS, type ResolvedPlane, type ScopedSectionPlane } from "./planes";

/** Wait after the last change of the planes or the model before the exact cut is computed (DEFAULT). */
export const SLICE_DEBOUNCE_MS = 250;

/** What `observe()` reports about sections. */
export interface SectionsReport {
  /** Planes in force (world mm: n·p + constant = 0, n toward the kept side). */
  planes: { normal: [number, number, number]; constant: number }[];
  /** Instance paths the planes cut ("all": the whole model). */
  scope: string[] | "all";
  /** The exact cut per plane, once the view settled after the last change (null while it is being computed). */
  cuts: SectionCut[] | null;
  /** The live caps' last pass: planes capped, CPU ms of the pass. */
  caps: { planes: number; ms: number };
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
  caps = { planes: 0, ms: 0 };

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
    this.drawOutline(cuts, planes);
    this.deps.invalidate();
    return cuts;
  }

  report(): SectionsReport | undefined {
    const { planes } = this.planes();
    if (!planes.length) return undefined;
    const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
    return {
      planes: planes.map((p) => ({ normal: [r4(p.normal.x), r4(p.normal.y), r4(p.normal.z)], constant: r4(p.constant) })),
      scope: this.input?.scope?.length ? (this.input.scopePaths ?? []) : "all",
      cuts: this.cutVersion === this.version ? this.cuts : null,
      caps: { planes: this.caps.planes, ms: Math.round(this.caps.ms * 100) / 100 },
    };
  }

  setLineColor(hex: string): void {
    this.lineMaterial.color.set(hex);
  }

  private clearOutline(): void {
    for (const c of [...this.outline.children]) {
      this.outline.remove(c);
      (c as THREE.LineSegments).geometry.dispose();
    }
  }

  private drawOutline(cuts: SectionCut[], planes: THREE.Plane[]): void {
    this.clearOutline();
    const eye = this.deps.eye();
    cuts.forEach((cut, i) => {
      const p = planes[i];
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
  }
}
