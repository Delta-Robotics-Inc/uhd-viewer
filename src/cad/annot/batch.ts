/**
 * Instanced draws for the annotation layer's dots, DRC markers and stems (R2-C, wave R1 gate: "16 pin markers cost
 * 48 draws"). Before R2 every terminal dot and marker was a live and a ghost `THREE.Sprite` and every stem its own
 * quad: 5 draws a marker, 80 on ClientX's opening view. Now:
 *
 * - `GlyphAtlas`: one small canvas texture holding every dot and severity glyph in use (colour and count badge baked
 *   in, as the sprites' own textures were), a cell per distinct picture;
 * - `QuadBatch`: all camera-facing quads (callout dots, terminal dots, marker glyphs) as one instanced draw with
 *   depth testing, plus a ghost copy of the same instances (30 %, no depth test) as a second draw;
 * - `StemBatch`: all marker stems as one instanced draw, depth-tested.
 *
 * Three draws whatever the number of markers. The sizes are in CSS px and turned into world units in the vertex
 * shader from the view depth (`uPerPx`), as `THREE.Sprite` with `sizeAttenuation: false` did, so a quad keeps its
 * pixel size while the camera moves without the CPU touching it.
 *
 * Why instancing also fixes the screen-filling glyph (gate R1): the meshes exist from the layer's construction and
 * never move (identity matrices); only attribute buffers change from frame to frame. A sprite added during a
 * camera-only frame never had its `matrixWorld` computed (the scene's matrices are brought up to date only on scene
 * and pose frames and `scene.matrixWorldAutoUpdate` is off): it was drawn at the origin with scale 1, which
 * `sizeAttenuation: false` multiplies by the view depth, a quad about 1.7 view heights tall.
 *
 * Units: world positions are the scene's (CAD mm, Z up); sizes are CSS px.
 */
import * as THREE from "three";

/** DEFAULT (R2-C): atlas cell size and grid (64 px cells, 8 x 8, a 512 px texture: 64 distinct pictures). */
export const ATLAS_CELL_PX = 64;
export const ATLAS_GRID = 8;

export type AtlasDraw = (ctx: CanvasRenderingContext2D, px: number) => void;

/** A texture atlas of small pictures, one cell per key; `uv` gives a cell's [u0, v0, u1, v1]. */
export class GlyphAtlas {
  readonly texture: THREE.Texture;
  private canvas: HTMLCanvasElement | undefined;
  private ctx: CanvasRenderingContext2D | null = null;
  private cells = new Map<string, number>();
  /** Times the atlas was cleared because it was full (tests, debugging). */
  resets = 0;

  constructor(
    readonly cell = ATLAS_CELL_PX,
    readonly grid = ATLAS_GRID,
  ) {
    this.canvas = typeof document !== "undefined" ? document.createElement("canvas") : undefined;
    if (this.canvas) {
      this.canvas.width = this.canvas.height = cell * grid;
      this.ctx = this.canvas.getContext?.("2d") ?? null;
    }
    const t = new THREE.CanvasTexture(this.canvas ?? (undefined as unknown as HTMLCanvasElement));
    t.colorSpace = THREE.SRGBColorSpace;
    // no mipmaps: a mip level would blend neighbouring cells; the quads are drawn near their cell's own size
    t.generateMipmaps = false;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = 1;
    this.texture = t;
  }

  get size(): number {
    return this.cells.size;
  }

  has(key: string): boolean {
    return this.cells.has(key);
  }

  /** Clears every cell (the atlas was full). Callers resolve their keys again after a reset. */
  clear(): void {
    this.cells.clear();
    this.ctx?.clearRect(0, 0, this.cell * this.grid, this.cell * this.grid);
    this.resets++;
  }

  /**
   * The cell of `key`, drawing it with `draw` the first time. When every cell is taken the atlas is cleared first
   * (`clear`), so `ensure` a frame's whole set of keys before reading any `uv` (QuadBatch.flush does).
   */
  ensure(key: string, draw: AtlasDraw): number {
    let i = this.cells.get(key);
    if (i !== undefined) return i;
    if (this.cells.size >= this.grid * this.grid) this.clear();
    i = this.cells.size;
    this.cells.set(key, i);
    const ctx = this.ctx;
    if (ctx) {
      const x = (i % this.grid) * this.cell;
      const y = Math.floor(i / this.grid) * this.cell;
      ctx.save();
      ctx.clearRect(x, y, this.cell, this.cell);
      ctx.translate(x, y);
      ctx.beginPath();
      ctx.rect(0, 0, this.cell, this.cell);
      ctx.clip();
      draw(ctx, this.cell);
      ctx.restore();
    }
    this.texture.needsUpdate = true;
    return i;
  }

  /** A cell's texture rectangle [u0, v0, u1, v1] (the canvas is uploaded flipped: its top row is v = 1). */
  uv(key: string): [number, number, number, number] {
    const i = this.cells.get(key) ?? 0;
    const c = i % this.grid;
    const r = Math.floor(i / this.grid);
    // half a texel in, so linear filtering never reads the neighbouring cell
    const e = 0.5 / (this.cell * this.grid);
    return [c / this.grid + e, 1 - (r + 1) / this.grid + e, (c + 1) / this.grid - e, 1 - r / this.grid - e];
  }

  dispose(): void {
    this.texture.dispose();
  }
}

/** Shared by both batches: world units per CSS px is `uPerPx.x * viewDepth + uPerPx.y` (perspective, orthographic). */
export function perPxUniform(camera: THREE.Camera, height: number, out = new THREE.Vector2()): THREE.Vector2 {
  const h = Math.max(1, height);
  const p = camera as THREE.PerspectiveCamera;
  if (p.isPerspectiveCamera) return out.set((2 * Math.tan((p.fov * Math.PI) / 360)) / h, 0);
  const o = camera as THREE.OrthographicCamera;
  if (o.isOrthographicCamera) return out.set(0, (o.top - o.bottom) / Math.max(1e-9, o.zoom) / h);
  return out.set(0, 1 / h);
}

const QUAD_VERT = /* glsl */ `
attribute vec3 iCentre;
attribute float iPx;
attribute vec4 iUv;
uniform vec2 uPerPx;
varying vec2 vUv;
void main() {
  vec4 mv = modelViewMatrix * vec4(iCentre, 1.0);
  float k = iPx * (uPerPx.x * -mv.z + uPerPx.y);
  mv.xy += position.xy * k;
  gl_Position = projectionMatrix * mv;
  vUv = mix(iUv.xy, iUv.zw, uv);
}`;

const QUAD_FRAG = /* glsl */ `
uniform sampler2D map;
uniform float opacity;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(map, vUv);
  if (c.a < 0.01) discard;
  gl_FragColor = vec4(c.rgb, c.a * opacity);
  #include <colorspace_fragment>
}`;

const STEM_VERT = /* glsl */ `
attribute vec3 iBase;
attribute vec2 iSizePx;
attribute vec3 iColour;
uniform vec2 uPerPx;
varying vec3 vColour;
void main() {
  vec4 mv = modelViewMatrix * vec4(iBase, 1.0);
  float k = uPerPx.x * -mv.z + uPerPx.y;
  // straight up the screen from the base (the view's own y axis): width x, length y
  mv.x += position.x * iSizePx.x * k;
  mv.y += (position.y + 0.5) * iSizePx.y * k;
  gl_Position = projectionMatrix * mv;
  vColour = iColour;
}`;

const STEM_FRAG = /* glsl */ `
varying vec3 vColour;
void main() {
  gl_FragColor = vec4(vColour, 1.0);
  #include <colorspace_fragment>
}`;

/** No pick ever lands on an annotation draw (the base quad sits at the origin; the instances are in attributes). */
const noRaycast = () => {};

function mark(o: THREE.Object3D) {
  o.frustumCulled = false;
  o.userData.noBatch = true;
  o.userData.annot = true;
  o.matrixAutoUpdate = false;
  o.raycast = noRaycast;
}

/** One camera-facing quad: its centre (world), its size in CSS px, and the atlas picture it shows. */
export interface QuadInstance {
  centre: THREE.Vector3;
  px: number;
  key: string;
  draw: AtlasDraw;
}

/** Every quad of the layer in one instanced draw (depth-tested) and its ghost copy in a second one. */
export class QuadBatch {
  readonly live: THREE.Mesh;
  readonly ghost: THREE.Mesh;
  readonly atlas: GlyphAtlas;
  private geometry: THREE.InstancedBufferGeometry;
  private capacity = 0;
  private uniforms: { uPerPx: { value: THREE.Vector2 } };
  count = 0;

  constructor(atlas = new GlyphAtlas()) {
    this.atlas = atlas;
    this.uniforms = { uPerPx: { value: new THREE.Vector2(0, 1) } };
    this.geometry = this.makeGeometry(16);
    const mat = (depth: boolean) =>
      new THREE.ShaderMaterial({
        uniforms: { map: { value: atlas.texture }, opacity: { value: depth ? 1 : 0.3 }, uPerPx: this.uniforms.uPerPx },
        vertexShader: QUAD_VERT,
        fragmentShader: QUAD_FRAG,
        transparent: true,
        depthTest: depth,
        depthWrite: false,
        toneMapped: false,
      });
    this.live = new THREE.Mesh(this.geometry, mat(true));
    this.ghost = new THREE.Mesh(this.geometry, mat(false));
    this.live.name = "annot-quads";
    this.ghost.name = "annot-quads-ghost";
    // the ghost first, the live quads over the stems (renderOrder 20): a terminal dot covers its stem's foot
    this.live.renderOrder = 21;
    this.ghost.renderOrder = 19;
    mark(this.live);
    mark(this.ghost);
    this.live.visible = this.ghost.visible = false;
  }

  private makeGeometry(capacity: number): THREE.InstancedBufferGeometry {
    const g = new THREE.InstancedBufferGeometry();
    const base = new THREE.PlaneGeometry(1, 1);
    g.index = base.index;
    g.setAttribute("position", base.getAttribute("position"));
    g.setAttribute("uv", base.getAttribute("uv"));
    g.setAttribute("iCentre", new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("iPx", new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("iUv", new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage));
    g.instanceCount = 0;
    this.capacity = capacity;
    return g;
  }

  /** Writes this frame's quads (in draw order) and the camera's px scale. */
  flush(list: QuadInstance[], camera: THREE.Camera, height: number, ghosts: boolean): void {
    perPxUniform(camera, height, this.uniforms.uPerPx.value);
    // every key in the atlas before any uv is read (a full atlas is cleared once and refilled with this frame's set)
    const keys = new Map<string, AtlasDraw>();
    for (const q of list) if (!keys.has(q.key)) keys.set(q.key, q.draw);
    if ([...keys.keys()].filter((k) => !this.atlas.has(k)).length + this.atlas.size > this.atlas.grid * this.atlas.grid) this.atlas.clear();
    for (const [k, d] of keys) this.atlas.ensure(k, d);
    if (list.length > this.capacity) {
      let cap = this.capacity;
      while (cap < list.length) cap *= 2;
      const old = this.geometry;
      this.geometry = this.makeGeometry(cap);
      this.live.geometry = this.ghost.geometry = this.geometry;
      old.dispose();
    }
    const c = this.geometry.getAttribute("iCentre") as THREE.InstancedBufferAttribute;
    const s = this.geometry.getAttribute("iPx") as THREE.InstancedBufferAttribute;
    const u = this.geometry.getAttribute("iUv") as THREE.InstancedBufferAttribute;
    list.forEach((q, i) => {
      c.setXYZ(i, q.centre.x, q.centre.y, q.centre.z);
      s.setX(i, q.px);
      const r = this.atlas.uv(q.key);
      u.setXYZW(i, r[0], r[1], r[2], r[3]);
    });
    c.needsUpdate = s.needsUpdate = u.needsUpdate = true;
    this.geometry.instanceCount = list.length;
    this.count = list.length;
    this.live.visible = list.length > 0;
    this.ghost.visible = list.length > 0 && ghosts;
  }

  /** The instance data as written (tests): centre, px, uv. */
  instance(i: number): { centre: [number, number, number]; px: number; uv: [number, number, number, number] } {
    const c = this.geometry.getAttribute("iCentre") as THREE.InstancedBufferAttribute;
    const s = this.geometry.getAttribute("iPx") as THREE.InstancedBufferAttribute;
    const u = this.geometry.getAttribute("iUv") as THREE.InstancedBufferAttribute;
    return { centre: [c.getX(i), c.getY(i), c.getZ(i)], px: s.getX(i), uv: [u.getX(i), u.getY(i), u.getZ(i), u.getW(i)] };
  }

  dispose(): void {
    this.geometry.dispose();
    (this.live.material as THREE.Material).dispose();
    (this.ghost.material as THREE.Material).dispose();
    this.atlas.dispose();
  }
}

/** One marker stem: its foot (world), its width and length in CSS px, its colour. */
export interface StemInstance {
  base: THREE.Vector3;
  widthPx: number;
  lengthPx: number;
  colour: string;
}

/** Every marker stem in one instanced draw, depth-tested. */
export class StemBatch {
  readonly mesh: THREE.Mesh;
  private geometry: THREE.InstancedBufferGeometry;
  private capacity = 0;
  private uniforms = { uPerPx: { value: new THREE.Vector2(0, 1) } };
  private colour = new THREE.Color();
  count = 0;

  constructor() {
    this.geometry = this.makeGeometry(16);
    this.mesh = new THREE.Mesh(
      this.geometry,
      new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: STEM_VERT, fragmentShader: STEM_FRAG, transparent: true, depthTest: true, depthWrite: false, toneMapped: false }),
    );
    this.mesh.name = "annot-stems";
    this.mesh.renderOrder = 20;
    mark(this.mesh);
    this.mesh.visible = false;
  }

  private makeGeometry(capacity: number): THREE.InstancedBufferGeometry {
    const g = new THREE.InstancedBufferGeometry();
    const base = new THREE.PlaneGeometry(1, 1);
    g.index = base.index;
    g.setAttribute("position", base.getAttribute("position"));
    g.setAttribute("iBase", new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("iSizePx", new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("iColour", new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.instanceCount = 0;
    this.capacity = capacity;
    return g;
  }

  flush(list: StemInstance[], camera: THREE.Camera, height: number): void {
    perPxUniform(camera, height, this.uniforms.uPerPx.value);
    if (list.length > this.capacity) {
      let cap = this.capacity;
      while (cap < list.length) cap *= 2;
      const old = this.geometry;
      this.geometry = this.makeGeometry(cap);
      this.mesh.geometry = this.geometry;
      old.dispose();
    }
    const b = this.geometry.getAttribute("iBase") as THREE.InstancedBufferAttribute;
    const s = this.geometry.getAttribute("iSizePx") as THREE.InstancedBufferAttribute;
    const c = this.geometry.getAttribute("iColour") as THREE.InstancedBufferAttribute;
    list.forEach((m, i) => {
      b.setXYZ(i, m.base.x, m.base.y, m.base.z);
      s.setXY(i, m.widthPx, m.lengthPx);
      // a CSS hex (sRGB) into the working (linear) space; the fragment shader converts back for the output
      this.colour.set(m.colour);
      c.setXYZ(i, this.colour.r, this.colour.g, this.colour.b);
    });
    b.needsUpdate = s.needsUpdate = c.needsUpdate = true;
    this.geometry.instanceCount = list.length;
    this.count = list.length;
    this.mesh.visible = list.length > 0;
  }

  instance(i: number): { base: [number, number, number]; size: [number, number] } {
    const b = this.geometry.getAttribute("iBase") as THREE.InstancedBufferAttribute;
    const s = this.geometry.getAttribute("iSizePx") as THREE.InstancedBufferAttribute;
    return { base: [b.getX(i), b.getY(i), b.getZ(i)], size: [s.getX(i), s.getY(i)] };
  }

  dispose(): void {
    this.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
