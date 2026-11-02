/**
 * Painting a selection and a highlight (R1-A, items A1, A2 and M5 of the 2026-11-01 walkthrough): the selected
 * thing, body or component, is drawn in the theme's accent surface (`focusMaterial`, one orange for every view); what
 * an agent highlights glows (an emissive variant of its own material, ./looks.ts). A component lives inside its
 * holder body (a board's part): it is found by node name, by the instance path its extras carry, or as one instance
 * of a GPU-instanced node, which gets a twin drawn over it. Every change pushes its undo onto `restore`.
 */
import * as THREE from "three";
import { focusMaterial, type SceneColors } from "../scene";
import { baseMaterialOf, setMeshLook } from "./looks";
import { instanceIdOf } from "./ids";

/**
 * The highlight surface for one instance of a GPU-instanced node (R1-A, A1): the instance's own material with the
 * glow, drawn just in front of it (a twin over the instance). One per base material and colour.
 */
const glowTwinMaterials = new WeakMap<THREE.Material, Map<number, THREE.Material>>();
export function glowTwinMaterial(base: THREE.Material, color: number): THREE.Material {
  let byColor = glowTwinMaterials.get(base);
  if (!byColor) glowTwinMaterials.set(base, (byColor = new Map()));
  let m = byColor.get(color);
  if (!m) {
    const std = base as THREE.MeshStandardMaterial;
    const v = std.isMeshStandardMaterial ? std.clone() : new THREE.MeshStandardMaterial({ color: 0x808080 });
    v.emissive.setHex(color);
    v.emissiveIntensity = 1;
    v.polygonOffset = true;
    v.polygonOffsetFactor = -2;
    v.polygonOffsetUnits = -2;
    byColor.set(color, (m = v));
  }
  return m;
}

/** Point a mesh at another material until `restore` runs (unless something else changed it meanwhile). */
export function swapMaterial(mesh: THREE.Mesh, mat: THREE.Material, restore: (() => void)[]): void {
  const was = mesh.material;
  if (was === mat) return;
  mesh.material = mat;
  restore.push(() => {
    if (mesh.material === mat) mesh.material = was;
  });
}

/**
 * Paint a component drawn inside a body (a board's part; R1-A, A1 and A2): `select` gives it the selection's solid
 * accent surface, `highlight` the highlight glow. It is found by its node's name (its id in the body), by the
 * instance path its extras carry (a sub-module's path lights every part under it), or as one instance of a
 * GPU-instanced node (a twin of that instance drawn over it). Returns whether anything was found.
 */
export function paintComponent(rec: { obj: THREE.Object3D; body: { key: string } }, path: string, mode: "select" | "highlight", colors: SceneColors, restore: (() => void)[]): boolean {
  const holder = rec.body.key.split("#")[0];
  const rel = holder && path.startsWith(`${holder}/`) ? path.slice(holder.length + 1) : path;
  const names = (id: unknown) => typeof id === "string" && id !== "" && (id === rel || id === path || id.startsWith(`${rel}/`) || id.startsWith(`${path}/`));
  const partId = (o: THREE.Object3D) => (o.userData.protoboard as { partInstanceId?: unknown } | undefined)?.partInstanceId;
  const mark = (mesh: THREE.Mesh) => {
    if (mode === "select") swapMaterial(mesh, focusMaterial(colors.focus), restore);
    else {
      setMeshLook(mesh, { emissive: colors.glowStrong });
      restore.push(() => setMeshLook(mesh, { emissive: undefined }));
    }
  };
  let found = false;
  const walk = (o: THREE.Object3D) => {
    if (o.name === rel || names(partId(o))) {
      found = true;
      o.traverse((x) => {
        if ((x as THREE.Mesh).isMesh && !x.userData.feature) mark(x as THREE.Mesh);
      });
      return;
    }
    for (const c of o.children) walk(c);
  };
  walk(rec.obj);
  if (found) return true;
  // one instance of a GPU-instanced node (`extras.protoboard.instances`, e.g. ClientX's SOP-8 packages): a twin of
  // that instance in the highlight surface, drawn over it (gate 3; the annotation layer resolves it the same way)
  const twins: { parent: THREE.Object3D; twin: THREE.Mesh }[] = [];
  rec.obj.traverse((o) => {
    const im = o as THREE.InstancedMesh;
    const list = ((o.userData.protoboard as { instances?: unknown } | undefined)?.instances ?? o.userData.protoboardInstances) as unknown;
    if (!im.isInstancedMesh || !Array.isArray(list) || !im.parent) return;
    list.forEach((p, i) => {
      // R3-A: an entry is a plain path (sidecar) or the view-model's `{partInstanceId}` object
      if (i >= im.count || !names(instanceIdOf(p))) return;
      const at = new THREE.Matrix4();
      im.getMatrixAt(i, at);
      const base = baseMaterialOf(im);
      const twin = new THREE.Mesh(im.geometry, mode === "select" ? focusMaterial(colors.focus) : glowTwinMaterial(base, colors.glowStrong));
      twin.matrixAutoUpdate = false;
      twin.matrix.multiplyMatrices(im.matrix, at);
      twin.userData.noBatch = true;
      twin.raycast = () => {};
      twins.push({ parent: im.parent!, twin });
    });
  });
  for (const { parent, twin } of twins) {
    parent.add(twin);
    restore.push(() => parent.remove(twin));
  }
  return twins.length > 0;
}
