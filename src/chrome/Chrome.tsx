import { memo, useState } from "react";
import { useReactFlow } from "@xyflow/react";
import type { ChildLink, ModuleDef } from "@uhd/types/index.js";
import type { UhdBundleDiagnostic } from "@uhd/types/bundle.js";
import type { ScopedDiagnostic } from "../model/diagnostics";
import { circuitOutputs } from "../model/outputs";
import { BoardViews, DerivedDetails, DerivedList, NetDetails, PackageSection, PinTable } from "./BoardInspector";
import type { ViewLink, ViewModel, ViewNode } from "../model/types";
import { ArtifactsSection, AssemblyArtifacts, type ArtifactResolver } from "./Artifacts";
import type { Appearance } from "../source/source";
import { CLASSIFICATIONS, colorFor, legendFor, type Classification } from "../model/classification";
import { evidenceFor } from "../model/evidence";
import { Icon } from "../canvas/Icon";
import { fitPadding, type Selection } from "../canvas/Canvas";

// ---------------------------------------------------------------------------
// Header: breadcrumb (D9), scenario, classification (D7), detail (D5)
// ---------------------------------------------------------------------------

function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button key={o.id} className={o.id === value ? "on" : ""} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function HeaderView(props: {
  vm: ViewModel;
  onNavigate: (depth: number) => void;
  scenarios: { id: string; label: string }[];
  scenario: string;
  onScenario: (id: string) => void;
  mode: Classification;
  onMode: (m: Classification) => void;
  conductors: boolean;
  onConductors: (c: boolean) => void;
  showGrounds: boolean;
  onGrounds: (g: boolean) => void;
  view: "diagram" | "3d";
  onView: (v: "diagram" | "3d") => void;
}) {
  return (
    <header className="header">
      <div className="brand">
        <span className="brand-mark">UHD</span>
        <span className="brand-name">VIEWER</span>
      </div>
      <span className="sep" />
      <nav className="breadcrumb">
        {props.vm.path.map((p, i) => (
          <span key={p.id || "root"} className="crumb-wrap">
            {i > 0 && <Icon name="chevron-right" size={12} className="crumb-sep" />}
            <button className={`crumb${i === props.vm.path.length - 1 ? " current" : ""}`} onClick={() => props.onNavigate(i)}>
              {p.label.toUpperCase()}
            </button>
          </span>
        ))}
      </nav>
      <div className="header-controls">
        <Segmented
          options={[
            { id: "diagram", label: "Diagram" },
            { id: "3d", label: "3D" },
          ]}
          value={props.view}
          onChange={props.onView}
        />
        <span className="sep" />
        <label className="scenario">
          <Icon name="flask-conical" size={12} />
          <select value={props.scenario} onChange={(e) => props.onScenario(e.target.value)}>
            {props.scenarios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <span className="sep" />
        <Segmented options={CLASSIFICATIONS} value={props.mode} onChange={props.onMode} />
        <span className="sep" />
        <Segmented
          options={[
            { id: "bundled", label: "Basic" },
            { id: "conductors", label: "Ribbon" },
          ]}
          value={props.conductors ? "conductors" : "bundled"}
          onChange={(v) => props.onConductors(v === "conductors")}
        />
        <button className={`chip-toggle${props.showGrounds ? " on" : ""}`} onClick={() => props.onGrounds(!props.showGrounds)}>
          GND wires
        </button>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Left activity bar (layout decision D11)
// ---------------------------------------------------------------------------

export type Panel = "hierarchy" | "checks";

function ActivityBarView({ panel, onPanel, errors }: { panel: Panel | null; onPanel: (p: Panel | null) => void; errors: number }) {
  const items: { id?: Panel; icon: string; label: string }[] = [
    { id: "hierarchy", icon: "list-tree", label: "Hierarchy" },
    { id: "checks", icon: "shield-check", label: "System checks" },
    { icon: "search", label: "Search (planned)" },
    { icon: "package", label: "Parts library (planned)" },
  ];
  return (
    <aside className="activity-bar">
      {items.map((it) => (
        <button
          key={it.icon}
          className={`activity${it.id && panel === it.id ? " on" : ""}`}
          title={it.label}
          disabled={!it.id}
          onClick={() => it.id && onPanel(panel === it.id ? null : it.id)}
        >
          <Icon name={it.icon} size={16} />
          {it.id === "checks" && errors > 0 && <span className="badge">{errors}</span>}
        </button>
      ))}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

const STATE_LABEL: Record<string, string> = {
  configured: "CONFIGURED",
  partial: "PARTIAL",
  incompatible: "INCOMPATIBLE",
  unconfigured: "NOT CONFIGURED",
};

function Row({ k, v }: { k: string; v?: string }) {
  if (!v) return null;
  return (
    <div className="kv">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  );
}

function EvidenceSection({ def }: { def?: ModuleDef }) {
  const ev = evidenceFor(def);
  if (!ev || (!ev.sources.length && !ev.performance.length)) return null;
  const v = ev.verification;
  return (
    <>
      <div className="section-title">EVIDENCE</div>
      <div className="evidence">
        {!ev.filesKnown ? null : v?.audit ? (
          <div className={`audit ${v.audit.wrong + v.audit.unsupported > 0 ? "repaired" : "ok"}`}>
            <Icon name="badge-check" size={13} />
            <span>
              AUDITED {v.audit.confirmed}/{v.audit.checked} FACTS
            </span>
            {v.repairs && <span className="muted"> · {v.repairs}</span>}
          </div>
        ) : (
          <div className="audit pending">
            <Icon name="circle-dashed" size={13} /> <span>NOT YET AUDITED</span>
          </div>
        )}
        {ev.performance.map((p) => (
          <div key={p.kind} className="facts">
            <div className="facts-title">{p.kind.toUpperCase()}</div>
            {p.facts.map(([k, val]) => (
              <Row key={k} k={k.toUpperCase()} v={val} />
            ))}
          </div>
        ))}
        {ev.assumptions.length > 0 && (
          <div className="facts">
            <div className="facts-title warn">ASSUMPTIONS · {ev.assumptions.length}</div>
            {ev.assumptions.map((a) => (
              <p key={a.field} className="note">
                <b>{a.field}</b>
                {a.value ? ` = ${a.value}` : ""}
                {a.reason ? ` — ${a.reason}` : ""}
              </p>
            ))}
          </div>
        )}
        {ev.discrepancies.length > 0 && (
          <div className="facts">
            <div className="facts-title">SOURCE CONFLICTS · {ev.discrepancies.length}</div>
            {ev.discrepancies.map((d) => (
              <p key={d.field} className="note">
                <b>{d.field}</b>
                {d.resolution ? ` — ${d.resolution}` : ""}
              </p>
            ))}
          </div>
        )}
        {ev.gaps.length > 0 && (
          <div className="facts">
            <div className="facts-title">OPEN DATA GAPS · {ev.gaps.length}</div>
            <p className="note">{ev.gaps.join(" · ")}</p>
          </div>
        )}
        {ev.sources.length > 0 && (
          <div className="facts">
            <div className="facts-title">SOURCES · {ev.sources.length}</div>
            {ev.sources.map((s) => (
              <a key={s.id} className="source" href={s.url} target="_blank" rel="noreferrer">
                <span className={`authority ${s.authority}`}>{s.authority.slice(0, 5).toUpperCase()}</span>
                <span>{s.title}</span>
              </a>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function NodeDetails({
  node,
  vm,
  mode,
  def,
  onDrill,
  onToggleExpand,
  onSelect,
  artifacts,
  board,
}: {
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
}) {
  if (node.net) return <NetDetails node={node} vm={vm} onSelect={onSelect} />;
  const links = vm.links.filter((l) => !l.passThrough && (l.source.node === node.id || l.target.node === node.id));
  return (
    <div className="details">
      <div className="details-title">
        <Icon name={node.icon} size={16} />
        <span>{node.label}</span>
      </div>
      <Row k="KIND" v={node.kind.toUpperCase()} />
      <Row k="DEFINITION" v={node.defId} />
      <Row k="MANUFACTURER" v={node.manufacturer} />
      <Row k="PART NUMBER" v={node.partNumber} />
      <Row k="PATH" v={node.id} />
      {node.description && <p className="description">{node.description}</p>}
      {node.childCount > 0 && (
        <div className="actions">
          <button onClick={() => onToggleExpand(node.id)}>{node.expanded ? "COLLAPSE" : "EXPAND IN PLACE"}</button>
          <button onClick={() => onDrill(node.id)}>OPEN AS CANVAS</button>
        </div>
      )}
      {board}
      {artifacts}
      <PackageSection def={def} />
      <DerivedList items={vm.derived.filter((d) => d.a.node === node.id || d.b.node === node.id)} title="FUNCTIONAL LINKS" onSelect={onSelect} />
      <EvidenceSection def={def} />
      {node.kind !== "harness" && (
        <>
          <div className="section-title">INTERFACES · {node.ports.length}</div>
          <div className="port-list">
            {node.ports.map((p) => {
              const link = links.find((l) => (l.source.node === node.id && l.source.port === p.id) || (l.target.node === node.id && l.target.port === p.id));
              return (
                <div key={p.id} className="port-row">
                  <span className="swatch" style={{ background: colorFor({ domain: p.domain, protocol: p.protocol, state: link?.state }, mode) }} />
                  <span className="port-name">{p.name}</span>
                  <span className="port-proto">{p.protocol}</span>
                  {link ? (
                    <span className="port-linked">
                      ↔ {(() => {
                        const other = link.source.node === node.id ? link.target.node : link.source.node;
                        // a net reads by its name, not its path
                        return vm.nodes.find((n) => n.id === other && n.net)?.label ?? other;
                      })()}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
          <PinTable def={def} node={node} vm={vm} />
        </>
      )}
    </div>
  );
}

function LinkDetails({
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
}: {
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
  return (
    <div className="details">
      <div className="details-title">
        <Icon name="cable" size={16} color={color} />
        <span>{link.name.toUpperCase()}</span>
      </div>
      <Row k="PROTOCOL" v={link.protocol} />
      <Row k="DOMAIN" v={link.domain} />
      <Row k="STATE" v={STATE_LABEL[link.state]} />
      <Row k="HARNESS" v={link.run?.name ?? link.harness} />
      <Row k="NET" v={link.net?.name} />
      <div className="actions">
        {!link.net && <button onClick={onPair}>PAIR VIEW</button>}
        {link.children.length > 1 && <button onClick={() => onToggle(link.linkId)}>{open ? "CLOSE LINK" : "OPEN LINK"}</button>}
      </div>
      {harness}
      {link.children.length > 0 && (
        <>
          <div className="section-title">
            <span>
              {link.net ? "PINS ON THE NET" : "CHILD LINKS"} · {link.children.length}
              {link.manual && (
                <span className="manual-tag">
                  <Icon name="lock" size={9} /> STORED
                </span>
              )}
            </span>
            {canRemap && (
              <span className="section-actions">
                <button className="mini" onClick={() => setEditing((e) => !e)}>
                  {editing ? "DONE" : "REMAP"}
                </button>
                {override && (
                  <button className="mini" onClick={() => onOverride?.(null)}>
                    RESET
                  </button>
                )}
              </span>
            )}
          </div>
          <table className="child-table">
            <tbody>
              {link.children.map((c, i) => (
                <tr key={c.id}>
                  <td>{(link.net ? c.label : c.a).toUpperCase()}</td>
                  <td className="muted">{c.aPin ?? ""}</td>
                  <td>→</td>
                  <td>
                    {editing ? (
                      <select value={c.b} onChange={(e) => remap(i, e.target.value)}>
                        {bSlots.map((s) => (
                          <option key={s} value={s}>
                            {s.toUpperCase()}
                          </option>
                        ))}
                      </select>
                    ) : (
                      c.b.toUpperCase()
                    )}
                  </td>
                  <td className="muted">{c.bPin ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {derived}
      {link.diagnostics.length > 0 && (
        <>
          <div className="section-title">DIAGNOSTICS</div>
          {link.diagnostics.map((d) => (
            <p key={d} className={`diagnostic ${link.state}`}>
              {d}
            </p>
          ))}
        </>
      )}
    </div>
  );
}

function Hierarchy({ vm, selection, onSelect, board }: { vm: ViewModel; selection: Selection; onSelect: (s: Selection) => void; board?: React.ReactNode }) {
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

/** A stored or derived link id as the view selects it: the line that draws it, or the derived link itself. */
export function selectableLink(vm: ViewModel, id: string): Selection {
  if (vm.derived.some((d) => d.id === id)) return { kind: "link", id };
  const line = vm.links.find((l) => l.linkId === id || l.alsoIds?.includes(id));
  return line ? { kind: "link", id: line.linkId } : null;
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
}) {
  const { vm, selection } = props;
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

  return (
    <aside className="inspector">
      <div className="inspector-header">
        <span>INSPECTOR</span>
        <span className="section-actions">
          <button className={`mini${!selection && props.panel === "hierarchy" ? " on" : ""}`} onClick={() => { props.onSelect(null); props.onPanel("hierarchy"); }}>
            HIERARCHY
          </button>
          <button className={`mini${!selection && props.panel === "checks" ? " on" : ""}`} onClick={() => { props.onSelect(null); props.onPanel("checks"); }}>
            CHECKS
          </button>
        </span>
      </div>
      <div className="inspector-body">
        {node ? (
          <NodeDetails
            node={node}
            vm={vm}
            mode={props.mode}
            def={props.defFor(node.defId)}
            onDrill={props.onDrill}
            onToggleExpand={props.onToggleExpand}
            onSelect={props.onSelect}
            board={boardFor(node)}
            artifacts={<AssemblyArtifacts key={node.id} def={props.defFor(node.defId)} lookup={props.defFor} resolve={props.resolveArtifact} appearance={props.appearance} />}
          />
        ) : link ? (
          <LinkDetails
            link={link}
            mode={props.mode}
            open={props.openLinks.has(link.linkId)}
            onToggle={props.onToggleLink}
            onPair={() => props.onPair(link)}
            bSlots={props.bSlotsFor(link)}
            override={props.overrides[link.linkId]}
            onOverride={props.topLevel ? (c) => props.onOverride(link.linkId, c) : undefined}
            harness={
              link.run && (
                <ArtifactsSection def={props.defFor(link.run.defId)} resolve={props.resolveArtifact} appearance={props.appearance?.[link.run.defId]} />
              )
            }
            derived={link.net && <DerivedList items={vm.derived.filter((d) => d.via.includes(link.id))} title="FUNCTIONAL LINKS OVER THESE PINS" onSelect={props.onSelect} />}
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
            board={
              circuitOutputs(props.levelDef) && (
                <BoardViews def={props.levelDef} lookup={lookup} resolve={props.resolveArtifact} onPick={(instance) => props.onSelect({ kind: "node", id: instance })} />
              )
            }
          />
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Bottom toolbar and legend
// ---------------------------------------------------------------------------

function ToolbarView({ onReset, inspector = false }: { onReset: () => void; inspector?: boolean }) {
  const flow = useReactFlow();
  const tools = [
    { icon: "maximize", label: "Fit view", run: () => flow.fitView({ padding: fitPadding(inspector), maxZoom: 1.25, duration: 300 }) },
    { icon: "zoom-in", label: "Zoom in", run: () => flow.zoomIn({ duration: 200 }) },
    { icon: "zoom-out", label: "Zoom out", run: () => flow.zoomOut({ duration: 200 }) },
    { icon: "rotate-ccw", label: "Reset layout", run: onReset },
  ];
  return (
    <div className="toolbar">
      {tools.map((t) => (
        <button key={t.icon} title={t.label} onClick={t.run}>
          <Icon name={t.icon} size={15} />
        </button>
      ))}
    </div>
  );
}

function LegendView({ mode }: { mode: Classification }) {
  return (
    <div className="legend">
      <div className="legend-title">{CLASSIFICATIONS.find((c) => c.id === mode)?.label}</div>
      {legendFor(mode).map((item) => (
        <div key={item.label} className="legend-item">
          <span className="legend-swatch" style={{ background: item.color }} />
          <span>{item.label}</span>
        </div>
      ))}
    </div>
  );
}

/** Memoised: re-renders only when its props change, not on every frame of a canvas drag. */
export const Header = memo(HeaderView);
export const ActivityBar = memo(ActivityBarView);
export const Inspector = memo(InspectorView);
export const Toolbar = memo(ToolbarView);
export const Legend = memo(LegendView);
