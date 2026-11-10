/**
 * The cube for scale (R4-B, 2026-11-02). Kevin: "The cube should be in or mm options and stack, for example 1 cube is
 * 1x1 mm, then they stack to 10x10 mm to make a 1x1 cm and so on. Or for rendering performance only ever do 1x1 units
 * but it has a dynamic grid on the surface when you zoom in and out."
 *
 * DEFAULT (the performant one Kevin offered): ONE cube, one draw. Its edge snaps to the rung of the units just below
 * the model's size (1, 10, 100, 1000 mm; or 1/16 in, 1 in, 1 ft), and its faces carry the grid shader's lines
 * (../grid/shader.ts, the floor's family) at the finer rungs, which appear as you zoom in: a 10 mm cube shows 1 mm
 * lines up close and 0.1 mm closer still; its edges are the coarsest rung, drawn as major lines. Units: scene mm.
 */
import * as THREE from "three";
import { MM_PER_IN, type Units } from "../grid/levels";
import { GRID_LINES_GLSL, devicePxPerCss, gridUniforms, setLadder } from "../grid/shader";
import { MIN_LINE_PX } from "../grid/levels";

/** The edges a cube may have (mm), per units, smallest first (Kevin's rungs). */
export const CUBE_EDGES: Readonly<Record<Units, readonly number[]>> = Object.freeze({
  mm: [1, 10, 100, 1000],
  in: [MM_PER_IN / 16, MM_PER_IN, 12 * MM_PER_IN],
});

/**
 * The cube's edge for a model `sizeMm` across (its largest extent): the largest rung not above it; the smallest rung
 * for a model smaller than that (DEFAULT R4-B).
 */
export function cubeEdgeFor(sizeMm: number, units: Units): number {
  const edges = CUBE_EDGES[units];
  if (!Number.isFinite(sizeMm) || sizeMm <= 0) return edges[0];
  let edge = edges[0];
  // a hair of tolerance: a 100.0000001 mm model and a 99.9999999 mm one both get the 100 mm cube
  for (const e of edges) if (e <= sizeMm * (1 + 1e-6)) edge = e;
  return edge;
}

export interface CubeColors {
  face: string;
  minor: string;
  major: string;
}

const VERTEX = /* glsl */ `
varying vec3 vLocal;
varying vec3 vObjNormal;
varying vec3 vViewNormal;
void main() {
  vLocal = position;
  vObjNormal = normal;
  vViewNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;
${GRID_LINES_GLSL}
uniform float uEdge;
uniform vec3 uFace;
uniform vec3 uMinor;
uniform vec3 uMajor;
varying vec3 vLocal;
varying vec3 vObjNormal;
varying vec3 vViewNormal;
void main() {
  // the face's own two axes, in mm from its corner (the box is 1 unit, centred, base at 0: see makeCube)
  vec3 q = vec3(vLocal.x + 0.5, vLocal.y + 0.5, vLocal.z) * uEdge;
  vec3 an = abs(vObjNormal);
  vec2 c = an.x > 0.5 ? q.yz : (an.y > 0.5 ? q.xz : q.xy);
  vec2 g = gridLines(c, uEdge);
  // a fixed light from the viewer's upper left: each face its own tone, whatever the scene's lights
  float shade = 0.64 + 0.36 * max(dot(normalize(vViewNormal), normalize(vec3(-0.35, 0.55, 0.75))), 0.0);
  vec3 col = mix(uFace * shade, mix(uMinor, uMajor, g.y), g.x);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface CubeMesh {
  mesh: THREE.Mesh;
  /** Set the edge (mm) and the units (the face lines' ladder). */
  set(edgeMm: number, units: Units): void;
  setColors(c: CubeColors): void;
  dispose(): void;
}

/** One cube, its base on z = 0, centred on its local origin, scaled to its edge; one draw. */
export function makeCube(colors: CubeColors): CubeMesh {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  geometry.translate(0, 0, 0.5);
  const uniforms = {
    ...gridUniforms("mm"),
    uEdge: { value: 10 },
    uFace: { value: new THREE.Color(colors.face) },
    uMinor: { value: new THREE.Color(colors.minor) },
    uMajor: { value: new THREE.Color(colors.major) },
  };
  const material = new THREE.ShaderMaterial({ name: "scale-cube", uniforms, vertexShader: VERTEX, fragmentShader: FRAGMENT });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "scale-cube";
  mesh.userData.noBatch = true;
  mesh.raycast = () => undefined;
  mesh.onBeforeRender = (renderer) => {
    const dpr = devicePxPerCss(renderer);
    uniforms.uDpr.value = dpr;
    uniforms.uMinPx.value = MIN_LINE_PX * dpr;
  };
  return {
    mesh,
    set(edgeMm, units) {
      uniforms.uEdge.value = edgeMm;
      setLadder(uniforms, units);
      mesh.scale.setScalar(edgeMm);
      mesh.updateMatrix();
    },
    setColors(c) {
      uniforms.uFace.value.set(c.face);
      uniforms.uMinor.value.set(c.minor);
      uniforms.uMajor.value.set(c.major);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
