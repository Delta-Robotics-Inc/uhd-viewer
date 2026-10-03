/**
 * Screenshots of the board and enclosure views (PB-823) on the sample
 * fixtures (fixtures/README.md), from a running dev server:
 *
 *   npm run dev -- --port 5191 &
 *   node scripts/capture-board-shots.mjs http://127.0.0.1:5191 <out-dir>
 *
 * Writes one PNG per view and summary.json (page errors and failed requests
 * per shot); exits 1 if any shot had either. SHOTS=<regex> picks some.
 * Needs Chrome (CHROME, default /usr/bin/google-chrome).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const [base, out] = process.argv.slice(2);
if (!base || !out) {
  console.error("usage: node scripts/capture-board-shots.mjs <viewer-url> <out-dir>");
  process.exit(2);
}
const fixtures = fileURLToPath(new URL("../fixtures/imu-pod/", import.meta.url));
const POD = `/@fs${fixtures}uhd-bundle.json`;
const BOARD = `/@fs${fixtures}imu-board.bundle.json`;
const W = 1600;
const H = 1000;
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

/** In the page: click the first element matching `selector` whose text matches `text`. */
const click = (selector, text) => (page) =>
  page.evaluate(
    (sel, t) => {
      const el = [...document.querySelectorAll(sel)].find((e) => new RegExp(t).test(e.textContent ?? ""));
      if (!el) throw new Error(`no ${sel} with ${t}`);
      el.click();
    },
    selector,
    text,
  );
/**
 * Wheel-zooms the PCB drawing; a problem if the inspector scrolled as well
 * (the drawing's wheel listener must not be passive).
 */
const wheelZoom = async (page) => {
  const box = await (await page.$(".board-drawing-view")).boundingBox();
  const before = await page.$eval(".inspector-body", (el) => el.scrollTop);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel({ deltaY: -300 });
  await settle(300);
  const after = await page.$eval(".inspector-body", (el) => el.scrollTop);
  return after !== before ? `inspector scrolled ${before} → ${after} on a drawing wheel zoom` : undefined;
};

// readiness checks run in the page, so they take their argument from waitForFunction
const bodies = (n) => /** @type {any} */ (window).__cad?.ready() >= n;
const nodes = () => document.querySelectorAll(".react-flow__node").length > 3;

const SHOTS = [
  { name: "01-board-diagram", bundle: BOARD, query: "", ready: nodes },
  { name: "02-board-component-pcb-top", bundle: BOARD, query: "select=node:u2", ready: nodes },
  { name: "03-board-component-pcb-bottom", bundle: BOARD, query: "select=node:r1", ready: nodes },
  { name: "04-board-schematic", bundle: BOARD, query: "", ready: nodes, then: click(".board-tabs button", "SCHEMATIC") },
  { name: "05-board-net", bundle: BOARD, query: "select=node::sda&mode=signal", ready: nodes },
  { name: "06-board-derived-link", bundle: BOARD, query: "mode=signal", ready: nodes, then: click(".tree-item", "I2C 0") },
  { name: "07-board-bus-incomplete", bundle: BOARD, query: "scenario=imu-sdx-int1-swapped&mode=drc", ready: nodes, then: click(".tree-item", "I2C 0") },
  { name: "08-board-bus-incomplete-checks", bundle: BOARD, query: "scenario=imu-sdx-int1-swapped&mode=drc&panel=checks", ready: nodes },
  { name: "09-board-gnd-wires", bundle: BOARD, query: "grounds=1", ready: nodes },
  { name: "10-pod-diagram", bundle: POD, query: "select=node:board", ready: () => document.querySelectorAll(".react-flow__node").length >= 2 },
  { name: "11-pod-drill-board", bundle: POD, query: "drill=board&panel=checks", ready: nodes },
  { name: "12-pod-3d-findings", bundle: POD, query: "view=3d&labels=0", ready: bodies, arg: 2, wait: 4000 },
  { name: "13-pod-3d-xray", bundle: POD, query: "view=3d&xray=1&labels=0", ready: bodies, arg: 2, wait: 4000 },
  { name: "14-pod-3d-section", bundle: POD, query: "view=3d&section=y&at=0.5&labels=0&findings=0", ready: bodies, arg: 2, wait: 4000 },
  { name: "15-pod-3d-exploded", bundle: POD, query: "view=3d&explode=1&findings=0", ready: bodies, arg: 2, wait: 4000 },
  { name: "16-pod-3d-component", bundle: POD, query: "view=3d&xray=1&labels=0&findings=0&body=board&component=u1", ready: bodies, arg: 2, wait: 4000 },
  { name: "17-board-3d", bundle: BOARD, query: "view=3d&labels=0", ready: bodies, arg: 1, wait: 4000 },
  { name: "18-board-pcb-wheel-zoom", bundle: BOARD, query: "select=node:u2", ready: nodes, then: wheelZoom },
];

mkdirSync(out, { recursive: true });
const pick = process.env.SHOTS ? new RegExp(process.env.SHOTS) : null;
/** Software WebGL (SwiftShader) with CPU raster and compositing: without the last three, zoomed diagrams keep stale tiles (PB-873). */
const HEADLESS_GL = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-rasterization", "--disable-partial-raster", "--disable-gpu-compositing"];
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", ...HEADLESS_GL, "--hide-scrollbars", `--window-size=${W},${H}`],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
});
const summary = {};
let bad = false;
try {
  for (const shot of SHOTS) {
    if (pick && !pick.test(shot.name)) continue;
    const page = await browser.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push(String(e)));
    page.on("console", (m) => m.type() === "error" && !/favicon|status of 404/.test(m.text()) && problems.push(m.text()));
    page.on("response", (r) => r.status() >= 400 && !/favicon\.ico/.test(r.url()) && problems.push(`${r.status()} ${r.url()}`));
    await page.evaluateOnNewDocument(() => localStorage.clear());
    const url = new URL(base);
    url.searchParams.set("bundle", shot.bundle);
    for (const [k, v] of new URLSearchParams(shot.query)) url.searchParams.set(k, v);
    // with GPU compositing off, Chrome never reports network idle on a WebGL page: wait for the requests instead
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 120000 });
    await page.waitForFunction(shot.ready, { timeout: 120000 }, shot.arg);
    await settle(shot.wait ?? 1500);
    if (shot.then) {
      const problem = await shot.then(page);
      if (problem) problems.push(problem);
      await settle(1500);
    }
    await page.screenshot({ path: join(out, `${shot.name}.png`) });
    summary[shot.name] = { url: url.href, problems };
    if (problems.length) bad = true;
    console.log(`${shot.name}${problems.length ? `: ${problems.join("; ")}` : ""}`);
    await page.close();
  }
} finally {
  await browser.close();
}
writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2));
process.exit(bad ? 1 : 0);
