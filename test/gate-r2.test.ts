// Wave R2 gate (2026-11-02): the 3D view's Model info panel lists findings in the stack's plain words (D3), not the
// rule name and the raw message; the raw message stays as the row's tooltip.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildFixtures } from "../fixtures/src/imu-pod";
import { buildCadModel } from "../src/cad/model";
import { findingAnchors } from "../src/cad/findings";
import { plainTextIndex } from "../src/cad/annot/plain";
import type { GeometryManifest } from "@uhd/system/geometry.js";
import type { ScopedDiagnostic } from "../src/model/diagnostics";

const dir = new URL("../fixtures/imu-pod/", import.meta.url);
const text = (path: string) => readFileSync(new URL(path, dir)).toString("utf8");
const fx = buildFixtures();
const lookup = (id: string) => fx.definitions.find((d) => d.id === id);
const manifests = new Map([
  [`${fx.board.id}:board_glb`, JSON.parse(text("board/out/board.manifest.json")) as GeometryManifest],
  [`${fx.enclosure.id}:enclosure_glb`, JSON.parse(text("enclosure/out/body.manifest.json")) as GeometryManifest],
]);

describe("wave R2 gate: plain words on the Model info findings", () => {
  const model = buildCadModel(fx.pod, lookup, manifests);

  it("host findings take the bundle's title and summary, the raw message kept aside", () => {
    const host = fx.bundles.pod.diagnostics!.map((d, i) => (i === 0 ? { ...d, title: "Window is off the pads", summary: "The SWD window sits 0.8 mm away from the pads it should expose." } : d));
    const all = findingAnchors(model, [], host);
    expect(all.length).toBeGreaterThan(0);
    const first = all[0];
    expect(first.title).toBe("Window is off the pads");
    expect(first.message).toBe("The SWD window sits 0.8 mm away from the pads it should expose.");
    expect(first.raw).toBe(host[0].message);
    // a finding without the fields reads as before (code in words, raw message), with no separate raw
    for (const f of all.slice(1)) expect(f.raw).toBeUndefined();
  });

  it("the viewer's own checks take the text indexed from the stack's copies (code and message)", () => {
    const own: ScopedDiagnostic[] = [{ id: "x1", rule: "link_state", severity: "error", message: "A to B: incompatible", refs: ["board/l1"], scope: "" } as unknown as ScopedDiagnostic];
    const index = plainTextIndex([{ code: "UHD_LINK_STATE", message: "pod (imu-pod): A to B: incompatible", title: "Link protocols do not match", summary: "A and B share no protocol." }]);
    const [f] = findingAnchors(model, own, [], index);
    expect(f).toMatchObject({ title: "Link protocols do not match", message: "A and B share no protocol.", raw: "A to B: incompatible" });
    const [g] = findingAnchors(model, own, []);
    expect(g).toMatchObject({ title: "LINK STATE", message: "A to B: incompatible" });
    expect(g.raw).toBeUndefined();
  });
});
