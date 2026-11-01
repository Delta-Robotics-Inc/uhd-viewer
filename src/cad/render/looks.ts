/**
 * Per-mesh highlight and x-ray without a material per mesh (PB-1175).
 *
 * A mesh keeps its base material (shared: one per look, or the GLB's own) in
 * `userData.baseMaterial`; a highlight or x-ray points it at a *variant* of
 * that base, made once per (base, state) and shared by every mesh in the same
 * state. Under the batcher (./batch.ts) a variant differs from its base only
 * in emissive, which is a per-instance attribute, so selecting draws through
 * the same GPU material and costs an attribute write; x-ray changes the look
 * (opacity), so x-rayed meshes move to a see-through batch. Without batching
 * the variants are drawn as they are.
 */
import * as THREE from "three";

export interface MeshLook {
  /** Emissive glow (hex), or none. */
  emissive?: number;
  /** See-through (x-ray of a shell). */
  xray?: boolean;
}

const variants = new WeakMap<THREE.Material, Map<string, THREE.MeshStandardMaterial>>();

/** The shared variant of `base` for a state (the base itself when there is nothing to change). */
export function variantOf(base: THREE.Material, look: MeshLook): THREE.Material {
  if (look.emissive === undefined && !look.xray) return base;
  const std = base as THREE.MeshStandardMaterial;
  if (!std.isMeshStandardMaterial) return base;
  let byKey = variants.get(base);
  if (!byKey) variants.set(base, (byKey = new Map()));
  const key = `${look.emissive ?? "-"}|${look.xray ? 1 : 0}`;
  let v = byKey.get(key);
  if (!v) {
    v = std.clone();
    if (look.emissive !== undefined) {
      v.emissive.setHex(look.emissive);
      v.emissiveIntensity = 1;
    }
    if (look.xray) {
      v.transparent = true;
      v.opacity = 0.22;
      v.depthWrite = false;
    }
    v.userData = { ...v.userData, variantOf: base.uuid };
    byKey.set(key, v);
  }
  // the base's side follows the section view: a variant made earlier follows it too
  if (v.side !== std.side) {
    v.side = std.side;
    v.needsUpdate = true;
  }
  return v;
}

/** Set part of a mesh's state (`undefined` clears that part) and point it at the matching shared material. */
export function setMeshLook(mesh: THREE.Mesh, change: MeshLook): void {
  const base = (mesh.userData.baseMaterial ??= mesh.material) as THREE.Material;
  const state = (mesh.userData.look ??= {}) as MeshLook;
  if ("emissive" in change) state.emissive = change.emissive;
  if ("xray" in change) state.xray = change.xray;
  mesh.material = variantOf(base, state);
}

/** The material a mesh would show with no highlight and no x-ray. */
export function baseMaterialOf(mesh: THREE.Mesh): THREE.Material {
  return (mesh.userData.baseMaterial ?? mesh.material) as THREE.Material;
}
