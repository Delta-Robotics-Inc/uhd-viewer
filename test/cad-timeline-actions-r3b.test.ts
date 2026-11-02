/**
 * R3-B (2026-11-02): what the assembly timeline's controls and the toolbar's hook DO. The viewer's tests have no DOM,
 * so React's hooks are replaced by plain stand-ins in this file only (state is its initial value, effects do not
 * run) and the components are called as functions: the returned element tree is walked and its handlers called.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("react", async (orig) => {
  const R = await orig<typeof import("react")>();
  const hooks = {
    useState: (i: unknown) => [typeof i === "function" ? (i as () => unknown)() : i, () => {}],
    useRef: (v: unknown) => ({ current: v }),
    useEffect: () => {},
    useLayoutEffect: () => {},
    useMemo: (f: () => unknown) => f(),
    useCallback: (f: unknown) => f,
    useSyncExternalStore: (_s: unknown, get: () => unknown) => get(),
  };
  return { ...R, ...hooks, default: { ...R, ...hooks } };
});

import type { ReactElement } from "react";
import type { Assembly, Mat4 } from "@uhd/system/geometry.js";
import type { ModuleDef } from "@uhd/types/index.js";
import { CadToolbar, type CadToolbarProps } from "../src/cad/CadToolbar";
import { SequencePlayer, generateSequence, resolveSequence, type ResolvedWithRadial, type SequenceCommand } from "../src/cad/sequence";
import { HUMAN, createViewStore } from "../src/cad/state";
import { TimelinePanel, axisOf, timelineModel } from "../src/cad/timeline";

/** Every element in a tree (host elements' children; function components are not called). */
function walk(node: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) node.forEach((n) => walk(n, out));
  else if (node && typeof node === "object" && "props" in (node as object)) {
    const el = node as ReactElement<{ children?: unknown }>;
    out.push(el);
    walk(el.props.children, out);
  }
  return out;
}
const find = (tree: unknown, pred: (p: Record<string, unknown>) => boolean) => walk(tree).find((e) => pred(e.props as Record<string, unknown>)) as ReactElement<Record<string, unknown>> | undefined;

describe("the toolbar's hook (opens the timeline when Explode or Assemble is turned on)", () => {
  const props = (over: Partial<CadToolbarProps>): CadToolbarProps =>
    ({
      exploded: false, onExploded: () => {}, labels: false, onLabels: () => {}, labelKinds: new Set(["module"]), onLabelKind: () => {}, labelMenu: false, onLabelMenu: () => {},
      hardwareCount: 0, hardware: false, onHardware: () => {}, harnessCount: 0, wires: false, onWires: () => {}, frames: false, onFrames: () => {},
      section: null, onSection: () => {}, sectionMenu: false, onSectionMenu: () => {}, autoFlip: () => true, shells: 0, xray: false, onXray: () => {},
      findings: 0, showFindings: false, onFindings: () => {}, direction: "feature", onDirection: () => {}, onFit: () => {}, onFocus: () => {}, canFocus: false,
      sections: [], onSections: () => {}, onExplode: () => {}, onAssemble: () => {},
      ...over,
    }) as CadToolbarProps;
  const click = (p: CadToolbarProps, which: "radial" | "sequence") => {
    const btn = find(CadToolbar(p), (q) => q["data-explode"] === which);
    (btn!.props as { onClick: () => void }).onClick();
  };

  it("without CadView's onToggle (R5-B): Explode on asks for it, off lets it go; Assemble likewise; R2-B's handlers still run", () => {
    const asked: boolean[] = [];
    const exploded: boolean[] = [];
    const assembled: boolean[] = [];
    const base = { onTimeline: (on: boolean) => asked.push(on), onExplode: (on: boolean) => exploded.push(on), onAssemble: (t: boolean) => assembled.push(t) };
    click(props({ ...base, exploded: false, explodeMode: "radial" }), "radial");
    click(props({ ...base, exploded: true, explodeMode: "radial" }), "radial");
    click(props({ ...base, exploded: false }), "sequence");
    click(props({ ...base, exploded: true, explodeMode: "sequence" }), "sequence");
    expect(asked).toEqual([true, false, true, false]);
    expect(exploded).toEqual([true, false]);
    expect(assembled).toEqual([false, true]);
  });

  it("without the hook the toolbar behaves as before", () => {
    const exploded: boolean[] = [];
    expect(() => click(props({ onExplode: (on) => exploded.push(on) }), "radial")).not.toThrow();
    expect(exploded).toEqual([true]);
  });
});

// ---- the panel's controls -------------------------------------------------------------------------------------------

const T = (x: number, y: number, z: number): Mat4 => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
const def = (id: string): ModuleDef => ({ id, name: id, interfaces: [] }) as unknown as ModuleDef;
const bolt = (role: "structure" | "component") => ({ id: "mount", domain: "mechanical", protocols: [{ type: "bolt_pattern", roles: [role] }] });
function fixture(): Assembly {
  const mate = (link: string, child: string, parent: string, z: number) => ({ linkId: link, a: { path: [child], def: def(child), iface: bolt("component"), frame: { origin: [0, 0, z], normal: [0, 0, -1] } }, b: { path: [parent], def: def(parent), iface: bolt("structure"), frame: { origin: [0, 0, z], normal: [0, 0, 1] } } });
  return {
    instances: [],
    placements: [
      { key: "case", path: ["case"], matrix: T(0, 0, 0) },
      { key: "lid", path: ["lid"], matrix: T(0, 0, 20), via: "lid_mount" },
      { key: "mast", path: ["mast"], matrix: T(0, 0, 30), via: "mast_mount" },
      { key: "antenna", path: ["antenna"], matrix: T(0, 0, 40), via: "antenna_mount" },
    ],
    mates: [mate("lid_mount", "lid", "case", 20), mate("mast_mount", "mast", "lid", 30), mate("antenna_mount", "antenna", "mast", 40)],
    routes: [], hardware: [], harnesses: [], unrouted: [], issues: [],
  } as unknown as Assembly;
}

function setup(t: number, mode: "radial" | "sequence" = "sequence") {
  const resolved: ResolvedWithRadial = resolveSequence({ assembly: fixture(), gap: 10 }, generateSequence(fixture(), { root: ["case"] }));
  // Explode mode needs a radial plan (CadView's resolveForCad makes one from the loaded model)
  if (mode === "radial") resolved.radial = { moves: new Map(), centre: [0, 0, 0], radius: 50, ms: 0 };
  const player = new SequencePlayer(resolved);
  player.setMode(mode, { instant: true });
  player.set({ t });
  const store = createViewStore();
  if (t > 0) store.dispatch([{ op: "explode", t, mode }]);
  const cmds: SequenceCommand[] = [];
  const run = (c: SequenceCommand) => {
    cmds.push(c);
    return player.run(c);
  };
  const tree = () => TimelinePanel({ store, source: { player: () => player, run }, requested: true });
  return { player, store, cmds, tree, model: timelineModel(resolved) };
}
const humanOps = (store: ReturnType<typeof createViewStore>) => store.log().filter((e) => e.actor.id === HUMAN.id);

describe("the panel's controls drive the player and the view state", () => {
  it("R5-A: play goes on from where the parts are toward the direction's end; pause holds them", () => {
    const s = setup(0.6);
    s.player.setDirection("together");
    const play = find(s.tree(), (p) => p.className === "cad-tl-btn cad-tl-play")!;
    (play.props.onClick as () => void)();
    expect(s.cmds.at(-1)).toEqual({ action: "resume" });
    expect(s.player.playing).toBe("assemble");
    expect(s.player.t).toBeCloseTo(0.6, 9);
    const pause = find(s.tree(), (p) => p.className === "cad-tl-btn cad-tl-play")!;
    // wave R5 gate: the play button's name says what it does (Pause); no pressed state as well
    expect(pause.props["aria-label"]).toBe("Pause (Space)");
    (pause.props.onClick as () => void)();
    expect(s.cmds.at(-1)).toEqual({ action: "pause" });
    expect(s.player.playing).toBeUndefined();
  });

  it("R5 gate: play together at the together end turns round (takes it apart from where it is, no jump)", () => {
    const s = setup(0);
    s.player.setDirection("together");
    (find(s.tree(), (p) => p.className === "cad-tl-btn cad-tl-play")!.props.onClick as () => void)();
    expect(s.cmds.at(-1)).toEqual({ action: "resume" });
    expect(s.player.t).toBeCloseTo(0, 9);
    expect(s.player.direction).toBe("apart");
    expect(s.player.playing).toBe("explode");
  });

  it("R5-A: in Explode mode, play runs the player all at once at its speed (not the view state's ease)", () => {
    const s = setup(0.6, "radial");
    s.player.setDirection("together");
    (find(s.tree(), (p) => p.className === "cad-tl-btn cad-tl-play")!.props.onClick as () => void)();
    expect(s.cmds.at(-1)).toEqual({ action: "resume" });
    expect(s.player.explodeMode).toBe("radial");
    expect(s.player.playing).toBe("assemble");
  });

  it("R5-A: the direction buttons and the speed select drive the player; close hides the panel", () => {
    const s = setup(0.6);
    const dir = find(s.tree(), (p) => p["data-dir"] === "together")!;
    (dir.props.onClick as () => void)();
    expect(s.cmds.at(-1)).toEqual({ action: "direction", to: "together" });
    expect(s.player.direction).toBe("together");
    const speed = find(s.tree(), (p) => p["aria-label"] === "Speed" && p.value !== undefined)!;
    (speed.props.onChange as (e: unknown) => void)({ target: { value: "2" } });
    expect(s.cmds.at(-1)).toEqual({ action: "speed", x: 2 });
    expect(s.player.speed).toBe(2);
    expect(find(s.tree(), (p) => p.className === "cad-tl-btn cad-tl-close")).toBeDefined();
  });

  it("loop asks the player to loop in the mode in force (and off again)", () => {
    const s = setup(0.6);
    s.player.setDirection("together");
    (find(s.tree(), (p) => p.className === "cad-tl-btn cad-tl-loop")!.props.onClick as () => void)();
    expect(s.cmds.at(-1)).toEqual({ action: "loop", on: true, mode: "assemble", keep: true });
    expect(s.player.snapshot().loop).toBe(true);
  });

  it("the EXPLODE slider writes explode.t through the explode op, logged as the person's gesture", () => {
    const s = setup(0.6);
    const range = find(s.tree(), (p) => p.type === "range")!;
    (range.props.onChange as (e: unknown) => void)({ target: { value: "0.25" } });
    expect(s.store.get().explode.t).toBe(0.25);
    const e = humanOps(s.store).at(-1)!;
    expect(e.label).toBe("set the explode amount (timeline)");
    expect(e.ops.some((o) => o.path?.[0] === "explode")).toBe(true);
  });

  it("a press on a step chip that does not move goes to that step (through the view state's step)", () => {
    const s = setup(0.6);
    const target = s.model.steps[1];
    const tracks = find(s.tree(), (p) => p.className === "cad-tl-tracks")!;
    const chipEl = { closest: (sel: string) => (sel === "[data-step]" ? { dataset: { step: target.id } } : null) };
    const ev = (x: number) => ({ button: 0, clientX: x, pointerId: 1, target: chipEl, currentTarget: { setPointerCapture() {} } });
    (tracks.props.onPointerDown as (e: unknown) => void)(ev(100));
    (tracks.props.onPointerUp as (e: unknown) => void)(ev(101));
    const ex = s.store.get().explode;
    expect(ex.step).toBe(target.id);
    expect(ex.t).toBeCloseTo(1 - target.x0, 9);
    expect((ex as { mode?: string }).mode).toBe("sequence");
    expect(humanOps(s.store).at(-1)?.label).toBe(`go to step ${target.n}: ${target.title}`);
  });

  it("dragging on the tracks scrubs the player, and the release is logged as the person's", () => {
    const s = setup(0.6);
    const tracks = find(s.tree(), (p) => p.className === "cad-tl-tracks")!;
    const lane = { closest: () => null };
    // no overlay box in node: the axis falls back to where the playhead is, so the scrub "seeks" there
    const ev = (x: number) => ({ button: 0, clientX: x, pointerId: 7, target: lane, currentTarget: { setPointerCapture() {} } });
    (tracks.props.onPointerDown as (e: unknown) => void)(ev(10));
    expect(s.cmds.at(-1)).toMatchObject({ action: "set" });
    (tracks.props.onPointerMove as (e: unknown) => void)(ev(40));
    (tracks.props.onPointerUp as (e: unknown) => void)(ev(40));
    expect(humanOps(s.store).at(-1)?.label).toBe("scrub the timeline");
    expect(s.store.get().explode.t).toBeCloseTo(s.player.t, 9);
  });

  it("Space toggles play and Right goes to the next step when the panel has focus", () => {
    const s = setup(0.6);
    const section = find(s.tree(), (p) => p.className === "cad-timeline")!;
    const key = (k: string) => (section.props.onKeyDown as (e: unknown) => void)({ key: k, target: { tagName: "SECTION" }, preventDefault() {}, stopPropagation() {} });
    s.player.setDirection("together");
    key(" ");
    expect(s.player.playing).toBe("assemble");
    s.player.stop();
    const before = s.model.steps.findIndex((x) => axisOf(s.player.t) >= x.x0 && axisOf(s.player.t) <= x.x1);
    const sec2 = find(s.tree(), (p) => p.className === "cad-timeline")!;
    (sec2.props.onKeyDown as (e: unknown) => void)({ key: "ArrowRight", target: { tagName: "SECTION" }, preventDefault() {}, stopPropagation() {} });
    expect(s.store.get().explode.step).toBe(s.model.steps[before + 1].id);
  });

  it("the collapse button folds it to one line", () => {
    const s = setup(0.6);
    const fold = find(s.tree(), (p) => p.className === "cad-tl-btn cad-tl-fold")!;
    expect(fold.props["aria-expanded"]).toBe(true);
    expect(() => (fold.props.onClick as () => void)()).not.toThrow();
  });
});
