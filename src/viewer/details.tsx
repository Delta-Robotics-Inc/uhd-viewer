/**
 * The inspector's details for one thing of a bundle, without a viewer around
 * it: what `ViewerInspector` shows for a selected module, link or net, for a
 * host that has an inspector of its own (a native side view) and selects by
 * path. The same components draw both, so a host's inspector and the
 * viewer's show a module the same way.
 *
 *   <ThemeProvider adapter={vscodeThemeAdapter()}>
 *     <SelectionDetails bundle={bundle} target={{ kind: "module", path: "stack/esc" }} host={{ openArtifact }} />
 *   </ThemeProvider>
 *
 * The level that holds the target is modelled as the viewer models it (its
 * links, nets and checks), but nothing is laid out or drawn.
 */
import { useMemo, type ReactNode } from "react";
import type { ModuleDef } from "@uhd/types/index.js";
import type { ModuleLookup } from "@uhd/system/index.js";
import type { UhdBundle } from "@uhd/types/bundle.js";
import type { ArtifactResolver } from "../api";
import type { Selection } from "../canvas/Canvas";
import { LinkDetails, NodeDetails } from "../chrome/Chrome";
import { AssemblyArtifacts, ArtifactsSection } from "../chrome/Artifacts";
import { BoardViews, DerivedDetails, DerivedList } from "../chrome/BoardInspector";
import { PairPreview, pairEnds } from "../chrome/PairView";
import { HostContext, type HostActions } from "../host/context";
import { defAt } from "../cad/model";
import { drillTarget, focusTarget, fullId, instancePrefix, selectTarget } from "../host/targets";
import type { Classification } from "../model/classification";
import { systemDiagnostics } from "../model/diagnostics";
import { buildView, levelModule } from "../model/from-uhd";
import { circuitOutputs } from "../model/outputs";
import type { ViewLink, ViewModel, ViewNode } from "../model/types";
import { sourceFromBundle } from "../source/source";

/** What to show: a module instance by its path from the root (`""`: the root), a link on the level of its owner, or a definition on its own. */
export type DetailsTarget =
  | { kind: "module"; path: string }
  | { kind: "link"; owner: string; ids: string[] }
  | { kind: "definition"; id: string };

export interface SelectionDetailsProps {
  /** The bundle the target is in. Not given: only `definition` targets among `definitions` can be shown. */
  bundle?: UhdBundle;
  /** Definitions outside the bundle (a library part shown on its own), by their ids. */
  definitions?: ModuleDef[];
  target: DetailsTarget;
  /** URL of a definition's artifact file; not given, files do not resolve (their cards show icons). */
  resolveArtifact?: ArtifactResolver;
  /** What the host takes over, and how artifacts are shown (host/context.ts). */
  host?: HostActions;
  /** How interface swatches are coloured (default: by domain). */
  mode?: Classification;
  /** A board's drawings with pan and zoom, as in the viewer (default false: the drawings are cards, nothing is fetched). */
  boardDrawings?: boolean;
  /** The user picked something else in the details (an end of a link, a net's member, a functional link): canonical ids from the root. */
  onSelect?: (selection: { kind: "node" | "link"; id: string }) => void;
  /** The user asked for the pair view of the link shown. */
  onPair?: (request: { linkId: string; a: string; b: string }) => void;
  /** Shown when the target is not in the bundle. */
  missing?: ReactNode;
  className?: string;
}

const NO_FILES: ArtifactResolver = () => undefined;
const NONE = new Set<string>();

interface Resolved {
  vm: ViewModel;
  drill: string[];
  node?: ViewNode;
  link?: ViewLink;
  derived?: ViewModel["derived"][number];
  levelDef?: ModuleDef;
}

/** A definition shown on its own: the one child of an empty module, so its ports and package read as in a system. */
function alone(def: ModuleDef, lookup: ModuleLookup, path = ""): Resolved {
  const root = { id: "\u0000details", name: def.name, kind: "module", interfaces: [], children: [{ id: "it", moduleDefId: def.id, name: def.name }], links: [] } as unknown as ModuleDef;
  const vm = buildView(root, (id) => (id === def.id ? def : lookup(id)), [], { expanded: NONE });
  const node = vm.nodes.find((n) => n.id === "it");
  // its path when it is an instance the diagram does not draw; none for a definition
  return { vm: { ...vm, links: [], derived: [] }, drill: [], ...(node ? { node: { ...node, id: path } } : {}) };
}

export function SelectionDetails({ bundle, definitions, target, resolveArtifact = NO_FILES, host, mode = "domain", boardDrawings = false, onSelect, onPair, missing = null, className }: SelectionDetailsProps) {
  const source = useMemo(() => {
    if (!bundle) return undefined;
    try {
      return sourceFromBundle(bundle, "about:blank");
    } catch {
      return undefined;
    }
  }, [bundle]);
  const scenario = source?.scenarios[0];
  const lookup = useMemo<ModuleLookup>(() => {
    const extra = new Map((definitions ?? []).map((d) => [d.id, d]));
    return (id: string) => extra.get(id) ?? scenario?.lookup(id);
  }, [definitions, scenario]);
  // the root's checks (and each board's): what gives links their state, as in the viewer
  const diagnostics = useMemo(() => {
    if (!scenario) return [];
    try {
      return systemDiagnostics(scenario.system, scenario.lookup);
    } catch {
      return [];
    }
  }, [scenario]);

  const key = JSON.stringify(target);
  const found = useMemo<Resolved | undefined>(() => {
    try {
      if (target.kind === "definition") {
        const def = lookup(target.id);
        return def ? alone(def, lookup) : undefined;
      }
      if (!scenario) return undefined;
      const { system } = scenario;
      if (target.kind === "module") {
        const t = focusTarget(system, lookup, target.path, { drill: [], expanded: NONE });
        // the root is not drawn on any level: shown on its own
        if (!t.selection) return target.path.split("/").filter(Boolean).length ? undefined : alone(system, lookup);
        const vm = buildView(system, lookup, t.drill, { expanded: NONE, diagnostics });
        const node = vm.nodes.find((n) => n.id === t.selection!.id);
        if (node) return { vm, drill: t.drill, node, levelDef: levelModule(system, t.drill, lookup).def };
        // an instance the diagram does not draw as a node (a fastener stack, a harness that carries no link here): its definition, at its path
        const parts = target.path.split("/").filter(Boolean);
        const def = defAt(system, lookup, parts);
        return def && instancePrefix(system, lookup, parts).length === parts.length ? alone(def, lookup, parts.join("/")) : undefined;
      }
      const drill = drillTarget(system, lookup, target.owner);
      // a link declared by a module the level does not open (a harness): drawn when that module is expanded in place
      const rest = target.owner.split("/").filter(Boolean).slice(drill.length);
      const vm = buildView(system, lookup, drill, { expanded: rest.length ? new Set([rest[0]]) : NONE, diagnostics });
      const sel = selectTarget(vm, drill, target.ids);
      if (!sel) return undefined;
      const levelDef = levelModule(system, drill, lookup).def;
      if (sel.kind === "node") return { vm, drill, node: vm.nodes.find((n) => n.id === sel.id), levelDef };
      const link = vm.links.find((l) => l.linkId === sel.id);
      return link ? { vm, drill, link, levelDef } : { vm, drill, derived: vm.derived.find((d) => d.id === sel.id), levelDef };
    } catch {
      return undefined;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, scenario, lookup, diagnostics]);

  const actions = useMemo<HostActions>(() => ({ artifactModels: "cards", ...host }), [host]);
  if (!found || (!found.node && !found.link && !found.derived)) return <>{missing}</>;
  const { vm, drill, node, link, derived } = found;
  const defFor = (id?: string) => (id ? lookup(id) : undefined);
  const select = (s: Selection) => s && onSelect?.({ kind: s.kind, id: fullId(drill, s.id) });
  const appearance = source?.display.spatial?.appearance;

  /** A board's outputs: the module's own, or (with drawings) the board it is a component of, marking it. */
  const boardFor = (n: ViewNode): ReactNode => {
    const own = defFor(n.defId);
    if (n.kind !== "net" && circuitOutputs(own)) return <BoardViews def={own!} lookup={lookup} resolve={resolveArtifact} drawings={boardDrawings} onPick={(instance) => onSelect?.({ kind: "node", id: fullId([...drill, ...n.id.split("/").filter(Boolean)], instance) })} />;
    if (!boardDrawings || !found.levelDef || !circuitOutputs(found.levelDef)) return null;
    return <BoardViews def={found.levelDef} lookup={lookup} resolve={resolveArtifact} highlight={n.id} onPick={(instance) => select({ kind: "node", id: instance })} />;
  };

  return (
    <HostContext.Provider value={actions}>
      <div className={`uhd-selection-details${className ? ` ${className}` : ""}`}>
        {node ? (
          <NodeDetails
            bare
            node={node}
            vm={vm}
            mode={mode}
            def={defFor(node.defId)}
            onDrill={() => undefined}
            onToggleExpand={() => undefined}
            onSelect={select}
            board={boardFor(node)}
            artifacts={<AssemblyArtifacts key={node.defId} def={defFor(node.defId)} lookup={defFor} resolve={resolveArtifact} appearance={appearance} />}
          />
        ) : link ? (
          <LinkDetails
            bare
            link={link}
            mode={mode}
            open={false}
            onToggle={() => undefined}
            onPair={() => undefined}
            preview={
              !link.net && (
                <PairPreview
                  vm={vm}
                  link={link}
                  mode={mode}
                  onOpen={() => {
                    const ends = pairEnds(vm, link);
                    onPair?.({ linkId: fullId(drill, link.linkId), a: fullId(drill, ends.a.node), b: fullId(drill, ends.b.node) });
                  }}
                />
              )
            }
            bSlots={[]}
            harness={link.run && <ArtifactsSection def={defFor(link.run.defId)} resolve={resolveArtifact} appearance={appearance?.[link.run.defId]} />}
            derived={link.net && <DerivedList items={vm.derived.filter((d) => d.via.includes(link.id))} title="FUNCTIONAL LINKS OVER THESE PINS" onSelect={select} />}
          />
        ) : (
          <DerivedDetails bare d={derived!} vm={vm} onSelect={select} />
        )}
      </div>
    </HostContext.Provider>
  );
}
