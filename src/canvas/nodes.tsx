import type { Node, NodeProps } from "@xyflow/react";
import type { Box, PlacedPort, PortGroup } from "../layout/layout";
import type { ViewNode } from "../model/types";
import { colorFor, isFaded, type Classification } from "../model/classification";
import { Icon } from "./Icon";
import { Port } from "./Port";

export interface NodeData extends Record<string, unknown> {
  node: ViewNode;
  box: Box;
  ports: PlacedPort[];
  groups: PortGroup[];
  mode: Classification;
  showGrounds: boolean;
  selectedPorts: Set<string>;
}

export type ModuleNodeType = Node<NodeData, "module">;
export type ContainerNodeType = Node<NodeData, "container">;
export type SheetNodeType = Node<NodeData, "sheet">;
export type HarnessNodeType = Node<NodeData, "harness">;

const STATUS: Record<string, string> = {
  configured: "var(--drc-configured)",
  partial: "var(--drc-partial)",
  incompatible: "var(--drc-incompatible)",
  unconfigured: "var(--drc-unconfigured)",
};

function portColor(p: PlacedPort, mode: Classification): string {
  const link = p.links.find((l) => !l.passThrough) ?? p.links[0];
  return colorFor({ domain: p.port.domain, protocol: link?.protocol ?? p.port.protocol, state: link?.state }, mode);
}

/**
 * Ports are absolutely positioned inside the node's element, whose origin is
 * inside its border: `border` shifts them back so each dot sits exactly on
 * the port point where its links end.
 */
function Ports({ data, labels, border = 2 }: { data: NodeData; labels: boolean; border?: number }) {
  const { box, ports, mode, showGrounds, selectedPorts, node } = data;
  const perSide = (side: string) => ports.filter((q) => q.side === side).length;
  const widthFor = (p: PlacedPort) =>
    p.side === "left" || p.side === "right"
      ? Math.max(40, box.w / 2 - 54)
      : Math.max(30, Math.min(84, (box.w - 32) / (perSide(p.side) + 1) - 4));
  return (
    <>
      {ports.map((p) => {
        const onlyGround = p.links.every((l) => l.ground);
        return (
          <Port
            key={p.port.id}
            placed={p}
            x={p.x - box.x - border}
            y={p.y - box.y - border}
            color={portColor(p, mode)}
            faded={isFaded({ domain: p.port.domain, protocol: p.port.protocol }, mode)}
            exported={Boolean(p.port.exported) && node.expanded}
            label={labels}
            ground={onlyGround && !showGrounds}
            selected={selectedPorts.has(p.port.id)}
            labelWidth={widthFor(p)}
          />
        );
      })}
    </>
  );
}

function PortGroups({ groups, mode }: { groups: PortGroup[]; mode: Classification }) {
  if (!groups.length) return null;
  const shown = groups.slice(0, 4);
  const rest = groups.slice(4).reduce((n, g) => n + g.count, 0);
  return (
    <div className="port-groups">
      {shown.map((g) => (
        <span key={g.protocol} className="port-group" style={{ borderColor: colorFor({ domain: g.domain, protocol: g.protocol }, mode) }}>
          {g.protocol.replace(/_/g, " ").toUpperCase()} ×{g.count}
        </span>
      ))}
      {rest > 0 && <span className="port-group muted">+{rest}</span>}
    </div>
  );
}

export function ModuleNode({ data, selected }: NodeProps<ModuleNodeType>) {
  const { node, box } = data;
  const circle = node.shape === "circle";
  return (
    <div
      className={`module-card${circle ? " circle" : ""}${selected ? " selected" : ""}`}
      style={{ width: box.w, height: box.h, ["--status" as string]: STATUS[node.status] }}
      title={node.description}
    >
      <span className="status-dot" style={{ background: STATUS[node.status] }} />
      <div className="module-body">
        <Icon name={node.icon} size={circle ? 18 : 22} strokeWidth={1.6} />
        <div className="module-title">{node.label}</div>
        {!circle && <PortGroups groups={data.groups} mode={data.mode} />}
      </div>
      <Ports data={data} labels={!circle} border={2} />
    </div>
  );
}

export function ContainerNode({ data, selected }: NodeProps<ContainerNodeType>) {
  const { node, box } = data;
  const group = node.kind === "group";
  return (
    <div className={`container${group ? " group" : ""}${selected ? " selected" : ""}`} style={{ width: box.w, height: box.h }}>
      {/* not position: relative, so its ports are placed from the node wrapper (no border offset) */}
      <div className="container-label">
        <Icon name={node.icon} size={12} strokeWidth={1.8} />
        <span>{node.label}</span>
        <span className="container-kind">{group ? "GROUP" : "MODULE"}</span>
      </div>
      <Ports data={data} labels={false} border={0} />
    </div>
  );
}

export function SheetNode({ data, selected }: NodeProps<SheetNodeType>) {
  const { node, box } = data;
  const port = data.ports[0];
  const color = port ? portColor(port, data.mode) : "var(--text-muted)";
  return (
    <div className={`sheet-port${selected ? " selected" : ""}`} style={{ width: box.w, height: box.h, borderColor: color }}>
      <Icon name={port?.side === "left" ? "arrow-left-from-line" : "arrow-right-to-line"} size={12} color={color} />
      <span>{node.label}</span>
      <Ports data={data} labels={false} border={1} />
    </div>
  );
}

/** A harness module drawn as the carrier node its links pass through (design D2, board 04). */
export function HarnessNode({ data, selected }: NodeProps<HarnessNodeType>) {
  const { node, box } = data;
  const color = data.ports[0] ? portColor(data.ports[0], data.mode) : "var(--text-muted)";
  return (
    <div className={`harness-node${selected ? " selected" : ""}`} style={{ width: box.w, height: box.h, borderColor: color }} title={node.description}>
      <Icon name={node.icon} size={12} color={color} />
      <span className="harness-name">{node.label}</span>
      <span className="harness-kind">HARNESS</span>
      <Ports data={data} labels={false} border={1.5} />
    </div>
  );
}

export const nodeTypes = { module: ModuleNode, container: ContainerNode, sheet: SheetNode, harness: HarnessNode };
