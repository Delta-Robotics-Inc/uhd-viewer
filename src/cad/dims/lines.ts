/**
 * One draw for many line segments (R3-C): a `LineSegments` whose buffers grow as needed and are rewritten on every
 * frame that draws them, with a colour per vertex and, for a dashed material, each segment's distance along itself
 * (so every segment starts on a dash). Used for the dimensions and angles (solid, dashed, and a faint ghost of the
 * solid lines that ignores depth) and for the explode path lines.
 */
import * as THREE from "three";

export class SegmentBatch {
  readonly geometry = new THREE.BufferGeometry();
  private pos: Float32Array;
  private col: Float32Array;
  private dist: Float32Array;
  private n = 0;
  private cap: number;

  constructor(capacity = 64) {
    this.cap = capacity;
    this.pos = new Float32Array(capacity * 6);
    this.col = new Float32Array(capacity * 6);
    this.dist = new Float32Array(capacity * 2);
    this.attach();
  }

  private attach() {
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute("color", new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute("lineDistance", new THREE.BufferAttribute(this.dist, 1).setUsage(THREE.DynamicDrawUsage));
  }

  /** Segments written since the last `begin`. */
  get count(): number {
    return this.n;
  }

  begin() {
    this.n = 0;
  }

  /** One segment from `a` to `b` in `colour`. */
  add(a: THREE.Vector3, b: THREE.Vector3, colour: THREE.Color) {
    if (![a.x, a.y, a.z, b.x, b.y, b.z].every(Number.isFinite)) return;
    if (this.n >= this.cap) this.grow();
    const i = this.n * 6;
    this.pos[i] = a.x;
    this.pos[i + 1] = a.y;
    this.pos[i + 2] = a.z;
    this.pos[i + 3] = b.x;
    this.pos[i + 4] = b.y;
    this.pos[i + 5] = b.z;
    for (let k = 0; k < 2; k++) {
      this.col[i + k * 3] = colour.r;
      this.col[i + k * 3 + 1] = colour.g;
      this.col[i + k * 3 + 2] = colour.b;
    }
    this.dist[this.n * 2] = 0;
    this.dist[this.n * 2 + 1] = a.distanceTo(b);
    this.n++;
  }

  /** A polyline as segments. */
  polyline(pts: THREE.Vector3[], colour: THREE.Color) {
    for (let i = 1; i < pts.length; i++) this.add(pts[i - 1], pts[i], colour);
  }

  /** Uploads what was written (only the used range). */
  end() {
    for (const name of ["position", "color", "lineDistance"]) {
      const a = this.geometry.getAttribute(name) as THREE.BufferAttribute;
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.n * (name === "lineDistance" ? 2 : 6));
      a.needsUpdate = true;
    }
    this.geometry.setDrawRange(0, this.n * 2);
  }

  /** The segment written at `i` (tests). */
  segment(i: number): { a: [number, number, number]; b: [number, number, number]; colour: [number, number, number] } {
    const k = i * 6;
    const r = (x: number) => Math.round(x * 1000) / 1000;
    return { a: [r(this.pos[k]), r(this.pos[k + 1]), r(this.pos[k + 2])], b: [r(this.pos[k + 3]), r(this.pos[k + 4]), r(this.pos[k + 5])], colour: [r(this.col[k]), r(this.col[k + 1]), r(this.col[k + 2])] };
  }

  private grow() {
    const cap = this.cap * 2;
    const pos = new Float32Array(cap * 6);
    const col = new Float32Array(cap * 6);
    const dist = new Float32Array(cap * 2);
    pos.set(this.pos);
    col.set(this.col);
    dist.set(this.dist);
    this.pos = pos;
    this.col = col;
    this.dist = dist;
    this.cap = cap;
    // a new buffer for each attribute: three uploads the larger array on the next draw
    this.geometry.dispose();
    this.attach();
  }

  dispose() {
    this.geometry.dispose();
  }
}

/** A line object over a batch (several objects may share one batch's geometry with different materials). */
export function segmentsOf(batch: SegmentBatch, material: THREE.Material, renderOrder: number): THREE.LineSegments {
  const l = new THREE.LineSegments(batch.geometry, material);
  l.frustumCulled = false;
  l.renderOrder = renderOrder;
  l.matrixAutoUpdate = false;
  l.userData.noBatch = true;
  return l;
}
