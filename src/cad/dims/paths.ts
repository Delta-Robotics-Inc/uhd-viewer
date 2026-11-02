/**
 * Explode path lines (R3-C, 2026-11-02; concept B, image 1: the dashed lines under the arms and motors): in an
 * exploded view, a thin dashed line from each moved part back to where it sits assembled, in a low-contrast ink
 * (`explodePath`), depth-tested, all of them one draw. Hidden while the model is assembled (explode 0) and for a
 * part that has not moved.
 *
 * Works on any record with an object and its assembled local matrix (`base`): CadView's bodies and hardware, a
 * body's named parts (an enclosure's lid, moved by position), and a board's components once they move on their own
 * (R3-A's board-as-assembly split passes them the same way). Each line runs from the part's anchor (its own box
 * centre) at its assembled place in its parent (the parent's world matrix now times `base`) to the same anchor
 * now, so a component that moves with its board and away from it draws only its own move.
 *
 * Units: world mm (../scene.ts cadWrapper scales the glTF metres at the boundary).
 */
import * as THREE from "three";
import { cssColour } from "../annot/layer";
import { SegmentBatch, segmentsOf } from "./lines";
import { DASH_PX, DIM_FALLBACK, GAP_PX } from "./style";
import { perPxAt } from "./geometry";

/** A part that can move: its object and its assembled placement in its parent (a matrix, or a position). */
export interface PathMover {
  obj: THREE.Object3D;
  /** The object's local matrix as assembled. */
  rest: THREE.Matrix4;
}

/** A line shorter than this is not drawn, mm (DEFAULT 0.5) or CSS px on screen (DEFAULT 4), whichever is longer. */
export const PATH_MIN_MM = 0.5;
export const PATH_MIN_PX = 4;
/** Below this explode amount there are no path lines (DEFAULT: the assembled view, and the last frames of an ease). */
export const PATH_MIN_EXPLODE = 0.002;
/** At most this many path lines (DEFAULT; a board's hundreds of components keep their first ones). */
export const MAX_PATHS = 600;

/** CadView's records as movers: bodies (with their named parts) and hardware; more lists (a board's movers) may follow. */
export function pathMovers(
  bodies: Iterable<{ obj: THREE.Object3D; base: THREE.Matrix4; parts?: readonly { obj: THREE.Object3D; base: THREE.Vector3 }[] }>,
  ...more: (Iterable<{ obj: THREE.Object3D; base: THREE.Matrix4 }> | undefined)[]
): PathMover[] {
  const out: PathMover[] = [];
  for (const b of bodies) {
    out.push({ obj: b.obj, rest: b.base });
    // a named body (an enclosure's lid) is moved by position inside its body: assembled at `base`
    for (const p of b.parts ?? []) out.push({ obj: p.obj, rest: new THREE.Matrix4().compose(p.base, p.obj.quaternion, p.obj.scale) });
  }
  for (const list of more) if (list) for (const m of list) out.push({ obj: m.obj, rest: m.base });
  return out;
}

/** An object's anchor in its own frame: the centre of its bounds (found once per object, DEFAULT). */
const anchors = new WeakMap<THREE.Object3D, THREE.Vector3>();
function anchorOf(obj: THREE.Object3D): THREE.Vector3 {
  let a = anchors.get(obj);
  if (!a) {
    obj.updateWorldMatrix(true, true, true);
    const box = new THREE.Box3().setFromObject(obj);
    // the world box's centre taken back into the object's frame (a box's centre maps to the transformed box's centre)
    a = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3()).applyMatrix4(obj.matrixWorld.clone().invert());
    anchors.set(obj, a);
  }
  return a;
}

export class ExplodePaths {
  readonly group = new THREE.Group();
  private batch = new SegmentBatch(128);
  private mat: THREE.LineDashedMaterial;
  private lines: THREE.LineSegments;
  private colour = new THREE.Color(DIM_FALLBACK.path);

  constructor() {
    this.group.name = "explode-paths";
    this.group.userData.noBatch = true;
    this.mat = new THREE.LineDashedMaterial({ vertexColors: true, depthTest: true, depthWrite: false, transparent: true, opacity: 1, dashSize: 1, gapSize: 1, toneMapped: false });
    // drawn before the callouts and dimensions (they sit over the paths)
    this.lines = segmentsOf(this.batch, this.mat, 16);
    this.group.add(this.lines);
    this.group.visible = false;
  }

  /** Read the theme's `explodePath` colour from an element under the themed root. */
  refreshColours(el: Element | null) {
    this.colour = new THREE.Color(cssColour(el, "--uhd-explode-path", DIM_FALLBACK.path));
  }

  /** Lines drawn on the last frame. */
  get count(): number {
    return this.group.visible ? this.batch.count : 0;
  }

  /** A line as written on the last frame (tests). */
  segment(i: number) {
    return this.batch.segment(i);
  }

  /**
   * Draw a line per moved part (call on every frame the view draws). `explode` is the view's explode amount
   * (0 assembled): no lines at 0. Returns how many were drawn.
   */
  update(movers: Iterable<PathMover>, camera: THREE.PerspectiveCamera, height: number, explode: number): number {
    this.batch.begin();
    if (!(explode > PATH_MIN_EXPLODE)) {
      this.batch.end();
      this.group.visible = false;
      return 0;
    }
    camera.updateMatrixWorld();
    const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    const from = new THREE.Vector3();
    const to = new THREE.Vector3();
    const restWorld = new THREE.Matrix4();
    let perPxSum = 0;
    for (const m of movers) {
      if (this.batch.count >= MAX_PATHS) break;
      if (!m.obj.parent || !m.obj.visible) continue;
      // three r187 keeps world matrices by dirty flag: the object's own is recomputed (forced) from its parent's, so a
      // component that rides on a moved board is right in this frame, before the renderer's own update
      m.obj.updateWorldMatrix(true, false, true);
      const a = anchorOf(m.obj);
      to.copy(a).applyMatrix4(m.obj.matrixWorld);
      restWorld.multiplyMatrices(m.obj.parent.matrixWorld, m.rest);
      from.copy(a).applyMatrix4(restWorld);
      const len = from.distanceTo(to);
      const perPx = perPxAt(camera, Math.max(camera.near, to.clone().sub(camPos).dot(fwd)), height);
      if (len < Math.max(PATH_MIN_MM, PATH_MIN_PX * perPx)) continue;
      this.batch.add(from, to, this.colour);
      perPxSum += perPx;
    }
    const n = this.batch.count;
    this.batch.end();
    // dashes a constant size on screen at the lines' mean depth (the material's dashes are world units)
    const k = n ? perPxSum / n : 1;
    this.mat.dashSize = DASH_PX * k;
    this.mat.gapSize = GAP_PX * k;
    this.group.visible = n > 0;
    this.group.updateMatrixWorld(true);
    return n;
  }

  dispose() {
    this.group.removeFromParent();
    this.batch.dispose();
    this.mat.dispose();
  }
}
