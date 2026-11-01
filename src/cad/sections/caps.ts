/**
 * Section caps for the live view (PB-1186, the GPU half of the hybrid caps): a stencil fill where a section plane
 * passes through solid material, drawn every frame, so a cut part reads as solid, not as a hollow shell.
 *
 * How: after the scene pass (depth written), for each plane the clipped geometry is drawn once more with no colour
 * and no depth test, both faces, inverting one stencil bit per fragment. A ray from the eye that reaches the plane
 * inside a closed part crosses that part's kept surface an odd number of times; outside, an even number. Then a
 * quad lying on the plane is drawn where the bit is set, depth-tested (what stands in front of the cut still hides
 * it) and clipped by the other planes only, in the theme's `sectionCap` colour; the bit is cleared. The quad
 * writes depth, so the ink pass outlines the cap like any face.
 *
 * Cost: one extra geometry pass per plane (vertex work; no colour writes), only while a section is on. Measured on
 * ClientX's board in phase-1/progress.md (W3-C).
 *
 * Open (non-closed) meshes give speckled caps; CAD exports are closed solids, the tessellated board too.
 */
import * as THREE from "three";

/** Size of the cap quad as a multiple of the model's bounding radius (it must cover the whole cut). DEFAULT. */
const QUAD_SCALE = 4;

export class SectionCaps {
  /** Writes the parity bit only (bit 0). */
  readonly stencil = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
    stencilWrite: true,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilRef: 1,
    stencilWriteMask: 1,
    stencilFuncMask: 1,
    stencilFail: THREE.KeepStencilOp,
    stencilZFail: THREE.InvertStencilOp,
    stencilZPass: THREE.InvertStencilOp,
  });
  /** The cap fill: where the bit is set, depth-tested, writing depth; unlit, the theme's colour. */
  readonly fill = new THREE.MeshBasicMaterial({
    color: 0x4a4640,
    side: THREE.DoubleSide,
    toneMapped: false,
    stencilWrite: true,
    stencilFunc: THREE.EqualStencilFunc,
    stencilRef: 1,
    stencilFuncMask: 1,
    stencilWriteMask: 1,
    stencilFail: THREE.KeepStencilOp,
    stencilZFail: THREE.ZeroStencilOp,
    stencilZPass: THREE.ZeroStencilOp,
  });
  private quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.fill);
  private holder = new THREE.Scene();
  /** Last pass: planes capped and the GPU time is the caller's to measure. */
  last = { planes: 0, ms: 0 };

  constructor() {
    this.quad.frustumCulled = false;
    this.quad.matrixAutoUpdate = false;
    this.holder.add(this.quad);
    this.holder.matrixWorldAutoUpdate = false;
  }

  setColor(hex: string): void {
    this.fill.color.set(hex);
  }

  /**
   * Draw the caps for `planes` (world) into the current target, after the scene pass. `drawStencil(material)` draws
   * whatever the section cuts with `material` (the scene with an override material, or only the scoped subtree)
   * clipped by every plane; `setClipping(planes)` sets the renderer's clipping for the quad.
   */
  draw(
    renderer: THREE.WebGLRenderer,
    camera: THREE.Camera,
    planes: readonly THREE.Plane[],
    bounds: THREE.Sphere,
    drawStencil: (material: THREE.Material, plane: THREE.Plane) => void,
    setClipping: (planes: THREE.Plane[]) => void,
  ): void {
    const t0 = performance.now();
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    try {
      for (let i = 0; i < planes.length; i++) {
        const p = planes[i];
        renderer.clearStencil();
        drawStencil(this.stencil, p);
        // the quad lies on plane i: clipped by the others only (by itself it would sit exactly on the boundary)
        setClipping(planes.filter((_, j) => j !== i));
        this.placeQuad(p, bounds);
        renderer.render(this.holder, camera);
        setClipping([...planes]);
      }
    } finally {
      renderer.clearStencil();
      renderer.autoClear = autoClear;
    }
    this.last = { planes: planes.length, ms: performance.now() - t0 };
  }

  /** The quad on the plane, centred on the model's centre projected onto it, large enough to cover the cut. */
  private placeQuad(plane: THREE.Plane, bounds: THREE.Sphere): void {
    const centre = plane.projectPoint(bounds.center, new THREE.Vector3());
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), plane.normal);
    const size = Math.max(1, bounds.radius * QUAD_SCALE);
    this.quad.matrix.compose(centre, q, new THREE.Vector3(size, size, 1));
    this.quad.matrixWorld.copy(this.quad.matrix);
  }

  dispose(): void {
    this.stencil.dispose();
    this.fill.dispose();
    this.quad.geometry.dispose();
  }
}
