/**
 * Shared materials and instanced drawing (PB-1175).
 *
 * The 3D view builds an ordinary three.js tree (one group per body, the GLB's
 * meshes under it). That tree stays the *logical* scene: placement, explode,
 * visibility, selection, labels and picking all work on it by instance path,
 * exactly as before. It is no longer drawn directly. Before a frame, the
 * batcher walks it and draws it as instanced meshes instead:
 *
 * - one GPU material per *look* (roughness, metalness, opacity, side, …),
 *   never one per mesh: ClientX had 70,142 materials for 70,159 meshes;
 * - one `InstancedMesh` per (geometry, look): repeated parts (four motors, 55
 *   resistors, a GLB placed twice) are one draw call;
 * - colour and highlight are per-instance attributes (`instanceColor`, and an
 *   `instanceEmissive` attribute added to the standard shader), so selecting
 *   or highlighting writes a few floats and never clones a material.
 *
 * What it does not take over (drawn as they are): lines and points, other
 * material types (gizmos, labels), materials with maps or vertex colours,
 * morphs, and anything marked `userData.noBatch`. A mesh's highlight is
 * `userData.emissive` (a hex colour) when set, else its material's emissive;
 * `userData.xray` draws it see-through.
 *
 * Logical meshes the batcher draws are moved to `LOGICAL_LAYER`, which the
 * camera does not render; raycasters that should see them enable that layer.
 * A GLB that arrives already instanced (`EXT_mesh_gpu_instancing`) keeps its
 * own InstancedMesh, which gets the shared material and the same attributes.
 */
import * as THREE from "three";

/** The layer of logical meshes (not rendered by the camera; picking and sampling enable it). */
export const LOGICAL_LAYER = 31;
const LOGICAL_MASK = (1 << LOGICAL_LAYER) >>> 0;

const INSTANCE_EMISSIVE = "instanceEmissive";

/** The look of a mesh: everything of its material but colour and emissive (those are per instance). */
export interface Look {
  roughness: number;
  metalness: number;
  transparent: boolean;
  opacity: number;
  side: THREE.Side;
  depthWrite: boolean;
  depthTest: boolean;
  polygonOffset: boolean;
  polygonOffsetFactor: number;
  polygonOffsetUnits: number;
  wireframe: boolean;
  flatShading: boolean;
  renderOrder: number;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function lookOf(mesh: THREE.Mesh, material: THREE.MeshStandardMaterial): Look {
  const xray = mesh.userData.xray === true;
  return {
    roughness: r3(material.roughness),
    metalness: r3(material.metalness),
    transparent: xray || material.transparent,
    opacity: xray ? 0.22 : r3(material.opacity),
    side: material.side,
    depthWrite: xray ? false : material.depthWrite,
    depthTest: material.depthTest,
    polygonOffset: material.polygonOffset,
    polygonOffsetFactor: material.polygonOffsetFactor,
    polygonOffsetUnits: material.polygonOffsetUnits,
    wireframe: material.wireframe,
    flatShading: material.flatShading,
    renderOrder: mesh.renderOrder,
  };
}

/**
 * A mesh's look and its key, cached per material (keyed by the material's
 * version, so a change made with `needsUpdate` is seen; side and opacity
 * changes in this viewer always set it) and per render order and x-ray: the
 * batcher's sync then does no string work per mesh (ClientX has 70k).
 */
const lookCache = new WeakMap<THREE.Material, Map<string, { version: number; side: THREE.Side; opacity: number; look: Look; key: string }>>();
export function cachedLook(mesh: THREE.Mesh, material: THREE.MeshStandardMaterial): { look: Look; key: string } {
  const variant = `${mesh.renderOrder}|${mesh.userData.xray === true ? 1 : 0}`;
  let byVariant = lookCache.get(material);
  if (!byVariant) lookCache.set(material, (byVariant = new Map()));
  const hit = byVariant.get(variant);
  if (hit && hit.version === material.version && hit.side === material.side && hit.opacity === material.opacity) return hit;
  const look = lookOf(mesh, material);
  const entry = { version: material.version, side: material.side, opacity: material.opacity, look, key: lookKey(look) };
  byVariant.set(variant, entry);
  return entry;
}

export const lookKey = (l: Look) =>
  `${l.roughness}/${l.metalness}/${l.transparent ? 1 : 0}/${l.opacity}/${l.side}/${l.depthWrite ? 1 : 0}${l.depthTest ? 1 : 0}/${l.polygonOffset ? `${l.polygonOffsetFactor},${l.polygonOffsetUnits}` : "-"}/${l.wireframe ? 1 : 0}${l.flatShading ? 1 : 0}/${l.renderOrder}`;

/** A MeshStandardMaterial with nothing per-mesh the batcher would lose (maps, vertex colours, clipping of its own). */
function batchableMaterial(m: THREE.Material | THREE.Material[]): m is THREE.MeshStandardMaterial {
  if (Array.isArray(m) || (m as THREE.MeshStandardMaterial).type !== "MeshStandardMaterial") return false;
  const s = m as THREE.MeshStandardMaterial;
  return !(
    s.map ||
    s.normalMap ||
    s.emissiveMap ||
    s.roughnessMap ||
    s.metalnessMap ||
    s.aoMap ||
    s.alphaMap ||
    s.bumpMap ||
    s.displacementMap ||
    s.lightMap ||
    s.envMap ||
    s.vertexColors ||
    s.alphaTest > 0 ||
    (s.clippingPlanes && s.clippingPlanes.length) ||
    s.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile
  );
}

/** Whether the batcher draws this mesh (a plain mesh; instanced meshes are handled as themselves). */
export function isBatchable(o: THREE.Object3D): o is THREE.Mesh {
  const mesh = o as THREE.Mesh;
  if (!mesh.isMesh || (mesh as unknown as THREE.SkinnedMesh).isSkinnedMesh || (mesh as THREE.InstancedMesh).isInstancedMesh || (mesh as unknown as THREE.BatchedMesh).isBatchedMesh) return false;
  if (mesh.userData.noBatch) return false;
  const g = mesh.geometry;
  if (!g?.getAttribute("position") || Object.keys(g.morphAttributes).length) return false;
  return batchableMaterial(mesh.material);
}

/**
 * The shared GPU materials, one per look: white base colour and black
 * emissive (both come from the instance attributes), with the standard shader
 * reading `instanceEmissive`.
 */
export class MaterialRegistry {
  private byKey = new Map<string, THREE.MeshStandardMaterial>();

  get(look: Look): THREE.MeshStandardMaterial {
    const key = lookKey(look);
    let m = this.byKey.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: look.roughness,
        metalness: look.metalness,
        transparent: look.transparent,
        opacity: look.opacity,
        side: look.side,
        depthWrite: look.depthWrite,
        depthTest: look.depthTest,
        polygonOffset: look.polygonOffset,
        polygonOffsetFactor: look.polygonOffsetFactor,
        polygonOffsetUnits: look.polygonOffsetUnits,
        wireframe: look.wireframe,
        flatShading: look.flatShading,
      });
      m.name = `look:${key}`;
      m.defines = { ...(m.defines ?? {}), USE_INSTANCE_EMISSIVE: "" };
      m.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", `#include <common>\nattribute vec3 ${INSTANCE_EMISSIVE};\nvarying vec3 vInstanceEmissive;`)
          .replace("#include <begin_vertex>", `#include <begin_vertex>\nvInstanceEmissive = ${INSTANCE_EMISSIVE};`);
        shader.fragmentShader = shader.fragmentShader
          .replace("#include <common>", "#include <common>\nvarying vec3 vInstanceEmissive;")
          .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += vInstanceEmissive;");
      };
      m.customProgramCacheKey = () => "uhd-instance-emissive";
      this.byKey.set(key, m);
    }
    return m;
  }

  /** Every material in use (for a global change such as clipping or side). */
  all(): THREE.MeshStandardMaterial[] {
    return [...this.byKey.values()];
  }

  get size(): number {
    return this.byKey.size;
  }

  /** Drop materials no group uses any more. */
  retain(used: Set<THREE.Material>): void {
    for (const [k, m] of this.byKey)
      if (!used.has(m)) {
        m.dispose();
        this.byKey.delete(k);
      }
  }

  dispose(): void {
    for (const m of this.byKey.values()) m.dispose();
    this.byKey.clear();
  }
}

/** A geometry that shares another's buffers (so the GPU holds them once) and has an instance attribute of its own. */
function wrapperGeometry(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  if (source.index) g.setIndex(source.index);
  for (const [name, attr] of Object.entries(source.attributes)) if (name !== INSTANCE_EMISSIVE) g.setAttribute(name, attr);
  for (const grp of source.groups) g.addGroup(grp.start, grp.count, grp.materialIndex);
  g.setDrawRange(source.drawRange.start, source.drawRange.count);
  if (!source.boundingSphere) source.computeBoundingSphere();
  if (!source.boundingBox) source.computeBoundingBox();
  g.boundingSphere = source.boundingSphere!.clone();
  g.boundingBox = source.boundingBox!.clone();
  g.userData.shares = source;
  return g;
}

/** Free a wrapper's own buffers only: detach the shared ones first, or the GPU copy of the source would be deleted too. */
function disposeWrapper(g: THREE.BufferGeometry): void {
  for (const name of Object.keys(g.attributes)) if (name !== INSTANCE_EMISSIVE) g.deleteAttribute(name);
  g.setIndex(null);
  g.dispose();
}

interface Group {
  key: string;
  source: THREE.BufferGeometry;
  look: Look;
  material: THREE.MeshStandardMaterial;
  mesh: THREE.InstancedMesh;
  capacity: number;
  members: THREE.Mesh[];
}

/**
 * What the quality curve (PB-1176, ./quality/) changes in a sync: a stand-in
 * geometry to draw for a mesh (the coarse tier of an unfocused part), and
 * meshes the batcher leaves out because a merged mesh draws them. The logical
 * meshes themselves are not touched (picking and ids read their own geometry).
 */
export interface SyncPolicy {
  geometryOf?: (mesh: THREE.Mesh) => THREE.BufferGeometry | undefined;
  exclude?: (mesh: THREE.Mesh) => boolean;
}

export interface SyncStats {
  /** Logical meshes drawn by the batcher (visible ones). */
  instances: number;
  /** Instanced draws (groups with something visible). */
  groups: number;
  /** GPU materials in use. */
  materials: number;
  /** Logical meshes drawn as themselves. */
  native: number;
  ms: number;
}

const _m = new THREE.Matrix4();
const _c = new THREE.Color();
const _e = new THREE.Color();

/** The colour a mesh shows: its material's base colour (linear). */
function baseColor(mesh: THREE.Mesh, out: THREE.Color): THREE.Color {
  const m = (mesh.userData.__logical ?? mesh.material) as THREE.MeshStandardMaterial;
  return out.copy(m.color);
}

/** The glow a mesh shows: `userData.emissive` (hex) when set, else its material's emissive × intensity (linear). */
function emissiveOf(mesh: THREE.Object3D, material: THREE.MeshStandardMaterial | undefined, out: THREE.Color): THREE.Color {
  const e = mesh.userData.emissive;
  if (typeof e === "number") return out.setHex(e);
  if (material?.emissive) return out.copy(material.emissive).multiplyScalar(material.emissiveIntensity ?? 1);
  return out.setRGB(0, 0, 0);
}

export class Batcher {
  /** Holds the instanced meshes; add it to the scene once. */
  readonly root = new THREE.Group();
  readonly materials = new MaterialRegistry();
  private groups = new Map<string, Group>();
  /** Instanced meshes from a GLB (EXT_mesh_gpu_instancing) whose material was swapped for a shared one. */
  private native = new Set<THREE.InstancedMesh>();
  last: SyncStats = { instances: 0, groups: 0, materials: 0, native: 0, ms: 0 };
  /**
   * Children of the sources whose whole subtree the batches draw: the renderer
   * need not walk them (the scene hides them for the draw call and puts them back).
   */
  pure: THREE.Object3D[] = [];
  /** Logical meshes drawn as themselves after the last sync (a look with fewer than `minInstances` meshes): the quality curve swaps their geometry for the draw. */
  singles: THREE.Mesh[] = [];

  /** Looks with fewer visible meshes than this are drawn mesh by mesh (default 2). */
  readonly minInstances: number;

  constructor(options: { minInstances?: number } = {}) {
    this.minInstances = Math.max(1, options.minInstances ?? 2);
    this.root.name = "batches";
    this.root.matrixAutoUpdate = false;
  }

  /**
   * Draw `sources` (world matrices up to date) as batches. Cost: one walk of
   * the logical tree and a rewrite of the instance attributes, so it runs only
   * when the scene changed, never for a camera move.
   */
  sync(sources: THREE.Object3D[], policy: SyncPolicy = {}): SyncStats {
    const t0 = performance.now();
    const singles: THREE.Mesh[] = [];
    const lists = new Map<string, { source: THREE.BufferGeometry; look: Look; members: THREE.Mesh[]; tops: THREE.Object3D[] }>();
    let native = 0;
    const seenNative = new Set<THREE.InstancedMesh>();
    /** Walks a subtree; true when something in it is drawn as itself (so the renderer must still walk it). */
    const walk = (o: THREE.Object3D, visible: boolean, top: THREE.Object3D): boolean => {
      const vis = visible && o.visible;
      let own = false;
      if (isBatchable(o)) {
        // a mesh a merged mesh draws (the quality curve's merge knob) stays on the logical layer, in no group
        if (!policy.exclude?.(o)) {
          const { look, key: lk } = cachedLook(o, o.material as THREE.MeshStandardMaterial);
          // the quality curve may draw a stand-in (the coarse tier); the logical mesh keeps its own geometry
          const geometry = policy.geometryOf?.(o) ?? o.geometry;
          const key = `${geometry.id}|${lk}`;
          let list = lists.get(key);
          if (!list) lists.set(key, (list = { source: geometry, look, members: [], tops: [] }));
          if (vis) {
            list.members.push(o);
            list.tops.push(top);
          }
        }
        if (o.layers.mask !== LOGICAL_MASK) {
          o.userData.__layers ??= o.layers.mask;
          o.layers.set(LOGICAL_LAYER);
        }
      } else if ((o as THREE.Mesh).isMesh) {
        // drawn as itself (again, if it used to be batched: its material changed kind)
        if (o.userData.__layers !== undefined) {
          o.layers.mask = o.userData.__layers;
          delete o.userData.__layers;
        }
        if ((o as THREE.InstancedMesh).isInstancedMesh && this.adoptNative(o as THREE.InstancedMesh)) seenNative.add(o as THREE.InstancedMesh);
        if (vis) native++;
        own = true;
      } else if ((o as THREE.Line).isLine || (o as THREE.Points).isPoints || (o as THREE.Sprite).isSprite || (o as THREE.Light).isLight) own = true;
      for (const c of o.children) if (walk(c, vis, top)) own = true;
      return own;
    };
    const candidates: THREE.Object3D[] = [];
    const impure = new Set<THREE.Object3D>();
    for (const s of sources) {
      if ((s.type !== "Group" && s.type !== "Object3D") || !s.children.length) {
        walk(s, true, s);
        continue;
      }
      const vis = s.visible;
      for (const c of s.children) if (!walk(c, vis, c)) candidates.push(c);
    }
    // a look with fewer meshes than `minInstances` is drawn as itself: an instanced draw of one costs three
    // more GPU buffers (matrix, colour, emissive) for nothing, and ClientX's board has thousands of such
    for (const [key, list] of lists) {
      if (!list.members.length || list.members.length >= this.minInstances) continue;
      list.members.forEach((m, i) => {
        if (m.userData.__layers !== undefined) {
          m.layers.mask = m.userData.__layers;
          delete m.userData.__layers;
        }
        impure.add(list.tops[i]);
        singles.push(m);
        native++;
      });
      lists.delete(key);
    }
    this.pure = candidates.filter((c) => !impure.has(c));
    this.singles = singles;

    // groups that are gone
    for (const [key, g] of this.groups)
      if (!lists.has(key) || !lists.get(key)!.members.length) {
        this.root.remove(g.mesh);
        disposeWrapper(g.mesh.geometry);
        g.mesh.dispose();
        this.groups.delete(key);
      }
    for (const m of this.native) if (!seenNative.has(m)) this.releaseNative(m);

    let instances = 0;
    for (const [key, list] of lists) {
      const n = list.members.length;
      if (!n) continue;
      let g = this.groups.get(key);
      if (!g || g.capacity < n) {
        if (g) {
          this.root.remove(g.mesh);
          disposeWrapper(g.mesh.geometry);
          g.mesh.dispose();
        }
        const capacity = g ? Math.max(n, Math.ceil(g.capacity * 1.5)) : n;
        const geometry = wrapperGeometry(list.source);
        geometry.setAttribute(INSTANCE_EMISSIVE, new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3));
        const material = this.materials.get(list.look);
        const mesh = new THREE.InstancedMesh(geometry, material, capacity);
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
        mesh.matrixAutoUpdate = false;
        mesh.renderOrder = list.look.renderOrder;
        mesh.name = key;
        this.root.add(mesh);
        g = { key, source: list.source, look: list.look, material, mesh, capacity, members: [] };
        this.groups.set(key, g);
      }
      g.members = list.members;
      const { mesh } = g;
      const emissive = mesh.geometry.getAttribute(INSTANCE_EMISSIVE) as THREE.InstancedBufferAttribute;
      const color = mesh.instanceColor!;
      for (let i = 0; i < n; i++) {
        const member = list.members[i];
        mesh.setMatrixAt(i, member.matrixWorld);
        baseColor(member, _c);
        color.setXYZ(i, _c.r, _c.g, _c.b);
        emissiveOf(member, member.material as THREE.MeshStandardMaterial, _e);
        emissive.setXYZ(i, _e.r, _e.g, _e.b);
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, n * 16);
      color.needsUpdate = true;
      color.clearUpdateRanges();
      color.addUpdateRange(0, n * 3);
      emissive.needsUpdate = true;
      emissive.clearUpdateRanges();
      emissive.addUpdateRange(0, n * 3);
      mesh.computeBoundingSphere();
      instances += n;
    }
    const used = new Set<THREE.Material>([...this.groups.values()].map((g) => g.material));
    for (const m of this.native) used.add(m.material as THREE.Material);
    this.materials.retain(used);
    this.last = { instances, groups: this.groups.size, materials: this.materials.size, native, ms: performance.now() - t0 };
    return this.last;
  }

  /**
   * Placements only changed (an explode tween, a sequence playing): rewrite each group's instance matrices from
   * its members' world matrices, without walking the tree or regrouping. Visibility, looks and highlights must
   * not have changed (those need `sync`). Returns the instances written.
   */
  refreshMatrices(): number {
    let n = 0;
    for (const g of this.groups.values()) {
      const { mesh, members } = g;
      for (let i = 0; i < members.length; i++) mesh.setMatrixAt(i, members[i].matrixWorld);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, members.length * 16);
      mesh.computeBoundingSphere();
      n += members.length;
    }
    return n;
  }

  /** A GLB's own InstancedMesh: shared material, colour and emissive attributes. False when its material cannot be shared. */
  private adoptNative(mesh: THREE.InstancedMesh): boolean {
    const logical = (mesh.userData.__logical ?? mesh.material) as THREE.Material;
    if (!batchableMaterial(logical)) return false;
    if (!mesh.userData.__logical) {
      mesh.userData.__logical = logical;
      // its own geometry wrapper: the source geometry is shared with every other clone of the GLB
      mesh.userData.__source = mesh.geometry;
      mesh.geometry = wrapperGeometry(mesh.geometry);
      mesh.geometry.setAttribute(INSTANCE_EMISSIVE, new THREE.InstancedBufferAttribute(new Float32Array(mesh.instanceMatrix.count * 3), 3));
      if (!mesh.instanceColor) {
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(mesh.instanceMatrix.count * 3), 3);
        _c.copy((logical as THREE.MeshStandardMaterial).color);
        for (let i = 0; i < mesh.instanceMatrix.count; i++) mesh.instanceColor.setXYZ(i, _c.r, _c.g, _c.b);
      }
      this.native.add(mesh);
    }
    mesh.material = this.materials.get(lookOf(mesh, logical as THREE.MeshStandardMaterial));
    const emissive = mesh.geometry.getAttribute(INSTANCE_EMISSIVE) as THREE.InstancedBufferAttribute;
    const per = mesh.userData.instanceEmissive as Map<number, number> | undefined;
    emissiveOf(mesh, logical as THREE.MeshStandardMaterial, _e);
    for (let i = 0; i < emissive.count; i++) {
      const hex = per?.get(i);
      if (hex !== undefined) _c.setHex(hex);
      else _c.copy(_e);
      emissive.setXYZ(i, _c.r, _c.g, _c.b);
    }
    emissive.needsUpdate = true;
    return true;
  }

  private releaseNative(mesh: THREE.InstancedMesh): void {
    if (mesh.userData.__logical) {
      mesh.material = mesh.userData.__logical;
      disposeWrapper(mesh.geometry);
      mesh.geometry = mesh.userData.__source;
      delete mesh.userData.__logical;
      delete mesh.userData.__source;
    }
    this.native.delete(mesh);
  }

  /** The logical mesh drawn at a batch's instance (for GPU-side picking or debugging). */
  memberAt(batch: THREE.InstancedMesh, instance: number): THREE.Mesh | undefined {
    return this.groups.get(batch.name)?.members[instance];
  }

  /** Put every logical mesh back to drawing itself (batching switched off). */
  release(sources: THREE.Object3D[]): void {
    for (const s of sources)
      s.traverse((o) => {
        if (o.userData.__layers !== undefined) {
          o.layers.mask = o.userData.__layers;
          delete o.userData.__layers;
        }
      });
    for (const m of [...this.native]) this.releaseNative(m);
    for (const g of this.groups.values()) {
      this.root.remove(g.mesh);
      disposeWrapper(g.mesh.geometry);
      g.mesh.dispose();
    }
    this.groups.clear();
  }

  dispose(): void {
    for (const g of this.groups.values()) {
      disposeWrapper(g.mesh.geometry);
      g.mesh.dispose();
    }
    this.groups.clear();
    this.materials.dispose();
  }
}

/** Matrix of a logical mesh as the batcher wrote it (tests). */
export function instanceMatrix(batch: THREE.InstancedMesh, i: number): THREE.Matrix4 {
  batch.getMatrixAt(i, _m);
  return _m.clone();
}
