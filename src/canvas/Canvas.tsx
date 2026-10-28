import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Position,
  BackgroundVariant,
  ConnectionMode,
  ReactFlow,
  useNodesInitialized,
  useReactFlow,
  useStore,
  type Edge,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import type { ViewModel } from "../model/types";
import type { NodeMark } from "../api";
import { colorFor, isFaded, type Classification } from "../model/classification";
import type { ComputedLayout } from "../layout/layout";
import type { LevelLayout, LinkLayout } from "../layout/layout";
import { nodeTypes, type NodeData } from "./nodes";
import { edgeTypes, type Detail, type LinkData } from "./LinkEdge";
import type { Pt } from "./routing";
import type { Isolation } from "../model/isolate";
import type { Live } from "../viewer/controller";
import { frameViewport, linesBounds, revealViewport, selectionBounds } from "./reveal";
import { canvasCommand, firstView, interactionProps, typingTarget, type InteractionAction, type InteractionState, type Viewport } from "./interaction";
import { GRID } from "../layout/router";
import { createRightDrag } from "./rightDrag";

import { CanvasActionsContext, type CanvasActions } from "./actions";

/** A view command from outside the canvas (a toolbar, a menu): fit, or a zoom step; `seq` tells repeats apart. */
export interface ViewCommand {
  type: "fit" | "in" | "out" | "reset";
  seq: number;
}

/** Keys that add to the selection or take from it (a click on a module with one held). */
const MULTI_SELECT_KEYS = ["Meta", "Control", "Shift"];
const MODIFIED = (e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => e.shiftKey || e.ctrlKey || e.metaKey;

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
  /** Double-click on a node (default: expand it in place). */
  onOpenNode?: (id: string) => void;
  onMove: (id: string, x: number, y: number) => void;
  /** A drag starts (what moves) or ends (null): the layout reroutes only what moves meanwhile. */
  onLive: (live: Live | null) => void;
  /**
   * A node to bring into view (a host's focus, a row of the hierarchy), once it is drawn; `seq` tells repeats
   * apart. With `lines`, a harness drawn along lines (no card of its own): those lines are framed.
   */
  centre?: { id: string; seq: number; lines?: readonly string[] };
  /** A selection to bring into view if it is not (a host's select): panned to, zoomed out only if it must; `seq` tells repeats apart. */
  reveal?: { selection: NonNullable<Selection>; seq: number };
  /** Right-click on a node: its context menu at the pointer (the browser's own when not given). */
  onNodeContext?: (id: string, x: number, y: number) => void;
  /** The host's marks by definition id (`ViewerOptions.nodeMarks`). */
  marks?: Record<string, NodeMark>;
  /** Legend entries are isolated: what stays at full strength (the rest fades). */
  isolation?: Isolation | null;
  /** Modules selected together (a selection box, clicks with Shift, Ctrl or Cmd, select all): two or more, else empty. */
  group?: readonly string[];
  /** React Flow selected or unselected modules (a box, a click with a key held, a press on a module): the changes, a rail's taps named as the rail. */
  onSelectChanges?: (changes: { id: string; selected: boolean }[]) => void;
  /** The tool chosen and whether Space is held (default: select). */
  interaction?: InteractionState;
  onInteraction?: (action: InteractionAction) => void;
  /** Ctrl/Cmd+A, and Escape. */
  onSelectAll?: () => void;
  onEscape?: () => void;
  /** Fit or zoom, asked for by a toolbar or a menu. */
  command?: ViewCommand;
  /** The viewport saved for this level: put back when the canvas opens (none: the diagram is fitted). */
  viewport?: Viewport;
  /** The user moved the view (its viewport), or asked for a fit (null: nothing is kept, the next opening fits). */
  onViewport?: (viewport: Viewport | null) => void;
  /** Right-click on the empty canvas: its menu at the pointer (the browser's own when not given). */
  onPaneContext?: (x: number, y: number) => void;
}

const DEFAULT_INTERACTION: InteractionState = { tool: "select", space: false };
const NO_GROUP: readonly string[] = [];

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
  const isolation = props.isolation ?? null;
  const group = props.group ?? NO_GROUP;
  const interaction = props.interaction ?? DEFAULT_INTERACTION;
  const pointer = interactionProps(interaction);

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
      const selected = (selection?.kind === "node" && (selection.id === node.id || selection.id === node.tapOf)) || group.includes(node.id) || (node.tapOf !== undefined && group.includes(node.tapOf));
      const mark = node.defId ? props.marks?.[node.defId] : undefined;
      // isolated legend entries: a node none of their links touch fades, and on one that stays, the other ports
      const out = isolation ? !isolation.nodes.has(node.id) : false;
      const keptPorts = isolation && !out ? ports.filter((p) => isolation.ports.has(`${node.id}|${p.port.id}`)).map((p) => p.port.id) : undefined;
      const key = [node, box, parentBox, portKey, layout.groups[node.id], mode, props.showGrounds, [...selectedPorts], ribbonKey, selected, mark?.tone, mark?.label, mark?.shape, out, keptPorts ?? null];
      return stable(nodeCache.current, node.id, key, () => ({
        id: node.id,
        type: node.sheetPort ? "sheet" : node.kind === "harness" ? "harness" : node.kind === "net" ? "net" : node.expanded ? "container" : "module",
        position: parentBox ? { x: box.x - parentBox.x, y: box.y - parentBox.y } : { x: box.x, y: box.y },
        ...(node.parent ? { parentId: node.parent } : {}),
        data: { node, box, ports, groups: layout.groups[node.id] ?? [], mode, showGrounds: props.showGrounds, selectedPorts, ribbonPorts, ...(mark ? { mark } : {}), ...(keptPorts ? { keptPorts: new Set(keptPorts) } : {}) },
        selected,
        ...(out ? { className: "isolated-out" } : {}),
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
  }, [vm, layout, mode, props.showGrounds, selection, selectedLinks, ribbonPorts, isolation, group]);

  const { onSelect } = props;
  const onSelectLink = useCallback((id: string) => onSelect({ kind: "link", id }), [onSelect]);

  const edges = useMemo<Edge<LinkData>[]>(() => {
    return vm.links
      .filter((link) => layout.routes[link.id])
      .map((link) => {
        const color = colorFor(link, mode);
        const selected = selectedIds.has(link.linkId);
        const open = props.openLinks.has(link.linkId);
        const faded = isFaded(link, mode) || (isolation ? !isolation.links.has(link.id) : false);
        const key = [
          faded,
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
            faded,
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
  }, [vm, layout, mode, selection, props.openLinks, props.detail, props.hand, props.onToggleLink, props.onLayout, props.onPins, props.onLive, onSelectLink, isolation]);

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<NodeData>>[]) => {
      // React Flow's own selection (a box, a click with a key held, a press on a module): the viewer's follows it
      const canonical = (id: string) => vm.nodes.find((n) => n.id === id)?.tapOf ?? id;
      const picks = changes.flatMap((c) => (c.type === "select" ? [{ id: canonical(c.id), selected: c.selected }] : []));
      if (picks.length) props.onSelectChanges?.(picks);
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
  /** The user (or a host's focus) moved the view since the canvas opened: no automatic fit after that. */
  const moved = useRef(false);
  const centred = useRef(0);
  const { centre, inspector } = props;
  const paneWidth = useStore((s) => s.width);
  const paneHeight = useStore((s) => s.height);
  useEffect(() => {
    if (!centre || !drawn || centred.current === centre.seq) return;
    if (centre.lines) {
      // a harness along its lines: framed as a module is (centred, zoomed to fit, never past 1)
      const rect = linesBounds(layout, centre.lines);
      if (!rect || !paneWidth || !paneHeight) return;
      const t = setTimeout(() => {
        centred.current = centre.seq;
        moved.current = true;
        void flow.setViewport(frameViewport(rect, { width: paneWidth, height: paneHeight }, inspector ?? false), { duration: 300 });
      }, 60);
      return () => clearTimeout(t);
    }
    if (!nodes.some((n) => n.id === centre.id)) return;
    const t = setTimeout(() => {
      centred.current = centre.seq;
      moved.current = true;
      void flow.fitView({ nodes: [{ id: centre.id }], padding: fitPadding(inspector ?? false), maxZoom: 1, duration: 300 });
    }, 60);
    return () => clearTimeout(t);
  }, [centre, drawn, nodes, layout, flow, inspector, paneWidth, paneHeight]);

  // a host's select: when what it selected is off screen (or under the inspector), pan to it
  const revealed = useRef(0);
  const { reveal } = props;
  useEffect(() => {
    if (!reveal || !drawn || revealed.current === reveal.seq || !paneWidth || !paneHeight) return;
    const rect = selectionBounds(vm, layout, reveal.selection);
    if (!rect) return;
    const t = setTimeout(() => {
      revealed.current = reveal.seq;
      moved.current = true;
      const next = revealViewport(rect, flow.getViewport(), { width: paneWidth, height: paneHeight }, inspector ?? false);
      if (next) void flow.setViewport(next, { duration: 300 });
    }, 60);
    return () => clearTimeout(t);
  }, [reveal, drawn, vm, layout, flow, inspector, paneWidth, paneHeight]);

  // ---- the first view (item: fit on first open): a saved viewport is put back, else the diagram is fitted,
  // and fitted again when modules come or go (a project an agent is still building) until the user moves the view
  const saved = useRef(props.viewport);
  const restored = useRef(false);
  const fittedKey = useRef<string | null>(null);
  const fittedSize = useRef<string | null>(null);
  const nodesKey = useMemo(() => vm.nodes.map((n) => n.id).sort().join("|"), [vm]);
  const padding = fitPadding(inspector ?? false);
  useEffect(() => {
    const size = `${Math.round(paneWidth)}x${Math.round(paneHeight)}`;
    const step = firstView({ saved: saved.current, restored: restored.current, moved: moved.current, nodesKey, fittedKey: fittedKey.current, sized: Boolean(drawn && paneWidth && paneHeight), size, fittedSize: fittedSize.current });
    if (step.kind === "restore") {
      restored.current = true;
      void flow.setViewport(step.viewport);
    } else if (step.kind === "fit") {
      const first = fittedKey.current === null;
      fittedKey.current = nodesKey;
      fittedSize.current = size;
      void flow.fitView({ padding, maxZoom: 1.25, duration: first ? 0 : 300 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawn, paneWidth, paneHeight, nodesKey, flow]);

  // ---- fit and zoom asked for from outside (a toolbar, a menu) or by a key
  const { onViewport } = props;
  const keep = useCallback(
    (ms: number) => {
      moved.current = true;
      setTimeout(() => onViewport?.(flow.getViewport()), ms + 30);
    },
    [flow, onViewport],
  );
  const run = useCallback(
    (type: ViewCommand["type"]) => {
      if (type === "fit") {
        // a fit asked for is the diagram's own view again: nothing is kept, and modules that come later are fitted too
        saved.current = undefined;
        moved.current = false;
        fittedKey.current = nodesKey;
        fittedSize.current = null;
        onViewport?.(null);
        void flow.fitView({ padding, maxZoom: 1.25, duration: 300 });
      } else {
        if (type === "in") void flow.zoomIn({ duration: 200 });
        else if (type === "out") void flow.zoomOut({ duration: 200 });
        else void flow.zoomTo(1, { duration: 200 });
        keep(200);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [flow, nodesKey, onViewport, keep, inspector],
  );
  const ran = useRef(props.command?.seq ?? 0);
  const { command } = props;
  useEffect(() => {
    if (!command || ran.current === command.seq) return;
    ran.current = command.seq;
    run(command.type);
  }, [command, run]);

  // ---- the canvas's keys (interaction.ts): tools, select all, Escape, fit and zoom, arrow nudges; Space held pans
  const element = useRef<HTMLDivElement>(null);
  const keys = useRef({ props, nodes, layout, vm, run });
  keys.current = { props, nodes, layout, vm, run };
  useEffect(() => {
    if (typeof window === "undefined") return;
    /** A key is the canvas's when it is pressed on the page or inside this viewer, outside any field. */
    const ours = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      // (a host that made the viewer inert, behind an overlay of its own, gets no canvas keys either)
      if (e.defaultPrevented || typingTarget(t) || element.current?.closest("[inert]")) return false;
      const root = element.current?.closest(".uhd-root") ?? element.current;
      return !t || t === document.body || t === document.documentElement || Boolean(root?.contains(t));
    };
    const taken = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const down = (e: KeyboardEvent) => {
      if (!ours(e)) return;
      const { props: p, nodes: drawnNodes, layout: l, vm: model, run: act } = keys.current;
      if (e.key === " " || e.code === "Space") {
        // Space on a button presses it; anywhere else it is held to pan
        // (a module's own element is focusable and has a role; it does not use the key)
        if ((e.target as HTMLElement | null)?.closest?.("button, a[href], summary, [role='tab'], [role='menuitem']")) return;
        e.preventDefault();
        if (!e.repeat) p.onInteraction?.({ type: "space", down: true });
        return;
      }
      // Enter on a module reached with Tab selects it (the canvas has the keys, not React Flow: see disableKeyboardA11y)
      const focused = e.target as HTMLElement | null;
      if (e.key === "Enter" && focused?.classList?.contains("react-flow__node") && focused.dataset.id) {
        const node = model.nodes.find((n) => n.id === focused.dataset.id);
        if (node) p.onSelect({ kind: "node", id: node.tapOf ?? node.id });
        return taken(e);
      }
      const c = canvasCommand(e, GRID);
      if (!c) return;
      switch (c.type) {
        case "tool":
          if (!p.onInteraction) return;
          p.onInteraction(c);
          return taken(e);
        case "selectAll":
          if (!p.onSelectAll) return;
          p.onSelectAll();
          return taken(e);
        case "escape":
          // not taken: a menu, a tooltip and the host close on it too
          p.onEscape?.();
          return;
        case "fit":
          act("fit");
          return taken(e);
        case "zoom":
          act(c.by);
          return taken(e);
        case "nudge": {
          // the selected modules move a grid step (Shift: four); one inside a selected container moves with it
          const picked = drawnNodes.filter((n) => n.selected && !n.data.node.sheetPort && !n.data.node.tapOf);
          const ids = new Set(picked.map((n) => n.id));
          const moving = picked.filter((n) => !(n.data.node.parent && ids.has(n.data.node.parent)));
          if (!moving.length) return;
          for (const n of moving) {
            const box = l.boxes[n.id];
            if (box && model.nodes.some((x) => x.id === n.id)) p.onMove(n.id, box.x + c.dx, box.y + c.dy);
          }
          return taken(e);
        }
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === " " || e.code === "Space") keys.current.props.onInteraction?.({ type: "space", down: false });
    };
    const blur = () => keys.current.props.onInteraction?.({ type: "blur" });
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", blur);
    };
  }, []);

  // ---- the right button (rightDrag.ts): a drag pans the view with either tool, over the empty canvas, modules
  // and links; a click opens the canvas's menu where it was let go (a module's over a module, else the canvas's)
  const [rightPanning, setRightPanning] = useState(false);
  useEffect(() => {
    const el = element.current;
    if (!el || typeof window === "undefined") return;
    const nodeAt = (t: EventTarget | null) => (t as Element | null)?.closest?.(".react-flow__node") as HTMLElement | null;
    // the canvas's own surface: not a floating card or a menu a shell put inside it
    const onCanvas = (t: EventTarget | null) => Boolean((t as Element | null)?.closest?.(".react-flow__renderer, .react-flow__pane"));
    const gesture = createRightDrag<EventTarget | null>({
      viewport: () => flow.getViewport(),
      setViewport: (v) => void flow.setViewport(v),
      panStart: () => {
        moved.current = true;
        setRightPanning(true);
      },
      panEnd: (v) => {
        setRightPanning(false);
        keys.current.props.onViewport?.(v);
      },
      hasMenu: (t) => {
        const p = keys.current.props;
        return nodeAt(t)?.dataset.id ? Boolean(p.onNodeContext) : Boolean(p.onPaneContext);
      },
      openMenu: (t, x, y) => {
        const { props: p, vm: model } = keys.current;
        const id = nodeAt(t)?.dataset.id;
        if (id && p.onNodeContext) {
          const node = model.nodes.find((n) => n.id === id);
          const at = node?.tapOf ?? id;
          p.onSelect({ kind: "node", id: at });
          p.onNodeContext(at, x, y);
        } else p.onPaneContext?.(x, y);
      },
    });
    const at = (e: MouseEvent) => ({ x: e.clientX, y: e.clientY, target: e.target, button: e.button, buttons: e.buttons });
    const move = (e: PointerEvent) => {
      const was = gesture.panning;
      if (!gesture.move(at(e))) return;
      e.preventDefault();
      // the pan follows the pointer past the canvas's edge, and out of the window, until the button comes up
      if (!was) {
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          /* the pointer is already gone */
        }
      }
    };
    const stop = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
    };
    const up = (e: PointerEvent) => {
      if (gesture.up(at(e))) stop();
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType === "touch" || !onCanvas(e.target) || !gesture.down(at(e))) return;
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", up, true);
    };
    const menu = (e: MouseEvent) => {
      if (!onCanvas(e.target)) return;
      if (gesture.contextMenu(at(e))) {
        // the canvas's own menu (now or on release), not the browser's or the webview host's; not React Flow's handlers either
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const blur = () => {
      gesture.cancel();
      stop();
      setRightPanning(false);
    };
    el.addEventListener("pointerdown", down, true);
    el.addEventListener("contextmenu", menu, true);
    window.addEventListener("blur", blur);
    return () => {
      el.removeEventListener("pointerdown", down, true);
      el.removeEventListener("contextmenu", menu, true);
      window.removeEventListener("blur", blur);
      stop();
    };
  }, [flow]);

  // a double press of the middle button fits the diagram
  const middle = useRef({ at: 0, x: 0, y: 0 });
  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 1) return;
    const last = middle.current;
    const again = e.timeStamp - last.at < 400 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 5;
    middle.current = again ? { at: 0, x: 0, y: 0 } : { at: e.timeStamp, x: e.clientX, y: e.clientY };
    if (again) run("fit");
  };

  const actions = useMemo<CanvasActions>(() => ({ onToggleExpand: props.onToggleExpand }), [props.onToggleExpand]);

  return (
    <CanvasActionsContext.Provider value={actions}>
    <ReactFlow
      ref={element}
      className={`uhd-tool-${interaction.tool}${pointer.cursor === "grab" ? " uhd-grab" : ""}${rightPanning ? " uhd-right-panning" : ""}`}
      onMouseDown={onMouseDown}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      connectionMode={ConnectionMode.Loose}
      onNodesChange={onNodesChange}
      onNodeClick={(e, n) => {
        // with Shift, Ctrl or Cmd held the click adds to the selection or takes from it (onNodesChange)
        if (!MODIFIED(e)) props.onSelect({ kind: "node", id: n.data.node.tapOf ?? n.id });
      }}
      onNodeDragStart={(_, n, all) => props.onLive({ nodes: new Set([n.id, ...all.map((x) => x.id)]) })}
      onNodeDragStop={() => props.onLive(null)}
      onEdgeClick={(_, e) => props.onSelect({ kind: "link", id: vm.links.find((l) => l.id === e.id)?.linkId ?? e.id })}
      onNodeDoubleClick={(_, n) => (props.onOpenNode ?? props.onToggleExpand)(n.id)}
      onPaneClick={() => props.onSelect(null)}
      onMoveEnd={(e, viewport) => {
        // a pan or a zoom by the user (the view's own fits and a host's moves carry no event)
        if (!e) return;
        moved.current = true;
        onViewport?.(viewport);
      }}
      nodesConnectable={false}
      nodesDraggable={pointer.nodesDraggable}
      panOnDrag={pointer.panOnDrag}
      selectionOnDrag={pointer.selectionOnDrag}
      panActivationKeyCode={null}
      multiSelectionKeyCode={MULTI_SELECT_KEYS}
      deleteKeyCode={null}
      zoomOnDoubleClick={false}
      // the canvas has its own keys (above): React Flow's would act a second time on a focused module
      // (its Escape selects a module that Escape here has just unselected)
      disableKeyboardA11y
      snapToGrid
      snapGrid={[16, 16]}
      elevateEdgesOnSelect
      fitView={!props.viewport}
      {...(props.viewport ? { defaultViewport: props.viewport } : {})}
      fitViewOptions={{ padding, maxZoom: 1.25 }}
      minZoom={0.2}
      maxZoom={2.5}
      attributionPosition="bottom-left"
    >
      <Background variant={BackgroundVariant.Dots} gap={16} size={1.6} color="var(--uhd-canvas-dot)" bgColor="var(--uhd-canvas)" />
    </ReactFlow>
    </CanvasActionsContext.Provider>
  );
}
