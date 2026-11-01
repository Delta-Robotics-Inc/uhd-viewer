/** The pre-flight over the view sidecars (PB-1177), before any GLB is fetched. */
import { MAX_SIDECAR_JSON_BYTES } from "../render/sidecar";
import { preflight, sidecarCounts } from "./stages";

/**
 * The pre-flight warning from the view sidecars, fetched before the GLBs:
 * `X.view.json` beside each body GLB (small files), times the placements that
 * draw it. Files without a sidecar count nothing (their cost is unknown until
 * loaded). Each index is size-capped (`MAX_SIDECAR_JSON_BYTES`, checked on the
 * header before the body is read and on the text after). Never throws.
 */
/** A response body as text, or undefined once it passes `max` bytes (the rest is not read). */
export async function readCapped(res: Response, max: number): Promise<string | undefined> {
  const body = (res as { body?: ReadableStream<Uint8Array> | null }).body;
  if (!body || typeof body.getReader !== "function") {
    const text = await res.text();
    return text.length > max ? undefined : text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export async function preflightFromSidecars(glbs: ReadonlyMap<string, number>, fetcher: typeof fetch = (input, init) => fetch(input, init)): Promise<ReturnType<typeof preflight>> {
  const counts = await Promise.all(
    [...glbs].map(async ([url, placements]) => {
      try {
        const res = await fetcher(url.replace(/\.glb(\?.*)?$/i, ".view.json$1"), { cache: "no-cache" });
        if (!res.ok) return undefined;
        const declared = Number(res.headers?.get?.("content-length"));
        if (Number.isFinite(declared) && declared > MAX_SIDECAR_JSON_BYTES) return undefined;
        // without a content-length the body is read in chunks and dropped past the cap (W4-D, wave 3 carry-forward)
        const text = await readCapped(res, MAX_SIDECAR_JSON_BYTES);
        if (text === undefined || text.length > MAX_SIDECAR_JSON_BYTES) return undefined;
        return sidecarCounts(JSON.parse(text), placements);
      } catch {
        return undefined;
      }
    }),
  );
  return preflight(counts.filter((c): c is NonNullable<typeof c> => Boolean(c)));
}

