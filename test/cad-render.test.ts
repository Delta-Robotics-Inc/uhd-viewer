/**
 * The 3D view's renderer core (PB-1175), in node: the on-demand frame loop
 * (no frame while idle), the content-hash GLB cache with the view-sidecar
 * fallback, ids (instance paths, faces, feature ids), shared materials and
 * instancing with highlight as an attribute, BVH picking that skips hidden
 * and clipped geometry, and the state a hot swap must keep.
 */
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { createFrameLoop, type FrameInfo } from "../src/cad/render/loop";
import { createGlbCache, checkGlb, contentHash, fnv1a64, type FetchResponse, type Fetcher } from "../src/cad/render/glbCache";
import { faceAt, normaliseSidecar, sidecarStale, sidecarUrls } from "../src/cad/render/sidecar";
import { featureIdAt, idsAt, instancePathIn, isPlaceholder, partInstanceIdOf } from "../src/cad/render/ids";
import { Batcher, LOGICAL_LAYER, isBatchable } from "../src/cad/render/batch";
import { buildAll, pick } from "../src/cad/render/pick";
import { setMeshLook, variantOf } from "../src/cad/render/looks";
import { onGlbLoad } from "../src/cad/render/events";
import { observeScene } from "../src/cad/render/observe";
import { BOARD, BOARD_VIEW, boardSidecar, makeGlb } from "../src/cad/__fixtures__/glb";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** A fake animation-frame queue: frames run only when the test steps time. */
function fakeFrames() {
  let t = 0;
  let next = 1;
  const queue = new Map<number, (t: number) => void>();
  return {
    raf: (cb: (t: number) => void) => {
      const id = next++;
      queue.set(id, cb);
      return id;
    },
    caf: (id: number) => void queue.delete(id),
    now: () => t,
    /** Advance n display refreshes of 16 ms, running what was scheduled. */
    step(n = 1) {
      for (let i = 0; i < n; i++) {
        t += 16;
        const due = [...queue.values()];
        queue.clear();
        for (const cb of due) cb(t);
      }
    },
    get scheduled() {
      return queue.size;
    },
  };
}

/** A fetch over an in-memory file map (keys are URLs). HEAD answers with the length only. */
function memoryFetch(files: Map<string, ArrayBuffer | string>, log: string[] = []): Fetcher {
  return async (url, init) => {
    log.push(`${init?.method ?? "GET"} ${url}`);
    const body = files.get(url);
    const bytes = body === undefined ? undefined : typeof body === "string" ? new TextEncoder().encode(body).buffer : body;
    const res: FetchResponse = {
      ok: bytes !== undefined,
      status: bytes !== undefined ? 200 : 404,
      headers: { get: (n) => (n.toLowerCase() === "content-length" && bytes ? String(bytes.byteLength) : null) },
      arrayBuffer: async () => bytes!.slice(0),
      text: async () => new TextDecoder().decode(bytes!),
    };
    return res;
  };
}

const loader = new GLTFLoader();
const parse = (data: ArrayBuffer, path: string) => loader.parseAsync(data, path);

const meshNamed = (root: THREE.Object3D, name: string) => {
  let out: THREE.Mesh | undefined;
  root.traverse((o) => {
    if (!out && o.name === name && (o as THREE.Mesh).isMesh) out = o as THREE.Mesh;
  });
  return out!;
};

// ---------------------------------------------------------------------------
// render on demand
// ---------------------------------------------------------------------------

describe("render on demand", () => {
  it("draws one frame per burst of changes and none while idle", () => {
    const f = fakeFrames();
    const frame = vi.fn((_info: FrameInfo) => false);
    const loop = createFrameLoop({ frame, raf: f.raf, caf: f.caf, now: f.now });
    // nothing asked: nothing drawn, nothing scheduled, for a long idle stretch
    f.step(600);
    expect(frame).toHaveBeenCalledTimes(0);
    expect(f.scheduled).toBe(0);
    // ten changes before the next refresh: one frame
    for (let i = 0; i < 10; i++) loop.invalidate(i % 2 ? "view" : "scene");
    f.step(1);
    expect(frame).toHaveBeenCalledTimes(1);
    expect(frame.mock.calls[0][0]).toMatchObject({ scene: true });
    // and then idle again: ten seconds of refreshes, no frame, no scheduled callback
    f.step(600);
    expect(frame).toHaveBeenCalledTimes(1);
    expect(f.scheduled).toBe(0);
    expect(loop.frames).toBe(1);
  });

  it("keeps drawing while a frame says it is animating, then stops", () => {
    const f = fakeFrames();
    let left = 5;
    const frame = vi.fn((_info: FrameInfo) => --left > 0);
    const loop = createFrameLoop({ frame, raf: f.raf, caf: f.caf, now: f.now });
    loop.invalidate("view");
    f.step(100);
    expect(frame).toHaveBeenCalledTimes(5);
    // a camera-only change does not mark the scene changed
    expect(frame.mock.calls[0][0]).toMatchObject({ scene: true }); // the very first frame always syncs
    loop.invalidate("view");
    f.step(1);
    expect(frame.mock.calls.at(-1)![0]).toMatchObject({ scene: false });
    expect(f.scheduled).toBe(0);
  });

  it("steps an ordinary frame after idle, not the idle gap", () => {
    const f = fakeFrames();
    const dts: number[] = [];
    const loop = createFrameLoop({ frame: ({ dt }) => (dts.push(dt), dts.length < 3), raf: f.raf, caf: f.caf, now: f.now });
    f.step(1000);
    loop.invalidate();
    f.step(10);
    expect(dts[0]).toBeCloseTo(1 / 60);
    expect(dts[1]).toBeCloseTo(0.016);
  });

  it("skips scheduled frames while paused (external capture) and draws on flush", () => {
    const f = fakeFrames();
    const frame = vi.fn((_info: FrameInfo) => false);
    const loop = createFrameLoop({ frame, raf: f.raf, caf: f.caf, now: f.now });
    loop.paused = true;
    loop.invalidate();
    f.step(5);
    expect(frame).toHaveBeenCalledTimes(0);
    loop.flush();
    expect(frame).toHaveBeenCalledTimes(1);
    loop.dispose();
    loop.invalidate();
    f.step(5);
    expect(frame).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// sidecar and cache
// ---------------------------------------------------------------------------

describe("view sidecar", () => {
  it("derives X.view.glb and X.view.json beside X.glb, keeping the query", () => {
    expect(sidecarUrls("/artifacts/p/out/body.glb")).toEqual({ glb: "/artifacts/p/out/body.view.glb", json: "/artifacts/p/out/body.view.json" });
    expect(sidecarUrls("http://h/a/body.GLB?v=2#x")).toEqual({ glb: "http://h/a/body.view.glb?v=2#x", json: "http://h/a/body.view.json?v=2#x" });
    expect(sidecarUrls("/a/body.view.glb")).toBeUndefined();
    expect(sidecarUrls("/a/body.step")).toBeUndefined();
    expect(sidecarUrls("data:model/gltf-binary;base64,AAAA.glb")).toBeUndefined();
  });

  it("reads the sidecar in the spellings the exporter may use", () => {
    const a = normaliseSidecar({ output: { sha256: "abcdef0123" }, nodes: { "U3": { node: 4, faces: [{ start: 0, count: 2, face: 9 }] } }, features: ["U3", { partInstanceId: "R1", face: 2 }] })!;
    expect(a.hash).toBe("abcdef0123");
    expect(a.nodes[0]).toMatchObject({ node: 4, instancePath: "U3", faces: [[[0, 2, 9]]] });
    expect(a.features.get(0)).toEqual({ instancePath: "U3" });
    expect(a.features.get(1)).toEqual({ instancePath: "R1", face: 2 });
    expect(normaliseSidecar({ nodes: [] })).toBeUndefined(); // no hash: not usable
    expect(normaliseSidecar("nope")).toBeUndefined();
  });

  it("reads the stack's v0 index: tier hash, relative paths, face triples, GPU instances", () => {
    const v0 = normaliseSidecar(boardSidecar("sha256:view-0001", 1234))!;
    expect(v0.schema).toBe("protoboard.view-sidecar/v0");
    expect(v0.hash).toBe("sha256:view-0001");
    expect(v0.source).toEqual({ sha256: "0".repeat(64), bytes: 1234 });
    // two instances of node 3 become one entry with the paths in instance order
    expect(v0.nodes).toHaveLength(3);
    expect(v0.nodes[2]).toMatchObject({ node: 3, instances: ["R1", "R2"], placeholder: true });
    // [feature, first, count] triples → [first, count, face] ranges
    expect(v0.nodes[0].faces![0].slice(0, 2)).toEqual([
      [0, 2, 100],
      [2, 2, 101],
    ]);
    expect(v0.nodes[0].instancePath).toBe("");
    expect(v0.nodes[0].bounds).toEqual([
      [-0.02, -0.0008, -0.015],
      [0.02, 0.0008, 0.015],
    ]);
  });

  it("finds a triangle's face by binary search", () => {
    const ranges: [number, number, number][] = [
      [0, 2, 100],
      [2, 3, 101],
      [9, 1, 102],
    ];
    expect([0, 1, 2, 4, 5, 9, 10].map((t) => faceAt(ranges, t))).toEqual([100, 100, 101, 101, undefined, 102, undefined]);
  });

  it("is stale when it was made from a GLB of another size", () => {
    const s = normaliseSidecar(boardSidecar("sha256:x0000000", 1000))!;
    expect(sidecarStale(s, 1000)).toBe(false);
    expect(sidecarStale(s, 1001)).toBe(true);
    expect(sidecarStale(s, undefined)).toBe(false);
  });
});

describe("GLB cache keyed by content", () => {
  const glb = makeGlb(BOARD);
  const viewGlb = makeGlb(BOARD_VIEW);

  it("hashes bytes with sha-256 (and FNV-1a where Web Crypto is missing)", async () => {
    expect(await contentHash(new TextEncoder().encode("abc").buffer)).toBe("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    // FNV-1a 64 of "a" is af63dc4c8601ec8c
    expect(fnv1a64(new TextEncoder().encode("a").buffer)).toBe("fnv1a64:af63dc4c8601ec8c");
  });

  it("refuses a required extension it cannot honour", () => {
    expect(() => checkGlb(makeGlb({ ...BOARD, extensionsRequired: ["KHR_draco_mesh_compression"] }))).toThrow(/KHR_draco_mesh_compression/);
    expect(() => checkGlb(makeGlb({ ...BOARD, extensionsRequired: ["KHR_mesh_quantization"] }))).not.toThrow();
    expect(() => checkGlb(new ArrayBuffer(8))).toThrow();
  });

  it("falls back to X.glb when there is no sidecar, keyed by the bytes' hash", async () => {
    const log: string[] = [];
    const cache = createGlbCache({ fetch: memoryFetch(new Map([["/m/body.glb", glb]]), log), parse });
    const m = (await cache.load("/m/body.glb"))!;
    expect(m.source).toBe("glb");
    expect(m.path).toBe("/m/body.glb");
    expect(m.hash).toBe(await contentHash(glb));
    expect(log).toEqual(["GET /m/body.view.json", "GET /m/body.view.glb", "GET /m/body.glb"]);
    // the ids came through: extras land in userData
    expect(partInstanceIdOf(m.gltf.scene.getObjectByName("U3")!)?.id).toBe("U3");
  });

  it("prefers X.view.glb when X.view.json is there, keyed by the sidecar's output hash", async () => {
    const files = new Map<string, ArrayBuffer | string>([
      ["/m/body.glb", glb],
      ["/m/body.view.glb", viewGlb],
      ["/m/body.view.json", JSON.stringify(boardSidecar("sha256:view-0001", glb.byteLength))],
    ]);
    const log: string[] = [];
    const events: string[] = [];
    const off = onGlbLoad((e) => events.push(`${e.source}:${e.hash}:${e.cached}`));
    const cache = createGlbCache({ fetch: memoryFetch(files, log), parse });
    const m = (await cache.load("/m/body.glb"))!;
    off();
    expect(m.source).toBe("sidecar");
    expect(m.hash).toBe("sha256:view-0001");
    expect(m.path).toBe("/m/body.view.glb");
    // the original GLB is only asked for its size (staleness), never downloaded
    expect(log).toEqual(["GET /m/body.view.json", "HEAD /m/body.glb", "GET /m/body.view.glb"]);
    expect(events).toEqual(["sidecar:sha256:view-0001:false"]);
    // the sidecar's index is on the parsed scene: names from the table, faces by key
    const plate = meshNamed(m.gltf.scene, "plate");
    // the owner's own geometry has the empty path: it names no part
    expect(partInstanceIdOf(plate)).toBeUndefined();
    expect(idsAt(plate, 5)).toMatchObject({ face: 102 });
    const u3 = meshNamed(m.gltf.scene, "U3");
    // triangle 0 is on the +x face (feature 0), triangle 4 on +y (feature 2)
    expect(idsAt(u3, 0)).toMatchObject({ feature: 0, partInstanceId: "U3", face: 0 });
    expect(idsAt(u3, 4)).toMatchObject({ feature: 2, partInstanceId: "U3", face: 2 });
    // the GPU-instanced resistors: one InstancedMesh, each instance named
    const r = m.gltf.scene.getObjectByName("R") as THREE.InstancedMesh;
    expect(r.isInstancedMesh).toBe(true);
    expect(r.count).toBe(2);
    expect(idsAt(r, 0, undefined, 1).partInstanceId).toBe("R2");
  });

  it("uses X.glb when the sidecar is stale, missing its GLB, or unreadable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stale = createGlbCache({
      fetch: memoryFetch(new Map<string, ArrayBuffer | string>([["/m/body.glb", glb], ["/m/body.view.glb", viewGlb], ["/m/body.view.json", JSON.stringify(boardSidecar("sha256:view-0001", glb.byteLength + 4))]])),
      parse,
    });
    expect((await stale.load("/m/body.glb"))!.source).toBe("glb");
    const noGlb = createGlbCache({ fetch: memoryFetch(new Map<string, ArrayBuffer | string>([["/m/body.glb", glb], ["/m/body.view.json", JSON.stringify(boardSidecar("sha256:view-0001"))]])), parse });
    expect((await noGlb.load("/m/body.glb"))!.source).toBe("glb");
    const broken = createGlbCache({ fetch: memoryFetch(new Map<string, ArrayBuffer | string>([["/m/body.glb", glb], ["/m/body.view.glb", new ArrayBuffer(16)], ["/m/body.view.json", JSON.stringify(boardSidecar("sha256:view-0002"))]])), parse });
    expect((await broken.load("/m/body.glb"))!.source).toBe("glb");
    const missing = createGlbCache({ fetch: memoryFetch(new Map()), parse });
    expect(await missing.load("/m/body.glb")).toBeNull();
    warn.mockRestore();
  });

  it("parses one content once, whatever the URLs, and re-checks content each generation", async () => {
    const files = new Map<string, ArrayBuffer | string>([
      ["/a/body.glb", glb],
      ["/b/copy.glb", glb.slice(0)],
    ]);
    const parseSpy = vi.fn(parse);
    const cache = createGlbCache({ fetch: memoryFetch(files), parse: parseSpy });
    const [a, b] = await Promise.all([cache.load("/a/body.glb"), cache.load("/b/copy.glb")]);
    expect(a!.gltf).toBe(b!.gltf);
    expect(parseSpy).toHaveBeenCalledTimes(1);
    // the same generation: the URL is not fetched again
    expect(await cache.load("/a/body.glb")).toBe(a);
    // a new generation with unchanged bytes: fetched and hashed again, not parsed again
    cache.beginGeneration();
    const again = (await cache.load("/a/body.glb"))!;
    expect(again.gltf).toBe(a!.gltf);
    expect(parseSpy).toHaveBeenCalledTimes(1);
  });

  it("shows a GLB re-exported to the same path without a reload (the stale-GLB bug)", async () => {
    const files = new Map<string, ArrayBuffer | string>([["/m/body.glb", glb]]);
    const cache = createGlbCache({ fetch: memoryFetch(files), parse });
    const before = (await cache.load("/m/body.glb"))!;
    // the exporter writes new geometry to the same path
    files.set("/m/body.glb", makeGlb({ ...BOARD, meshes: [{ half: [0.03, 0.001, 0.02] }, ...BOARD.meshes.slice(1)] }));
    // same generation: what the view already holds (no surprise swaps mid-frame)
    expect((await cache.load("/m/body.glb"))!.hash).toBe(before.hash);
    // the next generation (a rebuilt bundle, __cad.refresh()) sees the new content
    cache.beginGeneration();
    const after = (await cache.load("/m/body.glb"))!;
    expect(after.hash).not.toBe(before.hash);
    expect(after.gltf).not.toBe(before.gltf);
    const size = new THREE.Box3().setFromObject(meshNamed(after.gltf.scene, "plate")).getSize(new THREE.Vector3());
    expect(size.x).toBeCloseTo(0.06);
    // the old content is dropped once nothing in this generation resolves to it
    expect(cache.size).toBe(2);
    expect(cache.prune()).toBe(1);
    expect(cache.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ids
// ---------------------------------------------------------------------------

describe("ids", () => {
  it("maps a GLB's part ids to instance paths under the body that draws them", () => {
    expect(instancePathIn("controller/board", "U3")).toBe("controller/board/U3");
    expect(instancePathIn("controller/board", "controller/board/U3")).toBe("controller/board/U3");
    expect(instancePathIn("", "U3")).toBe("U3");
  });

  it("reads partInstanceId and placeholder up the tree, stopping at the body", async () => {
    const gltf = await parse(makeGlb(BOARD), "");
    const j1 = meshNamed(gltf.scene, "J1");
    expect(isPlaceholder(j1)).toBe(true);
    expect(isPlaceholder(meshNamed(gltf.scene, "U3"))).toBe(false);
    // a mesh without its own id takes its node's
    const child = new THREE.Mesh(new THREE.BoxGeometry());
    meshNamed(gltf.scene, "R1").add(child);
    expect(partInstanceIdOf(child)?.id).toBe("R1");
    expect(partInstanceIdOf(child, meshNamed(gltf.scene, "R1"))).toBeUndefined();
  });

  it("reads _FEATURE_ID_0 per triangle (indexed geometry)", async () => {
    const gltf = await parse(makeGlb(BOARD_VIEW), "");
    const parts = meshNamed(gltf.scene, "U3");
    expect([0, 1, 2, 3, 10, 11].map((t) => featureIdAt(parts.geometry, t))).toEqual([0, 0, 1, 1, 5, 5]);
    expect(featureIdAt(meshNamed(gltf.scene, "plate").geometry, 0)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// shared materials, instancing, highlight as an attribute
// ---------------------------------------------------------------------------

function boardsScene(n: number) {
  const geometry = new THREE.BoxGeometry(10, 2, 8);
  const grey = new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 0.5 });
  const red = new THREE.MeshStandardMaterial({ color: 0xff0000, roughness: 0.5 });
  const root = new THREE.Group();
  const meshes: THREE.Mesh[] = [];
  for (let i = 0; i < n; i++) {
    const body = new THREE.Group();
    body.userData.key = `b${i}`;
    body.position.set(i * 20, 0, 0);
    const mesh = new THREE.Mesh(geometry, i % 2 ? red : grey);
    mesh.userData.bodyKey = `b${i}`;
    body.add(mesh);
    root.add(body);
    meshes.push(mesh);
  }
  root.updateMatrixWorld(true);
  return { root, meshes, geometry, grey, red };
}

describe("batcher", () => {
  it("draws repeated geometry as one instanced mesh per look, colour per instance", () => {
    const { root, meshes } = boardsScene(6);
    const b = new Batcher();
    const stats = b.sync([root]);
    // two colours, one look: one GPU material and one instanced draw for six meshes
    expect(stats).toMatchObject({ instances: 6, groups: 1, materials: 1, native: 0 });
    const batch = b.root.children[0] as THREE.InstancedMesh;
    expect(batch.isInstancedMesh).toBe(true);
    expect(batch.count).toBe(6);
    const c = new THREE.Color();
    batch.getColorAt(1, c);
    expect(c.getHex()).toBe(0xff0000);
    // logical meshes are no longer drawn by the camera, but stay in the tree for picking and placement
    expect(meshes.every((m) => m.layers.mask === (1 << LOGICAL_LAYER) >>> 0)).toBe(true);
    expect(b.memberAt(batch, 3)).toBe(meshes[3]);
    // the batch's matrix is the mesh's world matrix
    const m = new THREE.Matrix4();
    batch.getMatrixAt(5, m);
    expect(new THREE.Vector3().setFromMatrixPosition(m).x).toBe(100);
  });

  it("selects by an attribute write: no new GPU material, no material clone per mesh", () => {
    const { root, meshes } = boardsScene(6);
    const b = new Batcher();
    b.sync([root]);
    const gpuBefore = new Set(b.materials.all());
    setMeshLook(meshes[2], { emissive: 0x334455 });
    setMeshLook(meshes[4], { emissive: 0x334455 });
    const s = b.sync([root]);
    expect(s.materials).toBe(1);
    expect(new Set(b.materials.all())).toEqual(gpuBefore);
    // both selected meshes share one variant of their (shared) material
    expect(meshes[2].material).toBe(meshes[4].material);
    expect(variantOf(meshes[0].material as THREE.Material, { emissive: 0x334455 })).toBe(meshes[2].material);
    const batch = b.root.children[0] as THREE.InstancedMesh;
    const em = batch.geometry.getAttribute("instanceEmissive") as THREE.InstancedBufferAttribute;
    const expected = new THREE.Color(0x334455);
    expect([em.getX(2), em.getY(2), em.getZ(2)].map((x) => +x.toFixed(4))).toEqual([expected.r, expected.g, expected.b].map((x) => +x.toFixed(4)));
    expect(em.getX(1)).toBe(0);
    // cleared: back to the base material, attribute back to black
    setMeshLook(meshes[2], { emissive: undefined });
    b.sync([root]);
    expect(meshes[2].material).toBe(meshes[2].userData.baseMaterial);
    expect(em.getX(2)).toBe(0);
  });

  it("leaves hidden meshes out and draws x-ray as its own see-through look", () => {
    const { root, meshes } = boardsScene(4);
    const b = new Batcher({ minInstances: 1 });
    (root.children[1] as THREE.Group).visible = false;
    setMeshLook(meshes[3], { xray: true });
    const s = b.sync([root]);
    expect(s.instances).toBe(3);
    expect(s.groups).toBe(2);
    const see = b.root.children.map((c) => (c as THREE.InstancedMesh).material as THREE.MeshStandardMaterial).find((m) => m.transparent)!;
    expect(see.opacity).toBeCloseTo(0.22);
    expect(see.depthWrite).toBe(false);
  });

  it("draws other kinds as themselves, and says which subtrees it fully covers", () => {
    const { root } = boardsScene(2);
    const gizmo = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial());
    (root.children[0] as THREE.Group).add(gizmo);
    const basic = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    (root.children[1] as THREE.Group).add(basic);
    const b = new Batcher();
    const s = b.sync([root]);
    expect(isBatchable(basic)).toBe(false);
    expect(s.native).toBe(1);
    expect(basic.layers.mask).toBe(1); // still on the camera's layer
    expect(b.pure).toEqual([]);
    (root.children[0] as THREE.Group).remove(gizmo);
    (root.children[1] as THREE.Group).remove(basic);
    b.sync([root]);
    expect(b.pure).toEqual(root.children);
  });

  it("draws a look with a single mesh as itself (no instance buffers for one draw)", () => {
    const { root, meshes } = boardsScene(3);
    setMeshLook(meshes[0], { xray: true });
    const b = new Batcher();
    const s = b.sync([root]);
    expect(s).toMatchObject({ instances: 2, groups: 1, native: 1 });
    expect(meshes[0].layers.mask).toBe(1);
    expect(meshes[1].layers.mask).toBe((1 << LOGICAL_LAYER) >>> 0);
    // its body is walked by the renderer; the others are not
    expect(b.pure).toEqual([root.children[1], root.children[2]]);
  });

  it("keeps the shared buffers when a batch goes away", () => {
    const { root, geometry, meshes } = boardsScene(3);
    const b = new Batcher();
    b.sync([root]);
    const disposed = vi.fn();
    geometry.addEventListener("dispose", disposed);
    for (const m of meshes) m.visible = false;
    expect(b.sync([root]).groups).toBe(0);
    expect(disposed).not.toHaveBeenCalled();
    expect(geometry.getAttribute("position")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// picking
// ---------------------------------------------------------------------------

describe("BVH picking", () => {
  const down = (x: number, y: number) => new THREE.Ray(new THREE.Vector3(x, y, 100), new THREE.Vector3(0, 0, -1));

  async function board() {
    const gltf = await parse(makeGlb(BOARD), "");
    // glTF m, Y up → mm, Z up, as the view wraps it
    const w = new THREE.Group();
    w.rotation.x = Math.PI / 2;
    w.scale.setScalar(1000);
    w.add(gltf.scene);
    const body = new THREE.Group();
    body.userData.key = "controller/board";
    body.add(w);
    body.traverse((o) => (o as THREE.Mesh).isMesh && (o.userData.bodyKey = "controller/board"));
    const root = new THREE.Group();
    root.add(body);
    root.updateMatrixWorld(true);
    return { root, body, scene: gltf.scene };
  }

  it("hits the nearest part and names it by instance path", async () => {
    const { root, body } = await board();
    // U3 sits at x 5 mm, z (glTF y) 1.3 mm above the plate's centre
    const hit = pick(down(5, 0), [root], { stop: () => body })!;
    expect(hit.partInstanceId).toBe("U3");
    expect(instancePathIn("controller/board", hit.partInstanceId!)).toBe("controller/board/U3");
    expect(hit.point.z).toBeCloseTo(1.8, 3);
    // beside the parts: the plate
    expect(pick(down(15, 10), [root])!.partInstanceId).toBe("pcb");
    expect(pick(down(500, 500), [root])).toBeUndefined();
  });

  it("skips hidden geometry and what a section cuts away", async () => {
    const { root, scene } = await board();
    meshNamed(scene, "U3").visible = false;
    expect(pick(down(5, 0), [root])!.partInstanceId).toBe("pcb");
    meshNamed(scene, "U3").visible = true;
    // keep z ≤ 1.0 (the plate's top is 0.8, U3's top 1.8): U3's top is cut away, its inside shows the plate
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 1.0);
    const hit = pick(down(5, 0), [root], { clippingPlanes: [plane] })!;
    expect(hit.point.z).toBeLessThanOrEqual(1.0 + 1e-6);
  });

  it("leaves the geometry's triangle order alone (face tables stay valid)", async () => {
    const { root, scene } = await board();
    const plate = meshNamed(scene, "plate");
    const before = Array.from(plate.geometry.index!.array);
    const built = buildAll([root]);
    expect(built.geometries).toBe(4);
    expect(Array.from(plate.geometry.index!.array)).toEqual(before);
    // +z in the view is glTF +y: the plate's +y face is triangles 4 and 5
    const hit = pick(down(15, 10), [root])!;
    expect([4, 5]).toContain(hit.triangle);
  });

  it("picks an instance of a GPU-instanced node and names it by its own path", async () => {
    const gltf = await parse(makeGlb(BOARD_VIEW), "");
    const w = new THREE.Group();
    w.rotation.x = Math.PI / 2;
    w.scale.setScalar(1000);
    w.add(gltf.scene);
    const root = new THREE.Group();
    root.add(w);
    root.updateMatrixWorld(true);
    // the batcher keeps the GLB's InstancedMesh, with a shared material and the per-instance attributes
    const b = new Batcher();
    const s = b.sync([root]);
    // the instanced resistors, and the plate and U3 (one mesh per look: drawn as themselves)
    expect(s.native).toBe(3);
    const r = gltf.scene.getObjectByName("R") as THREE.InstancedMesh;
    expect(r.geometry.getAttribute("instanceEmissive")).toBeDefined();
    expect(b.materials.all()).toContain(r.material);
    // R2 sits at glTF z -4 mm, i.e. view y +4 mm (Y up → Z up turns glTF z into -y)
    const hit = pick(down(-8, 4), [root])!;
    expect(hit.instance).toBe(1);
    expect(hit.partInstanceId).toBe("R2");
    expect(pick(down(-8, -4), [root])!.partInstanceId).toBe("R1");
  });

  it("picks the logical meshes the batcher draws (they sit on the hidden layer)", async () => {
    const { root, body } = await board();
    new Batcher().sync([root]);
    expect(pick(down(5, 0), [root], { stop: () => body })!.partInstanceId).toBe("U3");
  });
});

// ---------------------------------------------------------------------------
// hot swap: what a swap must keep
// ---------------------------------------------------------------------------

describe("hot swap by instance path", () => {
  it("replaces one body's objects and keeps the others' placement, explode offset and highlight", () => {
    const { root, meshes } = boardsScene(3);
    const b = new Batcher({ minInstances: 1 });
    // body 0 exploded 12 mm up, body 1 selected
    const bodies = root.children as THREE.Group[];
    bodies[0].position.z = 12;
    setMeshLook(meshes[1], { emissive: 0x112233 });
    root.updateMatrixWorld(true);
    b.sync([root]);
    // body 2's content changed: a new object in its place (same key), the others untouched
    const fresh = new THREE.Group();
    fresh.userData.key = "b2";
    fresh.position.copy(bodies[2].position);
    const newMesh = new THREE.Mesh(new THREE.BoxGeometry(12, 3, 9), meshes[0].userData.baseMaterial ?? meshes[0].material);
    newMesh.userData.bodyKey = "b2";
    fresh.add(newMesh);
    const kept = [bodies[0], bodies[1]];
    root.remove(bodies[2]);
    root.add(fresh);
    root.updateMatrixWorld(true);
    const s = b.sync([root]);
    expect(s.instances).toBe(3);
    expect(root.children.slice(0, 2)).toEqual(kept);
    const inst = b.root.children.find((c) => (c as THREE.InstancedMesh).count === 2) as THREE.InstancedMesh;
    const m = new THREE.Matrix4();
    inst.getMatrixAt(0, m);
    expect(new THREE.Vector3().setFromMatrixPosition(m).z).toBe(12);
    const em = inst.geometry.getAttribute("instanceEmissive") as THREE.InstancedBufferAttribute;
    expect(em.getX(1)).toBeGreaterThan(0);
    // the observation reports the swapped body where it is, by instance path
    const camera = new THREE.PerspectiveCamera();
    const obs = observeScene({
      seq: 7,
      bodies: root.children.map((o) => ({ key: o.userData.key, obj: o, hasModel: true })),
      harnesses: [],
      selection: { body: "b1" },
      camera,
      target: new THREE.Vector3(),
      counts: { draws: 2, triangles: 36, frames: 7 },
      loading: { phase: "ready", total: 3, done: 3, failed: 0, bytes: 0, swapped: 1, kept: 2, started: 0, ms: 0 },
    });
    expect(obs.nodes.map((n) => n.id)).toEqual(["b0", "b1", "b2"]);
    expect(obs.nodes[0].bounds![0][2]).toBeCloseTo(8);
    expect(obs.nodes[2].bounds![1][0]).toBeCloseTo(46);
    expect(obs.selection).toEqual({ body: "b1" });
  });
});
