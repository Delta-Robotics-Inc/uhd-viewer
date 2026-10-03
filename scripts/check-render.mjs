/**
 * Render check for a running viewer (dev server or `uhd-viewer serve`):
 * the diagram, the inspector's artifacts for a part and an assembly, and the
 * 3D view, with every failed request reported.
 *
 *   node scripts/check-render.mjs <viewer-url> <out-dir>
 *   node scripts/check-render.mjs compare <dir-a> <dir-b>
 *   node scripts/check-render.mjs host <bundle.json> <out-dir>
 *   node scripts/check-render.mjs messages <bundle.json> <out-dir>
 *
 * The first form writes one PNG per view and summary.json to <out-dir> and
 * exits 1 if any request failed (a missing favicon aside) or a view did not
 * render. The second compares the PNGs of two runs pixel by pixel. The third
 * checks the library build (dist/lib) as a host uses it: see checkHost. The
 * fourth drives the built app in a frame through host messages: see
 * checkMessages.
 * Needs Chrome (CHROME, default /usr/bin/google-chrome).
 */
import { createReadStream, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { viewerHandler } from "../bin/serve.mjs";

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

/** Console errors other than failed loads (those are counted from the requests, where a missing favicon can be told apart). */
const pageErrors = (errors) => errors.filter((e) => !/^Failed to load resource/.test(e));

/** A host page: mounts the library with its own diagnostics, resolver and layout handler. */
const HOST_PAGE = `<!doctype html>
<html>
  <head><meta charset="utf-8"><link rel="stylesheet" href="/lib/uhd-viewer.css"></head>
  <body style="margin:0">
    <div id="viewer" style="height:100vh"></div>
    <script type="module">
      import { mountViewer } from "/lib/uhd-viewer.js";
      const page = (window.host = { layouts: [], resolved: 0, events: [] });
      page.viewer = mountViewer(document.getElementById("viewer"), {
        onReady: () => page.events.push({ type: "ready" }),
        onSelectionChanged: (selection) => page.events.push({ type: "selection", selection }),
        bundleUrl: "/uhd-bundle.json",
        diagnostics: [{ code: "HOST_CHECK", severity: "warning", message: "a finding from the host page", validator: "host-check" }],
        resolveArtifact: (id, file, fallback) => (page.resolved++, fallback(id, file)),
        onLayoutChange: (layout) => page.layouts.push(layout),
      });
    </script>
  </body>
</html>`;

/**
 * The library as a host uses it (the contract `protoboard dev` relies on):
 * dist/lib mounted in a page of its own, next to the bundle and artifacts
 * served by viewerHandler. Checks that host diagnostics are listed and
 * replaced by update(); that a dragged node reaches onLayoutChange and not
 * local storage; that a layout passed back through update() moves the node
 * and is not sent back; that the 3D view resolves artifacts through the host's
 * resolver; and that no request fails.
 */
async function checkHost(bundleFile, out) {
  mkdirSync(out, { recursive: true });
  const lib = fileURLToPath(new URL("../dist/lib/", import.meta.url));
  const viewer = viewerHandler({ bundleFile });
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/host.html") return res.writeHead(200, { "content-type": "text/html" }).end(HOST_PAGE);
    const file = { "/lib/uhd-viewer.js": "uhd-viewer.js", "/lib/uhd-viewer.css": "uhd-viewer.css" }[path];
    if (file) return createReadStream(join(lib, file)).pipe(res.writeHead(200, { "content-type": file.endsWith(".css") ? "text/css" : "text/javascript" }));
    return viewer(req, res);
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(undefined)));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/host.html`;
  const browser = await launch();
  const results = [];
  const expect = (name, ok, detail) => {
    results.push({ name, ok: Boolean(ok), detail });
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: ${JSON.stringify(detail)}`}`);
  };
  const failures = [];
  try {
    // diagram: diagnostics, layout to the host, layout from the host
    const diagram = await visit(browser, at(base, "panel=checks"), () => document.querySelectorAll(".react-flow__node").length > 5);
    const { page } = diagram;
    const hostChecks = () => page.evaluate(() => [...document.querySelectorAll(".check")].map((c) => c.textContent ?? "").filter((t) => /HOST/.test(t)));
    expect("host diagnostic listed", (await hostChecks()).some((t) => t.includes("HOST CHECK")), await hostChecks());
    await page.screenshot({ path: join(out, "06-library-host.png") });

    // drag the first leaf node 120 px right
    const target = await page.evaluate(() => {
      const leaf = [...document.querySelectorAll(".react-flow__node")].find((n) => !n.querySelector(".react-flow__node") && n.getBoundingClientRect().width > 40);
      if (!leaf) return null;
      const r = leaf.getBoundingClientRect();
      return { id: leaf.getAttribute("data-id") ?? "", x: r.x + r.width / 2, y: r.y + 12 };
    });
    if (!target) throw new Error("no node to drag");
    await page.mouse.move(target.x, target.y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(target.x + i * 10, target.y, { steps: 2 });
    await page.mouse.up();
    await settle(800);
    const dragged = await page.evaluate(() => ({
      calls: /** @type {any} */ (window).host.layouts.length,
      last: /** @type {any} */ (window).host.layouts.at(-1),
      stored: Object.keys(localStorage).filter((k) => k.startsWith("uhd-viewer:")),
    }));
    const moved = dragged.last?.positions?.[""]?.[target.id];
    expect("drag reaches onLayoutChange", dragged.calls >= 1 && moved, dragged);
    expect("layout not kept in local storage", !dragged.stored.some((k) => /positions|links/.test(k)), dragged.stored);

    // the host passes back what it was sent (a save and reload): nothing changes, nothing is sent
    await page.evaluate((l) => /** @type {any} */ (window).host.viewer.update({ layout: structuredClone(l) }), dragged.last);
    await settle(800);
    const echoed = await page.evaluate(() => /** @type {any} */ (window).host.layouts.length);
    expect("own layout passed back is not sent again", echoed === dragged.calls, { before: dragged.calls, after: echoed });

    // the host's saved layout changed (edited elsewhere): the node moves there, nothing is sent back
    // on the diagram's 16 px grid, as a dragged position is
    const there = { x: Math.round((moved.x + 200) / 16) * 16, y: Math.round(moved.y / 16) * 16 };
    const transform = () => page.evaluate((id) => /** @type {HTMLElement | null} */ (document.querySelector(`.react-flow__node[data-id="${id}"]`))?.style.transform, target.id);
    await page.evaluate((l) => /** @type {any} */ (window).host.viewer.update({ layout: l }), { positions: { "": { [target.id]: there } }, links: {} });
    await settle(800);
    const applied = { transform: await transform(), calls: await page.evaluate(() => /** @type {any} */ (window).host.layouts.length) };
    expect("layout from update() applied", applied.transform?.includes(`${there.x}px`), { there, ...applied });
    expect("layout from update() not sent back", applied.calls === dragged.calls, applied);

    // update() replaces the host diagnostics
    await page.evaluate(() => /** @type {any} */ (window).host.viewer.update({ diagnostics: [{ code: "HOST_UPDATED", severity: "error", message: "replaced through update()" }] }));
    await settle(500);
    const updated = await hostChecks();
    expect("update() replaces host diagnostics", updated.some((t) => t.includes("HOST UPDATED")) && !updated.some((t) => t.includes("HOST CHECK")), updated);
    // the handle's host methods: ready came, focus selects through the callbacks, no open actions without their callbacks
    const handled = await page.evaluate(async () => {
      const host = /** @type {any} */ (window).host;
      host.viewer.focus("stack/esc");
      await new Promise((r) => setTimeout(r, 800));
      const out = { events: host.events.slice(), selected: document.querySelector(".react-flow__node.selected")?.getAttribute("data-id"), openSource: Boolean(document.querySelector(".open-source")) };
      host.viewer.select([]);
      await new Promise((r) => setTimeout(r, 300));
      return { ...out, after: host.events.at(-1) };
    });
    expect("handle: ready, then focus → onSelectionChanged", handled.events[0]?.type === "ready" && handled.events.some((e) => e.selection?.id === "stack/esc" && e.selection?.defId), handled);
    expect("handle: no OPEN SOURCE without onOpenSource", !handled.openSource, handled);
    expect("handle: select([]) clears the selection", handled.after?.type === "selection" && handled.after.selection === null, handled.after);
    failures.push(...diagram.failed(), ...pageErrors(diagram.errors));
    await page.close();

    // 3D: every artifact through the host's resolver
    const cad = await visit(browser, at(base, "view=3d"), () => /** @type {any} */ (window).__cad?.ready() >= 16);
    await settle(5000);
    const state = await cad.page.evaluate(() => ({ bodies: /** @type {any} */ (window).__cad.ready(), resolved: /** @type {any} */ (window).host.resolved }));
    expect("3D artifacts through the host resolver", state.bodies >= 16 && state.resolved > 0, state);
    await cad.page.screenshot({ path: join(out, "07-library-host-3d.png") });
    failures.push(...cad.failed(), ...pageErrors(cad.errors));
    await cad.page.close();
    expect("no failed requests or page errors", failures.length === 0, failures);
  } finally {
    await browser.close();
    server.closeAllConnections();
    server.close();
  }
  writeFileSync(join(out, "host-summary.json"), JSON.stringify({ bundleFile, results, failures }, null, 2));
  console.log(`${out}/host-summary.json`);
  return results.every((r) => r.ok) ? 0 : 1;
}

/**
 * The outer host page for checkMessages: frames the app (another origin) and
 * records what the frame posts. `window.send(message)` posts to the frame.
 */
const OUTER_PAGE = (src) => `<!doctype html>
<html>
  <body style="margin:0">
    <iframe id="viewer" src="${src}" style="border:0;width:100vw;height:100vh;display:block"></iframe>
    <script>
      const frame = document.getElementById("viewer");
      window.events = [];
      window.addEventListener("message", (e) => {
        if (e.source === frame.contentWindow && String(e.data?.type).startsWith("uhd-viewer:")) window.events.push({ ...e.data, origin: e.origin });
      });
      window.send = (message) => frame.contentWindow.postMessage(message, new URL(frame.src).origin);
    </script>
  </body>
</html>`;

/**
 * Host messages through postMessage, as a host frames the viewer (a VS Code
 * webview, a web app): the built app on one origin (localhost), in a frame of
 * a page on another (127.0.0.1) that it allows with ?hostOrigin=. Checks that
 * the frame says it is ready; that focus drills to a module's level, selects
 * it and brings it into view, and the frame reports the selection; that drill,
 * select and setView apply; that OPEN SOURCE and an artifact row reach the
 * host (and no tab opens); that a frame which does not allow the page's
 * origin ignores it and sends nothing.
 */
async function checkMessages(bundleFile, out) {
  mkdirSync(out, { recursive: true });
  const app = createServer(viewerHandler({ bundleFile }));
  const outer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    res.writeHead(200, { "content-type": "text/html" }).end(OUTER_PAGE(url.searchParams.get("src") ?? ""));
  });
  const listen = (server) => new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(/** @type {any} */ (server.address()).port)));
  const appPort = await listen(app);
  const outerPort = await listen(outer);
  const hostOrigin = `http://127.0.0.1:${outerPort}`;
  const outerUrl = (query) => `${hostOrigin}/?src=${encodeURIComponent(`http://localhost:${appPort}/?${query}`)}`;
  const browser = await launch();
  const results = [];
  const expect = (name, ok, detail) => {
    results.push({ name, ok: Boolean(ok), detail });
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: ${JSON.stringify(detail)}`}`);
  };
  const failures = [];
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto(outerUrl(`hostOrigin=${encodeURIComponent(hostOrigin)}`), { waitUntil: "load", timeout: 120000 });
    const events = () => page.evaluate(() => /** @type {any} */ (window).events);
    const waitEvent = (pred, timeout = 30000, ...args) => page.waitForFunction(pred, { timeout }, ...args).then(() => true, () => false);
    expect("ready posted to the host's origin", await waitEvent(() => /** @type {any} */ (window).events.some((e) => e.type === "uhd-viewer:ready"), 120000), await events());
    const frame = page.frames().find((f) => f.url().startsWith(`http://localhost:${appPort}`));
    if (!frame) throw new Error("no viewer frame");
    await frame.waitForFunction(() => document.querySelectorAll(".react-flow__node").length > 5, { timeout: 60000 });
    const send = (m) => page.evaluate((m) => /** @type {any} */ (window).send(m), m);
    const state = () =>
      frame.evaluate(() => {
        const sel = document.querySelector(".react-flow__node.selected");
        const r = sel?.getBoundingClientRect();
        return {
          crumbs: [...document.querySelectorAll(".crumb")].map((c) => c.textContent),
          selected: sel?.getAttribute("data-id") ?? null,
          title: document.querySelector(".details-title")?.textContent ?? null,
          centre: r ? { x: r.x + r.width / 2, y: r.y + r.height / 2, w: innerWidth, h: innerHeight } : null,
          view: document.querySelector(".cad-view") ? "3d" : "diagram",
        };
      });
    const lastSelection = async () => (await events()).filter((e) => e.type === "uhd-viewer:selectionChanged").at(-1)?.selection;
    /** Until the frame reports a selection with this id (a render can take a second in software GL). */
    const selected = (id) =>
      waitEvent((id) => /** @type {any} */ (window).events.filter((e) => e.type === "uhd-viewer:selectionChanged").at(-1)?.selection?.id === id, 15000, id);

    // drill into the stack, then focus a module on another level
    await send({ type: "uhd-viewer:drill", path: "stack" });
    await frame.waitForFunction(() => document.querySelectorAll(".crumb").length === 2, { timeout: 15000 }).catch(() => undefined);
    const drilled = await state();
    expect("drill opens the stack", drilled.crumbs.length === 2 && /STACK/i.test(drilled.crumbs[1] ?? ""), drilled);
    await send({ type: "uhd-viewer:focus", path: "arm_fl/motor" });
    await selected("arm_fl/motor");
    // the view moves to the module (300 ms)
    await settle(2000);
    const focused = await state();
    const sel = await lastSelection();
    expect("focus selects the module on its level", focused.selected === "motor" || focused.selected === "arm_fl/motor", focused);
    expect("focus reports the selection with its definition", sel?.kind === "node" && sel.id === "arm_fl/motor" && Boolean(sel.defId), sel);
    // in view: clear of the inspector (360 px on the right) and the header
    const c = focused.centre;
    expect("focus brings the module into view", c && c.x > 40 && c.x < c.w - 380 && c.y > 50 && c.y < c.h - 60, c);
    await page.screenshot({ path: join(out, "08-messages-focus.png") });

    // select by canonical id on the level, a link, then nothing
    await send({ type: "uhd-viewer:focus", path: "video" });
    await selected("video");
    expect("focus from a drilled level returns to the top", (await state()).crumbs.length === 1 && (await lastSelection())?.id === "video", await state());
    // dji_o4 is the second half of the camera cable: drawn, and selected, as dji_fc
    await send({ type: "uhd-viewer:select", ids: ["no_such_thing", "link:dji_o4"] });
    await selected("dji_fc");
    const link = await lastSelection();
    expect("select picks the first id on the level (a link)", link?.kind === "link" && link.id === "dji_fc", link);
    await send({ type: "uhd-viewer:select", ids: ["gnss"] });
    await selected("gnss");
    await settle(300);
    expect("select picks a module", (await state()).selected === "gnss" && (await lastSelection())?.id === "gnss", await state());

    // open actions go to the host
    const tabs = (await browser.pages()).length;
    const clicked = await frame.evaluate(() => {
      const b = /** @type {HTMLButtonElement | null} */ (document.querySelector(".open-source"));
      b?.click();
      return Boolean(b);
    });
    await waitEvent(() => /** @type {any} */ (window).events.some((e) => e.type === "uhd-viewer:openSource"), 5000);
    const source = (await events()).filter((e) => e.type === "uhd-viewer:openSource").at(-1);
    expect("OPEN SOURCE reaches the host", clicked && source?.defId && source.instancePath === "gnss", { clicked, source });
    await send({ type: "uhd-viewer:focus", path: "video" });
    await selected("video");
    await settle(300);
    const artifact = await frame.evaluate(() => {
      const a = /** @type {HTMLAnchorElement | null} */ (document.querySelector("a.artifact-file[data-artifact]"));
      a?.click();
      return a?.dataset.artifact ?? null;
    });
    await waitEvent(() => /** @type {any} */ (window).events.some((e) => e.type === "uhd-viewer:openArtifact"), 5000);
    await settle(300);
    const opened = (await events()).filter((e) => e.type === "uhd-viewer:openArtifact").at(-1);
    expect("an artifact row reaches the host, no tab opens", artifact && opened?.artifactId === artifact && (await browser.pages()).length === tabs, { artifact, opened });
    expect("events are posted at the host's origin only", (await events()).every((e) => e.origin === `http://localhost:${appPort}`), [...new Set((await events()).map((e) => e.origin))]);

    // the 3D view: focus selects the module's body
    await send({ type: "uhd-viewer:setView", view: "3d" });
    await frame.waitForFunction(() => /** @type {any} */ (window).__cad?.ready() >= 10, { timeout: 120000 }).catch(() => undefined);
    await send({ type: "uhd-viewer:focus", path: "gnss" });
    await selected("gnss");
    await settle(1500);
    const cad = await state();
    const cadSel = await lastSelection();
    expect("setView shows the 3D view; focus there selects the body", cad.view === "3d" && cadSel?.id === "gnss", { view: cad.view, cadSel });
    await page.screenshot({ path: join(out, "09-messages-3d.png") });
    await send({ type: "uhd-viewer:setView", view: "diagram" });
    await frame.waitForFunction(() => !document.querySelector(".cad-view") && document.querySelectorAll(".react-flow__node").length > 5, { timeout: 15000 }).catch(() => undefined);
    expect("setView returns to the diagram", (await state()).view === "diagram", await state());
    failures.push(...pageErrors(errors));
    await page.close();

    // a frame that does not allow this page's origin: nothing in, nothing out
    const closed = await browser.newPage();
    await closed.goto(outerUrl(""), { waitUntil: "load", timeout: 120000 });
    const closedFrame = closed.frames().find((f) => f.url().startsWith(`http://localhost:${appPort}`));
    await closedFrame?.waitForFunction(() => document.querySelectorAll(".react-flow__node").length > 5, { timeout: 60000 });
    await closed.evaluate(() => /** @type {any} */ (window).send({ type: "uhd-viewer:focus", path: "video" }));
    await settle(1500);
    const ignored = { events: await closed.evaluate(() => /** @type {any} */ (window).events.length), selected: await closedFrame?.evaluate(() => document.querySelector(".react-flow__node.selected")?.getAttribute("data-id") ?? null) };
    expect("a frame that does not allow the host ignores it and sends nothing", ignored.events === 0 && ignored.selected === null, ignored);
    await closed.close();
    expect("no page errors", failures.length === 0, failures);
  } finally {
    await browser.close();
    for (const s of [app, outer]) {
      s.closeAllConnections();
      s.close();
    }
  }
  writeFileSync(join(out, "messages-summary.json"), JSON.stringify({ bundleFile, results, failures }, null, 2));
  console.log(`${out}/messages-summary.json`);
  return results.every((r) => r.ok) ? 0 : 1;
}

const [first, second, third] = process.argv.slice(2);
if (first === "compare" && second && third) await compare(second, third);
else if (first === "host" && second && third) process.exitCode = await checkHost(second, third);
else if (first === "messages" && second && third) process.exitCode = await checkMessages(second, third);
else if (first && second) process.exitCode = await check(first, second);
else {
  console.error("usage: node scripts/check-render.mjs <viewer-url> <out-dir> | compare <dir-a> <dir-b> | host <bundle.json> <out-dir> | messages <bundle.json> <out-dir>");
  process.exitCode = 2;
}
