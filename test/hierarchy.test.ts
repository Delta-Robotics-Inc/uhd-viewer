/**
 * The hierarchy panel's model (PB-1042): the tree of every level, kinds and
 * icons, marks and findings, the filter, the rows on screen, the keyboard, and
 * how rows and the diagram's level and selection map to each other. On the
 * IMU pod fixture (a board with components and nets, an enclosure), and on a
 * small system with a harness, a group, quantities and a definition that names
 * itself.
 */
import { describe, expect, it } from "vitest";
import { icons } from "lucide-react";
import type { ModuleDef } from "@uhd/types/index.js";
import {
  BLANK_ICON,
  KIND_ICON,
  ancestorsOf,
  buildHierarchy,
  drillInto,
  filterHierarchy,
  groupWiring,
  hierarchyIndex,
  markLegend,
  modulePart,
  panelState,
  revealPaths,
  rowTarget,
  selectedPath,
  treeKey,
  visibleRows,
  HIERARCHY_WIDTH,
  WIRING_PATH,
} from "../src/model/hierarchy";
import { systemDiagnostics } from "../src/model/diagnostics";
import bundle from "../fixtures/imu-pod/uhd-bundle.json";

const defs = new Map((bundle.definitions as unknown as ModuleDef[]).map((d) => [d.id, d]));
const lookup = (id: string) => defs.get(id);
const root = defs.get(bundle.root)!;

const mod = (id: string, extra: Partial<ModuleDef> = {}): ModuleDef => ({ id, name: id.toUpperCase(), interfaces: [], ...extra });
const small = (): { root: ModuleDef; lookup: (id: string) => ModuleDef | undefined } => {
  const all = [
    mod("drone", { children: [{ id: "frame", moduleDefId: "frame" }, { id: "power", moduleDefId: "power", name: "Power train" }, { id: "loom", moduleDefId: "loom" }, { id: "bolts", moduleDefId: "bolts" }, { id: "mystery", moduleDefId: "missing-def" }] }),
    mod("frame", { categories: ["mechanical.structure.frame"], children: [{ id: "arm", moduleDefId: "arm", quantity: 4 }] }),
    mod("arm", { children: [{ id: "motor", moduleDefId: "motor" }] }),
    mod("motor", { categories: ["actuator.motor"] }),
    mod("power", { kind: "group", children: [{ id: "battery", moduleDefId: "battery" }, { id: "loop", moduleDefId: "loop" }] }),
    mod("battery", {}),
    mod("loop", { children: [{ id: "again", moduleDefId: "loop" }] }),
    mod("loom", { kind: "harness", children: [{ id: "inside", moduleDefId: "battery" }] }),
    mod("bolts", { kind: "harness", fastenerStack: [{ part: "m3", quantity: 4 } as never] }),
  ];
  const m = new Map(all.map((d) => [d.id, d]));
  return { root: m.get("drone")!, lookup: (id) => m.get(id) };
};

describe("the hierarchy's tree", () => {
  it("holds every level of the system, with kinds and icons", () => {
    const [tree] = buildHierarchy(root, lookup);
    expect(tree.path).toBe("");
    expect(tree.kind).toBe("system");
    expect(tree.children.map((c) => c.path)).toEqual(["board", "enclosure"]);
    const board = tree.children[0];
    expect(board.kind).toBe("board");
    expect(board.drillable).toBe(true);
    expect(board.children.map((c) => c.path)).toEqual(["board/u1", "board/u2", "board/u3", "board/l1", "board/r1", "board/r2", "board/r3", "board/r4"]);
    expect(board.children.every((c) => c.kind === "part" && !c.drillable && c.parent === "board" && c.depth === 2)).toBe(true);
    expect(tree.children[1].kind).toBe("enclosure");
    expect(hierarchyIndex([tree]).size).toBe(11);
  });

  it("knows harnesses, fastener stacks, groups, structures and quantities, and stops where a definition names itself", () => {
    const s = small();
    const [tree] = buildHierarchy(s.root, s.lookup);
    const at = hierarchyIndex([tree]);
    expect(at.get("frame")!.kind).toBe("structure");
    expect(at.get("frame/arm")!.quantity).toBe(4);
    expect(at.get("frame/arm")!.kind).toBe("assembly");
    expect(at.get("frame/arm/motor")!.kind).toBe("part");
    expect(at.get("power")!.kind).toBe("group");
    expect(at.get("power")!.label).toBe("Power train");
    // a harness is a leaf: its children are not a level of the system
    expect(at.get("loom")!.kind).toBe("harness");
    expect(at.get("loom")!.children).toEqual([]);
    expect(at.get("loom")!.drillable).toBe(false);
    expect(at.get("bolts")!.kind).toBe("fasteners");
    // a definition that holds itself shows once below itself, then stops
    expect(at.get("power/loop/again")).toBeDefined();
    expect(at.get("power/loop/again/again")).toBeUndefined();
    // a definition the bundle lacks is a part named by its id
    expect(at.get("mystery")!.label).toBe("mystery");
  });

  it("uses icons Lucide has", () => {
    const pascal = (name: string) => name.replace(/(^|-)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());
    for (const name of [...Object.values(KIND_ICON), BLANK_ICON]) expect(icons[pascal(name) as keyof typeof icons], name).toBeDefined();
  });

  it("carries the host's marks, a blank block's ring, and placeholders", () => {
    const u2 = defs.get(root.children![0].moduleDefId)!.children!.find((c) => c.id === "u2")!.moduleDefId;
    const [tree] = buildHierarchy(root, lookup, {
      marks: { [u2]: { tone: "ok", label: "Verified" }, [root.children![1].moduleDefId]: { tone: "neutral", shape: "ring", label: "Blank block" } },
      isMissing: (d) => d.id === u2,
    });
    const at = hierarchyIndex([tree]);
    expect(at.get("board/u2")!.mark).toEqual({ tone: "ok", label: "Verified" });
    expect(at.get("board/u2")!.missing).toBe(true);
    expect(at.get("enclosure")!.icon).toBe(BLANK_ICON);
    expect(at.get("board/u1")!.mark).toBeUndefined();
  });

  it("places findings on the module they name and rolls the worst up", () => {
    const [tree] = buildHierarchy(root, lookup, {
      diagnostics: [
        { id: "x", rule: "r", severity: "warning", message: "m", refs: ["board/u2:pin_14"], scope: "board" },
        { id: "y", rule: "r", severity: "info", message: "m", refs: [":sda"], scope: "board" },
      ] as never,
      hostDiagnostics: [
        { code: "c", severity: "error", message: "m", entity: { kind: "instance", id: "board/r1" } },
        { code: "d", severity: "warning", message: "m", entity: { kind: "definition", id: defs.get(root.children![1].moduleDefId)!.id } },
        { code: "e", severity: "warning", message: "m" },
      ],
    });
    const at = hierarchyIndex([tree]);
    expect(at.get("board/u2")!.findings).toEqual({ error: 0, warning: 1, info: 0 });
    expect(at.get("board")!.findings.info).toBe(1);
    expect(at.get("board/r1")!.findings.error).toBe(1);
    expect(at.get("enclosure")!.findings.warning).toBe(1);
    expect(tree.findings.warning).toBe(1);
    expect(at.get("board")!.worst).toBe("error");
    expect(tree.worst).toBe("error");
    expect(at.get("board/u1")!.worst).toBeUndefined();
  });

  it("takes the viewer's own checks as they come", () => {
    const [tree] = buildHierarchy(root, lookup, { diagnostics: systemDiagnostics(root, lookup) });
    const total = [...hierarchyIndex([tree]).values()].reduce((n, x) => n + x.findings.error + x.findings.warning + x.findings.info, 0);
    expect(total).toBe(systemDiagnostics(root, lookup).length);
  });

  it("reads the module a ref names", () => {
    expect(modulePart("board/u2:pin_14", "")).toBe("board/u2");
    expect(modulePart("link:board/u2_i2c", "")).toBe("board");
    expect(modulePart("link:top", "")).toBe("");
    expect(modulePart(":sda", "board")).toBe("board");
    expect(modulePart("enclosure", "")).toBe("enclosure");
  });
});

describe("wiring and hardware, and the legend", () => {
  it("folds every harness and fastener stack into one group at the bottom", () => {
    const s = small();
    const shown = groupWiring(buildHierarchy(s.root, s.lookup));
    expect(shown.map((n) => n.path)).toEqual(["", WIRING_PATH]);
    const [structure, wiring] = shown;
    expect(wiring.group).toBe(true);
    expect(wiring.children.map((n) => n.path)).toEqual(["loom", "bolts"]);
    // each says where it belongs (four "Prop nut" rows read alike otherwise)
    expect(wiring.children.map((n) => n.where)).toEqual(["DRONE", "DRONE"]);
    expect(structure.children.map((n) => n.path)).toEqual(["frame", "power", "mystery"]);
    // closed until opened, like any row; its rows keep their paths
    expect(visibleRows(shown, new Set([""])).map((r) => r.node.path)).toEqual(["", "frame", "power", "mystery", WIRING_PATH]);
    expect(visibleRows(shown, new Set(["", WIRING_PATH])).slice(-2).map((r) => r.node.path)).toEqual(["loom", "bolts"]);
    // a system without any: the tree as it was
    const imu = buildHierarchy(root, lookup);
    expect(groupWiring(imu)).toEqual(imu);
  });

  it("names each tone the tree shows once, from its marks", () => {
    const s = small();
    const tree = buildHierarchy(s.root, s.lookup, {
      marks: {
        motor: { tone: "ok", label: "Verified. In a library and verified." },
        battery: { tone: "neutral", label: "Local. Only in this project." },
        arm: { tone: "neutral", label: "Local. Only in this project." },
        frame: { tone: "warning", label: "Unverified. Check it." },
        loop: { tone: "neutral", shape: "ring", label: "Blank block. Nothing chosen yet." },
      },
    });
    expect(markLegend(tree)).toEqual([
      { tone: "neutral", label: "Local" },
      { tone: "warning", label: "Unverified" },
      { tone: "ok", label: "Verified" },
    ]);
    expect(markLegend(buildHierarchy(root, lookup))).toEqual([]);
  });
});

describe("filter and rows", () => {
  const tree = buildHierarchy(root, lookup);

  it("shows the root open, and children of open modules only", () => {
    expect(visibleRows(tree, new Set([""])).map((r) => r.node.path)).toEqual(["", "board", "enclosure"]);
    const rows = visibleRows(tree, new Set(["", "board"]));
    expect(rows).toHaveLength(11);
    const u1 = rows.find((r) => r.node.path === "board/u1")!;
    expect(u1).toMatchObject({ level: 3, branch: false, open: false, pos: 1, size: 8 });
    expect(rows[1]).toMatchObject({ level: 2, branch: true, open: true, pos: 1, size: 2 });
  });

  it("keeps what matches every word, with the modules that lead there open", () => {
    const f = filterHierarchy(tree, "resist");
    expect([...f.matches].sort()).toEqual(["board/r1", "board/r2", "board/r3", "board/r4"]);
    expect([...f.expanded].sort()).toEqual(["", "board"]);
    expect(visibleRows(f.nodes, f.expanded).map((r) => r.node.path)).toEqual(["", "board", "board/r1", "board/r2", "board/r3", "board/r4"]);
    expect(filterHierarchy(tree, "board r2").matches).toEqual(new Set(["board/r2"]));
    expect(filterHierarchy(tree, "nothing-like-it").nodes).toEqual([]);
    // a matching module keeps its children
    const b = filterHierarchy(tree, "board").nodes[0].children[0];
    expect(b.children).toHaveLength(8);
    // and what matches inside it shows: the module opens, and its matching children are matches, not dimmed rows
    const inside = filterHierarchy(tree, "board");
    expect(inside.matches.has("board")).toBe(true);
    expect(inside.matches.has("board/u1")).toBe(true);
    expect(inside.expanded.has("board")).toBe(true);
    expect(filterHierarchy(tree, "  ").nodes).toEqual(tree);
  });
});

describe("the keyboard", () => {
  const tree = buildHierarchy(root, lookup);
  const open = new Set(["", "board"]);
  const rows = visibleRows(tree, open);

  it("moves with the arrows, Home and End", () => {
    expect(treeKey(rows, "board", "ArrowDown", open)!.focus).toBe("board/u1");
    expect(treeKey(rows, "board", "ArrowUp", open)!.focus).toBe("");
    expect(treeKey(rows, "", "ArrowUp", open)!.focus).toBe("");
    expect(treeKey(rows, "board/u1", "End", open)!.focus).toBe("enclosure");
    expect(treeKey(rows, "enclosure", "ArrowDown", open)!.focus).toBe("enclosure");
    expect(treeKey(rows, "enclosure", "Home", open)!.focus).toBe("");
  });

  it("opens and closes with Right and Left, and goes to the child or the parent", () => {
    const closed = new Set([""]);
    const shut = visibleRows(tree, closed);
    const opened = treeKey(shut, "board", "ArrowRight", closed)!;
    expect(opened.focus).toBe("board");
    expect(opened.expanded.has("board")).toBe(true);
    expect(treeKey(rows, "board", "ArrowRight", open)!.focus).toBe("board/u1");
    const closedAgain = treeKey(rows, "board", "ArrowLeft", open)!;
    expect(closedAgain.expanded.has("board")).toBe(false);
    expect(closedAgain.focus).toBe("board");
    expect(treeKey(rows, "board/r3", "ArrowLeft", open)!.focus).toBe("board");
    // a leaf stays put on Right
    expect(treeKey(rows, "board/r3", "ArrowRight", open)!.focus).toBe("board/r3");
  });

  it("selects with Enter and Space, and drills with Enter on the selected module", () => {
    expect(treeKey(rows, "board", "Enter", open)!.action).toBe("select");
    expect(treeKey(rows, "board", "Enter", open, "board")!.action).toBe("drill");
    // a part has no level of its own: Enter selects it again
    expect(treeKey(rows, "board/u1", "Enter", open, "board/u1")!.action).toBe("select");
    expect(treeKey(rows, "board", " ", open, "board")!.action).toBe("select");
  });

  it("opens every sibling with *, and leaves other keys to the filter", () => {
    const r = treeKey(visibleRows(tree, new Set([""])), "enclosure", "*", new Set([""]))!;
    expect(r.expanded.has("board")).toBe(true);
    expect(treeKey(rows, "board", "a", open)).toBeUndefined();
    expect(treeKey([], "", "ArrowDown", open)).toBeUndefined();
  });
});

describe("the tree and the diagram", () => {
  const none = { drill: [] as string[], expanded: new Set<string>() };

  it("selects a row on the level that holds it", () => {
    expect(rowTarget(root, lookup, "board", none)).toEqual({ drill: [], selection: { kind: "node", id: "board" } });
    expect(rowTarget(root, lookup, "board/u2", none)).toEqual({ drill: ["board"], selection: { kind: "node", id: "u2" } });
    // drawn on the current level when its module is expanded in place there
    expect(rowTarget(root, lookup, "board/u2", { drill: [], expanded: new Set(["board"]) })).toEqual({ drill: [], selection: { kind: "node", id: "board/u2" } });
    // the root row: the top level, nothing selected
    expect(rowTarget(root, lookup, "", { drill: ["board"], expanded: new Set() })).toEqual({ drill: [], selection: null });
  });

  it("drills into a module", () => {
    const [tree] = buildHierarchy(root, lookup);
    expect(drillInto(hierarchyIndex([tree]).get("board")!)).toEqual({ drill: ["board"], selection: null });
    expect(drillInto(tree)).toEqual({ drill: [], selection: null });
  });

  it("finds the row of the canvas's selection", () => {
    expect(selectedPath(["board"], { kind: "node", id: "u2" })).toBe("board/u2");
    expect(selectedPath([], { kind: "node", id: "board/u2" })).toBe("board/u2");
    expect(selectedPath([], { kind: "node", id: "enclosure" })).toBe("enclosure");
    expect(selectedPath(["board"], { kind: "node", id: ":sda" })).toBeUndefined();
    expect(selectedPath(["board"], { kind: "node", id: "@sda" })).toBeUndefined();
    expect(selectedPath([], { kind: "link", id: "x" })).toBeUndefined();
    expect(selectedPath([], null)).toBeUndefined();
  });

  it("opens the rows above what it reveals", () => {
    expect(ancestorsOf("board/u2")).toEqual(["", "board"]);
    expect(ancestorsOf("")).toEqual([]);
    const shown = new Set([""]);
    expect([...revealPaths(shown, "board/u2")].sort()).toEqual(["", "board"]);
    // nothing to open: the same set back (no re-render)
    const already = new Set(["", "board"]);
    expect(revealPaths(already, "board/u2")).toBe(already);
    expect(revealPaths(already, undefined)).toBe(already);
  });
});

describe("what a tab keeps", () => {
  it("reads a kept state and falls back on anything malformed", () => {
    expect(panelState({ open: false, width: 300, expanded: ["", "board"] })).toEqual({ open: false, width: 300, expanded: ["", "board"] });
    expect(panelState(undefined)).toEqual({ open: true, width: HIERARCHY_WIDTH.default, expanded: [""] });
    expect(panelState(undefined, false).open).toBe(false);
    expect(panelState({ open: "yes", width: "wide", expanded: [1, "a"] })).toEqual({ open: true, width: HIERARCHY_WIDTH.default, expanded: ["a"] });
    expect(panelState({ width: 10_000 }).width).toBe(HIERARCHY_WIDTH.max);
    expect(panelState({ width: 3 }).width).toBe(HIERARCHY_WIDTH.min);
  });
});

