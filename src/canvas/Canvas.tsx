import { useCallback, useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  ReactFlow,
  type Edge,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import type { ViewModel } from "../model/types";
import { colorFor, isFaded, type Classification } from "../model/classification";
import type { ComputedLayout } from "../layout/layout";
import type { LevelLayout } from "../layout/layout";
import { nodeTypes, type NodeData } from "./nodes";
import { edgeTypes, type Detail, type LinkData } from "./LinkEdge";
import type { Pt } from "./routing";

export type Selection = { kind: "node" | "link"; id: string } | null;

export interface CanvasProps {
  vm: ViewModel;
  layout: ComputedLayout;
  hand?: LevelLayout;
  mode: Classification;
  detail: Detail;
  showGrounds: boolean;
  openLinks: Set<string>;
  selection: Selection;
  onSelect: (s: Selection) => void;
  onToggleLink: (id: string) => void;
  onLabel: (linkId: string, t: number) => void;
  onPins: (linkId: string, pins: Pt[]) => void;
  onToggleExpand: (id: string) => void;
  onMove: (id: string, x: number, y: number) => void;
}

export function Canvas(props: CanvasProps) {
  const { vm, layout, mode, selection } = props;

  const selectedLinks = selection?.kind === "link" ? vm.links.filter((l) => l.linkId === selection.id) : [];

  // in ribbon mode a multi-conductor link ends in its own pin handle, so the port dot underneath is hidden
  const ribbonPorts = useMemo(() => {
    const out = new Set<string>();
    if (props.detail !== "ribbon") return out;
    for (const l of vm.links) if ((l.conductors?.length ?? 0) > 1 && layout.routes[l.id]) for (const e of [l.source, l.target]) out.add(`${e.node}|${e.port}`);
    return out;
  }, [vm, layout, props.detail]);

  const nodes = useMemo<Node<NodeData>[]>(() => {
    // parents before children, as React Flow requires
    const ordered = [...vm.nodes].sort((a, b) => Number(Boolean(a.parent)) - Number(Boolean(b.parent)));
    return ordered.map((node) => {
      const box = layout.boxes[node.id];
      const parentBox = node.parent ? layout.boxes[node.parent] : undefined;
      const ports = Object.values(layout.ports).filter((p) => p.node === node.id);
      const selectedPorts = new Set<string>();
      for (const l of selectedLinks) {
        for (const end of [l.source, l.target]) if (end.node === node.id) selectedPorts.add(end.port);
      }
      return {
        id: node.id,
        type: node.sheetPort ? "sheet" : node.kind === "harness" ? "harness" : node.expanded ? "container" : "module",
        position: parentBox ? { x: box.x - parentBox.x, y: box.y - parentBox.y } : { x: box.x, y: box.y },
        ...(node.parent ? { parentId: node.parent } : {}),
        data: { node, box, ports, groups: layout.groups[node.id] ?? [], mode, showGrounds: props.showGrounds, selectedPorts, ribbonPorts },
        selected: selection?.kind === "node" && selection.id === node.id,
        style: { width: box.w, height: box.h },
        zIndex: node.expanded ? 0 : 2,
      };
    });
  }, [vm, layout, mode, props.showGrounds, selection, selectedLinks, ribbonPorts]);

  const edges = useMemo<Edge<LinkData>[]>(() => {
    return vm.links
      .filter((link) => layout.routes[link.id])
      .map((link) => {
        const color = colorFor(link, mode);
        return {
          id: link.id,
          type: "link",
          source: link.source.node,
          target: link.target.node,
          sourceHandle: `p:${link.source.port}`,
          targetHandle: `p:${link.target.port}`,
          selected: selection?.kind === "link" && selection.id === link.linkId,
          zIndex: link.passThrough ? 1 : 3,
          data: {
            link,
            points: layout.routes[link.id],
            color,
            faded: isFaded(link, mode),
            mode,
            detail: props.detail,
            open: props.openLinks.has(link.linkId),
            openLanes: props.openLinks,
            run: layout.runs[link.id],
            labelAt: layout.labelAt[link.id],
            labelFixed: layout.labelFixed[link.id] ?? false,
            pins: layout.pins[link.id] ?? [],
            bends: layout.bends[link.id] ?? [],
            onToggle: props.onToggleLink,
            onToggleLane: props.onToggleLink,
            onLabel: props.onLabel,
            onPins: props.onPins,
          },
        };
      });
  }, [vm, layout, mode, selection, props.openLinks, props.detail, props.hand, props.onToggleLink, props.onLabel, props.onPins]);

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<NodeData>>[]) => {
      for (const change of changes) {
        if (change.type !== "position" || !change.position) continue;
        const node = vm.nodes.find((n) => n.id === change.id);
        const parentBox = node?.parent ? layout.boxes[node.parent] : undefined;
        props.onMove(change.id, change.position.x + (parentBox?.x ?? 0), change.position.y + (parentBox?.y ?? 0));
      }
    },
    [vm, layout, props],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      connectionMode={ConnectionMode.Loose}
      onNodesChange={onNodesChange}
      onNodeClick={(_, n) => props.onSelect({ kind: "node", id: n.id })}
      onEdgeClick={(_, e) => props.onSelect({ kind: "link", id: vm.links.find((l) => l.id === e.id)?.linkId ?? e.id })}
      onNodeDoubleClick={(_, n) => props.onToggleExpand(n.id)}
      onPaneClick={() => props.onSelect(null)}
      nodesConnectable={false}
      snapToGrid
      snapGrid={[16, 16]}
      elevateEdgesOnSelect
      fitView
      fitViewOptions={{ padding: 0.08 }}
      minZoom={0.2}
      maxZoom={2.5}
      attributionPosition="bottom-left"
    >
      <Background variant={BackgroundVariant.Dots} gap={16} size={1.6} color="var(--canvas-dot)" bgColor="var(--canvas-bg)" />
    </ReactFlow>
  );
}
