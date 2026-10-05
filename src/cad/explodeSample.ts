/**
 * Samples a part's surfaces for the exploded stack (./explode.ts): rays along
 * the up axis over the part's outline give its top and bottom heights, and
 * rays across the axis say whether one part surrounds another.
 */
import * as THREE from "three";
import { cellCentre, exitFrom, type ExitLine, type HeightGrid, type StackPart } from "./explode";

/** A sampled part, with the meshes it was sampled from (for the surround test). */
export interface SampledPart extends StackPart {
  meshes: THREE.Mesh[];
  /** Middle across the axis (u, v). */
  centre: [number, number];
}

/** Two directions across the axis, completing a right-handed frame with it. */
export function acrossAxis(axis: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
  const helper = Math.abs(axis.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(helper, axis).normalize();
  const v = new THREE.Vector3().crossVectors(axis, u).normalize();
  return [u, v];
}

/** Visible meshes under the objects, leaving out the subtrees in `skip` (named bodies that move on their own). */
function meshesOf(objects: THREE.Object3D[], skip: Set<THREE.Object3D>): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  const walk = (o: THREE.Object3D) => {
    if (!o.visible || skip.has(o)) return;
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
    for (const c of o.children) walk(c);
  };
  for (const o of objects) walk(o);
  return out;
}

/** Cast against meshes from both sides of every face (a mesh's back faces are surfaces too). */
function cast(ray: THREE.Raycaster, meshes: THREE.Mesh[]): THREE.Intersection | undefined {
  const sides = meshes.map((m) => {
    const mat = m.material as THREE.Material | THREE.Material[];
    const list = Array.isArray(mat) ? mat : [mat];
    const before = list.map((x) => x.side);
    for (const x of list) x.side = THREE.DoubleSide;
    return () => list.forEach((x, i) => (x.side = before[i]));
  });
  try {
    return ray.intersectObjects(meshes, false)[0];
  } finally {
    for (const restore of sides) restore();
  }
}

/** The part's top and bottom over a grid on its outline (world space, the assembled pose). */
export function sampleStackPart(key: string, objects: THREE.Object3D[], skip: Set<THREE.Object3D>, axis: THREE.Vector3, n = 14): SampledPart | undefined {
  const meshes = meshesOf(objects, skip);
  if (!meshes.length) return undefined;
  const box = new THREE.Box3();
  for (const m of meshes) box.expandByObject(m);
  if (box.isEmpty()) return undefined;
  const [U, V] = acrossAxis(axis);
  const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
  const range = (d: THREE.Vector3) => [Math.min(...corners.map((c) => c.dot(d))), Math.max(...corners.map((c) => c.dot(d)))] as const;
  const [u0, u1] = range(U);
  const [v0, v1] = range(V);
  const [lo, hi] = range(axis);
  const du = Math.max(1e-3, (u1 - u0) / n);
  const dv = Math.max(1e-3, (v1 - v0) / n);
  const top = new Float64Array(n * n).fill(NaN);
  const bottom = new Float64Array(n * n).fill(NaN);
  const grid: HeightGrid = { u0, v0, du, dv, nu: n, nv: n, top, bottom };
  const ray = new THREE.Raycaster();
  const span = hi - lo + 2;
  const down = axis.clone().negate();
  for (let k = 0; k < n * n; k++) {
    const u = u0 + ((k % n) + 0.5) * du;
    const v = v0 + (Math.floor(k / n) + 0.5) * dv;
    const at = (h: number) => U.clone().multiplyScalar(u).addScaledVector(V, v).addScaledVector(axis, h);
    ray.set(at(hi + 1), down);
    ray.far = span;
    const t = cast(ray, meshes);
    if (!t) continue;
    top[k] = hi + 1 - t.distance;
    ray.set(at(lo - 1), axis);
    const b = cast(ray, meshes);
    bottom[k] = b ? lo - 1 + b.distance : top[k];
  }
  if (top.every((x) => Number.isNaN(x))) return undefined;
  return { key, lo, hi, mid: (lo + hi) / 2, outline: [u0, u1, v0, v1], grid, meshes, centre: [(u0 + u1) / 2, (v0 + v1) / 2] };
}

/** Whether `holder` surrounds `part` across the axis: rays from the part's middle meet it on at least three of four sides. */
export function surrounded(holder: SampledPart, part: SampledPart, axis: THREE.Vector3): boolean {
  const [U, V] = acrossAxis(axis);
  const origin = U.clone().multiplyScalar(part.centre[0]).addScaledVector(V, part.centre[1]).addScaledVector(axis, part.mid);
  const reach = Math.hypot(holder.outline[1] - holder.outline[0], holder.outline[3] - holder.outline[2]) + 1;
  const ray = new THREE.Raycaster();
  ray.far = reach;
  let hits = 0;
  for (const d of [U, V, U.clone().negate(), V.clone().negate()]) {
    ray.set(origin, d);
    if (cast(ray, holder.meshes)) hits++;
  }
  return hits >= 3;
}

/**
 * Which way `part` leaves `holder`, from rays along the axis through every
 * sampled point of the part against the holder's own meshes (finer than the
 * holder's height grid: a probe's few millimetres through a cap's floor).
 */
export function exitByRays(holder: SampledPart, part: SampledPart, axis: THREE.Vector3, eps = 0.05): "up" | "down" | undefined {
  const [U, V] = acrossAxis(axis);
  const ray = new THREE.Raycaster();
  const down = axis.clone().negate();
  const span = Math.max(holder.hi, part.hi) - Math.min(holder.lo, part.lo) + 4;
  const g = part.grid;
  const lines: ExitLine[] = [];
  for (let k = 0; k < g.nu * g.nv; k++) {
    if (Number.isNaN(g.top[k])) continue;
    const [u, v] = cellCentre(g, k);
    const at = (h: number) => U.clone().multiplyScalar(u).addScaledVector(V, v).addScaledVector(axis, h);
    const high = Math.max(holder.hi, part.hi) + 2;
    const low = Math.min(holder.lo, part.lo) - 2;
    ray.far = span;
    ray.set(at(high), down);
    const fromAbove = cast(ray, holder.meshes);
    if (!fromAbove) continue;
    ray.set(at(low), axis);
    const fromBelow = cast(ray, holder.meshes);
    const holderTop = high - fromAbove.distance;
    const holderBottom = fromBelow ? low + fromBelow.distance : holderTop;
    lines.push({ partTop: g.top[k], partBottom: g.bottom[k], above: holderTop > g.top[k] + eps, below: holderBottom < g.bottom[k] - eps, holderTop, holderBottom });
  }
  return exitFrom(lines, eps);
}
