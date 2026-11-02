/**
 * Dimension and angle records (R3-C, 2026-11-02): two more kinds in the view state's `annotations` list, beside
 * W3-B's callouts, marks and arrows (`uhd-viewer.annotation/v0`, additive; ../annot/record.ts parses every entry
 * and hands these two kinds to `parseDimFields` below). Like every record they are data, never a drawing: they name
 * what they measure by instance path, so the drawing follows the parts through explode, camera moves and a swap.
 *
 *   dimension: { id, kind: "dimension", ref, author, point?, to, toPoint?, tier?, valueMm?, toleranceMm?, offset?,
 *                title?, text?, tone?, visibility? }
 *   angle:     { id, kind: "angle", ref, author, joint?, title?, tone?, visibility? }
 *
 * A dimension runs from `ref` (at `point`, mm in the frame of the body that holds it, as a callout's point) to `to`
 * (at `toPoint`). Without a point an end is the part's design frame (its placed origin): the NOMINAL tier, "design
 * frames". With picked points it is the MESH tier unless the record says otherwise. `valueMm` is a value its author
 * measured another way (the exact tier's B-rep answer, a bench reading: EXACT, MEASURED); absent, the viewer shows
 * the distance between the two ends as assembled.
 *
 * An angle is drawn about a revolute joint (W4-E's `protoboard.mate` trait, the sequence's `joints`): `ref` is the
 * joint's id (usually its link id) or the instance path of the part it turns; `joint` names the joint when `ref` is
 * the part and the part has several.
 *
 * Text is plain and capped, shown with textContent only (an agent's words are data). This file imports nothing from
 * ../annot so the record parser there can import it without a cycle.
 */

export type Vec3 = [number, number, number];

/**
 * How a number was obtained (the MEASURE panel's tiers, concept B; the risk card's tier chips, concept A):
 * NOMINAL from the design frames, MESH from the display mesh, EXACT from the B-rep (the CLI's geometry service),
 * MEASURED from a bench. Lower case in records, upper case on screen.
 */
export type DimTier = "nominal" | "mesh" | "exact" | "measured";
export const DIM_TIERS: readonly DimTier[] = ["nominal", "mesh", "exact", "measured"];

export type DimKind = "dimension" | "angle";
export const DIM_KINDS: readonly DimKind[] = ["dimension", "angle"];

/** The fields both kinds share with a callout (id, ref, author, text, tone, visibility). */
interface DimBase {
  id: string;
  ref: string;
  author: string;
  title?: string;
  text?: string;
  tone?: "accent" | "neutral" | "fail" | "risk" | "warn" | "info" | "pass" | "unknown";
  visibility?: "on" | "hover" | "off";
}

export interface DimensionRecord extends DimBase {
  kind: "dimension";
  /** End A on `ref`, mm in its body's frame (Z up). Absent: the part's design frame (nominal). */
  point?: Vec3;
  /** End B: an instance path from the root. */
  to: string;
  toPoint?: Vec3;
  /** Absent: "mesh" when both ends are picked points, else "nominal". */
  tier?: DimTier;
  /** A value its author measured another way, mm (shown instead of the drawn distance). */
  valueMm?: number;
  /** ± mm, shown after the value. */
  toleranceMm?: number;
  /** Where the dimension line sits off the measured points, mm in the assembly root's frame. Absent: DEFAULT (./geometry.ts). */
  offset?: Vec3;
}

export interface AngleRecord extends DimBase {
  kind: "angle";
  /** The joint's id when `ref` is the part it turns and the part has several joints. */
  joint?: string;
}

export type DimRecord = DimensionRecord | AngleRecord;

/** Caps (DEFAULT, the same as a callout's in ../annot/record.ts LIMITS). */
export const DIM_LIMITS = { id: 128, ref: 512, author: 64, title: 120, text: 600, joint: 128, mm: 1e6 } as const;

const TONES = ["accent", "neutral", "fail", "risk", "warn", "info", "pass", "unknown"];
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x) && Math.abs(x) < 1e7);
// eslint-disable-next-line no-control-regex
const isPath = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max && !/[\u0000-\u001f]/.test(v);
const mm = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= DIM_LIMITS.mm ? v : undefined);

/** Plain text: control and direction-override characters dropped (newline kept), trimmed, capped. */
function clean(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u0009\u000b-\u001f\u007f‪-‮⁦-⁩]/g, "").trim();
  return s ? (s.length > max ? `${s.slice(0, max - 1)}…` : s) : undefined;
}

/**
 * The dimension or angle fields of a raw record whose id, kind, ref and author were already checked (by
 * ../annot/record.ts parseRecord), or why not. Unknown fields are dropped; nothing is interpreted.
 */
export function parseDimFields(raw: Record<string, unknown>, base: { id: string; kind: DimKind; ref: string; author: string }): { record: DimRecord } | { error: string } {
  const { id } = base;
  const common: DimBase = { id, ref: base.ref, author: base.author };
  const title = clean(raw.title, DIM_LIMITS.title);
  if (title) common.title = title.replace(/\n/g, " ");
  const text = clean(raw.text, DIM_LIMITS.text);
  if (text) common.text = text;
  if (raw.tone !== undefined) {
    if (!TONES.includes(raw.tone as string)) return { error: `${id}: tone must be ${TONES.join(", ")}` };
    common.tone = raw.tone as DimBase["tone"];
  }
  if (raw.visibility !== undefined) {
    if (raw.visibility !== "on" && raw.visibility !== "hover" && raw.visibility !== "off") return { error: `${id}: visibility must be on, hover or off` };
    common.visibility = raw.visibility;
  }
  if (base.kind === "angle") {
    const r: AngleRecord = { ...common, kind: "angle" };
    if (raw.joint !== undefined) {
      if (!isPath(raw.joint, DIM_LIMITS.joint) || !raw.joint) return { error: `${id}: joint must be a joint id` };
      r.joint = raw.joint;
    }
    return { record: r };
  }
  if (!isPath(raw.to, DIM_LIMITS.ref)) return { error: `${id}: a dimension needs \`to\`, the instance path of its other end` };
  const r: DimensionRecord = { ...common, kind: "dimension", to: raw.to };
  for (const k of ["point", "toPoint", "offset"] as const) {
    if (raw[k] === undefined) continue;
    if (!isVec3(raw[k])) return { error: `${id}: ${k} must be [x, y, z] mm` };
    r[k] = [...(raw[k] as Vec3)] as Vec3;
  }
  if (raw.tier !== undefined) {
    const t = typeof raw.tier === "string" ? raw.tier.toLowerCase() : raw.tier;
    if (!DIM_TIERS.includes(t as DimTier)) return { error: `${id}: tier must be ${DIM_TIERS.join(", ")}` };
    r.tier = t as DimTier;
  }
  if (raw.valueMm !== undefined) {
    const v = mm(raw.valueMm);
    if (v === undefined || v < 0) return { error: `${id}: valueMm must be a distance in mm` };
    r.valueMm = v;
  }
  if (raw.toleranceMm !== undefined) {
    const v = mm(raw.toleranceMm);
    if (v === undefined || v < 0) return { error: `${id}: toleranceMm must be a distance in mm` };
    r.toleranceMm = v;
  }
  return { record: r };
}

/** A dimension's tier: the record's, else MESH for two picked points, else NOMINAL (design frames). */
export const tierOf = (r: DimensionRecord): DimTier => r.tier ?? (r.point && r.toPoint ? "mesh" : "nominal");

/** What the tier means, for a chip's tooltip. */
export const TIER_NOTE: Record<DimTier, string> = {
  nominal: "Nominal: from the design frames",
  mesh: "Mesh: measured on the display mesh",
  exact: "Exact: measured on the B-rep (STEP)",
  measured: "Measured: a bench measurement",
};

/** A dimension or angle record from untrusted JSON on its own (tests, the measure tool): the base fields too. */
export function parseDimRecord(raw: unknown): { record: DimRecord } | { error: string } {
  if (!isObj(raw)) return { error: "a record must be an object" };
  const id = typeof raw.id === "string" ? raw.id : "";
  // eslint-disable-next-line no-control-regex
  if (!id || id.length > DIM_LIMITS.id || /[\u0000-\u001f]/.test(id)) return { error: `a record needs an id of 1 to ${DIM_LIMITS.id} characters` };
  if (!DIM_KINDS.includes(raw.kind as DimKind)) return { error: `${id}: kind must be ${DIM_KINDS.join(" or ")}` };
  if (!isPath(raw.ref, DIM_LIMITS.ref)) return { error: `${id}: ref must be an instance path` };
  const author = clean(raw.author, DIM_LIMITS.author);
  if (!author) return { error: `${id}: author is required (who made it)` };
  return parseDimFields(raw, { id, kind: raw.kind as DimKind, ref: raw.ref, author });
}

/**
 * Every dimension and angle record of a view state's `annotations` list (other kinds are skipped; rejects are left
 * out, as `recordsOf` does): valid records by id, a later duplicate replacing an earlier. At most 500 entries are read.
 */
export function dimRecordsOf(list: unknown[]): DimRecord[] {
  const byId = new Map<string, DimRecord>();
  for (const raw of list.slice(0, 500)) {
    if (!isObj(raw) || !DIM_KINDS.includes(raw.kind as DimKind)) continue;
    const p = parseDimRecord(raw);
    if ("record" in p) byId.set(p.record.id, p.record);
  }
  return [...byId.values()];
}
