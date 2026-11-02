/**
 * The floor grid (moved out of scene.ts by R4-A, 2026-11-02; owned by R4-B from here on). scene.ts only calls the
 * interface below; the inside may change freely.
 *
 * R4-B (2026-11-02), Kevin: "The floor grid should be infinite but render with scale/zoom." "The floor needs a dynamic
 * grid too in mm or in." One quad on the floor plane follows the orbit target and grows with the view (it reaches
 * past where the grid has faded out, so it reads as endless); a shader (./shader.ts) draws the rungs of a spacing
 * ladder (./levels.ts: 0.1, 1, 10, 100, 1000 mm, or 1/16 in, 1 in, 1 ft) chosen per fragment from how many pixels
 * apart they fall, the finer rung fading in as you zoom in, the coarser one taking the major tone, the floor fading
 * towards the horizon, and the two world axes on the floor tinted. Colours are the theme's `sceneGrid` (major) and
 * `sceneGridMinor` tokens (dark and paper). One draw, no depth written (the ink pass would outline the lines), never
 * picked. Units: scene mm, as every other scene object (the glTF metres boundary is in scene.ts and ../scaleref).
 */
import * as THREE from "three";
import { DEFAULT_UNITS, MIN_LINE_PX, gridLevels, pxPerMmAt, type GridLevels, type Units } from "./levels";
import { GRID_LINES_GLSL, devicePxPerCss, gridUniforms, setLadder } from "./shader";

export { DEFAULT_UNITS, LADDERS, MM_PER_IN, MIN_LINE_PX, formatLength, gridLevels, pxPerMmAt, readUnits, rungAlpha, rungWeight, type GridLevels, type Units } from "./levels";
export { GRID_LINES_GLSL, gridUniforms, setLadder, devicePxPerCss, MAX_RUNGS } from "./shader";
export { mountGridLabel } from "./label";

export interface GroundGrid {
  /** The object added to the scene (one root; sections, captures and the inset hide it through `visible`). */
  readonly object: THREE.Object3D;
  visible: boolean;
  /** Theme colours (major lines, minor lines), CSS strings. */
  setColors(major: string, minor: string): void;
  /** The model's up axis changed (unit vector; +Z by default). */
  setUp(up: THREE.Vector3): void;
  /** Sit just under this box (the assembled model, scene units mm) across `up`. */
  placeUnder(box: THREE.Box3, up: THREE.Vector3): void;
  /** Called before every drawn frame (camera-following grids); return true to ask for another frame. */
  update?(camera: THREE.PerspectiveCamera, target: THREE.Vector3): boolean | void;
  dispose(): void;
  /** R4-B: the grid's units (`viewer.units`; DEFAULT mm). Setting them redraws on the next frame. */
  units: Units;
  /** R4-B: the floor's height along `up` (mm): where the scale references stand. */
  readonly floor: number;
  /** R4-B: the rungs at the orbit target as last drawn (the scale label's value); undefined before a frame. */
  levels(): GridLevels | undefined;
  /** R4-B: called when the major spacing or the units change (the scale label). Returns unsubscribe. */
  onLevels(cb: (l: GridLevels) => void): () => void;
}

/** DEFAULT (R4-B): the quad reaches this many times the larger of the camera's distance to the target and its height. */
export const GRID_REACH = 12;
/** DEFAULT (R4-B): the floor fades from this share of the quad's radius to its edge. */
export const GRID_FADE_FROM = 0.45;
/**
 * DEFAULT (R4-B): the line colours are the theme's tokens pushed this many times as far from the scene's background
 * (in sRGB). The tokens were tuned for the old fixed 600 mm GridHelper; at 1x the endless grid's lines nearly vanished
 * on both grounds (dark #2a2a2a on #131313, paper #e0e0dc on #fbfbfa).
 */
export const GRID_CONTRAST = 2;
/** The token colour pushed `k` times as far from `bg` (sRGB, clamped). */
export function awayFrom(token: THREE.Color, bg: THREE.Color, k = GRID_CONTRAST, out = new THREE.Color()): THREE.Color {
  const t = token.getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);
  const b = bg.getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);
  const c = (x: number, y: number) => Math.min(1, Math.max(0, y + (x - y) * k));
  return out.setRGB(c(t.r, b.r), c(t.g, b.g), c(t.b, b.b), THREE.SRGBColorSpace);
}

/** DEFAULT (R4-B): the floor's world-axis tints, mixed into the major line colour (x red, y green, z blue). */
export const AXIS_TINTS = { x: "#e5484d", y: "#30a46c", z: "#3e63dd", mix: 0.6 } as const;

const VERTEX = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;
${GRID_LINES_GLSL}
uniform vec3 uMajor;
uniform vec3 uMinor;
uniform vec3 uTintU;
uniform vec3 uTintV;
uniform vec3 uOrigin;
uniform vec3 uAxisU;
uniform vec3 uAxisV;
uniform vec3 uCentre;
uniform float uRadius;
uniform float uFadeFrom;
varying vec3 vWorld;
void main() {
  vec3 p = vWorld - uOrigin;
  vec2 c = vec2(dot(p, uAxisU), dot(p, uAxisV));
  vec2 g = gridLines(c, 1e9);
  vec3 col = mix(uMinor, uMajor, g.y);
  float a = g.x;
  // the world axes on the floor: v = 0 is the U axis, u = 0 the V axis (1.5 px)
  vec2 fw = max(fwidth(c), vec2(1e-6));
  float au = clamp(0.75 * uDpr + 0.5 - abs(c.y) / fw.y, 0.0, 1.0);
  float av = clamp(0.75 * uDpr + 0.5 - abs(c.x) / fw.x, 0.0, 1.0);
  col = mix(col, uTintU, au);
  a = max(a, au);
  col = mix(col, uTintV, av);
  a = max(a, av);
  float fade = 1.0 - smoothstep(uFadeFrom, 1.0, length(vWorld - uCentre) / uRadius);
  a *= fade;
  if (a < 0.003) discard;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** The two world axes lying in the floor across `up`, and their tint keys (the axis most along up is left out). */
export function floorAxes(up: THREE.Vector3): { u: THREE.Vector3; v: THREE.Vector3; keys: ["x" | "y" | "z", "x" | "y" | "z"] } {
  const a = [Math.abs(up.x), Math.abs(up.y), Math.abs(up.z)];
  const n = a[2] >= a[0] && a[2] >= a[1] ? 2 : a[1] >= a[0] ? 1 : 0;
  const names = ["x", "y", "z"] as const;
  const [i, j] = n === 2 ? [0, 1] : n === 1 ? [0, 2] : [1, 2];
  const axis = (k: number) => new THREE.Vector3().setComponent(k, 1);
  // each made exactly perpendicular to up (an up a little off an axis still gets a flat floor frame)
  const u = axis(i).sub(up.clone().multiplyScalar(up.getComponent(i))).normalize();
  const v = new THREE.Vector3().crossVectors(up, u).normalize();
  return { u, v, keys: [names[i], names[j]] };
}

/** The lowest point of `box` along `up` (mm). */
export function lowAlong(box: THREE.Box3, up: THREE.Vector3): number {
  let low = Infinity;
  for (let i = 0; i < 8; i++) low = Math.min(low, (i & 1 ? box.max.x : box.min.x) * up.x + (i & 2 ? box.max.y : box.min.y) * up.y + (i & 4 ? box.max.z : box.min.z) * up.z);
  return low;
}

export function createGroundGrid(): GroundGrid {
  const holder = new THREE.Group();
  holder.name = "ground-grid";
  holder.userData.groundGrid = true;
  let units: Units = DEFAULT_UNITS;
  const up = new THREE.Vector3(0, 0, 1);
  /** The floor's height along up: half a millimetre under the model's lowest point (as the old GridHelper). */
  let floor = -0.5;
  const major = new THREE.Color(0x3a3a3a);
  const minor = new THREE.Color(0x262626);
  const uniforms = {
    ...gridUniforms(units),
    uMajor: { value: major.clone() },
    uMinor: { value: minor.clone() },
    uTintU: { value: new THREE.Color() },
    uTintV: { value: new THREE.Color() },
    uOrigin: { value: new THREE.Vector3(0, 0, floor) },
    uAxisU: { value: new THREE.Vector3(1, 0, 0) },
    uAxisV: { value: new THREE.Vector3(0, 1, 0) },
    uCentre: { value: new THREE.Vector3() },
    uRadius: { value: 1000 },
    uFadeFrom: { value: GRID_FADE_FROM },
  };
  let tintKeys: ["x" | "y" | "z", "x" | "y" | "z"] = ["x", "y"];
  /** The scene's background the line colours were pushed away from (read at draw time). */
  const ground = new THREE.Color(0x131313);
  const tints = () => {
    awayFrom(major, ground, GRID_CONTRAST, uniforms.uMajor.value);
    awayFrom(minor, ground, GRID_CONTRAST, uniforms.uMinor.value);
    uniforms.uTintU.value.copy(uniforms.uMajor.value).lerp(new THREE.Color(AXIS_TINTS[tintKeys[0]]), AXIS_TINTS.mix);
    uniforms.uTintV.value.copy(uniforms.uMajor.value).lerp(new THREE.Color(AXIS_TINTS[tintKeys[1]]), AXIS_TINTS.mix);
  };
  tints();
  const material = new THREE.ShaderMaterial({
    name: "ground-grid",
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const geometry = new THREE.PlaneGeometry(2, 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "ground-grid-plane";
  // the quad moves in update(); culling would judge it where it was
  mesh.frustumCulled = false;
  // first among the see-through things (x-ray shells draw over it)
  mesh.renderOrder = -1;
  // drawn as itself (a ShaderMaterial is not batched anyway), never picked
  mesh.userData.noBatch = true;
  mesh.raycast = () => undefined;
  holder.add(mesh);

  const target = new THREE.Vector3();
  let haveTarget = false;
  let last: GridLevels | undefined;
  const subs = new Set<(l: GridLevels) => void>();
  let pending = false;
  const notify = () => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      if (!last) return;
      for (const cb of subs) {
        try {
          cb(last);
        } catch (e) {
          console.warn("[cad] grid label subscriber failed:", e);
        }
      }
    });
  };
  // the pixel ratio of what is drawn into (canvas or a smaller target) and the label, at draw time
  mesh.onBeforeRender = (renderer, scene, camera) => {
    const bg = (scene as THREE.Scene).background as THREE.Color | null;
    if (bg && (bg as THREE.Color).isColor && !bg.equals(ground)) {
      ground.copy(bg);
      tints();
    }
    const dpr = devicePxPerCss(renderer);
    uniforms.uDpr.value = dpr;
    uniforms.uMinPx.value = MIN_LINE_PX * dpr;
    const cam = camera as THREE.PerspectiveCamera;
    if (!haveTarget || !cam.isPerspectiveCamera) return;
    const l = gridLevels(pxPerMmAt(cam.position.distanceTo(target), cam.fov, renderer.domElement.clientHeight || 1), units);
    const changed = !last || last.majorMm !== l.majorMm || last.units !== l.units || last.minorMm !== l.minorMm;
    last = l;
    if (changed) notify();
  };

  const centre = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const setFrame = () => {
    const axes = floorAxes(up);
    uniforms.uAxisU.value.copy(axes.u);
    uniforms.uAxisV.value.copy(axes.v);
    tintKeys = axes.keys;
    tints();
    uniforms.uOrigin.value.copy(up).multiplyScalar(floor);
    // the quad's local +z along up, its local x along the floor's u axis
    const m = new THREE.Matrix4().makeBasis(axes.u, axes.v, up);
    quat.setFromRotationMatrix(m);
  };
  setFrame();

  return {
    object: holder,
    get visible() {
      return holder.visible;
    },
    set visible(v: boolean) {
      if (holder.visible === v) return;
      holder.visible = v;
      // the scale label hides and shows with the grid
      notify();
    },
    get units() {
      return units;
    },
    set units(u: Units) {
      if (u === units) return;
      units = u;
      setLadder(uniforms, u);
      last = undefined;
    },
    get floor() {
      return floor;
    },
    levels: () => last,
    onLevels(cb) {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    setColors(maj, min) {
      major.set(maj);
      minor.set(min);
      tints();
    },
    setUp(u) {
      up.copy(u).normalize();
      floor = -0.5;
      setFrame();
    },
    placeUnder(box, u) {
      if (box.isEmpty()) return;
      up.copy(u).normalize();
      // the lowest point of the box along up, half a millimetre below it
      floor = lowAlong(box, up) - 0.5;
      setFrame();
    },
    update(camera, t) {
      target.copy(t);
      haveTarget = true;
      // under the orbit target, on the floor
      centre.copy(t).addScaledVector(up, floor - t.dot(up));
      const d = camera.position.distanceTo(t);
      const h = Math.abs(camera.position.dot(up) - floor);
      const far = camera.far > 0 ? camera.far : 1e6;
      // DEFAULT (R4-B): at least 10 mm across, at most 95 % of the far plane
      const r = Math.max(10, Math.min(0.95 * far, GRID_REACH * Math.max(d, h)));
      mesh.position.copy(centre);
      mesh.quaternion.copy(quat);
      mesh.scale.set(r, r, 1);
      mesh.updateMatrix();
      mesh.updateMatrixWorld(true);
      uniforms.uCentre.value.copy(centre);
      uniforms.uRadius.value = r;
      return false;
    },
    dispose() {
      subs.clear();
      holder.remove(mesh);
      geometry.dispose();
      material.dispose();
    },
  };
}

/** The floor grid of a scene, by its marker (CadView, ModelView and the artifact capture hide it). */
export function findGroundGrid(scene: THREE.Object3D): THREE.Object3D | undefined {
  return scene.children.find((o) => o.userData.groundGrid === true);
}
