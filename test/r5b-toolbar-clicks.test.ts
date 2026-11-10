/**
 * R5-B: the toolbar's Explode and Assemble buttons, clicked. As in cad-timeline-actions-r3b.test.ts, React's hooks are
 * plain stand-ins in this file only and the toolbar is called as a function; its element tree is walked and the
 * buttons' handlers called.
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
import { CadToolbar, type CadToolbarProps } from "../src/cad/CadToolbar";
import { pressToggle, type MotionToggle, type MotionToggles } from "../src/cad/nav";

function walk(node: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) node.forEach((n) => walk(n, out));
  else if (node && typeof node === "object" && "props" in (node as object)) {
    const el = node as ReactElement<{ children?: unknown }>;
    out.push(el);
    walk(el.props.children, out);
  }
  return out;
}

const ALL: MotionToggles[] = [
  { explode: false, assemble: false },
  { explode: true, assemble: false },
  { explode: false, assemble: true },
  { explode: true, assemble: true },
];

const props = (over: Partial<CadToolbarProps>): CadToolbarProps =>
  ({
    exploded: false, onExploded: () => {}, labels: false, onLabels: () => {}, labelKinds: new Set(["module"]), onLabelKind: () => {}, labelMenu: false, onLabelMenu: () => {},
    hardwareCount: 0, hardware: false, onHardware: () => {}, harnessCount: 0, wires: false, onWires: () => {}, frames: false, onFrames: () => {},
    section: null, onSection: () => {}, sectionMenu: false, onSectionMenu: () => {}, autoFlip: () => true, shells: 0, xray: false, onXray: () => {},
    findings: 0, showFindings: false, onFindings: () => {}, direction: "feature", onDirection: () => {}, onFit: () => {}, onFocus: () => {}, canFocus: false,
    sections: [], onSections: () => {},
    ...over,
  }) as CadToolbarProps;
const button = (p: CadToolbarProps, which: MotionToggle) => walk(CadToolbar(p)).find((e) => (e.props as Record<string, unknown>)["data-toggle"] === which) as ReactElement<{ onClick: () => void; pressed?: boolean; label?: string }>;

describe("clicking Explode and Assemble (R5-B)", () => {
  it("each click reports only its own toggle's new state, in all four combinations", () => {
    for (const t of ALL) {
      for (const which of ["explode", "assemble"] as const) {
        const calls: [MotionToggle, boolean][] = [];
        const p = props({ toggles: t, onToggle: (w, on) => calls.push([w, on]) });
        const b = button(p, which);
        expect(b.props.pressed).toBe(t[which]);
        expect(b.props.label).toBe(which === "explode" ? "Explode" : "Assemble");
        b.props.onClick();
        expect(calls).toEqual([[which, !t[which]]]);
      }
    }
  });

  it("a click wired to a motion controller (as CadView wires it) sets its own flag and never calls play", () => {
    for (const t of ALL) {
      for (const which of ["explode", "assemble"] as const) {
        const ctrl = { setExplode: vi.fn(), setAssemble: vi.fn(), play: vi.fn() };
        button(props({ toggles: t, onToggle: (w) => pressToggle(ctrl, t, w) }), which).props.onClick();
        expect(ctrl.play).not.toHaveBeenCalled();
        const own = which === "explode" ? ctrl.setExplode : ctrl.setAssemble;
        const other = which === "explode" ? ctrl.setAssemble : ctrl.setExplode;
        expect(own).toHaveBeenCalledWith(!t[which]);
        expect(other).not.toHaveBeenCalled();
      }
    }
  });
});
