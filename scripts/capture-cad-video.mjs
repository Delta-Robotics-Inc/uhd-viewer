/**
 * Record the 3D view: rotation, assembled ⇄ exploded, labels on/off (PB-775).
 *
 *   FFMPEG=/path/to/ffmpeg node scripts/capture-cad-video.mjs [out.mp4]
 *
 * Needs the dev server (npm run dev, port 5178) and Google Chrome. Frames are
 * rendered deterministically through window.__cad.set(...) (CadView), one
 * screenshot per frame, piped into ffmpeg (H.264, 30 fps).
 */
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";

const OUT = process.argv[2] ?? "docs/video/quadcopter-3d.mp4";
const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
const FPS = 30;
const W = 1920;
const H = 1080;

// storyboard (seconds)
const T = 28;
const explodeAt = (t) => (t < 8 ? 0 : t < 10 ? (t - 8) / 2 : t < 19 ? 1 : t < 21 ? 1 - (t - 19) / 2 : 0);
const labelsAt = (t) => (t >= 3 && t < 15.5) || t >= 22;
const captionAt = (t) =>
  t < 3
    ? ["Assembled from UHD links", "every module placed by its mating interfaces"]
    : t < 8
      ? ["Modules, harnesses, hardware", "labels follow the model, always facing the camera"]
      : t < 15.5
        ? ["Exploded along each mate", "fastener stacks come apart along their joints"]
        : t < 19
          ? ["Exploded, labels off", ""]
          : t < 22
            ? ["Reassembling", "motor faces return to their arm pads"]
            : ["Assembled", "72 fasteners · 4 phase harnesses · 16 bodies"];

/** Software WebGL (SwiftShader) with CPU raster and compositing: without the last three, zoomed diagrams keep stale tiles (PB-873). */
const HEADLESS_GL = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-rasterization", "--disable-partial-raster", "--disable-gpu-compositing"];
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
  headless: "new",
  args: [...HEADLESS_GL, "--hide-scrollbars", `--window-size=${W},${H}`],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
// with GPU compositing off, Chrome never reports network idle on a WebGL page: wait for the requests instead
await page.goto("http://localhost:5178/?view=3d&present=1&labels=0", { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForNetworkIdle({ idleTime: 500, timeout: 120000 });
await page.waitForFunction(() => window.__cad && window.__cad.ready() >= 16, { timeout: 120000 });
await new Promise((r) => setTimeout(r, 3000)); // hardware GLBs

const ff = spawn(FFMPEG, ["-y", "-f", "image2pipe", "-framerate", String(FPS), "-i", "-", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "slow", "-movflags", "+faststart", OUT], {
  stdio: ["pipe", "inherit", "inherit"],
});

const frames = T * FPS;
for (let i = 0; i < frames; i++) {
  const t = i / FPS;
  const ex = explodeAt(t);
  const state = {
    azimuth: -58 + (360 * t) / T,
    elevation: 26 + 6 * Math.sin((2 * Math.PI * t) / T),
    distance: 430 + 100 * ex,
    explode: ex,
    labels: labelsAt(t),
    caption: captionAt(t),
  };
  await page.evaluate((s) => window.__cad.set(s), state);
  const buf = await page.screenshot({ type: "jpeg", quality: 92 });
  if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
  if (i % 60 === 0) process.stdout.write(`\rframe ${i}/${frames}`);
}
ff.stdin.end();
await new Promise((r) => ff.on("close", r));
await browser.close();
console.log(`\nwrote ${OUT}`);
