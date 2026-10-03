/**
 * Evidence for a part: its sources.json and verification.json, when they are
 * registered (registerEvidenceFiles; nothing does yet), plus the evidence
 * traits on its definition.
 *
 * The traits come with the bundle. The two files do not (yet): UHD has no
 * part library to read them from, so without a host that supplies them the
 * viewer shows the traits only.
 */
import type { ModuleDef, TraitDef } from "@uhd/types/index.js";

export interface SourceRow {
  id: string;
  title: string;
  url: string;
  type: string;
  authority: string;
  supports?: string[];
}

export interface Verification {
  audit: { checked: number; confirmed: number; wrong: number; unsupported: number } | null;
  repairs: string | null;
  assumptions: unknown[];
  data_gaps: unknown[];
  vocabulary_gaps: unknown[];
  recorded_at: string;
}

let SOURCES_BY_PART: Record<string, SourceRow[]> = {};
let VERIFICATION_BY_PART: Record<string, Verification> = {};
let filesKnown = false;

/** Evidence files by part id (definition id). */
export function registerEvidenceFiles(files: { sources: Record<string, SourceRow[]>; verification: Record<string, Verification> }) {
  SOURCES_BY_PART = files.sources;
  VERIFICATION_BY_PART = files.verification;
  filesKnown = true;
}

export interface Evidence {
  /** Whether sources.json / verification.json were available at all (false: the audit state is unknown). */
  filesKnown: boolean;
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
    filesKnown,
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
