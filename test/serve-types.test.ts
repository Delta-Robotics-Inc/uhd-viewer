import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as serve from "../bin/serve.mjs";

// bin/serve.d.mts is written by hand; the type-check uses it for every import of the server
describe("serve declarations", () => {
  it("declare exactly what bin/serve.mjs exports", () => {
    const declared = [...readFileSync(new URL("../bin/serve.d.mts", import.meta.url), "utf8").matchAll(/^export declare (?:const|function) (\w+)/gm)].map((m) => m[1]);
    expect(declared.sort()).toEqual(Object.keys(serve).sort());
  });

  it("declare the constants' values", () => {
    expect(serve.BUNDLE_SCHEMA).toBe("uhd.bundle/v0");
    expect(serve.BUNDLE_URL).toBe("uhd-bundle.json");
  });
});
