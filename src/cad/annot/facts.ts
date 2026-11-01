/**
 * What a label sheet says about a part (PB-1184): reference designator, MPN,
 * LCSC number, value, read from the model only (no network, no guess). A row
 * the model does not carry is left out, never invented.
 *
 * The LCSC rule is the build's (stack `view-model/project.ts` `vendorKeyOf`,
 * written again here: the viewer cannot import core): an artifact whose name
 * or URL mentions LCSC and carries a C-number (C followed by 3 to 9 digits,
 * not inside a longer word; case-sensitive, so a package code like c0603 is
 * not one).
 */
import type { ModuleDef } from "@uhd/types/module.js";
import type { AnnotRecord } from "../../api";

const LCSC = /(?:^|[^A-Za-z0-9])(C\d{3,9})(?!\d)/;

/** The LCSC part number of a definition, if one of its artifacts names it. */
export function lcscOf(def: Pick<ModuleDef, "artifacts"> | undefined): string | undefined {
  for (const a of def?.artifacts ?? []) {
    const text = `${(a as { name?: string }).name ?? ""} ${(a as { url?: string }).url ?? ""}`;
    if (!/lcsc/i.test(text)) continue;
    const m = LCSC.exec(text);
    if (m) return m[1];
  }
  return undefined;
}

/** A reference designator from an instance id ("u13" → "U13"): letters then digits, nothing else. */
export function refdesOf(path: string): string | undefined {
  const id = path.split("/").pop() ?? "";
  return /^[a-z]{1,3}\d{1,4}$/i.test(id) ? id.toUpperCase() : undefined;
}

export interface PartFacts {
  name?: string;
  refdes?: string;
  mpn?: string;
  manufacturer?: string;
  lcsc?: string;
  value?: string;
}

/** Facts of a part instance: its definition and the child ref that places it (overrides win). */
export function partFacts(path: string, def: ModuleDef | undefined, child?: { name?: string; overrides?: Record<string, unknown> }): PartFacts {
  const o = child?.overrides ?? {};
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : undefined);
  const out: PartFacts = {};
  const name = child?.name ?? def?.name;
  if (name) out.name = name;
  const refdes = refdesOf(path);
  if (refdes) out.refdes = refdes;
  const mpn = str(o.part_number) ?? str(def?.part_number);
  if (mpn) out.mpn = mpn;
  const mfr = str(o.manufacturer) ?? str(def?.manufacturer);
  if (mfr) out.manufacturer = mfr;
  const lcsc = str(o.lcsc) ?? lcscOf(def);
  if (lcsc && /^C\d{3,9}$/.test(lcsc)) out.lcsc = lcsc;
  const value = str(o.value);
  if (value) out.value = value;
  return out;
}

/**
 * The label sheet rows for a part: REF, MPN, LCSC, VALUE, MFR (in that order).
 * DEFAULT (PB-1184): a part with no LCSC number says so ("none in the model")
 * rather than dropping the row, so an exit test asking for MPN and LCSC shows
 * both rows on a bought module that has none (the drone's parts).
 */
export function factRows(f: PartFacts, opts: { lcscRow?: "always" | "known" } = {}): [string, string][] {
  const rows: [string, string][] = [];
  if (f.refdes) rows.push(["REF", f.refdes]);
  if (f.mpn) rows.push(["MPN", f.mpn]);
  if (f.lcsc) rows.push(["LCSC", f.lcsc]);
  else if ((opts.lcscRow ?? "always") === "always") rows.push(["LCSC", "none in the model"]);
  if (f.value) rows.push(["VALUE", f.value]);
  if (f.manufacturer) rows.push(["MFR", f.manufacturer]);
  return rows;
}

/** The child ref and definition at an instance path from `root` (undefined when no such instance). */
export function instanceAt(root: ModuleDef, lookup: (id: string) => ModuleDef | undefined, path: string): { def: ModuleDef; child?: { id: string; name?: string; overrides?: Record<string, unknown> } } | undefined {
  if (!path) return { def: root };
  let def: ModuleDef | undefined = root;
  let child: { id: string; name?: string; overrides?: Record<string, unknown>; moduleDefId: string } | undefined;
  for (const id of path.split("/")) {
    child = def?.children?.find((c) => c.id === id);
    if (!child) return undefined;
    def = lookup(child.moduleDefId);
    if (!def) return undefined;
  }
  return def ? { def, ...(child ? { child } : {}) } : undefined;
}

/**
 * A callout and a ring for a part, as a person's records (the inspector's "Callout"). The store retires an id
 * once removed (W3-A: never reused), so each press makes new ids: `user:callout:<path>:<stamp>`; the inspector
 * finds a part's own records by author, kind and ref.
 */
export function partCallout(path: string, facts: PartFacts, author = "user", stamp: string = Date.now().toString(36)): { callout: AnnotRecord; ring: AnnotRecord } {
  const name = facts.name ?? path;
  // "U13 · Buck converter", but not "U13 · U13 TPS54427 ..." when the name already starts with the designator
  const title = facts.refdes && !name.toUpperCase().startsWith(facts.refdes) ? `${facts.refdes} · ${name}` : name;
  return {
    callout: { id: `${author}:callout:${path}:${stamp}`, kind: "callout", ref: path, author, title, rows: factRows(facts) },
    ring: { id: `${author}:ring:${path}:${stamp}`, kind: "mark", ref: path, author, shape: "ring" },
  };
}
