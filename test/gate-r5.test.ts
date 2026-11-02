/**
 * Wave R5 gate (2026-11-02): the gate's fixes.
 * - ClientX display colours (display.json `spatial.appearance`) on a model that is one mesh node (a merged view sidecar):
 *   the body's only part is that mesh, so it takes the project's colour, not the colour baked into the sidecar.
 * - The motion controller keeps a sub-assembly explode's scope in its write, and sets both toggles in one command.
 * - The timeline's keys leave a select (the speed) alone.
 */
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { Assembly, Mat4 } from "@uhd/system/geometry.js";
import type { ModuleDef } from "@uhd/types/index.js";
import { planBoard, withBoard, type BoardPartInput } from "../src/cad/assembly";
import { radialEase, type RadialMove } from "../src/cad/explode";
import { EXPLODE_TRAVEL_S, MotionController, SPEEDS, SequencePlayer, generateSequence, hardwareKeys, resolveSequence, type Mat, type ResolvedWithRadial, type SequenceCommand } from "../src/cad/sequence";

const T = (x: number, y: number, z: number): Mat4 => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
const def = (id: string, extra: Partial<ModuleDef> = {}): ModuleDef => ({ id, name: id, interfaces: [], ...extra }) as unknown as ModuleDef;
const bolt = (role: "structure" | "component") => ({ id: "mount", domain: "mechanical", protocols: [{ type: "bolt_pattern", roles: [role] }] });
const shaft = (role: "output" | "input") => ({ id: role === "output" ? "shaft" : "bore", domain: "mechanical", protocols: [{ type: "shaft", roles: [role] }] });

function fixture(): Assembly {
  const screw = def("m3x10", { tags: ["fastener", "screw"], traits: [{ type: "performance", params: { thread: "M3 x 0.5" } }] } as Partial<ModuleDef>);
  const nut = def("m3-nut", { tags: ["fastener", "nut"], traits: [{ type: "performance", params: { thread: "M3 x 0.5" } }] } as Partial<ModuleDef>);
  const motor = def("motor");
  return {
    instances: [],
    placements: [
      { key: "plate", path: ["plate"], matrix: T(0, 0, 0) },
      { key: "unit/motor", path: ["unit", "motor"], matrix: T(0, 0, 2), via: "motor_mount" },
      { key: "unit/hub", path: ["unit", "hub"], matrix: T(0, 0, 22), via: "unit/hub_on_shaft" },
    ],
    mates: [
      { linkId: "motor_mount", harness: "motor_hw", a: { path: ["unit", "motor"], def: motor, iface: bolt("component"), frame: { origin: [0, 0, 0], normal: [0, 0, -1] } }, b: { path: ["plate"], def: def("plate"), iface: bolt("structure"), frame: { origin: [0, 0, 2], normal: [0, 0, 1] } } },
      { linkId: "unit/hub_on_shaft", a: { path: ["unit", "motor"], def: motor, iface: shaft("output"), frame: { origin: [0, 0, 20], normal: [0, 0, 1] } }, b: { path: ["unit", "hub"], def: def("hub"), iface: shaft("input"), frame: { origin: [0, 0, 0], normal: [0, 0, -1] } } },
    ],
    routes: [],
    hardware: [
      { harness: "motor_hw", child: "screws", def: screw, linkId: "motor_mount", matrix: T(-5, 0, -1), structure: "plate", mounted: "unit/motor", atMm: -3, direction: 1 },
      { harness: "motor_hw", child: "screws", def: screw, linkId: "motor_mount", matrix: T(5, 0, -1), structure: "plate", mounted: "unit/motor", atMm: -3, direction: 1 },
      { harness: "motor_hw", child: "nuts", def: nut, linkId: "motor_mount", matrix: T(-5, 0, 8), structure: "plate", mounted: "unit/motor", atMm: 6, direction: 1 },
      { harness: "motor_hw", child: "nuts", def: nut, linkId: "motor_mount", matrix: T(5, 0, 8), structure: "plate", mounted: "unit/motor", atMm: 6, direction: 1 },
    ],
    harnesses: [],
    unrouted: [],
    issues: [],
  } as unknown as Assembly;
}

/** The fixture resolved from its mates with a radial plan beside it: every part a path, some unlike its step's own. */
function resolved(): ResolvedWithRadial {
  const asm = fixture();
  const r = resolveSequence({ assembly: asm, gap: 10 }, generateSequence(asm, { root: ["plate"] }), "generated") as ResolvedWithRadial;
  const moves = new Map<string, RadialMove>([
    ["plate", { dir: [0, 0, -1], distance: 30, from: "up" }],
    ["unit/motor", { dir: [1, 0, 0], distance: 40, from: "face" }],
    ["unit/hub", { dir: [0, 0, 1], distance: 50, from: "sequence" }],
    // a part no step names (a cable tie, say): it goes in a final step
    ["tie", { dir: [0, 1, 0], distance: 20, from: "centre" }],
  ]);
  hardwareKeys(asm.hardware).forEach((k, i) => moves.set(k!, { dir: i < 2 ? [0, 0, -1] : [0, 0, 1], distance: 25 + i, from: "face" }));
  r.radial = { moves, centre: [0, 0, 10], radius: 60, ms: 0 };
  r.baseParts = ["plate"];
  return r;
}

const at = (m: Mat | undefined): [number, number, number] => (m ? [m[12], m[13], m[14]] : [0, 0, 0]);
const close = (a: readonly number[], b: readonly number[], d = 6) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], d));
const same = (p: Map<string, Mat>, q: Map<string, Mat>, keys: Iterable<string>) => {
  for (const k of keys) close(at(p.get(k)), at(q.get(k)));
};
import { bodyPartsOf, materialFor } from "../src/cad/scene";
import { keyAction } from "../src/cad/timeline/model";

describe("display colours reach a one-mesh model (ClientX, wave R5 gate)", () => {
  it("a lone mesh is its own part and takes the appearance colour over its baked material", () => {
    const baked = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.1022, 0.1221, 0.162) });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), baked);
    mesh.name = "grill-triangle";
    const { parts, lone } = bodyPartsOf(mesh);
    expect(lone).toBe(true);
    expect(parts).toEqual([mesh]);
    const grill = def("grill-triangle");
    for (const part of parts) part.traverse((o) => ((o as THREE.Mesh).isMesh ? ((o as THREE.Mesh).material = materialFor(grill, "", { color: "#e4e4e0", roughness: 0.7, metalness: 0 })) : undefined));
    const m = mesh.material as THREE.MeshStandardMaterial;
    expect(m).not.toBe(baked);
    expect(`#${m.color.getHexString()}`).toBe("#e4e4e0");
    expect(m.roughness).toBe(0.7);
  });
  it("a model with nodes under its top is coloured part by part as before", () => {
    const top = new THREE.Group();
    const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    top.add(a, b);
    expect(bodyPartsOf(top)).toEqual({ parts: [a, b], lone: false });
  });
});

describe("the motion controller's writes (wave R5 gate)", () => {
  it("keeps the sub-assembly being exploded (a write without scope brought the whole model out)", () => {
    const p = new SequencePlayer(resolved());
    p.setScope("unit", { instant: true });
    const writes: { ops: unknown[]; label: string }[] = [];
    const m = new MotionController({ player: () => p, run: (c) => p.run(c), write: (ops, label) => writes.push({ ops, label }) });
    m.setExplode(true);
    expect(writes.at(-1)?.ops[0]).toMatchObject({ op: "explode", scope: "unit", on: true });
    m.pause();
    expect(writes.at(-1)?.ops[0]).toMatchObject({ scope: "unit" });
  });
  it("sets both toggles in one command, in the player's order, and can leave the view state alone", () => {
    const p = new SequencePlayer(resolved());
    const cmds: SequenceCommand[] = [];
    const writes: unknown[] = [];
    const m = new MotionController({ player: () => p, run: (c) => (cmds.push(c), p.run(c)), write: (ops) => writes.push(ops) });
    m.setToggles({ explode: true, assemble: true }, { write: false });
    expect(cmds).toEqual([{ action: "toggle", explode: true, assemble: true }]);
    expect(writes).toEqual([]);
    // both from rest in one command: Assemble drives and it plays (one at a time left the parts paused at rest)
    expect(m.state()).toMatchObject({ explode: true, assemble: true, mode: "sequence", playing: true });
  });
});

describe("the timeline's keys (wave R5 gate)", () => {
  it("leave the speed select its own Space and arrows", () => {
    for (const k of [" ", "ArrowLeft", "ArrowRight", "Enter"]) expect(keyAction(k, { tagName: "SELECT" })).toBeNull();
    expect(keyAction(" ", { tagName: "SECTION" })).toBe("toggle");
  });
});
