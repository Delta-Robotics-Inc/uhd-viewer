/**
 * Measurement tiers and face primitives (PB-1187), in node: fits and their
 * tolerances on tessellated holes and plates, face patches from merged
 * meshes (feature ids) and plain ones (one mesh per face) in mm through the
 * cadWrapper boundary, picks through W1-C's BVH picking, the exact tier's
 * request, place on face and orient by face, and the shared protocol.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { cadWrapper } from "../src/cad/scene";
import {
  GEOMETRY_REQUEST_SCHEMA,
  checkGeometryRequest,
  classifySurface,
  compareTiers,
  exactRequest,
  faceFrameOf,
  faceIdOf,
  faceSignature,
  fitCylinder,
  fitPlane,
  measureBounds,
  measureCylinder,
  measureFaceFace,
  measurePointFace,
  measurePointPoint,
  meshFace,
  objectFace,
  orientByFaceFrames,
  pickRef,
  placeOnFace,
  placeOnFaceFrames,
  refFace,
  refFaceSource,
  refPointInPart,
  tessellationStats,
  toPartFrame,
  type FacePatch,
  type MeasureResult,
} from "../src/cad/measure";
import { checkValue } from "../src/cad/state/schema";
import { IDENTITY, applyDir, applyPoint, mul, rotationAbout, translation, type V3 } from "../src/cad/measure/linalg";

// ---------------------------------------------------------------------------
// synthetic faces (mm)
// ---------------------------------------------------------------------------

/** The wall of a hole: radius r, axis +Z through (cx, cy), from z0 to z1, n segments (vertices on the true circle). */
function hole(cx: number, cy: number, r: number, z0: number, z1: number, n = 32): FacePatch {
  const pos: number[] = [];
  const nor: number[] = [];
  for (let i = 0; i < n; i++) {
    const a0 = (2 * Math.PI * i) / n;
    const a1 = (2 * Math.PI * (i + 1)) / n;
    const p = (a: number, z: number) => [cx + r * Math.cos(a), cy + r * Math.sin(a), z];
    // inward normals (a hole's wall faces the axis)
    const nn = (a: number) => [-Math.cos(a), -Math.sin(a), 0];
    for (const [a, z] of [
      [a0, z0],
      [a1, z1],
      [a1, z0],
      [a0, z0],
      [a0, z1],
      [a1, z1],
    ] as [number, number][]) {
      pos.push(...p(a, z));
      nor.push(...nn(a));
    }
  }
  return { positions: Float64Array.from(pos), normals: Float64Array.from(nor) };
}

/** A flat rectangle at height z, normal +Z (or -Z when `down`). */
function rect(x0: number, y0: number, x1: number, y1: number, z: number, down = false): FacePatch {
  const a = [x0, y0, z];
  const b = [x1, y0, z];
  const c = [x1, y1, z];
  const d = [x0, y1, z];
  const tris = down ? [a, c, b, a, d, c] : [a, b, c, a, c, d];
  return { positions: Float64Array.from(tris.flat()) };
}

describe("fits and tolerances on tessellated faces", () => {
  it("fits a hole's axis and diameter; the vertices lie on the circle, so the fit is near exact", () => {
    const f = fitCylinder(hole(79.55, 79.55, 1.6, 0, 5))!;
    expect(f.radius).toBeCloseTo(1.6, 6);
    expect(Math.abs(f.axis[2])).toBeCloseTo(1, 9);
    expect(f.point[0]).toBeCloseTo(79.55, 6);
    expect(f.point[1]).toBeCloseTo(79.55, 6);
    expect(f.coverageDeg).toBeGreaterThan(348);
    expect(f.length).toBeCloseTo(5, 9);
    expect(classifySurface(hole(0, 0, 1.6, 0, 5)).kind).toBe("cylinder");
  });

  it("estimates the chord error from the tessellation (L * phi / 8 against r(1 - cos(pi/n)))", () => {
    for (const n of [12, 32, 64]) {
      const s = tessellationStats(hole(0, 0, 10, 0, 1, n));
      const truth = 10 * (1 - Math.cos(Math.PI / n));
      expect(s.sagitta.max).toBeGreaterThan(truth * 0.9);
      expect(s.sagitta.max).toBeLessThan(truth * 1.1);
    }
    // without corner normals: from the neighbouring triangles' normals
    const bare = hole(0, 0, 10, 0, 1, 32);
    delete bare.normals;
    expect(tessellationStats(bare).sagitta.max).toBeCloseTo(10 * (1 - Math.cos(Math.PI / 32)), 2);
    expect(tessellationStats(rect(0, 0, 10, 10, 0)).sagitta.max).toBe(0);
  });

  it("fits a plane through a plate's face, normal with the winding", () => {
    const up = fitPlane(rect(-5, -5, 5, 5, 8));
    expect(up.normal[2]).toBeCloseTo(1, 9);
    expect(up.point[2]).toBeCloseTo(8, 9);
    expect(up.rms).toBeLessThan(1e-9);
    expect(fitPlane(rect(-5, -5, 5, 5, 1.6, true)).normal[2]).toBeCloseTo(-1, 9);
    expect(classifySurface(rect(0, 0, 1, 1, 0)).kind).toBe("plane");
  });

  it("measures two motor-mount holes axis to axis (16 mm on a 16 x 16 pattern) with a tolerance that holds the truth", () => {
    const a = { patch: hole(71.55, 79.55, 1.6, 0, 5, 24), quantization: 0.01 };
    const b = { patch: hole(87.55, 79.55, 1.6, 0, 5, 24), quantization: 0.01 };
    const m = measureFaceFace(a, b);
    expect(m.tier).toBe("mesh");
    expect(m.method).toBe("axis-to-axis");
    expect(m.distance).toBeCloseTo(16, 4);
    expect(m.angleDeg).toBeCloseTo(0, 4);
    expect(m.tolerance.mm).toBeGreaterThan(0.02);
    expect(m.tolerance.basis.join(" ")).toMatch(/chord error/);
    const c = measureCylinder(a);
    expect(c.diameter).toBeCloseTo(3.2, 4);
    expect(c.axis!.direction[2]).toBeCloseTo(1, 6);
  });

  it("measures the gap between parallel planes (a package's height over its board) and the angle between faces", () => {
    const top = { patch: rect(-12.25, -12.25, 12.25, 12.25, 8) };
    const board = { patch: rect(-18, -18, 18, 18, 1.6) };
    const m = measureFaceFace(top, board);
    expect(m.method).toBe("parallel-planes");
    expect(m.distance).toBeCloseTo(6.4, 6);
    expect(m.angleDeg).toBeCloseTo(0, 6);
    const tilted = { patch: { positions: Float64Array.from([0, 0, 0, 1, 0, 1, 0, 1, 0]) } };
    expect(measureFaceFace(board, tilted).angleDeg).toBeCloseTo(45, 6);
    const pf = measurePointFace([0, 0, 10], board);
    expect(pf.method).toBe("plane-fit");
    expect(pf.distance).toBeCloseTo(8.4, 6);
    expect(measurePointPoint([0, 0, 0], [3, 4, 0]).distance).toBe(5);
  });

  it("gives bounds with the chord error and grid as tolerance", () => {
    const m = measureBounds({ patch: hole(0, 0, 5, 0, 10, 16), quantization: 0.002 });
    expect(m.size![2]).toBeCloseTo(10, 6);
    // a 16-gon's flats are under the true radius: the tolerance covers it
    expect(Math.abs(m.size![0] - 10)).toBeLessThanOrEqual(m.tolerance.mm + 1e-9);
  });
});

// ---------------------------------------------------------------------------
// the scene: a body as CadView builds it (placement -> cadWrapper -> GLB nodes in metres, Y up)
// ---------------------------------------------------------------------------

/** A 20 x 20 x 4 mm plate with a hole, as a GLB would carry it: metres, Y up, faces as feature ids on one merged mesh. */
function plateMesh(): THREE.Mesh {
  // build in mm Z-up, then convert to the GLB frame (x, z, -y) / 1000
  const top = rect(-10, -10, 10, 10, 4);
  const bottom = rect(-10, -10, 10, 10, 0, true);
  const bore = hole(5, 0, 1.6, 0, 4, 24);
  const faces = [top, bottom, bore];
  const pos: number[] = [];
  const fid: number[] = [];
  faces.forEach((f, i) => {
    for (let k = 0; k < f.positions.length; k += 3) {
      const [x, y, z] = [f.positions[k], f.positions[k + 1], f.positions[k + 2]];
      pos.push(x / 1000, z / 1000, -y / 1000);
      fid.push(i);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("_feature_id_0", new THREE.Float32BufferAttribute(fid, 1));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  return m;
}

/** A body placed at `place` (mm, Z up), holding `meshes` under a GLB root, as CadView holds it. */
function body(key: string, place: THREE.Matrix4, meshes: THREE.Mesh[]): THREE.Object3D {
  const obj = new THREE.Group();
  obj.name = key;
  obj.matrixAutoUpdate = false;
  obj.matrix.copy(place);
  const glbRoot = new THREE.Group();
  for (const m of meshes) {
    m.userData.bodyKey = key;
    glbRoot.add(m);
  }
  const w = cadWrapper(glbRoot);
  w.name = "cad";
  obj.add(w);
  obj.updateMatrixWorld(true);
  return obj;
}

describe("face patches from the scene (metres to mm at cadWrapper)", () => {
  it("takes one face of a merged mesh by its feature id, in assembly mm and in the part's own mm", () => {
    const place = new THREE.Matrix4().makeTranslation(100, 0, 20);
    const mesh = plateMesh();
    const b = body("plate", place, [mesh]);
    const top = meshFace(mesh, 0);
    expect(top.source).toBe("feature-id");
    expect(top.patch.positions.length / 9).toBe(2);
    const zs = new Set<number>();
    for (let i = 2; i < top.patch.positions.length; i += 3) zs.add(Math.round(top.patch.positions[i] * 1e6) / 1e6);
    expect([...zs]).toEqual([24]);
    const local = meshFace(mesh, 0, { toFrame: toPartFrame(mesh) });
    expect(fitPlane(local.patch).point[2]).toBeCloseTo(4, 5);
    // the bore, in part mm
    const bore = meshFace(mesh, 2, { toFrame: toPartFrame(mesh) });
    const c = fitCylinder(bore.patch)!;
    expect(c.radius).toBeCloseTo(1.6, 4);
    expect(c.point[0]).toBeCloseTo(5, 4);
    expect(c.point[1]).toBeCloseTo(0, 4);
    expect(b.children[0].name).toBe("cad");
    // bounds of the whole body, assembly mm
    const bb = measureBounds(objectFace(b));
    expect(bb.size![0]).toBeCloseTo(20, 4);
    expect(bb.size![2]).toBeCloseTo(4, 4);
    expect(bb.min![2]).toBeCloseTo(20, 4);
  });

  it("keeps each glTF node's face numbering apart (a sidecar's named nodes each start at face 0)", () => {
    const a = plateMesh();
    const b = plateMesh();
    a.userData.gltfNode = 1;
    b.userData.gltfNode = 2;
    b.position.set(0.05, 0, 0); // 50 mm along x, in GLB metres
    body("fc", new THREE.Matrix4(), [a, b]);
    const fa = meshFace(a, 0);
    const fb = meshFace(b, 0);
    expect(fa.patch.positions.length / 9).toBe(2);
    expect(fb.patch.positions.length / 9).toBe(2);
    expect(fitPlane(fb.patch).point[0]).toBeCloseTo(50, 4);
  });

  it("numbers a plain GLB's faces by primitive (one mesh per face)", () => {
    const meshes = [rect(0, 0, 10, 10, 2), rect(0, 0, 10, 10, 0, true)].map((f) => {
      const g = new THREE.BufferGeometry();
      const pos: number[] = [];
      for (let k = 0; k < f.positions.length; k += 3) pos.push(f.positions[k] / 1000, f.positions[k + 2] / 1000, -f.positions[k + 1] / 1000);
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    });
    body("washer", new THREE.Matrix4(), meshes);
    expect(faceIdOf(meshes[1], 0)).toEqual({ face: 1, source: "primitive" });
    const f = meshFace(meshes[0], 1);
    expect(f.source).toBe("primitive");
    expect(fitPlane(f.patch).normal[2]).toBeCloseTo(-1, 6);
  });

  it("picks through the BVH and turns the hit into a reference with the face, point and part frame", () => {
    const mesh = plateMesh();
    const b = body("stack/fc", new THREE.Matrix4().makeTranslation(0, 0, 50), [mesh]);
    const ray = new THREE.Ray(new THREE.Vector3(-3, 2, 200), new THREE.Vector3(0, 0, -1));
    const ref = pickRef(ray, [b])!;
    expect(ref.part).toBe("stack/fc");
    expect(ref.face).toBe(0);
    expect(ref.point[2]).toBeCloseTo(54, 4);
    expect(refPointInPart(ref)[2]).toBeCloseTo(4, 4);
    const sig = faceSignature(refFace(ref, "part"));
    expect(sig.type).toBe("plane");
    expect(sig.centroid[2]).toBeCloseTo(4, 4);
    expect(sig.normal![2]).toBeCloseTo(1, 5);
    // the exact tier's request: signatures in part mm, the placement to come back in assembly mm
    const down = pickRef(new THREE.Ray(new THREE.Vector3(5, 0, 52), new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 0, 1), 0.3)), [b]);
    expect(down).toBeDefined();
    const req = exactRequest("face-face", ref, down!);
    expect(checkGeometryRequest(req)).toBeUndefined();
    expect(req.a.transform![11]).toBeCloseTo(50, 6);
    expect(req.a.signature!.type).toBe("plane");
  });
});

describe("place on face and orient by face", () => {
  it("lays a face on a target face: normals opposite, centroids together, with a gap and a spin", () => {
    const part = translation([30, -10, 5]);
    const face = { kind: "plane" as const, point: [30, -10, 5] as V3, normal: [1, 0, 0] as V3 };
    const target = { kind: "plane" as const, point: [0, 0, 19.3] as V3, normal: [0, 0, 1] as V3 };
    const r = placeOnFaceFrames(part, face, target, { gap: 0.5, spinDeg: 30 });
    const p = applyPoint(r.delta, face.point);
    expect(p[0]).toBeCloseTo(0, 9);
    expect(p[1]).toBeCloseTo(0, 9);
    expect(p[2]).toBeCloseTo(19.8, 9);
    const n = applyDir(r.delta, face.normal);
    expect(n[2]).toBeCloseTo(-1, 9);
    expect(r.matrix).toEqual(mul(r.delta, part));
  });

  it("puts a bore on a shaft coaxially, keeping the position along the axis", () => {
    const face = { kind: "axis" as const, point: [3, 4, 7] as V3, normal: [0, 1, 0] as V3 };
    const target = { kind: "axis" as const, point: [0, 0, 20] as V3, normal: [0, 0, 1] as V3 };
    const r = placeOnFaceFrames(IDENTITY, face, target);
    const p = applyPoint(r.delta, face.point);
    expect(p[0]).toBeCloseTo(0, 9);
    expect(p[1]).toBeCloseTo(0, 9);
    expect(p[2]).toBeCloseTo(7, 9);
    expect(applyDir(r.delta, face.normal)[2]).toBeCloseTo(1, 9);
  });

  it("orients without travelling, and reproduces a turn it is shown", () => {
    const turned = rotationAbout([1, 0, 0], 90, [0, 0, 0]);
    const face = { kind: "plane" as const, point: [2, 2, 2] as V3, normal: applyDir(turned, [0, 0, 1]) };
    const r = orientByFaceFrames(IDENTITY, face, { kind: "plane", point: [0, 0, 0], normal: [0, 0, 1] });
    expect(applyPoint(r.delta, face.point)).toEqual(face.point.map((x) => expect.closeTo(x, 9)));
    expect(applyDir(r.delta, face.normal)[2]).toBeCloseTo(1, 9);
  });

  it("places a part picked in the scene on another part's face and emits the view-state write", () => {
    const motorTop = plateMesh();
    const motor = body("arm_fl/motor", new THREE.Matrix4().makeTranslation(80, 80, 5), [motorTop]);
    const propMesh = plateMesh();
    const prop = body("arm_fl/prop", new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(0, 0, 100), [propMesh]);
    const top = pickRef(new THREE.Ray(new THREE.Vector3(78, 82, 200), new THREE.Vector3(0, 0, -1)), [motor])!;
    // the prop's bottom face (feature 1): turned 90 degrees about X it faces +Y, so pick it from that side
    const propBottom = { ...pickRef(new THREE.Ray(new THREE.Vector3(-3, 200, 100), new THREE.Vector3(0, -1, 0)), [prop])! };
    expect(top.face).toBe(0);
    expect(propBottom.face).toBe(1);
    const placed = placeOnFace(refFaceSource([top, propBottom]), "arm_fl/prop", 1, "arm_fl/motor", 0);
    expect(placed.op).toEqual({ op: "set", path: ["placements", "arm_fl/prop"], value: expect.objectContaining({ by: "placeOnFace", faces: { part: "arm_fl/prop", face: 1, target: "arm_fl/motor", targetFace: 0 } }) });
    // apply and check: the prop's bottom now lies on the motor's top (z 9), facing down
    prop.matrix.copy(new THREE.Matrix4().set(...(placed.matrix as [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number])));
    prop.updateMatrixWorld(true);
    const after = fitPlane(meshFace(propMesh, 1).patch);
    expect(after.point[2]).toBeCloseTo(9, 3);
    expect(after.normal[2]).toBeCloseTo(-1, 5);
    expect(after.point[0]).toBeCloseTo(80, 3);
    expect(placed.turnedDeg).toBeCloseTo(90, 3);
    expect(faceFrameOf(refFace(top)).normal[2]).toBeCloseTo(1, 6);
    // the write passes the view state's own check (rigid within 1e-6), even from a rounded starting placement
    expect(checkValue("placements", { "arm_fl/prop": placed.op.value })).toBeUndefined();
    prop.matrix.set(0.7071, -0.7071, 0, 0, 0.7071, 0.7071, 0, 0, 0, 0, 1, 100, 0, 0, 0, 1);
    prop.updateMatrixWorld(true);
    const again = placeOnFace(refFaceSource([top, { ...propBottom }]), "arm_fl/prop", 1, "arm_fl/motor", 0);
    expect(checkValue("placements", { "arm_fl/prop": again.op.value })).toBeUndefined();
  });
});

describe("the shared protocol", () => {
  it("checks requests and compares tiers field by field", () => {
    expect(checkGeometryRequest({ schema: GEOMETRY_REQUEST_SCHEMA, kind: "face-face", a: { part: "frame" } })).toMatch(/b is missing|face on a/);
    expect(checkGeometryRequest({ schema: GEOMETRY_REQUEST_SCHEMA, kind: "bounds", a: { part: "frame" } })).toBeUndefined();
    expect(checkGeometryRequest({ schema: "x", kind: "bounds", a: { part: "" } })).toMatch(/schema/);
    expect(checkGeometryRequest({ schema: GEOMETRY_REQUEST_SCHEMA, kind: "cylinder", a: { part: "f", signature: { type: "plane", centroid: [0, 0] } } })).toMatch(/centroid/);
    const mesh: MeasureResult = { tier: "mesh", kind: "face-face", frame: "part", method: "axis-to-axis", distance: 16.003, tolerance: { mm: 0.01, basis: [] } };
    const exact: MeasureResult = { tier: "exact", kind: "face-face", frame: "part", method: "axis-to-axis", distance: 16, tolerance: { mm: 0, basis: [] } };
    const c = compareTiers(mesh, exact);
    expect(c).toHaveLength(1);
    expect(c[0].difference).toBeCloseTo(0.003, 9);
    expect(c[0].withinTolerance).toBe(true);
  });
});
