/**
 * 3D view model (PB-775): what to load and where, derived from UHD alone.
 *
 * - Placements come from `assemble` (mechanical links with frames).
 * - Each placement's body is the module's GLB artifact for that body.
 * - Each interface reports how it is bound, per direction:
 *     feature    D1  named sub-shape in the body artifact (+ signature)
 *     artifact   D2  its own artifact file
 *     procedural D3  derived from its parameters at its frame
 *   plus whether it is logical, unmapped, or resolved through its children.
 */
import type { ArtifactDef, ChildModuleRef, GeometryFrame, GeometryRef, InterfaceDef, ModuleDef } from "@uhd/types/index.js";
import {
  assemble,
  bodyKey,
  checkGeometryBindings,
  interfaceGeometry,
  type Assembly,
  type GeometryBindingIssue,
  type GeometryManifest,
  type Mat4,
  type Placement,
} from "@uhd/system/geometry.js";
import type { ModuleLookup } from "@uhd/system/index.js";
import { cadOutputs } from "../model/outputs";

/** Artifact URL for a definition's (relative) file path: supplied by the viewer's source. */
import type { ArtifactResolver } from "../api";
export type { ArtifactResolver };

export type Direction = "feature" | "artifact" | "procedural";
export const DIRECTIONS: { id: Direction; label: string; hint: string }[] = [
  { id: "feature", label: "D1 FEATURE", hint: "Named sub-shape inside the module's artifact (STEP/GLB name, KCL tag)" },
  { id: "artifact", label: "D2 ARTIFACT", hint: "One artifact file per interface" },
  { id: "procedural", label: "D3 PROCEDURAL", hint: "No file: derived from the interface's parameters at its frame" },
];

export interface CadBody {
  key: string;
  path: string[];
  def: ModuleDef;
  /** GLB to load, if the module has one for this body. */
  glb?: ArtifactDef;
  /** The body artifact id feature refs point at (STEP or vendor source). */
  bodyArtifact?: string;
  matrix: Mat4;
  via?: string;
  /** Placed by a hint, not by a link. */
  hint?: string;
}

export type BindingStatus = "bound" | "stale" | "missing" | "unchecked" | "none";

export interface InterfaceRow {
  iface: InterfaceDef;
  frame?: GeometryFrame;
  /** Geometry comes from these interfaces (itself, or its children). */
  sources: string[];
  refs: { interfaceId: string; ref: GeometryRef }[];
  logical: boolean;
  /** No frame and no refs, on itself or any child. */
  unmapped: boolean;
  /** Per-direction resolution. */
  byDirection: Record<Direction, { interfaceId: string; ref: GeometryRef; status: BindingStatus; note?: string }[]>;
  issues: GeometryBindingIssue[];
}

export interface CadModel {
  assembly: Assembly;
  bodies: CadBody[];
  /** module path key -> def, for every leaf instance */
  defs: Map<string, ModuleDef>;
  manifests: Map<string, GeometryManifest>;
  /**
   * Instances drawn inside another module's body rather than placed: the
   * components of a board whose body (board.glb) shows them (PB-823). Path
   * key → the body key that holds them.
   */
  within: Map<string, string>;
}

/** The definition at an instance path below `system` ([] is the system itself). */
export function defAt(system: ModuleDef, lookup: ModuleLookup, path: string[]): ModuleDef | undefined {
  let def: ModuleDef | undefined = system;
  for (const id of path) {
    const ref: ChildModuleRef | undefined = def?.children?.find((c) => c.id === id);
    def = ref ? lookup(ref.moduleDefId) : undefined;
  }
  return def;
}

/** Artifact id of the GLB for a body: the one generated from `bodyArtifact`, or the module's first body GLB. */
export function glbFor(def: ModuleDef, bodyArtifact?: string): ArtifactDef | undefined {
  const arts = def.artifacts ?? [];
  if (bodyArtifact) return arts.find((a) => a.format === "glb" && (a.id === bodyArtifact || a.provenance?.generatedFrom === bodyArtifact));
  return arts.find((a) => a.role === "body" && a.format === "glb");
}

/** The STEP (or vendor source) that a body GLB was generated from — what D1 feature refs name. */
function sourceOf(def: ModuleDef, glb?: ArtifactDef): string | undefined {
  return glb?.provenance?.generatedFrom ?? undefined;
}

/** Fetch every manifest JSON the modules declare (artifacts with format json generated from a body). */
export async function loadManifests(defs: ModuleDef[], resolve: ArtifactResolver): Promise<Map<string, GeometryManifest>> {
  const out = new Map<string, GeometryManifest>();
  await Promise.all(
    defs.flatMap((def) =>
      (def.artifacts ?? [])
        .filter((a) => a.format === "json" && a.provenance?.generatedFrom && a.filePath)
        .map(async (a) => {
          try {
            const url = resolve(def.id, a.filePath!);
            if (!url) return;
            const res = await fetch(url);
            if (res.ok) out.set(`${def.id}:${a.provenance!.generatedFrom}`, (await res.json()) as GeometryManifest);
          } catch {
            /* missing manifest: bindings report "unchecked" */
          }
        }),
    ),
  );
  return out;
}

export function buildCadModel(
  system: ModuleDef,
  lookup: ModuleLookup,
  manifests: Map<string, GeometryManifest>,
  hints: { path: string[]; matrix: Mat4; note: string }[] = [],
  rootPath?: string[],
): CadModel {
  const fixed = Object.fromEntries(hints.map((h) => [bodyKey(h.path), h.matrix]));
  const assembly = assemble(system, lookup, { root: rootPath ?? defaultRoot(system, lookup), fixed });
  const defs = new Map(assembly.instances.map((i) => [bodyKey(i.path), i.def]));
  const bodies: CadBody[] = assembly.placements.flatMap((p: Placement) => {
    // a module with children of its own (a board) is placed by its own mates, and the system itself can be the root
    const def = defs.get(bodyKey(p.path)) ?? defAt(system, lookup, p.path);
    if (!def) return [];
    defs.set(bodyKey(p.path), def);
    const glb = glbFor(def, p.body);
    const hint = hints.find((h) => bodyKey(h.path) === p.key)?.note;
    // a GLB generated from nothing else (a provider's board.glb) is its own source: its manifest is generated from it
    return [{ key: p.key, path: p.path, def, glb, bodyArtifact: p.body ?? sourceOf(def, glb) ?? glb?.id, matrix: p.matrix, via: p.via, hint }];
  });
  // instances inside a placed body that has a GLB of its own are drawn by it (a board's components in board.glb)
  const within = new Map<string, string>();
  for (const inst of assembly.instances) {
    const holder = bodies.filter((b) => b.glb && !b.key.includes("#") && b.path.length < inst.path.length && b.path.every((x, i) => inst.path[i] === x)).sort((a, b) => b.path.length - a.path.length)[0];
    if (holder) within.set(bodyKey(inst.path), holder.key);
  }
  return { assembly, bodies, defs, manifests, within };
}

/**
 * The named bodies a GLB comes apart into when exploded (D17): the largest
 * stays, the rest move away from it. Only a cad standard output does this:
 * `body.glb` with a `body.manifest.json` generated from it, whose `bodies`
 * lists two or more (an enclosure's back and lid). A vendor or library part's
 * GLB stays rigid even when its manifest names several bodies (a motor's bell
 * and stator, a prop's hub and blades).
 */
export function explodeParts(def: ModuleDef, glb: ArtifactDef | undefined, manifest: GeometryManifest | undefined): { fixed: string; moving: string[] } | undefined {
  const cad = cadOutputs(def);
  if (!glb || !cad?.glb || cad.glb.id !== glb.id || cad.manifest?.provenance?.generatedFrom !== glb.id) return undefined;
  const named = Object.entries(manifest?.bodies ?? {}).sort((a, b) => b[1] - a[1]);
  if (named.length < 2) return undefined;
  return { fixed: named[0][0], moving: named.slice(1).map(([n]) => n) };
}

export function interfaceRows(def: ModuleDef, manifests: Map<string, GeometryManifest>): InterfaceRow[] {
  const manifestFor = (artifactId: string) => manifests.get(`${def.id}:${artifactId}`);
  const issues = checkGeometryBindings(def, manifestFor);
  const artifacts = new Map((def.artifacts ?? []).map((a) => [a.id, a]));
  return def.interfaces.map((iface) => {
    const g = interfaceGeometry(def, iface.id);
    const own = issues.filter((i) => i.interfaceId === iface.id || g.sources.includes(i.interfaceId));
    const byDirection: InterfaceRow["byDirection"] = { feature: [], artifact: [], procedural: [] };
    for (const { interfaceId, ref } of g.refs) {
      let status: BindingStatus = "bound";
      let note: string | undefined;
      if (ref.kind === "feature") {
        const art = artifacts.get(ref.artifact);
        const m = manifestFor(ref.artifact);
        if (art?.format === "kcl") {
          status = "unchecked";
          note = `KCL tag $${ref.name} in ${art.filePath?.split("/").pop()} — resolved by running the KCL`;
        } else if (!m) status = "unchecked";
        else if (!m.features[ref.name]) status = "missing";
        else if (own.some((i) => i.interfaceId === interfaceId && i.message.includes(`"${ref.name}"`) && i.message.includes("changed"))) status = "stale";
      }
      if (ref.kind === "artifact") {
        const art = artifacts.get(ref.artifact);
        if (!art) status = "missing";
        else if (art.format === "kcl") {
          status = "unchecked";
          note = `${art.filePath?.split("/").pop()} (KCL, not exported yet)`;
        }
      }
      byDirection[ref.kind].push({ interfaceId, ref, status, note });
    }
    return {
      iface,
      frame: iface.geometry?.frame,
      sources: g.sources,
      refs: g.refs,
      logical: g.logical,
      unmapped: !g.logical && g.frames.length === 0 && g.refs.length === 0,
      byDirection,
      issues: own,
    };
  });
}

/** Bolt-pattern / shaft parameters for procedural geometry (D3). */
export function param(iface: InterfaceDef, id: string): number | undefined {
  const p = iface.parameters?.find((x) => x.id === id);
  return p?.value ?? p?.range?.[0];
}
export function traitParam<T>(iface: InterfaceDef, type: string, key: string): T | undefined {
  return iface.traits?.find((t) => t.type === type)?.params?.[key] as T | undefined;
}

/**
 * The instance the assembly is placed from when the display hints don't say:
 * the system itself when it has a body of its own, else the top-level module
 * with the most interface frames (the structure the others mount to).
 */
export function defaultRoot(system: ModuleDef, lookup: (id: string) => ModuleDef | undefined): string[] {
  // a system with a body of its own (a board as the bundle's root) is placed from itself
  if (glbFor(system)) return [];
  let best: { id: string; frames: number } | undefined;
  for (const c of system.children ?? []) {
    const def = lookup(c.moduleDefId);
    if (!def || def.kind === "harness") continue;
    const frames = def.interfaces.filter((i) => i.geometry?.frame).length;
    if (frames && (!best || frames > best.frames)) best = { id: c.id, frames };
  }
  return best ? [best.id] : [];
}
