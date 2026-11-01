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
export async function preflightFromSidecars(glbs: ReadonlyMap<string, number>, fetcher: typeof fetch = (input, init) => fetch(input, init)): Promise<ReturnType<typeof preflight>> {
  const counts = await Promise.all(
    [...glbs].map(async ([url, placements]) => {
      try {
        const res = await fetcher(url.replace(/\.glb(\?.*)?$/i, ".view.json$1"), { cache: "no-cache" });
        if (!res.ok) return undefined;
        const declared = Number(res.headers?.get?.("content-length"));
        if (Number.isFinite(declared) && declared > MAX_SIDECAR_JSON_BYTES) return undefined;
        const text = await res.text();
        if (text.length > MAX_SIDECAR_JSON_BYTES) return undefined;
        return sidecarCounts(JSON.parse(text), placements);
      } catch {
        return undefined;
      }
    }),
  );
  return preflight(counts.filter((c): c is NonNullable<typeof c> => Boolean(c)));
}

