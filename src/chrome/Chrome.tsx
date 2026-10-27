import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ChildLink, ModuleDef } from "@uhd/types/index.js";
import type { UhdBundleDiagnostic } from "@uhd/types/bundle.js";
import type { ScopedDiagnostic } from "../model/diagnostics";
import { circuitOutputs } from "../model/outputs";
import { BoardViews, DerivedDetails, DerivedList, NetDetails, PackageSection, PinTable } from "./BoardInspector";
import { partPackage } from "@uhd/protocols/package.js";
import type { ViewLink, ViewModel, ViewNode } from "../model/types";
import { ArtifactsSection, type ArtifactResolver } from "./Artifacts";
import type { Appearance } from "../source/source";
import { colorFor, type Classification } from "../model/classification";
import { EvidenceSection, hasEvidence } from "./Evidence";
import { evidenceFor } from "../model/evidence";
import { artifactCards, groupArtifactCards } from "../model/artifacts";
import { checkFindings, interfaceSlots, levelNames, sentence, slotSummary, type HostFinding } from "../model/slots";
import { ClampedText, DetailsSection, KeyValues, LIST_STEP, SelectionKey, Sections, useLoadMore } from "./Sections";
import { InterfaceCards, type InterfaceCardActions } from "./InterfaceCards";
import { Icon } from "../canvas/Icon";
import type { Selection } from "../canvas/Canvas";
import { fullId, linkOwner, selectableLink } from "../host/targets";
import { useHost } from "../host/context";
import { ScrollArea } from "../ui/ScrollArea";
import { IconButton } from "../ui/Toolbar";
import { PairPreview } from "./PairView";

export type Panel = "hierarchy" | "checks";

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

/** A module's (or a link's) facts as key and value rows; empty values are left out. */
function factRows(rows: [string, string | undefined][]): { key: string; value: string }[] {
  return rows.filter((r): r is [string, string] => Boolean(r[1])).map(([key, value]) => ({ key, value }));
}

/**
 * "4 models · 2 docs · 1 evidence": what a definition's own artifacts are, by group. A parent's are its own only
 * (PB-1088): its children's are theirs, a selection away.
 */
export function artifactSummary(def: ModuleDef | undefined, _lookup?: (id?: string) => ModuleDef | undefined): { count: number; text: string } {
  if (!def) return { count: 0, text: "" };
  // a board's drawings and outputs are the Board section's (ArtifactsSection leaves them out too)
  const outs = circuitOutputs(def);
  const board = new Set(outs ? Object.values(outs).filter(Boolean) : []);
  const cards = artifactCards(def, () => undefined, { skip: (a) => board.has(a) });
  const WORD: Record<string, [string, string]> = {
    images: ["image", "images"],
    models: ["model", "models"],
    board: ["drawing", "drawings"],
    datasheets: ["datasheet", "datasheets"],
    documents: ["doc", "docs"],
    evidence: ["evidence", "evidence"],
    design: ["design file", "design files"],
    data: ["data file", "data files"],
  };
  const groups = groupArtifactCards(cards);
  return { count: cards.length, text: groups.map((g) => `${g.cards.length} ${WORD[g.id][g.cards.length === 1 ? 0 : 1]}`).join(" · ") };
}

const STATE_WORD: Record<string, string> = { configured: "Configured", partial: "Warning", incompatible: "Incompatible", unconfigured: "Not configured" };
const STATE_VAR: Record<string, string> = { configured: "var(--uhd-severity-ok)", partial: "var(--uhd-severity-warning)", incompatible: "var(--uhd-severity-error)", unconfigured: "var(--uhd-text-faint)" };

/** A link's state as a dot and its word. */
function StateValue({ state }: { state: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className="size-[7px] shrink-0 rounded-full" style={{ background: STATE_VAR[state] }} />
      <span style={{ color: STATE_VAR[state] }}>{STATE_WORD[state] ?? state}</span>
    </span>
  );
}

export interface NodeDetailsProps {
  node: ViewNode;
  vm: ViewModel;
  mode: Classification;
  def?: ModuleDef;
  onDrill: (id: string) => void;
  onToggleExpand: (id: string) => void;
  onSelect: (s: Selection) => void;
  /** Thumbnail and CAD preview. */
  artifacts?: React.ReactNode;
  /** The board's drawings: this node's own, or those of the board it sits on, with it marked. */
  board?: React.ReactNode;
  /** Ask the host to open the module's source (only when a host takes it). */
  onOpenSource?: () => void;
  /** No title and no action buttons: the host draws its own header and actions. */
  bare?: boolean;
  /** Definitions by id (the interface cards read the module's children and the other ends). */
  lookup?: (id?: string) => ModuleDef | undefined;
  /** The level shown, from the root: canonical ids for findings and Locate. */
  drill?: string[];
  /** Names as written, by node id on the level; link names by link id. */
  names?: Map<string, string>;
  linkNames?: Map<string, string>;
  /** Findings to show on the interface cards (the host's, with keys; else the viewer's own checks). */
  findings?: HostFinding[];
  /** What the interface cards' actions do. */
  cardActions?: InterfaceCardActions;
}

export function NodeDetails(props: NodeDetailsProps) {
  if (props.node.net) return <NetDetails node={props.node} vm={props.vm} onSelect={props.onSelect} bare={props.bare} />;
  return <ModuleDetails {...props} />;
}

/**
 * A module in sections (PB-1042, design A): its parameters, its board, its
 * interfaces as slot cards, its artifacts, then what is secondary, closed,
 * with what it holds in the header: the package, the pins, the functional
 * links and the evidence.
 */
function ModuleDetails({ node, vm, def, onDrill, onToggleExpand, onSelect, artifacts, board, onOpenSource, bare, lookup, drill, names, linkNames, findings, cardActions }: NodeDetailsProps) {
  const host = useHost();
  const find = lookup ?? ((id?: string) => (id && id === def?.id ? def : undefined));
  const ev = evidenceFor(def, def ? host.evidence?.(def.id) : undefined);
  const performance = (ev?.performance ?? []).flatMap((p) => p.facts.map(([k, v]) => ({ key: k[0].toUpperCase() + k.slice(1), value: v })));
  const params = [
    ...factRows([
      ["Kind", node.kind[0].toUpperCase() + node.kind.slice(1)],
      ["Definition", node.defId],
      ["Manufacturer", node.manufacturer],
      ["Part number", node.partNumber],
      ["Path", node.id || undefined],
    ]),
    ...performance,
  ];
  const more = useLoadMore(params.length);
  const slots = useMemo(
    () => (node.kind === "harness" ? [] : interfaceSlots(node, vm, { lookup: (id) => find(id), drill, names, linkNames, findings })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [node, vm, def, drill?.join("/"), names, linkNames, findings],
  );
  const summary = slotSummary(slots);
  const arts = artifactSummary(def, find);
  const derived = vm.derived.filter((d) => d.a.node === node.id || d.b.node === node.id);
  const pins = (def?.interfaces ?? []).filter((i) => i.pin !== undefined).length;
  const pkg = def ? partPackage(def) : undefined;
  return (
    <div className="details uhd-details-a">
      {!bare && (
        <div className="details-title">
          <Icon name={node.icon} size={16} />
          <span>{node.label}</span>
        </div>
      )}
      {!bare && (node.childCount > 0 || onOpenSource) && (
        <div className="actions">
          {node.childCount > 0 && <button onClick={() => onToggleExpand(node.id)}>{node.expanded ? "COLLAPSE" : "EXPAND IN PLACE"}</button>}
          {node.childCount > 0 && <button onClick={() => onDrill(node.id)}>OPEN AS CANVAS</button>}
          {onOpenSource && (
            <button className="open-source" onClick={onOpenSource}>
              OPEN SOURCE
            </button>
          )}
        </div>
      )}
      <Sections label={`${node.label} details`}>
        {/* a long description is cut to five lines, with More (PB-1088); long design notes belong in the docs */}
        <DetailsSection id="parameters" title="Parameters">
          {node.description && <ClampedText key={node.description} text={node.description} lines={5} className="text-[11px] leading-[1.5] text-fg-muted" />}
          <KeyValues rows={params} limit={more.limit} />
          {more.footer}
        </DetailsSection>
        {board && (
          <DetailsSection id="board" title="Board">
            {board}
          </DetailsSection>
        )}
        {node.kind !== "harness" && slots.length > 0 && (
          <DetailsSection id="interfaces" title="Interfaces" count={summary.total} summary={summary.text}>
            <InterfaceCards key={node.id} slots={slots} first={LIST_STEP} actions={cardActions ?? { selectLink: (id) => onSelect({ kind: "link", id }) }} />
          </DetailsSection>
        )}
        {artifacts && arts.count > 0 && (
          <DetailsSection id="artifacts" title="Artifacts" count={arts.count} summary={arts.text}>
            {artifacts}
          </DetailsSection>
        )}
        {pkg && (
          <DetailsSection id="package" title="Package" summary={pkg.name ?? pkg.code} defaultOpen={false}>
            <PackageSection def={def} titled={false} />
          </DetailsSection>
        )}
        {pins > 0 && node.kind !== "harness" && (
          <DetailsSection id="pins" title="Pins" count={pins} defaultOpen={false}>
            <PinTable def={def} node={node} vm={vm} titled={false} />
          </DetailsSection>
        )}
        {derived.length > 0 && (
          <DetailsSection id="functional-links" title="Functional links" count={derived.length} summary={derived.slice(0, 3).map((d) => d.name).join(", ")} defaultOpen={false}>
            <DerivedList items={derived} title="FUNCTIONAL LINKS" onSelect={onSelect} titled={false} />
          </DetailsSection>
        )}
        {hasEvidence(ev, false) && (
          <DetailsSection
            id="evidence"
            title="Evidence"
            summary={[ev!.sources.length ? `${ev!.sources.length} source${ev!.sources.length === 1 ? "" : "s"}` : "", ev!.assumptions.length ? `${ev!.assumptions.length} assumed` : ""].filter(Boolean).join(" · ")}
            defaultOpen={false}
          >
            <EvidenceSection def={def} titled={false} performance={false} />
          </DetailsSection>
        )}
      </Sections>
    </div>
  );
}

export function LinkDetails({
  link,
  mode,
  open,
  onToggle,
  onPair,
  bSlots,
  override,
  onOverride,
  harness,
  derived,
  onOpenSource,
  preview,
  bare,
}: {
  /** No title and no action buttons: the host draws its own header and actions. */
  bare?: boolean;
  /** Ask the host to open the source that declares the link (only when a host takes it). */
  onOpenSource?: () => void;
  /** The pair the link joins, small (its button opens the pair view). */
  preview?: React.ReactNode;
  /** The harness carrying the link: its artifacts (thumbnail, CAD). */
  harness?: React.ReactNode;
  /** Functional links that run over this line (a grouped net membership). */
  derived?: React.ReactNode;
  link: ViewLink;
  mode: Classification;
  open: boolean;
  onToggle: (id: string) => void;
  onPair: () => void;
  /** Child slots on the b side, for remapping. */
  bSlots: string[];
  override?: ChildLink[];
  onOverride?: (childLinks: ChildLink[] | null) => void;
}) {
  const color = colorFor(link, mode);
  const [editing, setEditing] = useState(false);
  const canRemap = Boolean(onOverride) && link.children.length > 1 && bSlots.length > 1;
  /** Choosing a slot swaps it with the row that held it, so each conductor keeps a distinct slot. */
  const remap = (index: number, b: string) => {
    const targets = link.children.map((c) => c.b);
    const holder = targets.indexOf(b);
    if (holder >= 0 && holder !== index) targets[holder] = targets[index];
    targets[index] = b;
    onOverride?.(link.children.map((c, i) => ({ a: c.a, b: targets[i], locked: true })));
  };
  const facts = [
    ...factRows([
      ["Protocol", link.protocol],
      ["Domain", link.domain],
    ]),
    { key: "State", value: <StateValue state={link.state} /> },
    ...factRows([
      ["Harness", link.run ? sentence(link.run.name) : link.harness],
      ["Net", link.net?.name],
    ]),
  ];
  return (
    <div className="details uhd-details-a">
      {!bare && (
        <div className="details-title">
          <Icon name="cable" size={16} color={color} />
          <span>{link.name.toUpperCase()}</span>
        </div>
      )}
      {!bare && (
        <div className="actions">
          {!link.net && !preview && <button onClick={onPair}>PAIR VIEW</button>}
          {link.children.length > 1 && <button onClick={() => onToggle(link.linkId)}>{open ? "CLOSE LINK" : "OPEN LINK"}</button>}
          {onOpenSource && (
            <button className="open-source" onClick={onOpenSource}>
              OPEN SOURCE
            </button>
          )}
        </div>
      )}
      <Sections label={`${link.name} details`}>
        <DetailsSection id="link-parameters" title="Parameters">
          <KeyValues rows={facts} />
          {preview && <div className="pt-1.5">{preview}</div>}
        </DetailsSection>
        {link.children.length > 0 && (
          <DetailsSection
            id="link-children"
            title={link.net ? "Pins on the net" : "Conductors"}
            count={link.children.length}
            summary={link.manual ? "stored" : undefined}
            aside={
              canRemap ? (
                <span className="ml-auto flex shrink-0 gap-1">
                  <button className="mini" onClick={() => setEditing((e) => !e)}>
                    {editing ? "Done" : "Remap"}
                  </button>
                  {override && (
                    <button className="mini" onClick={() => onOverride?.(null)}>
                      Reset
                    </button>
                  )}
                </span>
              ) : undefined
            }
          >
            <div className="flex flex-col gap-[3px]">
              {link.children.map((c, i) => (
                <div key={c.id} className="flex min-h-5 min-w-0 items-center gap-2 text-[11px] leading-none" data-conductor={c.id}>
                  <span className="inline-flex h-4 shrink-0 items-center rounded-[4px] border border-line px-1 text-[10px] text-fg-muted">{link.net ? c.label : c.a}</span>
                  {c.aPin && <span className="shrink-0 text-fg-faint">{c.aPin}</span>}
                  <span className="shrink-0 text-fg">→</span>
                  {editing ? (
                    <select value={c.b} onChange={(e) => remap(i, e.target.value)} className="min-w-0">
                      {bSlots.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="shrink-0 text-fg">{c.b}</span>
                  )}
                  {c.bPin && <span className="min-w-0 truncate text-fg-faint">{c.bPin}</span>}
                  <span aria-label={STATE_WORD[c.state]} className="ml-auto size-[7px] shrink-0 rounded-full" style={{ background: STATE_VAR[c.state] }} />
                </div>
              ))}
            </div>
          </DetailsSection>
        )}
        {harness && (
          <DetailsSection id="link-harness" title="Harness" summary={link.run ? sentence(link.run.name) : link.harness} defaultOpen={false}>
            {harness}
          </DetailsSection>
        )}
        {derived && (
          <DetailsSection id="link-derived" title="Functional links" defaultOpen={false}>
            {derived}
          </DetailsSection>
        )}
        {link.diagnostics.length > 0 && (
          <DetailsSection id="link-checks" title="Checks" count={link.diagnostics.length}>
            {link.diagnostics.map((d) => (
              <div key={d} className="flex items-start gap-2 py-1 text-[11px] leading-[1.4]">
                <Icon name={link.state === "incompatible" ? "circle-x" : "triangle-alert"} size={13} strokeWidth={1.75} aria-hidden className="mt-px shrink-0" style={{ color: STATE_VAR[link.state] }} />
                <span className="min-w-0 text-fg">{d}</span>
              </div>
            ))}
          </DetailsSection>
        )}
      </Sections>
    </div>
  );
}

function Hierarchy({
  vm,
  selection,
  onSelect,
  board,
  onContext,
}: {
  vm: ViewModel;
  selection: Selection;
  onSelect: (s: Selection) => void;
  board?: React.ReactNode;
  /** Right-click on a module: its context menu at the pointer. */
  onContext?: (id: string, x: number, y: number) => void;
}) {
  const roots = vm.nodes.filter((n) => !n.parent && !n.sheetPort && n.kind !== "net");
  const kids = (id: string) => vm.nodes.filter((n) => n.parent === id && n.kind !== "net");
  const nets = vm.nodes.filter((n) => n.kind === "net");
  const links = vm.links.filter((l) => !l.passThrough && l.segment !== "b" && !l.net);
  const item = (n: ViewNode, depth: number): React.ReactNode => (
    <div key={n.id}>
      <button
        className={`tree-item${selection?.kind === "node" && selection.id === n.id ? " on" : ""}`}
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => onSelect({ kind: "node", id: n.id })}
        onContextMenu={
          onContext &&
          ((e) => {
            e.preventDefault();
            onSelect({ kind: "node", id: n.id });
            onContext(n.id, e.clientX, e.clientY);
          })
        }
      >
        <Icon name={n.icon} size={12} />
        <span>{n.label}</span>
        {n.kind !== "module" && <span className="tree-tag">{n.kind.toUpperCase()}</span>}
      </button>
      {kids(n.id).map((k) => item(k, depth + 1))}
    </div>
  );
  return (
    <div className="hierarchy">
      {board}
      <div className="section-title">MODULES · {vm.nodes.filter((n) => !n.sheetPort && n.kind !== "net").length}</div>
      {roots.map((n) => item(n, 0))}
      {nets.length > 0 && (
        <>
          <div className="section-title">NETS · {nets.length}</div>
          {nets.map((n) => (
            <button key={n.id} className={`tree-item${selection?.kind === "node" && selection.id === n.id ? " on" : ""}`} onClick={() => onSelect({ kind: "node", id: n.id })}>
              <span className={`state-dot ${n.status}`} />
              <span>{n.label}</span>
              <span className="tree-tag">{n.net?.voltage ?? n.net?.signal}</span>
            </button>
          ))}
        </>
      )}
      {links.length > 0 && <div className="section-title">LINKS · {links.length}</div>}
      {links.map((l) => (
        <button
          key={l.id}
          className={`tree-item${selection?.kind === "link" && selection.id === l.linkId ? " on" : ""}`}
          onClick={() => onSelect({ kind: "link", id: l.linkId })}
        >
          <span className={`state-dot ${l.state}`} />
          <span>{l.name.toUpperCase()}</span>
          <span className="tree-tag">{l.protocol}</span>
        </button>
      ))}
      <DerivedList items={vm.derived} title="FUNCTIONAL LINKS (DERIVED)" onSelect={onSelect} />
    </div>
  );
}

const SEVERITY_ICON = { error: "octagon-x", warning: "triangle-alert", info: "info" } as const;

/** Where to go for a finding: a drill path and what to select there. */
export interface Goto {
  drill: string[];
  selection: Selection;
}


/**
 * What a canonical path (`u2:pin_14`, `board/u2`, `:sda`) is on this level:
 * the node itself, its net junction, or the node that contains it.
 */
function nodeFor(vm: ViewModel, path: string): Selection {
  if (vm.nodes.some((n) => n.id === path)) return { kind: "node", id: path };
  const [modules] = path.split(":");
  const parts = modules.split("/");
  for (let i = parts.length; i > 0; i--) {
    const id = parts.slice(0, i).join("/");
    if (vm.nodes.some((n) => n.id === id)) return { kind: "node", id };
  }
  return null;
}

/** What a producer finding is about: on this level, or inside a module on it (drilled into). */
function hostTarget(d: UhdBundleDiagnostic, vm: ViewModel, drill: string[]): Goto | null {
  const e = d.entity;
  if (!e) return null;
  if (e.kind === "link") {
    const sel = selectableLink(vm, e.id);
    return sel ? { drill, selection: sel } : null;
  }
  if (e.kind === "definition") {
    const node = vm.nodes.find((n) => n.defId === e.id);
    return node ? { drill, selection: { kind: "node", id: node.id } } : null;
  }
  const [modules] = e.id.split(":");
  const parts = modules ? modules.split("/") : [];
  // inside a child with children of its own (a component on a board): open the child and select it there
  const first = vm.nodes.find((n) => n.id === parts[0] && n.childCount > 0 && !n.expanded);
  if (first && parts.length > 1) return { drill: [...drill, parts[0]], selection: { kind: "node", id: parts[1] } };
  const sel = nodeFor(vm, e.id);
  return sel ? { drill, selection: sel } : null;
}

function Checks({
  diagnostics,
  host,
  vm,
  drill,
  onGoto,
}: {
  diagnostics: ScopedDiagnostic[];
  host: UhdBundleDiagnostic[];
  vm: ViewModel;
  drill: string[];
  onGoto: (g: Goto) => void;
}) {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const d of [...diagnostics, ...host]) counts[d.severity]++;
  const here = drill.join("/");
  /** A finding of this level resolves against what is drawn; one of another level opens that level. */
  const target = (d: ScopedDiagnostic): Goto | null => {
    const scope = d.scope;
    const strip = (r: string) =>
      !scope ? r : r.startsWith(`link:${scope}/`) ? `link:${r.slice(6 + scope.length)}` : r.startsWith(`${scope}/`) ? r.slice(scope.length + 1) : r.startsWith(`${scope}:`) ? r.slice(scope.length) : r;
    const refs = d.refs.map(strip);
    const link = refs.find((r) => r.startsWith("link:"))?.slice(5);
    const paths = refs.filter((r) => !r.startsWith("link:"));
    if (scope === here) {
      const sel = (link && selectableLink(vm, link)) || paths.map((r) => nodeFor(vm, r)).find(Boolean) || null;
      return sel ? { drill, selection: sel } : null;
    }
    const node = paths[0];
    return {
      drill: scope ? scope.split("/") : [],
      selection: link ? { kind: "link", id: link } : node ? { kind: "node", id: node.startsWith(":") ? node : node.split(":")[0].split("/")[0] } : null,
    };
  };
  return (
    <div className="checks">
      <div className="check-summary">
        <span className="sev error">{counts.error} ERRORS</span>
        <span className="sev warning">{counts.warning} WARNINGS</span>
        <span className="sev info">{counts.info} INFO</span>
      </div>
      {diagnostics.map((d) => (
        <button key={d.id} className={`check ${d.severity}`} onClick={() => onGoto(target(d) ?? { drill, selection: null })}>
          <Icon name={SEVERITY_ICON[d.severity]} size={13} />
          <span className="check-body">
            <span className="check-rule">
              {d.rule.replace(/_/g, " ").toUpperCase()}
              {d.scope && <span className="check-scope"> · IN {d.scope.toUpperCase()}</span>}
            </span>
            <span className="check-msg">{d.message}</span>
          </span>
        </button>
      ))}
      {host.length > 0 && <div className="section-title">FROM THE PRODUCER · {host.length}</div>}
      {host.map((d, i) => (
        <button key={`${d.code}:${d.entity?.id ?? i}`} className={`check ${d.severity}`} onClick={() => onGoto(hostTarget(d, vm, drill) ?? { drill, selection: null })}>
          <Icon name={SEVERITY_ICON[d.severity]} size={13} />
          <span className="check-body">
            <span className="check-rule">
              {d.code.replace(/_/g, " ")}
              {d.entity ? ` · ${d.entity.id}` : ""}
            </span>
            <span className="check-msg">{d.message}</span>
            {d.validator && <span className="check-rule muted">{d.validator}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}

function InspectorView(props: {
  className?: string;
  vm: ViewModel;
  panel: Panel;
  onPanel: (p: Panel) => void;
  selection: Selection;
  mode: Classification;
  openLinks: Set<string>;
  diagnostics: ScopedDiagnostic[];
  /** Findings from the bundle's producer and the host (UHD's own checks excluded: the viewer runs them). */
  hostDiagnostics: UhdBundleDiagnostic[];
  defFor: (defId?: string) => ModuleDef | undefined;
  /** Artifact URLs (from the bundle source) and per-definition appearance hints, for the previews. */
  resolveArtifact: ArtifactResolver;
  appearance?: Record<string, Appearance>;
  bSlotsFor: (link: ViewLink) => string[];
  overrides: Record<string, ChildLink[]>;
  onOverride: (linkId: string, childLinks: ChildLink[] | null) => void;
  onSelect: (s: Selection) => void;
  onDrill: (id: string) => void;
  onToggleLink: (id: string) => void;
  onToggleExpand: (id: string) => void;
  onPair: (link: ViewLink) => void;
  topLevel: boolean;
  /** The module shown at this level and its drill path (for its board drawings and for findings elsewhere). */
  levelDef: ModuleDef;
  drill: string[];
  onGoto: (g: Goto) => void;
  /** A module's context menu (when a host takes open actions). */
  onNodeContext?: (id: string, x: number, y: number) => void;
}) {
  const { vm, selection } = props;
  const host = useHost();
  const levelDefId = props.levelDef.id;
  const node = selection?.kind === "node" ? vm.nodes.find((n) => n.id === selection.id) : undefined;
  const link = selection?.kind === "link" ? vm.links.find((l) => l.linkId === selection.id) : undefined;
  const derived = selection?.kind === "link" && !link ? vm.derived.find((d) => d.id === selection.id) : undefined;
  const lookup = (id: string) => props.defFor(id);

  /** The drawings to show for a node: its own board's, or the board it is a component of, marking it. */
  const boardFor = (n: ViewNode): React.ReactNode => {
    const own = props.defFor(n.defId);
    if (n.kind !== "net" && circuitOutputs(own)) {
      // a click on a component opens the board and selects it there
      return <BoardViews def={own!} lookup={lookup} resolve={props.resolveArtifact} onPick={(instance) => props.onGoto({ drill: [...props.drill, ...n.id.split("/")], selection: { kind: "node", id: instance } })} />;
    }
    const parent = n.parent ? vm.nodes.find((x) => x.id === n.parent) : undefined;
    const holder = parent ? props.defFor(parent.defId) : props.levelDef;
    if (!holder || !circuitOutputs(holder)) return null;
    const prefix = parent ? `${parent.id}/` : "";
    return (
      <BoardViews
        def={holder}
        lookup={lookup}
        resolve={props.resolveArtifact}
        highlight={n.id.slice(prefix.length)}
        onPick={(instance) => props.onSelect({ kind: "node", id: prefix + instance })}
      />
    );
  };

  const findings = useMemo(() => checkFindings(props.diagnostics, props.hostDiagnostics), [props.diagnostics, props.hostDiagnostics]);
  const named = useMemo(() => levelNames(vm, props.levelDef, (id) => props.defFor(id)), [vm, props.levelDef, props.defFor]);
  const errors = props.diagnostics.filter((d) => d.severity === "error").length + props.hostDiagnostics.filter((d) => d.severity === "error").length;
  return (
    <aside className={`inspector${props.className ? ` ${props.className}` : ""}`}>
      <div className="inspector-header">
        <span>INSPECTOR</span>
        <span className="section-actions">
          <IconButton size="sm" icon="list-tree" label="Hierarchy" pressed={!selection && props.panel === "hierarchy"} onClick={() => { props.onSelect(null); props.onPanel("hierarchy"); }} />
          <IconButton size="sm" icon="shield-check" label="System checks" pressed={!selection && props.panel === "checks"} badge={errors || undefined} onClick={() => { props.onSelect(null); props.onPanel("checks"); }} />
        </span>
      </div>
      <ScrollArea className="inspector-scroll" contentClassName="inspector-body">
        {node ? (
          <SelectionKey.Provider value={`node:${fullId(props.drill, node.id)}`}>
            <NodeDetails
              node={node}
              vm={vm}
              mode={props.mode}
              def={props.defFor(node.defId)}
              onDrill={props.onDrill}
              onToggleExpand={props.onToggleExpand}
              onSelect={props.onSelect}
              board={boardFor(node)}
              onOpenSource={host.openSource && node.defId ? () => host.openSource!(node.defId!, fullId(props.drill, node.id)) : undefined}
              artifacts={<ArtifactsSection key={node.id} def={props.defFor(node.defId)} resolve={props.resolveArtifact} appearance={node.defId ? props.appearance?.[node.defId] : undefined} titled={false} />}
              lookup={props.defFor}
              drill={props.drill}
              names={named.names}
              linkNames={named.linkNames}
              findings={findings}
              cardActions={{
                selectLink: (id) => props.onSelect({ kind: "link", id }),
                locate: (slot) => {
                  const first = slot.links.find((l) => !l.derived) ?? slot.links[0];
                  props.onSelect(first ? { kind: "link", id: first.select } : { kind: "node", id: node.id });
                },
                ...(host.openSource
                  ? {
                      // a linked interface is written where its link is (the level's module); an open one in its module
                      openSource: (slot) => (slot.links.some((l) => !l.derived) ? host.openSource!(levelDefId, props.drill.join("/") || undefined) : node.defId && host.openSource!(node.defId, fullId(props.drill, node.id))),
                    }
                  : {}),
                ...(host.openLink ? { openLink: host.openLink } : {}),
              }}
            />
          </SelectionKey.Provider>
        ) : link ? (
          <LinkDetails
            link={link}
            mode={props.mode}
            open={props.openLinks.has(link.linkId)}
            onToggle={props.onToggleLink}
            onPair={() => props.onPair(link)}
            preview={!link.net && <PairPreview vm={vm} link={link} mode={props.mode} onOpen={() => props.onPair(link)} />}
            bSlots={props.bSlotsFor(link)}
            onOpenSource={(() => {
              const owner = linkOwner(vm, link.linkId, levelDefId);
              const slash = link.linkId.lastIndexOf("/");
              const at = slash < 0 ? props.drill.join("/") : fullId(props.drill, link.linkId.slice(0, slash));
              return host.openSource && owner ? () => host.openSource!(owner, at || undefined) : undefined;
            })()}
            override={props.overrides[link.linkId]}
            onOverride={props.topLevel ? (c) => props.onOverride(link.linkId, c) : undefined}
            harness={
              link.run && (
                <ArtifactsSection def={props.defFor(link.run.defId)} resolve={props.resolveArtifact} appearance={props.appearance?.[link.run.defId]} titled={false} />
              )
            }
            derived={link.net && <DerivedList items={vm.derived.filter((d) => d.via.includes(link.id))} title="FUNCTIONAL LINKS OVER THESE PINS" onSelect={props.onSelect} titled={false} />}
          />
        ) : derived ? (
          <DerivedDetails d={derived} vm={vm} onSelect={props.onSelect} />
        ) : props.panel === "checks" ? (
          <Checks diagnostics={props.diagnostics} host={props.hostDiagnostics} vm={vm} drill={props.drill} onGoto={props.onGoto} />
        ) : (
          <Hierarchy
            vm={vm}
            selection={selection}
            onSelect={props.onSelect}
            onContext={props.onNodeContext}
            board={
              circuitOutputs(props.levelDef) && (
                <BoardViews def={props.levelDef} lookup={lookup} resolve={props.resolveArtifact} onPick={(instance) => props.onSelect({ kind: "node", id: instance })} />
              )
            }
          />
        )}
      </ScrollArea>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// A module's context menu (canvas and hierarchy), when a host takes open actions
// ---------------------------------------------------------------------------

export interface NodeMenuItem {
  label: string;
  run: () => void;
}

/** A small menu at the pointer; any click elsewhere, Escape, or a choice closes it. */
export function NodeMenu({ x, y, items, onClose }: { x: number; y: number; items: NodeMenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  if (!items.length) return null;
  // kept inside the window
  const left = Math.min(x, window.innerWidth - 180);
  const top = Math.min(y, window.innerHeight - 12 - items.length * 30);
  return (
    <div ref={ref} className="context-menu" style={{ left, top }} role="menu">
      {items.map((it) => (
        <button
          key={it.label}
          role="menuitem"
          onClick={() => {
            onClose();
            it.run();
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

/** Memoised: re-renders only when its props change, not on every frame of a canvas drag. */
export const Inspector = memo(InspectorView);
