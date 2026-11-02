/**
 * R2-B (2026-11-02, Kevin's walkthrough H2): the radial explode. Every part moves at once along the outward normal
 * of its mounting face (its largest facing that points away from the assembly's centre), parts inside outward too,
 * 0.6 of the assembly's radius at amount 1 (DEFAULT); a sequence file can set a part's direction and distance; the
 * Assemble control's step player is unchanged (the sequence mode is today's `poseAt`, exactly).
 */
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { Assembly } from "@uhd/system/geometry.js";
import { RADIAL_SHARE, planRadial, radialDirection, radialEase, sphereOf, underScope, type RadialPart } from "../src/cad/explode";
import { facings } from "../src/cad/explodeSample";
import { MODE_BLEND_MS, SequencePlayer, applyPoint, explodeOverrides, poseAt, resolveForCad, resolveSequence, sequenceFromPlan, type CadBodyTarget, type Mat, type ResolvedWithRadial, type SequenceFile } from "../src/cad/sequence";

const at = (m: Mat | undefined, p: [number, number, number] = [0, 0, 0]) => (m ? applyPoint(m, p) : p);
const near = (a: number[], b: number[], d = 6) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], d));

describe("radial direction and plan (pure)", () => {
  const C: [number, number, number] = [0, 0, 0];
  it("a shell panel goes out along its outer face, not its inner one", () => {
    const panel: RadialPart = { key: "panel", centre: [50, 0, 0], facings: [{ normal: [-1, 0, 0], area: 120 }, { normal: [1, 0, 0], area: 100 }, { normal: [0, 0, 1], area: 10 }] };
    // the inner face is larger but points at the centre: the outer one is the mounting face
    expect(radialDirection(panel, C, 60)).toEqual({ dir: [1, 0, 0], from: "face" });
  });

  it("a tilted triangle panel goes along its own normal, not the line from the centre", () => {
    const n = new THREE.Vector3(1, 1, 1).normalize();
    const panel: RadialPart = { key: "tri", centre: [40, 30, 10], facings: [{ normal: [n.x, n.y, n.z], area: 300 }, { normal: [-n.x, -n.y, -n.z], area: 300 }] };
    const r = radialDirection(panel, C, 80);
    expect(r.from).toBe("face");
    near(r.dir, [n.x, n.y, n.z]);
  });

  it("no facing points away: the line from the centre; at the centre: up", () => {
    const side: RadialPart = { key: "s", centre: [0, 30, 0], facings: [{ normal: [1, 0, 0], area: 50 }, { normal: [-1, 0, 0], area: 50 }] };
    expect(radialDirection(side, C, 60)).toEqual({ dir: [0, 1, 0], from: "centre" });
    const inner: RadialPart = { key: "core", centre: [0.5, 0, 0], facings: [{ normal: [0, 0, 1], area: 10 }, { normal: [0, 0, -1], area: 10 }] };
    expect(radialDirection(inner, C, 60, [0, 0, 1])).toEqual({ dir: [0, 0, 1], from: "face" });
    expect(radialDirection({ centre: [0, 0, 0], facings: [] }, C, 60, [0, 1, 0])).toEqual({ dir: [0, 1, 0], from: "up" });
  });

  it("every part travels the same share of the radius; the sequence file overrides; riders follow their host", () => {
    const parts: RadialPart[] = [
      { key: "a", centre: [50, 0, 0], facings: [{ normal: [1, 0, 0], area: 1 }] },
      { key: "b", centre: [-50, 0, 0], facings: [{ normal: [-1, 0, 0], area: 1 }] },
      { key: "screw#1", centre: [50, 5, 0], facings: [], rides: "a" },
    ];
    const moves = planRadial(parts, { centre: [0, 0, 0], radius: 100, overrides: new Map([["b", { distance: 12 }]]) });
    expect(moves.get("a")).toEqual({ dir: [1, 0, 0], distance: 100 * RADIAL_SHARE, from: "face" });
    expect(moves.get("b")).toEqual({ dir: [-1, 0, 0], distance: 12, from: "sequence" });
    expect(moves.get("screw#1")).toEqual({ dir: [1, 0, 0], distance: 100 * RADIAL_SHARE, from: "rides" });
    const turned = planRadial(parts, { centre: [0, 0, 0], radius: 100, overrides: new Map([["a", { direction: [0, 0, 2] }]]) });
    expect(turned.get("a")).toEqual({ dir: [0, 0, 1], distance: 60, from: "sequence" });
  });

  it("scope and sphere helpers", () => {
    expect(underScope("shell/panel_1", "shell")).toBe(true);
    expect(underScope("shell/panel_1::lid", "shell/panel_1")).toBe(true);
    expect(underScope("shell_hw/screws#2", "shell")).toBe(false);
    expect(underScope("board", "shell")).toBe(false);
    expect(sphereOf([{ box: [[0, 0, 0], [2, 0, 0]] }, { box: [[-2, 0, 0], [0, 0, 0]] }])).toEqual({ centre: [0, 0, 0], radius: 2 });
    expect(radialEase(0)).toBe(0);
    expect(radialEase(1)).toBe(1);
    expect(radialEase(0.5)).toBeCloseTo(0.5, 9);
  });
});

describe("facings (explodeSample)", () => {
  it("a thin plate's two largest facings are its two faces, each its own area", () => {
    const plate = new THREE.Mesh(new THREE.BoxGeometry(100, 50, 2), new THREE.MeshStandardMaterial());
    plate.updateMatrixWorld(true);
    const f = facings([plate]);
    expect(f.length).toBe(6);
    const top = f.slice(0, 2).map((x) => x.normal[2]).sort();
    near(top, [-1, 1]);
    expect(f[0].area).toBeCloseTo(5000, 3);
  });

  it("follows the world matrix (a panel turned 90 degrees faces +x)", () => {
    const g = new THREE.Group();
    const plate = new THREE.Mesh(new THREE.BoxGeometry(40, 40, 2), new THREE.MeshStandardMaterial());
    plate.rotation.y = Math.PI / 2;
    g.add(plate);
    g.updateMatrixWorld(true);
    const xs = facings([g]).slice(0, 2).map((x) => Math.round(x.normal[0]));
    expect(xs.sort()).toEqual([-1, 1]);
  });
});

/** A cube of six thin walls around the origin and a block inside it, as CadView's records. */
function shell(): { bodies: Map<string, CadBodyTarget>; root: THREE.Group; model: { assembly: Assembly; bodies: { key: string }[] } } {
  const root = new THREE.Group();
  const bodies = new Map<string, CadBodyTarget>();
  const add = (key: string, size: [number, number, number], pos: [number, number, number]) => {
    const obj = new THREE.Group();
    obj.matrixAutoUpdate = false;
    obj.add(new THREE.Mesh(new THREE.BoxGeometry(...size), new THREE.MeshStandardMaterial()));
    const base = new THREE.Matrix4().makeTranslation(...pos);
    obj.matrix.copy(base);
    root.add(obj);
    const box = new THREE.Box3(new THREE.Vector3(...size).multiplyScalar(-0.5), new THREE.Vector3(...size).multiplyScalar(0.5));
    bodies.set(key, { body: { key }, obj, base, offset: new THREE.Vector3(), box, parts: [] });
  };
  const S = 100;
  const T = 2;
  add("shell/px", [T, S, S], [S / 2, 0, 0]);
  add("shell/nx", [T, S, S], [-S / 2, 0, 0]);
  add("shell/py", [S, T, S], [0, S / 2, 0]);
  add("shell/ny", [S, T, S], [0, -S / 2, 0]);
  add("shell/pz", [S, S, T], [0, 0, S / 2]);
  add("shell/nz", [S, S, T], [0, 0, -S / 2]);
  add("core", [20, 20, 10], [0, 0, 0]);
  const assembly = { instances: [], placements: [...bodies.keys()].map((k) => ({ key: k, path: k.split("/"), matrix: [] })), mates: [], routes: [], hardware: [], harnesses: [], unrouted: [], issues: [] } as unknown as Assembly;
  return { bodies, root, model: { assembly, bodies: [...bodies.keys()].map((key) => ({ key })) } };
}

describe("the radial explode on CadView's records (resolveForCad, the player)", () => {
  const { bodies, root, model } = shell();
  const resolved = resolveForCad({ model, bodies, hardware: [], up: new THREE.Vector3(0, 0, 1), gap: 20, root }) as ResolvedWithRadial;

  it("plans every part: walls out along their outer faces, the core up", () => {
    const plan = resolved.radial!;
    expect(plan.moves.size).toBe(7);
    const R = plan.radius;
    near(plan.moves.get("shell/px")!.dir, [1, 0, 0]);
    near(plan.moves.get("shell/nz")!.dir, [0, 0, -1]);
    expect(plan.moves.get("core")!.from === "face" || plan.moves.get("core")!.from === "up").toBe(true);
    near(plan.moves.get("core")!.dir, [0, 0, 1]);
    for (const m of plan.moves.values()) expect(m.distance).toBeCloseTo(R * RADIAL_SHARE, 6);
  });

  it("explodes radially by default, all parts at once on one ease", () => {
    const p = new SequencePlayer(resolved);
    expect(p.explodeMode).toBe("radial");
    const d = resolved.radial!.radius * RADIAL_SHARE;
    p.set({ t: 1 });
    near(at(p.pose().get("shell/px")), [d, 0, 0]);
    near(at(p.pose().get("shell/ny")), [0, -d, 0]);
    // mid-way every part is the same share of its way out (no stagger)
    p.set({ t: 0.3 });
    const share = (k: string) => Math.hypot(...at(p.pose().get(k))) / resolved.radial!.moves.get(k)!.distance;
    const shares = [...resolved.radial!.moves.keys()].map(share);
    for (const s of shares) expect(s).toBeCloseTo(radialEase(0.3), 6);
    expect(p.snapshot().explodeMode).toBe("radial");
    expect(p.snapshot().radial?.parts).toBe(7);
  });

  it("R5-A: Assemble moves the parts along the radial paths (fully out it is the explode), and a step command switches to it", () => {
    const p = new SequencePlayer(resolved);
    const r = new SequencePlayer(resolved);
    p.setMode("sequence", { instant: true });
    for (const t of [0, 1]) {
      p.set({ t });
      r.set({ t });
      for (const k of resolved.radial!.moves.keys()) near(at(p.pose().get(k)), at(r.pose().get(k)));
    }
    // part way: each part only along its own path (R2-B's paths, not the steps' own offsets)
    p.set({ t: 0.55 });
    for (const [k, m] of p.pose()) {
      const v = at(m);
      const mv = resolved.radial!.moves.get(k)!;
      near(v, mv.dir.map((x) => x * Math.hypot(...v)) as [number, number, number]);
    }
    expect(poseAt).toBeTypeOf("function");
    const q = new SequencePlayer(resolved);
    const first = resolved.steps[0]?.id;
    if (first) {
      expect(q.run({ action: "goto", step: first }).ok).toBe(true);
      expect(q.explodeMode).toBe("sequence");
    }
    expect(q.run({ action: "mode", mode: "radial" }).ok).toBe(true);
    expect(q.explodeMode).toBe("radial");
    expect(q.run({ action: "mode", mode: "nope" as never }).ok).toBe(false);
  });

  it("R5-A: a mode change while apart keeps every part where it is, paused (no fade, no autostart)", () => {
    const p = new SequencePlayer(resolved);
    let now = 1000;
    p.now = () => now;
    p.set({ t: 0.5 });
    const radialAt = at(p.pose().get("shell/px"));
    p.setMode("sequence");
    near(at(p.pose().get("shell/px")), radialAt);
    expect(p.tick(0.016)).toBe(false);
    now += MODE_BLEND_MS + 1;
    near(at(p.pose().get("shell/px")), radialAt);
    expect(p.playing).toBeUndefined();
  });

  it("a sub-assembly on its own (R2-A's explode.scope): only its parts move, about its own centre", () => {
    const p = new SequencePlayer(resolved);
    p.setScope("shell", { instant: true });
    p.set({ t: 1 });
    expect(p.pose().has("core")).toBe(false);
    expect(Math.hypot(...at(p.pose().get("shell/pz")))).toBeGreaterThan(0);
    expect(p.snapshot().scope).toBe("shell");
    expect(p.run({ action: "scope" }).ok).toBe(true);
    expect(p.scope).toBeUndefined();
  });

  it("without a radial plan (a player built on a bare resolution) it is the steps", () => {
    const r = resolveSequence({ assembly: model.assembly, gap: 10, planned: new Map([["core", 5]]) }, sequenceFromPlan(new Map([["core", 5]])), "planner");
    const p = new SequencePlayer(r);
    expect(p.explodeMode).toBe("sequence");
    expect(p.setMode("radial")).toBe(false);
  });
});

describe("explode overrides from a sequence file (R2-E writes them)", () => {
  it("reads a step's and a member's explode, the member winning, groups expanded, junk ignored", () => {
    const file = {
      schema: "protoboard.sequence/v0",
      main: "main",
      sequences: [
        {
          id: "main",
          groups: [{ id: "@feet", members: ["shell/foot_1", "shell/foot_2"] }],
          steps: [
            { id: "place:a", title: "a", kind: "place", members: [{ ref: "shell/a" }, { ref: "shell/b", explode: { distance: 5 } }], explode: { direction: [0, 0, 1], distance: 40 } },
            { id: "place:feet", title: "feet", kind: "place", members: [{ ref: "@feet", explode: { direction: [0, 0, -1] } }] },
            { id: "place:x", title: "x", kind: "place", members: [{ ref: "shell/x", explode: { direction: [0, 0, 0], distance: -3 } }] },
          ],
        },
      ],
    } as unknown as SequenceFile;
    const o = explodeOverrides(file);
    expect(o.get("shell/a")).toEqual({ direction: [0, 0, 1], distance: 40 });
    expect(o.get("shell/b")).toEqual({ direction: [0, 0, 1], distance: 5 });
    expect(o.get("shell/foot_2")).toEqual({ direction: [0, 0, -1] });
    expect(o.has("shell/x")).toBe(false);
  });
});
