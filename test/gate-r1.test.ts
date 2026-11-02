/**
 * Wave R1 gate: the host's `uhd-viewer:openFinding` (a check row clicked in the host's Inspector, R1-E's D7
 * handoff): the message check and which finding it names.
 */
import { describe, expect, it } from "vitest";
import { parseHostMessage } from "../src/host/protocol";
import { findingForHost } from "../src/cad/annot/drc";
import { glowPlan } from "../src/cad/state/view";
import * as THREE from "three";
import { principalNormal } from "../src/cad/scene";

describe("uhd-viewer:openFinding", () => {
  it("takes an id and a code, an optional path, each at most 1024 characters", () => {
    expect(parseHostMessage({ type: "uhd-viewer:openFinding", id: "drc:X:module:pcb", code: "X" })).toEqual({ type: "uhd-viewer:openFinding", id: "drc:X:module:pcb", code: "X" });
    expect(parseHostMessage({ type: "uhd-viewer:openFinding", id: "drc:X:module:pcb", code: "X", path: "/pcb/usb/" })).toEqual({ type: "uhd-viewer:openFinding", id: "drc:X:module:pcb", code: "X", path: "pcb/usb" });
    expect(parseHostMessage({ type: "uhd-viewer:openFinding", id: "drc:X:module:pcb", code: "X", path: ["pcb", "usb"] })).toEqual({ type: "uhd-viewer:openFinding", id: "drc:X:module:pcb", code: "X", path: "pcb/usb" });
    expect(parseHostMessage({ type: "uhd-viewer:openFinding", code: "X" })).toBeUndefined();
    expect(parseHostMessage({ type: "uhd-viewer:openFinding", id: "a", code: "" })).toBeUndefined();
    expect(parseHostMessage({ type: "uhd-viewer:openFinding", id: "a".repeat(1025), code: "X" })).toBeUndefined();
    expect(parseHostMessage({ type: "uhd-viewer:openFinding", id: "a", code: "X", path: 3 })).toBeUndefined();
    expect(parseHostMessage({ type: "uhd-viewer:openFinding", id: "a", code: "X", path: "p".repeat(1025) })).toBeUndefined();
  });

  it("names the exact finding, else its first repeat, else the first of that code naming the path or a part under it", () => {
    const list = [
      { id: "drc:A:link:l1", code: "A", refs: ["pcb/u1"] },
      { id: "drc:B:module:pcb#2", code: "B", refs: ["pcb"] },
      { id: "drc:B:module:pcb#3", code: "B", refs: ["pcb"] },
      { id: "drc:C:module:x", code: "C", refs: ["pcb/usb/usbc"] },
    ];
    expect(findingForHost(list, { id: "drc:A:link:l1", code: "A" })?.id).toBe("drc:A:link:l1");
    expect(findingForHost(list, { id: "drc:B:module:pcb", code: "B" })?.id).toBe("drc:B:module:pcb#2");
    expect(findingForHost(list, { id: "drc:C:other", code: "C", path: "pcb/usb" })?.id).toBe("drc:C:module:x");
    expect(findingForHost(list, { id: "drc:C:other", code: "C", path: "pcb/usb/usbc" })?.id).toBe("drc:C:module:x");
    expect(findingForHost(list, { id: "drc:C:other", code: "C", path: "pcb/us" })).toBeUndefined();
    expect(findingForHost(list, { id: "drc:C:other", code: "C" })).toBeUndefined();
    // a module view: refs are keys in its scope, turned into paths from the root
    expect(findingForHost([{ id: "drc:D:x", code: "D", refs: ["usb/usbc"] }], { id: "?", code: "D", path: "pcb/usb" }, (r) => `pcb/${r}`)?.id).toBe("drc:D:x");
  });
});

describe("an interface pick (gate R1, diff review)", () => {
  it("leaves its body unpainted so the interface's accent geometry reads against it; a body pick still selects", () => {
    expect([...glowPlan({ bodies: ["shell", "pcb"], selection: { body: "shell", iface: "m3_holes" }, highlight: [] }).selected]).toEqual([]);
    expect([...glowPlan({ bodies: ["shell", "pcb"], selection: { body: "shell" }, highlight: [] }).selected]).toEqual(["shell"]);
  });
});

describe("Look along normal on a panel modelled in its assembly's frame (gate R1, E3)", () => {
  it("faces the plate square, from the camera's side, whatever its own box", () => {
    // a 100 x 100 x 3 plate tilted 45 degrees about X: its box is not square to it
    const g = new THREE.BoxGeometry(100, 100, 3);
    const m = new THREE.Mesh(g);
    m.rotation.x = Math.PI / 4;
    const group = new THREE.Group();
    group.add(m);
    const want = new THREE.Vector3(0, -Math.SQRT1_2, Math.SQRT1_2);
    const n = principalNormal([group], new THREE.Vector3(0, -1, 1))!;
    expect(Math.abs(n.dot(want))).toBeGreaterThan(0.999);
    expect(n.dot(new THREE.Vector3(0, -1, 1))).toBeGreaterThan(0);
    expect(principalNormal([group], new THREE.Vector3(0, 1, -1))!.dot(want)).toBeLessThan(-0.999);
    expect(principalNormal([new THREE.Group()], new THREE.Vector3(0, 0, 1))).toBeUndefined();
  });
});
