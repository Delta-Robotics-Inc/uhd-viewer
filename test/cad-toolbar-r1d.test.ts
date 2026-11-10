/**
 * R1-D (2026-11-01, Kevin's walkthrough): the 3D toolbar's dead controls (G4), the section view control (G5), the
 * toon band ramp (C2), Model info on by default (G1) and the standard-view glyphs (E2).
 */
import * as THREE from "three";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CadToolbar, directionOption, framesLabel, toolbarAvailability, type CadToolbarProps } from "../src/cad/CadToolbar";
import { DIRECTIONS, type CadModel } from "../src/cad/model";
import { TOON_EDGES, TOON_SOFT, patchToon, toonBand, toonUniforms } from "../src/cad/render/toon";
import { ViewGlyph } from "../src/cad/viewIcons";
import { MODEL_INFO_KEY, initialModelInfo } from "../src/cad/ModelView";

const props = (over: Partial<CadToolbarProps> = {}): CadToolbarProps =>
  ({
    exploded: false, onExploded: () => {}, labels: false, onLabels: () => {}, labelKinds: new Set(["module"]), onLabelKind: () => {}, labelMenu: false, onLabelMenu: () => {},
    hardwareCount: 0, hardware: false, onHardware: () => {}, harnessCount: 0, wires: false, onWires: () => {}, frames: false, onFrames: () => {},
    section: null, onSection: () => {}, sectionMenu: false, onSectionMenu: () => {}, autoFlip: () => true, shells: 0, xray: false, onXray: () => {},
    findings: 0, showFindings: false, onFindings: () => {}, direction: "feature", onDirection: () => {}, onFit: () => {}, onFocus: () => {}, canFocus: false,
    sections: [], onSections: () => {},
    ...over,
  }) as CadToolbarProps;
const html = (over: Partial<CadToolbarProps> = {}) => renderToStaticMarkup(createElement(CadToolbar, props(over)));
/** The opening tag of the button whose tooltip starts with `label`. */
const button = (markup: string, label: string) => markup.match(new RegExp(`<button[^>]*data-tooltip="${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^"]*"[^>]*>`))?.[0];

// a body with one framed interface bound by a feature (D1) and one bound by its own artifact (D2)
const frame = { origin: [0, 0, 0], normal: [0, 0, 1], xAxis: [1, 0, 0] };
const def = (id: string, interfaces: unknown[]) => ({ id, name: id, kind: "module", interfaces, artifacts: [{ id: "cad_step", kind: "cad", format: "step", filePath: "out/body.step" }, { id: "cad_if_a", kind: "cad", format: "glb", filePath: "out/if-a.glb" }] });
const model = (bodies: { key: string; def: ReturnType<typeof def> }[]) =>
  ({ bodies: bodies.map((b) => ({ key: b.key, path: b.key.split("#")[0].split("/"), def: b.def, matrix: [] })), manifests: new Map() }) as unknown as Pick<CadModel, "bodies" | "manifests">;

describe("toolbar availability (G4: a control with nothing to show says so)", () => {
  it("counts interface frames on drawn bodies and the geometry each direction has", () => {
    const a = toolbarAvailability(
      model([
        { key: "plate", def: def("plate", [{ id: "a", geometry: { frame, refs: [{ kind: "feature", artifact: "cad_step", name: "a" }, { kind: "artifact", artifact: "cad_if_a" }] } }, { id: "b" }]) },
      ]),
    );
    expect(a.frames).toBe(1);
    expect(a.byDirection.feature).toBe(1);
    expect(a.byDirection.artifact).toBe(1);
    expect(a.byDirection.procedural).toBe(0);
  });

  it("a model with no frames and no bound geometry (the ClientX cube shell's STL panels) disables both", () => {
    const a = toolbarAvailability(model([{ key: "shell/grill_1", def: def("grill", [{ id: "edge" }]) }, { key: "shell/foot_1", def: def("foot", []) }]));
    expect(a).toEqual({ frames: 0, byDirection: { feature: 0, artifact: 0, procedural: 0 } });
    expect(framesLabel(a)).toBe("No interface frames in this model");
    for (const d of DIRECTIONS) expect(directionOption(d, a)).toEqual({ label: expect.stringMatching(/none in this model$/), disabled: true });
  });

  it("unknown availability keeps every control enabled (a host that does not pass it)", () => {
    expect(framesLabel(undefined)).toBe("Every interface frame");
    expect(directionOption(DIRECTIONS[0], undefined).disabled).toBe(false);
  });

  it("renders the frame toggle and the radios disabled with their reason, the others enabled", () => {
    const none = html({ availability: { frames: 0, byDirection: { feature: 2, artifact: 0, procedural: 0 } }, frames: true });
    const f = button(none, "No interface frames in this model")!;
    expect(f).toContain('aria-disabled="true"');
    expect(f).toContain('aria-pressed="false"'); // on in the view state, but nothing to draw: not shown as on
    expect(button(none, "Interface geometry by D2 artifact: none in this model")).toContain('aria-disabled="true"');
    const d1 = button(none, "Interface geometry by D1 feature")!;
    expect(d1).not.toContain("aria-disabled");
    expect(d1).toContain('role="radio"');
    expect(d1).toContain('aria-checked="true"');
    const some = html({ availability: { frames: 4, byDirection: { feature: 1, artifact: 1, procedural: 1 } } });
    expect(button(some, "Every interface frame · 4")).not.toContain("aria-disabled");
  });
});

describe("the toolbar's menus (G4 label types, G5 section plane)", () => {
  it("the label types menu lists the kinds and a findings row tied to the marker layer", () => {
    const m = html({ labelMenu: true, findings: 16, showFindings: true });
    expect(m).toContain('role="menu"');
    expect(m).toContain("Modules");
    expect(m).toContain("Interfaces (mates)");
    expect(m).toMatch(/role="menuitemcheckbox" aria-checked="true"[^>]*>.*Findings · 16/);
    const none = html({ labelMenu: true, findings: 0 });
    expect(none).toContain("Findings (none)");
    expect(none).toContain('data-tooltip="No findings in this model"');
  });

  it("the chevrons say they open a menu; the scissors is the section view's on/off", () => {
    const m = html();
    expect(button(m, "Label types")).toContain('aria-haspopup="menu"');
    expect(button(m, "Section view: plane, offset, side, scope")).toContain('aria-haspopup="dialog"');
    expect(button(m, "Section view")).toContain('aria-pressed="false"');
    expect(button(html({ sections: [{ axis: 1, at: 0.5 }] }), "Section view: on")).toContain('aria-pressed="true"');
  });

  it("the section popover has the axis choice, the slider, keep the other side and the scope", () => {
    const m = html({ sectionMenu: true, sections: [{ axis: 1, at: 0.5 }], scopeCandidate: { path: "shell/grill_1", label: "grill_1" } });
    expect(m).toContain('role="dialog"');
    expect(m).toContain('data-tooltip="YZ plane (cut across X)"');
    expect(m).toContain('type="range"');
    expect(m).toContain('data-tooltip="Keep the other side"');
    expect(m).toContain("Only grill_1");
  });
});

describe("toon band ramp (C2)", () => {
  const bands = [0.35, 0.56, 1] as const;

  it("the shader takes the band from a view-space key with a smoothstep at each edge", () => {
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader } as unknown as THREE.WebGLProgramParametersWithUniforms;
    const u = toonUniforms();
    patchToon(shader, u);
    expect(u.uToonSoft.value).toBe(TOON_SOFT);
    expect(TOON_SOFT).toBe(0.06);
    expect(shader.fragmentShader).toContain("uniform float uToonSoft;");
    expect(shader.fragmentShader.match(/smoothstep\( uToonEdges\.[xy] - hw, uToonEdges\.[xy] \+ hw, k \)/g)).toHaveLength(2);
    expect(shader.fragmentShader).toContain("dot( normalize( normal ), uToonKey )");
    // GLSL source stays ASCII (some drivers refuse other characters even in comments)
    const patch = shader.fragmentShader.slice(shader.fragmentShader.indexOf("#ifdef UHD_TOON"));
    expect(/[^\x00-\x7f]/.test(patch)).toBe(false);
    expect((shader.uniforms as Record<string, unknown>).uToonSoft).toBe(u.uToonSoft);
  });

  it("is the hard bands away from the edges and a continuous ramp across them", () => {
    const [e0, e1] = [TOON_EDGES.x, TOON_EDGES.y];
    expect(toonBand(-0.5, bands)).toBeCloseTo(0.35, 6);
    expect(toonBand(0.2, bands)).toBeCloseTo(0.56, 6);
    expect(toonBand(0.9, bands)).toBeCloseTo(1, 6);
    expect(toonBand(e0, bands)).toBeCloseTo((0.35 + 0.56) / 2, 6);
    expect(toonBand(e1, bands)).toBeCloseTo((0.56 + 1) / 2, 6);
    expect(toonBand(e0 - TOON_SOFT / 2, bands)).toBeCloseTo(0.35, 6);
    expect(toonBand(e1 + TOON_SOFT / 2, bands)).toBeCloseTo(1, 6);
    // the largest step between two orientations 1 degree apart, sweeping a face through both edges
    let maxStep = 0;
    let maxHard = 0;
    for (let deg = 0; deg < 180; deg++) {
      const k0 = Math.cos((deg * Math.PI) / 180);
      const k1 = Math.cos(((deg + 1) * Math.PI) / 180);
      maxStep = Math.max(maxStep, Math.abs(toonBand(k1, bands) - toonBand(k0, bands)));
      maxHard = Math.max(maxHard, Math.abs(toonBand(k1, bands, undefined, 0) - toonBand(k0, bands, undefined, 0)));
    }
    expect(maxHard).toBeCloseTo(0.44, 2); // a whole band jump in one degree (the snap Kevin saw)
    expect(maxStep).toBeLessThan(0.2); // spread over about four degrees
  });
});

describe("Model info on by default (G1) and the view glyphs (E2)", () => {
  const store = (v: string | null) => ({ getItem: (k: string) => (k === MODEL_INFO_KEY ? v : null) });

  it("is on unless the person turned it off", () => {
    expect(initialModelInfo(true, store(null))).toBe(true);
    expect(initialModelInfo(true, store("0"))).toBe(false);
    expect(initialModelInfo(false, store("1"))).toBe(true);
    expect(initialModelInfo(true, { getItem: () => { throw new Error("denied"); } })).toBe(true);
    expect(initialModelInfo(true, undefined)).toBe(true);
  });

  it("each view glyph is the same cube with the face it looks at filled; isometric fills three", () => {
    const g = (face: "iso" | "top" | "front" | "right") => renderToStaticMarkup(createElement(ViewGlyph, { face }));
    expect(g("iso").match(/fill-opacity/g)).toHaveLength(3);
    for (const f of ["top", "front", "right"] as const) expect(g(f).match(/fill-opacity/g)).toHaveLength(1);
    expect(g("top")).toContain('d="M12 3 20 7.5 12 12 4 7.5Z" fill="currentColor" fill-opacity="0.75"');
    expect(g("iso")).toContain('stroke-width="1.75"');
    expect(g("iso")).toContain('xmlns="http://www.w3.org/2000/svg"');
  });
});
