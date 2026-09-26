import { useState } from "react";
import { useReactFlow } from "@xyflow/react";
import type { ChildLink, ModuleDef } from "@uhd/types/index.js";
import type { SystemDiagnostic } from "@uhd/system/checks.js";
import type { ViewLink, ViewModel, ViewNode } from "../model/types";
import { CLASSIFICATIONS, colorFor, legendFor, type Classification } from "../model/classification";
import { evidenceFor } from "../model/evidence";
import { Icon } from "../canvas/Icon";
import type { Selection } from "../canvas/Canvas";

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

export function Header(props: {
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
            { id: "bundled", label: "Bundled" },
            { id: "conductors", label: "Conductors" },
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

export function ActivityBar({ panel, onPanel, errors }: { panel: Panel | null; onPanel: (p: Panel | null) => void; errors: number }) {
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
        {v?.audit ? (
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
}: {
  node: ViewNode;
  vm: ViewModel;
  mode: Classification;
  def?: ModuleDef;
  onDrill: (id: string) => void;
  onToggleExpand: (id: string) => void;
}) {
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
                  {link ? <span className="port-linked">↔ {link.source.node === node.id ? link.target.node : link.source.node}</span> : null}
                </div>
              );
            })}
          </div>
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
}: {
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
      <Row k="HARNESS" v={link.harness} />
      <div className="actions">
        <button onClick={onPair}>PAIR VIEW</button>
        {link.children.length > 1 && <button onClick={() => onToggle(link.linkId)}>{open ? "CLOSE LINK" : "OPEN LINK"}</button>}
      </div>
      {link.children.length > 0 && (
        <>
          <div className="section-title">
            <span>
              CHILD LINKS · {link.children.length}
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
                  <td>{c.a.toUpperCase()}</td>
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

function Hierarchy({ vm, selection, onSelect }: { vm: ViewModel; selection: Selection; onSelect: (s: Selection) => void }) {
  const roots = vm.nodes.filter((n) => !n.parent && !n.sheetPort);
  const kids = (id: string) => vm.nodes.filter((n) => n.parent === id);
  const links = vm.links.filter((l) => !l.passThrough && l.segment !== "b");
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
      <div className="section-title">MODULES · {vm.nodes.filter((n) => !n.sheetPort).length}</div>
      {roots.map((n) => item(n, 0))}
      <div className="section-title">LINKS · {links.length}</div>
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
    </div>
  );
}

const SEVERITY_ICON = { error: "octagon-x", warning: "triangle-alert", info: "info" } as const;

function Checks({ diagnostics, vm, onSelect }: { diagnostics: SystemDiagnostic[]; vm: ViewModel; onSelect: (s: Selection) => void }) {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const d of diagnostics) counts[d.severity]++;
  const target = (d: SystemDiagnostic): Selection => {
    const link = d.refs.find((r) => r.startsWith("link:"))?.slice(5);
    if (link && vm.links.some((l) => l.linkId === link)) return { kind: "link", id: link };
    const node = d.refs.map((r) => r.split(":")[0]).find((n) => vm.nodes.some((x) => x.id === n));
    return node ? { kind: "node", id: node } : null;
  };
  return (
    <div className="checks">
      <div className="check-summary">
        <span className="sev error">{counts.error} ERRORS</span>
        <span className="sev warning">{counts.warning} WARNINGS</span>
        <span className="sev info">{counts.info} INFO</span>
      </div>
      {diagnostics.map((d) => (
        <button key={d.id} className={`check ${d.severity}`} onClick={() => onSelect(target(d))}>
          <Icon name={SEVERITY_ICON[d.severity]} size={13} />
          <span className="check-body">
            <span className="check-rule">{d.rule.replace(/_/g, " ").toUpperCase()}</span>
            <span className="check-msg">{d.message}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

export function Inspector(props: {
  vm: ViewModel;
  panel: Panel;
  onPanel: (p: Panel) => void;
  selection: Selection;
  mode: Classification;
  openLinks: Set<string>;
  diagnostics: SystemDiagnostic[];
  defFor: (defId?: string) => ModuleDef | undefined;
  bSlotsFor: (link: ViewLink) => string[];
  overrides: Record<string, ChildLink[]>;
  onOverride: (linkId: string, childLinks: ChildLink[] | null) => void;
  onSelect: (s: Selection) => void;
  onDrill: (id: string) => void;
  onToggleLink: (id: string) => void;
  onToggleExpand: (id: string) => void;
  onPair: (link: ViewLink) => void;
  topLevel: boolean;
}) {
  const { vm, selection } = props;
  const node = selection?.kind === "node" ? vm.nodes.find((n) => n.id === selection.id) : undefined;
  const link = selection?.kind === "link" ? vm.links.find((l) => l.linkId === selection.id) : undefined;
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
          <NodeDetails node={node} vm={vm} mode={props.mode} def={props.defFor(node.defId)} onDrill={props.onDrill} onToggleExpand={props.onToggleExpand} />
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
          />
        ) : props.panel === "checks" ? (
          <Checks diagnostics={props.diagnostics} vm={vm} onSelect={props.onSelect} />
        ) : (
          <Hierarchy vm={vm} selection={selection} onSelect={props.onSelect} />
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Bottom toolbar and legend
// ---------------------------------------------------------------------------

export function Toolbar({ onReset }: { onReset: () => void }) {
  const flow = useReactFlow();
  const tools = [
    { icon: "maximize", label: "Fit view", run: () => flow.fitView({ padding: 0.08, duration: 300 }) },
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

export function Legend({ mode }: { mode: Classification }) {
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
