/**
 * A board's UHD groups as Assemble steps (R3-A): the board module's children are its sections (ClientX: power,
 * controller, outputs (fans and lights), expansion), each section's children with parts of their own are its groups
 * (power input, fan power, the rails; MCU, USB, sensors; ...). One step per group in the board's own order, then one
 * per section for the parts placed directly in it. Pure (UHD definitions in, prefixes and titles out).
 */
import type { ModuleDef } from "@uhd/types/index.js";
import type { BoardGroup } from "./plan";

/** A definition's or instance's name without its parenthesised detail ("Power input (12 V jack / ...)" → "Power input"). */
export const shortName = (name: string | undefined, fallback: string): string => {
  const n = (name ?? "").replace(/\s*\(.*$/, "").trim();
  return n || fallback.replace(/_/g, " ");
};

/**
 * The groups of the board `def` placed at `holder` (its instance path in the level, "" when it is the level's own
 * model), in assembly order: every group before the section that holds it is listed after it (the longest prefix
 * wins in `groupOf`, so the order of the list is the order of the steps).
 */
export function boardGroups(def: ModuleDef, lookup: (id: string) => ModuleDef | undefined, holder = ""): BoardGroup[] {
  const at = (id: string) => (holder ? `${holder}/${id}` : id);
  const out: BoardGroup[] = [];
  for (const s of def.children ?? []) {
    const sdef = lookup(s.moduleDefId);
    const section = shortName(s.name ?? sdef?.name, s.id);
    if (!sdef?.children?.length) continue;
    for (const g of sdef.children) {
      const gdef = lookup(g.moduleDefId);
      if (!gdef?.children?.length) continue;
      out.push({ prefix: at(`${s.id}/${g.id}`), title: shortName(g.name ?? gdef.name, g.id), section });
    }
    // parts placed directly in the section (no group of their own)
    out.push({ prefix: at(s.id), title: section, section });
  }
  return out;
}
