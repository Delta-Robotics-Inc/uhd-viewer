/**
 * What double-clicking a board's component opens (R3-A, 2026-11-02). Kevin: "If I double-click on a component, I
 * should also be able to look at that step. If I double-click on the USB-C, it'll actually pull up that 3D file."
 *
 * A component drawn inside its board is a leaf part: its own 3D model is the part's model artifact (`cad_glb`, else
 * `cad_step` or any model file under `parts/local` or `parts/catalog`), opened through the R2 `uhd-viewer:navigate`
 * with `target.model` (a module target would make a host drill to the level that holds the part, the board again).
 * A part with no model of its own (only the board export's shape: ClientX's USB-C until R3-M adds one), or a build
 * placeholder box, has no target: the view selects and frames it and says so. When R3-M adds the USB-C's model to
 * its UHD file, the next build lists the artifact and this opens it, with no change here.
 */
import type { ArtifactDef, ModuleDef } from "@uhd/types/index.js";
import type { NavigateTarget } from "../../api";
import { modelArtifact } from "../nav/target";

/** DEFAULT (R3-A): a build placeholder (a box the stack drew for a part with no model) is not a model of its own. */
export function isPlaceholderArtifact(a: ArtifactDef): boolean {
  const file = (a.filePath ?? "").replace(/\\/g, "/");
  return /(^|\/)placeholders\//.test(file) || /\(placeholder\)\s*$/i.test(a.name ?? "");
}

/** The part's own model to open: its body GLB first (the viewer opens it as it is), else a model file (its STEP). */
export function componentModel(def: ModuleDef | undefined): ArtifactDef | undefined {
  if (!def) return undefined;
  const arts = (def.artifacts ?? []).filter((a) => a.filePath && !isPlaceholderArtifact(a));
  const glb = arts.find((a) => a.role === "body" && String(a.format ?? "").toLowerCase() === "glb");
  if (glb) return glb;
  const any = modelArtifact({ ...def, artifacts: arts });
  return any && !isPlaceholderArtifact(any) ? any : undefined;
}

/**
 * The navigation target of a component drawn inside a board shown as an assembly: a sub-assembly (a module with
 * parts) opens as a module, a part opens its own model file; undefined when it has none.
 */
export function componentTarget(def: ModuleDef | undefined, path: string): NavigateTarget | undefined {
  if (!def) return undefined;
  if (def.children?.length) return { module: path };
  const art = componentModel(def);
  return art ? { model: { defId: def.id, artifactId: art.id, path } } : undefined;
}
