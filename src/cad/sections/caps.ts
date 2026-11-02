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
 * Colours, per part (R4-C, 2026-11-02; Kevin: "The color of the cross-section hatch system should match the color of
 * the actual 3D model"): after the parity pass, a second pass draws the BACK faces of the same geometry where the
 * parity bit is set, depth-tested against the scene. Looking into a cut closed part, the nearest back face behind the
 * cut is that part's own far wall, so each cap pixel is shaded by the part it belongs to: the shader reads that
 * part's colour where the scene keeps it (the batcher's per-instance colour and glow, a merged mesh's vertex colour,
 * a material's colour and emissive set per draw), finds the point on the plane along the view ray, and paints the
 * fill and hatch there in the part's own tones (./capColour.ts: the fill pulled 12 % toward the background in
 * lightness, the lines a darker tone of the same hue at 3:1 or more). It marks what it painted in a second stencil
 * bit. Then the quad fills, in the theme's `sectionCap` with its `sectionLine` hatch, only what the part pass did
 * not reach (an open mesh, a part whose far wall is missing), and a second, depth-only draw of the quad puts the
 * plane's depth under every cap pixel (the ink pass outlines the cap like a face) and clears both bits.
 *
 * The theme's tones: until the scene hands the ink over (`setInk`), it is chosen from the cap's luminance: the paper
 * look's dark ink on a light cap, the dark look's light ink on a dark cap (the two themes' own `sectionLine` values).
 * The background and the lit tone the part tones are derived against come from `setSceneTones` (a handoff to the
 * scene's owner); until then from the theme the ink belongs to (paper's dark ink: the paper scene tokens).
 *
 * Cost: per plane, the parity pass and the part pass (two geometry passes over the parts the plane crosses; the
 * second shades only cap pixels) and two quads, only while a section is on. Measured in phase-1/progress.md (R4-C).
 *
 * Open (non-closed) meshes give speckled caps; CAD exports are closed solids, the tessellated board too. A part
 * whose mesh is open gets its cap from the CPU cut instead once the view settles (./index.ts, noted in the report).
 */
import * as THREE from "three";
import { CAP_LINE_SHARE, CAP_TONES_GLSL, DARK_CAP_SCENE, PAPER_CAP_SCENE, capSceneParams, type CapScene } from "./capColour";
import { NEUTRAL_FALLBACK } from "../render/toon";

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

/**
 * GLSL (ASCII only: some drivers refuse anything else, even in comments): the hatch's uniforms and `uhdHatchLine`,
 * the line coverage (0..1) at a world point of the cut. Shared by the theme fill and the part pass.
 */
export const HATCH_PARS = /* glsl */ `
uniform vec3 uHatchAcross;
uniform float uHatchMm;
uniform vec2 uHatchScreen;
uniform float uHatchScreenPx;
uniform float uHatchMinPx;
uniform float uHatchLinePx;
float uhdHatchLine( vec3 world ) {
  // model-space lines: the coordinate across them in units of the spacing, and its change per pixel
  float c = dot( world, uHatchAcross ) / uHatchMm;
  float w = fwidth( c );
  // too dense on screen (fewer than uHatchMinPx pixels from line to line): lay them in screen space
  if ( w * uHatchMinPx > 1.0 ) {
    c = dot( gl_FragCoord.xy, uHatchScreen ) / uHatchScreenPx;
    w = fwidth( c );
  }
  float d = abs( fract( c + 0.5 ) - 0.5 ) / max( w, 1e-6 );
  return clamp( 0.5 * uHatchLinePx + 0.5 - d, 0.0, 1.0 );
}
`;

/** GLSL that mixes the hatch into `diffuseColor` (the theme fill, the CPU caps). */
export const HATCH_FRAGMENT = /* glsl */ `
#ifdef UHD_HATCH
  diffuseColor.rgb = mix( diffuseColor.rgb, uHatchInk, uhdHatchLine( vHatchWorld ) * uHatchShare );
#endif
`;

/** Patch a basic material's shader with the hatch (world position varying, the uniforms, the mix). */
export function patchHatch(shader: THREE.WebGLProgramParametersWithUniforms, u: HatchUniforms): void {
  Object.assign(shader.uniforms, u);
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "#include <common>\nvarying vec3 vHatchWorld;")
    .replace("#include <project_vertex>", "#include <project_vertex>\n  vHatchWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;");
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", `#include <common>\n#define UHD_HATCH\nvarying vec3 vHatchWorld;\nuniform vec3 uHatchInk;\nuniform float uHatchShare;\n${HATCH_PARS}`)
    .replace("#include <map_fragment>", `#include <map_fragment>\n${HATCH_FRAGMENT}`);
}

/** DEFAULT (R4-C): below this luminance distance a material's colour is the neutral fallback grey (as the toon look's test). */
const FALLBACK_EPS = 0.004;
/** The part pass's slack on the other planes' clip test, mm: the cap point lies exactly on its own plane (DEFAULT). */
export const CAP_CLIP_TOLERANCE_MM = 0.01;
/** DEFAULT (R4-C): see-through parts under this opacity (x-ray shells) get no part cap (as the batcher's `SURFACE_OPACITY`). */
const CAP_MIN_OPACITY = 0.5;

const PART_VERTEX = /* glsl */ `
#include <common>
#include <clipping_planes_pars_vertex>
attribute vec3 instanceEmissive;
uniform vec3 uCapColor;
uniform vec3 uCapEmissive;
uniform float uCapVertexColor;
varying vec3 vCapSurface;
varying vec3 vCapView;
void main() {
  #include <begin_vertex>
  #include <project_vertex>
  #include <clipping_planes_vertex>
  vCapView = mvPosition.xyz;
  vec3 base = uCapColor;
  #ifdef USE_INSTANCING_COLOR
    base *= instanceColor;
  #endif
  #ifdef USE_COLOR
    base *= mix( vec3( 1.0 ), color.rgb, uCapVertexColor );
  #endif
  vCapSurface = base;
  // the glow: the batcher's per-instance attribute (0 where a mesh has none) or the material's, per draw
  vCapSurface += instanceEmissive + uCapEmissive;
}
`;

const PART_FRAGMENT = /* glsl */ `
#include <common>
#include <clipping_planes_pars_fragment>
uniform vec4 uCapPlane;
uniform float uCapSkip;
uniform vec3 uCapNeutral;
uniform vec3 uCapFallback;
uniform float uCapGroundL;
uniform float uCapDarken;
uniform float uCapLineShare;
uniform float uCapClipTol;
varying vec3 vCapSurface;
varying vec3 vCapView;
${HATCH_PARS}
${CAP_TONES_GLSL}
void main() {
  if ( uCapSkip > 0.5 ) discard;
  #include <clipping_planes_fragment>
  // the point of the cap on this plane along the view ray (view space; the plane is n.p + w = 0)
  vec3 dir = isOrthographic ? vec3( 0.0, 0.0, - 1.0 ) : normalize( vCapView );
  float den = dot( uCapPlane.xyz, dir );
  if ( abs( den ) < 1e-6 ) discard;
  vec3 p = vCapView - dir * ( ( dot( uCapPlane.xyz, vCapView ) + uCapPlane.w ) / den );
  // a cap point another plane removes belongs to that plane's cap, not this one's
  #if NUM_CLIPPING_PLANES > 0
  for ( int i = 0; i < NUM_CLIPPING_PLANES; i ++ ) {
    if ( dot( - p, clippingPlanes[ i ].xyz ) > clippingPlanes[ i ].w + uCapClipTol ) discard;
  }
  #endif
  vec3 world = transpose( mat3( viewMatrix ) ) * ( p - viewMatrix[ 3 ].xyz );
  vec3 surface = vCapSurface;
  // an unhinted part (the neutral fallback grey) shows the theme's lit tone, as its surface does
  if ( distance( surface, uCapFallback ) < ${FALLBACK_EPS} ) surface = uCapNeutral;
  vec3 fill;
  vec3 line;
  uhdCapTones( surface, uCapGroundL, uCapDarken, fill, line );
  gl_FragColor = vec4( mix( fill, line, uhdHatchLine( world ) * uCapLineShare ), 1.0 );
  #include <colorspace_fragment>
}
`;

/**
 * The part pass's material (see the header): back faces where the parity bit (bit 0) is set, depth-tested against the
 * scene and written (the nearest back face wins), bit 1 set where it painted. Per draw it reads the drawn object's
 * colour and glow (`onBeforeRender`); the shader takes the batcher's per-instance colour and glow and a merged mesh's
 * vertex colour itself.
 */
function partMaterial(hatch: HatchUniforms): THREE.ShaderMaterial {
  const u = {
    ...hatch,
    uCapPlane: { value: new THREE.Vector4(0, 0, 1, 0) },
    uCapColor: { value: new THREE.Color(1, 1, 1) },
    uCapEmissive: { value: new THREE.Color(0, 0, 0) },
    uCapVertexColor: { value: 0 },
    uCapSkip: { value: 0 },
    uCapNeutral: { value: new THREE.Color(DARK_CAP_SCENE.neutral) },
    uCapFallback: { value: new THREE.Color(NEUTRAL_FALLBACK) },
    uCapGroundL: { value: 0 },
    uCapDarken: { value: 0.45 },
    uCapLineShare: { value: CAP_LINE_SHARE },
    uCapClipTol: { value: CAP_CLIP_TOLERANCE_MM },
  };
  const m = new THREE.ShaderMaterial({
    name: "section-cap-part",
    uniforms: u,
    vertexShader: PART_VERTEX,
    fragmentShader: PART_FRAGMENT,
    vertexColors: true,
    clipping: true,
    side: THREE.BackSide,
    toneMapped: false,
    depthTest: true,
    depthWrite: true,
    depthFunc: THREE.LessEqualDepth,
    // the scene may have drawn the same far wall (a double-sided material): a hair in front so this pass wins it
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    stencilWrite: true,
    stencilFunc: THREE.EqualStencilFunc,
    stencilRef: 3,
    stencilFuncMask: 1,
    stencilWriteMask: 2,
    stencilFail: THREE.KeepStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilZPass: THREE.ReplaceStencilOp,
  });
  // attributes a drawn mesh may lack: white vertex colour, no glow (three binds these constants instead)
  (m as unknown as { defaultAttributeValues: Record<string, number[]> }).defaultAttributeValues = { color: [1, 1, 1], uv: [0, 0], uv1: [0, 0], instanceEmissive: [0, 0, 0] };
  m.onBeforeRender = (_renderer, _scene, _camera, _geometry, object, group) => {
    const o = object as THREE.Mesh & { isInstancedMesh?: boolean; instanceColor?: THREE.InstancedBufferAttribute | null };
    const mats = o.material;
    const mat = (Array.isArray(mats) ? mats[(group as unknown as { materialIndex?: number } | null)?.materialIndex ?? 0] : mats) as THREE.MeshStandardMaterial | undefined;
    // only solids: not lines or points, not x-ray shells, not what sections leave alone
    const skip = !o.isMesh || !!o.userData.noSection || !!o.userData.xray || (!!mat?.transparent && (mat.opacity ?? 1) < CAP_MIN_OPACITY);
    u.uCapSkip.value = skip ? 1 : 0;
    if (o.isInstancedMesh && o.instanceColor) {
      // the batcher's instances: colour and glow per instance (attributes)
      u.uCapColor.value.setRGB(1, 1, 1);
      u.uCapEmissive.value.setRGB(0, 0, 0);
    } else {
      if (mat?.color) u.uCapColor.value.copy(mat.color);
      else u.uCapColor.value.setRGB(1, 1, 1);
      const e = o.userData.emissive;
      if (typeof e === "number") u.uCapEmissive.value.setHex(e);
      else if (mat?.emissive) u.uCapEmissive.value.copy(mat.emissive).multiplyScalar(mat.emissiveIntensity ?? 1);
      else u.uCapEmissive.value.setRGB(0, 0, 0);
    }
    u.uCapVertexColor.value = mat?.vertexColors ? 1 : 0;
    m.uniformsNeedUpdate = true;
  };
  return m;
}
const _plane = new THREE.Plane();
const _normalMatrix = new THREE.Matrix3();

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
  /**
   * The theme fill: where the parity bit is set and the part pass did not paint (bit 1 clear), depth-tested, writing
   * depth; unlit, the theme's tone with the hatch. Drawn a second time with no colour over every remaining cap pixel
   * (the plane's depth), which clears both bits.
   */
  readonly fill = hatchMaterial(
    {
      color: 0x4a4640,
      side: THREE.DoubleSide,
      toneMapped: false,
      stencilWrite: true,
      stencilFunc: THREE.EqualStencilFunc,
      stencilRef: 1,
      stencilFuncMask: 3,
      stencilWriteMask: 3,
      stencilFail: THREE.KeepStencilOp,
      stencilZFail: THREE.ZeroStencilOp,
      stencilZPass: THREE.ZeroStencilOp,
    },
    this.hatch,
  );
  /** The part pass: each cap pixel in the tones of the part it cuts (R4-C). */
  readonly part = partMaterial(this.hatch);
  /** Whether caps take each part's colour (R4-C, DEFAULT on); off: every cap in the theme's tone, as before. */
  partColours = true;
  private quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.fill);
  private holder = new THREE.Scene();
  /** Last pass: planes capped, CPU ms of the pass, draw calls it made (the GPU time is the caller's to measure). */
  last = { planes: 0, ms: 0, draws: 0 };
  /** The ink was handed over by the scene (`setInk`): the luminance rule no longer picks it. */
  private inkSet = false;
  /** The background and lit tone were handed over by the scene (`setSceneTones`). */
  private sceneSet = false;
  private capHex = "#4a4640";
  private tones: CapScene = DARK_CAP_SCENE;

  constructor() {
    this.quad.frustumCulled = false;
    this.quad.matrixAutoUpdate = false;
    this.holder.add(this.quad);
    this.holder.matrixWorldAutoUpdate = false;
    this.hatch.uHatchInk.value.set(inkFor(this.capHex));
    this.applyTones();
  }

  setColor(hex: string): void {
    this.capHex = hex;
    this.fill.color.set(hex);
    if (!this.inkSet) this.hatch.uHatchInk.value.set(inkFor(hex));
    this.guessTones();
  }

  /** The hatch ink (the theme's `sectionLine`); handed over by the scene with the look. */
  setInk(hex: string): void {
    this.inkSet = true;
    this.hatch.uHatchInk.value.set(hex);
    this.guessTones();
  }

  /**
   * The scene's background and lit tone (the theme's `sceneBackground`, or the scene's own background colour, and
   * `modelToneLit`): the part tones are derived against them. Until a scene calls this, the two themes' scene tokens
   * are used, chosen by the ink (paper's dark ink: paper).
   */
  setSceneTones(tones: CapScene): void {
    this.sceneSet = true;
    this.tones = { ...tones };
    this.applyTones();
  }

  /** The tones the part caps are derived against (tests, observe). */
  sceneTones(): CapScene {
    return { ...this.tones };
  }

  private guessTones(): void {
    if (this.sceneSet) return;
    this.tones = this.inkTheme();
    this.applyTones();
  }

  /** The theme the ink belongs to: a dark ink is the paper look's. */
  private inkTheme(): CapScene {
    const ink = `#${this.hatch.uHatchInk.value.getHexString()}`;
    return contrast(ink, "#000000") < contrast(ink, "#ffffff") ? PAPER_CAP_SCENE : DARK_CAP_SCENE;
  }

  private applyTones(): void {
    const p = capSceneParams(this.tones);
    const u = this.part.uniforms;
    u.uCapGroundL.value = p.groundL;
    u.uCapDarken.value = p.darken;
    (u.uCapNeutral.value as THREE.Color).copy(p.neutral);
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
    // the draws each pass made: the counter's growth (the scene turns autoReset off), or its value when every
    // render() resets it
    let draws = 0;
    const info = renderer.info as THREE.WebGLInfo | undefined;
    const count = (pass: () => void) => {
      const before = info?.render.calls ?? 0;
      pass();
      if (info) draws += info.autoReset ? info.render.calls : info.render.calls - before;
    };
    // `globalThis.__uhdCapsPartColours = false` turns the part pass off on a live page (A/B measurement, R4-C)
    const partPass = this.partColours && (globalThis as { __uhdCapsPartColours?: boolean }).__uhdCapsPartColours !== false;
    const plane4 = this.part.uniforms.uCapPlane.value as THREE.Vector4;
    try {
      for (let i = 0; i < planes.length; i++) {
        const p = planes[i];
        renderer.clearStencil();
        count(() => drawStencil(this.stencil, p));
        hatchAcross(p.normal, this.hatch.uHatchAcross.value);
        if (partPass) {
          // the plane in view space for the shader (n.p + w = 0)
          camera.updateMatrixWorld();
          _normalMatrix.getNormalMatrix(camera.matrixWorldInverse);
          _plane.copy(p).applyMatrix4(camera.matrixWorldInverse, _normalMatrix);
          plane4.set(_plane.normal.x, _plane.normal.y, _plane.normal.z, _plane.constant);
          count(() => drawStencil(this.part, p));
        }
        // the quad lies on plane i: clipped by the others only (by itself it would sit exactly on the boundary)
        setClipping(planes.filter((_, j) => j !== i));
        this.placeQuad(p, bounds);
        // the theme fill where the part pass did not paint (bit 0 set, bit 1 clear); without the part pass, every cap
        this.fill.stencilFuncMask = partPass ? 3 : 1;
        count(() => renderer.render(this.holder, camera));
        if (partPass) {
          // the plane's depth under the part caps, both bits cleared (no colour)
          this.fill.colorWrite = false;
          this.fill.stencilFuncMask = 1;
          try {
            count(() => renderer.render(this.holder, camera));
          } finally {
            this.fill.colorWrite = true;
          }
        }
        setClipping([...planes]);
      }
    } finally {
      this.fill.stencilFuncMask = 3;
      renderer.clearStencil();
      renderer.autoClear = autoClear;
    }
    this.last = { planes: planes.length, ms: performance.now() - t0, draws };
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
    this.part.dispose();
    this.quad.geometry.dispose();
  }
}
