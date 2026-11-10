/**
 * W3-C: the toon bands and twins (PB-1189), sections (PB-1186: planes, the CPU cut, the cut as data, the scoped
 * looks), the loading tiers wired to loads (PB-1177), the coarse load's size cap and byte hash, the debug flag.
 */
import * as THREE from "three";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Batcher, MaterialRegistry, SECTION_LAYER, lookOf } from "../src/cad/render/batch";
import { NEUTRAL_FALLBACK, ToonTwins, bandFactors, patchToon, toonUniforms } from "../src/cad/render/toon";
import { SceneSections, chainSegments, clipSegment, flipped, instancePathOfMesh, nextPlane, resolvePlane, sectionsByCamera, sliceGeometry, slicePlane, sliceTargets } from "../src/cad/sections";
import { observeScene } from "../src/cad/render/observe";
import { TierGate } from "../src/cad/loading/tiers";
import { preflightFromSidecars } from "../src/cad/loading/preflight";
import { LoadTracker } from "../src/cad/loading/stages";
import { MAX_SIDECAR_JSON_BYTES, MAX_GLB_BYTES } from "../src/cad/render/sidecar";
import { CadToolbar, type CadToolbarProps } from "../src/cad/CadToolbar";

const std = (color = 0x8b8b8b) => new THREE.MeshStandardMaterial({ color });

describe("toon bands (PB-1189)", () => {
  it("patches the standard shader: bands from a camera key, the neutral body takes the lit tone, emissive on top", () => {
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader } as unknown as THREE.WebGLProgramParametersWithUniforms;
    const u = toonUniforms();
    patchToon(shader, u);
    expect(shader.fragmentShader).toContain("#ifdef UHD_TOON");
    expect(shader.fragmentShader).toContain("outgoingLight = base * band + totalEmissiveRadiance;");
    expect(shader.fragmentShader.match(/#include <opaque_fragment>/g)!.length).toBe(1);
    expect((shader.uniforms as Record<string, unknown>).uToonBands).toBe(u.uToonBands);
    // idempotent
    const once = shader.fragmentShader;
    patchToon(shader, u);
    expect(shader.fragmentShader).toBe(once);
    expect(u.uToonFallback.value.getHex()).toBe(new THREE.Color(NEUTRAL_FALLBACK).getHex());
  });

  it("band factors are the tones' luminance over the lit tone's", () => {
    expect(bandFactors({ lit: "#ffffff", mid: "#ffffff", shade: "#000000" })).toEqual([0, 1, 1]);
    const [s, m, l] = bandFactors({ lit: "#333333", mid: "#262626", shade: "#1c1c1c" });
    expect(l).toBe(1);
    expect(m).toBeGreaterThan(s);
    expect(bandFactors({ lit: "nope", mid: "#000", shade: "#000" })).toHaveLength(3);
  });

  it("the shared instanced materials carry the toon define, no tone mapping, and switch back", () => {
    const reg = new MaterialRegistry();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), std());
    const m = reg.get(lookOf(mesh, mesh.material as THREE.MeshStandardMaterial));
    expect(m.defines).toHaveProperty("UHD_TOON");
    expect(m.toneMapped).toBe(false);
    expect(m.defines).toHaveProperty("USE_INSTANCE_EMISSIVE");
    const v = m.version;
    reg.setToon(false);
    expect(m.defines).not.toHaveProperty("UHD_TOON");
    expect(m.toneMapped).toBe(true);
    expect(m.version).toBeGreaterThan(v);
  });

  it("a mesh drawn as itself draws a twin that follows its material (fades, colour, side) and carries the clip planes", () => {
    const twins = new ToonTwins(toonUniforms());
    const base = std(0xff0000);
    const t = twins.of(base);
    expect(t).not.toBe(base);
    expect(t.defines).toHaveProperty("UHD_TOON");
    expect(twins.of(base)).toBe(t);
    base.opacity = 0.3;
    base.transparent = true;
    base.color.setHex(0x00ff00);
    const v = t.version;
    twins.of(base);
    expect(t.opacity).toBe(0.3);
    expect(t.transparent).toBe(true);
    expect(t.color.getHex()).toBe(0x00ff00);
    expect(t.version).toBeGreaterThan(v);
    const planes = [new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)];
    const clipped = twins.of(base, { toon: true, clip: planes });
    expect(clipped).not.toBe(t);
    expect(clipped.clippingPlanes).toBe(planes);
    const lit = twins.of(base, { toon: false, clip: planes });
    expect(lit.defines ?? {}).not.toHaveProperty("UHD_TOON");
  });
});

describe("the batcher under sections and the toon look", () => {
  const scene = () => {
    const root = new THREE.Group();
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = std(0x336699);
    const a = new THREE.Mesh(geo, mat);
    const b = new THREE.Mesh(geo, mat);
    const c = new THREE.Mesh(geo, mat);
    const cable = new THREE.Mesh(geo, std(0xffffff));
    cable.userData.noBatch = true;
    root.add(a, b, c, cable);
    root.updateMatrixWorld(true);
    return { root, a, b, c, cable };
  };

  it("lists every mesh drawn as itself (for its toon twin)", () => {
    const { root, cable } = scene();
    const bt = new Batcher();
    bt.sync([root]);
    expect(bt.own).toContain(cable);
  });

  it("scoped meshes go to their own looks, clipped through the material, on the section layer", () => {
    const { root, a, b, c } = scene();
    a.userData.sectionScoped = true;
    b.userData.sectionScoped = true;
    const bt = new Batcher();
    const planes = [new THREE.Plane(new THREE.Vector3(1, 0, 0), 0)];
    bt.materials.setClipPlanes(planes);
    bt.sync([root]);
    const groups = bt.root.children as THREE.InstancedMesh[];
    const clipped = groups.find((g) => (g.material as THREE.Material).clippingPlanes?.length);
    expect(clipped).toBeDefined();
    expect(clipped!.count).toBe(2);
    expect(clipped!.layers.isEnabled(SECTION_LAYER)).toBe(true);
    expect((clipped!.material as THREE.Material).clippingPlanes).toBe(bt.materials.clipPlanes);
    // c is alone in its look: drawn as itself, not clipped
    expect(bt.singles).toContain(c);
    // a change in the number of planes recompiles the clipped looks
    const m = clipped!.material as THREE.Material;
    const v = m.version;
    bt.materials.setClipPlanes([...planes, new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)]);
    expect(m.version).toBeGreaterThan(v);
  });
});

describe("section planes", () => {
  const box = new THREE.Box3(new THREE.Vector3(-10, -20, 0), new THREE.Vector3(10, 20, 40));

  it("resolves the view state's axis, fraction and side to a world plane (mm)", () => {
    const p = resolvePlane({ axis: 2, at: 0.25, flip: true }, box)!;
    expect(p.at).toBe(10);
    expect(p.plane.distanceToPoint(new THREE.Vector3(0, 0, 11))).toBeGreaterThan(0);
    expect(p.plane.distanceToPoint(new THREE.Vector3(0, 0, 9))).toBeLessThan(0);
    // no side: away from the camera along the axis
    const cam = { position: new THREE.Vector3(0, 0, 100), target: new THREE.Vector3(0, 0, 20) };
    const q = resolvePlane({ axis: 2, at: 0.5 }, box, cam)!;
    expect(q.flip).toBe(false);
    expect(q.plane.distanceToPoint(new THREE.Vector3(0, 0, 0))).toBeGreaterThan(0);
    expect(resolvePlane({ axis: 0, at: 0.5 }, new THREE.Box3())).toBeUndefined();
  });

  it("adds planes on unused axes up to three, and flips an automatic side into an explicit one", () => {
    expect(nextPlane([])).toEqual({ axis: 2, at: 0.5 });
    expect(nextPlane([{ axis: 2, at: 0.1 }])!.axis).toBe(0);
    expect(nextPlane([{ axis: 2, at: 0 }, { axis: 0, at: 0 }, { axis: 1, at: 0 }])).toBeUndefined();
    expect(flipped({ axis: 1, at: 0.5 }, true).flip).toBe(false);
    expect(flipped({ axis: 1, at: 0.5, flip: false }, true).flip).toBe(true);
  });
});

describe("the exact cut (CPU slice)", () => {
  it("cuts a 10 mm cube at its middle into one closed square, 40 mm around, with and without the BVH", () => {
    const g = new THREE.BoxGeometry(10, 10, 10);
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    for (const bvh of [true, false]) {
      const { segments, triangles } = sliceGeometry(g, plane, bvh);
      expect(triangles).toBe(8);
      const pts = segments.map((p) => [p.x, p.y, p.z] as [number, number, number]);
      const { polylines, closed } = chainSegments(pts);
      expect(polylines.length).toBe(1);
      expect(closed).toEqual([true]);
    }
  });

  it("reports world mm per part, through cadWrapper's metres-to-mm scale, and clips by the other planes", () => {
    // a 10 mm cube modelled in metres inside a ×1000 wrapper (as every GLB is)
    const body = new THREE.Group();
    body.userData.key = "shell#body";
    const wrap = new THREE.Group();
    wrap.scale.setScalar(1000);
    wrap.rotation.x = Math.PI / 2;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), std());
    mesh.userData.protoboard = { partInstanceId: "lid" };
    wrap.add(mesh);
    body.add(wrap);
    body.position.set(100, 0, 0);
    body.updateMatrixWorld(true);
    expect(instancePathOfMesh(mesh)).toBe("shell/lid");
    const targets = sliceTargets([body]);
    expect(targets.length).toBe(1);
    const cut = slicePlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), targets);
    expect(cut.parts.length).toBe(1);
    expect(cut.parts[0].instancePath).toBe("shell/lid");
    expect(cut.parts[0].lengthMm).toBeCloseTo(40, 3);
    const xs = cut.parts[0].polylines[0].map((p) => p[0]);
    expect(Math.min(...xs)).toBeCloseTo(95, 3);
    expect(Math.max(...xs)).toBeCloseTo(105, 3);
    // the other plane keeps x >= 100: half the square, open
    const half = slicePlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), targets, { keep: [new THREE.Plane(new THREE.Vector3(1, 0, 0), -100)] });
    expect(half.parts[0].lengthMm).toBeCloseTo(20, 3);
    expect(half.parts[0].closed).toEqual([false]);
    expect(cut.parts[0].watertight).toBe(true);
    expect(half.parts[0].watertight).toBe(false);
  });

  it("cuts each GPU instance of an instanced mesh", () => {
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(2, 2, 2), std(), 2);
    inst.setMatrixAt(0, new THREE.Matrix4().makeTranslation(-5, 0, 0));
    inst.setMatrixAt(1, new THREE.Matrix4().makeTranslation(5, 0, 0));
    const holder = new THREE.Group();
    holder.userData.key = "r";
    holder.add(inst);
    holder.updateMatrixWorld(true);
    const cut = slicePlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), sliceTargets([holder]));
    expect(cut.parts[0].polylines.length).toBe(2);
    expect(cut.parts[0].lengthMm).toBeCloseTo(16, 3);
  });

  it("clips a segment to the kept side of every plane", () => {
    const keep = [new THREE.Plane(new THREE.Vector3(1, 0, 0), 0)];
    const s = clipSegment(new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0), keep)!;
    expect(s[0].x).toBeCloseTo(0);
    expect(clipSegment(new THREE.Vector3(-2, 0, 0), new THREE.Vector3(-1, 0, 0), keep)).toBeUndefined();
  });
});

describe("a scene's sections, and observe()", () => {
  it("computes the cut once quiet, drops it on a change, and reports it through observe() by camera", async () => {
    const root = new THREE.Group();
    const body = new THREE.Group();
    body.userData.key = "box";
    body.add(new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), std()));
    root.add(body);
    root.updateMatrixWorld(true);
    let globals: THREE.Plane[] = [];
    let frames = 0;
    const s = new SceneSections({ roots: () => [root], globalPlanes: () => globals, invalidate: () => frames++, eye: () => new THREE.Vector3(0, 0, 100), debounceMs: 5 });
    expect(s.report()).toBeUndefined();
    globals = [new THREE.Plane(new THREE.Vector3(0, 0, -1), 0)];
    s.checkGlobal();
    expect(s.report()!.cuts).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    const rep = s.report()!;
    expect(rep.scope).toBe("all");
    expect(rep.cuts![0].parts[0]).toMatchObject({ instancePath: "box", closed: [true] });
    expect(s.outline.children.length).toBe(1);
    expect(frames).toBeGreaterThan(0);
    // a change drops the cut and the outline until quiet again
    s.changed();
    expect(s.report()!.cuts).toBeNull();
    expect(s.outline.children.length).toBe(0);
    // observe() finds a scene's report by its camera
    const camera = new THREE.PerspectiveCamera();
    sectionsByCamera.set(camera, () => s.report());
    const o = observeScene({ seq: 1, bodies: [], harnesses: [], selection: {}, camera, target: new THREE.Vector3(), counts: { draws: 0, triangles: 0, frames: 0 }, loading: { phase: "ready", total: 0, done: 0, failed: 0, bytes: 0, swapped: 0, kept: 0, started: 0, ms: 0 } });
    expect(o.sections?.planes[0].normal).toEqual([0, 0, -1]);
    s.dispose();
  });

  it("with a host's scoped planes, cuts only the scope and names it", () => {
    const root = new THREE.Group();
    const a = new THREE.Group();
    a.userData.key = "a";
    a.add(new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), std()));
    const b = new THREE.Group();
    b.userData.key = "b";
    b.add(new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), std()));
    root.add(a, b);
    root.updateMatrixWorld(true);
    const s = new SceneSections({ roots: () => [root], globalPlanes: () => [], invalidate: () => {}, eye: () => new THREE.Vector3(0, 0, 100) });
    s.set({ planes: [new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)], scope: [a], scopePaths: ["a"] });
    const cuts = s.compute();
    expect(cuts[0].parts.map((p) => p.instancePath)).toEqual(["a"]);
    expect(s.report()!.scope).toEqual(["a"]);
    s.dispose();
  });
});

describe("loading tiers wired to loads (the wave 2 gate)", () => {
  const sidecarFetch = (files: Record<string, unknown>, headers: Record<string, string> = {}) =>
    (async (url: string) => (files[url] ? new Response(JSON.stringify(files[url]), { headers }) : new Response("", { status: 404 }))) as unknown as typeof fetch;

  it("a light model loads at once at the fine tier", async () => {
    const tr = new LoadTracker();
    const gate = new TierGate(() => tr);
    const t = await gate.plan(new Map([["/m/a.glb", 1]]), sidecarFetch({ "/m/a.view.json": { tiers: { fine: { draws: 10, triangles: 100 } } } }));
    expect(t).toBe("fine");
    expect(gate.preflight?.over).toBe(false);
  });

  it("a heavy model waits for a choice; the choice sets the tier and tells the tracker", async () => {
    const tr = new LoadTracker();
    const gate = new TierGate(() => tr);
    const heard: string[] = [];
    gate.onChange((t) => heard.push(t));
    const p = gate.plan(new Map([["/m/a.glb", 3]]), sidecarFetch({ "/m/a.view.json": { tiers: { fine: { draws: 9000, triangles: 2_000_000 } } } }));
    let settled = false;
    void p.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    expect(tr.snapshot().preflight?.over).toBe(true);
    gate.choose("coarse");
    expect(await p).toBe("coarse");
    expect(gate.tier).toBe("coarse");
    expect(heard).toEqual(["coarse"]);
    expect(tr.snapshot().choice).toBe("coarse");
    // once chosen, a new plan does not ask again
    expect(await gate.plan(new Map([["/m/a.glb", 3]]), sidecarFetch({}))).toBe("coarse");
  });

  it("the pre-flight skips an index over the size cap, by its header and by its text", async () => {
    const big = { tiers: { fine: { draws: 99_999, triangles: 1 } }, pad: "x".repeat(16) };
    const byHeader = await preflightFromSidecars(new Map([["/m/a.glb", 1]]), sidecarFetch({ "/m/a.view.json": big }, { "content-length": String(MAX_SIDECAR_JSON_BYTES + 1) }));
    expect(byHeader.draws).toBe(0);
    const ok = await preflightFromSidecars(new Map([["/m/a.glb", 1]]), sidecarFetch({ "/m/a.view.json": big }));
    expect(ok.draws).toBe(99_999);
  });
});

describe("the coarse load: size before reading, the bytes' hash as the key", () => {
  it("refuses a GLB the server says is over the cap without reading its body", async () => {
    const { createGlbCache } = await import("../src/cad/render/glbCache");
    let read = 0;
    const cache = createGlbCache({
      sidecars: false,
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: (n: string) => (n.toLowerCase() === "content-length" ? String(MAX_GLB_BYTES + 1) : null) },
        arrayBuffer: async () => {
          read++;
          return new ArrayBuffer(4);
        },
        text: async () => "",
      }),
      parse: async () => ({ scene: new THREE.Group() }) as never,
    });
    expect(await cache.load("/m/huge.glb").catch(() => null)).toBeNull();
    expect(read).toBe(0);
  });
});

describe("the debug handle", () => {
  it("installs window.__cadQuality only behind the flag", async () => {
    const { cadDebugEnabled } = await import("../src/cad/scene");
    const g = globalThis as { __CAD_DEBUG__?: boolean };
    expect(cadDebugEnabled()).toBe(false);
    g.__CAD_DEBUG__ = true;
    expect(cadDebugEnabled()).toBe(true);
    delete g.__CAD_DEBUG__;
  });
});

describe("the toolbar's section planes", () => {
  const props = (over: Partial<CadToolbarProps>): CadToolbarProps =>
    ({
      exploded: false, onExploded: () => {}, labels: false, onLabels: () => {}, labelKinds: new Set(), onLabelKind: () => {}, labelMenu: false, onLabelMenu: () => {},
      hardwareCount: 0, hardware: false, onHardware: () => {}, harnessCount: 0, wires: false, onWires: () => {}, frames: false, onFrames: () => {},
      section: null, onSection: () => {}, sectionMenu: true, onSectionMenu: () => {}, autoFlip: () => true, shells: 0, xray: false, onXray: () => {},
      findings: 0, showFindings: false, onFindings: () => {}, direction: "both", onDirection: () => {}, onFit: () => {}, onFocus: () => {}, canFocus: false,
      ...over,
    }) as CadToolbarProps;

  it("lists each plane with its axis, side and slider, offers adding and the scope", () => {
    const html = renderToStaticMarkup(createElement(CadToolbar, props({ sections: [{ axis: 2, at: 0.3 }, { axis: 0, at: 0.6, flip: true }], onSections: () => {}, scopeCandidate: { path: "shell/lid", label: "lid" } })));
    expect(html.match(/cad-section-row/g)!.length).toBe(2);
    expect(html).toContain("Add plane");
    expect(html).toContain("Whole model");
    expect(html).toContain("Only lid");
    expect(html).toContain('aria-label="Plane 1 offset along Z (mm)"');
  });

  it("says when three planes are in", () => {
    const html = renderToStaticMarkup(createElement(CadToolbar, props({ sections: [{ axis: 2, at: 0 }, { axis: 0, at: 0 }, { axis: 1, at: 0 }], onSections: () => {} })));
    expect(html).toContain("At most 3 planes");
  });
});
