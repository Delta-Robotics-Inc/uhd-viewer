/**
 * One model on its own (an artifact file opened by itself, outside an
 * assembly): a GLB by URL, or a scene a host built (a STEP it converted), in
 * the 3D view's own scene, lights, materials and theme colours, with a
 * floating icon toolbar (fit, standard views, wireframe, x-ray, grid, turn)
 * and, on request from the toolbar, a card with its name and size (PB-1074:
 * shown all the time it covered the model, and a Select All lit it up). Nothing
 * here is specific to a host.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { useTheme, tokenColor } from "../theme/ThemeProvider";
import { DEFAULT_SCENE_ACCENT, DEFAULT_SCENE_HIGHLIGHT, cadWrapper, createScene, loadGlb, type SceneHandle } from "./scene";
import { IconButton, Toolbar, ToolbarSeparator } from "../ui/Toolbar";
import { cx } from "../ui/cx";

export interface ModelViewProps {
  /** A GLB or glTF file. */
  url?: string;
  /**
   * A model a host built (a converted STEP), in millimetres with Z up (the
   * 3D view's CAD coordinates). Used instead of `url`.
   */
  object?: THREE.Object3D | null;
  /** The file's name, for the card. */
  name?: string;
  /** A line under the name ("STEP · converted in the viewer"). */
  detail?: string;
  /** Why the model could not be shown (the host's conversion failed). */
  error?: string;
  /** Called once the model is on screen, with what the card shows. */
  onReady?: (info: ModelInfo) => void;
  /** Show the card with the name and size from the start (default: folded into the toolbar's Model info button). */
  infoOpen?: boolean;
  /** Extra buttons at the toolbar's end (a host's "open in the system viewer"). */
  actions?: React.ReactNode;
  className?: string;
}

export interface ModelInfo {
  /** Size along x, y, z (mm). */
  size: [number, number, number];
  meshes: number;
  triangles: number;
}

type ViewDir = "iso" | "top" | "front" | "right";

const VIEWS: { id: ViewDir; icon: string; label: string; dir: [number, number, number] }[] = [
  { id: "iso", icon: "box", label: "Isometric view", dir: [1, -1.2, 0.9] },
  { id: "top", icon: "arrow-down-to-dot", label: "Top view", dir: [0, -0.0001, 1] },
  { id: "front", icon: "square", label: "Front view", dir: [0, -1, 0.0001] },
  { id: "right", icon: "panel-right", label: "Right view", dir: [1, 0, 0.0001] },
];

/** A neutral satin surface for meshes that bring no material of their own (the 3D view's default). */
const neutral = () => new THREE.MeshStandardMaterial({ color: 0x8b8b8b, roughness: 0.55, metalness: 0.1 });

function stats(root: THREE.Object3D): Omit<ModelInfo, "size"> {
  let meshes = 0;
  let triangles = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    meshes++;
    const g = m.geometry as THREE.BufferGeometry;
    triangles += g.index ? g.index.count / 3 : (g.getAttribute("position")?.count ?? 0) / 3;
  });
  return { meshes, triangles: Math.round(triangles) };
}

const mm = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2));

export function ModelView({ url, object, name, detail, error, onReady, actions, infoOpen = false, className }: ModelViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<SceneHandle | null>(null);
  const model = useRef<THREE.Object3D | null>(null);
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; message?: string; info?: ModelInfo }>({ status: "loading" });
  const [wire, setWire] = useState(false);
  const [xray, setXray] = useState(false);
  const [grid, setGrid] = useState(true);
  const [spin, setSpin] = useState(false);
  const [view, setView] = useState<ViewDir>("iso");
  const [showInfo, setShowInfo] = useState(infoOpen);

  useEffect(() => {
    if (!host.current) return;
    let h: SceneHandle;
    try {
      h = createScene(host.current);
    } catch {
      setState({ status: "error", message: "3D drawing (WebGL) is not available here." });
      return;
    }
    handle.current = h;
    return () => {
      h.dispose();
      handle.current = null;
    };
  }, []);

  // the theme's background, grid and highlight colours
  const { theme } = useTheme();
  useEffect(() => {
    const h = handle.current;
    const el = host.current;
    if (!h || !el) return;
    h.setTheme({
      background: tokenColor(el, "sceneBackground"),
      grid: tokenColor(el, "sceneGrid", "#3a3a3a"),
      gridMinor: tokenColor(el, "sceneGridMinor", "#262626"),
      accent: tokenColor(el, "accent", DEFAULT_SCENE_ACCENT),
      highlight: tokenColor(el, "highlight", DEFAULT_SCENE_HIGHLIGHT),
    });
  }, [theme]);

  /** Frame the model from a direction (in the model's Z-up coordinates). */
  const frame = (dir: [number, number, number]) => {
    const h = handle.current;
    const m = model.current;
    if (!h || !m) return;
    const box = new THREE.Box3().setFromObject(m);
    if (box.isEmpty()) return;
    const centre = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() / 2 || 1;
    const d = new THREE.Vector3(...dir).normalize();
    const dist = (radius / Math.sin((h.camera.fov * Math.PI) / 360)) * 1.08;
    h.camera.near = Math.max(0.01, radius / 200);
    h.camera.far = radius * 200;
    h.camera.updateProjectionMatrix();
    h.controls.target.copy(centre);
    h.camera.position.copy(centre).addScaledVector(d, dist);
    h.controls.update();
  };

  // the model: the host's scene, or the GLB at `url`
  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    let cancelled = false;
    h.root.clear();
    model.current = null;
    if (error) {
      setState({ status: "error", message: error });
      return;
    }
    const show = (root: THREE.Object3D) => {
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && !m.material) m.material = neutral();
      });
      h.root.add(root);
      model.current = root;
      root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(root);
      const size = box.getSize(new THREE.Vector3());
      h.setGround(box);
      const info: ModelInfo = { size: [size.x, size.y, size.z], ...stats(root) };
      setState({ status: "ready", info });
      frame(VIEWS[0].dir);
      onReady?.(info);
    };
    if (object) show(object);
    else if (url) {
      setState({ status: "loading" });
      loadGlb(url).then((gltf) => {
        if (cancelled) return;
        if (!gltf) return setState({ status: "error", message: "The model could not be read." });
        show(cadWrapper(gltf.scene.clone(true)));
      });
    } else if (object === undefined) setState({ status: "error", message: "Nothing to show." });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, object, error]);

  // wireframe and x-ray change the materials in place
  const originals = useMemo(() => new WeakMap<THREE.Material, { wireframe: boolean; opacity: number; transparent: boolean; depthWrite: boolean }>(), []);
  useEffect(() => {
    const m = model.current;
    if (!m) return;
    m.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const mat of (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[]) {
        if (!originals.has(mat)) originals.set(mat, { wireframe: mat.wireframe, opacity: mat.opacity, transparent: mat.transparent, depthWrite: mat.depthWrite });
        const o0 = originals.get(mat)!;
        mat.wireframe = wire || o0.wireframe;
        mat.transparent = xray || o0.transparent;
        mat.opacity = xray ? Math.min(o0.opacity, 0.28) : o0.opacity;
        mat.depthWrite = xray ? false : o0.depthWrite;
        mat.needsUpdate = true;
      }
    });
  }, [wire, xray, state.status, originals]);

  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    const g = h.scene.children.find((o) => o instanceof THREE.GridHelper);
    if (g) g.visible = grid;
  }, [grid, state.status, theme]);

  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    h.controls.autoRotate = spin;
    h.controls.autoRotateSpeed = 1.4;
  }, [spin]);

  const info = state.info;
  return (
    // nothing in the view selects as text (a drag that starts on the card turns the model; Select All lights nothing up)
    <div className={cx("uhd-model-view relative size-full min-h-[240px] min-w-[280px] overflow-hidden bg-canvas select-none", className)}>
      <div ref={host} className="absolute inset-0 [&>canvas]:block [&>canvas]:size-full" />
      {showInfo && (name || info) && (
        <div role="note" aria-label="Model info" className="absolute top-[calc(var(--uhd-inset-top,0px)+12px)] left-3 max-w-[min(360px,calc(100%-24px))] rounded-panel border border-line bg-surface px-3 py-2 shadow-panel outline outline-1 -outline-offset-1 outline-contrast">
          {name && <div className="truncate font-label text-[12px] tracking-[0.06em] text-fg uppercase">{name}</div>}
          {detail && <div className="truncate text-[11px] text-fg-muted">{detail}</div>}
          {info && (
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-code text-[11px] text-fg-muted">
              <span>
                {info.size.map(mm).join(" × ")} <span className="text-fg-faint">mm</span>
              </span>
              <span>
                {info.meshes} <span className="text-fg-faint">{info.meshes === 1 ? "mesh" : "meshes"}</span>
              </span>
              <span>
                {info.triangles.toLocaleString("en-US")} <span className="text-fg-faint">triangles</span>
              </span>
            </div>
          )}
        </div>
      )}
      {state.status !== "ready" && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className={cx("rounded-panel border border-line bg-surface px-4 py-3 text-center shadow-panel", state.status === "error" ? "text-error" : "text-fg-muted")}>
            <div className="font-label text-[12px] tracking-[0.06em] uppercase">{state.status === "error" ? "Cannot show this model" : "Loading the model"}</div>
            {state.message && <div className="mt-1 max-w-[320px] text-[11px] text-fg-muted">{state.message}</div>}
          </div>
        </div>
      )}
      <div className="absolute right-0 bottom-3 left-0 flex justify-center px-3">
        <Toolbar label="Model tools" className="max-w-full overflow-x-auto [scrollbar-width:none]">
          <IconButton icon="maximize" label="Fit" tooltipSide="top" disabled={state.status !== "ready"} onClick={() => frame(VIEWS.find((v) => v.id === view)!.dir)} />
          <ToolbarSeparator />
          {VIEWS.map((v) => (
            <IconButton
              key={v.id}
              icon={v.icon}
              label={v.label}
              tooltipSide="top"
              pressed={view === v.id}
              disabled={state.status !== "ready"}
              onClick={() => {
                setView(v.id);
                frame(v.dir);
              }}
            />
          ))}
          <ToolbarSeparator />
          <IconButton icon="grid-3x3" label="Wireframe" tooltipSide="top" pressed={wire} onClick={() => setWire(!wire)} />
          <IconButton icon="scan-eye" label="X-ray: see through the model" tooltipSide="top" pressed={xray} onClick={() => setXray(!xray)} />
          <IconButton icon="grid-2x2" label="Ground grid" tooltipSide="top" pressed={grid} onClick={() => setGrid(!grid)} />
          <IconButton icon="orbit" label="Turn the model" tooltipSide="top" pressed={spin} onClick={() => setSpin(!spin)} />
          {(name || info) && (
            <>
              <ToolbarSeparator />
              <IconButton icon="info" label={showInfo ? "Hide the model info" : "Model info: name and size"} tooltipSide="top" pressed={showInfo} onClick={() => setShowInfo(!showInfo)} />
            </>
          )}
          {actions && <ToolbarSeparator />}
          {actions}
        </Toolbar>
      </div>
    </div>
  );
}
