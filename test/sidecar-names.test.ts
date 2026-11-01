import { describe, expect, it } from "vitest";
import { normaliseSidecar } from "../src/cad/render/sidecar";

// A sidecar whose index has `root` (the named-node build) keeps every node of the original the manifest names,
// so a manifest name it lacks is no reason to load X.glb (wave 1 gate: the drone's M9N fell back for `mount`).
describe("normaliseSidecar and named nodes", () => {
  const base = { schema: "protoboard.view-sidecar/v0", tiers: { fine: { sha256: "abcdef0123456789" } }, nodes: [] };

  it("says a named-node sidecar keeps the original's named nodes", () => {
    expect(normaliseSidecar({ ...base, root: { node: 0, name: "PCB" } })?.keepsNamedNodes).toBe(true);
  });

  it("says nothing for a sidecar from before (merged named nodes)", () => {
    expect(normaliseSidecar(base)?.keepsNamedNodes).toBeUndefined();
  });
});
