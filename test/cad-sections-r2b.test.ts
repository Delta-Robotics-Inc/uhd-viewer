/**
 * R2-B (2026-11-02, Kevin's walkthrough G5): the section view's plane chooser (origin planes of the model's frame,
 * a picked face's plane), the offset and the drag handle's line, hatched caps (paper and dark, contrast-checked),
 * the CPU caps of open meshes, and the Explode and Assemble controls in the toolbar.
 */
import * as THREE from "three";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ASSEMBLE_LABEL, CadToolbar, EXPLODE_LABEL, planeName, type CadToolbarProps } from "../src/cad/CadToolbar";
import {
  COPLANAR_KEEP_MM,
  HATCH_DEG,
  HATCH_MM,
  SceneSections,
  SectionCaps,
  capTriangles,
  contrast,
  facePlane,
  hatchAcross,
  inkFor,
  isPlaced,
  meshIsClosed,
  offsetOf,
  offsetRange,
  originPlane,
  planeFrame,
  planeMeta,
  resolvePlane,
  withOffset,
} from "../src/cad/sections";
import { HATCH_FRAGMENT, patchHatch, hatchUniforms } from "../src/cad/sections/caps";
import { faceOfPick, gatherFace, mmPerPixel, rayLineParam, segmentDistancePx } from "../src/cad/sections/gizmo";
import { FEATURE_ID_ATTRIBUTE } from "../src/cad/render/ids";
import { DARK_SCENE_TOKENS, PAPER_SCENE_TOKENS } from "../src/theme/themes";

const box = (min: [number, number, number], max: [number, number, number]) => new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max));

describe("origin planes and placed planes", () => {
  it("an origin plane passes through the origin when it is well inside, else the bounds' middle on that axis", () => {
    const centred = box([-100, -100, -100], [100, 100, 100]);
    expect(originPlane(2, centred)).toMatchObject({ source: "origin", normal: [0, 0, 1], point: [0, 0, 0], offset: 0, axis: 2, at: 0.5 });
    // ClientX's shell stands on its origin: the XY plane would cut its very bottom
    const standing = box([-120, -120, 0], [120, 120, 250]);
    const xy = originPlane(2, standing);
    expect(xy.point).toEqual([0, 0, 125]);
    expect(xy.at).toBeCloseTo(0.5, 6);
    expect(originPlane(0, standing).point).toEqual([0, 0, 0]);
  });

  it("resolves to a three plane at the offset, keeping the side away from the camera or the side asked", () => {
    const b = box([-50, -50, 0], [50, 50, 100]);
    const s = withOffset(originPlane(2, b), 10, b);
    expect(s.offset).toBe(10);
    expect(s.at).toBeCloseTo(0.6, 6);
    const cam = { position: new THREE.Vector3(0, 0, 500), target: new THREE.Vector3(0, 0, 50) };
    const r = resolvePlane(s, b, cam)!;
    // camera above: the lower part is kept
    expect(r.plane.distanceToPoint(new THREE.Vector3(0, 0, 59))).toBeGreaterThan(0);
    expect(r.plane.distanceToPoint(new THREE.Vector3(0, 0, 61))).toBeLessThan(0);
    expect(planeMeta.get(r.plane)).toEqual({ source: "origin", offset: 10 });
    const up = resolvePlane({ ...s, flip: true }, b, cam)!;
    expect(up.plane.distanceToPoint(new THREE.Vector3(0, 0, 61))).toBeGreaterThan(0);
  });

  it("a legacy axis plane resolves as before and converts to the origin form on an offset", () => {
    const b = box([0, 0, 0], [200, 100, 50]);
    const legacy = { axis: 1 as const, at: 0.25 };
    const r = resolvePlane(legacy, b, { position: new THREE.Vector3(0, -500, 0), target: new THREE.Vector3(0, 50, 0) })!;
    expect(r.at).toBe(25);
    expect(planeMeta.get(r.plane)?.source).toBe("axis");
    expect(isPlaced(legacy)).toBe(false);
    // its offset from the origin plane on its axis (the middle, 50: the origin is on the bounds' edge)
    expect(offsetOf(legacy, b)).toBe(-25);
    const moved = withOffset(legacy, -20, b);
    expect(moved).toMatchObject({ source: "origin", offset: -20, axis: 1 });
    expect(moved.at).toBeCloseTo(0.3, 6);
    expect(offsetRange(moved, b)).toEqual([-50, 50]);
  });

  it("a picked face's plane keeps the material behind it, a hair past the face (so the face itself stays whole)", () => {
    const b = box([-50, -50, -50], [50, 50, 50]);
    const n = new THREE.Vector3(1, 1, 0).normalize();
    const s = facePlane(n, new THREE.Vector3(30, 30, 0), b, { path: "shell/tri_1", face: 4, body: "shell/tri_1", planar: true });
    expect(s).toMatchObject({ source: "face", flip: false, offset: 0, face: { path: "shell/tri_1", face: 4 } });
    const r = resolvePlane(s, b)!;
    const onFace = new THREE.Vector3(30, 30, 0);
    expect(r.plane.distanceToPoint(onFace)).toBeCloseTo(COPLANAR_KEEP_MM, 6);
    expect(r.plane.distanceToPoint(onFace.clone().addScaledVector(n, -5))).toBeGreaterThan(0);
    expect(r.plane.distanceToPoint(onFace.clone().addScaledVector(n, 5))).toBeLessThan(0);
    expect(planeName(s)).toBe("Face of tri_1");
    expect(planeName({ ...s, face: { path: "a/b", planar: false } })).toContain("curved");
    // dragged 8 mm into the part
    const r2 = resolvePlane(withOffset(s, -8, b), b)!;
    expect(r2.plane.distanceToPoint(onFace.clone().addScaledVector(n, -7.5))).toBeLessThan(0);
  });

  it("the plane's frame covers the bounds' shadow, centred on the face point or the bounds' centre", () => {
    const b = box([-50, -20, 0], [50, 20, 30]);
    const f = planeFrame(originPlane(2, b), b);
    expect(f.centre.toArray()).toEqual([0, 0, 15]);
    const [small, large] = [...f.half].sort((x, y) => x - y);
    expect(small).toBeGreaterThanOrEqual(20);
    expect(large).toBeGreaterThanOrEqual(50);
    expect(f.u.dot(f.normal)).toBeCloseTo(0, 9);
    expect(f.v.dot(f.normal)).toBeCloseTo(0, 9);
  });
});

describe("face pick (gizmo)", () => {
  const cube = () => {
    const m: THREE.Mesh = new THREE.Mesh(new THREE.BoxGeometry(20, 20, 20), new THREE.MeshStandardMaterial());
    m.position.set(100, 0, 0);
    m.userData.bodyKey = "shell/blank_1";
    m.updateMatrixWorld(true);
    return m;
  };
  it("gathers the flat face of a plain mesh by its plane: outward normal, centroid, area", () => {
    const m = cube();
    // BoxGeometry's triangles 0 and 1 are its +x face
    const f = gatherFace(m, 0)!;
    expect(f.source).toBe("coplanar");
    expect(f.planar).toBe(true);
    expect(f.triangles.length).toBe(18);
    expect(f.normal.toArray().map((x) => Math.round(x * 1e6) / 1e6)).toEqual([1, 0, 0]);
    expect(f.point.x).toBeCloseTo(110, 6);
    expect(f.areaMm2).toBeCloseTo(400, 3);
  });

  it("gathers a B-rep face by its feature id when the sidecar has one", () => {
    const m = cube();
    const g = m.geometry.toNonIndexed();
    const ids = new Float32Array(g.getAttribute("position").count);
    // the +x face is feature 7; every other triangle another id
    for (let t = 0; t < ids.length / 3; t++) ids.fill(t < 2 ? 7 : 100 + t, t * 3, t * 3 + 3);
    g.setAttribute(FEATURE_ID_ATTRIBUTE, new THREE.BufferAttribute(ids, 1));
    m.geometry = g;
    const f = gatherFace(m, 1)!;
    expect(f.source).toBe("feature-id");
    expect(f.face).toBe(7);
    expect(f.triangles.length).toBe(18);
  });

  it("a part with one id for every triangle (an STL part, ClientX's panels) is read by the hit's plane", () => {
    const m = cube();
    const g = m.geometry.toNonIndexed();
    g.setAttribute(FEATURE_ID_ATTRIBUTE, new THREE.BufferAttribute(new Float32Array(g.getAttribute("position").count), 1));
    m.geometry = g;
    const f = gatherFace(m, 0)!;
    expect(f.source).toBe("coplanar");
    expect(f.planar).toBe(true);
    expect(f.areaMm2).toBeCloseTo(400, 3);
    expect(f.spreadMm).toBe(0);
  });

  it("a curved face is not planar: the plane is tangent at the point picked", () => {
    // a closed cylinder whose side is one B-rep face (id 3) and whose caps are others (id 4)
    const g = new THREE.CylinderGeometry(10, 10, 30, 32, 1, false).toNonIndexed();
    const ids = new Float32Array(g.getAttribute("position").count);
    for (let t = 0; t < ids.length / 3; t++) ids.fill(t < 64 ? 3 : 4, t * 3, t * 3 + 3);
    g.setAttribute(FEATURE_ID_ATTRIBUTE, new THREE.BufferAttribute(ids, 1));
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial());
    m.userData.bodyKey = "tube";
    m.updateMatrixWorld(true);
    const hitPoint = new THREE.Vector3(0, 0, 10);
    const f = faceOfPick({ object: m, triangle: 0, point: hitPoint, distance: 1 } as never)!;
    expect(f.planar).toBe(false);
    expect(f.point.toArray()).toEqual([0, 0, 10]);
    expect(f.path).toBe("tube");
  });

  it("the handle's drag runs along its line; the press radius is measured on screen", () => {
    const ray = new THREE.Ray(new THREE.Vector3(0, -100, 7), new THREE.Vector3(0, 1, 0));
    expect(rayLineParam(ray, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 1))).toBeCloseTo(7, 9);
    // along the line itself: no answer (the arrow points at the eye)
    expect(rayLineParam(new THREE.Ray(new THREE.Vector3(0, 0, 50), new THREE.Vector3(0, 0, -1)), new THREE.Vector3(), new THREE.Vector3(0, 0, 1))).toBeUndefined();
    expect(segmentDistancePx(new THREE.Vector2(5, 3), new THREE.Vector2(0, 0), new THREE.Vector2(10, 0))).toBe(3);
    const cam = new THREE.PerspectiveCamera(32, 1, 1, 5000);
    cam.position.set(0, 0, 1000);
    expect(mmPerPixel(cam, new THREE.Vector3(), 900)).toBeCloseTo((2 * 1000 * Math.tan((16 * Math.PI) / 180)) / 900, 9);
  });
});

describe("hatched caps (G5: the cut reads as a section, not as the panel)", () => {
  it("lays 45-degree lines in the plane, 1.2 mm apart, in ink over the cap tone, with a screen-space fallback", () => {
    expect(HATCH_MM).toBe(1.2);
    expect(HATCH_DEG).toBe(45);
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.basic.vertexShader, fragmentShader: THREE.ShaderLib.basic.fragmentShader } as unknown as THREE.WebGLProgramParametersWithUniforms;
    const u = hatchUniforms();
    patchHatch(shader, u);
    expect(shader.vertexShader).toContain("vHatchWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;");
    expect(shader.fragmentShader).toContain("fwidth( c )");
    expect(shader.fragmentShader).toContain("gl_FragCoord.xy");
    expect(shader.fragmentShader).toContain("#define UHD_HATCH");
    expect(/[^\x00-\x7f]/.test(HATCH_FRAGMENT)).toBe(false);
    expect((shader.uniforms as Record<string, unknown>).uHatchMm).toBe(u.uHatchMm);
    const n = new THREE.Vector3(0, 0, 1);
    const across = hatchAcross(n);
    expect(across.dot(n)).toBeCloseTo(0, 9);
    // 45 degrees from the plane's first axis plus 90: equal parts of u and v
    expect(Math.abs(across.x)).toBeCloseTo(Math.abs(across.y), 9);
  });

  it("reads in both looks: the ink on the cap at least 4.5:1, the ink the theme's own", () => {
    for (const t of [PAPER_SCENE_TOKENS, DARK_SCENE_TOKENS]) {
      expect(inkFor(t.sectionCap)).toBe(t.sectionLine);
      expect(contrast(t.sectionLine, t.sectionCap)).toBeGreaterThanOrEqual(4.5);
    }
    const caps = new SectionCaps();
    caps.setColor(PAPER_SCENE_TOKENS.sectionCap);
    expect(caps.colors()).toEqual({ cap: PAPER_SCENE_TOKENS.sectionCap, ink: PAPER_SCENE_TOKENS.sectionLine });
    caps.setColor(DARK_SCENE_TOKENS.sectionCap);
    expect(caps.colors().ink).toBe(DARK_SCENE_TOKENS.sectionLine);
    caps.setInk("#ff0000");
    caps.setColor(PAPER_SCENE_TOKENS.sectionCap);
    expect(caps.colors().ink).toBe("#ff0000");
    caps.dispose();
  });
});

describe("open meshes get CPU caps", () => {
  it("tells a closed box from an open sheet", () => {
    expect(meshIsClosed(new THREE.BoxGeometry(1, 1, 1))).toBe(true);
    expect(meshIsClosed(new THREE.PlaneGeometry(1, 1))).toBe(false);
    expect(meshIsClosed(new THREE.CylinderGeometry(1, 1, 2, 12, 1, true))).toBe(false);
  });

  it("fills closed chains with their holes, on the plane", () => {
    const sq = (s: number, z: number): [number, number, number][] => [[-s, -s, z], [s, -s, z], [s, s, z], [-s, s, z]];
    const tris = capTriangles([sq(10, 5), sq(4, 5)], [true, true], new THREE.Vector3(0, 0, 1));
    let area = 0;
    for (let i = 0; i < tris.length; i += 9) {
      const a = new THREE.Vector3(tris[i], tris[i + 1], tris[i + 2]);
      const b = new THREE.Vector3(tris[i + 3], tris[i + 4], tris[i + 5]);
      const c = new THREE.Vector3(tris[i + 6], tris[i + 7], tris[i + 8]);
      area += b.sub(a).cross(c.sub(a)).length() / 2;
      expect(tris[i + 2]).toBeCloseTo(5, 6);
    }
    expect(area).toBeCloseTo(400 - 64, 6);
    expect(capTriangles([sq(10, 0)], [false], new THREE.Vector3(0, 0, 1))).toEqual([]);
  });

  it("the sections report names each plane's source and offset, the hatch, and the open parts", () => {
    const root = new THREE.Group();
    const solid = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), new THREE.MeshStandardMaterial());
    const sheet: THREE.Mesh = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), new THREE.MeshStandardMaterial());
    // the sheet: a box with its +z face left out (triangles 8 and 9: open), cut across y through it
    const g = sheet.geometry.toNonIndexed();
    const pos = g.getAttribute("position");
    const keep: number[] = [];
    for (let t = 0; t < pos.count / 3; t++) if (!(t === 8 || t === 9)) for (let k = 0; k < 9; k++) keep.push((pos.array as Float32Array)[t * 9 + k]);
    sheet.geometry = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(keep, 3));
    const a = new THREE.Group();
    a.userData.key = "solid";
    a.add(solid);
    const b = new THREE.Group();
    b.userData.key = "sheet";
    b.position.x = 30;
    b.add(sheet);
    root.add(a, b);
    root.updateMatrixWorld(true);
    const s = new SceneSections({ roots: () => [root], globalPlanes: () => [], invalidate: () => {}, eye: () => new THREE.Vector3(0, -100, 0) });
    const bx = new THREE.Box3().setFromObject(root);
    const plane = resolvePlane(withOffset(originPlane(1, bx), 0, bx), bx)!;
    s.set({ planes: [plane.plane] });
    s.compute();
    const r = s.report()!;
    expect(r.planes[0]).toMatchObject({ source: "origin", offset: 0 });
    expect(r.hatch).toEqual({ mm: 1.2, deg: 45, minPx: 2, screenPx: 6 });
    expect(r.open?.map((o) => o.instancePath)).toEqual(["sheet"]);
    expect(r.open?.[0].cap).toBe("none");
    s.dispose();
  });
});

describe("the toolbar (R2-B): Explode and Assemble, the section chooser", () => {
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
  const tag = (m: string, label: string) => m.match(new RegExp(`<button[^>]*data-tooltip="${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^"]*"[^>]*>`))?.[0];

  it("two controls with their own glyphs and tooltips (R5-B: two independent toggles, \"Explode\" and \"Assemble\")", () => {
    const m = html();
    expect(tag(m, EXPLODE_LABEL)).toContain('aria-pressed="false"');
    expect(tag(m, ASSEMBLE_LABEL)).toContain('aria-pressed="false"');
    expect(m).toContain('data-glyph="explode"');
    expect(m).toContain('data-glyph="assemble"');
    expect(EXPLODE_LABEL).toBe("Explode");
    expect(ASSEMBLE_LABEL).toBe("Assemble");
    // a state from before R5 reads through t and the mode
    const radial = html({ exploded: true, explodeMode: "radial" });
    expect(tag(radial, EXPLODE_LABEL)).toContain('aria-pressed="true"');
    expect(tag(radial, ASSEMBLE_LABEL)).toContain('aria-pressed="false"');
    const steps = html({ exploded: true, explodeMode: "sequence" });
    expect(tag(steps, EXPLODE_LABEL)).toContain('aria-pressed="false"');
    expect(tag(steps, ASSEMBLE_LABEL)).toContain('aria-pressed="true"');
  });

  it("the section popover offers XY, YZ, ZX and a face pick (disabled with its reason without a scene), the offset in mm", () => {
    const b = box([-50, -50, 0], [50, 50, 100]);
    const m = html({ sectionMenu: true, sections: [withOffset(originPlane(2, b), 12.5, b)], bounds: () => b } as Partial<CadToolbarProps>);
    for (const id of ["XY", "YZ", "ZX"]) expect(m).toContain(`>${id}</button>`);
    expect(m).toContain('data-tooltip="XY plane (cut across Z)"');
    expect(tag(m, "Pick a face: not available in this view")).toContain("disabled");
    expect(m).toContain('aria-label="Plane 1 offset (mm)"');
    expect(m).toContain('value="12.5"');
    expect(m).toContain("XY plane");
    expect(m).toContain('data-tooltip="Keep the other side"');
    const withScene = html({ sectionMenu: true, sections: [originPlane(2, b)], bounds: () => b, sceneRef: { current: null } } as Partial<CadToolbarProps>);
    expect(tag(withScene, "Pick a face: its plane becomes the cut")).not.toContain("disabled");
  });
});
