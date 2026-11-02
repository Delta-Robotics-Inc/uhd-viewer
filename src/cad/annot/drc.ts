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

/**
 * Whether the findings toggle has anything to show in this view (R1-D's G4 ask: ClientX's Cube shell had 0 of 16
 * findings placed, and the toggle turned on and showed nothing). `drawn` is the layer's count of markers drawn
 * (AnnotLayer.markersDrawn) when the host has it; else the findings with a 3D anchor in this scope.
 */
export function findingsPlacement(findings: FindingAnchors[], drawn?: number): { total: number; placed: number; empty: boolean; note?: string } {
  const placed = drawn ?? findings.filter((f) => f.anchors.length > 0).length;
  const empty = findings.length > 0 && placed === 0;
  return { total: findings.length, placed, empty, ...(empty ? { note: "No findings placed in this view" } : {}) };
}

/** The one-line description's longest, in characters, before an ellipsis at a word boundary. DEFAULT 120 (R1-C). */
export const SUMMARY_MAX = 120;

/**
 * A finding's card in hover tiers (walkthrough D3, presentation only: the plain-language rewrite is wave R2): the
 * title (the code in words), a one-line description cut from the message (parentheticals dropped, the first clause
 * or sentence, at most SUMMARY_MAX characters), and the raw rows (AT path, BY validator) and full message, which
 * only the pinned card shows.
 */
export function findingSummary(f: FindingAnchors): { title: string; description: string; text: string; rows: [string, string][] } {
  const card = findingCard(f);
  return { title: card.title, description: summarise(f.message), text: card.text, rows: card.rows };
}

/** The first clause of a diagnostic message, without parentheticals, cut at a word boundary (pure). */
export function summarise(message: string, max = SUMMARY_MAX): string {
  let s = (message ?? "").replace(/\s+/g, " ").trim();
  // "(controller/sensors/i2c0_sda.ps.pin_4+...)": the raw list stays in the pinned card and the Inspector
  for (let i = 0; i < 3 && /\([^()]*\)/.test(s); i++) s = s.replace(/\s*\([^()]*\)/g, "");
  s = s.replace(/\s+([:;,.])/g, "$1").replace(/\s{2,}/g, " ").trim();
  // the first clause: before a dash aside, else the first sentence
  const dash = s.search(/\s[–—-]\s/);
  if (dash > 12) s = s.slice(0, dash);
  const stop = s.search(/[.!?](\s|$)/);
  if (stop > 12) s = s.slice(0, stop + 1);
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:]+$/, "")}…`;
}

/**
 * The finding a host names to pin (`uhd-viewer:openFinding`, sent when a check row is clicked in the host's
 * Inspector; gate R1, R1-E's D7 handoff): the exact id, else its repeats (`<id>#2`, ...) in order, else the first
 * finding with that code whose refs name `path` or a part under it. `rootPath` turns a ref (a key in the view's
 * scope) into a path from the root, as the host names it.
 */
export function findingForHost<F extends Pick<FindingAnchors, "id" | "code" | "refs">>(
  findings: readonly F[],
  want: { id: string; code: string; path?: string },
  rootPath: (ref: string) => string = (r) => r,
): F | undefined {
  const exact = findings.find((f) => f.id === want.id) ?? findings.find((f) => f.id.startsWith(`${want.id}#`));
  if (exact || want.path === undefined) return exact;
  const path = want.path.replace(/^\/+|\/+$/g, "");
  return findings.find(
    (f) =>
      f.code === want.code &&
      f.refs.some((r) => {
        const p = rootPath(r.split("#")[0]);
        return p === path || (path !== "" && p.startsWith(`${path}/`));
      }),
  );
}
