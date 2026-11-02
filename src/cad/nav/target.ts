/**
 * What a part opens and what its menu and tooltip say (R2-A, walkthrough F2, F3 and A3, 2026-11-02). Pure: the 3D
 * view hands in the definition at a path and gets back the navigation target, the menu's items and the tooltip's
 * lines.
 */
import type { ArtifactDef, ModuleDef } from "@uhd/types/index.js";
import { partPackage } from "@uhd/protocols/package.js";
import type { NavigateTarget } from "../../api";
import { glbFor } from "../model";

/** Model formats a part's own model artifact may have (a vendor model it can be opened on). */
const MODEL_FORMATS = new Set(["glb", "gltf", "step", "stp", "stl", "3mf", "obj", "wrl"]);

/** The model artifact a part can be opened on when it has no body GLB (its vendor STEP, say), or undefined. */
export function modelArtifact(def: ModuleDef): ArtifactDef | undefined {
  const arts = def.artifacts ?? [];
  const ok = (a: ArtifactDef) => MODEL_FORMATS.has(String(a.format ?? "").toLowerCase()) && a.role !== "interface" && Boolean(a.filePath);
  return arts.find((a) => ok(a) && a.role === "body") ?? arts.find((a) => ok(a) && a.role !== "source") ?? arts.find(ok);
}

/**
 * What double-clicking a part opens (R2-A, F3: "if I double-click on a part, that should open that 3D model"):
 * its module's own 3D level when it is a sub-assembly or has a body model (a bought part's body GLB is its vendor
 * model), else a model artifact of its own (its STEP), else nothing (the view selects and frames it).
 * `path` is the instance path from the root.
 */
export function navigateTarget(def: ModuleDef | undefined, path: string): NavigateTarget | undefined {
  if (!def) return undefined;
  if (def.children?.length || glbFor(def)) return { module: path };
  const art = modelArtifact(def);
  return art ? { model: { defId: def.id, artifactId: art.id, path } } : undefined;
}

/** The facts a part's tooltip shows (refdes, names, MPN, package, finding count). */
export interface PartTip {
  /** Instance path in the view's scope. */
  key: string;
  refdes?: string;
  /** The instance's or its definition's name. */
  name?: string;
  mpn?: string;
  /** The package name and body size ("SOIC-8, 4.9 x 3.9 x 1.75 mm"). */
  pkg?: string;
  /** Findings that name the part or a part inside it. */
  findings: number;
  /** The worst of them ("fail", "warn", ...). */
  worst?: string;
  /** What a double-click does here ("open", "frame"). */
  open: "open" | "frame";
}

/** A package's line: its name and body size where it states one. */
export function packageLine(def: ModuleDef | undefined): string | undefined {
  const p = def ? partPackage(def) : undefined;
  if (!p?.name) return undefined;
  const s = p.size_mm as { length?: number; width?: number; height?: number } | undefined;
  const n = (v?: number) => (typeof v === "number" && Number.isFinite(v) ? `${+v.toFixed(2)}` : undefined);
  const size = s && n(s.length) && n(s.width) ? `${n(s.length)} x ${n(s.width)}${n(s.height) ? ` x ${n(s.height)}` : ""} mm` : undefined;
  return size ? `${p.name}, ${size}` : p.name;
}

/**
 * The short tooltip (R2-A, A3; Kevin: "in tscircuit when I hover over something it gives me a tooltip of the
 * component, like U1, J1"): the refdes and the short name ("U13 TPS54427 5 V buck"); a part with neither shows the
 * last segment of its path.
 */
export function shortTip(t: PartTip): string {
  const name = t.name && t.name !== t.refdes ? t.name : undefined;
  // wave R3 gate: a board component's name often starts with its designator ("C25 100 uF electrolytic"): said once
  if (name && t.refdes && name.startsWith(`${t.refdes} `)) return name;
  const parts = [t.refdes, name].filter(Boolean);
  return parts.length ? parts.join(" ") : (t.key.split("/").pop() ?? t.key);
}

/** The long tooltip's rows (after a long hover): MPN, package, findings, and what a click does. */
export function longTipRows(t: PartTip): [string, string][] {
  const rows: [string, string][] = [];
  if (t.mpn) rows.push(["MPN", t.mpn]);
  if (t.pkg) rows.push(["Package", t.pkg]);
  rows.push(["Findings", t.findings ? `${t.findings}${t.worst ? ` (worst ${t.worst})` : ""}` : "none"]);
  return rows;
}

/** The hint under the long tooltip: what the pointer can do here (Kevin: hovering must say it is clickable). */
export const tipHint = (t: PartTip): string => `Click to select · Double-click to ${t.open === "open" ? "open its 3D model" : "frame it"} · Right-click for more`;

/** One item of the 3D context menu. */
export interface MenuItem {
  id: PartItemId | VoidItemId;
  label: string;
  /** Lucide icon name (the app's Icon set). */
  icon: string;
  /** Why it cannot run here; the item is shown disabled with this as its tooltip. */
  disabled?: string;
  /** A keyboard hint shown at the right. */
  hint?: string;
  /** R4-A: a rule above this item (the void menu's groups; the part menu keeps its own two rules). */
  rule?: boolean;
  /** R4-A: an on/off item that is on now (shown pressed). */
  checked?: boolean;
}

/** The part menu's items (R2-A). */
export type PartItemId = "inspect" | "open" | "openTab" | "frame" | "isolate" | "hide" | "explode" | "copy";
/** The void menu's items (R4-A, ./void.ts). */
export type VoidItemId = "showAll" | "unisolate" | "fit" | "reset" | "explode" | "assemble" | "sectionOff" | "grid" | "scaleRef" | "capture";

/**
 * The context menu for a part (R2-A, F2; Kevin: "if I right-click it, it gives me options like inspect, view 3D
 * model, explode subassembly"; "the default mode to change the current window and the secondary right-click mode to
 * open in a new tab"). `component`: the part is drawn inside another body (a board's part), so isolating or hiding
 * it alone is not possible; `canExplode`: the part's module has parts to explode.
 */
export function menuFor(opts: { target: NavigateTarget | undefined; component: boolean; canExplode: boolean; canOpenTab: boolean; isolated: boolean }): MenuItem[] {
  const none = "This part has no 3D model of its own";
  const inside = "Drawn inside its board: isolate or hide the board";
  return [
    { id: "inspect", label: "Inspect", icon: "scan-search" },
    { id: "open", label: "Open 3D model", icon: "box", hint: "Double-click", ...(opts.target ? {} : { disabled: none }) },
    { id: "openTab", label: "Open in new tab", icon: "square-arrow-out-up-right", hint: "Ctrl+double-click", ...(!opts.target ? { disabled: none } : !opts.canOpenTab ? { disabled: "This viewer has no tabs to open" } : {}) },
    { id: "frame", label: "Frame", icon: "scan" },
    { id: "isolate", label: opts.isolated ? "Show everything" : "Isolate", icon: "focus", ...(opts.component && !opts.isolated ? { disabled: inside } : {}) },
    { id: "hide", label: "Hide", icon: "eye-off", ...(opts.component ? { disabled: inside } : {}) },
    { id: "explode", label: "Explode this sub-assembly", icon: "move-diagonal", ...(opts.canExplode ? {} : { disabled: "Nothing to explode: this part has no parts of its own" }) },
    { id: "copy", label: "Copy instance path", icon: "copy" },
  ];
}
