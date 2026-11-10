/**
 * Samples a part's surfaces for the exploded stack (./explode.ts): rays along
 * the up axis over the part's outline give its top and bottom heights, and
 * rays across the axis say whether one part surrounds another.
 */
import * as THREE from "three";
import { cellCentre, exitFrom, planStack, type ExitLine, type HeightGrid, type StackPart } from "./explode";
import { bvhOf } from "./render/pick";

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

/** A raycaster that sees every layer: the meshes the batcher draws for them sit on a layer the camera skips (PB-1175). */
function sampler(): THREE.Raycaster {
  const ray = new THREE.Raycaster();
  ray.layers.enableAll();
  return ray;
}

const _inv = new THREE.Matrix4();
const _local = new THREE.Ray();
const _im = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _p = new THREE.Vector3();

/**
 * The nearest hit of the ray on the meshes, from both sides of every face (a mesh's back faces are surfaces too),
 * within `ray.far`. Ray against each geometry's BVH (three-mesh-bvh, the picking BVH of ./render/pick.ts, built
 * once per geometry and shared), so sampling a heavy board is milliseconds, not seconds; instanced meshes test
 * each instance.
 */
function cast(ray: THREE.Raycaster, meshes: THREE.Mesh[]): { distance: number } | undefined {
  let best: number | undefined;
  const test = (mesh: THREE.Mesh, world: THREE.Matrix4) => {
    _inv.copy(world).invert();
    _local.copy(ray.ray).applyMatrix4(_inv);
    const hit = bvhOf(mesh.geometry).raycastFirst(_local, THREE.DoubleSide);
    if (!hit) return;
    const d = _p.copy(hit.point).applyMatrix4(world).distanceTo(ray.ray.origin);
    if (d >= ray.near && d <= ray.far && (best === undefined || d < best)) best = d;
  };
  for (const mesh of meshes) {
    if (!mesh.geometry?.getAttribute("position")) continue;
    const inst = mesh as THREE.InstancedMesh;
    if (inst.isInstancedMesh) {
      for (let i = 0; i < inst.count; i++) {
        inst.getMatrixAt(i, _im);
        test(mesh, _world.multiplyMatrices(mesh.matrixWorld, _im));
      }
    } else test(mesh, mesh.matrixWorld);
  }
  return best === undefined ? undefined : { distance: best };
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
  const ray = sampler();
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
  const ray = sampler();
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
  const ray = sampler();
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

/**
 * The stack plan over sampled elements (moved here from CadView's `planStacks`, PB-1183): each element's rise
 * along `axis` when fully exploded, by key. The scene must be at the assembled pose with world matrices current.
 * Used only for what no mate places (display-hint parts, a bare multi-body GLB, named bodies along up); mated
 * parts follow the assembly sequence.
 */
export function planStackRises(elements: readonly { key: string; objects: THREE.Object3D[]; skip: Set<THREE.Object3D> }[], axis: THREE.Vector3, gap: number): Map<string, number> {
  const parts = elements.map((e) => sampleStackPart(e.key, e.objects, e.skip, axis)).filter((p): p is SampledPart => Boolean(p));
  const byKey = new Map(parts.map((p) => [p.key, p]));
  return planStack(parts, {
    gap,
    surrounds: (holder, part) => surrounded(byKey.get(holder.key)!, byKey.get(part.key)!, axis),
    exit: (holder, part) => exitByRays(byKey.get(holder.key)!, byKey.get(part.key)!, axis),
  });
}

// ---- facings for the radial explode (R2-B, ./explode.ts `planRadial`) ---------------------------------------------

/** At most this many triangles are read per part (a stride beyond; DEFAULT: a board's 870 k triangles cost ~60 k reads). */
export const FACING_MAX_TRIANGLES = 60_000;
/** Direction bins: normals are rounded to this many steps per unit (DEFAULT 20: about 3 degrees). */
export const FACING_BINS = 20;
/** How many of a part's largest facings are kept (DEFAULT). */
export const FACING_KEEP = 8;

const _fa = new THREE.Vector3();
const _fb = new THREE.Vector3();
const _fc = new THREE.Vector3();
const _fn = new THREE.Vector3();
const _fm = new THREE.Matrix4();

/**
 * A part's surface by the way it faces (world mm, Z up): every triangle of its visible meshes (named bodies in `skip`
 * left out) adds its area to the bin of its outward normal; the bins' area-weighted normals, largest first. A flat
 * face is one bin, so the largest bin is the part's largest face (a shell panel's outer face and its inner face are
 * two bins pointing opposite ways). Read at the assembled pose (the caller puts the objects there).
 */
export function facings(objects: THREE.Object3D[], skip: Set<THREE.Object3D> = new Set(), maxTriangles = FACING_MAX_TRIANGLES): { normal: [number, number, number]; area: number }[] {
  const meshes = meshesOf(objects, skip);
  let total = 0;
  for (const m of meshes) {
    const g = m.geometry as THREE.BufferGeometry;
    const p = g?.getAttribute("position");
    if (!p) continue;
    const inst = m as THREE.InstancedMesh;
    total += ((g.index ? g.index.count : p.count) / 3) * (inst.isInstancedMesh ? inst.count : 1);
  }
  const stride = Math.max(1, Math.ceil(total / maxTriangles));
  const bins = new Map<number, { x: number; y: number; z: number; area: number }>();
  const B = FACING_BINS;
  const add = (g: THREE.BufferGeometry, world: THREE.Matrix4) => {
    const p = g.getAttribute("position") as THREE.BufferAttribute;
    const idx = g.index;
    const tris = (idx ? idx.count : p.count) / 3;
    const mirrored = world.determinant() < 0;
    for (let t = 0; t < tris; t += stride) {
      _fa.fromBufferAttribute(p, idx ? idx.getX(t * 3) : t * 3).applyMatrix4(world);
      _fb.fromBufferAttribute(p, idx ? idx.getX(t * 3 + 1) : t * 3 + 1).applyMatrix4(world);
      _fc.fromBufferAttribute(p, idx ? idx.getX(t * 3 + 2) : t * 3 + 2).applyMatrix4(world);
      _fn.copy(_fb).sub(_fa).cross(_fc.sub(_fa));
      const twice = _fn.length();
      if (twice < 1e-12) continue;
      if (mirrored) _fn.negate();
      const area = (twice / 2) * stride;
      const nx = _fn.x / twice;
      const ny = _fn.y / twice;
      const nz = _fn.z / twice;
      const key = (Math.round(nx * B) + B) * (2 * B + 1) * (2 * B + 1) + (Math.round(ny * B) + B) * (2 * B + 1) + (Math.round(nz * B) + B);
      let bin = bins.get(key);
      if (!bin) bins.set(key, (bin = { x: 0, y: 0, z: 0, area: 0 }));
      bin.x += nx * area;
      bin.y += ny * area;
      bin.z += nz * area;
      bin.area += area;
    }
  };
  for (const m of meshes) {
    const g = m.geometry as THREE.BufferGeometry;
    if (!g?.getAttribute("position")) continue;
    m.updateWorldMatrix(true, false);
    const inst = m as THREE.InstancedMesh;
    if (inst.isInstancedMesh) {
      for (let i = 0; i < inst.count; i++) {
        inst.getMatrixAt(i, _fm);
        add(g, _fm.premultiply(m.matrixWorld));
      }
    } else add(g, m.matrixWorld);
  }
  return [...bins.values()]
    .filter((b) => b.area > 0)
    .sort((a, b) => b.area - a.area)
    .slice(0, FACING_KEEP)
    .map((b) => {
      const l = Math.hypot(b.x, b.y, b.z) || 1;
      return { normal: [b.x / l, b.y / l, b.z / l] as [number, number, number], area: Math.round(b.area * 100) / 100 };
    });
}
