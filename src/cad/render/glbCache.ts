/**
 * GLB cache keyed by content (PB-1175). Round 1 (README §4) found that the
 * old cache was keyed by URL and never cleared, so a GLB re-exported to the
 * same path kept showing the old geometry until the page reloaded.
 *
 * Now a parsed model is keyed by its content hash: the view sidecar's output
 * hash when `X.view.json` is there, else the sha-256 of the GLB bytes. A URL
 * remembers which hash it gave in the current *generation*; starting a new
 * generation (a new bundle, `__cad.refresh()`) makes the next load of every
 * URL check its content again. Unchanged content is not parsed twice; changed
 * content gets a new hash, so it is parsed and shown without a reload.
 *
 * Order for `X.glb`: `X.view.json` (hash, scene index) and `X.view.glb`; if
 * either is missing, unreadable, stale (its recorded source size differs from
 * `X.glb`'s) or fails to parse, `X.glb` itself.
 *
 * Fetch, hashing and parsing are injectable so the cache runs in tests.
 */
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import type * as THREE from "three";
import { emitGlbLoad, type GlbLoadEvent } from "./events";
import { applySidecar } from "./ids";
import { MAX_GLB_BYTES, MAX_SIDECAR_JSON_BYTES, normaliseSidecar, sidecarStale, sidecarUrls, type ViewSidecar } from "./sidecar";

/** The part of `Response` the cache reads. */
export interface FetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}
export type Fetcher = (url: string, init?: { method?: string; cache?: "no-cache" }) => Promise<FetchResponse>;

export interface LoadedModel {
  gltf: GLTF;
  /** Content hash (sidecar output hash, or `sha256:` / `fnv1a64:` of the bytes). */
  hash: string;
  /** The URL asked for (`X.glb`). */
  url: string;
  /** The URL the bytes came from. */
  path: string;
  source: "sidecar" | "glb";
  sidecar?: ViewSidecar;
  bytes: number;
  /** Time the GLTFLoader parse took (ms) when the content was parsed. */
  parseMs: number;
}

export interface GlbCacheOptions {
  fetch?: Fetcher;
  /** Parse GLB bytes (`resourcePath`: the URL's folder, for external buffers). */
  parse: (data: ArrayBuffer, resourcePath: string) => Promise<GLTF>;
  hash?: (data: ArrayBuffer) => Promise<string>;
  now?: () => number;
  /** Look for `X.view.glb` / `X.view.json` (default true). */
  sidecars?: boolean;
}

export interface LoadOptions {
  /** false: `X.glb` itself, never the sidecar (a caller that needs the original's node structure). */
  sidecar?: boolean;
}

export interface GlbCache {
  /** The model at `url` (null when it cannot be loaded; the reason is logged). */
  load: (url: string, options?: LoadOptions) => Promise<LoadedModel | null>;
  /** The next load of every URL checks its content again. Returns the new generation. */
  beginGeneration: () => number;
  readonly generation: number;
  /** Hash a URL resolved to in the current or last generation. */
  hashOf: (url: string) => string | undefined;
  /** Parsed models held (by content hash). */
  readonly size: number;
  /** Drop parsed models no URL resolved to in the current generation (call once a generation's loads settled). */
  prune: () => number;
  clear: () => void;
}

const SUPPORTED_REQUIRED = new Set([
  "KHR_mesh_quantization",
  "EXT_meshopt_compression",
  "EXT_mesh_gpu_instancing",
  "KHR_materials_unlit",
  "KHR_texture_transform",
  "KHR_materials_emissive_strength",
  // the view sidecar's per-face ids: the attribute is read directly, the extension object is metadata
  "EXT_mesh_features",
]);

/** The JSON chunk of a GLB (or a .gltf's JSON), for checks before parsing. */
export function glbJson(data: ArrayBuffer): { extensionsRequired?: string[] } | undefined {
  try {
    const view = new DataView(data);
    if (data.byteLength >= 20 && view.getUint32(0, true) === 0x46546c67) {
      const len = view.getUint32(12, true);
      if (view.getUint32(16, true) !== 0x4e4f534a || 20 + len > data.byteLength) return undefined;
      return JSON.parse(new TextDecoder().decode(new Uint8Array(data, 20, len)));
    }
    return JSON.parse(new TextDecoder().decode(new Uint8Array(data)));
  } catch {
    return undefined;
  }
}

/** Security basics: a required extension the loader cannot honour is an error, not a warning. */
export function checkGlb(data: ArrayBuffer): void {
  if (data.byteLength > MAX_GLB_BYTES) throw new Error(`GLB of ${data.byteLength} bytes is over the ${MAX_GLB_BYTES}-byte cap`);
  const json = glbJson(data);
  if (!json) throw new Error("not a GLB or glTF file");
  const unknown = (json.extensionsRequired ?? []).filter((e) => !SUPPORTED_REQUIRED.has(e));
  if (unknown.length) throw new Error(`required glTF extension(s) not supported: ${unknown.join(", ")}`);
}

/** FNV-1a 64 over the bytes: the fallback content hash where Web Crypto is not available (an insecure origin). */
export function fnv1a64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  // two 32-bit halves of the 64-bit FNV state, multiplied by the FNV prime 0x100000001b3
  let h = 0xcbf29ce4 >>> 0;
  let l = 0x84222325 >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    l = (l ^ bytes[i]) >>> 0;
    const lo = l * 0x1b3;
    const hi = h * 0x1b3 + l * 0x100 + Math.floor(lo / 0x100000000);
    l = lo >>> 0;
    h = hi >>> 0;
  }
  return `fnv1a64:${h.toString(16).padStart(8, "0")}${l.toString(16).padStart(8, "0")}`;
}

export async function contentHash(data: ArrayBuffer): Promise<string> {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (subtle) {
    try {
      const d = new Uint8Array(await subtle.digest("SHA-256", data));
      return `sha256:${Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("")}`;
    } catch {
      /* fall through */
    }
  }
  return fnv1a64(data);
}

function counts(scene: THREE.Object3D): GlbLoadEvent["counts"] & { nodes: number } {
  let nodes = 0;
  let meshes = 0;
  let triangles = 0;
  scene.traverse((o) => {
    nodes++;
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    meshes++;
    const g = m.geometry;
    const n = g.index ? g.index.count / 3 : (g.getAttribute("position")?.count ?? 0) / 3;
    triangles += Math.round(n) * ((m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1);
  });
  return { bytes: 0, nodes, meshes, triangles };
}

const folderOf = (url: string) => {
  const path = url.split(/[?#]/)[0];
  return path.slice(0, path.lastIndexOf("/") + 1);
};

export function createGlbCache(options: GlbCacheOptions): GlbCache {
  const doFetch: Fetcher = options.fetch ?? ((url, init) => fetch(url, init as RequestInit) as Promise<FetchResponse>);
  const hashOf = options.hash ?? contentHash;
  const now = options.now ?? (() => performance.now());
  const useSidecars = options.sidecars !== false;
  /** Parsed models by content hash. */
  const byHash = new Map<string, Promise<LoadedModel | null>>();
  /** URL → its load in a generation. */
  const byUrl = new Map<string, { generation: number; promise: Promise<LoadedModel | null>; hash?: string }>();
  let generation = 0;

  const get = async (url: string, method: "GET" | "HEAD" = "GET") => {
    try {
      const r = await doFetch(url, { method, cache: "no-cache" });
      return r.ok ? r : undefined;
    } catch {
      return undefined;
    }
  };
  const lengthOf = (r: FetchResponse | undefined) => {
    const n = Number(r?.headers.get("content-length"));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };

  /** Parse bytes once per content hash. */
  const parseOnce = (hash: string, make: () => Promise<{ data: ArrayBuffer; path: string; source: LoadedModel["source"]; sidecar?: ViewSidecar }>, url: string): Promise<LoadedModel | null> => {
    const have = byHash.get(hash);
    if (have) return have;
    const p = (async () => {
      const { data, path, source, sidecar } = await make();
      checkGlb(data);
      const tParse = now();
      const gltf = await options.parse(data, folderOf(path));
      const parseMs = now() - tParse;
      // the parsed scene is a template (callers clone it): ids go on it once, before any clone
      const assoc = (gltf.parser as unknown as { associations?: Map<THREE.Object3D, { nodes?: number }> }).associations;
      applySidecar(gltf.scene, hash, sidecar, (o) => assoc?.get(o)?.nodes);
      return { gltf, hash, url, path, source, ...(sidecar ? { sidecar } : {}), bytes: data.byteLength, parseMs } satisfies LoadedModel;
    })();
    byHash.set(hash, p);
    // a failed parse is not cached: the next generation tries again
    p.catch(() => byHash.get(hash) === p && byHash.delete(hash));
    return p;
  };

  const viaSidecar = async (url: string): Promise<LoadedModel | undefined> => {
    const urls = useSidecars ? sidecarUrls(url) : undefined;
    if (!urls) return undefined;
    const jsonRes = await get(urls.json);
    let sidecar: ViewSidecar | undefined;
    if (jsonRes) {
      try {
        const text = await jsonRes.text();
        if (text.length <= MAX_SIDECAR_JSON_BYTES) sidecar = normaliseSidecar(JSON.parse(text));
      } catch {
        sidecar = undefined;
      }
    }
    if (sidecar) {
      // stale: the original was written again after the sidecar (a size check, see sidecarStale)
      if (sidecar.source?.bytes !== undefined && sidecarStale(sidecar, lengthOf(await get(url, "HEAD")))) {
        console.warn(`[cad] ${urls.json} is stale (made from a different ${url}): using the GLB`);
        return undefined;
      }
      const sc = sidecar;
      return (await parseOnce(
        sc.hash,
        async () => {
          const r = await get(urls.glb);
          if (!r) throw new Error(`${urls.glb} missing`);
          return { data: await r.arrayBuffer(), path: urls.glb, source: "sidecar", sidecar: sc };
        },
        url,
      )) ?? undefined;
    }
    // no scene index: the merged GLB alone still beats the original (hashed by its bytes)
    const r = await get(urls.glb);
    if (!r) return undefined;
    const data = await r.arrayBuffer();
    const hash = await hashOf(data);
    return (await parseOnce(hash, async () => ({ data, path: urls.glb, source: "sidecar" }), url)) ?? undefined;
  };

  const viaGlb = async (url: string): Promise<LoadedModel | null> => {
    const r = await get(url);
    if (!r) throw new Error(`${url}: not found`);
    const data = await r.arrayBuffer();
    const hash = await hashOf(data);
    return parseOnce(hash, async () => ({ data, path: url, source: "glb" }), url);
  };

  const load = (url: string, loadOptions: LoadOptions = {}): Promise<LoadedModel | null> => {
    const plain = loadOptions.sidecar === false;
    const slot = plain ? `${url}#glb-only` : url;
    const known = byUrl.get(slot);
    if (known && known.generation === generation) return known.promise;
    const t0 = now();
    const before = new Set(byHash.keys());
    const entry: { generation: number; promise: Promise<LoadedModel | null>; hash?: string } = { generation, promise: Promise.resolve(null) };
    entry.promise = (async () => {
      let model: LoadedModel | null | undefined;
      try {
        model = plain ? undefined : await viaSidecar(url);
      } catch (e) {
        console.warn(`[cad] ${url}: view sidecar not used (${e instanceof Error ? e.message : e})`);
        model = undefined;
      }
      if (!model) {
        try {
          model = await viaGlb(url);
        } catch (e) {
          console.warn(`[cad] ${url}: ${e instanceof Error ? e.message : e}`);
          return null;
        }
      }
      if (!model) return null;
      entry.hash = model.hash;
      const c = counts(model.gltf.scene);
      const cached = before.has(model.hash);
      const ms = now() - t0;
      emitGlbLoad({ path: model.path, requested: url, hash: model.hash, ms, cached, source: model.source, counts: { ...c, bytes: model.bytes }, ...(cached ? {} : { parseMs: model.parseMs, fetchMs: Math.max(0, ms - model.parseMs) }) });
      return model;
    })();
    byUrl.set(slot, entry);
    return entry.promise;
  };

  return {
    load,
    beginGeneration: () => ++generation,
    get generation() {
      return generation;
    },
    hashOf: (url) => byUrl.get(url)?.hash,
    get size() {
      return byHash.size;
    },
    prune: () => {
      // what the current generation resolved to stays; older generations' content goes
      const live = new Set([...byUrl.values()].filter((e) => e.generation === generation).map((e) => e.hash).filter(Boolean));
      let n = 0;
      for (const [h, p] of [...byHash.entries()])
        if (!live.has(h)) {
          byHash.delete(h);
          n++;
          // its GPU buffers go too (a renderer that still draws a clone uploads them again)
          void p.then((m) => m?.gltf.scene.traverse((o) => (o as THREE.Mesh).geometry?.dispose())).catch(() => undefined);
        }
      return n;
    },
    clear: () => {
      byHash.clear();
      byUrl.clear();
    },
  };
}
