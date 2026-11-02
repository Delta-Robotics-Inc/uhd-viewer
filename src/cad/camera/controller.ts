/**
 * The camera policy on a live view (R4-A, 2026-11-02): the Onshape-like wheel zoom with hard stops (./zoom.ts) and
 * the pivot dot shown while orbiting (./pivot.ts). OrbitControls keeps orbit, pan, the middle-button dolly and touch;
 * the wheel (and a trackpad's pinch, which browsers send as ctrl + wheel) is handled here, before OrbitControls sees
 * it, so each notch is one constant factor applied at once. OrbitControls' own zoom-to-cursor stays off: it moved the
 * target onto the cursor's ray and left the pivot off the model; the cursor zoom here keeps it on the model.
 * The middle-button dolly and a touch pinch obey the same stops: OrbitControls' min and max distance are set to them
 * for the length of a gesture only (between its start and end), so a fit or an agent's camera is never snapped.
 */
import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { PIVOT_DOT_FADE_MS, PIVOT_DOT_PX, radiusOf } from "./pivot";
import { WheelNotches, planeAnchor, zoomLimits, zoomStep, type ZoomLimits } from "./zoom";

/** What the policy needs of a scene (a SceneHandle has all of it). */
export interface CameraHost {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  renderer: { domElement: HTMLCanvasElement };
  invalidate: (what?: "view") => void;
}

export interface CameraPolicyOptions {
  /** The box of what is drawn now (the visible assembly, or the isolated set): the pivot's box and the stops' size. */
  drawn: () => THREE.Box3;
  /** The visible assembly's box for the farthest stop; DEFAULT the drawn box. */
  assembly?: () => THREE.Box3;
  /** The surface point under a client point (nearest part hit), if any. */
  hit?: (clientX: number, clientY: number) => THREE.Vector3 | undefined;
  /** Zoom toward the cursor (R1-A's E1, DEFAULT on); off: a plain dolly to the pivot. */
  cursor: () => boolean;
}

export interface CameraPolicy {
  /** The stops for what is drawn now. */
  limits: () => ZoomLimits;
  /** Zoom by `notches` about a client point (tests and agents' scripted checks); returns whether the camera moved. */
  zoomAt: (notches: number, clientX?: number, clientY?: number) => boolean;
  /** Show the pivot dot now (it fades PIVOT_DOT_FADE_MS later unless an orbit holds it). */
  flashPivot: () => void;
  dispose: () => void;
}

const ROTATING = new Set([0, 3, 6]); // OrbitControls' ROTATE, TOUCH_ROTATE, TOUCH_DOLLY_ROTATE

export function attachCameraPolicy(h: CameraHost, opts: CameraPolicyOptions): CameraPolicy {
  const canvas = h.renderer.domElement;
  const holder = canvas.parentElement ?? canvas;
  const reader = new WheelNotches();
  const controls = h.controls;
  // the wheel is ours: OrbitControls' zoom-to-cursor would move the pivot onto the cursor's ray
  controls.zoomToCursor = false;

  // wave R4 gate: the scene's smallest near plane (scene.ts nearPlaneFor: 1 mm whenever the camera is close), not the
  // live one, which grows with distance and would stop a middle-button dolly begun far away too soon
  const SCENE_NEAR_MIN_MM = 1;
  const limits = (): ZoomLimits => {
    const drawn = opts.drawn();
    const assembly = opts.assembly?.() ?? drawn;
    return zoomLimits({ focusRadius: radiusOf(drawn), assemblyRadius: radiusOf(assembly.isEmpty() ? drawn : assembly), fovDeg: h.camera.fov, aspect: h.camera.aspect, near: SCENE_NEAR_MIN_MM, far: h.camera.far });
  };

  const anchorAt = (clientX: number | undefined, clientY: number | undefined): THREE.Vector3 => {
    const pose = { position: h.camera.position, target: controls.target };
    if (clientX === undefined || clientY === undefined || !opts.cursor()) return controls.target.clone();
    const hit = opts.hit?.(clientX, clientY);
    if (hit) return hit;
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return controls.target.clone();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), h.camera);
    return planeAnchor(ray.ray, pose);
  };

  const zoomAt = (notches: number, clientX?: number, clientY?: number): boolean => {
    const drawn = opts.drawn();
    const next = zoomStep({ position: h.camera.position, target: controls.target }, { anchor: anchorAt(clientX, clientY), notches, limits: limits(), keepIn: drawn });
    if (!next) return false;
    // as OrbitControls does for its own wheel: start, the move, change, end (the view reports the camera, the
    // quality curve sees a gesture, a hover tooltip or a menu closes)
    controls.dispatchEvent({ type: "start" });
    h.camera.position.copy(next.position);
    controls.target.copy(next.target);
    h.camera.lookAt(controls.target);
    h.camera.updateMatrixWorld();
    controls.dispatchEvent({ type: "change" });
    controls.dispatchEvent({ type: "end" });
    h.invalidate("view");
    return true;
  };

  const onWheel = (e: WheelEvent) => {
    // only the canvas's own wheel: chips, menus and the toolbar inside the same holder scroll as before
    if (e.target !== canvas) return;
    if (controls.enabled === false || controls.enableZoom === false) return;
    e.preventDefault();
    e.stopPropagation();
    // a drag in progress keeps the wheel out, as OrbitControls does
    if ((controls as unknown as { state: number }).state !== -1) return;
    const n = reader.read(e);
    if (n) zoomAt(n, e.clientX, e.clientY);
  };
  // capture on the holder: before the canvas's own listeners (OrbitControls'), whatever the browser's target order
  holder.addEventListener("wheel", onWheel, { capture: true, passive: false });

  // ---- the middle-button dolly and a touch pinch: the same stops, for the length of the gesture ----------------
  const onStart = () => {
    const d = h.camera.position.distanceTo(controls.target);
    const l = limits();
    // a camera already past a stop (an isolation shrank what is drawn) is not pulled in: it can only come closer
    controls.minDistance = Math.min(l.min, d);
    controls.maxDistance = Math.max(l.max, d);
    const state = (controls as unknown as { state: number }).state;
    if (ROTATING.has(state)) showDot(true);
  };
  const onEnd = () => {
    controls.minDistance = 0;
    controls.maxDistance = Infinity;
    if (dot.style.opacity !== "0") hideDotSoon();
  };
  controls.addEventListener("start", onStart);
  controls.addEventListener("end", onEnd);

  // ---- the pivot dot (DEFAULT on while orbiting, fades PIVOT_DOT_FADE_MS after) ---------------------------------
  // no document (a headless test): a detached stand-in that is never shown
  const dot: HTMLElement = typeof document !== "undefined" ? document.createElement("div") : ({ style: {}, dataset: {}, setAttribute() {}, remove() {} } as unknown as HTMLElement);
  dot.className = "cad-pivot-dot";
  dot.setAttribute("aria-hidden", "true");
  dot.dataset.chrome = "pivot";
  Object.assign(dot.style, {
    position: "absolute",
    width: `${PIVOT_DOT_PX}px`,
    height: `${PIVOT_DOT_PX}px`,
    marginLeft: `${-PIVOT_DOT_PX / 2}px`,
    marginTop: `${-PIVOT_DOT_PX / 2}px`,
    borderRadius: "50%",
    background: "var(--uhd-accent, #3b82f6)",
    boxShadow: "0 0 0 1.5px var(--uhd-background, #1a1a1a)",
    pointerEvents: "none",
    opacity: "0",
    transition: `opacity ${PIVOT_DOT_FADE_MS}ms ease-out`,
    zIndex: "5",
    left: "-99px",
    top: "-99px",
  } satisfies Partial<CSSStyleDeclaration>);
  if (holder !== canvas && typeof document !== "undefined") holder.appendChild(dot);
  let fade: ReturnType<typeof setTimeout> | undefined;
  const place = () => {
    // OrbitControls' lookAt leaves the camera's world matrix half updated (new position, old turn) until the frame
    h.camera.updateMatrixWorld();
    const p = controls.target.clone().project(h.camera);
    const w = canvas.clientWidth;
    const hh = canvas.clientHeight;
    dot.style.left = `${canvas.offsetLeft + ((p.x + 1) / 2) * w}px`;
    dot.style.top = `${canvas.offsetTop + ((1 - p.y) / 2) * hh}px`;
  };
  const showDot = (hold: boolean) => {
    clearTimeout(fade);
    place();
    dot.style.transition = "none";
    dot.style.opacity = "1";
    if (!hold) hideDotSoon();
  };
  const hideDotSoon = () => {
    clearTimeout(fade);
    // shown, then faded over PIVOT_DOT_FADE_MS (the damping's tail is still turning about it meanwhile)
    fade = setTimeout(() => {
      dot.style.transition = `opacity ${PIVOT_DOT_FADE_MS}ms ease-out`;
      dot.style.opacity = "0";
    }, 0);
  };
  const onChange = () => {
    if (dot.style.opacity !== "0") place();
  };
  controls.addEventListener("change", onChange);

  return {
    limits,
    zoomAt,
    flashPivot: () => showDot(false),
    dispose: () => {
      holder.removeEventListener("wheel", onWheel, { capture: true });
      controls.removeEventListener("start", onStart);
      controls.removeEventListener("end", onEnd);
      controls.removeEventListener("change", onChange);
      clearTimeout(fade);
      dot.remove();
      controls.minDistance = 0;
      controls.maxDistance = Infinity;
    },
  };
}
