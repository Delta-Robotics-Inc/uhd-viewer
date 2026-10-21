import * as THREE from "three";

/**
 * Bodies that nothing places (PB-1040) in a row beside what is placed, once
 * their models are loaded and their sizes known: along x, after the placed
 * bodies, centred on them across and resting on their lowest point; from the
 * origin when nothing is placed. Each one's `base` is where it now sits.
 */
export function layOutRow(recs: { body: { row?: boolean }; base: THREE.Matrix4; obj: THREE.Object3D; box: THREE.Box3 }[]) {
  const row = recs.filter((r) => r.body.row && !r.box.isEmpty());
  if (!row.length) return;
  const placed = new THREE.Box3();
  for (const r of recs) if (!r.body.row && !r.box.isEmpty()) placed.union(r.box.clone().applyMatrix4(r.base));
  const sizes = row.map((r) => r.box.getSize(new THREE.Vector3()));
  const gap = Math.max(8, 0.25 * Math.max(...sizes.map((v) => Math.max(v.x, v.y))));
  let x = placed.isEmpty() ? 0 : placed.max.x + gap;
  const y = placed.isEmpty() ? 0 : placed.getCenter(new THREE.Vector3()).y;
  const z = placed.isEmpty() ? 0 : placed.min.z;
  row.forEach((r, i) => {
    const c = r.box.getCenter(new THREE.Vector3());
    r.base.makeTranslation(x - r.box.min.x, y - c.y, z - r.box.min.z);
    r.obj.matrix.copy(r.base);
    r.obj.matrixWorldNeedsUpdate = true;
    x += sizes[i].x + gap;
  });
}
