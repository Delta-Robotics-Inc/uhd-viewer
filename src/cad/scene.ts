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
import { param, traitParam } from "./model";
import type { Appearance } from "../source/source";

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

/** Load a GLB by URL (artifact URLs come from the viewer source's resolver). */
export function loadGlb(url: string): Promise<GLTF | null> {
  if (!cache.has(url)) {
    cache.set(
      url,
      loader.loadAsync(url).catch((e) => {
        console.warn(`[cad] ${url}: ${e}`);
        return null;
      }),
    );
  }
  return cache.get(url)!;
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

/**
 * Surface for a module's body (or one named sub-body of its CAD), from, in
 * order: display hints for the definition (and part), the part's declared
 * material (UHD MaterialSpec), then neutral defaults by kind. Nothing here
 * knows a particular project.
 */
export function materialFor(def: ModuleDef, bodyPart: string, appearance?: Appearance): THREE.MeshStandardMaterial {
  const hint = { ...(appearance ?? {}), ...(appearance?.parts?.[bodyPart] ?? {}) };
  const base = fallbackAppearance(def, bodyPart);
  const a = { ...base, ...hint };
  const transparent = a.opacity !== undefined && a.opacity < 1;
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(a.color ?? "#8b8b8b"),
    roughness: a.roughness ?? 0.55,
    metalness: a.metalness ?? 0.1,
    ...(transparent ? { transparent: true, opacity: a.opacity, side: THREE.DoubleSide, depthWrite: false } : {}),
  });
}

/** Declared material first (UHD `domains[mechanical].material`), then what the part is. */
function fallbackAppearance(def: ModuleDef, bodyPart: string): Omit<Appearance, "parts"> {
  const mech = (def.domains ?? []).find((d) => d.domain === "mechanical") as { material?: { name?: string } } | undefined;
  const text = `${mech?.material?.name ?? ""} ${def.name} ${(def.tags ?? []).join(" ")} ${(def.categories ?? []).join(" ")}`.toLowerCase();
  // satin, not glossy: a flat plate under the key light otherwise shows a broad pale highlight (PB-873)
  if (/carbon/.test(text)) return { color: "#232326", roughness: 0.62, metalness: 0.08 };
  if (/alumin/.test(text)) return { color: "#9aa0a8", metalness: 0.8, roughness: 0.35 };
  if (/nylon|pa6|plastic|pla\b|abs\b/.test(text)) return { color: "#1c1c1c", roughness: 0.7 };
  if (/stainless|steel|screw|bolt|nut|fastener/.test(text)) return { color: "#c0c4cc", metalness: 0.85, roughness: 0.3 };
  if (bodyPart === "components") return { color: "#3f3f46" };
  if (/propeller|\bprop\b/.test(text)) return { color: "#e7e5e4", opacity: 0.6 };
  if (/battery|lipo/.test(text)) return { color: "#2d2f36", roughness: 0.6 };
  if (/esc|controller|driver|board|module|sensor|receiver|pcb/.test(text) && bodyPart !== "") return { color: "#1f3b2c" };
  if (/motor/.test(text)) return { color: "#9ca3af", metalness: 0.75, roughness: 0.3 };
  return { color: "#8b8b8b" };
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
  /**
   * The model direction drawn up (default +z): the camera's up, the orbit
   * axis, the ground grid and the lights follow it (a display hint, PB-873).
   */
  setUp: (up: THREE.Vector3) => void;
  /** Put the ground grid under a box (the assembled model), across the up direction. */
  setGround: (box: THREE.Box3) => void;
  /** Called every frame before rendering, with the frame time in seconds. */
  onFrame: Set<(dt: number) => void>;
  /** When set, the render loop is driven externally (video capture). */
  manual: { on: boolean };
  renderOnce: () => void;
}

export function createScene(container: HTMLElement): SceneHandle {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a1a);
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
  const onFrame = new Set<(dt: number) => void>();
  const manual = { on: false };
  let last = performance.now();
  const renderOnce = (dt = 1 / 60) => {
    controls.update();
    for (const f of onFrame) f(dt);
    renderer.render(scene, camera);
  };
  const tick = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!manual.on) renderOnce(dt);
    raf = requestAnimationFrame(tick);
  };
  tick();
  const ro = new ResizeObserver(() => {
    renderer.setSize(container.clientWidth, container.clientHeight);
    camera.aspect = container.clientWidth / Math.max(1, container.clientHeight);
    camera.updateProjectionMatrix();
  });
  ro.observe(container);

  const upAxis = new THREE.Vector3(0, 0, 1);
  const lights: [THREE.Object3D, THREE.Vector3][] = [
    [key, key.position.clone()],
    [rim, rim.position.clone()],
  ];
  const gridBase = grid.quaternion.clone();
  const setUp = (up: THREE.Vector3) => {
    upAxis.copy(up).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), upAxis);
    camera.up.copy(upAxis);
    // OrbitControls keeps the rotation from camera.up to +y from its construction
    const c = controls as unknown as { _quat: THREE.Quaternion; _quatInverse: THREE.Quaternion };
    c._quat.setFromUnitVectors(upAxis, new THREE.Vector3(0, 1, 0));
    c._quatInverse.copy(c._quat).invert();
    for (const [light, base] of lights) light.position.copy(base).applyQuaternion(q);
    grid.quaternion.copy(q).multiply(gridBase);
    grid.position.copy(upAxis).multiplyScalar(-0.5);
  };
  const setGround = (box: THREE.Box3) => {
    if (box.isEmpty()) return;
    // the lowest point of the box along up, half a millimetre below it
    const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
    const low = Math.min(...corners.map((c) => c.dot(upAxis)));
    const c = box.getCenter(new THREE.Vector3());
    grid.position.copy(c.sub(upAxis.clone().multiplyScalar(c.dot(upAxis) - low + 0.5)));
  };

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
    setUp,
    setGround,
    onFrame,
    manual,
    renderOnce: () => renderOnce(1 / 30),
    dispose: () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
