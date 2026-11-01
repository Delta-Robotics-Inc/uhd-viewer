/**
 * The exact cut (PB-1186, the CPU half of the hybrid caps): where a section plane meets each part's triangles, as
 * closed or open polylines per part. Run once the view settles (the live view's caps are the stencil fill in
 * ./caps.ts); the results are data (`observe().sections`) and the outline drawn on the cap.
 *
 * Units: the logical meshes' geometry is glTF (metres, Y up) inside `cadWrapper`, whose ×1000 scale and +90° turn
 * about X are part of every mesh's world matrix. Triangles are cut in the mesh's own frame (the plane is taken
 * into it), and the segment ends are taken back out with the world matrix: **every number returned is world mm**
 * (Z up), the assembly's units. Nothing here converts by hand.
 *
 * Only triangles whose BVH node boxes straddle the plane are visited (three-mesh-bvh `shapecast`, the picking
 * BVH, built lazily by `bvhOf`), so a cut through ClientX's board reads a few thousand triangles, not 870 k.
 */
import * as THREE from "three";
import { INTERSECTED, NOT_INTERSECTED } from "three-mesh-bvh";
import { bvhOf } from "../render/pick";

export type Vec3 = [number, number, number];

export interface PartCut {
  /** The part's instance path (its body key's path, or the GLB node's `partInstanceId` within it). */
  instancePath: string;
  /** Chains of points (world mm); `closed[i]` when chain i returns to its start. */
  polylines: Vec3[][];
  closed: boolean[];
  /** Total length of the chains (mm). */
  lengthMm: number;
  /**
   * Every chain closes (PB-1186): false flags a mesh that is not watertight (vendor meshes often are not), whose cap
   * may be speckled. With other planes in force, the chains they trim are open too: then this is false by design.
   */
  watertight: boolean;
  /** Triangles the plane crossed. */
  triangles: number;
}

export interface SectionCut {
  /** The plane in world mm: n·p + constant = 0 (n points to the kept side). */
  plane: { normal: Vec3; constant: number };
  parts: PartCut[];
  /** CPU time of the slice (ms). */
  ms: number;
}

/** What to cut: a visible logical mesh and the instance path it belongs to. */
export interface SliceTarget {
  mesh: THREE.Mesh;
  instancePath: string;
}

/** Points closer than this (mm) are the same point when chaining segments (DEFAULT). */
export const WELD_MM = 1e-3;
/** A part's chains are capped at this many points in total (DEFAULT, keeps observe() replies small). */
export const MAX_POINTS_PER_PART = 20_000;

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** Segments where `plane` (in the geometry's frame) crosses the geometry's triangles, as point pairs in that frame. */
export function sliceGeometry(geometry: THREE.BufferGeometry, plane: THREE.Plane, useBvh = true): { segments: THREE.Vector3[]; triangles: number } {
  const segments: THREE.Vector3[] = [];
  let triangles = 0;
  const pos = geometry.getAttribute("position");
  if (!pos) return { segments, triangles };
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const cutTri = (p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3) => {
    const d0 = plane.distanceToPoint(p0);
    const d1 = plane.distanceToPoint(p1);
    const d2 = plane.distanceToPoint(p2);
    // all on one side (a vertex exactly on the plane counts as the + side, so a shared edge is not cut twice)
    const s0 = d0 >= 0;
    const s1 = d1 >= 0;
    const s2 = d2 >= 0;
    if (s0 === s1 && s1 === s2) return;
    const pts: THREE.Vector3[] = [];
    const edge = (pa: THREE.Vector3, pb: THREE.Vector3, da: number, db: number) => {
      if (da >= 0 === db >= 0) return;
      const t = da / (da - db);
      pts.push(new THREE.Vector3().lerpVectors(pa, pb, t));
    };
    edge(p0, p1, d0, d1);
    edge(p1, p2, d1, d2);
    edge(p2, p0, d2, d0);
    if (pts.length === 2) {
      segments.push(pts[0], pts[1]);
      triangles++;
    }
  };
  const bvh = useBvh && geometry.index !== undefined ? bvhOf(geometry) : undefined;
  if (bvh) {
    bvh.shapecast({
      intersectsBounds: (box) => (plane.intersectsBox(box) ? INTERSECTED : NOT_INTERSECTED),
      intersectsTriangle: (tri) => {
        cutTri(tri.a, tri.b, tri.c);
        return false;
      },
    });
    return { segments, triangles };
  }
  const index = geometry.index;
  const n = index ? index.count : pos.count;
  for (let i = 0; i + 2 < n; i += 3) {
    const i0 = index ? index.getX(i) : i;
    const i1 = index ? index.getX(i + 1) : i + 1;
    const i2 = index ? index.getX(i + 2) : i + 2;
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    cutTri(a, b, c);
  }
  return { segments, triangles };
}

/** Chain segment pairs into polylines, welding ends closer than `weld`. */
export function chainSegments(segments: Vec3[], weld = WELD_MM): { polylines: Vec3[][]; closed: boolean[] } {
  const key = (p: Vec3) => `${Math.round(p[0] / weld)},${Math.round(p[1] / weld)},${Math.round(p[2] / weld)}`;
  const n = segments.length >> 1;
  const at = new Map<string, number[]>();
  const add = (k: string, s: number) => {
    const l = at.get(k);
    if (l) l.push(s);
    else at.set(k, [s]);
  };
  const keys: string[] = [];
  for (let s = 0; s < n; s++) {
    const k0 = key(segments[2 * s]);
    const k1 = key(segments[2 * s + 1]);
    keys.push(k0, k1);
    if (k0 === k1) continue;
    add(k0, s);
    add(k1, s);
  }
  const used = new Uint8Array(n);
  const polylines: Vec3[][] = [];
  const closed: boolean[] = [];
  /** From the end `k` of a chain, the next unused segment and its far end. */
  const step = (k: string): { s: number; far: number } | undefined => {
    for (const s of at.get(k) ?? []) {
      if (used[s]) continue;
      return { s, far: keys[2 * s] === k ? 2 * s + 1 : 2 * s };
    }
    return undefined;
  };
  for (let s0 = 0; s0 < n; s0++) {
    if (used[s0] || keys[2 * s0] === keys[2 * s0 + 1]) continue;
    used[s0] = 1;
    const chain: Vec3[] = [segments[2 * s0], segments[2 * s0 + 1]];
    let head = keys[2 * s0];
    let tail = keys[2 * s0 + 1];
    for (let nx = step(tail); nx; nx = step(tail)) {
      used[nx.s] = 1;
      chain.push(segments[nx.far]);
      tail = keys[nx.far];
    }
    const isClosed = head === tail && chain.length > 3;
    if (!isClosed) {
      for (let nx = step(head); nx; nx = step(head)) {
        used[nx.s] = 1;
        chain.unshift(segments[nx.far]);
        head = keys[nx.far];
      }
    }
    if (isClosed) chain.pop();
    polylines.push(chain);
    closed.push(isClosed || (head === tail && chain.length > 2));
  }
  return { polylines, closed };
}

const _inv = new THREE.Matrix4();
const _m = new THREE.Matrix4();
const _w = new THREE.Matrix4();

/** The part of segment p-q on the kept side of every plane in `keep` (n·x + c ≥ 0), or undefined. */
export function clipSegment(p: THREE.Vector3, q: THREE.Vector3, keep: readonly THREE.Plane[]): [THREE.Vector3, THREE.Vector3] | undefined {
  let a = p;
  let b = q;
  for (const k of keep) {
    const da = k.distanceToPoint(a);
    const db = k.distanceToPoint(b);
    if (da < 0 && db < 0) return undefined;
    if (da >= 0 && db >= 0) continue;
    const x = new THREE.Vector3().lerpVectors(a, b, da / (da - db));
    if (da < 0) a = x;
    else b = x;
  }
  return [a, b];
}

/**
 * Cut every target with `plane` (world mm). Instanced meshes are cut once per instance. `keep`: the other planes
 * in force; what they cut away is left out of this plane's cut.
 */
export function slicePlane(plane: THREE.Plane, targets: SliceTarget[], options: { useBvh?: boolean; keep?: readonly THREE.Plane[] } = {}): SectionCut {
  const keep = options.keep ?? [];
  const t0 = performance.now();
  const byPath = new Map<string, { segments: Vec3[]; triangles: number }>();
  const local = new THREE.Plane();
  const box = new THREE.Box3();
  const cutWith = (world: THREE.Matrix4, mesh: THREE.Mesh, path: string) => {
    const g = mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    // the plane must cross the part's box at all
    box.copy(g.boundingBox!).applyMatrix4(world);
    if (!plane.intersectsBox(box)) return;
    _inv.copy(world).invert();
    local.copy(plane).applyMatrix4(_inv);
    const { segments, triangles } = sliceGeometry(g, local, options.useBvh ?? true);
    if (!segments.length) return;
    let rec = byPath.get(path);
    if (!rec) byPath.set(path, (rec = { segments: [], triangles: 0 }));
    rec.triangles += triangles;
    // out of the mesh's frame (glTF metres inside cadWrapper) into the world: mm, Z up
    for (let i = 0; i + 1 < segments.length; i += 2) {
      const seg = clipSegment(segments[i].applyMatrix4(world), segments[i + 1].applyMatrix4(world), keep);
      if (!seg) continue;
      for (const p of seg) rec.segments.push([r4(p.x), r4(p.y), r4(p.z)]);
    }
  };
  for (const { mesh, instancePath } of targets) {
    mesh.updateWorldMatrix(true, false);
    const inst = mesh as THREE.InstancedMesh;
    if (inst.isInstancedMesh) {
      for (let i = 0; i < inst.count; i++) {
        inst.getMatrixAt(i, _m);
        _w.multiplyMatrices(mesh.matrixWorld, _m);
        cutWith(_w, mesh, instancePath);
      }
    } else cutWith(mesh.matrixWorld, mesh, instancePath);
  }
  const parts: PartCut[] = [];
  for (const [instancePath, rec] of byPath) {
    const { polylines, closed } = chainSegments(rec.segments);
    let total = 0;
    let lengthMm = 0;
    const kept: Vec3[][] = [];
    const keptClosed: boolean[] = [];
    polylines.forEach((pl, i) => {
      if (total + pl.length > MAX_POINTS_PER_PART) return;
      total += pl.length;
      for (let j = 1; j < pl.length + (closed[i] ? 1 : 0); j++) {
        const p = pl[j - 1];
        const q = pl[j % pl.length];
        lengthMm += Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
      }
      kept.push(pl);
      keptClosed.push(closed[i]);
    });
    parts.push({ instancePath, polylines: kept, closed: keptClosed, lengthMm: Math.round(lengthMm * 1000) / 1000, watertight: keptClosed.every(Boolean), triangles: rec.triangles });
  }
  parts.sort((x, y) => (x.instancePath < y.instancePath ? -1 : x.instancePath > y.instancePath ? 1 : 0));
  return { plane: { normal: [r4(plane.normal.x), r4(plane.normal.y), r4(plane.normal.z)], constant: r4(plane.constant) }, parts, ms: Math.round((performance.now() - t0) * 10) / 10 };
}
