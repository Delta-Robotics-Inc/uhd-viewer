/**
 * The findings the 3D view pins (PB-1184), from its two sources: the viewer's
 * own system checks (refs: instance paths, `link:<id>`) and the host's
 * diagnostics (`protoboard check` through the bundle, or a host message),
 * which may carry a `DiagnosticLocation` (board-frame mm). Both become
 * `FindingInput`s for ./findings-anchors.ts. Pure.
 */
import type { UhdBundleDiagnostic } from "@uhd/types/bundle.js";
import type { ScopedDiagnostic } from "../../model/diagnostics";
import type { FindingInput, FindingLocation } from "./findings-anchors";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const pair = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number" && Number.isFinite(x));
const strings = (v: unknown, max = 64): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length <= 512).slice(0, max) : undefined);

/** A `DiagnosticLocation` from untrusted JSON (shapes checked, lists capped), or undefined. */
export function locationOf(raw: unknown): FindingLocation | undefined {
  if (!isObj(raw)) return undefined;
  const out: FindingLocation = {};
  if (raw.scope === "design") out.scope = "design";
  if (pair(raw.at)) out.at = [raw.at[0], raw.at[1]];
  if (Array.isArray(raw.points)) out.points = raw.points.filter(pair).slice(0, 256) as [number, number][];
  if (typeof raw.layer === "string" && raw.layer.length <= 32) out.layer = raw.layer;
  for (const k of ["components", "pads", "nets", "items"] as const) {
    const l = strings(raw[k]);
    if (l?.length) out[k] = l;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The view's own checks first, then the host's (each host diagnostic keeps its location when it has one). */
export function findingInputs(system: ScopedDiagnostic[], host: UhdBundleDiagnostic[]): FindingInput[] {
  const out: FindingInput[] = [];
  for (const d of system) {
    // the most specific ref first: a pin or interface, then a link
    const refs = [...d.refs.filter((r) => !r.startsWith("link:")), ...d.refs.filter((r) => r.startsWith("link:"))];
    const ref = refs[0];
    out.push({
      code: d.rule.toUpperCase(),
      severity: d.severity,
      message: d.message,
      ...(ref !== undefined ? { entity: ref.startsWith("link:") ? { kind: "link", id: ref.slice(5) } : { kind: "instance", id: ref } } : {}),
      validator: "uhd-viewer/system",
    });
  }
  for (const d of host) {
    const loc = locationOf((d as { location?: unknown }).location);
    const risk = (d as { risk?: unknown }).risk === true;
    out.push({ code: d.code, severity: d.severity, message: d.message, ...(d.entity ? { entity: { kind: d.entity.kind, id: d.entity.id } } : {}), ...(d.validator ? { validator: d.validator } : {}), ...(loc ? { location: loc } : {}), ...(risk ? { risk } : {}) });
  }
  return out;
}
