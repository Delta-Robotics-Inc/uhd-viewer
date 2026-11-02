/**
 * Plain-language text on findings (R2-C, Kevin's walkthrough D3: "a plain title and a one-line description"). The
 * stack writes two optional strings on each bundle diagnostic (R2-D): `title` (plain words, no code or path) and
 * `summary` (one sentence: what is wrong and why it matters). The viewer shows `title` on the short hover, the
 * marker's tooltip and the Findings list; `summary` on the long hover and the pinned card; the raw message and the
 * AT / BY / MORE rows only under the pinned card's "Details" disclosure. Without them it falls back to today's
 * text (the code in words; the message's first clause).
 *
 * The shared file `./findings-anchors.ts` (byte-identical with the stack's core copy) is not changed: the two fields
 * ride beside it. `findingsAnchors` here wraps the shared one and copies them onto its results, matched by input
 * order (the shared function keeps input order and skips only info findings unless asked for them).
 */
import { findingsAnchors as anchorsOf, severityOf, type FindingAnchors, type FindingInput, type FindingsAnchorsOptions, type SceneBody } from "./findings-anchors";

/** The plain-language fields a finding may carry (R2-D writes them on bundle diagnostics). */
export interface FindingText {
  title?: string;
  summary?: string;
}

/** DEFAULT (R2-C): the longest plain title and summary shown, in characters (longer is cut with an ellipsis). */
export const PLAIN_TITLE_MAX = 80;
export const PLAIN_SUMMARY_MAX = 160;

/** A string from untrusted JSON as shown text: whitespace collapsed, at most `max` characters (cut at a word). */
export function plainString(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/\s+/g, " ").trim();
  if (!s) return undefined;
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

/** The plain-language fields of a raw diagnostic (anything not a usable string is left out). */
export function findingText(raw: unknown): FindingText {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as { title?: unknown; summary?: unknown };
  const title = plainString(r.title, PLAIN_TITLE_MAX);
  const summary = plainString(r.summary, PLAIN_SUMMARY_MAX);
  return { ...(title ? { title } : {}), ...(summary ? { summary } : {}) };
}

/**
 * The viewer computes its own system checks (UHD_LINK_STATE, UHD_INTERFACE_REUSE, ...) and the host's copies of them
 * (validator `uhd/checkSystem`) are dropped before they reach the 3D view, with the plain text R2-D writes on them.
 * This index keeps that text: by code and message (the viewer's check and the stack's are the same function, so the
 * message is the same), for `findingInputs` to put back on the viewer's own findings. Built from the bundle's
 * diagnostics, before any filtering.
 */
export function plainTextIndex(diagnostics: readonly unknown[]): Map<string, FindingText> {
  const out = new Map<string, FindingText>();
  for (const d of diagnostics) {
    const t = findingText(d);
    if (!t.title && !t.summary) continue;
    const r = d as { code?: unknown; message?: unknown };
    if (typeof r.code !== "string" || typeof r.message !== "string") continue;
    out.set(plainKey(r.code, r.message), t);
  }
  return out;
}

/**
 * The index key of a finding's plain text: its code and its message, whitespace collapsed. The stack names a system
 * check `UHD_<RULE>` and puts the checked module before a nested check's message ("pcb (pcb-b1-4): ..."); the viewer
 * names it `<RULE>` with the bare message. Both reduce to the same key.
 */
export const plainKey = (code: string, message: string) =>
  `${code.toUpperCase().replace(/^UHD_/, "")}|${message
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[^\s()]+ \([^()]*\): /, "")}`;

/**
 * `findingsAnchors` of ./findings-anchors.ts, with each input's `title` and `summary` (when it has them) copied onto
 * its finding. Same arguments, same results otherwise.
 */
export function findingsAnchors(findings: (FindingInput & FindingText)[], bodies: SceneBody[], options: FindingsAnchorsOptions = {}): (FindingAnchors & FindingText)[] {
  const out = anchorsOf(findings, bodies, options) as (FindingAnchors & FindingText)[];
  const kept = findings.filter((d) => options.includeInfo || severityOf(d) !== "info");
  if (kept.length !== out.length) return out;
  kept.forEach((d, i) => {
    const t = findingText(d);
    if (t.title) out[i].title = t.title;
    if (t.summary) out[i].summary = t.summary;
  });
  return out;
}
