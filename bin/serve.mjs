/**
 * `uhd-viewer serve`: a small static server for the built viewer (dist/app),
 * one UHD bundle, and the artifact files that bundle references.
 *
 * Bundles written by a producer carry absolute filesystem artifact bases
 * (`UhdBundle.artifactBases`). Each base is mounted at a URL prefix,
 * `/artifacts/<name>/`, and the served bundle names those URLs instead, so no
 * local path reaches the browser. Only files the bundle references as
 * artifacts are served from a base, and only if their real path stays inside
 * it (no `..`, no symlink out). Each goes out with a sandboxing
 * Content-Security-Policy and `nosniff`; an HTML file as a download.
 *
 * Bound to 127.0.0.1 by default, and then only answers requests addressed to a
 * loopback name (a page on another site cannot reach it by DNS rebinding).
 */
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const BUNDLE_SCHEMA = "uhd.bundle/v0";
/** URL path of the served (rewritten) bundle, relative to the app. */
export const BUNDLE_URL = "uhd-bundle.json";
export const DEFAULT_PORT = 5179;
export const APP_DIR = fileURLToPath(new URL("../dist/app", import.meta.url));

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".step": "model/step",
  ".stp": "model/step",
  ".stl": "model/stl",
  ".dxf": "image/vnd.dxf",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

/**
 * Headers on every artifact response (PB-1048): an artifact is a file from a
 * part or a project, not part of the app, so it runs no script, loads nothing
 * but its own images, and is never sniffed into another type. An HTML file is
 * downloaded, not shown.
 */
export const ARTIFACT_HEADERS = {
  "content-security-policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
  "x-content-type-options": "nosniff",
};
const DOWNLOADED = /\.(html?|xhtml|xht|shtml|mht|mhtml)$/i;

/** The headers an artifact file is sent with. */
export function artifactHeaders(file) {
  return DOWNLOADED.test(file) ? { ...ARTIFACT_HEADERS, "content-disposition": `attachment; filename="${basename(file).replace(/[^\x20-\x7e]|["\\]/g, "_")}"` } : { ...ARTIFACT_HEADERS };
}

const typeOf = (file) => TYPES[file.slice(file.lastIndexOf(".")).toLowerCase()] ?? "application/octet-stream";
const isUrl = (s) => /^https?:\/\//.test(s);

/** `dir` contains `file` (both absolute, normalised). */
const inside = (dir, file) => file === dir || file.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/**
 * What to serve for one bundle.
 *
 * @param {any} bundle a parsed `uhd.bundle/v0`
 * @param {string} bundleFile its path on disk (relative bases and definitions without a base resolve against its folder)
 * @returns {{ mounts: Map<string, string>, files: Map<string, string>, bases: Record<string, string>, rewrite: (origin: string) => any }}
 *   mounts: URL name → base folder; files: "<name>/<artifact path>" → file;
 *   bases: definition id → mount name or URL; rewrite: the bundle as served from `origin`.
 */
export function planBundle(bundle, bundleFile) {
  if (bundle?.schema !== BUNDLE_SCHEMA) throw new Error(`${bundleFile} is not a UHD bundle (schema ${String(bundle?.schema)})`);
  const bundleDir = dirname(resolve(bundleFile));
  const mounts = new Map();
  const byDir = new Map();
  const mount = (dir) => {
    if (byDir.has(dir)) return byDir.get(dir);
    const stem = basename(dir).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "") || "base";
    let name = stem;
    for (let i = 2; mounts.has(name); i++) name = `${stem}-${i}`;
    mounts.set(name, dir);
    byDir.set(dir, name);
    return name;
  };
  const sourceBases = bundle.artifactBases ?? {};
  const bases = {};
  const files = new Map();
  for (const [id, base] of Object.entries(sourceBases)) bases[id] = isUrl(base) ? base : mount(isAbsolute(base) ? normalize(base) : resolve(bundleDir, base));
  const definitions = [
    ...(bundle.definitions ?? []),
    ...(bundle.scenarios ?? []).flatMap((s) => [s.root, ...(s.definitions ?? [])]).filter(Boolean),
  ];
  for (const def of definitions) {
    for (const a of def.artifacts ?? []) {
      if (!a.filePath || isUrl(a.filePath)) continue;
      if (isUrl(bases[def.id] ?? "")) continue;
      // a definition without a base resolves against the bundle's own folder
      bases[def.id] ??= mount(bundleDir);
      const rel = normalize(a.filePath);
      if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) continue;
      const name = bases[def.id];
      files.set(`${name}/${rel.split(sep).join("/")}`, join(mounts.get(name), rel));
    }
  }
  const rewrite = (origin) => ({
    ...bundle,
    artifactBases: Object.fromEntries(Object.entries(bases).map(([id, b]) => [id, isUrl(b) ? b : `${origin}/artifacts/${b}`])),
  });
  return { mounts, files, bases, rewrite };
}

/**
 * The app's index.html with its config injected (read by src/main.tsx): the
 * bundle URL and the parent origins it may talk to when framed. The page that
 * frames the app writes its URL, so the origins come from here, not the query.
 */
export function injectConfig(html, config) {
  const json = JSON.stringify(config).replace(/</g, "\\u003c");
  return html.replace("</head>", `  <script type="application/json" id="uhd-viewer-config">${json}</script>\n  </head>`);
}

/** Re-reads the bundle when its file changes (a rebuild while the server runs). */
function bundleState(bundleFile) {
  let cached;
  return async () => {
    const { mtimeMs, size } = await stat(bundleFile);
    if (!cached || cached.mtimeMs !== mtimeMs || cached.size !== size) {
      const bundle = JSON.parse(await readFile(bundleFile, "utf8"));
      cached = { mtimeMs, size, plan: planBundle(bundle, bundleFile) };
    }
    return cached.plan;
  };
}

function send(res, status, body, type = "text/plain; charset=utf-8", headers = {}) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-cache", ...headers });
  res.end(res.req.method === "HEAD" ? undefined : body);
}

async function sendFile(res, file, cache, headers = {}) {
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) return send(res, 404, "not found", undefined, headers);
  res.writeHead(200, { "content-type": typeOf(file), "content-length": info.size, "cache-control": cache, ...headers });
  if (res.req.method === "HEAD") return res.end();
  createReadStream(file).pipe(res);
}

/**
 * A request handler for the viewer, a bundle and its artifacts. Hosts that
 * serve more (their own pages) can call it for the rest: it answers every
 * request it is given.
 *
 * @param {{ bundleFile: string, appDir?: string, allowHost?: (hostname: string) => boolean, hostOrigins?: string[] }} options
 *   hostOrigins: parent origins the app takes host messages from when framed (exact, `scheme://*` or `*`)
 */
export function viewerHandler({ bundleFile, appDir: app = APP_DIR, allowHost = (h) => LOOPBACK.has(h), hostOrigins = [] }) {
  const appDir = resolve(app);
  const plan = bundleState(resolve(bundleFile));
  const realBase = new Map();
  const realOf = async (dir) => {
    if (!realBase.has(dir)) {
      const real = await realpath(dir).catch(() => undefined);
      if (!real) return undefined;
      realBase.set(dir, real);
    }
    return realBase.get(dir);
  };
  return async (req, res) => {
    try {
      const host = req.headers.host ?? "";
      const hostname = host.replace(/:\d+$/, "");
      if (!allowHost(hostname)) return send(res, 403, `host ${hostname} not allowed`);
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed", undefined, { allow: "GET, HEAD" });
      let path;
      try {
        path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
      } catch {
        return send(res, 400, "bad request");
      }
      if (path === "/" || path === "/index.html") {
        const html = await readFile(join(appDir, "index.html"), "utf8");
        return send(res, 200, injectConfig(html, hostOrigins.length ? { bundleUrl: BUNDLE_URL, hostOrigins } : { bundleUrl: BUNDLE_URL }), TYPES[".html"]);
      }
      if (path === `/${BUNDLE_URL}`) {
        const p = await plan();
        return send(res, 200, JSON.stringify(p.rewrite(`http://${host}`)), TYPES[".json"]);
      }
      if (path.startsWith("/artifacts/")) {
        const p = await plan();
        const key = path.slice("/artifacts/".length);
        const file = p.files.get(key);
        if (!file) return send(res, 404, "not an artifact of this bundle", undefined, ARTIFACT_HEADERS);
        const base = await realOf(p.mounts.get(key.split("/")[0]));
        const real = await realpath(file).catch(() => undefined);
        if (!base || !real) return send(res, 404, "not found", undefined, ARTIFACT_HEADERS);
        if (!inside(base, real)) return send(res, 403, "outside the artifact base", undefined, ARTIFACT_HEADERS);
        return sendFile(res, real, "no-cache", artifactHeaders(real));
      }
      // the built app: hashed assets are immutable
      const file = resolve(appDir, `.${path}`);
      if (!inside(appDir, file)) return send(res, 404, "not found");
      return sendFile(res, file, relative(appDir, file).startsWith(`assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache");
    } catch (e) {
      return send(res, 500, String(e instanceof Error ? e.message : e));
    }
  };
}

/**
 * Starts the server. Fails before listening if the bundle or the built app is missing.
 *
 * @param {{ bundleFile: string, port?: number, host?: string, appDir?: string, hostOrigins?: string[] }} options
 * @returns {Promise<{ url: string, server: import("node:http").Server, close: () => Promise<void> }>}
 */
export async function startServer({ bundleFile, port = DEFAULT_PORT, host = "127.0.0.1", appDir = APP_DIR, hostOrigins = [] }) {
  planBundle(JSON.parse(await readFile(bundleFile, "utf8")), bundleFile);
  await stat(join(appDir, "index.html")).catch(() => {
    throw new Error(`no built viewer at ${appDir}: run \`npm run build\` first`);
  });
  const loopback = LOOPBACK.has(host);
  // exposed on purpose (--host 0.0.0.0): any Host header is accepted
  const server = createServer(viewerHandler({ bundleFile, appDir, hostOrigins, allowHost: loopback ? (h) => LOOPBACK.has(h) : () => true }));
  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, host, () => ok(undefined));
  });
  const address = server.address();
  const actual = typeof address === "object" && address ? address.port : port;
  const shown = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const name = shown.includes(":") ? `[${shown}]` : shown;
  return {
    url: `http://${name}:${actual}/`,
    server,
    close: () =>
      new Promise((ok) => {
        server.close(() => ok());
        server.closeIdleConnections();
      }),
  };
}
