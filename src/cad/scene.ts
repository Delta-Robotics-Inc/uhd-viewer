/**
 * Imperative three.js scene for the 3D view (PB-775). Units: mm, Z up.
 *
 * GLB artifacts are glTF (metres, Y up); each is wrapped in a group that
 * rotates +90° about X and scales ×1000, which returns it to the module's
 * own CAD coordinates — the coordinates UHD frames are written in.
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { GeometryFrame, InterfaceDef, ModuleDef } from "@uhd/types/index.js";
import type { Mat4 } from "@uhd/system/geometry.js";
import { param, traitParam, uhdUrl } from "./model";

export const COLORS = {
  focus: 0xff5c00,
  counterpart: 0x38bdf8,
  normal: 0xff5c00,
  xAxis: 0x22d3ee,
  phase: [0xe11d48, 0xfacc15, 0x38bdf8],
  hint: 0xa8a29e,
};

const loader = new GLTFLoader();
const cache = new Map<string, Promise<GLTF | null>>();

export function loadGlb(filePath: string): Promise<GLTF | null> {
  if (!cache.has(filePath)) {
    cache.set(
      filePath,
      loader.loadAsync(uhdUrl(filePath)).catch((e) => {
        console.warn(`[cad] ${filePath}: ${e}`);
        return null;
      }),
    );
  }
  return cache.get(filePath)!;
}

/** glTF (m, Y-up) back to CAD coordinates (mm, Z-up). */
export function cadWrapper(obj: THREE.Object3D): THREE.Group {
  const g = new THREE.Group();
  g.rotation.x = Math.PI / 2;
  g.scale.setScalar(1000);
  g.add(obj);
  return g;
}

export function toMatrix4(m: Mat4): THREE.Matrix4 {
  return new THREE.Matrix4().set(...(m as [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]));
}

// ---------------------------------------------------------------------------
// Materials by what the module is
// ---------------------------------------------------------------------------

export function materialFor(def: ModuleDef, bodyPart: string): THREE.MeshStandardMaterial {
  const id = def.id;
  const std = (color: number, o: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.1, ...o });
  if (id.includes("frame")) return std(0x2a2a2c, { roughness: 0.35, metalness: 0.2 });
  if (id.includes("meps")) {
    if (bodyPart.startsWith("lead")) return std(0x1b1b1b, { roughness: 0.8 });
    if (bodyPart === "shaft_body") return std(0xd6d3d1, { metalness: 0.9, roughness: 0.25 });
    if (bodyPart === "base") return std(0x57534e, { metalness: 0.6, roughness: 0.4 });
    return std(0x9ca3af, { metalness: 0.75, roughness: 0.3 });
  }
  if (id.includes("hqprop")) return std(0xff5c00, { transparent: true, opacity: 0.45, roughness: 0.4, side: THREE.DoubleSide, depthWrite: false });
  if (id.includes("am32")) return bodyPart === "components" ? std(0x3f3f46) : std(0x1e3a5f);
  if (id.includes("f405")) return bodyPart === "components" ? std(0x3f3f46) : std(0x14532d);
  if (id.includes("o4")) return std(0x3a3a3c, { metalness: 0.4 });
  if (id.includes("cnhl")) return std(0x44403c, { transparent: true, opacity: 0.6 });
  if (id.includes("spacer")) return std(0xe7e5e4, { roughness: 0.7 });
  if (id.includes("iso-")) return std(0xc0c4cc, { metalness: 0.85, roughness: 0.3 });
  return std(0x8b8b8b);
}

export const focusMaterial = (color: number) =>
  new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0.6,
    roughness: 0.4,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

// ---------------------------------------------------------------------------
// Frames and procedural geometry (D3), in a module's CAD coordinates
// ---------------------------------------------------------------------------

/** Group whose local X/Y/Z are the frame's xAxis / (normal × xAxis) / normal, origin at the frame origin. */
export function frameGroup(frame: GeometryFrame): THREE.Group {
  const z = new THREE.Vector3(...frame.normal).normalize();
  let x = frame.xAxis ? new THREE.Vector3(...frame.xAxis) : Math.abs(z.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  x = x.sub(z.clone().multiplyScalar(x.dot(z))).normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  const g = new THREE.Group();
  g.matrixAutoUpdate = false;
  g.matrix.makeBasis(x, y, z).setPosition(...frame.origin);
  return g;
}

export function frameGizmo(frame: GeometryFrame, size = 14): THREE.Group {
  const g = frameGroup(frame);
  const arrow = (dir: THREE.Vector3, color: number, len: number) => {
    const a = new THREE.ArrowHelper(dir, new THREE.Vector3(), len, color, len * 0.22, len * 0.12);
    (a.line.material as THREE.LineBasicMaterial).depthTest = false;
    (a.cone.material as THREE.MeshBasicMaterial).depthTest = false;
    a.renderOrder = 10;
    return a;
  };
  g.add(arrow(new THREE.Vector3(0, 0, 1), COLORS.normal, size));
  if (frame.xAxis) g.add(arrow(new THREE.Vector3(1, 0, 0), COLORS.xAxis, size * 0.6));
  // symmetry: tick marks every symmetryDeg
  if (frame.symmetryDeg) {
    const pts: THREE.Vector3[] = [];
    for (let a = 0; a < 360; a += frame.symmetryDeg) {
      const r = (a * Math.PI) / 180;
      pts.push(new THREE.Vector3(Math.cos(r) * size * 0.45, Math.sin(r) * size * 0.45, 0), new THREE.Vector3(Math.cos(r) * size * 0.7, Math.sin(r) * size * 0.7, 0));
    }
    const ticks = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: COLORS.xAxis, depthTest: false }));
    ticks.renderOrder = 10;
    g.add(ticks);
  }
  return g;
}

/**
 * D3: geometry derived from the interface's own parameters, placed at its
 * frame. Returns null when the generator has nothing to work with. `notes`
 * collects what the parameters could not say (e.g. pattern phase).
 */
export function proceduralGeometry(iface: InterfaceDef, generator: string, frame: GeometryFrame, color: number, notes: string[]): THREE.Object3D | null {
  const g = frameGroup(frame);
  const mat = focusMaterial(color);
  if (generator === "bolt_pattern") {
    const spacing = param(iface, "hole_spacing");
    const spacingY = param(iface, "hole_spacing_y") ?? spacing;
    const count = param(iface, "hole_count") ?? 4;
    const d = param(iface, "fastener_diameter") ?? 3;
    const shape = traitParam<string>(iface, "bolt_pattern", "shape") ?? "square";
    if (!spacing) return null;
    const holes: [number, number][] = [];
    if (shape === "circle") {
      notes.push("circle pattern phase is not a UHD parameter: holes drawn from 45°");
      for (let k = 0; k < count; k++) {
        const a = Math.PI / 4 + (k * 2 * Math.PI) / count;
        holes.push([(Math.cos(a) * spacing) / 2, (Math.sin(a) * spacing) / 2]);
      }
    } else {
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) holes.push([(sx * spacing) / 2, (sy * spacingY!) / 2]);
    }
    for (const [x, y] of holes) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(d / 2 + 0.6, 0.45, 10, 32), mat);
      ring.position.set(x, y, 0.3);
      g.add(ring);
      const pin = new THREE.Mesh(new THREE.CylinderGeometry(d / 2, d / 2, 6, 20), new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.35 }));
      pin.rotation.x = Math.PI / 2;
      pin.position.set(x, y, 3);
      g.add(pin);
    }
    const outline =
      shape === "circle"
        ? new THREE.EllipseCurve(0, 0, spacing / 2, spacing / 2).getPoints(64).map((p) => new THREE.Vector3(p.x, p.y, 0.3))
        : [
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, 1],
            [-1, -1],
          ].map(([sx, sy]) => new THREE.Vector3((sx * spacing) / 2, (sy * spacingY!) / 2, 0.3));
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(outline), new THREE.LineDashedMaterial({ color, dashSize: 1.5, gapSize: 1 })).computeLineDistances());
    return g;
  }
  if (generator === "shaft") {
    const d = param(iface, "shaft_diameter") ?? 5;
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(d / 2 + 0.2, d / 2 + 0.2, 12, 32, 1, true), mat);
    cyl.rotation.x = Math.PI / 2;
    cyl.position.z = 6;
    g.add(cyl);
    notes.push("shaft length is not a UHD parameter: drawn 12 mm");
    return g;
  }
  if (generator === "pad") {
    const pad = new THREE.Mesh(new THREE.BoxGeometry(4, 9, 0.4), mat);
    pad.position.z = 0.2;
    g.add(pad);
    notes.push("pad size/pitch are not UHD parameters: drawn as a generic 3-pad group");
    return g;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

export interface SceneHandle {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  renderer: THREE.WebGLRenderer;
  root: THREE.Group;
  overlay: THREE.Group;
  dispose: () => void;
  frameAll: (box?: THREE.Box3) => void;
}

export function createScene(container: HTMLElement): SceneHandle {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1c1c1c);
  const camera = new THREE.PerspectiveCamera(32, container.clientWidth / container.clientHeight, 1, 5000);
  camera.up.set(0, 0, 1);
  camera.position.set(260, -330, 250);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 20);
  controls.enableDamping = true;

  scene.add(new THREE.HemisphereLight(0xf5f5f4, 0x1c1917, 1.4));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(200, -150, 400);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffedd5, 0.8);
  rim.position.set(-300, 250, 120);
  scene.add(rim);

  const grid = new THREE.GridHelper(600, 60, 0x3a3a3a, 0x262626);
  grid.rotation.x = Math.PI / 2;
  grid.position.z = -0.5;
  scene.add(grid);

  const root = new THREE.Group();
  const overlay = new THREE.Group();
  scene.add(root, overlay);

  let raf = 0;
  const tick = () => {
    controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(tick);
  };
  tick();
  const ro = new ResizeObserver(() => {
    renderer.setSize(container.clientWidth, container.clientHeight);
    camera.aspect = container.clientWidth / Math.max(1, container.clientHeight);
    camera.updateProjectionMatrix();
  });
  ro.observe(container);

  const frameAll = (box?: THREE.Box3) => {
    const b = box ?? new THREE.Box3().setFromObject(root);
    if (b.isEmpty()) return;
    const c = b.getCenter(new THREE.Vector3());
    const r = b.getSize(new THREE.Vector3()).length() / 2;
    const dir = camera.position.clone().sub(controls.target).normalize();
    controls.target.copy(c);
    camera.position.copy(c.clone().add(dir.multiplyScalar(r / Math.sin((camera.fov * Math.PI) / 360))));
  };

  return {
    scene,
    camera,
    controls,
    renderer,
    root,
    overlay,
    frameAll,
    dispose: () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
