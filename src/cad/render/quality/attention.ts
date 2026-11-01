/**
 * Attention foveation (PB-1176): the parts the user or an agent is looking at
 * keep the fine tier and full pixel density while the quality curve degrades
 * the rest. Eye tracking does not transfer to a windowed CAD view; attention
 * does (round-2-notes quality-curve-uhd-carrier-transcripts.md, A3).
 *
 * Three sets of keys, by who put them there:
 * - `selected`: the view's selection (CadView sets it once W2-A wires it; until
 *   then a mesh that is lit, i.e. drawn with a highlight, counts as selected);
 * - `agent`: what an agent focuses (the view state's agent focus, W2-A);
 * - `hovered`: what the pointer is over.
 *
 * A key is a body key (CadView `userData.bodyKey`, the body's instance path,
 * possibly with a `#` suffix) or a routed harness key (`userData.harness`).
 * A key focuses the body it names, the bodies under it (an assembly selected
 * as its parts) and the body holding it (a component inside a board selects
 * the board).
 */
import * as THREE from "three";

export type AttentionKind = "selected" | "agent" | "hovered";

export interface AttentionSnapshot {
  selected: string[];
  agent: string[];
  hovered: string[];
}

export class Attention {
  private sets: Record<AttentionKind, Set<string>> = { selected: new Set(), agent: new Set(), hovered: new Set() };
  /** Bumped on every change (merges and the foveal inset are rebuilt when it moves). */
  version = 0;
  private memo = new Map<string, boolean>();
  private listeners = new Set<() => void>();

  /** Replace one set. Returns true when it changed. */
  set(kind: AttentionKind, keys: Iterable<string>): boolean {
    const next = new Set([...keys].filter((k) => typeof k === "string" && k.length > 0));
    const cur = this.sets[kind];
    if (next.size === cur.size && [...next].every((k) => cur.has(k))) return false;
    this.sets[kind] = next;
    this.version++;
    this.memo.clear();
    for (const l of this.listeners) l();
    return true;
  }

  get(kind: AttentionKind): ReadonlySet<string> {
    return this.sets[kind];
  }

  snapshot(): AttentionSnapshot {
    return { selected: [...this.sets.selected], agent: [...this.sets.agent], hovered: [...this.sets.hovered] };
  }

  get empty(): boolean {
    return !this.sets.selected.size && !this.sets.agent.size && !this.sets.hovered.size;
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  /** Whether a body or harness key is under attention (memoised until the sets change). */
  focusedKey(key: string | undefined): boolean {
    if (!key) return false;
    const hit = this.memo.get(key);
    if (hit !== undefined) return hit;
    let out = false;
    for (const kind of ["selected", "agent", "hovered"] as const)
      for (const a of this.sets[kind])
        if (keyCovers(a, key)) {
          out = true;
          break;
        }
    this.memo.set(key, out);
    return out;
  }

  /** Whether a logical mesh is under attention: its body or harness key, or it is lit (a highlight: the selection until W2-A sets it). */
  focused(o: THREE.Object3D): boolean {
    if (isLit(o)) return true;
    return this.focusedKey(o.userData.bodyKey as string | undefined) || this.focusedKey(o.userData.harness as string | undefined);
  }
}

/** `a` (an attention key) covers body key `k`: the same, an ancestor of it, or a component inside it. */
export function keyCovers(a: string, k: string): boolean {
  if (a === k) return true;
  const kb = k.split("#")[0];
  const ab = a.split("#")[0];
  if (ab === kb) return true;
  return kb.startsWith(`${ab}/`) || ab.startsWith(`${kb}/`);
}

/** A mesh drawn with a highlight (`setMeshLook` emissive, or `userData.emissive`). */
export function isLit(o: THREE.Object3D): boolean {
  if (typeof o.userData.emissive === "number" && o.userData.emissive !== 0) return true;
  const look = o.userData.look as { emissive?: number } | undefined;
  return look?.emissive !== undefined && look.emissive !== 0;
}

const _box = new THREE.Box3();
const _v = new THREE.Vector3();

/**
 * The screen rectangle (CSS pixels, origin bottom left as WebGL scissors take
 * it) covering the focused meshes' world boxes, padded, or undefined when
 * nothing focused is on screen. `boxes` are world-space boxes.
 */
export function focusRect(boxes: THREE.Box3[], camera: THREE.Camera, width: number, height: number, padPx = 8): { x: number; y: number; w: number; h: number } | undefined {
  if (!boxes.length || width <= 0 || height <= 0) return undefined;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of boxes) {
    if (b.isEmpty()) continue;
    for (let i = 0; i < 8; i++) {
      _v.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).project(camera);
      // a corner behind the camera: the box spans the view plane, take the whole screen
      if (_v.z > 1 || _v.z < -1) return { x: 0, y: 0, w: width, h: height };
      x0 = Math.min(x0, _v.x);
      x1 = Math.max(x1, _v.x);
      y0 = Math.min(y0, _v.y);
      y1 = Math.max(y1, _v.y);
    }
  }
  if (!Number.isFinite(x0)) return undefined;
  const px = (n: number, size: number) => ((n + 1) / 2) * size;
  const left = Math.max(0, Math.floor(px(x0, width) - padPx));
  const right = Math.min(width, Math.ceil(px(x1, width) + padPx));
  const bottom = Math.max(0, Math.floor(px(y0, height) - padPx));
  const top = Math.min(height, Math.ceil(px(y1, height) + padPx));
  if (right <= left || top <= bottom) return undefined;
  return { x: left, y: bottom, w: right - left, h: top - bottom };
}

/** World boxes of the focused, visible meshes under `roots` (world matrices up to date). */
export function focusedBoxes(roots: THREE.Object3D[], attention: Attention): THREE.Box3[] {
  const out: THREE.Box3[] = [];
  const walk = (o: THREE.Object3D, visible: boolean) => {
    const vis = visible && o.visible;
    if (!vis) return;
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && attention.focused(mesh)) {
      const inst = mesh as THREE.InstancedMesh;
      let local: THREE.Box3 | null;
      if (inst.isInstancedMesh) {
        // every instance, not the one geometry
        if (!inst.boundingBox) inst.computeBoundingBox();
        local = inst.boundingBox;
      } else {
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        local = mesh.geometry.boundingBox;
      }
      if (local) out.push(_box.copy(local).applyMatrix4(mesh.matrixWorld).clone());
    }
    for (const c of o.children) walk(c, vis);
  };
  for (const r of roots) walk(r, true);
  return out;
}
