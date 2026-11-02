/**
 * Caps from the CPU cut, for open meshes (R2-B, 2026-11-02). The live caps (./caps.ts) count crossings in a stencil
 * bit, which only works for closed solids: an open mesh (a vendor STL with holes, a sheet) gives a speckled cap. For
 * such a part, once the view settles and its cut chains close, the cut polygons are filled on the CPU (with holes
 * by nesting) and drawn hatched over the live cap. A part whose mesh is open and whose cut does not close gets no
 * cap; the sections report says so for each part (`open`).
 *
 * Units: the chains are world mm (./slice.ts); the triangles returned are world mm too.
 */
import * as THREE from "three";
import type { Vec3 } from "./slice";

/** Meshes larger than this are taken as closed without the edge test (CAD exports are closed solids; DEFAULT). */
export const CLOSED_TEST_MAX_TRIANGLES = 400_000;

const closedCache = new WeakMap<THREE.BufferGeometry, boolean>();

/**
 * Whether a geometry is a closed surface: after welding positions (1 µm in the geometry's units, which are glTF
 * metres here: DEFAULT 1e-6), every edge is shared by exactly two triangles. Cached per geometry.
 */
export function meshIsClosed(geometry: THREE.BufferGeometry, weld = 1e-6): boolean {
  const cached = closedCache.get(geometry);
  if (cached !== undefined) return cached;
  const pos = geometry.getAttribute("position");
  if (!pos) return true;
  const index = geometry.index;
  const tris = (index ? index.count : pos.count) / 3;
  if (tris > CLOSED_TEST_MAX_TRIANGLES) {
    closedCache.set(geometry, true);
    return true;
  }
  // welded vertex ids
  const ids = new Int32Array(pos.count);
  const byKey = new Map<string, number>();
  const q = 1 / weld;
  for (let i = 0; i < pos.count; i++) {
    const key = `${Math.round(pos.getX(i) * q)},${Math.round(pos.getY(i) * q)},${Math.round(pos.getZ(i) * q)}`;
    let id = byKey.get(key);
    if (id === undefined) byKey.set(key, (id = byKey.size));
    ids[i] = id;
  }
  const edges = new Map<number, number>();
  const n = byKey.size;
  const add = (a: number, b: number) => {
    if (a === b) return;
    const k = a < b ? a * n + b : b * n + a;
    edges.set(k, (edges.get(k) ?? 0) + 1);
  };
  for (let t = 0; t < tris; t++) {
    const a = ids[index ? index.getX(t * 3) : t * 3];
    const b = ids[index ? index.getX(t * 3 + 1) : t * 3 + 1];
    const c = ids[index ? index.getX(t * 3 + 2) : t * 3 + 2];
    // a degenerate triangle (two corners welded) adds no edge of its own
    if (a === b || b === c || a === c) continue;
    add(a, b);
    add(b, c);
    add(c, a);
  }
  let closed = edges.size > 0;
  for (const count of edges.values())
    if (count !== 2) {
      closed = false;
      break;
    }
  closedCache.set(geometry, closed);
  return closed;
}

/** Signed area of a 2D ring. */
const area2 = (r: THREE.Vector2[]) => {
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    const a = r[i];
    const b = r[(i + 1) % r.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
};

const inside = (p: THREE.Vector2, ring: THREE.Vector2[]) => {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
};

/**
 * Triangles filling the closed chains of one part's cut (world mm, a flat array of xyz triples): each chain is
 * taken into the plane's 2D frame, chains nested an odd number of times are holes of the chain holding them, and
 * each outer ring is triangulated with its holes (three's ShapeUtils, earcut). Open chains are skipped.
 */
export function capTriangles(polylines: Vec3[][], closed: boolean[], normal: THREE.Vector3): number[] {
  const n = normal.clone().normalize();
  const ref = Math.abs(n.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(ref, n).normalize();
  const v = new THREE.Vector3().crossVectors(n, u).normalize();
  const rings: { pts2: THREE.Vector2[]; pts3: Vec3[]; area: number }[] = [];
  polylines.forEach((pl, i) => {
    if (!closed[i] || pl.length < 3) return;
    const pts2 = pl.map((p) => new THREE.Vector2(p[0] * u.x + p[1] * u.y + p[2] * u.z, p[0] * v.x + p[1] * v.y + p[2] * v.z));
    const a = area2(pts2);
    if (Math.abs(a) < 1e-9) return;
    rings.push({ pts2, pts3: pl, area: Math.abs(a) });
  });
  if (!rings.length) return [];
  // nesting depth of each ring (how many rings hold its first point); larger rings first
  rings.sort((a, b) => b.area - a.area);
  const depth = rings.map((r, i) => rings.slice(0, i).filter((o) => inside(r.pts2[0], o.pts2)).length);
  // the plane's offset along n (every point lies on it)
  const d = rings[0].pts3[0][0] * n.x + rings[0].pts3[0][1] * n.y + rings[0].pts3[0][2] * n.z;
  const out: number[] = [];
  rings.forEach((outer, i) => {
    if (depth[i] % 2 === 1) return;
    // holes: rings one level deeper whose first point lies in this outer ring
    const holes = rings.filter((h, j) => depth[j] === depth[i] + 1 && inside(h.pts2[0], outer.pts2)).map((h) => h.pts2);
    const contour = outer.pts2;
    const tris = THREE.ShapeUtils.triangulateShape(contour, holes);
    const all = [...contour, ...holes.flat()];
    for (const t of tris)
      for (const k of t) {
        const p = all[k];
        out.push(u.x * p.x + v.x * p.y + n.x * d, u.y * p.x + v.y * p.y + n.y * d, u.z * p.x + v.z * p.y + n.z * d);
      }
  });
  return out;
}
