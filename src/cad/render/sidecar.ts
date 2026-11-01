/**
 * The view sidecar (phase 1 interface between W1-A, the export, and W1-C, this
 * viewer): for an artifact `X.glb` the build may write `X.view.glb` (merged,
 * instanced, quantized, meshopt), `X.view.coarse.glb` and `X.view.json` (the
 * scene index, schema `protoboard.view-sidecar/v0`, written by the stack's
 * `packages/core/src/view-model/`). The original `X.glb` stays untouched; the
 * viewer prefers the sidecar and falls back to `X.glb` when it is missing,
 * unreadable or stale.
 *
 * What is read from v0 (everything in the GLB's own frame, metres, Y up):
 * - `tiers.fine.sha256`: the content hash of `X.view.glb`, the cache key;
 * - `source.bytes` (and `sha256`): the `X.glb` it was made from;
 * - `nodes[]`: `node` (index in `X.view.glb`), `instance` (for a GPU-instanced
 *   node), `instancePath` (relative to the GLB's owner, "" = the owner),
 *   `placeholder`, `bounds {min, max}`, and `faces`: per primitive of the
 *   node's mesh, flattened `[feature, firstTriangle, triangleCount]` triples.
 *   A feature is the source primitive (B-rep face) index within the part,
 *   also carried per vertex as `_FEATURE_ID_0`.
 *
 * The reader is tolerant: a top-level `hash`, nodes keyed by path, and
 * `{feature|face, start, count}` objects are accepted too, so the hand-made
 * fixtures and a later schema revision read the same way.
 */

/** `[firstTriangle, triangleCount, face]`: a run of triangles of one primitive that came from one B-rep face. */
export type FaceRange = [start: number, count: number, face: number];

export interface ViewSidecarNode {
  /** glTF node index in `X.view.glb`. */
  node?: number;
  /** glTF node name (used when no index is given). */
  name?: string;
  /** UHD instance path relative to the GLB's owner ("" = the owner); `extras.protoboard.partInstanceId` carries the same. */
  instancePath?: string;
  /** A stand-in box, not the part's real shape. */
  placeholder?: boolean;
  /** Bounds in the GLB's own space (metres, Y up): [[min], [max]]. */
  bounds?: [[number, number, number], [number, number, number]];
  /** Face ranges, sorted by start, per primitive of the node's mesh (index = primitive). */
  faces?: FaceRange[][];
  /** For a GPU-instanced node (EXT_mesh_gpu_instancing): the instance path of each instance, by instance index. */
  instances?: string[];
}

export interface ViewSidecarFeature {
  instancePath?: string;
  face?: number;
}

export interface ViewSidecar {
  schema?: string;
  /** Content hash of `X.view.glb` (the cache key). */
  hash: string;
  /** What the sidecar was made from: the original GLB's digest and size (a different size means the sidecar is stale). */
  source?: { sha256?: string; bytes?: number };
  nodes: ViewSidecarNode[];
  /** `_FEATURE_ID_0` value → what it names, when a file numbers features across parts (v0 numbers them within each part: empty). */
  features: Map<number, ViewSidecarFeature>;
  /**
   * Materials the original `X.glb` had (v0 `counts.before.materials`). The viewer colours a body
   * from the part's appearance unless the original brought colours of its own; the sidecar always
   * has materials (merged per material), so this is what decides.
   */
  sourceMaterials?: number;
  /**
   * The sidecar keeps every node of the original that the geometry manifest names (its `root` entry is there:
   * W1-A's named-node build, phase-1 progress.md). A manifest name missing from such a sidecar is missing from
   * the original too (a feature that is a face set or a frame, not a node), so it is no reason to load `X.glb`.
   */
  keepsNamedNodes?: boolean;
}

/** Size caps (security basics: a parsed file never exceeds these). */
export const MAX_GLB_BYTES = 512 * 1024 * 1024;
export const MAX_SIDECAR_JSON_BYTES = 64 * 1024 * 1024;

/** Whether a URL names a `.glb` (before any query or hash) and is not already a sidecar. */
export function isPlainGlbUrl(url: string): boolean {
  const path = url.split(/[?#]/)[0];
  return /\.glb$/i.test(path) && !/\.view(\.coarse)?\.glb$/i.test(path) && !/^(data|blob):/i.test(url);
}

/** The sidecar URLs for `X.glb`: `X.view.glb` and `X.view.json`, with the same query and hash. */
export function sidecarUrls(url: string): { glb: string; json: string } | undefined {
  if (!isPlainGlbUrl(url)) return undefined;
  const m = /^([^?#]*?)\.glb([?#].*)?$/i.exec(url);
  if (!m) return undefined;
  const rest = m[2] ?? "";
  return { glb: `${m[1]}.view.glb${rest}`, json: `${m[1]}.view.json${rest}` };
}

const vec3 = (v: unknown): [number, number, number] | undefined =>
  Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x)) ? (v as [number, number, number]) : undefined;

const isInt = (x: unknown): x is number => Number.isInteger(x);

/** One primitive's ranges: flattened `[feature, first, count]` triples (v0), or `{feature|face, start, count}` objects. */
function faceRanges(raw: unknown): FaceRange[] {
  if (!Array.isArray(raw)) return [];
  const out: FaceRange[] = [];
  if (raw.every(isInt)) {
    for (let i = 0; i + 2 < raw.length; i += 3) out.push([raw[i + 1], raw[i + 2], raw[i]]);
  } else
    for (const r of raw) {
      if (!r || typeof r !== "object" || Array.isArray(r)) continue;
      const o = r as Record<string, unknown>;
      const start = o.start ?? o.first ?? o.firstTriangle;
      const count = o.count ?? o.triangleCount;
      const face = o.feature ?? o.face ?? o.id;
      if (isInt(start) && isInt(count) && isInt(face)) out.push([start, count, face]);
    }
  return out.sort((a, b) => a[0] - b[0]);
}

function node(raw: unknown, key?: string): (ViewSidecarNode & { instance?: number }) | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const out: ViewSidecarNode & { instance?: number } = {};
  if (isInt(o.node)) out.node = o.node;
  else if (isInt(o.index)) out.node = o.index;
  if (isInt(o.instance)) out.instance = o.instance;
  if (typeof o.name === "string") out.name = o.name;
  const path = o.instancePath ?? o.partInstanceId ?? key;
  if (typeof path === "string") out.instancePath = path;
  if (o.placeholder === true) out.placeholder = true;
  const b = o.bounds as unknown;
  if (Array.isArray(b) && vec3(b[0]) && vec3(b[1])) out.bounds = [vec3(b[0])!, vec3(b[1])!];
  else if (b && typeof b === "object" && vec3((b as { min?: unknown }).min) && vec3((b as { max?: unknown }).max))
    out.bounds = [vec3((b as { min: unknown }).min)!, vec3((b as { max: unknown }).max)!];
  const f = o.faces ?? o.faceRanges;
  if (Array.isArray(f) && f.length) out.faces = f.every((p) => Array.isArray(p)) ? f.map(faceRanges) : [faceRanges(f)];
  if (Array.isArray(o.instances) && o.instances.every((x) => typeof x === "string")) out.instances = o.instances as string[];
  return out;
}

/** A sidecar from its JSON, or undefined when it has no usable content hash. */
export function normaliseSidecar(raw: unknown): ViewSidecar | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const fine = (o.tiers as { fine?: { sha256?: unknown } } | undefined)?.fine;
  const output = o.output as Record<string, unknown> | undefined;
  const hash = [fine?.sha256, o.hash, o.contentHash, o.outputHash, output?.sha256].find((h) => typeof h === "string" && h.length >= 8) as string | undefined;
  if (!hash) return undefined;
  const parsed: (ViewSidecarNode & { instance?: number })[] = [];
  if (Array.isArray(o.nodes)) for (const n of o.nodes) node(n) && parsed.push(node(n)!);
  else if (o.nodes && typeof o.nodes === "object") for (const [k, n] of Object.entries(o.nodes)) node(n, k) && parsed.push(node(n, k)!);
  // a GPU-instanced node is listed once per instance: one entry with the instance paths in instance order
  const nodes: ViewSidecarNode[] = [];
  const instanced = new Map<number, ViewSidecarNode>();
  for (const n of parsed) {
    if (n.instance === undefined || n.node === undefined) {
      const { instance: _drop, ...rest } = n;
      nodes.push(rest);
      continue;
    }
    let entry = instanced.get(n.node);
    if (!entry) {
      entry = { node: n.node, instances: [], ...(n.faces ? { faces: n.faces } : {}) };
      instanced.set(n.node, entry);
      nodes.push(entry);
    }
    entry.instances![n.instance] = n.instancePath ?? "";
    if (n.placeholder) entry.placeholder = true;
  }
  const features = new Map<number, ViewSidecarFeature>();
  const fRaw = o.features;
  const feature = (v: unknown): ViewSidecarFeature | undefined => {
    if (typeof v === "string") return { instancePath: v };
    if (!v || typeof v !== "object") return undefined;
    const f = v as Record<string, unknown>;
    const out: ViewSidecarFeature = {};
    const p = f.instancePath ?? f.partInstanceId;
    if (typeof p === "string") out.instancePath = p;
    if (isInt(f.face)) out.face = f.face;
    return out;
  };
  if (Array.isArray(fRaw)) fRaw.forEach((v, i) => feature(v) && features.set(i, feature(v)!));
  else if (fRaw && typeof fRaw === "object") for (const [k, v] of Object.entries(fRaw)) if (/^\d+$/.test(k) && feature(v)) features.set(Number(k), feature(v)!);
  const src = (o.source ?? o.input) as Record<string, unknown> | undefined;
  const source = src && typeof src === "object" ? { ...(typeof src.sha256 === "string" ? { sha256: src.sha256 } : {}), ...(isInt(src.bytes) ? { bytes: src.bytes } : {}) } : undefined;
  const before = (o.counts as { before?: { materials?: unknown } } | undefined)?.before?.materials;
  return { ...(typeof o.schema === "string" ? { schema: o.schema } : {}), hash, ...(source ? { source } : {}), nodes, features, ...(isInt(before) ? { sourceMaterials: before } : {}), ...(o.root && typeof o.root === "object" ? { keepsNamedNodes: true } : {}) };
}

/** The face a triangle came from: binary search in sorted ranges. */
export function faceAt(ranges: FaceRange[] | undefined, triangle: number): number | undefined {
  if (!ranges?.length) return undefined;
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, count, face] = ranges[mid];
    if (triangle < start) hi = mid - 1;
    else if (triangle >= start + count) lo = mid + 1;
    else return face;
  }
  return undefined;
}

/**
 * Whether the sidecar no longer matches the original GLB. v0 records the
 * original's sha-256 and size; hashing a 32 MB board on every load would undo
 * what the sidecar saves, so the viewer compares sizes (a HEAD request): a GLB
 * re-exported by another tool has a different size almost always. Unknown on
 * either side: not stale (DEFAULT, PB-1175; see phase-1/progress.md W1-C).
 */
export function sidecarStale(sidecar: ViewSidecar, glbBytes: number | undefined): boolean {
  return sidecar.source?.bytes !== undefined && glbBytes !== undefined && sidecar.source.bytes !== glbBytes;
}
