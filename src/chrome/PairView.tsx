import type { ViewLink, ViewModel, ViewNode } from "../model/types";
import { colorFor, type Classification } from "../model/classification";
import { Icon } from "../canvas/Icon";

/**
 * Pair view (design board 08): every stored link between two modules, left
 * to right, with each link's child links as conductors. Crossovers (TX→RX)
 * draw as crossing lines. Unlinked interfaces are listed below.
 */

interface Endpoints {
  a: { node: string; port: string };
  b: { node: string; port: string };
}

/** True endpoints of a link, joining harness segments back together. */
function endpointsOf(vm: ViewModel, link: ViewLink): Endpoints {
  if (!link.segment) return { a: link.source, b: link.target };
  const first = vm.links.find((l) => l.linkId === link.linkId && l.segment === "a")!;
  const second = vm.links.find((l) => l.linkId === link.linkId && l.segment === "b")!;
  return { a: first.source, b: second.target };
}

const ROW = 22;
const HEAD = 30;

export function PairView({ vm, link, mode, onClose }: { vm: ViewModel; link: ViewLink; mode: Classification; onClose: () => void }) {
  const { a, b } = endpointsOf(vm, link);
  const nodeA = vm.nodes.find((n) => n.id === a.node);
  const nodeB = vm.nodes.find((n) => n.id === b.node);
  if (!nodeA || !nodeB) return null;

  const between = vm.links
    .filter((l) => !l.passThrough && l.segment !== "b")
    .map((l) => ({ link: l, ends: endpointsOf(vm, l) }))
    .filter(({ ends }) => (ends.a.node === nodeA.id && ends.b.node === nodeB.id) || (ends.a.node === nodeB.id && ends.b.node === nodeA.id))
    .map(({ link: l, ends }) => (ends.a.node === nodeA.id ? { link: l, aPort: ends.a.port, bPort: ends.b.port, flipped: false } : { link: l, aPort: ends.b.port, bPort: ends.a.port, flipped: true }));

  const linkedA = new Set(between.map((x) => x.aPort));
  const linkedB = new Set(between.map((x) => x.bPort));
  const portName = (node: ViewNode, id: string) => node.ports.find((p) => p.id === id)?.name ?? id;
  const worstState = between.some((x) => x.link.state === "incompatible")
    ? "incompatible"
    : between.some((x) => x.link.state === "partial")
      ? "partial"
      : "configured";

  let y = 0;
  const regions = between.map((x) => {
    const children = x.link.children.map((c) => (x.flipped ? { ...c, a: c.b, b: c.a, aPin: c.bPin, bPin: c.aPin } : c));
    // B-side rows follow B's own slot order so crossovers show as crossings
    const slotOrder = nodeB.ports.find((p) => p.id === x.bPort)?.children.map((c) => c.slotId) ?? [];
    const rank = (slot: string) => (slotOrder.indexOf(slot) >= 0 ? slotOrder.indexOf(slot) : slotOrder.length);
    const bOrder = [...children].sort((p, q) => rank(p.b) - rank(q.b) || p.b.localeCompare(q.b));
    const top = y;
    y += HEAD + Math.max(children.length, 0) * ROW + 12;
    return { ...x, children, bOrder, top, height: y - top - 8 };
  });

  return (
    <div className="pair-overlay" onClick={onClose}>
      <div className="pair-view" onClick={(e) => e.stopPropagation()}>
        <div className="pair-header">
          <span className="pair-title">PAIR VIEW</span>
          <span className="pair-sub">
            {nodeA.label} ↔ {nodeB.label}
          </span>
          <button className="mini" onClick={onClose}>
            CLOSE
          </button>
        </div>
        <div className="pair-grid" style={{ height: y + 40 }}>
          <div className="pair-col left">
            <div className="pair-col-title">
              <Icon name={nodeA.icon} size={13} /> {nodeA.label}
            </div>
          </div>
          <div className="pair-col right">
            <div className="pair-col-title">
              <Icon name={nodeB.icon} size={13} /> {nodeB.label}
            </div>
          </div>
          <svg className="pair-wires" width="100%" height={y + 40} viewBox={`0 0 1000 ${y + 40}`} preserveAspectRatio="none">
            {regions.map((r) => {
              const color = colorFor(r.link, mode);
              return r.children.length === 0 ? (
                <line key={r.link.id} x1={380} x2={620} y1={r.top + 40 + 14} y2={r.top + 40 + 14} stroke={color} strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
              ) : (
                r.children.map((c, i) => {
                  const j = r.bOrder.indexOf(c);
                  const y1 = r.top + 40 + HEAD + i * ROW + 8;
                  const y2 = r.top + 40 + HEAD + j * ROW + 8;
                  return <path key={c.id} d={`M 380 ${y1} C 480 ${y1}, 520 ${y2}, 620 ${y2}`} stroke={color} strokeWidth={1.6} fill="none" vectorEffect="non-scaling-stroke" />;
                })
              );
            })}
          </svg>
          {regions.map((r) => {
            const color = colorFor(r.link, mode);
            return (
              <div key={r.link.id} className="pair-region" style={{ top: r.top + 40, height: r.height, borderColor: color }}>
                <span className="pair-pill" style={{ borderColor: color, color }}>
                  {r.link.name.toUpperCase()} · {r.link.protocol.toUpperCase()} · {r.link.state.toUpperCase()}
                  {r.link.manual && <Icon name="lock" size={9} />}
                </span>
                <div className="pair-row head left">{portName(nodeA, r.aPort)}</div>
                <div className="pair-row head right">{portName(nodeB, r.bPort)}</div>
                {r.children.map((c, i) => (
                  <div key={`a${c.id}`} className="pair-row left" style={{ top: HEAD + i * ROW }}>
                    {c.a.toUpperCase()} <span className="muted">{c.aPin}</span>
                  </div>
                ))}
                {r.bOrder.map((c, j) => (
                  <div key={`b${c.id}`} className="pair-row right" style={{ top: HEAD + j * ROW }}>
                    <span className="muted">{c.bPin}</span> {c.b.toUpperCase()}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        <div className="pair-census">
          <div>
            <div className="section-title">NOT LINKED TO {nodeB.label} · {nodeA.ports.filter((p) => !linkedA.has(p.id)).length}</div>
            <div className="census-list">{nodeA.ports.filter((p) => !linkedA.has(p.id)).map((p) => <span key={p.id}>○ {p.name}</span>)}</div>
          </div>
          <div>
            <div className="section-title">NOT LINKED TO {nodeA.label} · {nodeB.ports.filter((p) => !linkedB.has(p.id)).length}</div>
            <div className="census-list">{nodeB.ports.filter((p) => !linkedB.has(p.id)).map((p) => <span key={p.id}>○ {p.name}</span>)}</div>
          </div>
        </div>
        <div className={`pair-verdict ${worstState}`}>
          {between.length} LINK{between.length === 1 ? "" : "S"} · {worstState.toUpperCase()}
        </div>
      </div>
    </div>
  );
}
