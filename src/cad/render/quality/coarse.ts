/**
 * The coarse tier for far-part detail (PB-1176). W1-A's export writes, beside
 * `X.view.glb`, `X.view.coarse.glb`: the same nodes and ids, fewer triangles
 * (`tiers.coarse` in `X.view.json`, read by ../sidecar.ts). When the quality
 * curve engages its "coarse" knob, unfocused parts draw the coarse geometry.
 *
 * Nothing in the logical scene changes: CadView's meshes keep the fine
 * geometry (picking, face ids, bounds and measurement read it: "a visual
 * artifact, not a data artifact"). The batcher draws a substitute instead
 * (`geometryOf`), and meshes drawn as themselves swap geometry only for the
 * length of the draw call (scene.ts).
 *
 * The map is fine geometry -> coarse geometry. The parsed fine scene is the
 * cache's template, and every body CadView builds is a clone of it, which
 * shares the template's BufferGeometry objects; so one map entry serves every
 * placement of a part. Pairs are made by walking both files' scenes in step
 * (same node structure); a file whose structure differs is left fine.
 */
import * as THREE from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { LoadedModel } from "../glbCache";

/** Triangles of a geometry (indexed or not). */
export function triangleCount(g: THREE.BufferGeometry): number {
  return Math.floor((g.index ? g.index.count : (g.getAttribute("position")?.count ?? 0)) / 3);
}

/** Whether a coarse geometry can stand in for a fine one in the same draw (the attributes the shaders read). */
function compatible(fine: THREE.BufferGeometry, coarse: THREE.BufferGeometry): boolean {
  for (const name of ["position", "normal"]) if (!!fine.getAttribute(name) !== !!coarse.getAttribute(name)) return false;
  return !!coarse.getAttribute("position");
}

/**
 * Pair the meshes of two scenes with the same node structure: each fine plain
 * mesh's geometry with the coarse one's at the same place. GPU-instanced
 * nodes (InstancedMesh) are skipped: their geometry is wrapped by the batcher.
 * Returns the pairs and whether the structures matched everywhere.
 */
export function pairCoarse(fine: THREE.Object3D, coarse: THREE.Object3D): { pairs: Map<THREE.BufferGeometry, THREE.BufferGeometry>; mismatches: number } {
  const pairs = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();
  let mismatches = 0;
  // KHR_mesh_quantization moves each mesh's dequantisation into its node's transform, per mesh volume: a simplified
  // mesh can have another volume, so its node another transform. Compare the two meshes' transforms within their
  // files; where they differ, the coarse geometry is baked into the fine node's frame (float positions).
  const rel = new THREE.Matrix4();
  const inv = new THREE.Matrix4();
  const fineRoot = new THREE.Matrix4();
  const coarseRoot = new THREE.Matrix4();
  fine.updateMatrixWorld(true);
  coarse.updateMatrixWorld(true);
  fineRoot.copy(fine.matrixWorld).invert();
  coarseRoot.copy(coarse.matrixWorld).invert();
  const inFrame = (fineMesh: THREE.Object3D, coarseMesh: THREE.Object3D, g: THREE.BufferGeometry): THREE.BufferGeometry => {
    // rel = (fine node in its file)^-1 x (coarse node in its file)
    inv.multiplyMatrices(fineRoot, fineMesh.matrixWorld).invert();
    rel.multiplyMatrices(coarseRoot, coarseMesh.matrixWorld).premultiply(inv);
    const e = rel.elements;
    const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const scale = Math.max(1e-9, ...[e[12], e[13], e[14]].map(Math.abs), 1);
    if (e.every((v, i) => Math.abs(v - id[i]) <= (i >= 12 && i <= 14 ? 1e-7 * scale : 1e-7))) return g;
    const out = new THREE.BufferGeometry();
    if (g.index) out.setIndex(g.index);
    for (const [name, attr] of Object.entries(g.attributes)) {
      if (name !== "position" && name !== "normal") {
        out.setAttribute(name, attr);
        continue;
      }
      const a = attr as THREE.BufferAttribute;
      const f = new THREE.Float32BufferAttribute(new Float32Array(a.count * 3), 3);
      for (let i = 0; i < a.count; i++) f.setXYZ(i, a.getX(i), a.getY(i), a.getZ(i));
      out.setAttribute(name, f);
    }
    out.getAttribute("position").applyMatrix4(rel);
    const n = out.getAttribute("normal");
    if (n) (n as THREE.BufferAttribute).applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(rel));
    for (const grp of g.groups) out.addGroup(grp.start, grp.count, grp.materialIndex);
    out.userData.coarseBaked = true;
    return out;
  };
  const walk = (a: THREE.Object3D, b: THREE.Object3D) => {
    if (a.children.length !== b.children.length) {
      mismatches++;
      return;
    }
    const ma = a as THREE.Mesh;
    const mb = b as THREE.Mesh;
    if (ma.isMesh !== mb.isMesh) {
      mismatches++;
      return;
    }
    if (ma.isMesh && !(ma as THREE.InstancedMesh).isInstancedMesh && !(mb as THREE.InstancedMesh).isInstancedMesh) {
      if (compatible(ma.geometry, mb.geometry) && triangleCount(mb.geometry) < triangleCount(ma.geometry)) pairs.set(ma.geometry, inFrame(ma, mb, mb.geometry));
      else if (!compatible(ma.geometry, mb.geometry)) mismatches++;
    }
    for (let i = 0; i < a.children.length; i++) walk(a.children[i], b.children[i]);
  };
  walk(fine, coarse);
  return { pairs, mismatches };
}

/** The coarse file's URL: its bare name beside the fine sidecar `X.view.glb` (same query). */
export function coarseUrl(model: Pick<LoadedModel, "path" | "sidecar">): string | undefined {
  const file = model.sidecar?.coarse?.file;
  if (!file) return undefined;
  const m = /^([^?#]*\/)?[^/?#]*([?#].*)?$/.exec(model.path);
  if (!m) return undefined;
  return `${m[1] ?? ""}${encodeURIComponent(file)}${m[2] ?? ""}`;
}

export interface CoarseStats {
  /** Coarse files asked for, loaded, failed. */
  files: number;
  loaded: number;
  failed: number;
  /** Fine geometries with a coarse stand-in, and their triangles fine and coarse. */
  mapped: number;
  fineTriangles: number;
  coarseTriangles: number;
  /** Files whose structure differed from the fine one (left fine). */
  mismatched: number;
  ms: number;
}

export interface CoarseTierOptions {
  /** Fetch and parse a coarse GLB (scene.ts: the shared loader, the same size and extension checks as every GLB). */
  load: (url: string) => Promise<GLTF | null>;
  now?: () => number;
}

/**
 * The coarse stand-ins of every loaded model. `prepare` loads what is missing
 * (once per coarse file), `geometryFor` answers per fine geometry.
 */
export class CoarseTier {
  private map = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();
  private done = new Map<string, Promise<boolean>>();
  private keep = new Map<string, GLTF>();
  stats: CoarseStats = { files: 0, loaded: 0, failed: 0, mapped: 0, fineTriangles: 0, coarseTriangles: 0, mismatched: 0, ms: 0 };
  /** Bumped when new pairs arrive (the batcher must sync again to use them). */
  version = 0;

  constructor(private options: CoarseTierOptions) {}

  geometryFor(fine: THREE.BufferGeometry): THREE.BufferGeometry | undefined {
    return this.map.get(fine);
  }

  get available(): boolean {
    return this.stats.mapped > 0;
  }

  /** Load the coarse tiers of these models (each file once); resolves when all are in. */
  async prepare(models: LoadedModel[]): Promise<CoarseStats> {
    const now = this.options.now ?? (() => performance.now());
    const t0 = now();
    const jobs: Promise<boolean>[] = [];
    for (const model of models) {
      const url = coarseUrl(model);
      if (!url) continue;
      const key = `${model.hash}|${url}`;
      let job = this.done.get(key);
      if (!job) {
        this.stats.files++;
        job = this.options
          .load(url)
          .then((gltf) => {
            if (!gltf) {
              this.stats.failed++;
              return false;
            }
            const { pairs, mismatches } = pairCoarse(model.gltf.scene, gltf.scene);
            if (mismatches) {
              this.stats.mismatched++;
              console.info(`[cad] ${url}: coarse tier does not match the fine tier's nodes (${mismatches}): parts stay fine`);
              return false;
            }
            for (const [f, c] of pairs) {
              this.map.set(f, c);
              this.stats.mapped++;
              this.stats.fineTriangles += triangleCount(f);
              this.stats.coarseTriangles += triangleCount(c);
            }
            this.keep.set(key, gltf);
            this.stats.loaded++;
            if (pairs.size) this.version++;
            return true;
          })
          .catch((e) => {
            this.stats.failed++;
            console.warn(`[cad] ${url}: coarse tier not loaded (${e instanceof Error ? e.message : e})`);
            return false;
          });
        this.done.set(key, job);
      }
      jobs.push(job);
    }
    await Promise.all(jobs);
    this.stats.ms += now() - t0;
    return { ...this.stats };
  }

  /** Free the coarse geometries (their GPU buffers too). */
  dispose(): void {
    for (const g of this.keep.values()) g.scene.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    this.keep.clear();
    this.done.clear();
    this.map = new WeakMap();
    this.stats = { files: 0, loaded: 0, failed: 0, mapped: 0, fineTriangles: 0, coarseTriangles: 0, mismatched: 0, ms: 0 };
    this.version++;
  }
}
