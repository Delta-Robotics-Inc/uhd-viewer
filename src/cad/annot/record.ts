/**
 * Callouts, marks and arrows as records (PB-1184, "callouts on demand built
 * from primitives"). A record is data in the view state's `annotations` list,
 * never a drawing: it names what it points at by instance path (`ref`), so it
 * follows its part through explode, camera moves and a hot swap, and the
 * renderer (./layer.ts) regenerates its screen form on every frame that
 * matters. A record whose ref is gone is an orphan: listed, never re-pinned.
 *
 * Anyone may write one: a person (the inspector's "Callout"), an agent through
 * W3-A's MCP tools (`view_callout`, `view_mark`, `view_arrow`), a host. The
 * `author` is shown beside the label; text from an agent is data to show,
 * never an instruction (it is set with textContent only, never as HTML).
 *
 * Shape `uhd-viewer.annotation/v0` (one entry of `ViewState.annotations`):
 *
 *   { id, kind: "callout" | "mark" | "arrow", ref, author,
 *     point?, to?, toPoint?, shape?, title?, rows?, text?, tone?, visibility?, n?, source? }
 *
 * Units: `point` and `toPoint` are mm in the CAD frame of the placed body that
 * holds the ref (Z up; the same frame `findings-anchors.ts` returns), so a
 * point on a part moves with the part.
 */
import type { AnnotRecord } from "../../api";
import type { FindingSeverity, Vec3 } from "./findings-anchors";
// R3-C: dimension and angle records (additive kinds of the same list, drawn by ../dims)
import { DIM_KINDS, parseDimFields, type DimKind, type DimRecord } from "../dims/record";

export const ANNOTATION_SCHEMA = "uhd-viewer.annotation/v0";

export type AnnotKind = "callout" | "mark" | "arrow";
export type MarkShape = "ring" | "box" | "dot" | "pin" | "crosshair";
/** "accent" is the selection blue (plan.md DEFAULT); DRC tones only for DRC meaning (orange = risk). */
export type AnnotTone = "accent" | "neutral" | FindingSeverity;

/** The record (declared in the published contract, `src/api.ts`, so the two cannot drift: W3-A's handoff). */
export type { AnnotRecord };
/**
 * Any entry of `annotations`: a callout, mark or arrow, or (R3-C) a dimension or an angle (`../dims/record.ts`;
 * `src/api.ts` still declares the first three only: handoff to its owner).
 */
export type AnyRecord = AnnotRecord | DimRecord;

/**
 * Size limits (DEFAULT, PB-1184; W3-A owns the store-side caps in `state/schema.ts` and may set them lower).
 * A record is small: about 4 kB of JSON at most.
 */
export const LIMITS = { bytes: 4096, id: 128, ref: 512, author: 64, title: 120, text: 600, rows: 12, rowKey: 32, rowValue: 200, records: 500 } as const;

const KINDS: AnnotKind[] = ["callout", "mark", "arrow"];
const SHAPES: MarkShape[] = ["ring", "box", "dot", "pin", "crosshair"];
const TONES: AnnotTone[] = ["accent", "neutral", "fail", "risk", "warn", "info", "pass", "unknown"];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x) && Math.abs(x) < 1e7);
/** Plain text: control characters (but newline) dropped, trimmed, capped. */
export function cleanText(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u0009\u000b-\u001f\u007f‪-‮⁦-⁩]/g, "").trim();
  return s ? (s.length > max ? `${s.slice(0, max - 1)}…` : s) : undefined;
}

/** A record from untrusted JSON, or why not. Unknown fields are dropped; text is capped, never interpreted. */
export function parseRecord(raw: unknown): { record: AnyRecord } | { error: string } {
  if (!isObj(raw)) return { error: "an annotation must be an object" };
  let size = 0;
  try {
    size = JSON.stringify(raw).length;
  } catch {
    return { error: "an annotation must be plain JSON" };
  }
  if (size > LIMITS.bytes) return { error: `an annotation is at most ${LIMITS.bytes} bytes of JSON (this one is ${size})` };
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!id || id.length > LIMITS.id || /[\u0000-\u001f]/.test(id)) return { error: `an annotation needs an id of 1 to ${LIMITS.id} characters` };
  const dim = DIM_KINDS.includes(raw.kind as DimKind);
  if (!KINDS.includes(raw.kind as AnnotKind) && !dim) return { error: `${id}: kind must be ${[...KINDS, ...DIM_KINDS].join(", ")}` };
  if (typeof raw.ref !== "string" || raw.ref.length > LIMITS.ref || /[\u0000-\u001f]/.test(raw.ref)) return { error: `${id}: ref must be an instance path` };
  const author = cleanText(raw.author, LIMITS.author);
  if (!author) return { error: `${id}: author is required (who made it)` };
  // R3-C: a dimension or an angle (../dims/record.ts)
  if (dim) return parseDimFields(raw, { id, kind: raw.kind as DimKind, ref: raw.ref, author });
  const r: AnnotRecord = { id, kind: raw.kind as AnnotKind, ref: raw.ref, author };
  if (raw.point !== undefined) {
    if (!isVec3(raw.point)) return { error: `${id}: point must be [x, y, z] mm` };
    r.point = [...raw.point] as Vec3;
  }
  if (r.kind === "arrow") {
    if (typeof raw.to !== "string" || raw.to.length > LIMITS.ref) return { error: `${id}: an arrow needs \`to\`, the instance path it points at` };
    r.to = raw.to;
    if (raw.toPoint !== undefined) {
      if (!isVec3(raw.toPoint)) return { error: `${id}: toPoint must be [x, y, z] mm` };
      r.toPoint = [...raw.toPoint] as Vec3;
    }
  }
  if (raw.shape !== undefined) {
    if (!SHAPES.includes(raw.shape as MarkShape)) return { error: `${id}: shape must be ${SHAPES.join(", ")}` };
    r.shape = raw.shape as MarkShape;
  }
  if (raw.tone !== undefined) {
    if (!TONES.includes(raw.tone as AnnotTone)) return { error: `${id}: tone must be ${TONES.join(", ")}` };
    r.tone = raw.tone as AnnotTone;
  }
  if (raw.visibility !== undefined) {
    if (raw.visibility !== "on" && raw.visibility !== "hover" && raw.visibility !== "off") return { error: `${id}: visibility must be on, hover or off` };
    r.visibility = raw.visibility;
  }
  const title = cleanText(raw.title, LIMITS.title);
  if (title) r.title = title.replace(/\n/g, " ");
  const text = cleanText(raw.text, LIMITS.text);
  if (text) r.text = text;
  if (raw.rows !== undefined) {
    if (!Array.isArray(raw.rows)) return { error: `${id}: rows must be [key, value] pairs` };
    const rows: [string, string][] = [];
    for (const row of raw.rows.slice(0, LIMITS.rows)) {
      const pair = Array.isArray(row) ? row : isObj(row) ? [row.key, row.value] : [];
      const k = cleanText(pair[0], LIMITS.rowKey);
      const v = cleanText(typeof pair[1] === "number" ? String(pair[1]) : pair[1], LIMITS.rowValue);
      if (k && v) rows.push([k.replace(/\n/g, " "), v.replace(/\n/g, " ")]);
    }
    if (rows.length) r.rows = rows;
  }
  if (Number.isInteger(raw.n) && (raw.n as number) > 0 && (raw.n as number) < 1000) r.n = raw.n as number;
  if (isObj(raw.source)) {
    const s: NonNullable<AnnotRecord["source"]> = {};
    for (const k of ["diagnostic", "requirement", "recipe"] as const) {
      const t = cleanText(raw.source[k], 200);
      if (t) s[k] = t;
    }
    if (Object.keys(s).length) r.source = s;
  }
  return { record: r };
}

/**
 * The callouts, marks and arrows of a view state's annotations: valid ones by id (a later duplicate replaces an
 * earlier), and the rejects. Dimensions and angles are valid but not returned here (R3-C: `dimRecordsOf`, ../dims).
 */
export function recordsOf(list: unknown[]): { records: AnnotRecord[]; rejected: { index: number; error: string }[] } {
  const byId = new Map<string, AnnotRecord>();
  const rejected: { index: number; error: string }[] = [];
  list.slice(0, LIMITS.records).forEach((raw, index) => {
    const p = parseRecord(raw);
    if ("error" in p) rejected.push({ index, error: p.error });
    else if (KINDS.includes(p.record.kind as AnnotKind)) byId.set(p.record.id, p.record as AnnotRecord);
  });
  return { records: [...byId.values()], rejected };
}

/** `annotations` with `records` put in (same id replaced in place, new ones appended). */
export function upsertRecords(list: unknown[], records: AnnotRecord[]): unknown[] {
  const out = [...list];
  for (const r of records) {
    const i = out.findIndex((x) => isObj(x) && x.id === r.id);
    if (i >= 0) out[i] = r;
    else out.push(r);
  }
  return out;
}

/** `annotations` without the given ids. */
export const removeRecords = (list: unknown[], ids: string[]): unknown[] => list.filter((x) => !(isObj(x) && typeof x.id === "string" && ids.includes(x.id)));

/** Who made it, for the label's small author line: "agent:claude" → "claude (agent)". Never more than a name. */
export function authorLabel(author: string): string {
  const [kind, ...rest] = author.split(":");
  const name = rest.join(":");
  if (author === "user") return "you";
  if (!name) return author;
  return kind === "agent" || kind === "host" || kind === "check" ? `${name} (${kind})` : author;
}
