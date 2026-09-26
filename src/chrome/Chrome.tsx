import { useReactFlow } from "@xyflow/react";
import type { ViewLink, ViewModel, ViewNode } from "../model/types";
import { CLASSIFICATIONS, colorFor, legendFor, type Classification } from "../model/classification";
import { Icon } from "../canvas/Icon";
import type { Selection } from "../canvas/Canvas";

// ---------------------------------------------------------------------------
// Header: breadcrumb (design D9) + classification (D7) + detail (D5)
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
  mode: Classification;
  onMode: (m: Classification) => void;
  conductors: boolean;
  onConductors: (c: boolean) => void;
  showGrounds: boolean;
  onGrounds: (g: boolean) => void;
}) {
  return (
    <header className="header">
      <div className="brand">
        <span className="brand-mark">UHD</span>
        <span className="brand-name">VIEWER</span>
      </div>
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
        <Segmented options={CLASSIFICATIONS} value={props.mode} onChange={props.onMode} />
        <Segmented
          options={[
            { id: "bundled", label: "BUNDLED" },
            { id: "conductors", label: "CONDUCTORS" },
          ]}
          value={props.conductors ? "conductors" : "bundled"}
          onChange={(v) => props.onConductors(v === "conductors")}
        />
        <button className={`chip-toggle${props.showGrounds ? " on" : ""}`} onClick={() => props.onGrounds(!props.showGrounds)}>
          GND WIRES
        </button>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Left activity bar (layout decision D11 — placeholders beyond hierarchy)
// ---------------------------------------------------------------------------

export function ActivityBar({ inspectorOpen, onInspector }: { inspectorOpen: boolean; onInspector: () => void }) {
  const items = [
    { icon: "list-tree", label: "Hierarchy", on: inspectorOpen, action: onInspector },
    { icon: "search", label: "Search (planned)" },
    { icon: "package", label: "Parts library (planned)" },
    { icon: "shield-check", label: "Design rule checks (planned)" },
    { icon: "file-box", label: "Artifacts (planned)" },
  ];
  return (
    <aside className="activity-bar">
      {items.map((it) => (
        <button key={it.icon} className={`activity${it.on ? " on" : ""}`} title={it.label} onClick={it.action} disabled={!it.action}>
          <Icon name={it.icon} size={16} />
        </button>
      ))}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Inspector: hierarchy by default, details for the selection
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

function NodeDetails({ node, vm, mode, onDrill, onToggleExpand }: { node: ViewNode; vm: ViewModel; mode: Classification; onDrill: (id: string) => void; onToggleExpand: (id: string) => void }) {
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
    </div>
  );
}

function LinkDetails({ link, mode, open, onToggle }: { link: ViewLink; mode: Classification; open: boolean; onToggle: (id: string) => void }) {
  const color = colorFor(link, mode);
  return (
    <div className="details">
      <div className="details-title">
        <Icon name="cable" size={16} color={color} />
        <span>{link.name.toUpperCase()}</span>
      </div>
      <Row k="PROTOCOL" v={link.protocol} />
      <Row k="DOMAIN" v={link.domain} />
      <Row k="STATE" v={STATE_LABEL[link.state]} />
      <Row k="FROM" v={`${link.source.node}:${link.source.port}`} />
      <Row k="TO" v={`${link.target.node}:${link.target.port}`} />
      {link.children.length > 0 && (
        <>
          <div className="section-title">
            CHILD LINKS · {link.children.length}
            <button className="mini" onClick={() => onToggle(link.id)}>{open ? "CLOSE" : "OPEN"}</button>
          </div>
          <table className="child-table">
            <tbody>
              {link.children.map((c) => (
                <tr key={c.id}>
                  <td>{c.a.toUpperCase()}</td>
                  <td className="muted">{c.aPin ?? ""}</td>
                  <td>→</td>
                  <td>{c.b.toUpperCase()}</td>
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
            <p key={d} className="diagnostic">{d}</p>
          ))}
        </>
      )}
    </div>
  );
}

function Hierarchy({ vm, selection, onSelect }: { vm: ViewModel; selection: Selection; onSelect: (s: Selection) => void }) {
  const roots = vm.nodes.filter((n) => !n.parent);
  const kids = (id: string) => vm.nodes.filter((n) => n.parent === id);
  const links = vm.links.filter((l) => !l.passThrough);
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
      {roots.filter((n) => !n.sheetPort).map((n) => item(n, 0))}
      <div className="section-title">LINKS · {links.length}</div>
      {links.map((l) => (
        <button
          key={l.id}
          className={`tree-item${selection?.kind === "link" && selection.id === l.id ? " on" : ""}`}
          onClick={() => onSelect({ kind: "link", id: l.id })}
        >
          <span className={`state-dot ${l.state}`} />
          <span>{l.name.toUpperCase()}</span>
          <span className="tree-tag">{l.protocol}</span>
        </button>
      ))}
    </div>
  );
}

export function Inspector(props: {
  vm: ViewModel;
  selection: Selection;
  mode: Classification;
  openLinks: Set<string>;
  onSelect: (s: Selection) => void;
  onDrill: (id: string) => void;
  onToggleLink: (id: string) => void;
  onToggleExpand: (id: string) => void;
}) {
  const { vm, selection } = props;
  const node = selection?.kind === "node" ? vm.nodes.find((n) => n.id === selection.id) : undefined;
  const link = selection?.kind === "link" ? vm.links.find((l) => l.id === selection.id) : undefined;
  return (
    <aside className="inspector">
      <div className="inspector-header">
        <span>INSPECTOR</span>
        {selection && (
          <button className="mini" onClick={() => props.onSelect(null)}>
            HIERARCHY
          </button>
        )}
      </div>
      <div className="inspector-body">
        {node ? (
          <NodeDetails node={node} vm={vm} mode={props.mode} onDrill={props.onDrill} onToggleExpand={props.onToggleExpand} />
        ) : link ? (
          <LinkDetails link={link} mode={props.mode} open={props.openLinks.has(link.id)} onToggle={props.onToggleLink} />
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
