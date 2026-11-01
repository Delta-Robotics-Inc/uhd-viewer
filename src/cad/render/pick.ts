/**
 * Picking with three-mesh-bvh (PB-1175): the logical scene (see ./batch.ts)
 * is tested ray-against-BVH, nearest first, skipping what is not drawn
 * (hidden, or on the cut-away side of a section plane). Each geometry gets its
 * BVH the first time a ray comes near it, built in *indirect* mode so the
 * geometry's triangle order is left alone (the sidecar's face-range table
 * counts triangles in that order). A hit names its object, its triangle and,
 * through ./ids.ts, the part's instance path and B-rep face.
 *
 * Fallback plan if BVH builds are too slow on a heavy board (> 2 s for all of
 * ClientX, measured in phase-1/progress.md): a GPU id buffer, i.e. draw the
 * batches once more into a 1x1 scissored target with a flat shader writing
 * (batch index, instance index, feature id) as colour, read the pixel back
 * and map it through `Batcher.memberAt`. Not built: the measured build time
 * decides.
 */
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";
import { idsAt, type HitIds } from "./ids";

export interface Pick extends HitIds {
  object: THREE.Mesh;
  /** World-space point and distance from the ray origin. */
  point: THREE.Vector3;
  distance: number;
  /** Triangle index in the geometry's own order. */
  triangle: number;
  /** Instance index, for an InstancedMesh from the GLB. */
  instance?: number;
}

export interface PickOptions {
  /** World clipping planes in force (a section): a hit on the cut-away side does not count. */
  clippingPlanes?: THREE.Plane[];
  /** Whether a mesh may be hit at all (besides being visible). */
  filter?: (mesh: THREE.Mesh) => boolean;
  /** Where ids stop walking up (the body's group). */
  stop?: (mesh: THREE.Mesh) => THREE.Object3D | undefined;
}

let bvhMs = 0;
let bvhBuilt = 0;
/** BVH builds so far: count and total ms (for the build-time measurement). */
export const bvhStats = () => ({ built: bvhBuilt, ms: bvhMs });

/** The geometry's BVH, built on first use (indirect: the index buffer is not reordered). */
export function bvhOf(geometry: THREE.BufferGeometry): MeshBVH {
  const g = geometry as THREE.BufferGeometry & { boundsTree?: MeshBVH };
  if (!g.boundsTree) {
    const t0 = performance.now();
    g.boundsTree = new MeshBVH(geometry, { indirect: true, verbose: false });
    bvhMs += performance.now() - t0;
    bvhBuilt++;
  }
  return g.boundsTree;
}

/** Visible all the way up (a hidden group hides what is in it). */
export function shown(o: THREE.Object3D): boolean {
  for (let x: THREE.Object3D | null = o; x; x = x.parent) if (!x.visible) return false;
  return true;
}

const kept = (p: THREE.Vector3, planes?: THREE.Plane[]) => !planes?.length || planes.every((pl) => pl.distanceToPoint(p) >= -1e-6);

const _inv = new THREE.Matrix4();
const _ray = new THREE.Ray();
const _sphere = new THREE.Sphere();
const _im = new THREE.Matrix4();
const _world = new THREE.Matrix4();

/** The nearest drawn hit of `ray` (world space) on meshes under `roots`. */
export function pick(ray: THREE.Ray, roots: THREE.Object3D[], options: PickOptions = {}): Pick | undefined {
  const candidates: { mesh: THREE.Mesh; near: number }[] = [];
  const walk = (o: THREE.Object3D) => {
    if (!o.visible) return;
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry?.getAttribute("position") && (!options.filter || options.filter(mesh))) {
      const g = mesh.geometry;
      if (!g.boundingSphere) g.computeBoundingSphere();
      const inst = mesh as THREE.InstancedMesh;
      if (inst.isInstancedMesh) {
        if (!inst.boundingSphere) inst.computeBoundingSphere();
        _sphere.copy(inst.boundingSphere!).applyMatrix4(mesh.matrixWorld);
      } else _sphere.copy(g.boundingSphere!).applyMatrix4(mesh.matrixWorld);
      if (ray.intersectsSphere(_sphere)) candidates.push({ mesh, near: Math.max(0, ray.origin.distanceTo(_sphere.center) - _sphere.radius) });
    }
    for (const c of o.children) walk(c);
  };
  for (const r of roots) walk(r);
  candidates.sort((a, b) => a.near - b.near);

  let best: Pick | undefined;
  const test = (mesh: THREE.Mesh, world: THREE.Matrix4, instance?: number) => {
    const bvh = bvhOf(mesh.geometry);
    _inv.copy(world).invert();
    _ray.copy(ray).applyMatrix4(_inv);
    const side = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material)?.side ?? THREE.FrontSide;
    // nearest first; with a section in force, the nearest that is not cut away
    const hits = options.clippingPlanes?.length ? bvh.raycast(_ray, side) : [bvh.raycastFirst(_ray, side)].filter((h): h is THREE.Intersection => Boolean(h));
    const sorted = hits
      .map((h) => {
        const point = h.point.clone().applyMatrix4(world);
        return { h, point, distance: point.distanceTo(ray.origin) };
      })
      .sort((a, b) => a.distance - b.distance);
    for (const { h, point, distance } of sorted) {
      if (!kept(point, options.clippingPlanes)) continue;
      if (best && best.distance <= distance) return;
      const triangle = h.faceIndex ?? 0;
      best = { object: mesh, point, distance, triangle, ...(instance !== undefined ? { instance } : {}), ...idsAt(mesh, triangle, options.stop?.(mesh), instance) };
      return;
    }
  };
  for (const { mesh, near } of candidates) {
    if (best && near > best.distance) break;
    const inst = mesh as THREE.InstancedMesh;
    if (inst.isInstancedMesh) {
      for (let i = 0; i < inst.count; i++) {
        inst.getMatrixAt(i, _im);
        test(mesh, _world.multiplyMatrices(mesh.matrixWorld, _im), i);
      }
    } else test(mesh, mesh.matrixWorld);
  }
  return best;
}

/** Build every BVH under `roots` now (measurement: how long a whole board takes). */
export function buildAll(roots: THREE.Object3D[]): { geometries: number; ms: number } {
  const seen = new Set<THREE.BufferGeometry>();
  const t0 = performance.now();
  for (const r of roots)
    r.traverse((o) => {
      const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
      if ((o as THREE.Mesh).isMesh && g?.getAttribute("position") && !seen.has(g)) {
        seen.add(g);
        bvhOf(g);
      }
    });
  return { geometries: seen.size, ms: performance.now() - t0 };
}
