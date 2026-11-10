/**
 * Draw-call foveation (PB-1176): the quality curve's "merge" knob draws every
 * unfocused part as one static mesh per look, so a draw-call-bound frame
 * (many parts, few pixels) stops paying a submission per part. The focused
 * parts stay as they are (instanced, highlightable, explodable).
 *
 * The merged mesh is a drawing only: positions and normals are baked into
 * world space (the scene's units), the part's base colour is a vertex colour,
 * and the logical meshes it replaces stay in the scene for picking, bounds
 * and ids (the batcher keeps them on the logical layer and leaves them out of
 * its groups while merged). It is rebuilt when the scene changes (explode,
 * visibility, a load) or the focus moves, and dropped when the knob is
 * released.
 *
 * What is never merged: meshes with a highlight, see-through looks (merging
 * would break their sorting), GPU-instanced nodes, meshes without normals.
 */
import * as THREE from "three";
import { cachedLook, isBatchable, type Look } from "../batch";
import { isLit } from "./attention";

/** Merged triangles at most (DEFAULT: past this the knob is skipped, the merge would cost more memory than it saves). */
export const MERGE_MAX_TRIANGLES = 4_000_000;

export interface MergeInput {
  mesh: THREE.Mesh;
  /** The geometry to bake (the coarse stand-in when the coarse knob is engaged). */
  geometry: THREE.BufferGeometry;
}

export interface MergeResult {
  /** One mesh per look, in world space. */
  meshes: THREE.Mesh[];
  /** The logical meshes now drawn by a merge. */
  members: Set<THREE.Mesh>;
  triangles: number;
  ms: number;
}

/** Whether a mesh may be merged (before the focus test). */
export function mergeable(o: THREE.Object3D): o is THREE.Mesh {
  if (!isBatchable(o)) return false;
  const mesh = o as THREE.Mesh;
  if (isLit(mesh) || mesh.userData.xray) return false;
  const m = mesh.material as THREE.MeshStandardMaterial;
  if (m.transparent || m.opacity < 1) return false;
  return !!mesh.geometry.getAttribute("normal");
}

const _n = new THREE.Matrix3();
const _v = new THREE.Vector3();

/** One look's material for merged meshes: the look, with the base colour from the vertices. */
function mergedMaterial(look: Look): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: look.roughness,
    metalness: look.metalness,
    side: look.side,
    depthWrite: look.depthWrite,
    depthTest: look.depthTest,
    polygonOffset: look.polygonOffset,
    polygonOffsetFactor: look.polygonOffsetFactor,
    polygonOffsetUnits: look.polygonOffsetUnits,
    wireframe: look.wireframe,
    flatShading: look.flatShading,
  });
  m.name = "merged";
  return m;
}

/**
 * Merge meshes (world matrices up to date) into one mesh per look. Returns
 * undefined when the total would pass `maxTriangles`.
 */
export function buildMerged(inputs: MergeInput[], maxTriangles = MERGE_MAX_TRIANGLES, now: () => number = () => performance.now()): MergeResult | undefined {
  const t0 = now();
  const byLook = new Map<string, { look: Look; items: MergeInput[]; vertices: number; indices: number }>();
  let triangles = 0;
  for (const it of inputs) {
    const g = it.geometry;
    const pos = g.getAttribute("position");
    if (!pos || !g.getAttribute("normal")) continue;
    const range = drawRange(g);
    if (range.count <= 0) continue;
    triangles += Math.floor(range.count / 3);
    if (triangles > maxTriangles) return undefined;
    const { look, key } = cachedLook(it.mesh, it.mesh.material as THREE.MeshStandardMaterial);
    let entry = byLook.get(key);
    if (!entry) byLook.set(key, (entry = { look, items: [], vertices: 0, indices: 0 }));
    entry.items.push(it);
    entry.vertices += pos.count;
    entry.indices += range.count;
  }
  const meshes: THREE.Mesh[] = [];
  const members = new Set<THREE.Mesh>();
  const color = new THREE.Color();
  for (const [key, e] of byLook) {
    const P = new Float32Array(e.vertices * 3);
    const N = new Float32Array(e.vertices * 3);
    const C = new Float32Array(e.vertices * 3);
    const I = e.vertices > 65535 ? new Uint32Array(e.indices) : new Uint16Array(e.indices);
    let vo = 0;
    let io = 0;
    for (const it of e.items) {
      const g = it.geometry;
      const pos = g.getAttribute("position");
      const nor = g.getAttribute("normal");
      const m = it.mesh.matrixWorld;
      _n.getNormalMatrix(m);
      // the part's base colour (its shared material's, as the batcher reads it)
      const base = (it.mesh.userData.__logical ?? it.mesh.material) as THREE.MeshStandardMaterial;
      if (base.color) color.copy(base.color);
      else color.setRGB(0.55, 0.55, 0.55);
      for (let i = 0; i < pos.count; i++) {
        _v.fromBufferAttribute(pos, i).applyMatrix4(m);
        P[(vo + i) * 3] = _v.x;
        P[(vo + i) * 3 + 1] = _v.y;
        P[(vo + i) * 3 + 2] = _v.z;
        _v.fromBufferAttribute(nor, i).applyMatrix3(_n).normalize();
        N[(vo + i) * 3] = _v.x;
        N[(vo + i) * 3 + 1] = _v.y;
        N[(vo + i) * 3 + 2] = _v.z;
        C[(vo + i) * 3] = color.r;
        C[(vo + i) * 3 + 1] = color.g;
        C[(vo + i) * 3 + 2] = color.b;
      }
      const range = drawRange(g);
      // a mirrored placement (negative determinant) turns the winding round: flip it back so front faces stay front
      const flip = m.determinant() < 0;
      const idx = g.index;
      for (let t = 0; t < range.count; t += 3) {
        const a = idx ? idx.getX(range.start + t) : range.start + t;
        const b = idx ? idx.getX(range.start + t + 1) : range.start + t + 1;
        const c = idx ? idx.getX(range.start + t + 2) : range.start + t + 2;
        I[io++] = vo + a;
        I[io++] = vo + (flip ? c : b);
        I[io++] = vo + (flip ? b : c);
      }
      vo += pos.count;
      members.add(it.mesh);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(P, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(N, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(C, 3));
    geometry.setIndex(new THREE.BufferAttribute(I, 1));
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
    const mesh = new THREE.Mesh(geometry, mergedMaterial(e.look));
    mesh.name = `merged:${key}`;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = e.look.renderOrder;
    mesh.userData.noBatch = true;
    mesh.userData.merged = true;
    meshes.push(mesh);
  }
  return { meshes, members, triangles, ms: now() - t0 };
}

/** The index (or vertex) range a geometry draws. */
function drawRange(g: THREE.BufferGeometry): { start: number; count: number } {
  const total = g.index ? g.index.count : (g.getAttribute("position")?.count ?? 0);
  const start = Math.max(0, g.drawRange.start);
  const count = Math.min(total - start, Number.isFinite(g.drawRange.count) ? g.drawRange.count : total);
  return { start, count: count - (count % 3) };
}

/** Free a merge's GPU buffers and materials. */
export function disposeMerged(r: MergeResult | undefined): void {
  if (!r) return;
  for (const m of r.meshes) {
    m.removeFromParent();
    m.geometry.dispose();
    (m.material as THREE.Material).dispose();
  }
}
