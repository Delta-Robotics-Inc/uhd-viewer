/**
 * The model's look (PB-1189, docs/style-guide.md): matte cel bands and restrained ink.
 *
 * **Bands.** Every lit surface the 3D view draws through MeshStandardMaterial (the batcher's shared instanced
 * materials and the meshes drawn as themselves) is shaded by one key light fixed to the camera: the cosine
 * between the view-space normal and the key picks one of three bands, and the surface's own colour (the
 * per-instance colour, a map) is scaled by that band's factor. No specular, no environment, no tone mapping:
 * the tones on screen are the theme's tones. A body with no colour of its own (the neutral fallback grey that
 * `materialFor` gives an unhinted part) takes the theme's lit tone instead, so on paper it reads as paper.
 * Highlight (per-instance emissive) is added on top, so selection keeps working.
 *
 * **Ink.** One screen-space pass over the depth buffer (scene.ts's output pass): where the reciprocal of view
 * depth bends (a second difference across the pixel) there is a fold or a step. A large, convex bend is a
 * silhouette or depth step, drawn in `inkSilhouette`; a small one is a crease, drawn in `inkCrease`. The
 * reciprocal of depth is affine across any plane in screen space, so flat faces never ink, at any angle. Lines
 * are one pixel at the ink width, constant on screen. The quality curve switches the pass off while the view
 * moves when frames run over budget (registered as an effect, `edges`).
 *
 * Nothing here uses the `postprocessing` package; three r187 only.
 */
import * as THREE from "three";
import { luminance, parseHex } from "../../theme/contrast";

/** The theme's tokens the scene reads (hex colours, CSS px lengths). */
export interface SceneLook {
  /** Band factors [shade, mid, lit] (lit is 1). */
  bands: [number, number, number];
  /** The lit tone: what a neutral body shows in the lit band. */
  neutral: string;
  silhouette: string;
  crease: string;
  /** Ink width in CSS px. */
  inkWidth: number;
  cap: string;
  capLine: string;
}

/** Token names read for the look (`readSceneLook`'s lookup is called with these). */
export const LOOK_TOKENS = ["modelToneLit", "modelToneMid", "modelToneShade", "inkSilhouette", "inkCrease", "inkWidth", "sectionCap", "sectionLine"] as const;
export type LookToken = (typeof LOOK_TOKENS)[number];

/** DEFAULT look before a theme is read: the anatomy dark set. */
export const DEFAULT_LOOK: SceneLook = { bands: [0.35, 0.56, 1], neutral: "#333333", silhouette: "#d4d4d4", crease: "#6a6a6a", inkWidth: 1, cap: "#4a4640", capLine: "#d4d4d4" };

/** Band factors from the three tone tokens: each band's relative luminance over the lit band's (linear light). */
export function bandFactors(t: { lit: string; mid: string; shade: string }): [number, number, number] {
  const l = (h: string) => {
    const c = parseHex(h);
    return c ? luminance(c) : undefined;
  };
  const lit = l(t.lit);
  const mid = l(t.mid);
  const shade = l(t.shade);
  if (!lit || mid === undefined || shade === undefined) return [...DEFAULT_LOOK.bands];
  const f = (v: number) => Math.round(Math.min(1, v / lit) * 1000) / 1000;
  return [f(shade), f(mid), 1];
}

/** The look from a token lookup (CadView/ModelView's element, or a token table in tests); missing tokens fall back. */
export function readSceneLook(get: (token: LookToken) => string | undefined): SceneLook {
  const hex = (t: LookToken, d: string) => {
    const v = get(t)?.trim();
    return v && parseHex(v) ? v : d;
  };
  const px = (t: LookToken, d: number) => {
    const m = /^(\d+(?:\.\d+)?)px$/.exec(get(t)?.trim() ?? "");
    return m ? Math.min(4, Math.max(0.5, Number(m[1]))) : d;
  };
  const lit = hex("modelToneLit", DEFAULT_LOOK.neutral);
  return {
    bands: bandFactors({ lit, mid: hex("modelToneMid", "#262626"), shade: hex("modelToneShade", "#1c1c1c") }),
    neutral: lit,
    silhouette: hex("inkSilhouette", DEFAULT_LOOK.silhouette),
    crease: hex("inkCrease", DEFAULT_LOOK.crease),
    inkWidth: px("inkWidth", DEFAULT_LOOK.inkWidth),
    cap: hex("sectionCap", DEFAULT_LOOK.cap),
    capLine: hex("sectionLine", DEFAULT_LOOK.capLine),
  };
}

/** The neutral fallback colour `materialFor` gives a part with nothing to say about its colour (scene.ts). */
export const NEUTRAL_FALLBACK = "#8b8b8b";

/**
 * The key light, in view space (camera-attached): up-left and toward the viewer, so the tops and the faces turned
 * to the left read lit, the side walls mid, the undersides shaded, whichever way the model is turned. DEFAULT.
 */
export const TOON_KEY = new THREE.Vector3(-0.35, 0.75, 0.56).normalize();
/** Cosine thresholds between the bands [shade|mid, mid|lit] (DEFAULT, look-tested on the drone and ClientX). */
export const TOON_EDGES = new THREE.Vector2(0.0, 0.45);

/** Uniforms one scene's toon materials share (a theme change writes them; no recompile). */
export interface ToonUniforms {
  uToonKey: { value: THREE.Vector3 };
  uToonEdges: { value: THREE.Vector2 };
  uToonBands: { value: THREE.Vector3 };
  uToonNeutral: { value: THREE.Color };
  uToonFallback: { value: THREE.Color };
}

export function toonUniforms(): ToonUniforms {
  return {
    uToonKey: { value: TOON_KEY.clone() },
    uToonEdges: { value: TOON_EDGES.clone() },
    uToonBands: { value: new THREE.Vector3(...DEFAULT_LOOK.bands) },
    uToonNeutral: { value: new THREE.Color(DEFAULT_LOOK.neutral) },
    uToonFallback: { value: new THREE.Color(NEUTRAL_FALLBACK) },
  };
}

/** Write a look into the uniforms (colours are converted to linear, as three's colour management does). */
export function applyLookToUniforms(u: ToonUniforms, look: SceneLook): void {
  u.uToonBands.value.set(...look.bands);
  u.uToonNeutral.value.set(look.neutral);
}

/**
 * Patch a standard-material shader (in `onBeforeCompile`) with the toon bands, active under the `UHD_TOON`
 * define. Idempotent per shader. The bands replace the lit colour just before the output; the emissive (a
 * highlight) is added back on top.
 */
export function patchToon(shader: THREE.WebGLProgramParametersWithUniforms, u: ToonUniforms): void {
  Object.assign(shader.uniforms, u);
  if (shader.fragmentShader.includes("uToonBands")) return;
  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <common>",
      `#include <common>
#ifdef UHD_TOON
uniform vec3 uToonKey;
uniform vec2 uToonEdges;
uniform vec3 uToonBands;
uniform vec3 uToonNeutral;
uniform vec3 uToonFallback;
#endif`,
    )
    .replace(
      "#include <opaque_fragment>",
      `#ifdef UHD_TOON
{
  float k = dot( normalize( normal ), uToonKey );
  float band = k > uToonEdges.y ? uToonBands.z : ( k > uToonEdges.x ? uToonBands.y : uToonBands.x );
  vec3 base = diffuseColor.rgb;
  // an unhinted part (the neutral fallback grey) takes the theme's lit tone
  if ( distance( base, uToonFallback ) < 0.004 ) base = uToonNeutral;
  outgoingLight = base * band + totalEmissiveRadiance;
}
#endif
#include <opaque_fragment>`,
    );
}

/** Kinds of material the toon patch understands (it needs `normal`, `diffuseColor` and `totalEmissiveRadiance`). */
export function toonable(m: THREE.Material | THREE.Material[] | undefined): m is THREE.MeshStandardMaterial {
  if (!m || Array.isArray(m)) return false;
  const t = (m as THREE.MeshStandardMaterial).type;
  return t === "MeshStandardMaterial" || t === "MeshPhysicalMaterial";
}

/**
 * The toon twins of materials drawn as themselves (one scene's): a clone of the material with the patch, kept in
 * step with the original's colour, opacity and state each time it is fetched (a cable fading as the model comes
 * apart changes its material every frame). The batcher's shared materials carry the patch themselves.
 */
export class ToonTwins {
  private twins = new WeakMap<THREE.Material, Map<string, THREE.MeshStandardMaterial>>();
  /** Every twin made, so `dispose` can give their GPU programs back (W4-D, wave 3 carry-forward). */
  private made = new Set<THREE.MeshStandardMaterial>();
  constructor(private u: ToonUniforms) {}

  /** Disposes every twin made (the scene is going away); `of` makes new ones if called again. */
  dispose(): void {
    for (const t of this.made) t.dispose();
    this.made.clear();
    this.twins = new WeakMap();
  }

  /**
   * The twin of `m` for a state, up to date with it: `toon` (the bands) and `clip` (the section planes of a scoped
   * section, ../sections: a mesh under the scope is clipped by its material, not by the renderer).
   */
  of(m: THREE.MeshStandardMaterial, state: { toon: boolean; clip?: THREE.Plane[] | null } = { toon: true }): THREE.MeshStandardMaterial {
    const key = `${state.toon ? 1 : 0}|${state.clip ? 1 : 0}`;
    let byKey = this.twins.get(m);
    if (!byKey) this.twins.set(m, (byKey = new Map()));
    let t = byKey.get(key);
    if (!t) {
      t = m.clone();
      t.name = `${m.name || m.type}:${state.toon ? "toon" : "lit"}${state.clip ? ":clip" : ""}`;
      if (state.toon) {
        t.defines = { ...(t.defines ?? {}), UHD_TOON: "" };
        t.toneMapped = false;
        const prior = m.onBeforeCompile;
        const u = this.u;
        t.onBeforeCompile = (shader, renderer) => {
          prior.call(m, shader, renderer);
          patchToon(shader, u);
        };
        const priorKey = m.customProgramCacheKey.bind(m);
        t.customProgramCacheKey = () => `${priorKey()}|uhd-toon`;
      }
      t.userData = { ...t.userData, twinOf: m.uuid };
      byKey.set(key, t);
      this.made.add(t);
    }
    // what changes at run time on these materials: colour and glow, fades, the section view's side
    t.color.copy(m.color);
    t.emissive.copy(m.emissive);
    t.emissiveIntensity = m.emissiveIntensity;
    t.opacity = m.opacity;
    t.visible = m.visible;
    // a see-through part at half opacity or more is a surface for the ink (as the batcher's looks, DEFAULT)
    t.depthWrite = m.depthWrite || (m.transparent && m.opacity >= 0.5);
    t.depthTest = m.depthTest;
    const clip = state.clip ?? m.clippingPlanes;
    if ((t.clippingPlanes?.length ?? 0) !== (clip?.length ?? 0)) t.needsUpdate = true;
    t.clippingPlanes = clip;
    if (t.transparent !== m.transparent || t.side !== m.side || t.wireframe !== m.wireframe) {
      t.transparent = m.transparent;
      t.side = m.side;
      t.wireframe = m.wireframe;
      t.needsUpdate = true;
    }
    return t;
  }
}

// ---------------------------------------------------------------------------
// Ink: the screen-space edge pass (inside scene.ts's output pass)
// ---------------------------------------------------------------------------

/**
 * Edge thresholds on the relative second difference of 1/depth across a pixel (DEFAULT, look-tested on the
 * drone and ClientX at 1440x900): above `silhouette` (and convex) the pixel takes the silhouette ink; above
 * `crease`, the crease ink.
 */
export const EDGE_THRESHOLDS = { silhouette: 0.02, crease: 0.0006 };

/** GLSL for the output pass: `inkAt(uv)` returns the ink colour (rgb) and its coverage (a). */
export const EDGE_GLSL = /* glsl */ `
uniform sampler2D tDepth;
uniform vec2 texel;
uniform float inkWidth;
uniform float cameraNear;
uniform float cameraFar;
uniform vec3 inkSilhouette;
uniform vec3 inkCrease;
uniform vec2 edgeThresholds;
// 1/z (view depth), affine across any plane in screen space; 0 for the far plane (nothing drawn)
float invZ( vec2 uv ) {
  float d = texture2D( tDepth, uv ).x;
  if ( d >= 1.0 ) return 0.0;
  return ( cameraFar - d * ( cameraFar - cameraNear ) ) / ( cameraNear * cameraFar );
}
vec4 inkAt( vec2 uv ) {
  vec2 o = texel * inkWidth;
  float c = invZ( uv );
  float l = invZ( uv - vec2( o.x, 0.0 ) );
  float r = invZ( uv + vec2( o.x, 0.0 ) );
  float d = invZ( uv - vec2( 0.0, o.y ) );
  float u = invZ( uv + vec2( 0.0, o.y ) );
  if ( c <= 0.0 ) return vec4( 0.0 );
  // the near side of a step only (convex: the centre is nearer than the line through its neighbours)
  float lh = ( l + r - 2.0 * c ) / c;
  float lv = ( d + u - 2.0 * c ) / c;
  float convex = min( lh, lv );
  float bend = max( abs( lh ), abs( lv ) );
  // a neighbour on the background: this pixel is on the outline
  if ( l <= 0.0 || r <= 0.0 || d <= 0.0 || u <= 0.0 ) return vec4( inkSilhouette, 1.0 );
  if ( -convex > edgeThresholds.x ) return vec4( inkSilhouette, 1.0 );
  if ( bend > edgeThresholds.y ) return vec4( inkCrease, smoothstep( edgeThresholds.y, edgeThresholds.y * 2.0, bend ) );
  return vec4( 0.0 );
}
`;
