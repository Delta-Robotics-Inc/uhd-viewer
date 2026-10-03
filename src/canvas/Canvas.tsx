import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Background,
  Position,
  BackgroundVariant,
  ConnectionMode,
  ReactFlow,
  useNodesInitialized,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import type { ViewModel } from "../model/types";
import { colorFor, isFaded, type Classification } from "../model/classification";
import type { ComputedLayout } from "../layout/layout";
import type { LevelLayout, LinkLayout } from "../layout/layout";
import { nodeTypes, type NodeData } from "./nodes";
import { edgeTypes, type Detail, type LinkData } from "./LinkEdge";
import type { Pt } from "./routing";
import type { Live } from "../App";

const POSITION = { left: Position.Left, right: Position.Right, top: Position.Top, bottom: Position.Bottom };

export type Selection = { kind: "node" | "link"; id: string } | null;

/** Fit padding that keeps the diagram clear of the floating chrome: the header, the toolbar and, when open, the inspector. */
export const fitPadding = (inspector: boolean) =>
  ({ top: "56px", bottom: "72px", left: "64px", right: inspector ? "376px" : "64px" }) as const;

export interface CanvasProps {
  vm: ViewModel;
  /** The inspector is open over the right of the canvas (fitting leaves room for it). */
  inspector?: boolean;
  layout: ComputedLayout;
  hand?: LevelLayout;
  mode: Classification;
  detail: Detail;
  showGrounds: boolean;
  openLinks: Set<string>;
  selection: Selection;
  onSelect: (s: Selection) => void;
  onToggleLink: (id: string) => void;
  onLayout: (linkId: string, patch: LinkLayout) => void;
  onPins: (linkId: string, pins: Pt[]) => void;
  onToggleExpand: (id: string) => void;
  onMove: (id: string, x: number, y: number) => void;
  /** A drag starts (what moves) or ends (null): the layout reroutes only what moves meanwhile. */
  onLive: (live: Live | null) => void;
  /** A node to bring into view (a host's focus), once it is drawn; `seq` tells repeats apart. */
  centre?: { id: string; seq: number };
  /** Right-click on a node: its context menu at the pointer (the browser's own when not given). */
  onNodeContext?: (id: string, x: number, y: number) => void;
}

/**
 * Reuse last render's object for anything whose content did not change, so
 * React Flow's memoised node and edge wrappers skip it: a drag then re-renders
 * only what moves. Objects compare by identity, plain values by content.
 */
function stable<T extends { id: string }>(cache: Map<string, { key: unknown[]; value: T }>, id: string, key: unknown[], make: () => T): T {
  const hit = cache.get(id);
  const same = (a: unknown, b: unknown) => a === b || (typeof a === "object" && typeof b === "object" && a !== null && b !== null && !(a instanceof Set) && JSON.stringify(a) === JSON.stringify(b));
  if (hit && hit.key.length === key.length && hit.key.every((k, i) => same(k, key[i]))) return hit.value;
  const value = make();
  cache.set(id, { key, value });
  return value;
}

export function Canvas(props: CanvasProps) {
  const nodeCache = useRef(new Map<string, { key: unknown[]; value: Node<NodeData> }>());
  const edgeCache = useRef(new Map<string, { key: unknown[]; value: Edge<LinkData> }>());
  const { vm, layout, mode, selection } = props;

  // a selected link derived over nets lights up the lines it runs over
  const derivedSel = selection?.kind === "link" ? vm.derived.find((d) => d.id === selection.id) : undefined;
  const selectedIds = new Set(derivedSel ? derivedSel.via : selection?.kind === "link" ? [selection.id] : []);
  const selectedLinks = vm.links.filter((l) => selectedIds.has(l.linkId));

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
      const portKey = ports.map((p) => [p.port.id, p.x, p.y, p.side, p.links.map((l) => l.id + l.state).join()]);
      const ribbonKey = ports.filter((p) => ribbonPorts.has(`${node.id}|${p.port.id}`)).map((p) => p.port.id);
      const selected = selection?.kind === "node" && selection.id === node.id;
      const key = [node, box, parentBox, portKey, layout.groups[node.id], mode, props.showGrounds, [...selectedPorts], ribbonKey, selected];
      return stable(nodeCache.current, node.id, key, () => ({
        id: node.id,
        type: node.sheetPort ? "sheet" : node.kind === "harness" ? "harness" : node.kind === "net" ? "net" : node.expanded ? "container" : "module",
        position: parentBox ? { x: box.x - parentBox.x, y: box.y - parentBox.y } : { x: box.x, y: box.y },
        ...(node.parent ? { parentId: node.parent } : {}),
        data: { node, box, ports, groups: layout.groups[node.id] ?? [], mode, showGrounds: props.showGrounds, selectedPorts, ribbonPorts },
        selected: selection?.kind === "node" && selection.id === node.id,
        style: { width: box.w, height: box.h },
        // size and handle positions are known from the layout: handing them over means React Flow
        // never drops its measured handle bounds when a node object is replaced (which blanked
        // every edge for a frame on each change: the flicker while dragging)
        width: box.w,
        height: box.h,
        measured: { width: box.w, height: box.h },
        handles: ports.flatMap((p) =>
          (["source", "target"] as const).map((type) => ({ id: `p:${p.port.id}`, type, position: POSITION[p.side], x: p.x - box.x, y: p.y - box.y, width: 1, height: 1 })),
        ),
        zIndex: node.expanded ? 0 : 2,
      }));
    });
  }, [vm, layout, mode, props.showGrounds, selection, selectedLinks, ribbonPorts]);

  const { onSelect } = props;
  const onSelectLink = useCallback((id: string) => onSelect({ kind: "link", id }), [onSelect]);

  const edges = useMemo<Edge<LinkData>[]>(() => {
    return vm.links
      .filter((link) => layout.routes[link.id])
      .map((link) => {
        const color = colorFor(link, mode);
        const selected = selectedIds.has(link.linkId);
        const open = props.openLinks.has(link.linkId);
        const key = [
          link, layout.routes[link.id], color, mode, props.detail, open, props.openLinks, layout.runs[link.id], layout.labelAt[link.id],
          layout.labelFixed[link.id], layout.pins[link.id], layout.bends[link.id], layout.edits[link.id], selected,
          props.onToggleLink, props.onLayout, props.onPins, props.onLive, onSelectLink,
        ];
        return stable(edgeCache.current, link.id, key, () => ({
          id: link.id,
          type: "link",
          source: link.source.node,
          target: link.target.node,
          sourceHandle: `p:${link.source.port}`,
          targetHandle: `p:${link.target.port}`,
          selected,
          zIndex: link.passThrough ? 1 : 3,
          data: {
            link,
            points: layout.routes[link.id],
            color,
            faded: isFaded(link, mode),
            mode,
            detail: props.detail,
            open,
            openLanes: props.openLinks,
            run: layout.runs[link.id],
            labelAt: layout.labelAt[link.id],
            labelFixed: layout.labelFixed[link.id] ?? false,
            pins: layout.pins[link.id] ?? [],
            bends: layout.bends[link.id] ?? [],
            onToggle: props.onToggleLink,
            onToggleLane: props.onToggleLink,
            onSelect: onSelectLink,
            onLayout: props.onLayout,
            edit: layout.edits[link.id],
            onPins: props.onPins,
            onLive: props.onLive,
          },
        }));
      });
  }, [vm, layout, mode, selection, props.openLinks, props.detail, props.hand, props.onToggleLink, props.onLayout, props.onPins, props.onLive, onSelectLink]);

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

  // a host's focus: once the node is drawn (and after the initial fit), frame it
  const flow = useReactFlow();
  const drawn = useNodesInitialized();
  const centred = useRef(0);
  const { centre, inspector } = props;
  useEffect(() => {
    if (!centre || !drawn || centred.current === centre.seq || !nodes.some((n) => n.id === centre.id)) return;
    const t = setTimeout(() => {
      centred.current = centre.seq;
      void flow.fitView({ nodes: [{ id: centre.id }], padding: fitPadding(inspector ?? false), maxZoom: 1, duration: 300 });
    }, 60);
    return () => clearTimeout(t);
  }, [centre, drawn, nodes, flow, inspector]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      connectionMode={ConnectionMode.Loose}
      onNodesChange={onNodesChange}
      onNodeClick={(_, n) => props.onSelect({ kind: "node", id: n.id })}
      onNodeDragStart={(_, n, all) => props.onLive({ nodes: new Set([n.id, ...all.map((x) => x.id)]) })}
      onNodeDragStop={() => props.onLive(null)}
      onEdgeClick={(_, e) => props.onSelect({ kind: "link", id: vm.links.find((l) => l.id === e.id)?.linkId ?? e.id })}
      onNodeDoubleClick={(_, n) => props.onToggleExpand(n.id)}
      onNodeContextMenu={
        props.onNodeContext &&
        ((e, n) => {
          e.preventDefault();
          props.onSelect({ kind: "node", id: n.id });
          props.onNodeContext?.(n.id, e.clientX, e.clientY);
        })
      }
      onPaneClick={() => props.onSelect(null)}
      nodesConnectable={false}
      snapToGrid
      snapGrid={[16, 16]}
      elevateEdgesOnSelect
      fitView
      fitViewOptions={{ padding: fitPadding(props.inspector ?? false), maxZoom: 1.25 }}
      minZoom={0.2}
      maxZoom={2.5}
      attributionPosition="bottom-left"
    >
      <Background variant={BackgroundVariant.Dots} gap={16} size={1.6} color="var(--canvas-dot)" bgColor="var(--canvas-bg)" />
    </ReactFlow>
  );
}
