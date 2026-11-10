/**
 * Where the viewer's sequence comes from (PB-1183), in order:
 * 1. a built `sequence.json` (generated from mates and fastener stacks, patched
 *    by the project): passed in by the host or fetched beside the bundle;
 * 2. the same generator run here on the model's assembly, when the bundle has
 *    mates but no built file (no project patches then);
 * 3. the stack planner alone, for a model with no mates (a bare multi-body
 *    GLB, a module whose parts only display hints place): one `place` step per
 *    part, lowest rise first, so a fully exploded view is today's planner
 *    result exactly (the bottle and quad-motor fixtures stay the baseline).
 */
import { generateSequence } from "./generate";
import { DEFAULTS, SEQUENCE_SCHEMA, type SequenceFile } from "./types";
import type { Assembly } from "./uhd";

/** A sequence from stack-planner rises alone (mm along up, by part ref). Parts that rise 0 stay. */
export function sequenceFromPlan(rise: ReadonlyMap<string, number>, base: string[] = []): SequenceFile {
  const order = [...rise.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  return {
    schema: SEQUENCE_SCHEMA,
    main: "main",
    sequences: [
      {
        id: "main",
        scope: "",
        base: base.length ? base : order.filter(([, r]) => r === 0).map(([k]) => k),
        steps: order.map(([ref, r]) => ({ id: `place:${ref}`, title: `Place the ${ref.split("/").pop()?.replace(/_/g, " ")}`, kind: "place" as const, members: [{ ref }], motion: { along: "up" as const, distance: r }, plan: "stack" as const, source: "generated" as const })),
      },
    ],
    defaults: { ...DEFAULTS },
    root: [],
    generated: { by: "uhd-viewer stack planner" },
  };
}

/** The model's own sequence when no built file came with the bundle; undefined when nothing is mated. */
export function sequenceForModel(asm: Assembly, root: string[], hinted: Iterable<string> = []): SequenceFile | undefined {
  if (!asm.mates.length) return undefined;
  return generateSequence(asm, { root, hinted, by: "uhd-viewer (no sequence.json in the bundle)" });
}

/** Whether a parsed JSON value is a sequence file this viewer reads. */
export function isSequenceFile(x: unknown): x is SequenceFile {
  const f = x as SequenceFile | undefined;
  return Boolean(f && f.schema === SEQUENCE_SCHEMA && Array.isArray(f.sequences) && typeof f.main === "string" && f.sequences.some((s) => s.id === f.main));
}

/**
 * `sequence.json` beside the bundle (`.protoboard/build/uhd-bundle.json` →
 * `.protoboard/build/sequence.json`); undefined when the server has none or it
 * is not a sequence file. Capped at 8 MB.
 */
export async function fetchSequenceBeside(bundleUrl: string, fetcher: typeof fetch = fetch): Promise<SequenceFile | undefined> {
  const url = bundleUrl.replace(/[^/?#]*([?#].*)?$/, "sequence.json");
  try {
    const res = await fetcher(url);
    if (!res.ok) return undefined;
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > 8 * 1024 * 1024) return undefined;
    const text = await res.text();
    if (text.length > 8 * 1024 * 1024) return undefined;
    const parsed = JSON.parse(text) as unknown;
    return isSequenceFile(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
