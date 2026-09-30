/**
 * Still renders of the 3D view for review and documentation.
 *
 *   node scripts/capture-cad-stills.mjs <out-dir> [url-query]
 *
 * Needs the dev server (npm run dev, port 5178) and Chrome (CHROME, default:
 * the newest puppeteer Chrome in ~/.cache/puppeteer, else google-chrome).
 * Every shot is set deterministically through window.__cad.set (CadView):
 * assembled from several angles, exploded, and close-ups of the stack and of
 * a motor arm.
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const OUT = process.argv[2] ?? "docs/screenshots/cad";
const QUERY = process.argv[3] ?? "";
const W = 1600;
const H = 1000;

function chrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = join(homedir(), ".cache/puppeteer/chrome");
  if (existsSync(base)) {
    const v = readdirSync(base).sort().pop();
    const p = v && join(base, v, "chrome-linux64/chrome");
    if (p && existsSync(p)) return p;
  }
  return "/usr/bin/google-chrome";
}

/** name → camera (target in mm, frame coordinates: X forward, Y left, Z up). */
const SHOTS = [
  ["01-assembled-front-left", { azimuth: 35, elevation: 26, distance: 470 }],
  ["02-assembled-rear-right", { azimuth: -140, elevation: 30, distance: 470 }],
  ["03-assembled-top", { azimuth: -90, elevation: 88, distance: 480 }],
  ["04-assembled-side", { azimuth: -90, elevation: 6, distance: 440 }],
  ["05-exploded", { azimuth: -58, elevation: 28, distance: 560, explode: 1 }],
  ["06-labels", { azimuth: -58, elevation: 28, distance: 520, labels: true }],
  ["07-stack-closeup", { azimuth: -125, elevation: 32, distance: 150, target: [-6, 0, 22] }],
  ["08-stack-closeup-right", { azimuth: -60, elevation: 22, distance: 150, target: [0, -8, 20] }],
  ["09-arm-front-left", { azimuth: 150, elevation: 38, distance: 190, target: [45, 45, 12] }],
  ["10-arm-rear-right", { azimuth: -20, elevation: 40, distance: 190, target: [-45, -45, 12] }],
  ["11-underside", { azimuth: -40, elevation: -35, distance: 430 }],
  ["12-rear-receiver", { azimuth: 180, elevation: 25, distance: 200, target: [-40, 0, 25] }],
  ["13-rear-stack", { azimuth: 150, elevation: 30, distance: 130, target: [-32, 0, 22] }],
  ["14-front-stack", { azimuth: 25, elevation: 22, distance: 130, target: [22, 0, 18] }],
  ["15-rear-stack-right", { azimuth: -140, elevation: 28, distance: 130, target: [-30, -8, 22] }],
];
const ONLY = process.env.SHOTS ? new RegExp(process.env.SHOTS) : null;

mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: chrome(),
  headless: "new",
  args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--hide-scrollbars", `--window-size=${W},${H}`],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
page.on("console", (m) => m.type() === "error" && console.error("[page]", m.text()));
await page.goto(`http://localhost:5178/?view=3d&present=1&labels=0${QUERY}`, { waitUntil: "networkidle0", timeout: 180000 });
await page.waitForFunction(() => window.__cad && window.__cad.ready() >= 16, { timeout: 180000 });
await new Promise((r) => setTimeout(r, 5000)); // hardware and harness GLBs

for (const [name, s] of SHOTS.filter(([n]) => !ONLY || ONLY.test(n))) {
  await page.evaluate((st) => window.__cad.set({ explode: 0, labels: false, snap: true, ...st }), s);
  await new Promise((r) => setTimeout(r, 400));
  await page.evaluate((st) => window.__cad.set({ explode: 0, labels: false, snap: true, ...st }), s);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`${OUT}/${name}.png`);
}
await browser.close();
