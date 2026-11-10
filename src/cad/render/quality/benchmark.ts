/**
 * The live-view budget and the display's frame period (PB-1176; review-round-1
 * README §5).
 *
 * WebGL resources cannot cross contexts, every VS Code webview panel is its
 * own page, and Chromium caps live WebGL contexts per process (reported at 8
 * or 16; the oldest is lost). So the host keeps at most `maxLiveViews` views
 * live; the least recently used drops to its snapshot (`suspend()`), and is
 * resumed when shown. The budget comes from a one-second benchmark on first
 * load: 1 on software rendering or weak graphics, 2 on integrated, 4 on
 * discrete. The host stores the result with the viewer state, keyed by
 * `benchmarkKey` (renderer string, device pixel ratio, screen), and runs it
 * again when the key changes. The policy (which view to drop) is the host's;
 * `viewsToSuspend` is a helper for it.
 */
import * as THREE from "three";

export type LiveViews = 1 | 2 | 4;

export interface LiveViewBenchmark {
  maxLiveViews: LiveViews;
  /** Median frame time of the synthetic scene, render plus GPU completion (ms). */
  medianMs: number;
  frames: number;
  /** The GPU's renderer string (WEBGL_debug_renderer_info), when the browser gives it. */
  renderer: string;
  software: boolean;
  dpr: number;
  screen: string;
  /** Storage key for the result (renderer x DPR x screen). */
  key: string;
  ms: number;
}

/** Renderer strings of software rasterisers. */
const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic|mesa offscreen/i;

/**
 * Live views for a benchmark result. DEFAULT thresholds, calibrated on the
 * phase-1 machine (Intel UHD integrated, ANGLE d3d11) against SwiftShader:
 * median up to 4 ms: 4 (discrete-class), up to 20 ms: 2 (integrated; the
 * Intel UHD measured 6.2 ms), slower or software: 1.
 */
export function liveViewsFor(medianMs: number, renderer = ""): LiveViews {
  if (SOFTWARE.test(renderer) || !Number.isFinite(medianMs)) return 1;
  if (medianMs <= 4) return 4;
  if (medianMs <= 20) return 2;
  return 1;
}

export function benchmarkKey(renderer: string, dpr: number, screen: string): string {
  return `${renderer}|dpr ${dpr}|${screen}`;
}

/**
 * The views to suspend so that at most `max` stay live: the least recently
 * used visible-or-live ones beyond the budget. `views` carry the time each
 * was last shown or used; a suspended view is not counted.
 */
export function viewsToSuspend<T extends { id: string; lastUsed: number; suspended?: boolean }>(views: T[], max: number): T[] {
  const live = views.filter((v) => !v.suspended).sort((a, b) => b.lastUsed - a.lastUsed);
  return live.slice(Math.max(1, max));
}

/** The GPU's renderer string, where the browser exposes it. */
export function rendererString(gl: WebGLRenderingContext | WebGL2RenderingContext): string {
  try {
    const ext = gl.getExtension("WEBGL_debug_renderer_info") as { UNMASKED_RENDERER_WEBGL: number } | null;
    return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? "");
  } catch {
    return "";
  }
}

/**
 * One second of a synthetic scene on a small canvas of its own: 240 meshes
 * (draw calls) of an icosphere, about 300k triangles, 512 x 512 px, each frame
 * waited for (a one-pixel read). The canvas and its context are given back at
 * the end. Browser only.
 */
export async function runLiveViewBenchmark(options: { durationMs?: number; maxFrames?: number; size?: number } = {}): Promise<LiveViewBenchmark> {
  const t0 = performance.now();
  const durationMs = options.durationMs ?? 1000;
  const maxFrames = options.maxFrames ?? 90;
  const size = options.size ?? 512;
  const dpr = Math.min(globalThis.devicePixelRatio ?? 1, 2);
  const screen = typeof globalThis.screen !== "undefined" ? `${globalThis.screen.width}x${globalThis.screen.height}` : "unknown";
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  let renderer: THREE.WebGLRenderer | undefined;
  // 20 (detail + 1)^2 triangles: 1,280 per mesh, 307k for the 240 meshes
  const geometry = new THREE.IcosahedronGeometry(1, 7);
  const material = new THREE.MeshStandardMaterial({ color: 0x8899aa, roughness: 0.5, metalness: 0.2 });
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: false, powerPreference: "default" });
    renderer.setPixelRatio(1);
    renderer.setSize(size, size, false);
    const gl = renderer.getContext();
    const name = rendererString(gl);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x202020);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x333333, 1.5));
    const key = new THREE.DirectionalLight(0xffffff, 2);
    key.position.set(3, 4, 5);
    scene.add(key);
    const N = 240;
    for (let i = 0; i < N; i++) {
      const m = new THREE.Mesh(geometry, material);
      const a = (i / N) * Math.PI * 2 * 7;
      const r = 2 + (i / N) * 8;
      m.position.set(Math.cos(a) * r, Math.sin(a) * r, ((i % 12) - 6) * 0.6);
      m.scale.setScalar(0.6 + (i % 5) * 0.15);
      scene.add(m);
    }
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, -18, 14);
    camera.lookAt(0, 0, 0);
    const px = new Uint8Array(4);
    const times: number[] = [];
    // first frame compiles the program: not timed
    renderer.render(scene, camera);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const tStart = performance.now();
    for (let f = 0; f < maxFrames && performance.now() - tStart < durationMs; f++) {
      camera.position.applyAxisAngle(new THREE.Vector3(0, 0, 1), 0.05);
      camera.lookAt(0, 0, 0);
      const a = performance.now();
      renderer.render(scene, camera);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      times.push(performance.now() - a);
      // let the page breathe between frames (the benchmark runs while the view loads)
      if (f % 10 === 9) await new Promise((r) => setTimeout(r, 0));
    }
    const sorted = [...times].sort((x, y) => x - y);
    const medianMs = sorted.length ? sorted[Math.floor(sorted.length / 2)] : Infinity;
    const software = SOFTWARE.test(name);
    return {
      maxLiveViews: liveViewsFor(medianMs, name),
      medianMs: Math.round(medianMs * 100) / 100,
      frames: times.length,
      renderer: name,
      software,
      dpr,
      screen,
      key: benchmarkKey(name, dpr, screen),
      ms: Math.round(performance.now() - t0),
    };
  } catch (e) {
    console.warn("[cad] live-view benchmark failed:", e);
    return { maxLiveViews: 1, medianMs: Infinity, frames: 0, renderer: "", software: false, dpr, screen, key: benchmarkKey("", dpr, screen), ms: Math.round(performance.now() - t0) };
  } finally {
    geometry.dispose();
    material.dispose();
    if (renderer) {
      renderer.dispose();
      // give the context back now: browsers cap live contexts
      renderer.forceContextLoss();
    }
  }
}

/**
 * The frame budget from the display's frame period (ms). DEFAULT (PB-1176, revisit): the budget is never
 * tighter than 60 Hz (16.7 ms) nor looser than 30 Hz (33.3 ms). A 120 Hz display would otherwise make a model
 * that orbits at 68 fps (ClientX, 14.7 ms) give up detail to reach 120; and headless Chrome, which runs
 * animation frames unthrottled (5.9 ms apart on the phase-1 machine), would ask the same.
 */
export function budgetFromPeriod(periodMs: number): number {
  if (!Number.isFinite(periodMs) || periodMs <= 0) return 1000 / 60;
  return Math.min(1000 / 30, Math.max(1000 / 60, periodMs));
}

/**
 * The display's frame period (ms) from a few animation frames: the 20th
 * percentile of the gaps (frames cannot come faster than the display; a busy
 * page, such as one still loading its models, only makes gaps longer).
 * Browser only.
 */
export function measureDisplayPeriod(frames = 12): Promise<number> {
  if (typeof requestAnimationFrame !== "function") return Promise.resolve(1000 / 60);
  return new Promise<number>((resolve) => {
    const stamps: number[] = [];
    const step = (t: number) => {
      stamps.push(t);
      if (stamps.length <= frames) requestAnimationFrame(step);
      else {
        const gaps = stamps.slice(1).map((s, i) => s - stamps[i]).sort((a, b) => a - b);
        resolve(gaps[Math.floor(gaps.length * 0.2)] ?? 1000 / 60);
      }
    };
    requestAnimationFrame(step);
    // a hidden page runs no animation frames: assume 60 Hz rather than wait
    setTimeout(() => resolve(1000 / 60), 1000);
  });
}
