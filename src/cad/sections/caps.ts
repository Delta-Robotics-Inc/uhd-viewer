/**
 * Section caps for the live view (PB-1186, the GPU half of the hybrid caps): a stencil fill where a section plane
 * passes through solid material, drawn every frame, so a cut part reads as solid, not as a hollow shell.
 *
 * How: after the scene pass (depth written), for each plane the clipped geometry is drawn once more with no colour
 * and no depth test, both faces, inverting one stencil bit per fragment. A ray from the eye that reaches the plane
 * inside a closed part crosses that part's kept surface an odd number of times; outside, an even number. Then a
 * quad lying on the plane is drawn where the bit is set, depth-tested (what stands in front of the cut still hides
 * it) and clipped by the other planes only; the bit is cleared. The quad writes depth, so the ink pass outlines the
 * cap like any face.
 *
 * Hatching (R2-B, 2026-11-02, Kevin's walkthrough G5: "hatch lines on the inside of a cross section, similar to how
 * Onshape and Fusion do cross sections"; R1's gate: "caps draw but the fill reads like the panels"): the quad's fill
 * carries diagonal lines in the ink colour over the cap tone, so a cut reads as a section, never as a panel's
 * exterior. The lines are laid in the plane, in model mm (`HATCH_MM` apart at `HATCH_DEG`), so they stay on the part
 * as the view turns; when that spacing would draw closer than `HATCH_MIN_PX` on screen (a far view), the lines are laid
 * in screen space `HATCH_SCREEN_PX` apart instead, so the cap never turns to a grey mush. Lines are one device pixel,
 * anti-aliased with the derivative of the line coordinate.
 *
 * Colours: the theme's `sectionCap` tone (one step off the model's tones) and its `sectionLine` ink. Until the scene
 * hands the ink over (`setInk`, a handoff to the scene's owner), the ink is chosen from the cap's luminance: the paper
 * look's dark ink on a light cap, the dark look's light ink on a dark cap (the two themes' own `sectionLine` values).
 *
 * Cost: one extra geometry pass per plane (vertex work; no colour writes), only while a section is on. Measured on
 * ClientX's board in phase-1/progress.md (W3-C); the hatch is a few ALU ops on the cap's own pixels.
 *
 * Open (non-closed) meshes give speckled caps; CAD exports are closed solids, the tessellated board too. A part
 * whose mesh is open gets its cap from the CPU cut instead once the view settles (./index.ts, noted in the report).
 */
import * as THREE from "three";

/** Size of the cap quad as a multiple of the model's bounding radius (it must cover the whole cut). DEFAULT. */
const QUAD_SCALE = 4;
/** Hatch line spacing on the cut, model mm (DEFAULT, Kevin's ask; Onshape's default section hatch is of this order). */
export const HATCH_MM = 1.2;
/** Hatch angle in the plane, degrees from the plane's first in-plane axis (DEFAULT 45). */
export const HATCH_DEG = 45;
/** Below this many screen pixels between model-space lines, the hatch is laid in screen space (DEFAULT). */
export const HATCH_MIN_PX = 2;
/** The screen-space fallback's spacing, CSS px (DEFAULT). */
export const HATCH_SCREEN_PX = 6;
/** Line width, CSS px (DEFAULT 1). */
export const HATCH_LINE_PX = 1;
/** How much of the ink the lines take over the cap tone (DEFAULT 0.85: lines read as ink, a touch softer than the outline). */
export const HATCH_INK_SHARE = 0.85;

/** The two themes' section ink (themes.ts `sectionLine`), chosen by the cap's luminance until the scene hands its own. */
export const INK_ON_LIGHT = "#26262a";
export const INK_ON_DARK = "#d4d4d4";

/** Relative luminance (WCAG) of an sRGB hex colour. */
export function luminance(hex: string): number {
  const c = new THREE.Color(hex);
  // THREE.Color holds linear values after a hex set in r152+ (ColorManagement on): those are the WCAG channel terms
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

/** WCAG contrast ratio of two hex colours. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** The ink for a cap tone: the dark ink on a light cap, the light ink on a dark one. */
export const inkFor = (cap: string): string => (contrast(cap, INK_ON_LIGHT) >= contrast(cap, INK_ON_DARK) ? INK_ON_LIGHT : INK_ON_DARK);

/** The hatch uniforms the cap fill reads (also used by the CPU caps in ./index.ts). */
export function hatchUniforms() {
  return {
    uHatchInk: { value: new THREE.Color(INK_ON_DARK) },
    uHatchShare: { value: HATCH_INK_SHARE },
    /** World-space unit vector across the lines (in the plane), and the spacing in mm. */
    uHatchAcross: { value: new THREE.Vector3(1, 0, 0) },
    uHatchMm: { value: HATCH_MM },
    /** Screen-space fallback: the direction across the lines on screen, spacing and line width in device px. */
    uHatchScreen: { value: new THREE.Vector2(Math.SQRT1_2, -Math.SQRT1_2) },
    uHatchScreenPx: { value: HATCH_SCREEN_PX },
    uHatchMinPx: { value: HATCH_MIN_PX },
    uHatchLinePx: { value: HATCH_LINE_PX },
  };
}
export type HatchUniforms = ReturnType<typeof hatchUniforms>;

/** GLSL (ASCII only: some drivers refuse anything else, even in comments) that mixes the hatch into `diffuseColor`. */
export const HATCH_FRAGMENT = /* glsl */ `
#ifdef UHD_HATCH
  {
    // model-space lines: the coordinate across them in units of the spacing, and its change per pixel
    float c = dot( vHatchWorld, uHatchAcross ) / uHatchMm;
    float w = fwidth( c );
    // too dense on screen (fewer than uHatchMinPx pixels from line to line): lay them in screen space
    if ( w * uHatchMinPx > 1.0 ) {
      c = dot( gl_FragCoord.xy, uHatchScreen ) / uHatchScreenPx;
      w = fwidth( c );
    }
    float d = abs( fract( c + 0.5 ) - 0.5 ) / max( w, 1e-6 );
    float line = clamp( 0.5 * uHatchLinePx + 0.5 - d, 0.0, 1.0 );
    diffuseColor.rgb = mix( diffuseColor.rgb, uHatchInk, line * uHatchShare );
  }
#endif
`;

/** Patch a basic material's shader with the hatch (world position varying, the uniforms, the mix). */
export function patchHatch(shader: THREE.WebGLProgramParametersWithUniforms, u: HatchUniforms): void {
  Object.assign(shader.uniforms, u);
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "#include <common>\nvarying vec3 vHatchWorld;")
    .replace("#include <project_vertex>", "#include <project_vertex>\n  vHatchWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;");
  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <common>",
      "#include <common>\n#define UHD_HATCH\nvarying vec3 vHatchWorld;\nuniform vec3 uHatchInk;\nuniform float uHatchShare;\nuniform vec3 uHatchAcross;\nuniform float uHatchMm;\nuniform vec2 uHatchScreen;\nuniform float uHatchScreenPx;\nuniform float uHatchMinPx;\nuniform float uHatchLinePx;",
    )
    .replace("#include <map_fragment>", `#include <map_fragment>\n${HATCH_FRAGMENT}`);
}

/** In-plane axes of a plane (u along the world axis least aligned with the normal, crossed; v = n x u). */
export function planeAxes(normal: THREE.Vector3, u = new THREE.Vector3(), v = new THREE.Vector3()): { u: THREE.Vector3; v: THREE.Vector3 } {
  const ref = Math.abs(normal.z) < 0.9 ? _z : _x;
  u.crossVectors(ref, normal).normalize();
  v.crossVectors(normal, u).normalize();
  return { u, v };
}
const _x = new THREE.Vector3(1, 0, 0);
const _z = new THREE.Vector3(0, 0, 1);

/** The world direction across the hatch lines of a plane (in the plane, `HATCH_DEG` from its u axis, plus 90). */
export function hatchAcross(normal: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  const { u, v } = planeAxes(normal);
  const a = ((HATCH_DEG + 90) * Math.PI) / 180;
  return out.copy(u).multiplyScalar(Math.cos(a)).addScaledVector(v, Math.sin(a)).normalize();
}

/** A material that fills a cap with the hatch (the stencil-less CPU caps of open meshes use it too). */
export function hatchMaterial(params: THREE.MeshBasicMaterialParameters, u = hatchUniforms()): THREE.MeshBasicMaterial & { userData: { hatch: HatchUniforms } } {
  const m = new THREE.MeshBasicMaterial(params) as THREE.MeshBasicMaterial & { userData: { hatch: HatchUniforms } };
  m.userData.hatch = u;
  m.onBeforeCompile = (shader) => patchHatch(shader, u);
  m.customProgramCacheKey = () => "uhd-hatch-v1";
  return m;
}

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
  /** The hatch the fill draws (ink, spacing, direction per plane). */
  readonly hatch = hatchUniforms();
  /** The cap fill: where the bit is set, depth-tested, writing depth; unlit, the theme's tone with the hatch. */
  readonly fill = hatchMaterial(
    {
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
    },
    this.hatch,
  );
  private quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.fill);
  private holder = new THREE.Scene();
  /** Last pass: planes capped and the GPU time is the caller's to measure. */
  last = { planes: 0, ms: 0 };
  /** The ink was handed over by the scene (`setInk`): the luminance rule no longer picks it. */
  private inkSet = false;
  private capHex = "#4a4640";

  constructor() {
    this.quad.frustumCulled = false;
    this.quad.matrixAutoUpdate = false;
    this.holder.add(this.quad);
    this.holder.matrixWorldAutoUpdate = false;
    this.hatch.uHatchInk.value.set(inkFor(this.capHex));
  }

  setColor(hex: string): void {
    this.capHex = hex;
    this.fill.color.set(hex);
    if (!this.inkSet) this.hatch.uHatchInk.value.set(inkFor(hex));
  }

  /** The hatch ink (the theme's `sectionLine`); handed over by the scene with the look. */
  setInk(hex: string): void {
    this.inkSet = true;
    this.hatch.uHatchInk.value.set(hex);
  }

  /** The cap tone and ink in force (tests, observe). */
  colors(): { cap: string; ink: string } {
    return { cap: `#${this.fill.color.getHexString()}`, ink: `#${this.hatch.uHatchInk.value.getHexString()}` };
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
    // device pixels: the screen-space spacing and the line width follow the pixel ratio
    const dpr = renderer.getPixelRatio?.() ?? 1;
    this.hatch.uHatchScreenPx.value = HATCH_SCREEN_PX * dpr;
    this.hatch.uHatchLinePx.value = HATCH_LINE_PX * dpr;
    this.hatch.uHatchMinPx.value = HATCH_MIN_PX * dpr;
    try {
      for (let i = 0; i < planes.length; i++) {
        const p = planes[i];
        renderer.clearStencil();
        drawStencil(this.stencil, p);
        // the quad lies on plane i: clipped by the others only (by itself it would sit exactly on the boundary)
        setClipping(planes.filter((_, j) => j !== i));
        this.placeQuad(p, bounds);
        hatchAcross(p.normal, this.hatch.uHatchAcross.value);
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
