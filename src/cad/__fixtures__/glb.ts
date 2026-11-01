/**
 * Hand-made GLB fixtures for the renderer tests (PB-1175), built in memory so
 * the bytes are reviewable as code: a few boxes, node extras
 * (`extras.protoboard.partInstanceId`, `placeholder`), an optional
 * `_FEATURE_ID_0` attribute, and the view sidecar JSON that goes with them.
 * Units as glTF: metres, Y up.
 */

export interface FixtureMesh {
  /** Box half-size (m) and centre. */
  half: [number, number, number];
  centre?: [number, number, number];
  /** One feature id per box face (6), written as `_FEATURE_ID_0` on its vertices. */
  featureIds?: number[];
}

export interface FixtureNode {
  name: string;
  mesh?: number;
  translation?: [number, number, number];
  extras?: Record<string, unknown>;
  children?: number[];
  /** GPU instances of the node's mesh (EXT_mesh_gpu_instancing), by translation (m). */
  instances?: [number, number, number][];
}

export interface FixtureSpec {
  meshes: FixtureMesh[];
  nodes: FixtureNode[];
  /** Root node indices of the scene. */
  scene: number[];
  extensionsRequired?: string[];
  /** A string written into the asset's generator (so two fixtures with equal geometry differ in bytes). */
  generator?: string;
}

/** A box as 24 vertices (4 per face, so each face can carry its own feature id) and 12 triangles, faces in the order +x -x +y -y +z -z. */
function box(half: [number, number, number], centre: [number, number, number] = [0, 0, 0]) {
  const [hx, hy, hz] = half;
  const [cx, cy, cz] = centre;
  const faces: { n: [number, number, number]; corners: [number, number, number][] }[] = [
    { n: [1, 0, 0], corners: [[hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz], [hx, -hy, hz]] },
    { n: [-1, 0, 0], corners: [[-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz], [-hx, -hy, -hz]] },
    { n: [0, 1, 0], corners: [[-hx, hy, -hz], [-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz]] },
    { n: [0, -1, 0], corners: [[-hx, -hy, hz], [-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz]] },
    { n: [0, 0, 1], corners: [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]] },
    { n: [0, 0, -1], corners: [[-hx, hy, -hz], [hx, hy, -hz], [hx, -hy, -hz], [-hx, -hy, -hz]] },
  ];
  const position: number[] = [];
  const normal: number[] = [];
  const index: number[] = [];
  faces.forEach((f, i) => {
    for (const c of f.corners) {
      position.push(c[0] + cx, c[1] + cy, c[2] + cz);
      normal.push(...f.n);
    }
    const b = i * 4;
    index.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  return { position, normal, index };
}

const pad4 = (n: number) => (n + 3) & ~3;

/** The GLB bytes for a spec. */
export function makeGlb(spec: FixtureSpec): ArrayBuffer {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const bufferViews: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];
  const add = (data: Float32Array | Uint16Array, target: number, accessor: Record<string, unknown>) => {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const padded = new Uint8Array(pad4(bytes.byteLength));
    padded.set(bytes);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, target });
    offset += padded.byteLength;
    chunks.push(padded);
    accessors.push({ bufferView: bufferViews.length - 1, ...accessor });
    return accessors.length - 1;
  };
  const meshes = spec.meshes.map((m) => {
    const b = box(m.half, m.centre);
    const min = [0, 1, 2].map((k) => Math.min(...b.position.filter((_, i) => i % 3 === k)));
    const max = [0, 1, 2].map((k) => Math.max(...b.position.filter((_, i) => i % 3 === k)));
    const attributes: Record<string, number> = {
      POSITION: add(new Float32Array(b.position), 34962, { componentType: 5126, count: 24, type: "VEC3", min, max }),
      NORMAL: add(new Float32Array(b.normal), 34962, { componentType: 5126, count: 24, type: "VEC3" }),
    };
    if (m.featureIds) {
      const ids = new Float32Array(24);
      for (let v = 0; v < 24; v++) ids[v] = m.featureIds[Math.floor(v / 4)];
      attributes._FEATURE_ID_0 = add(ids, 34962, { componentType: 5126, count: 24, type: "SCALAR" });
    }
    const indices = add(new Uint16Array(b.index), 34963, { componentType: 5123, count: 36, type: "SCALAR" });
    return { primitives: [{ attributes, indices, mode: 4 }] };
  });
  const instancing = spec.nodes.some((n) => n.instances);
  const nodeExtensions = spec.nodes.map((n) =>
    n.instances ? { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: add(new Float32Array(n.instances.flat()), 34962, { componentType: 5126, count: n.instances.length, type: "VEC3" }) } } } : undefined,
  );
  const used = [...(spec.extensionsRequired ?? []), ...(instancing ? ["EXT_mesh_gpu_instancing"] : [])];
  const json = {
    asset: { version: "2.0", generator: spec.generator ?? "uhd-viewer test fixture" },
    ...(used.length ? { extensionsUsed: used } : {}),
    ...(spec.extensionsRequired ? { extensionsRequired: spec.extensionsRequired } : {}),
    scene: 0,
    scenes: [{ nodes: spec.scene }],
    nodes: spec.nodes.map((n, i) => ({
      name: n.name,
      ...(n.mesh !== undefined ? { mesh: n.mesh } : {}),
      ...(n.translation ? { translation: n.translation } : {}),
      ...(n.extras ? { extras: n.extras } : {}),
      ...(n.children ? { children: n.children } : {}),
      ...(nodeExtensions[i] ? { extensions: nodeExtensions[i] } : {}),
    })),
    meshes,
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }],
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadded = new Uint8Array(pad4(jsonBytes.byteLength)).fill(0x20);
  jsonPadded.set(jsonBytes);
  const bin = new Uint8Array(offset);
  let at = 0;
  for (const c of chunks) {
    bin.set(c, at);
    at += c.byteLength;
  }
  const total = 12 + 8 + jsonPadded.byteLength + 8 + bin.byteLength;
  const out = new ArrayBuffer(total);
  const view = new DataView(out);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonPadded.byteLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(out, 20, jsonPadded.byteLength).set(jsonPadded);
  view.setUint32(20 + jsonPadded.byteLength, bin.byteLength, true);
  view.setUint32(24 + jsonPadded.byteLength, 0x004e4942, true);
  new Uint8Array(out, 28 + jsonPadded.byteLength, bin.byteLength).set(bin);
  return out;
}

/**
 * A small board: two components (`U3`, `R1`) on a plate, by instance path in
 * their extras, plus a placeholder box. The "view" variant merges U3 and R1
 * into one mesh whose faces carry feature ids 0..5 (U3) and 6..11 (R1).
 */
export const BOARD: FixtureSpec = {
  meshes: [{ half: [0.02, 0.0008, 0.015] }, { half: [0.0025, 0.0005, 0.0025] }, { half: [0.001, 0.0003, 0.0005] }, { half: [0.003, 0.003, 0.003] }],
  nodes: [
    { name: "board", children: [1, 2, 3, 4] },
    { name: "plate", mesh: 0, extras: { protoboard: { partInstanceId: "pcb" } } },
    { name: "U3", mesh: 1, translation: [0.005, 0.0013, 0], extras: { protoboard: { partInstanceId: "U3" } } },
    { name: "R1", mesh: 2, translation: [-0.008, 0.0011, 0.004], extras: { protoboard: { partInstanceId: "R1" } } },
    { name: "J1", mesh: 3, translation: [-0.015, 0.004, -0.01], extras: { protoboard: { partInstanceId: "J1", placeholder: true } } },
  ],
  scene: [0],
};

export const BOARD_VIEW: FixtureSpec = {
  meshes: [{ half: [0.02, 0.0008, 0.015] }, { half: [0.0025, 0.0005, 0.0025], centre: [0.005, 0.0013, 0], featureIds: [0, 1, 2, 3, 4, 5] }, { half: [0.001, 0.0003, 0.0005] }],
  nodes: [
    { name: "board", children: [1, 2, 3] },
    { name: "plate", mesh: 0, extras: { protoboard: { partInstanceId: "" } } },
    { name: "U3", mesh: 1, extras: { protoboard: { partInstanceId: "U3" } } },
    // two resistors as GPU instances of one mesh: the instance paths are per instance
    { name: "R", mesh: 2, instances: [[-0.008, 0.0011, 0.004], [-0.008, 0.0011, -0.004]], extras: { protoboard: { instances: ["R1", "R2"] } } },
  ],
  scene: [0],
  generator: "uhd-viewer test fixture (view sidecar)",
};

/** Six faces of a box, two triangles each, as v0 flattened `[feature, firstTriangle, triangleCount]` triples. */
const boxFaces = (base = 0) => [0, 1, 2, 3, 4, 5].flatMap((f) => [base + f, f * 2, 2]);

/** The v0 sidecar JSON for BOARD_VIEW (`protoboard.view-sidecar/v0`, as packages/core/src/view-model writes it). */
export function boardSidecar(hash: string, sourceBytes?: number) {
  return {
    schema: "protoboard.view-sidecar/v0",
    pipeline: 1,
    idScope: "relative-to-owner",
    source: { file: "body.glb", sha256: "0".repeat(64), ...(sourceBytes !== undefined ? { bytes: sourceBytes } : {}) },
    tiers: { fine: { file: "body.view.glb", sha256: hash, bytes: 0, draws: 3, triangles: 36, method: "merged" } },
    nodes: [
      // the owner's own plate: faces numbered 100.. to tell the table from the attribute
      { id: ".", instancePath: "", node: 1, bounds: { min: [-0.02, -0.0008, -0.015], max: [0.02, 0.0008, 0.015] }, tier: "fine", featureCount: 6, faces: [boxFaces(100)] },
      { id: "U3", instancePath: "U3", node: 2, bounds: { min: [0.0025, 0.0008, -0.0025], max: [0.0075, 0.0018, 0.0025] }, tier: "fine", featureCount: 6, faces: [boxFaces()] },
      { id: "R1", instancePath: "R1", node: 3, instance: 0, bounds: { min: [-0.009, 0.0008, 0.0035], max: [-0.007, 0.0014, 0.0045] }, faces: [boxFaces()] },
      { id: "R2", instancePath: "R2", node: 3, instance: 1, placeholder: true, bounds: { min: [-0.009, 0.0008, -0.0045], max: [-0.007, 0.0014, -0.0035] }, faces: [boxFaces()] },
    ],
  };
}
