/**
 * R4-C (2026-11-02; Kevin: "The color of the cross-section hatch system should match the color of the actual 3D
 * model"): each cut part's cap in its own colour. The fill is the part's surface colour pulled 12 % toward the
 * background in lightness, the hatch lines a darker tone of the same hue (45 % in the dark theme, 35 % on paper) at
 * 3:1 or more against the fill, a lighter one where a darker one cannot reach it; the live caps' part pass reads each
 * draw's colour; the CPU caps of open meshes take their part's tones too.
 */
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  CAP_LINE_DARKEN_DARK,
  CAP_LINE_DARKEN_PAPER,
  CAP_MIN_CONTRAST,
  CAP_SHIFT_TO_GROUND,
  DARK_CAP_SCENE,
  PAPER_CAP_SCENE,
  SceneSections,
  SectionCaps,
  capTones,
  isDarkGround,
  lightness,
  surfaceColour,
  type CapScene,
} from "../src/cad/sections";
import { CAP_TONES_GLSL } from "../src/cad/sections/capColour";
import { HATCH_FRAGMENT, HATCH_PARS } from "../src/cad/sections/caps";
import { DARK_SCENE_TOKENS, PAPER_SCENE_TOKENS } from "../src/theme/themes";
import { NEUTRAL_FALLBACK } from "../src/cad/render/toon";

const rgb = (hex: string): [number, number, number] => {
  const c = new THREE.Color(hex).getRGB(new THREE.Color(), THREE.SRGBColorSpace);
  return [c.r, c.g, c.b];
};
const hue = (hex: string): number => {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl, THREE.SRGBColorSpace);
  return hsl.h * 360;
};
const chroma = (hex: string) => Math.max(...rgb(hex)) - Math.min(...rgb(hex));

/** The parts on screen in Kevin's two test models: ClientX's grey panels, orange filters, the board; the drone's. */
const PARTS: Record<string, string> = {
  panelGrey: "#9aa0a8",
  filterOrange: "#f28c28",
  boardGreen: "#1f3b2c",
  carbon: "#232326",
  nylon: "#1c1c1c",
  steel: "#c0c4cc",
  motor: "#9ca3af",
  prop: "#e7e5e4",
  battery: "#2d2f36",
  white: "#ffffff",
  black: "#000000",
  accent: "#339fee",
  red: "#e11d48",
  yellow: "#facc15",
};
const SCENES: [string, CapScene][] = [
  ["dark", DARK_CAP_SCENE],
  ["paper", PAPER_CAP_SCENE],
];

describe("cap tones from a part's colour", () => {
  it("the two default scenes are the themes' own scene tokens, told apart by the background", () => {
    expect(DARK_CAP_SCENE).toEqual({ background: DARK_SCENE_TOKENS.sceneBackground, neutral: DARK_SCENE_TOKENS.modelToneLit });
    expect(PAPER_CAP_SCENE).toEqual({ background: PAPER_SCENE_TOKENS.sceneBackground, neutral: PAPER_SCENE_TOKENS.modelToneLit });
    expect(isDarkGround(DARK_CAP_SCENE.background)).toBe(true);
    expect(isDarkGround(PAPER_CAP_SCENE.background)).toBe(false);
  });

  it("every part's fill and lines are at least 3:1 apart, in both themes (8-bit hex, as drawn)", () => {
    for (const [, scene] of SCENES)
      for (const [name, hex] of Object.entries(PARTS)) {
        const t = capTones(hex, scene);
        expect(t.contrast, `${name} on ${scene.background}`).toBeGreaterThanOrEqual(CAP_MIN_CONTRAST);
      }
  });

  it("the fill is the part's colour moved 12 % of the way toward the background in lightness, hue kept", () => {
    for (const [, scene] of SCENES) {
      const lg = lightness(rgb(scene.background));
      for (const [name, hex] of Object.entries(PARTS)) {
        const l = lightness(rgb(hex));
        const t = capTones(hex, scene);
        expect(lightness(rgb(t.fill)), name).toBeCloseTo(l + CAP_SHIFT_TO_GROUND * (lg - l), 2);
        if (chroma(hex) > 0.2 && chroma(t.fill) > 0.1) expect(Math.abs(hue(t.fill) - hue(hex)), name).toBeLessThan(4);
      }
    }
  });

  it("the lines are a darker tone of the same hue: 45 % darker in the dark theme, 35 % on paper, where that reads", () => {
    // a mid-light colour: the darker tone alone clears 3:1
    for (const [label, scene, k] of [
      ["dark", DARK_CAP_SCENE, CAP_LINE_DARKEN_DARK],
      ["paper", PAPER_CAP_SCENE, CAP_LINE_DARKEN_PAPER],
    ] as const) {
      const t = capTones(PARTS.filterOrange, scene);
      const lf = lightness(rgb(t.fill));
      const ll = lightness(rgb(t.line));
      expect(ll, label).toBeLessThan(lf);
      // at most the brief's darkening, further only when 3:1 needed it
      expect(ll, label).toBeLessThanOrEqual(lf * (1 - k) + 1 / 255);
      expect(Math.abs(hue(t.line) - hue(t.fill)), label).toBeLessThan(4);
    }
    expect(CAP_LINE_DARKEN_DARK).toBe(0.45);
    expect(CAP_LINE_DARKEN_PAPER).toBe(0.35);
  });

  it("a near-black part gets lighter lines (a darker tone cannot reach 3:1), still its hue", () => {
    for (const [, scene] of SCENES)
      for (const hex of [PARTS.boardGreen, PARTS.carbon, PARTS.nylon, PARTS.black]) {
        const t = capTones(hex, scene);
        expect(lightness(rgb(t.line))).toBeGreaterThan(lightness(rgb(t.fill)));
        expect(t.contrast).toBeGreaterThanOrEqual(CAP_MIN_CONTRAST);
      }
    // the board stays green: the lines are a green tone, not grey
    const g = capTones(PARTS.boardGreen, DARK_CAP_SCENE);
    expect(Math.abs(hue(g.line) - hue(PARTS.boardGreen))).toBeLessThan(6);
  });

  it("different parts give different caps (the cap tells parts apart as their surfaces do)", () => {
    for (const [, scene] of SCENES) {
      const fills = new Set(Object.values(PARTS).map((h) => capTones(h, scene).fill));
      expect(fills.size).toBe(Object.keys(PARTS).length);
    }
  });

  it("a part with no colour of its own (the neutral fallback grey) is read as the theme's lit tone, as its surface", () => {
    for (const [, scene] of SCENES) expect(capTones(NEUTRAL_FALLBACK, scene)).toEqual(capTones(scene.neutral, scene));
  });

  it("the GLSL twin has the same constants and is ASCII", () => {
    for (const s of [CAP_TONES_GLSL, HATCH_PARS, HATCH_FRAGMENT]) expect(/[^\x00-\x7f]/.test(s)).toBe(false);
    expect(CAP_TONES_GLSL).toContain(CAP_SHIFT_TO_GROUND.toFixed(4));
    expect(CAP_TONES_GLSL).toContain(CAP_MIN_CONTRAST.toFixed(4));
    expect(CAP_TONES_GLSL).toContain("void uhdCapTones(");
  });
});

describe("a part's surface colour", () => {
  const neutral = new THREE.Color(DARK_SCENE_TOKENS.modelToneLit);
  it("is the material's colour plus its glow; the selection's surface is the accent", () => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: "#f28c28" }));
    expect(`#${surfaceColour(m, neutral).getHexString()}`).toBe("#f28c28");
    // the selection: the accent surface with its own emissive (scene.ts focusMaterial: 0.6 of the colour)
    const focus = new THREE.MeshStandardMaterial({ color: 0x339fee, emissive: 0x339fee, emissiveIntensity: 0.6 });
    const sel = surfaceColour(new THREE.Mesh(new THREE.BoxGeometry(), focus), neutral);
    const accent = new THREE.Color(0x339fee);
    expect(sel.b).toBeCloseTo(Math.min(1, accent.b * 1.6), 5);
    expect(sel.r).toBeGreaterThan(accent.r);
    // a highlight: `userData.emissive` on the part's own colour
    m.userData.emissive = 0x112233;
    const hl = surfaceColour(m, neutral);
    expect(hl.r).toBeGreaterThan(new THREE.Color("#f28c28").r);
  });
  it("the neutral fallback grey reads as the theme's lit tone", () => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: NEUTRAL_FALLBACK }));
    expect(surfaceColour(m, neutral).getHexString()).toBe(neutral.getHexString());
  });
});

describe("the live caps' part pass", () => {
  it("is a back-face pass on the parity bit that marks bit 1, depth-tested and written, clipped, with a mesh's missing attributes defaulted", () => {
    const caps = new SectionCaps();
    const m = caps.part;
    expect(m.side).toBe(THREE.BackSide);
    expect(m.clipping).toBe(true);
    expect(m.vertexColors).toBe(true);
    expect([m.depthTest, m.depthWrite, m.depthFunc]).toEqual([true, true, THREE.LessEqualDepth]);
    expect([m.stencilFunc, m.stencilRef, m.stencilFuncMask, m.stencilWriteMask, m.stencilZPass]).toEqual([THREE.EqualStencilFunc, 3, 1, 2, THREE.ReplaceStencilOp]);
    expect((m as unknown as { defaultAttributeValues: Record<string, number[]> }).defaultAttributeValues.instanceEmissive).toEqual([0, 0, 0]);
    // the theme fill: only where the part pass did not paint (bit 0 set, bit 1 clear)
    expect([caps.fill.stencilFuncMask, caps.fill.stencilWriteMask]).toEqual([3, 3]);
    expect(/[^\x00-\x7f]/.test(m.fragmentShader + m.vertexShader)).toBe(false);
    expect(m.fragmentShader).toContain("uhdCapTones(");
    expect(m.fragmentShader).toContain("uhdHatchLine(");
    caps.dispose();
  });

  it("reads each draw's colour: a plain mesh's material, the batcher's instances by attribute; skips lines and x-ray", () => {
    const caps = new SectionCaps();
    const m = caps.part;
    const u = m.uniforms;
    const r = {} as THREE.WebGLRenderer;
    const sc = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera();
    const call = (o: THREE.Object3D) => m.onBeforeRender(r, sc, cam, (o as THREE.Mesh).geometry, o, null as unknown as THREE.Group);
    const plain = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: "#f28c28", emissive: 0x000000 }));
    call(plain);
    expect(`#${(u.uCapColor.value as THREE.Color).getHexString()}`).toBe("#f28c28");
    expect(u.uCapSkip.value).toBe(0);
    expect(m.uniformsNeedUpdate).toBe(true);
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial(), 2);
    inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(6), 3);
    call(inst);
    expect((u.uCapColor.value as THREE.Color).getHex()).toBe(0xffffff);
    expect((u.uCapEmissive.value as THREE.Color).getHex()).toBe(0);
    const merged = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true }));
    call(merged);
    expect(u.uCapVertexColor.value).toBe(1);
    call(new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial()));
    expect(u.uCapSkip.value).toBe(1);
    const xray = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.22 }));
    call(xray);
    expect(u.uCapSkip.value).toBe(1);
    caps.dispose();
  });

  it("derives against the scene's tones: handed over, or told from the ink until then", () => {
    const caps = new SectionCaps();
    caps.setInk(PAPER_SCENE_TOKENS.sectionLine);
    expect(caps.sceneTones()).toEqual(PAPER_CAP_SCENE);
    expect(caps.part.uniforms.uCapDarken.value).toBe(CAP_LINE_DARKEN_PAPER);
    caps.setInk(DARK_SCENE_TOKENS.sectionLine);
    expect(caps.sceneTones()).toEqual(DARK_CAP_SCENE);
    expect(caps.part.uniforms.uCapDarken.value).toBe(CAP_LINE_DARKEN_DARK);
    caps.setSceneTones({ background: "#fbfbfa", neutral: "#f4f4f1" });
    caps.setInk("#d4d4d4");
    expect(caps.sceneTones().background).toBe("#fbfbfa");
    expect(caps.part.uniforms.uCapGroundL.value).toBeCloseTo(lightness(rgb("#fbfbfa")), 6);
    expect(caps.partColours).toBe(true);
    caps.dispose();
  });
});

describe("the CPU caps of open meshes take their part's tones", () => {
  it("each open part's cap is its own mesh in its own tones, with its plane's hatch direction", () => {
    // an open box (its top left out) in orange, cut across z: the cut closes, so it gets a CPU cap
    const g0 = new THREE.BoxGeometry(10, 10, 10).toNonIndexed();
    const pos = g0.getAttribute("position");
    const keep: number[] = [];
    for (let t = 0; t < pos.count / 3; t++) {
      let top = true;
      for (let k = 0; k < 3; k++) if ((pos.array as Float32Array)[t * 9 + k * 3 + 1] < 4.99) top = false;
      if (!top) for (let k = 0; k < 9; k++) keep.push((pos.array as Float32Array)[t * 9 + k]);
    }
    const open = new THREE.Mesh(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(keep, 3)), new THREE.MeshStandardMaterial({ color: "#f28c28" }));
    const body = new THREE.Group();
    body.userData.key = "filter";
    body.add(open);
    const root = new THREE.Group();
    root.add(body);
    root.updateMatrixWorld(true);
    const s = new SceneSections({ roots: () => [root], globalPlanes: () => [], invalidate: () => {}, eye: () => new THREE.Vector3(0, 100, 0) });
    s.setLineColor(DARK_SCENE_TOKENS.sectionLine);
    s.set({ planes: [new THREE.Plane(new THREE.Vector3(0, -1, 0), 0)] });
    s.compute();
    expect(s.report()?.open?.[0]).toMatchObject({ instancePath: "filter", cap: "cpu" });
    const cap = s.outline.children.find((c) => c.userData.capOf === "filter") as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial & { userData: { hatch: { uHatchInk: { value: THREE.Color } } } }>;
    expect(cap).toBeDefined();
    cap.material.onBeforeRender({} as THREE.WebGLRenderer, new THREE.Scene(), new THREE.PerspectiveCamera(), cap.geometry, cap, null as unknown as THREE.Group);
    const want = capTones("#f28c28", DARK_CAP_SCENE);
    expect(`#${cap.material.color.getHexString()}`).toBe(want.fill);
    expect(`#${cap.material.userData.hatch.uHatchInk.value.getHexString()}`).toBe(want.line);
    // the selection: the cap follows the part's surface on the next frame
    open.material = new THREE.MeshStandardMaterial({ color: 0x339fee, emissive: 0x339fee, emissiveIntensity: 0.6 });
    cap.material.onBeforeRender({} as THREE.WebGLRenderer, new THREE.Scene(), new THREE.PerspectiveCamera(), cap.geometry, cap, null as unknown as THREE.Group);
    expect(`#${cap.material.color.getHexString()}`).not.toBe(want.fill);
    // part colours off: the theme's cap tone
    s.partColours = false;
    cap.material.onBeforeRender({} as THREE.WebGLRenderer, new THREE.Scene(), new THREE.PerspectiveCamera(), cap.geometry, cap, null as unknown as THREE.Group);
    expect(`#${cap.material.color.getHexString()}`).toBe("#4a4640");
    s.dispose();
  });
});
