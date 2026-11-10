/**
 * Toolpath geometry for the G-code tab (PB-1192): ONE instanced draw for every
 * extrusion, and a second only for travel moves when they are shown.
 *
 * Each segment is an instance of one small template (a four-sided prism: 8
 * shared corners, 8 triangles: top, bottom and both sides; the ends overlap
 * the next bead; flat face normals come from screen-space derivatives in the
 * fragment shader, so no corner is duplicated per face). Its
 * vertex shader places the template between the segment's start and end,
 * `width` across and `height` down from the nozzle, from per-instance
 * attributes that are the parser's column arrays as they are (no copy):
 * start xyz, end xyz, feature index, layer index, width and height in
 * 0.01 mm. Colour comes from a 16-entry palette uniform by feature index.
 *
 * Nothing is rebuilt when the view changes. The parser keeps segments in file
 * order, so a layer range is one contiguous window of instances: the draw's
 * attributes start at the window's first segment and its instance count is
 * the window's length (`setWindow`), so layers outside the range cost
 * nothing. Two uniforms hold the range as well (the shader also hides by
 * layer, a guard). Feature toggles are a
 * 16-entry on/off uniform. Layers under the top one draw dimmed. This is the
 * "static data on the GPU, change only what is visible" design the slicers
 * use (R1 slicers-orca-bambu.md §2.6), described there in our own words and
 * written here from scratch.
 *
 * Units and frame: millimetres, Z up, as the parser gives them and as the
 * CAD scene draws (scene.ts is mm and Z-up); nothing converts.
 */
import * as THREE from "three";
import { FEATURE_COUNT, GCODE_FEATURES } from "./features";
import type { GcodeModel, SegmentColumns } from "./parser";

const VERTEX = /* glsl */ `
attribute vec3 iStart;
attribute vec3 iEnd;
attribute float iFeature;
// a Uint32 attribute is bound as an integer input in WebGL2 (vertexAttribIPointer), so it is declared uint
attribute uint iLayer;
attribute float iWidth;
attribute float iHeight;
uniform vec3 uPalette[${FEATURE_COUNT}];
uniform float uOn[${FEATURE_COUNT}];
uniform float uLayerMin;
uniform float uLayerMax;
uniform float uDim;
uniform float uTravel;
uniform float uTravelWidth;
uniform vec3 uTravelColor;
varying vec3 vColor;
varying vec3 vView;
void main() {
  int f = int(iFeature + 0.5);
  float layer = float(iLayer);
  float on = uTravel > 0.5 ? 1.0 : uOn[f];
  if (on < 0.5 || layer < uLayerMin - 0.5 || layer > uLayerMax + 0.5) {
    // hidden: every vertex of the instance outside the clip volume (nothing rasterised)
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vColor = vec3(0.0);
    vView = vec3(0.0);
    return;
  }
  vec3 d = iEnd - iStart;
  float len = length(d);
  vec3 t = len > 1e-6 ? d / len : vec3(1.0, 0.0, 0.0);
  // a right-handed frame (along, across, up), so the template's winding stays front-facing
  vec3 side = cross(vec3(0.0, 0.0, 1.0), t);
  float sl = length(side);
  side = sl > 1e-4 ? side / sl : vec3(0.0, 1.0, 0.0);
  vec3 up = cross(t, side);
  float w = uTravel > 0.5 ? uTravelWidth : max(iWidth * 0.01, 0.05);
  float h = uTravel > 0.5 ? uTravelWidth : max(iHeight * 0.01, 0.05);
  // template: x 0..1 along (stretched half a width past each end), y -0.5..0.5 across, z -1..0 down from the nozzle
  vec3 p = iStart + t * (position.x * (len + w) - 0.5 * w) + side * (position.y * w) + up * (position.z * h);
  vec3 c = uTravel > 0.5 ? uTravelColor : uPalette[f];
  vColor = layer < uLayerMax - 0.5 ? c * uDim : c;
  vec4 view = modelViewMatrix * vec4(p, 1.0);
  vView = view.xyz;
  gl_Position = projectionMatrix * view;
}
`;

const FRAGMENT = /* glsl */ `
varying vec3 vColor;
varying vec3 vView;
void main() {
  // the face's own normal (flat), in view space, from how the position changes across the pixel
  vec3 n = normalize(cross(dFdx(vView), dFdy(vView)));
  // a key light from the upper right of the view and a weak fill: matte, readable bead shapes
  float key = max(dot(n, normalize(vec3(0.35, 0.55, 0.75))), 0.0);
  float fill = max(dot(n, normalize(vec3(-0.5, -0.2, 0.4))), 0.0);
  gl_FragColor = vec4(vColor * (0.32 + 0.6 * key + 0.18 * fill), 1.0);
  #include <colorspace_fragment>
}
`;

/** The prism template: 8 corners, 8 triangles (top, bottom, the two sides), wound counter-clockwise from outside. */
export function segmentTemplate(): { position: Float32Array; index: Uint16Array } {
  // x 0..1 along, y -0.5..0.5 across, z -1..0 down from the nozzle: corners 0-3 on top, 4-7 below them
  const position = new Float32Array([0, -0.5, 0, 1, -0.5, 0, 1, 0.5, 0, 0, 0.5, 0, 0, -0.5, -1, 1, -0.5, -1, 1, 0.5, -1, 0, 0.5, -1]);
  const index = new Uint16Array([
    0, 1, 2, 0, 2, 3, // top
    7, 6, 5, 7, 5, 4, // bottom
    3, 2, 6, 3, 6, 7, // side +y
    4, 5, 1, 4, 1, 0, // side -y
  ]);
  return { position, index };
}

/** Shader attribute, parser column, components per segment. */
const COLUMNS = [
  ["iStart", "start", 3],
  ["iEnd", "end", 3],
  ["iFeature", "feature", 1],
  ["iLayer", "layer", 1],
  ["iWidth", "width", 1],
  ["iHeight", "height", 1],
] as const;

function instancedGeometry(c: SegmentColumns, template = segmentTemplate()): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.setIndex(new THREE.BufferAttribute(template.index, 1));
  g.setAttribute("position", new THREE.BufferAttribute(template.position, 3));
  const n = c.count;
  // the parser's arrays, as they are (views of the used rows; the GPU upload reads exactly these), each as an
  // instanced buffer read through an attribute whose offset can move: see setWindow
  for (const [name, key, size] of COLUMNS) {
    const buffer = new THREE.InstancedInterleavedBuffer(c[key].subarray(0, n * size), size, 1);
    g.setAttribute(name, new THREE.InterleavedBufferAttribute(buffer, size, 0));
  }
  g.instanceCount = n;
  return g;
}

/**
 * Draw only segments [first, end): a base instance without the extension. Each attribute is swapped for one over
 * the SAME buffer with its start moved by `first` rows (three binds the new offset; the buffer is not uploaded
 * again, it is keyed by its data), and the instance count is the window's length. Layers below the range then
 * cost nothing, not even the vertex shader (measured: progress.md W4-B).
 */
export function setWindow(g: THREE.InstancedBufferGeometry, first: number, end: number): void {
  for (const [name, , size] of COLUMNS) {
    const a = g.getAttribute(name) as THREE.InterleavedBufferAttribute;
    if (a.offset !== first * size) g.setAttribute(name, new THREE.InterleavedBufferAttribute(a.data, size, first * size));
  }
  g.instanceCount = Math.max(0, end - first);
}

export interface GcodeDrawOptions {
  /** Feature colours (16, by index); default the DEFAULT palette in features.ts. */
  palette?: string[];
  travelColor?: string;
  /** Travel lines' thickness (mm). DEFAULT 0.08. */
  travelWidth?: number;
  /** Brightness of layers under the top one (1 = not dimmed). DEFAULT 0.72. */
  dim?: number;
}

export interface GcodeDraw {
  /** Add this to a scene. */
  group: THREE.Group;
  extrusion: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  /** Built on first `setTravelVisible(true)`; null until then (or when the file has no travel). */
  travel: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial> | null;
  /** Show layers lo..hi (inclusive, layer indices). */
  setLayerRange: (lo: number, hi: number) => void;
  /** Per feature index: drawn or not (index 0, travel, is `setTravelVisible`). */
  setFeatureVisible: (on: readonly boolean[]) => void;
  setTravelVisible: (on: boolean) => void;
  setPalette: (colors: readonly string[], travel?: string) => void;
  setDim: (factor: number) => void;
  /** Draw calls a frame costs now: 1, or 2 with travel shown (0 when nothing is in range). */
  drawCalls: () => number;
  /** Instances submitted per draw now (the segments of the layer range, nothing else). */
  instances: () => { extrusion: number; travel: number };
  dispose: () => void;
}

function material(palette: readonly string[], travel: boolean, opts: Required<GcodeDrawOptions>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: {
      uPalette: { value: palette.map((c) => new THREE.Color(c)) },
      uOn: { value: new Array(FEATURE_COUNT).fill(1) },
      uLayerMin: { value: 0 },
      uLayerMax: { value: 1e9 },
      uDim: { value: opts.dim },
      uTravel: { value: travel ? 1 : 0 },
      uTravelWidth: { value: opts.travelWidth },
      uTravelColor: { value: new THREE.Color(opts.travelColor) },
    },
    toneMapped: false,
  });
}

/** The draws for a parsed file. Nothing here needs a GL context: it can be built (and tested) before a renderer exists. */
export function buildGcodeDraw(model: GcodeModel, options: GcodeDrawOptions = {}): GcodeDraw {
  const opts: Required<GcodeDrawOptions> = {
    palette: options.palette ?? GCODE_FEATURES.map((f) => f.color),
    travelColor: options.travelColor ?? GCODE_FEATURES[0].color,
    travelWidth: options.travelWidth ?? 0.08,
    dim: options.dim ?? 0.72,
  };
  const template = segmentTemplate();
  const group = new THREE.Group();
  group.name = "gcode";
  const make = (c: SegmentColumns, travel: boolean) => {
    const mesh = new THREE.Mesh(instancedGeometry(c, template), material(opts.palette, travel, opts));
    mesh.name = travel ? "gcode-travel" : "gcode-extrusion";
    // the template's own bounds say nothing about where the instances are
    mesh.frustumCulled = false;
    // the CAD scene's batcher, merger and toon pass leave it alone (render/batch.ts, quality/merge.ts)
    mesh.userData.noBatch = true;
    mesh.userData.gcode = true;
    return mesh;
  };
  const extrusion = make(model.extrude, false);
  group.add(extrusion);
  let travel: GcodeDraw["travel"] = null;
  let travelOn = false;
  let lo = 0;
  let hi = Math.max(0, model.layers.count - 1);
  const L = model.layers;

  /** The window of segments the layer range covers in one store (file order: layers are contiguous). */
  const span = (first: Uint32Array, end: Uint32Array, count: number): [number, number] => {
    if (!L.count) return [0, count];
    const a = Math.min(lo, L.count - 1);
    const b = Math.min(hi, L.count - 1);
    return [first[a], Math.max(first[a], end[b])];
  };
  const cut = () => {
    const [ef, ee] = span(L.extrudeFirst, L.extrudeEnd, model.extrude.count);
    setWindow(extrusion.geometry, ef, ee);
    extrusion.visible = ee > ef;
    if (travel) {
      const [tf, te] = span(L.travelFirst, L.travelEnd, model.travel.count);
      setWindow(travel.geometry, tf, te);
      travel.visible = travelOn && te > tf;
    }
  };
  const each = (fn: (m: THREE.ShaderMaterial) => void) => {
    fn(extrusion.material);
    if (travel) fn(travel.material);
  };

  const draw: GcodeDraw = {
    group,
    extrusion,
    get travel() {
      return travel;
    },
    setLayerRange(a, b) {
      lo = Math.max(0, Math.min(a, b));
      hi = Math.max(a, b);
      each((m) => {
        m.uniforms.uLayerMin.value = lo;
        m.uniforms.uLayerMax.value = hi;
      });
      cut();
    },
    setFeatureVisible(on) {
      const v = extrusion.material.uniforms.uOn.value as number[];
      for (let i = 0; i < FEATURE_COUNT; i++) v[i] = on[i] === false ? 0 : 1;
    },
    setTravelVisible(on) {
      travelOn = on;
      if (on && !travel && model.travel.count) {
        travel = make(model.travel, true);
        travel.material.uniforms.uLayerMin.value = lo;
        travel.material.uniforms.uLayerMax.value = hi;
        travel.material.uniforms.uDim.value = extrusion.material.uniforms.uDim.value;
        group.add(travel);
      }
      cut();
    },
    setPalette(colors, travelColor) {
      const p = extrusion.material.uniforms.uPalette.value as THREE.Color[];
      colors.forEach((c, i) => p[i]?.set(c));
      if (travelColor) each((m) => (m.uniforms.uTravelColor.value as THREE.Color).set(travelColor));
    },
    setDim(factor) {
      each((m) => (m.uniforms.uDim.value = factor));
    },
    drawCalls() {
      return (extrusion.visible && extrusion.geometry.instanceCount > 0 ? 1 : 0) + (travel && travel.visible && travel.geometry.instanceCount > 0 ? 1 : 0);
    },
    instances() {
      return { extrusion: extrusion.visible ? extrusion.geometry.instanceCount : 0, travel: travel?.visible ? travel.geometry.instanceCount : 0 };
    },
    dispose() {
      extrusion.geometry.dispose();
      extrusion.material.dispose();
      travel?.geometry.dispose();
      travel?.material.dispose();
      group.clear();
    },
  };
  cut();
  return draw;
}
