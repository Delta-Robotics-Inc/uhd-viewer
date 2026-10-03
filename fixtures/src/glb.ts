/**
 * A minimal glTF 2.0 binary writer for the hand-made sample outputs: boxes
 * and cylinders in CAD millimetres (Z up), each a named node with its own
 * colour. Enough to stand in for a provider's board.glb and body.glb until
 * the real providers write them. Not a general exporter.
 *
 * Coordinates: glTF is metres and Y up; the viewer turns a GLB back into CAD
 * coordinates by rotating +90° about X and scaling ×1000 (src/cad/scene.ts,
 * cadWrapper), so a CAD point (X, Y, Z) mm is written as (X, Z, −Y) / 1000.
 */

export type Vec3 = [number, number, number];
export type Rgba = [number, number, number, number];

export interface Solid {
  /** Triangle soup in CAD millimetres: positions, normals, indices. */
  positions: number[];
  normals: number[];
  indices: number[];
}

/** An axis-aligned box from `min` to `max` (mm). */
export function box(min: Vec3, max: Vec3): Solid {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const faces: { n: Vec3; c: Vec3[] }[] = [
    { n: [1, 0, 0], c: [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]] },
    { n: [-1, 0, 0], c: [[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]] },
    { n: [0, 1, 0], c: [[x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]] },
    { n: [0, -1, 0], c: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]] },
    { n: [0, 0, 1], c: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]] },
    { n: [0, 0, -1], c: [[x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]] },
  ];
  const out: Solid = { positions: [], normals: [], indices: [] };
  for (const f of faces) {
    const base = out.positions.length / 3;
    for (const c of f.c) {
      out.positions.push(...c);
      out.normals.push(...f.n);
    }
    out.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return out;
}

/** A cylinder along Z: centre of its base at `base`, radius and height in mm. */
export function cylinder(base: Vec3, radius: number, height: number, segments = 24): Solid {
  const out: Solid = { positions: [], normals: [], indices: [] };
  const [cx, cy, z0] = base;
  const z1 = z0 + height;
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const [c, s] = [Math.cos(a), Math.sin(a)];
    out.positions.push(cx + c * radius, cy + s * radius, z0, cx + c * radius, cy + s * radius, z1);
    out.normals.push(c, s, 0, c, s, 0);
  }
  for (let i = 0; i < segments; i++) {
    const k = i * 2;
    out.indices.push(k, k + 2, k + 3, k, k + 3, k + 1);
  }
  for (const [z, nz] of [[z0, -1], [z1, 1]] as const) {
    const centre = out.positions.length / 3;
    out.positions.push(cx, cy, z);
    out.normals.push(0, 0, nz);
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      out.positions.push(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius, z);
      out.normals.push(0, 0, nz);
    }
    for (let i = 0; i < segments; i++) {
      if (nz > 0) out.indices.push(centre, centre + 1 + i, centre + 2 + i);
      else out.indices.push(centre, centre + 2 + i, centre + 1 + i);
    }
  }
  return out;
}

/** Several solids as one mesh. */
export function merge(...solids: Solid[]): Solid {
  const out: Solid = { positions: [], normals: [], indices: [] };
  for (const s of solids) {
    const base = out.positions.length / 3;
    out.positions.push(...s.positions);
    out.normals.push(...s.normals);
    out.indices.push(...s.indices.map((i) => i + base));
  }
  return out;
}

export interface GlbNode {
  /** Node name: what the manifest's features and the viewer's highlights refer to. */
  name: string;
  solid: Solid;
  color: Rgba;
  metallic?: number;
  roughness?: number;
}

const pad4 = (n: number) => (4 - (n % 4)) % 4;

/** One GLB with a node per entry, all children of one root node named `root`. */
export function writeGlb(root: string, nodes: GlbNode[], generator = "uhd-viewer sample fixture (hand-made)"): Uint8Array {
  const chunks: Buffer[] = [];
  let offset = 0;
  const bufferViews: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];
  const add = (data: Buffer, target: number) => {
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length, target });
    chunks.push(data, Buffer.alloc(pad4(data.length)));
    offset += data.length + pad4(data.length);
    return bufferViews.length - 1;
  };
  const meshes: Record<string, unknown>[] = [];
  const materials: Record<string, unknown>[] = [];
  const gltfNodes: Record<string, unknown>[] = [];
  for (const n of nodes) {
    // CAD mm (Z up) → glTF m (Y up)
    const pos = new Float32Array(n.solid.positions.length);
    const nor = new Float32Array(n.solid.normals.length);
    for (let i = 0; i < pos.length; i += 3) {
      const [x, y, z] = [n.solid.positions[i], n.solid.positions[i + 1], n.solid.positions[i + 2]];
      pos.set([x / 1000, z / 1000, -y / 1000], i);
      const [a, b, c] = [n.solid.normals[i], n.solid.normals[i + 1], n.solid.normals[i + 2]];
      nor.set([a, c, -b], i);
    }
    const idx = new Uint32Array(n.solid.indices);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], pos[i + k]);
        max[k] = Math.max(max[k], pos[i + k]);
      }
    }
    const vPos = add(Buffer.from(pos.buffer), 34962);
    accessors.push({ bufferView: vPos, componentType: 5126, count: pos.length / 3, type: "VEC3", min, max });
    const aPos = accessors.length - 1;
    const vNor = add(Buffer.from(nor.buffer), 34962);
    accessors.push({ bufferView: vNor, componentType: 5126, count: nor.length / 3, type: "VEC3" });
    const aNor = accessors.length - 1;
    const vIdx = add(Buffer.from(idx.buffer), 34963);
    accessors.push({ bufferView: vIdx, componentType: 5125, count: idx.length, type: "SCALAR" });
    const aIdx = accessors.length - 1;
    materials.push({ name: n.name, pbrMetallicRoughness: { baseColorFactor: n.color, metallicFactor: n.metallic ?? 0, roughnessFactor: n.roughness ?? 0.6 } });
    meshes.push({ name: n.name, primitives: [{ attributes: { POSITION: aPos, NORMAL: aNor }, indices: aIdx, material: materials.length - 1 }] });
    gltfNodes.push({ name: n.name, mesh: meshes.length - 1 });
  }
  gltfNodes.push({ name: root, children: nodes.map((_, i) => i) });
  const bin = Buffer.concat(chunks);
  const json = {
    asset: { version: "2.0", generator },
    scene: 0,
    scenes: [{ nodes: [gltfNodes.length - 1] }],
    nodes: gltfNodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.length }],
  };
  const jsonBuf = Buffer.from(JSON.stringify(json), "utf8");
  const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc(pad4(jsonBuf.length), 0x20)]);
  const total = 12 + 8 + jsonChunk.length + 8 + bin.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // "glTF"
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jsonChunk.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4); // "JSON"
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.writeUInt32LE(0x004e4942, 4); // "BIN\0"
  return new Uint8Array(Buffer.concat([header, jh, jsonChunk, bh, bin]));
}

/** Binary STL of the solids (mm), for the print exports. */
export function writeStl(name: string, solids: Solid[]): Uint8Array {
  const tris: number[][] = [];
  for (const s of solids) {
    for (let i = 0; i < s.indices.length; i += 3) {
      const v = [0, 1, 2].map((k) => s.indices[i + k] * 3).map((j) => [s.positions[j], s.positions[j + 1], s.positions[j + 2]]);
      const u = [v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]];
      const w = [v[2][0] - v[0][0], v[2][1] - v[0][1], v[2][2] - v[0][2]];
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const l = Math.hypot(n[0], n[1], n[2]) || 1;
      tris.push([n[0] / l, n[1] / l, n[2] / l, ...v.flat()]);
    }
  }
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.write(`${name} (sample, hand-made)`.slice(0, 80), 0, "ascii");
  buf.writeUInt32LE(tris.length, 80);
  tris.forEach((t, i) => {
    t.forEach((x, k) => buf.writeFloatLE(x, 84 + i * 50 + k * 4));
  });
  return new Uint8Array(buf);
}
