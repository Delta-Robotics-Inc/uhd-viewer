import { describe, expect, it } from "vitest";
import type { UhdBundle } from "@uhd/types/bundle.js";
import { baseToUrl, bundleResolver, pickBundleUrl, sourceFromBundle } from "../src/source/source";

const bundle = {
  schema: "uhd.bundle/v0",
  root: "sys",
  definitions: [{ id: "sys", name: "System", interfaces: [] }],
  artifactBases: { fs: "/home/me/project", url: "http://127.0.0.1:5179/artifacts/project/", dev: "/@fs/home/me/project" },
  diagnostics: [{ code: "X", severity: "info", message: "m" }],
} as unknown as UhdBundle;

describe("artifact bases", () => {
  it("serves filesystem bases through /@fs in development only", () => {
    expect(baseToUrl("/home/me/project/", { fsRoute: true })).toBe("/@fs/home/me/project");
    expect(baseToUrl("/home/me/project")).toBeUndefined();
  });

  it("uses URL bases as they are", () => {
    expect(baseToUrl("https://cdn.example/p/")).toBe("https://cdn.example/p");
    expect(baseToUrl("/@fs/x", { fsRoute: true })).toBe("/@fs/x");
  });

  it("resolves per definition, then against the bundle's own location", () => {
    const resolve = bundleResolver(bundle, "http://127.0.0.1:5179/uhd-bundle.json");
    expect(resolve("url", "cad/a.glb")).toBe("http://127.0.0.1:5179/artifacts/project/cad/a.glb");
    expect(resolve("other", "cad/a.glb")).toBe("http://127.0.0.1:5179/cad/a.glb");
    expect(resolve("fs", "https://x.example/a.glb")).toBe("https://x.example/a.glb");
  });

  it("leaves filesystem bases unresolved in a production build", () => {
    const warn = console.warn;
    const warnings: unknown[] = [];
    console.warn = (m: unknown) => warnings.push(m);
    try {
      const resolve = bundleResolver(bundle, "/b.json");
      expect(resolve("fs", "cad/a.glb")).toBeUndefined();
      expect(resolve("fs", "cad/b.glb")).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(bundleResolver(bundle, "/b.json", { fsRoute: true })("fs", "cad/a.glb")).toBe("/@fs/home/me/project/cad/a.glb");
    } finally {
      console.warn = warn;
    }
  });
});

describe("sourceFromBundle", () => {
  it("lets a host resolver replace or extend the default", () => {
    const source = sourceFromBundle(bundle, "http://h/uhd-bundle.json", {
      resolveArtifact: (id, file, fallback) => (id === "fs" ? `blob:${file}` : fallback(id, file)),
    });
    expect(source.resolveArtifact("fs", "a.glb")).toBe("blob:a.glb");
    expect(source.resolveArtifact("url", "a.glb")).toBe("http://127.0.0.1:5179/artifacts/project/a.glb");
    expect(source.hostDiagnostics).toHaveLength(1);
    expect(source.scenarios.map((s) => s.id)).toEqual(["nominal"]);
  });

  it("rejects other schemas", () => {
    expect(() => sourceFromBundle({ ...bundle, schema: "x" } as unknown as UhdBundle, "/b.json")).toThrow(/not a UHD bundle/);
  });
});

it("picks ?bundle= over the injected URL over the development default", () => {
  expect(pickBundleUrl("?bundle=/a.json", "b.json", "/c.json")).toBe("/a.json");
  expect(pickBundleUrl("", "b.json", "/c.json")).toBe("b.json");
  expect(pickBundleUrl("", undefined, "/c.json")).toBe("/c.json");
  expect(pickBundleUrl("", null, null)).toBeUndefined();
});
