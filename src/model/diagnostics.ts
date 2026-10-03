/**
 * The system checks the viewer runs itself (PB-823).
 *
 * UHD derives links per module: a parent does not see through a child
 * board's nets (docs/boards-and-nets.md, "Limits"). So the root is checked,
 * and so is every module below it that declares nets (a board), on its own.
 * A board's findings are re-based onto the root: refs and ids carry the
 * board's instance path (`board/u2:pin_14`, `link:board/<id>`, `board:sda`),
 * and `scope` names the board, so the checks panel can say where a finding
 * is and the diagram can overlay it when that board is drilled into.
 */
import type { ModuleDef } from "@uhd/types/index.js";
import type { ModuleLookup } from "@uhd/system/index.js";
import { checkSystem, type SystemDiagnostic } from "@uhd/system/checks.js";
import { isNet } from "@uhd/protocols/net.js";

export interface ScopedDiagnostic extends SystemDiagnostic {
  /** Instance path of the module that was checked ("" for the root). */
  scope: string;
}

/** A canonical path below `scope`, re-based onto the root. */
export function rebase(ref: string, scope: string): string {
  if (!scope) return ref;
  if (ref.startsWith("link:")) return `link:${scope}/${ref.slice(5)}`;
  if (ref.startsWith(":")) return `${scope}${ref}`;
  return ref ? `${scope}/${ref}` : scope;
}

/** Instance paths of every module below `root` that declares nets, depth first. */
export function boardsBelow(root: ModuleDef, lookup: ModuleLookup): { path: string; def: ModuleDef }[] {
  const out: { path: string; def: ModuleDef }[] = [];
  const walk = (def: ModuleDef, prefix: string, depth: number) => {
    if (depth > 12) return;
    for (const ref of def.children ?? []) {
      const child = lookup(ref.moduleDefId);
      if (!child) continue;
      const path = prefix ? `${prefix}/${ref.id}` : ref.id;
      if (child.interfaces.some(isNet)) out.push({ path, def: child });
      walk(child, path, depth + 1);
    }
  };
  walk(root, "", 0);
  return out;
}

/** The root's findings, then each board's, re-based onto the root. */
export function systemDiagnostics(root: ModuleDef, lookup: ModuleLookup): ScopedDiagnostic[] {
  const out: ScopedDiagnostic[] = checkSystem(root, lookup).diagnostics.map((d) => ({ ...d, scope: "" }));
  for (const { path, def } of boardsBelow(root, lookup)) {
    for (const d of checkSystem(def, lookup).diagnostics) {
      out.push({ ...d, id: `${path}/${d.id}`, refs: d.refs.map((r) => rebase(r, path)), scope: path });
    }
  }
  return out;
}
