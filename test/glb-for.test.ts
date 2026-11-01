import { describe, expect, it } from "vitest";
import type { ModuleDef } from "@uhd/types/index.js";
import { glbFor } from "../src/cad/model";

// glbFor follows the stack resolver's body rule (bodyArtifact in @protoboardai/core part-files.ts)
describe("glbFor, the body GLB of a definition", () => {
  const def = {
    id: "part",
    artifacts: [
      { id: "pad_mesh", role: "interface", format: "glb", filePath: "cad/pad.glb", provenance: { generatedFrom: "cad_step" } },
      { id: "cad_step", role: "body", format: "step", filePath: "cad/part.step" },
      { id: "cad_glb", role: "body", format: "glb", filePath: "cad/part.glb", provenance: { generatedFrom: "cad_step" } },
    ],
  } as unknown as ModuleDef;

  it("takes the body made from a named STEP before an interface mesh made from it", () => {
    expect(glbFor(def, "cad_step")?.id).toBe("cad_glb");
  });

  it("never draws an interface's own mesh as the body", () => {
    const only = { ...def, artifacts: def.artifacts!.filter((a) => a.id !== "cad_glb") } as ModuleDef;
    expect(glbFor(only, "cad_step")).toBeUndefined();
  });

  it("without a named body, the first body GLB (a resolver's resolved_glb when the bundle added one)", () => {
    const resolved = { ...def, artifacts: [...def.artifacts!.map((a) => (a.id === "cad_glb" ? { ...a, role: "source" } : a)), { id: "resolved_glb", role: "body", format: "glb", filePath: ".protoboard/build/placeholders/part.glb" }] } as ModuleDef;
    expect(glbFor(def)?.id).toBe("cad_glb");
    expect(glbFor(resolved)?.id).toBe("resolved_glb");
  });
});
