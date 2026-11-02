/**
 * R3-B (2026-11-02): the assembly timeline under the 3D toolbar (Kevin's chosen concept, image 1's bottom panel).
 * Its model (the assembly axis, steps, joint keyframes and segments, contacts from the interference sweep, the header
 * words, when it shows, the keyboard, the remembered collapse), the panel as rendered (server markup), and the
 * contrast of the tokens it draws with in the dark and paper themes.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Assembly, Mat4 } from "@uhd/system/geometry.js";
import type { ModuleDef } from "@uhd/types/index.js";
import { SequencePlayer, generateSequence, resolveSequence, type SequenceFile } from "../src/cad/sequence";
import { createViewStore } from "../src/cad/state";
import {
  COLLAPSED_KEY,
  TIMELINE_CSS,
  TimelinePanel,
  activeSegment,
  axisOf,
  chipState,
  chipText,
  contactText,
  contactsFromReport,
  contactsOf,
  headerText,
  jointLabel,
  keyAction,
  loadCollapsed,
  neighbourStep,
  saveCollapsed,
  stepIndexAt,
  tOfAxis,
  timelineModel,
  timelineWanted,
  type InterferenceReportLike,
} from "../src/cad/timeline";
import { CONTRAST_GRAPHIC, CONTRAST_TEXT, contrastRatio } from "../src/theme/contrast";
import { defaultDark, defaultLight } from "../src/theme/themes";

const T = (x: number, y: number, z: number): Mat4 => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
const def = (id: string): ModuleDef => ({ id, name: id, interfaces: [] }) as unknown as ModuleDef;
const bolt = (role: "structure" | "component") => ({ id: "mount", domain: "mechanical", protocols: [{ type: "bolt_pattern", roles: [role] }] });

/** A case, a lid bolted on top, a mast bolted on the lid and an antenna on the mast (a fit step each). */
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
    routes: [],
    hardware: [],
    harnesses: [],
    unrouted: [],
    issues: [],
  } as unknown as Assembly;
}

/** The generated sequence plus a fold joint on the mast and a keyframe ("unfold to 135", beyond the 90 stop) on the last step. */
function withFold(): SequenceFile {
  const f = generateSequence(fixture(), { root: ["case"] });
  f.sequences[0].joints = [{ id: "gps_fold", type: "revolute", part: "mast", along: { at: [0, 0, 30], axis: [1, 0, 0] }, min: 0, max: 90, rest: 0, limitsFrom: "mate:trait" }];
  const last = f.sequences[0].steps[f.sequences[0].steps.length - 1];
  last.joints = { gps_fold: 135 };
  return f;
}
const resolved = () => resolveSequence({ assembly: fixture(), gap: 10 }, withFold());

describe("the assembly axis (x = 1 - t: apart on the left, together on the right)", () => {
  it("maps explode amounts and back, clamped", () => {
    expect(axisOf(1)).toBe(0);
    expect(axisOf(0)).toBe(1);
    expect(axisOf(0.25)).toBeCloseTo(0.75, 12);
    expect(tOfAxis(axisOf(0.4))).toBeCloseTo(0.4, 12);
    expect(axisOf(-2)).toBe(1);
    expect(tOfAxis(5)).toBe(0);
  });

  it("lays the steps out in assembly order, numbered, contiguous from 0 to 1", () => {
    const m = timelineModel(resolved());
    expect(m.steps.length).toBeGreaterThanOrEqual(3);
    expect(m.steps.map((s) => s.n)).toEqual(m.steps.map((_, i) => i + 1));
    expect(m.steps[0].x0).toBeCloseTo(0, 9);
    expect(m.steps[m.steps.length - 1].x1).toBeCloseTo(1, 9);
    for (let i = 1; i < m.steps.length; i++) expect(m.steps[i].x0).toBeCloseTo(m.steps[i - 1].x1, 9);
    // the first step assembled is the lid's (it goes on first), the mast's come after
    expect(m.steps[0].id).toMatch(/lid_mount/);
    expect(m.durationS).toBeGreaterThan(0);
  });

  it("finds the current step, its neighbours and each chip's state", () => {
    const { steps } = timelineModel(resolved());
    const mid = (steps[1].x0 + steps[1].x1) / 2;
    expect(stepIndexAt(steps, mid)).toBe(1);
    // a held goto names its step even at a boundary two chips share
    expect(stepIndexAt(steps, steps[2].x0, steps[2].id)).toBe(2);
    expect(chipState(0, 1, mid, steps[0])).toBe("done");
    expect(chipState(1, 1, mid, steps[1])).toBe("current");
    expect(chipState(2, 1, mid, steps[2])).toBe("todo");
    expect(neighbourStep(steps, 1, 1)?.id).toBe(steps[2].id);
    expect(neighbourStep(steps, 0, -1)).toBeUndefined();
    expect(neighbourStep(steps, steps.length, -1)?.id).toBe(steps[steps.length - 1].id);
    expect(neighbourStep(steps, -1, 1)?.id).toBe(steps[0].id);
  });
});

describe("joint rows (keyframes held at the stops, the moving segment, the label)", () => {
  it("keys the rest at the far left and the step's keyframe at the step's end, held at the 90 stop", () => {
    const m = timelineModel(resolved());
    const j = m.joints.find((x) => x.id === "gps_fold")!;
    expect(j.unit).toBe("°");
    expect(j.keys[0]).toEqual({ x: 0, value: 0 });
    const last = m.steps[m.steps.length - 1];
    expect(j.keys[1]).toMatchObject({ x: last.x1, value: 90, step: last.id, held: { joint: "gps_fold", asked: 135, held: 90, stop: "max" } });
    expect(j.segments).toEqual([{ step: last.id, x0: last.x0, x1: last.x1, from: 0, to: 90, ease: "cubic" }]);
    const inside = (last.x0 + last.x1) / 2;
    expect(activeSegment(j, inside)?.step).toBe(last.id);
    expect(activeSegment(j, last.x0 / 2)).toBeUndefined();
  });

  it("says the type, range, easing and clip as the concept does", () => {
    const j = timelineModel(resolved()).joints[0];
    const last = j.segments[0];
    expect(jointLabel(j, (last.x0 + last.x1) / 2, undefined)).toBe("revolute · 0° → 90° · ease in-out");
    expect(jointLabel(j, 0.1, 40, { joints: ["gps_fold"] })).toBe("revolute · 0° → 90° · ease in-out · now 40° · clip");
    // a joint no step keyframes: its stops and rest
    const bare = { ...j, segments: [], keys: [{ x: 0, value: 5 }], rest: 5, type: "slider" as const, unit: "mm", min: 0, max: 12 };
    expect(jointLabel(bare, 0.5, undefined)).toBe("slider · 0mm … 12mm · rest 5mm");
  });
});

const REPORT: InterferenceReportLike = {
  schema: "protoboard.interference/v0",
  keyframes: [
    { id: "assembled", label: "assembled", t: 0, hits: [{ a: "lid", b: "case", status: "contact", depthMm: 0, intended: "lid_mount" }] },
    {
      id: "step:fit:mast_mount",
      label: "just before Fit the mast",
      t: 0.245,
      hits: [
        { a: "arm_fl/prop", b: "video/camera_hood", status: "contact", depthMm: 0.05 },
        { a: "video/camera_hood", b: "arm_fl/prop", status: "contact", depthMm: 0.05 },
        { a: "mast", b: "battery", status: "interference", depthMm: 1.234 },
      ],
    },
  ],
};

describe("contacts from the interference sweep", () => {
  it("keeps the hits no mate intends, once per pair and keyframe, in assembly order", () => {
    const c = contactsFromReport(REPORT);
    expect(c.map((x) => [x.a, x.b, x.status])).toEqual([
      ["arm_fl/prop", "video/camera_hood", "contact"],
      ["mast", "battery", "interference"],
    ]);
    expect(c[1]).toMatchObject({ id: "battery|mast", t: 0.245, tEnd: 0.245, keyframe: "step:fit:mast_mount", from: "sweep", depthMm: 1.234, keyframes: 1 });
    // a pair seen at several keyframes is one contact, from where it first happens (in assembly order) to where it is last seen
    const long = contactsFromReport({ keyframes: [0.9, 0.5, 0.2].map((t, i) => ({ id: `k${i}`, t, hits: [{ a: "nut", b: "video", status: i === 1 ? "interference" : "contact", depthMm: i }] })) });
    expect(long).toEqual([{ id: "nut|video", t: 0.9, tEnd: 0.2, a: "nut", b: "video", status: "interference", depthMm: 2, keyframe: "k0", from: "sweep", keyframes: 3 }]);
    expect(contactsFromReport(undefined)).toEqual([]);
    expect(contactsFromReport({ keyframes: "x" } as never)).toEqual([]);
  });

  it("takes a report or the contacts themselves; nothing means no sweep was run", () => {
    expect(contactsOf(undefined)).toBeUndefined();
    expect(contactsOf(null)).toBeUndefined();
    expect(contactsOf(REPORT)?.length).toBe(2);
    expect(contactsOf([{ id: "x", t: 0.5, a: "p2", b: "hood", status: "contact" }, { bad: true } as never])?.length).toBe(1);
  });

  it("words a marker as the concept does: who touches what, when, from where", () => {
    const [touch, hit] = contactsFromReport(REPORT);
    expect(contactText(touch, 10)).toBe("prop touches camera hood · t 7.55 · from sweep");
    expect(contactText(hit, 10)).toBe("mast overlaps battery 1.2 mm · t 7.55 · from sweep");
  });
});

describe("the header and the chip", () => {
  it("names the step in progress (STEP 6 / 9 · …) with its id, parts, time and speed", () => {
    const m = timelineModel(resolved());
    const s = m.steps[1];
    const h = headerText(m, { mode: "sequence", t: tOfAxis((s.x0 + s.x1) / 2), speed: 1, playing: true });
    expect(h.title).toBe(`Step 2 / ${m.steps.length} · ${s.title}`);
    expect(h.sub).toMatch(new RegExp(`^${s.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} · \\d+ parts? · t = \\d+\\.\\d\\d · 1\\.0x$`));
    expect(headerText(m, { mode: "sequence", t: 0, speed: 1, playing: false }).title).toBe(`Assembled · ${m.steps.length} steps`);
    expect(headerText(m, { mode: "radial", t: 0.5, speed: 1, playing: false, radial: { parts: 26, distanceMm: 264.2, ms: 3, from: {} } })).toEqual({ title: "Explode · all parts at once", sub: "radial · 26 parts · 132.1 mm out · amount 0.50" });
    expect(headerText(undefined, { mode: "sequence", t: 0.5, speed: 1, playing: false }).title).toBe("No assembly steps");
  });

  it("shows a replay clip's size (joints × samples × 4 bytes), else what plays", () => {
    const snap = new SequencePlayer(resolved()).snapshot();
    expect(chipText({ ...snap, clip: { joints: Array.from({ length: 12 }, (_, i) => `j${i}`), samples: 120, durationS: 4 } }, true)).toBe("replay loop · 12 joints × 120 samples · 5.6 KB");
    expect(chipText(snap, false)).toMatch(/^\d+ steps · 1 joint · built sequence$/);
    expect(chipText({ ...snap, explodeMode: "radial", radial: { parts: 26, distanceMm: 264.24, ms: 1, from: {} } }, false)).toBe("radial · 26 parts · 264.2 mm");
  });
});

describe("when it shows, the keyboard, the remembered collapse", () => {
  it("shows while asked, apart, or moving (DEFAULT), else not", () => {
    expect(timelineWanted({ storeT: 0 })).toBe(false);
    expect(timelineWanted({ storeT: 0, requested: true })).toBe(true);
    expect(timelineWanted({ storeT: 1 })).toBe(true);
    expect(timelineWanted({ storeT: 0, playerT: 0.3 })).toBe(true);
    expect(timelineWanted({ storeT: 0, playerT: 0, playing: true })).toBe(true);
  });

  it("Space plays or pauses, Left/Right step; a slider keeps its arrows and a button its Space", () => {
    expect(keyAction(" ", { tagName: "SECTION" })).toBe("toggle");
    expect(keyAction("ArrowLeft", { tagName: "SECTION" })).toBe("prev");
    expect(keyAction("ArrowRight", { tagName: "BUTTON" })).toBe("next");
    expect(keyAction("ArrowRight", { tagName: "INPUT", type: "range" })).toBeNull();
    expect(keyAction(" ", { tagName: "INPUT", type: "range" })).toBe("toggle");
    expect(keyAction(" ", { tagName: "BUTTON" })).toBeNull();
    expect(keyAction(" ", { tagName: "INPUT", type: "text" })).toBeNull();
    expect(keyAction("a", null)).toBeNull();
  });

  it("remembers collapsed per viewer, and survives a storage that throws", () => {
    const mem = new Map<string, string>();
    const s = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    expect(loadCollapsed(s)).toBe(false);
    saveCollapsed(true, s);
    expect(mem.get(COLLAPSED_KEY)).toBe("1");
    expect(loadCollapsed(s)).toBe(true);
    const bad = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(loadCollapsed(bad)).toBe(false);
    expect(() => saveCollapsed(true, bad)).not.toThrow();
    expect(loadCollapsed(null)).toBe(false);
  });
});

describe("the panel as rendered", () => {
  afterEach(() => vi.unstubAllGlobals());
  const mount = (over: { t?: number; requested?: boolean; contacts?: InterferenceReportLike } = {}) => {
    const player = new SequencePlayer(resolved());
    player.setMode("sequence", { instant: true });
    player.set({ t: over.t ?? 0.5 });
    const store = createViewStore();
    if (over.t) store.dispatch([{ op: "explode", t: over.t }]);
    const run = vi.fn(() => ({ ok: true }));
    const html = renderToStaticMarkup(createElement(TimelinePanel, { store, source: { player: () => player, run }, requested: over.requested ?? true, ...(over.contacts ? { contacts: over.contacts } : {}) }));
    return { html, player };
  };

  it("draws the header, the three tracks and the playhead across them", () => {
    const { html, player } = mount({ t: 0.5 });
    expect(html).toContain('class="cad-timeline"');
    expect(html).toContain('aria-label="Assembly timeline"');
    expect(html).toMatch(/data-timeline="title"[^>]*>Step \d+ \/ \d+ · /);
    expect(html).toContain('aria-label="Explode amount"');
    expect(html).toContain('data-track="steps"');
    expect(html).toContain('data-joint="gps_fold"');
    expect(html).toContain("revolute · 0° → 90° · ease in-out");
    expect(html).toContain('data-held="true"');
    expect(html).toContain("no sweep run");
    // the playhead at x = 1 - t
    expect(html).toContain(`data-timeline="playhead" style="left:${(axisOf(player.t) * 100).toFixed(3)}%"`);
    // one current chip, earlier ones done
    expect(html.match(/data-state="current"/g)?.length).toBe(1);
    expect(html).toMatch(/data-state="done"/);
    expect(html).toMatch(/data-state="todo"/);
  });

  it("draws a sweep's contacts in red with their words", () => {
    const { html } = mount({ t: 0.5, contacts: REPORT });
    expect(html).toContain('data-contact="interference"');
    expect(html).toContain('data-contact="contact"');
    expect(html).toMatch(/aria-label="mast overlaps battery 1\.2 mm · t \d+\.\d\d · from sweep"/);
    expect(html).not.toContain("no sweep run");
  });

  it("renders nothing while neither asked nor apart, and one line when collapsed", () => {
    expect(mount({ t: 0, requested: false }).html).toBe("");
    vi.stubGlobal("localStorage", { getItem: (k: string) => (k === COLLAPSED_KEY ? "1" : null), setItem: () => {} });
    const { html } = mount({ t: 0.5 });
    expect(html).toContain("data-collapsed");
    expect(html).not.toContain('data-track="steps"');
    expect(html).not.toContain('aria-label="Explode amount"');
    expect(html).toMatch(/data-timeline="title"/);
  });
});

/** OKLCH to sRGB hex (CSS Color 4's matrices), for the themes' oklch tokens. */
function oklchHex(css: string): string {
  const m = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/.exec(css);
  if (!m) return css;
  const [L, C, h] = [Number(m[1]), Number(m[2]), (Number(m[3]) * Math.PI) / 180];
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s];
  const enc = (v: number) => Math.round(255 * Math.min(1, Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)));
  return `#${lin.map((v) => enc(v).toString(16).padStart(2, "0")).join("")}`;
}
/** `top` at `alpha` over `under` (sRGB), as `color-mix(… x%, transparent)` composites. */
const over = (top: string, alpha: number, under: string) => {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [t, u] = [p(top), p(under)];
  return `#${t.map((v, i) => Math.round(v * alpha + u[i] * (1 - alpha)).toString(16).padStart(2, "0")).join("")}`;
};

describe("contrast of what the panel draws (dark and paper)", () => {
  for (const theme of [defaultDark, defaultLight]) {
    const k = theme.tokens;
    const surface = oklchHex(k.surface);
    it(`${theme.id}: labels, contacts and the playhead hold their thresholds on the panel`, () => {
      expect(oklchHex("oklch(1 0 0)")).toBe("#ffffff");
      for (const text of [k.text, k.textMuted]) expect(contrastRatio(oklchHex(text), surface)).toBeGreaterThanOrEqual(CONTRAST_TEXT);
      // the contact markers and their words are the DRC red
      expect(contrastRatio(k.drcError, surface)).toBeGreaterThanOrEqual(CONTRAST_TEXT);
      // the playhead and the moving segment (graphics); the current chip's words (text colour: the accent itself is under
      // 4.5:1 on its own 15 % wash in both themes, 4.41 dark and 3.92 paper, so only its outline is accent) on the wash
      const accent = oklchHex(k.accent);
      expect(contrastRatio(accent, surface)).toBeGreaterThanOrEqual(CONTRAST_GRAPHIC);
      expect(contrastRatio(oklchHex(k.text), over(accent, 0.15, surface))).toBeGreaterThanOrEqual(CONTRAST_TEXT);
      // a done chip's words on the muted fill; a held keyframe's amber ring
      expect(contrastRatio(oklchHex(k.text), oklchHex(k.muted))).toBeGreaterThanOrEqual(CONTRAST_TEXT);
      expect(contrastRatio(k.drcWarning, surface)).toBeGreaterThanOrEqual(CONTRAST_GRAPHIC);
      // the play button: the surface colour on a text-coloured disc
      expect(contrastRatio(surface, oklchHex(k.text))).toBeGreaterThanOrEqual(CONTRAST_GRAPHIC);
    });
  }

  it("the sheet names theme tokens only (no raw colours)", () => {
    expect(TIMELINE_CSS).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|oklch\(|hsl\(/i);
    for (const v of TIMELINE_CSS.match(/var\(--[a-z-]+/g) ?? []) expect(v).toMatch(/^var\(--(uhd-|tl-)/);
  });
});
