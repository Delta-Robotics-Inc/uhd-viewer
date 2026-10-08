/**
 * The 3D view of one module (PB-897, PB-946): a module's view is built from
 * that module alone, and paths, hints and findings are translated between
 * the root and the module. On the IMU pod fixture: an enclosure that holds a
 * board, whose components are drawn in the board's own body.
 */
import { describe, expect, it } from "vitest";
import type { ModuleDef } from "@uhd/types/index.js";
import type { Mat4 } from "@uhd/system/geometry.js";
import { buildCadModel, defAt } from "../src/cad/model";
import { anchorOf } from "../src/cad/findings";
import { intoScope, outOfScope, scopeRef, scopedPlacements, scopedRoot, shownSummary } from "../src/cad/scope";
import bundle from "../fixtures/imu-pod/uhd-bundle.json";

const defs = new Map((bundle.definitions as unknown as ModuleDef[]).map((d) => [d.id, d]));
const lookup = (id: string) => defs.get(id);
const root = defs.get(bundle.root)!;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as unknown as Mat4;

describe("paths between the root and a module's own view", () => {
  it("translates instance paths both ways", () => {
    expect(intoScope("board/u2", "board")).toBe("u2");
    expect(intoScope("board", "board")).toBe("");
    expect(intoScope("enclosure", "board")).toBeUndefined();
    expect(intoScope("boardroom/u2", "board")).toBeUndefined();
    expect(intoScope("board/u2", "")).toBe("board/u2");
    expect(outOfScope("u2", "board")).toBe("board/u2");
    expect(outOfScope("", "board")).toBe("board");
    expect(outOfScope("u2", "")).toBe("u2");
    for (const p of ["u2", "", "a/b"]) expect(intoScope(outOfScope(p, "stack/fc"), "stack/fc")).toBe(p);
  });

  it("translates a finding's reference, and drops what lies outside", () => {
    expect(scopeRef("board/u2:pin_14", "board")).toBe("u2:pin_14");
    expect(scopeRef("board:sda", "board")).toBe(":sda");
    expect(scopeRef("board", "board")).toBe("");
    expect(scopeRef("link:board/i2c_bus", "board")).toBe("link:i2c_bus");
    expect(scopeRef("link:board_mount", "board")).toBeUndefined();
    expect(scopeRef("enclosure:swd_window", "board")).toBeUndefined();
    expect(scopeRef("enclosure:swd_window", "")).toBe("enclosure:swd_window");
  });

  it("keeps the display hints inside the module, re-keyed to it", () => {
    const placements = { "board/u2": { matrix: IDENTITY }, "board/j1#shell": { matrix: IDENTITY, note: "by hand" }, board: { matrix: IDENTITY }, lid: { matrix: IDENTITY } };
    expect(scopedPlacements(placements, "").map((h) => h.path.join("/"))).toEqual(["board/u2", "board/j1#shell", "board", "lid"]);
    const inside = scopedPlacements(placements, "board");
    expect(inside.map((h) => h.path.join("/"))).toEqual(["u2", "j1#shell"]);
    expect(inside[1].note).toBe("by hand");
    expect(inside[0].note).toBe("placed by a display hint");
    expect(scopedPlacements(undefined, "board")).toEqual([]);
    expect(scopedRoot("board/u2", "board")).toEqual(["u2"]);
    expect(scopedRoot("board", "board")).toBeUndefined();
    expect(scopedRoot("enclosure", "board")).toBeUndefined();
    expect(scopedRoot("enclosure", "")).toEqual(["enclosure"]);
    expect(scopedRoot(undefined, "")).toBeUndefined();
  });
});

describe("what a module's 3D view shows", () => {
  const whole = buildCadModel(root, lookup, new Map());
  const board = defAt(root, lookup, ["board"])!;
  const alone = buildCadModel(board, lookup, new Map());

  it("the root shows the whole assembly: the board is one body among the others", () => {
    expect(whole.bodies.length).toBeGreaterThan(1);
    expect(whole.bodies.some((b) => b.key === "board")).toBe(true);
    const s = shownSummary(whole, root, lookup);
    expect(s.loose).toBe(false);
    expect(s.placed.map((p) => p.id)).toContain("board");
  });

  it("a board shows itself alone, as its own body, its components in it", () => {
    // nothing of the rest of the assembly
    expect(alone.bodies.map((b) => b.key)).toEqual([""]);
    expect(alone.bodies[0].def.id).toBe(board.id);
    expect(alone.bodies[0].glb).toBeDefined();
    // in its own coordinates: placed at the origin, not where the enclosure holds it
    expect([...alone.bodies[0].matrix]).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const inAssembly = whole.bodies.find((b) => b.key === "board")!;
    expect([...inAssembly.matrix]).not.toEqual([...alone.bodies[0].matrix]);
    // every component is drawn by the board's body
    const s = shownSummary(alone, board, lookup);
    expect(s.ownBody).toBe(true);
    expect(s.parts).toBe((board.children ?? []).length);
    expect(s.unplaced).toEqual([]);
    expect(s.loose).toBe(false);
    for (const c of board.children ?? []) expect(alone.within.get(c.id), c.id).toBe("");
  });

  it("a finding from the root lands on the board's own view, and one outside it does not", () => {
    const child = board.children![0].id;
    const inside = scopeRef(`board/${child}`, "board")!;
    expect(anchorOf(alone, inside)).toMatchObject({ body: "", select: { body: "", component: child } });
    expect(scopeRef("enclosure", "board")).toBeUndefined();
  });

  it("a module whose parts nothing joins has no picture: one part alone is not it", () => {
    // the same board without its body: its components have no mechanical links between them
    const bare: ModuleDef = { ...board, artifacts: (board.artifacts ?? []).filter((a) => a.format !== "glb") };
    const model = buildCadModel(bare, lookup, new Map());
    const s = shownSummary(model, bare, lookup);
    expect(s.ownBody).toBe(false);
    expect(s.parts).toBeGreaterThan(1);
    expect(s.placed.length).toBeLessThanOrEqual(1);
    expect(s.unplaced.length).toBeGreaterThan(0);
    expect(s.loose).toBe(true);
    expect(s.unplaced[0].name).toBeTruthy();
  });

  it("a part with no children is shown on its own", () => {
    const leafRef = board.children![0];
    const leaf = lookup(leafRef.moduleDefId)!;
    const model = buildCadModel(leaf, lookup, new Map());
    const s = shownSummary(model, leaf, lookup);
    expect(s.parts).toBe(0);
    expect(s.loose).toBe(false);
  });
});
