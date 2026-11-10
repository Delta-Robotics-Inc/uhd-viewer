/**
 * Boxes from a view sidecar's scene index (PB-1176, for W2-C's loading screen,
 * "Show boxes"): one box per indexed node at its bounds, drawn before (or
 * instead of) any GLB is fetched. Only `X.view.json` is read.
 *
 * The boxes are in the GLB's own frame (glTF: metres, Y up), as the sidecar's
 * bounds are: the caller wraps them like a GLB scene (`cadWrapper`, back to mm
 * and Z up). Each box carries the node's ids (`userData.protoboard`), so
 * selection and labels by instance path work on them, and `userData.box`.
 */
import * as THREE from "three";
import type { ViewSidecar } from "./sidecar";

const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
const boxMaterial = new THREE.MeshStandardMaterial({ color: 0x8b8b8b, roughness: 0.8, metalness: 0, transparent: true, opacity: 0.55, depthWrite: false });
boxMaterial.name = "protoboard-box";

/** One box per sidecar node with bounds; an empty group when none has any. */
export function boxesFromSidecar(sidecar: ViewSidecar): THREE.Group {
  const g = new THREE.Group();
  g.name = "boxes";
  const min = new THREE.Vector3();
  const max = new THREE.Vector3();
  for (const n of sidecar.nodes) {
    if (!n.bounds) continue;
    min.fromArray(n.bounds[0]);
    max.fromArray(n.bounds[1]);
    const size = max.clone().sub(min);
    if (!(size.x >= 0 && size.y >= 0 && size.z >= 0)) continue;
    const box = new THREE.Mesh(boxGeometry, boxMaterial);
    box.name = n.name ?? `node${n.node ?? ""}`;
    // a flat part (a board's outline) still gets a visible box
    box.scale.set(Math.max(size.x, 1e-5), Math.max(size.y, 1e-5), Math.max(size.z, 1e-5));
    box.position.copy(min).add(max).multiplyScalar(0.5);
    box.userData.box = true;
    box.userData.protoboard = { ...(n.instancePath !== undefined ? { partInstanceId: n.instancePath } : {}), ...(n.placeholder ? { placeholder: true } : {}) };
    g.add(box);
  }
  return g;
}
