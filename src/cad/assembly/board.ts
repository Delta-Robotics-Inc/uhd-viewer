/**
 * A board opened on its own level is an assembly (R3-A, 2026-11-02). Kevin: "the PCB is a subassembly of the
 * larger assembly. The simple version is in the large assembly, and then the PCB becomes its own assembly that can
 * explode"; "each of the components actually needs to be selectable"; Mark: "at the scope that it needs to".
 *
 * What the board's view GLB holds (the stack's view-model, `packages/core/src/view-model/`, its "names" rule): the
 * board's own sheets (substrate, copper, silkscreen) as one node with no instance path of its own (`""`), every
 * component that is placed once as its own node (`extras.protoboard.partInstanceId`), and every footprint placed
 * several times as one GPU-instanced node (`EXT_mesh_gpu_instancing`, `extras.protoboard.instances[i]`). The
 * per-node face tables in `X.view.json` index B-rep faces *within* each part, not parts within a merged mesh: no
 * geometry has to be cut apart. What made the board "one body" was the structure: one record whose parts could
 * not move, and instanced components that were one object for all their placements.
 *
 * So the split here is structural and cheap (ClientX's board: 35 nodes, 197 components, a few ms):
 * - every component node is wrapped in a group named by its instance path (the group is what moves);
 * - every GPU instance becomes a plain mesh of its own, sharing the instanced node's geometry and material, in a
 *   wrapper of its own. The batcher (../render/batch.ts) draws plain meshes of one geometry and one look as one
 *   instanced draw again, so 55 resistors stay one draw call while each can move, hide and glow alone;
 * - what has no instance path (the board's sheets, pads the export could not match) stays where it is: the board.
 *
 * Nothing here depends on how many components a board has or on which part is which: a corrected board GLB (a new
 * export with a fixed USB-C, R3-M) is split the same way on its next load, with no change of code.
 *
 * Units: the GLB is metres and Y-up; CadView's `cadWrapper` turns it into UHD's mm and Z-up. Boxes, the board
 * normal and heights here are measured in the body's own CAD frame (mm, Z up); `toNode` carries a CAD mm vector
 * back into the GLB node space the wrappers live in (the wrapper's x1000 and its turn about X come out there).
 */
import * as THREE from "three";
import { instanceIdOf } from "../render/ids";

/** DEFAULT (R3-A): a level's own body is drawn as an assembly when its GLB names at least this many components. */
export const BOARD_MIN_COMPONENTS = 2;
/**
 * DEFAULT (R3-A): the board's normal is the axis along which its own sheets are thinnest, when that extent is at
 * most this share of the next one (a board 1.6 mm thick and 100 mm wide: 0.016); else the body's up (CAD +Z).
 */
export const BOARD_THIN_SHARE = 0.25;

/** One component of a board drawn as an assembly. */
export interface BoardComponent {
  /** Its id in the body, as the GLB names it (an instance path relative to the body's owner). */
  id: string;
  /** The group that moves when the board explodes (named `id`, carrying `extras.protoboard.partInstanceId`). */
  obj: THREE.Group;
  /** The group's assembled position (GLB node space). */
  base: THREE.Vector3;
  /** Assembled bounds in the body's own CAD frame (mm, Z up). */
  box: THREE.Box3;
  /** Which face of the board it sits on: its centre above or below the board's mid-plane, along the normal. */
  side: "top" | "bottom";
  /** How far it stands out of that face, mm (0 for a part flush with it). */
  height: number;
  /** Where it is now, relative to its assembled place: level CAD mm (bounds, labels and the ground read it). */
  travel: THREE.Vector3;
  refdes?: string;
  definition?: string;
}

export interface BoardAssembly {
  components: BoardComponent[];
  byId: Map<string, BoardComponent>;
  /** The board's own objects (substrate, copper and silkscreen sheets, unmatched pads): never moved by the split. */
  substrate: THREE.Object3D[];
  /** The board sheets' bounds (body CAD mm). */
  substrateBox: THREE.Box3;
  /** The board's normal, a unit axis of the body's CAD frame (top side along it). */
  normal: THREE.Vector3;
  /** A body CAD mm vector into the space the wrappers are placed in (the GLB node holding them). */
  toNode: THREE.Matrix3;
  /** What the split did (progress.md, observe). */
  stats: { ms: number; measureMs?: number; wrapped: number; deinstanced: number; instancedNodes: number; unmatched: number };
}

type Extras = { partInstanceId?: unknown; refdes?: unknown; definition?: unknown; instances?: unknown };
const extrasOf = (o: THREE.Object3D): Extras => ((o.userData.protoboard && typeof o.userData.protoboard === "object" ? o.userData.protoboard : {}) as Extras);
const str = (x: unknown): string | undefined => (typeof x === "string" && x ? x : undefined);

/** A node's per-instance id list: `extras.protoboard.instances` (objects or strings) or the sidecar's strings. */
function instanceList(o: THREE.Object3D): unknown[] | undefined {
  const list = extrasOf(o).instances ?? o.userData.protoboardInstances;
  return Array.isArray(list) ? list : undefined;
}

/** The InstancedMeshes a GPU-instanced node draws with (the node itself, or a group of one per primitive). */
function instancedMeshesOf(o: THREE.Object3D): THREE.InstancedMesh[] {
  const out: THREE.InstancedMesh[] = [];
  o.traverse((x) => {
    if ((x as THREE.InstancedMesh).isInstancedMesh) out.push(x as THREE.InstancedMesh);
  });
  return out;
}

/** How many components a node tree names directly under `top` (a placed node with an id, or a named instance). */
export function countComponents(top: THREE.Object3D): number {
  let n = 0;
  for (const c of top.children) {
    if (str(extrasOf(c).partInstanceId)) n++;
    else {
      const list = instanceList(c);
      if (list && instancedMeshesOf(c).length) n += list.filter((e) => instanceIdOf(e)).length;
    }
  }
  return n;
}

const _m = new THREE.Matrix4();
const _rel = new THREE.Matrix4();

/**
 * Split the node tree of a board's GLB (a fresh clone, before it is wrapped and placed) into components: see the
 * file comment. `top` is the GLB's root node (its children are the board's nodes). Returns undefined, and leaves
 * the tree untouched, when fewer than `min` components are named.
 */
export function splitBoard(top: THREE.Object3D, min = BOARD_MIN_COMPONENTS, now: () => number = () => performance.now()): BoardAssembly | undefined {
  const t0 = now();
  if (countComponents(top) < min) return undefined;
  const components: BoardComponent[] = [];
  const substrate: THREE.Object3D[] = [];
  const stats = { ms: 0, wrapped: 0, deinstanced: 0, instancedNodes: 0, unmatched: 0 };
  const wrapperFor = (id: string, from: Extras): THREE.Group => {
    const g = new THREE.Group();
    g.name = id;
    g.userData.protoboard = { partInstanceId: id, ...(str(from.refdes) ? { refdes: from.refdes } : {}), ...(str(from.definition) ? { definition: from.definition } : {}) };
    g.userData.boardComponent = id;
    top.add(g);
    components.push({ id, obj: g, base: g.position.clone(), box: new THREE.Box3(), side: "top", height: 0, travel: new THREE.Vector3(), ...(str(from.refdes) ? { refdes: from.refdes as string } : {}), ...(str(from.definition) ? { definition: from.definition as string } : {}) });
    return g;
  };
  let unmatchedHolder: THREE.Group | undefined;
  for (const child of [...top.children]) {
    const ex = extrasOf(child);
    const id = str(ex.partInstanceId);
    if (id) {
      // a component placed once: its node moves inside a wrapper named by its instance path
      const g = wrapperFor(id, ex);
      top.remove(child);
      g.add(child);
      stats.wrapped++;
      continue;
    }
    const list = instanceList(child);
    const meshes = list ? instancedMeshesOf(child) : [];
    if (!list || !meshes.length) {
      substrate.push(child);
      continue;
    }
    // a footprint placed several times (EXT_mesh_gpu_instancing): one plain mesh per instance, sharing the node's
    // geometry and material (the batcher instances them again per geometry and look)
    stats.instancedNodes++;
    child.updateMatrix();
    const count = Math.min(...meshes.map((m) => m.count));
    for (let i = 0; i < count; i++) {
      const entry = list[i];
      const iid = instanceIdOf(entry);
      let holder: THREE.Group;
      if (iid) holder = wrapperFor(iid, entry && typeof entry === "object" ? (entry as Extras) : {});
      else {
        // an instance the export matched to no UHD part (ClientX's test pads 5V_INT, 3_3V_INT, 12V): the board's own
        if (!unmatchedHolder) {
          unmatchedHolder = new THREE.Group();
          unmatchedHolder.name = "unmatched";
          top.add(unmatchedHolder);
          substrate.push(unmatchedHolder);
        }
        holder = unmatchedHolder;
        stats.unmatched++;
      }
      for (const im of meshes) {
        im.getMatrixAt(i, _m);
        // the instance's place in the node's own space: node x (mesh within node) x instance
        _rel.copy(child.matrix);
        if (im !== child) {
          for (let o: THREE.Object3D | null = im; o && o !== child; o = o.parent) o.updateMatrix();
          const chain: THREE.Matrix4[] = [];
          for (let o: THREE.Object3D | null = im; o && o !== child; o = o.parent) chain.unshift(o.matrix);
          for (const c of chain) _rel.multiply(c);
        }
        _rel.multiply(_m);
        const mesh = new THREE.Mesh(im.geometry, im.material);
        mesh.name = im.name || child.name;
        _rel.decompose(mesh.position, mesh.quaternion, mesh.scale);
        // ids the picker and the face tables read (../render/ids.ts): the hash and the face-table key carry over
        for (const k of ["protoboardHash", "protoboardFaces", "gltfNode"]) if (im.userData[k] !== undefined) mesh.userData[k] = im.userData[k];
        mesh.castShadow = im.castShadow;
        mesh.receiveShadow = im.receiveShadow;
        holder.add(mesh);
        stats.deinstanced++;
      }
    }
    top.remove(child);
  }
  stats.ms = now() - t0;
  return { components, byId: new Map(components.map((c) => [c.id, c])), substrate, substrateBox: new THREE.Box3(), normal: new THREE.Vector3(0, 0, 1), toNode: new THREE.Matrix3(), stats };
}

/** The board's normal from its sheets' bounds: the thinnest axis when it is clearly thin, else +Z (DEFAULT). */
export function boardNormal(box: THREE.Box3, thinShare = BOARD_THIN_SHARE): THREE.Vector3 {
  if (box.isEmpty()) return new THREE.Vector3(0, 0, 1);
  const s = box.getSize(new THREE.Vector3());
  const axes = [s.x, s.y, s.z].map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  if (axes[0].v > thinShare * axes[1].v) return new THREE.Vector3(0, 0, 1);
  return new THREE.Vector3().setComponent(axes[0].i, 1);
}

/** Which side of the board a box sits on and how far it stands out of that face (mm), along the unit `normal`. */
export function sideOf(box: THREE.Box3, board: THREE.Box3, normal: THREE.Vector3): { side: "top" | "bottom"; height: number } {
  const lo = (b: THREE.Box3) => Math.min(b.min.dot(normal), b.max.dot(normal));
  const hi = (b: THREE.Box3) => Math.max(b.min.dot(normal), b.max.dot(normal));
  const mid = (lo(board) + hi(board)) / 2;
  const centre = (lo(box) + hi(box)) / 2;
  if (centre >= mid) return { side: "top", height: Math.max(0, hi(box) - hi(board)) };
  return { side: "bottom", height: Math.max(0, lo(board) - lo(box)) };
}

/**
 * Measure a split board once its tree is under CadView's CAD wrapper (`wrapper`'s world = the body's CAD frame:
 * call it before the wrapper is parented). Boxes are precise (every vertex), as CadView's own body box.
 */
export function measureBoard(asm: BoardAssembly, wrapper: THREE.Object3D, top: THREE.Object3D, now: () => number = () => performance.now()): void {
  const t0 = now();
  wrapper.updateMatrixWorld(true);
  const toBody = new THREE.Matrix4();
  if (wrapper.parent) toBody.copy(wrapper.parent.matrixWorld).invert();
  const boxOf = (o: THREE.Object3D) => new THREE.Box3().setFromObject(o, true).applyMatrix4(toBody);
  // the board's own sheets set its faces; pads the export could not match sit on them and do not (unless nothing else)
  const board = new THREE.Box3();
  for (const o of asm.substrate) if (o.name !== "unmatched") board.union(boxOf(o));
  if (board.isEmpty()) for (const o of asm.substrate) board.union(boxOf(o));
  asm.substrateBox.copy(board);
  asm.normal.copy(boardNormal(board));
  for (const c of asm.components) {
    c.box.copy(boxOf(c.obj));
    if (c.box.isEmpty() || board.isEmpty()) continue;
    const s = sideOf(c.box, board, asm.normal);
    c.side = s.side;
    c.height = s.height;
  }
  // body CAD (mm, Z up) -> the node the wrappers sit in (GLB metres, Y up): the inverse of that node's place
  const topInBody = toBody.clone().multiply(top.matrixWorld);
  asm.toNode.setFromMatrix4(topInBody.invert());
  asm.stats.measureMs = now() - t0;
}

const _v = new THREE.Vector3();
const _inv = new THREE.Matrix3();

/**
 * Put each component where a pose says (the sequence player's deltas, level CAD mm, by the component's key in the
 * level): only the translation of a delta is used (components lift off; they do not turn). `base` is the body's
 * placement (level CAD); `keyOf` maps a component to its key in the pose. Components the pose leaves out go back.
 */
export function applyBoardPose(asm: BoardAssembly, pose: ReadonlyMap<string, ArrayLike<number>>, base: THREE.Matrix4, keyOf: (c: BoardComponent) => string): void {
  _inv.setFromMatrix4(base).invert();
  for (const c of asm.components) {
    const d = pose.get(keyOf(c));
    c.obj.position.copy(c.base);
    c.travel.set(0, 0, 0);
    if (d) {
      c.travel.set(d[12], d[13], d[14]);
      // level mm -> body CAD mm -> the wrapper's node space
      _v.copy(c.travel).applyMatrix3(_inv).applyMatrix3(asm.toNode);
      c.obj.position.add(_v);
    }
    c.obj.updateMatrix();
    c.obj.matrixWorldNeedsUpdate = true;
  }
}
