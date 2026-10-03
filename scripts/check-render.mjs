/**
 * Render check for a running viewer (dev server or `uhd-viewer serve`):
 * the diagram, the inspector's artifacts for a part and an assembly, and the
 * 3D view, with every failed request reported.
 *
 *   node scripts/check-render.mjs <viewer-url> <out-dir>
 *   node scripts/check-render.mjs compare <dir-a> <dir-b>
 *
 * The first form writes one PNG per view and summary.json to <out-dir> and
 * exits 1 if any request failed (a missing favicon aside) or a view did not
 * render. The second compares the PNGs of two runs pixel by pixel.
 * Needs Chrome (CHROME, default /usr/bin/google-chrome).
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const W = 1600;
const H = 1000;

const launch = () =>
  puppeteer.launch({
    executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--hide-scrollbars", `--window-size=${W},${H}`],
    defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  });

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

/** `base` with view parameters added (it may already carry ?bundle=). */
function at(base, query) {
  const url = new URL(base);
  for (const [k, v] of new URLSearchParams(query)) url.searchParams.set(k, v);
  return url.href;
}

/**
 * One page visit: waits for `ready` in the page, records requests.
 * @param {import("puppeteer-core").Browser} browser
 */
async function visit(browser, url, ready, timeout = 180000) {
  const page = await browser.newPage();
  const failed = [];
  const errors = [];
  let ok = 0;
  page.on("requestfailed", (r) => failed.push(`${r.url()} (${r.failure()?.errorText})`));
  page.on("response", (r) => {
    if (r.status() >= 400) failed.push(`${r.url()} (${r.status()})`);
    else ok++;
  });
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  // fresh layout state for every run (dev and served runs share no storage, but be explicit)
  await page.evaluateOnNewDocument(() => localStorage.clear());
  await page.goto(url, { waitUntil: "networkidle0", timeout });
  await page.waitForFunction(ready, { timeout });
  await settle(1500);
  return { page, failed: () => failed.filter((f) => !/favicon\.ico/.test(f)), errors, ok: () => ok };
}

const VIEWS = [
  {
    name: "01-diagram",
    query: "",
    ready: () => document.querySelectorAll(".react-flow__node").length > 5,
    measure: () => ({ nodes: document.querySelectorAll(".react-flow__node").length, edges: document.querySelectorAll(".react-flow__edge").length }),
  },
  {
    name: "02-inspector-part",
    query: "select=node:video",
    ready: () => /DRAG TO ROTATE|MODEL NOT FOUND/.test(document.querySelector(".artifact-cad-hint")?.textContent ?? ""),
    measure: artifactState,
  },
  {
    name: "03-inspector-assembly",
    query: "select=node:stack",
    ready: () => /DRAG TO ROTATE|MODEL NOT FOUND/.test(document.querySelector(".artifact-cad-hint")?.textContent ?? ""),
    measure: artifactState,
  },
  {
    name: "04-checks",
    query: "panel=checks",
    ready: () => document.querySelectorAll(".check").length > 0,
    measure: () => ({ checks: document.querySelectorAll(".check").length, summary: document.querySelector(".check-summary")?.textContent }),
  },
  {
    name: "05-3d",
    query: "view=3d",
    // every body GLB placed (CadView counts them)
    // CadView's capture hook (src/cad/CadView.tsx); these run in the page
    ready: () => /** @type {any} */ (window).__cad?.ready() >= 16,
    measure: () => ({ bodiesLoaded: /** @type {any} */ (window).__cad.ready() }),
    extraSettle: 5000, // harness and hardware GLBs load after the bodies
  },
];

/** In the page: the inspector preview's state and whether every listed artifact file answers. */
async function artifactState() {
  const hint = document.querySelector(".artifact-cad-hint")?.textContent;
  const thumb = document.querySelector("img.artifact-thumb, .artifact-thumb img");
  const links = [...document.querySelectorAll("a.artifact-file")].map((a) => /** @type {HTMLAnchorElement} */ (a).href);
  // read whole: Chrome reports a HEAD or an unread body as an aborted request
  const files = await Promise.all(links.map(async (href) => fetch(href).then(async (r) => [href, r.status, (await r.arrayBuffer()).byteLength])));
  const img = /** @type {HTMLImageElement | null} */ (thumb);
  return { hint, thumbnail: img ? { src: img.src, loaded: img.complete && img.naturalWidth > 0 } : null, files };
}

async function check(base, out) {
  mkdirSync(out, { recursive: true });
  const browser = await launch();
  const summary = { base, views: {} };
  let bad = false;
  try {
    for (const v of VIEWS) {
      const { page, failed, errors, ok } = await visit(browser, at(base, v.query), v.ready);
      if (v.extraSettle) await settle(v.extraSettle);
      const measured = await page.evaluate(v.measure);
      await page.screenshot({ path: join(out, `${v.name}.png`) });
      const fileFailures = (measured.files ?? []).filter(([, status]) => status !== 200);
      const result = { url: page.url(), okResponses: ok(), failedRequests: failed(), consoleErrors: errors, ...measured };
      summary.views[v.name] = result;
      if (failed().length || fileFailures.length || /NOT FOUND/.test(measured.hint ?? "")) bad = true;
      console.log(`${v.name}: ${ok()} ok, ${failed().length} failed${fileFailures.length ? `, ${fileFailures.length} artifact files missing` : ""}`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(`${out}/summary.json`);
  return bad ? 1 : 0;
}

/** Fraction of pixels that differ (any channel by more than 8) between same-named PNGs. */
async function compare(a, b) {
  const browser = await launch();
  const page = await browser.newPage();
  const rows = [];
  try {
    for (const name of readdirSync(a).filter((f) => f.endsWith(".png"))) {
      const [x, y] = [a, b].map((d) => `data:image/png;base64,${readFileSync(join(d, name)).toString("base64")}`);
      const diff = await page.evaluate(async (x, y) => {
        const load = (src) => new Promise((ok) => Object.assign(new Image(), { onload() { ok(this); }, src }));
        const [i, j] = await Promise.all([load(x), load(y)]);
        const px = (img) => {
          const c = Object.assign(document.createElement("canvas"), { width: img.width, height: img.height });
          const g = /** @type {CanvasRenderingContext2D} */ (c.getContext("2d"));
          g.drawImage(img, 0, 0);
          return g.getImageData(0, 0, img.width, img.height).data;
        };
        const [p, q] = [px(i), px(j)];
        if (p.length !== q.length) return 1;
        let n = 0;
        for (let k = 0; k < p.length; k += 4) if (Math.abs(p[k] - q[k]) > 8 || Math.abs(p[k + 1] - q[k + 1]) > 8 || Math.abs(p[k + 2] - q[k + 2]) > 8) n++;
        return n / (p.length / 4);
      }, x, y);
      rows.push([name, diff]);
      console.log(`${name}: ${(diff * 100).toFixed(2)}% of pixels differ`);
    }
  } finally {
    await browser.close();
  }
  return rows;
}

const [first, second, third] = process.argv.slice(2);
if (first === "compare" && second && third) await compare(second, third);
else if (first && second) process.exitCode = await check(first, second);
else {
  console.error("usage: node scripts/check-render.mjs <viewer-url> <out-dir> | compare <dir-a> <dir-b>");
  process.exitCode = 2;
}
