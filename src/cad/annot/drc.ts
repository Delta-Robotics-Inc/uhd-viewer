/**
 * Marker-first DRC (PB-1184): findings become severity markers on the model,
 * one per anchor (several findings at one anchor are one marker with a count
 * badge, in the worst severity), and the Findings control's state (which
 * severities are shown, which finding is open). Pure: the anchors come from
 * ./findings-anchors.ts, the 3D positions from the layer.
 */
import { SEVERITY_ORDER, worst, type FindingAnchorPoint, type FindingAnchors, type FindingSeverity } from "./findings-anchors";

export interface DrcMarker {
  /** Stable while the anchor stays: `<body>|<component>|<rounded local point>`. */
  key: string;
  anchor: FindingAnchorPoint;
  severity: FindingSeverity;
  /** Findings at this anchor, worst first. */
  findings: FindingAnchors[];
}

const round = (v: number) => Math.round(v * 10) / 10;
export const anchorKey = (a: FindingAnchorPoint) => `${a.body}|${a.component ?? ""}|${a.local ? a.local.map(round).join(",") : ""}`;

const rank = (s: FindingSeverity) => SEVERITY_ORDER.indexOf(s);

/** Markers for the findings whose severity is shown. */
export function drcMarkers(findings: FindingAnchors[], shown: Set<FindingSeverity>): DrcMarker[] {
  const by = new Map<string, DrcMarker>();
  for (const f of findings) {
    if (!shown.has(f.severity)) continue;
    for (const a of f.anchors) {
      const key = anchorKey(a);
      const m = by.get(key) ?? { key, anchor: a, severity: f.severity, findings: [] };
      if (!m.findings.includes(f)) m.findings.push(f);
      m.severity = worst([m.severity, f.severity])!;
      by.set(key, m);
    }
  }
  const out = [...by.values()];
  for (const m of out) m.findings.sort((a, b) => rank(a.severity) - rank(b.severity) || a.id.localeCompare(b.id));
  // worst first, then by key: the keyboard order (roving tab index) and the draw order
  return out.sort((a, b) => rank(a.severity) - rank(b.severity) || a.key.localeCompare(b.key));
}

/** Counts per severity (every finding, placed or not). */
export function severityCounts(findings: FindingAnchors[]): Record<FindingSeverity, number> {
  const c: Record<FindingSeverity, number> = { fail: 0, risk: 0, warn: 0, info: 0, pass: 0, unknown: 0 };
  for (const f of findings) c[f.severity]++;
  return c;
}

/**
 * The severities shown by default (round-2 note §D.3): everything but pass and info (pass is review mode only,
 * info is not pinned). DEFAULT (PB-1184).
 */
export const DEFAULT_SHOWN: FindingSeverity[] = ["fail", "risk", "warn", "unknown"];

/** "Open all labels" opens at most this many cards; the rest stay markers (round-2 note: "max 8"). DEFAULT. */
export const MAX_OPEN_FINDINGS = 8;

/** What "isolate" shows for a finding: the parts it names; none for a finding without a location. */
export const isolationOf = (f: FindingAnchors): string[] | null => (f.anchors.length && f.refs.length ? f.refs : null);

/** Next or previous finding with a location, from `current` (n / p keys). */
export function stepFinding(list: FindingAnchors[], current: string | undefined, by: 1 | -1): FindingAnchors | undefined {
  const placed = list.filter((f) => f.anchors.length);
  if (!placed.length) return undefined;
  const i = placed.findIndex((f) => f.id === current);
  return placed[i < 0 ? (by > 0 ? 0 : placed.length - 1) : (i + by + placed.length) % placed.length];
}

/** The card text of a finding: its code as the title, the message as the body (data, shown as text). */
export function findingCard(f: FindingAnchors): { title: string; text: string; rows: [string, string][] } {
  const rows: [string, string][] = [];
  if (f.entity) rows.push([f.entity.kind === "link" ? "LINK" : "AT", f.entity.id]);
  if (f.validator) rows.push(["BY", f.validator]);
  return { title: f.code.replace(/_/g, " "), text: f.message, rows };
}
