/**
 * Evidence for a part: its committed sources.json and verification.json
 * (UHD skills/uhd-part-verify) plus the evidence traits on its definition.
 */
import type { ModuleDef, TraitDef } from "@uhd/types/index.js";

interface SourceRow {
  id: string;
  title: string;
  url: string;
  type: string;
  authority: string;
  supports?: string[];
}

interface Verification {
  audit: { checked: number; confirmed: number; wrong: number; unsupported: number } | null;
  repairs: string | null;
  assumptions: unknown[];
  data_gaps: unknown[];
  vocabulary_gaps: unknown[];
  recorded_at: string;
}

const SOURCES = import.meta.glob<SourceRow[]>("../../../uhd/library/parts/*/sources.json", { eager: true, import: "default" });
const VERIFICATION = import.meta.glob<Verification>("../../../uhd/library/parts/*/verification.json", { eager: true, import: "default" });

const byPart = <T,>(files: Record<string, T>) =>
  Object.fromEntries(Object.entries(files).map(([path, value]) => [path.split("/").slice(-2)[0], value]));

const SOURCES_BY_PART = byPart(SOURCES);
const VERIFICATION_BY_PART = byPart(VERIFICATION);

export interface Evidence {
  sources: SourceRow[];
  verification?: Verification;
  performance: { kind: string; facts: [string, string][] }[];
  assumptions: { field: string; value?: string; reason?: string }[];
  discrepancies: { field: string; resolution?: string }[];
  gaps: string[];
}

const show = (v: unknown): string =>
  typeof v === "string" ? v : Array.isArray(v) ? v.map(show).join(", ") : typeof v === "object" && v ? JSON.stringify(v) : String(v);

export function evidenceFor(def: ModuleDef | undefined): Evidence | undefined {
  if (!def) return undefined;
  const traits: TraitDef[] = [def, ...def.interfaces].flatMap((x) => x.traits ?? []);
  const params = (t: TraitDef) => (t.params ?? {}) as Record<string, unknown>;
  const verification = VERIFICATION_BY_PART[def.id];
  return {
    sources: SOURCES_BY_PART[def.id] ?? [],
    verification,
    performance: traits
      .filter((t) => t.type === "performance")
      .map((t) => {
        const { kind, source, note, ...rest } = params(t);
        void source;
        void note;
        return {
          kind: String(kind ?? "performance"),
          facts: Object.entries(rest)
            .filter(([, v]) => v !== undefined && typeof v !== "object")
            .slice(0, 12)
            .map(([k, v]) => [k.replace(/_/g, " "), show(v)] as [string, string]),
        };
      }),
    assumptions: traits
      .filter((t) => t.type === "assumption")
      .map((t) => ({ field: show(params(t).field ?? "assumption"), value: params(t).value !== undefined ? show(params(t).value) : undefined, reason: params(t).reason ? show(params(t).reason) : undefined })),
    discrepancies: traits
      .filter((t) => t.type === "source_discrepancy")
      .map((t) => ({ field: show(params(t).field ?? "discrepancy"), resolution: params(t).resolution ? show(params(t).resolution) : undefined })),
    gaps: (verification?.data_gaps ?? []).map(show),
  };
}
