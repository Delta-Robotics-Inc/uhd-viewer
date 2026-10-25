import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectConfig, planBundle, startServer } from "../bin/serve.mjs";

const def = (id: string, files: string[]) => ({ id, name: id, interfaces: [], artifacts: files.map((f, i) => ({ id: `a${i}`, type: "3d_model", filePath: f })) });

describe("planBundle", () => {
  const bundle = {
    schema: "uhd.bundle/v0",
    root: "sys",
    definitions: [def("sys", ["cad/sys.glb"]), def("motor", ["cad/motor.glb", "../escape.txt", "/etc/passwd"]), def("remote", ["x.glb"]), def("loose", ["loose.glb"])],
    artifactBases: { sys: "/work/project", motor: "/work/node_modules/@acme/uhd", remote: "https://cdn.example/parts/remote" },
    scenarios: [{ id: "alt", label: "Alt", definitions: [def("motor", ["cad/motor-alt.glb"])] }],
  };
  const plan = planBundle(bundle, "/work/project/.build/uhd-bundle.json");

  it("mounts each filesystem base once, named after its folder", () => {
    expect(Object.fromEntries(plan.mounts)).toEqual({ project: "/work/project", uhd: "/work/node_modules/@acme/uhd", build: "/work/project/.build" });
  });

  it("allows only the artifact files the bundle references, inside their base", () => {
    expect(Object.fromEntries(plan.files)).toEqual({
      "project/cad/sys.glb": "/work/project/cad/sys.glb",
      "uhd/cad/motor.glb": "/work/node_modules/@acme/uhd/cad/motor.glb",
      "uhd/cad/motor-alt.glb": "/work/node_modules/@acme/uhd/cad/motor-alt.glb",
      // no base: the bundle's own folder
      "build/loose.glb": "/work/project/.build/loose.glb",
    });
  });

  it("rewrites filesystem bases to URLs and keeps URL bases", () => {
    const served = plan.rewrite("http://127.0.0.1:5179");
    expect(served.artifactBases).toEqual({
      sys: "http://127.0.0.1:5179/artifacts/project",
      motor: "http://127.0.0.1:5179/artifacts/uhd",
      remote: "https://cdn.example/parts/remote",
      loose: "http://127.0.0.1:5179/artifacts/build",
    });
    expect(JSON.stringify(served.artifactBases)).not.toContain("/work/");
    expect(served.definitions).toBe(bundle.definitions);
  });

  it("names two folders with the same name apart", () => {
    const p = planBundle({ schema: "uhd.bundle/v0", root: "a", definitions: [], artifactBases: { a: "/x/uhd", b: "/y/uhd" } }, "/b.json");
    expect([...p.mounts.keys()]).toEqual(["uhd", "uhd-2"]);
  });

  it("rejects anything that is not a UHD bundle", () => {
    expect(() => planBundle({ schema: "other" }, "/b.json")).toThrow(/not a UHD bundle/);
  });
});

it("injects the bundle URL into the page, escaped", () => {
  const html = injectConfig("<html><head></head><body></body></html>", { bundleUrl: "a</script>.json" });
  expect(html).toContain('<script type="application/json" id="uhd-viewer-config">{"bundleUrl":"a\\u003c/script>.json"}</script>');
});

describe("the server", () => {
  let dir: string;
  let origin: string;
  let close: () => Promise<void>;
  let bundleFile: string;
  let project: string;
  const write = (files: string[]) =>
    writeFileSync(bundleFile, JSON.stringify({ schema: "uhd.bundle/v0", root: "p", definitions: [def("p", files)], artifactBases: { p: project } }));

  const get = (path: string, opts: { host?: string; method?: string } = {}) =>
    new Promise<{ status: number; type?: string; body: string; headers: Record<string, unknown> }>((ok, fail) => {
      const url = new URL(path, origin);
      const req = request({ host: url.hostname, port: url.port, path, method: opts.method ?? "GET", headers: opts.host ? { host: opts.host } : {} }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => ok({ status: res.statusCode ?? 0, type: res.headers["content-type"], body, headers: res.headers }));
      });
      req.on("error", fail);
      req.end();
    });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "uhd-viewer-serve-"));
    const app = join(dir, "app");
    mkdirSync(join(app, "assets"), { recursive: true });
    writeFileSync(join(app, "index.html"), "<html><head><title>t</title></head><body></body></html>");
    writeFileSync(join(app, "assets", "index.js"), "console.log(1)");
    project = join(dir, "project");
    mkdirSync(join(project, "cad"), { recursive: true });
    writeFileSync(join(project, "cad", "body.glb"), "glTF");
    writeFileSync(join(project, "cad", "notes.html"), "<script>parent.postMessage('x','*')</script>");
    writeFileSync(join(project, "cad", "drawing.svg"), "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
    writeFileSync(join(project, ".env"), "SECRET=1");
    writeFileSync(join(dir, "outside.txt"), "outside");
    symlinkSync(join(dir, "outside.txt"), join(project, "cad", "link.glb"));
    bundleFile = join(dir, "bundle.json");
    write(["cad/body.glb", "cad/link.glb", "../outside.txt", "cad/notes.html", "cad/drawing.svg"]);
    ({ close, url: origin } = await startServer({ bundleFile, port: 0, appDir: app }));
  });
  afterAll(async () => {
    await close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves the app with the bundle URL injected", async () => {
    const page = await get("/");
    expect(page.status).toBe(200);
    expect(page.body).toContain('id="uhd-viewer-config">{"bundleUrl":"uhd-bundle.json"}');
    expect((await get("/assets/index.js")).body).toBe("console.log(1)");
  });

  it("injects the host origins it is given, and none by default", async () => {
    expect((await get("/")).body).not.toContain("hostOrigins");
    const other = await startServer({ bundleFile, port: 0, appDir: join(dir, "app"), hostOrigins: ["vscode-webview://*", "http://localhost:3000"] });
    try {
      const page = await fetch(other.url).then((r) => r.text());
      expect(page).toContain('{"bundleUrl":"uhd-bundle.json","hostOrigins":["vscode-webview://*","http://localhost:3000"]}');
    } finally {
      await other.close();
    }
  });

  it("serves the bundle with its bases as URLs on this server", async () => {
    const res = await get("/uhd-bundle.json");
    expect(res.type).toMatch(/application\/json/);
    const served = JSON.parse(res.body);
    expect(served.artifactBases).toEqual({ p: `${origin}artifacts/project` });
    expect(res.body).not.toContain(dir);
  });

  it("serves referenced artifacts with their media type", async () => {
    const res = await get("/artifacts/project/cad/body.glb");
    expect(res).toMatchObject({ status: 200, type: "model/gltf-binary", body: "glTF" });
  });

  it("sends every artifact sandboxed and unsniffed, and an HTML file as a download (PB-1048)", async () => {
    const csp = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";
    for (const path of ["/artifacts/project/cad/body.glb", "/artifacts/project/cad/drawing.svg", "/artifacts/project/cad/notes.html", "/artifacts/project/.env", "/artifacts/project/cad/link.glb"]) {
      const res = await get(path);
      expect([path, res.headers["content-security-policy"], res.headers["x-content-type-options"]]).toEqual([path, csp, "nosniff"]);
    }
    const svg = await get("/artifacts/project/cad/drawing.svg");
    expect([svg.type, svg.headers["content-disposition"]]).toEqual(["image/svg+xml", undefined]);
    const html = await get("/artifacts/project/cad/notes.html");
    expect([html.status, html.headers["content-disposition"]]).toEqual([200, 'attachment; filename="notes.html"']);
    // the app's own pages are not sandboxed
    expect((await get("/")).headers["content-security-policy"]).toBeUndefined();
  });

  it("serves nothing else from a base", async () => {
    expect((await get("/artifacts/project/.env")).status).toBe(404);
    expect((await get("/artifacts/project/cad/%2e%2e/.env")).status).toBe(404);
    expect((await get("/artifacts/project/..%2f..%2foutside.txt")).status).toBe(404);
    expect((await get("/artifacts/project/cad/link.glb")).status).toBe(403);
    expect((await get("/..%2foutside.txt")).status).toBe(404);
  });

  it("answers only loopback hosts and GET/HEAD", async () => {
    expect((await get("/uhd-bundle.json", { host: "evil.example:80" })).status).toBe(403);
    expect((await get("/uhd-bundle.json", { method: "POST" })).status).toBe(405);
    expect((await get("/artifacts/project/cad/body.glb", { method: "HEAD" })).status).toBe(200);
  });

  it("follows the bundle file when it is rebuilt", async () => {
    expect((await get("/artifacts/project/cad/later.glb")).status).toBe(404);
    write(["cad/body.glb", "cad/later.glb"]);
    writeFileSync(join(project, "cad", "later.glb"), "later");
    const t = new Date(Date.now() + 5000);
    utimesSync(bundleFile, t, t);
    expect((await get("/artifacts/project/cad/later.glb")).body).toBe("later");
  });
});
