/**
 * One link on the canvas (PB-803, design board 09 · D12).
 *
 * Basic mode: one line at each module; expanded, it flows out into one lane
 * per child (outer lanes first, inner last) and back. Detailed (ribbon) mode:
 * every conductor end to end at a tight pitch in its own colour over a soft
 * band; expanded, the conductors fan out into labelled lanes. A link that runs
 * through a harness gets a tight dotted region along the harness's span that
 * grows around whatever is drawn inside it, with the harness ends marked.
 *
 * The label sits above a rounded toggle box that spans what it opens; the two
 * move together along the route (drag the label). When the link is selected
 * its waypoints show: automatic bends hollow, pinned ones solid. Dragging a
 * bend pins it; double-clicking a pin releases it.
 */
import { useMemo, useRef, useState } from "react";
import { BaseEdge, EdgeLabelRenderer, useReactFlow, type Edge, type EdgeProps } from "@xyflow/react";
import type { ViewConductor, ViewLane, ViewLink } from "../model/types";
import { colorFor, conductorColor, type Classification } from "../model/classification";
import { filletPath, type Pt } from "./routing";
import {
  LANE_PITCH,
  RIBBON_PITCH,
  RUN,
  STAGE,
  at,
  lengths,
  densify,
  lane,
  offsets,
  project,
  regionOutline,
  ribbon,
  ribbonExpanded,
  stagedSpans,
  subpath,
  totalLength,
} from "./geometry";
import { offsetPolyline } from "./routing";
import { Icon } from "./Icon";
import { GRID } from "../layout/router";

export type Detail = "basic" | "ribbon";

export interface LinkData extends Record<string, unknown> {
  link: ViewLink;
  points: Pt[];
  color: string;
  faded: boolean;
  mode: Classification;
  detail: Detail;
  /** Expanded (lanes shown). */
  open: boolean;
  openLanes: Set<string>;
  /** Harness span along the route (arc lengths). */
  run?: [number, number];
  /** Label + toggle position (arc length); absent: no label. */
  labelAt?: number;
  pins: Pt[];
  bends: Pt[];
  onToggle: (id: string) => void;
  onToggleLane: (id: string) => void;
  onLabel: (linkId: string, t: number) => void;
  onPins: (linkId: string, pins: Pt[]) => void;
}

export type LinkEdgeType = Edge<LinkData, "link">;

const RADIUS = 12;

/** Lanes to draw: opened nested bundles are replaced by their own lanes. */
function flatten(lanes: ViewLane[], open: Set<string>): { lane: ViewLane; parent?: ViewLane }[] {
  return lanes.flatMap((l) => (l.children.length > 1 && open.has(l.id) ? l.children.map((c) => ({ lane: c, parent: l })) : [{ lane: l }]));
}

const horizontal = (d: Pt) => Math.abs(d[0]) > Math.abs(d[1]);

/** The longest straight part of [s0, s1] if it is at least `need` long, else [s0, s1]. */
function straightest(points: Pt[], s0: number, s1: number, need: number): [number, number] {
  const L = lengths(points);
  let best: [number, number] = [s0, s1];
  let bestLen = 0;
  for (let i = 1; i < points.length; i++) {
    const a = Math.max(s0, L[i - 1] + 8);
    const b = Math.min(s1, L[i] - 8);
    if (b - a > bestLen) {
      bestLen = b - a;
      best = [a, b];
    }
  }
  return bestLen >= need ? best : [s0, s1];
}

export function LinkEdge({ id, data, selected }: EdgeProps<LinkEdgeType>) {
  const flow = useReactFlow();
  const [drag, setDrag] = useState<{ kind: "pin" | "bend"; index: number; at: Pt } | null>(null);
  const labelDrag = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  const geo = useMemo(() => {
    if (!data || data.points.length < 2) return null;
    // conductors follow the classification: domain, DRC state, or signal type
    const tint = (c: ViewConductor) =>
      data.mode === "signal" ? conductorColor(c.protocol) : colorFor({ domain: c.domain, protocol: c.protocol, state: c.state }, data.mode);
    const { link, points, detail, open, run } = data;
    const L = totalLength(points);
    const edge = Math.min(40, L * 0.15);
    const [r0, r1] = run ? [run[0] + GRID, run[1] - GRID] : [edge, L - edge];
    // fan out along the longest straight stretch available, so lanes don't bunch around bends
    const [e0, e1] = straightest(points, r0, r1, 2 * RUN + 2 * STAGE + 48);
    const conductors = link.conductors ?? [];
    const ribbonMode = detail === "ribbon" && conductors.length > 1;
    const lanes = ribbonMode ? [] : flatten(link.lanes ?? [], data.openLanes);
    const expandable = ribbonMode ? conductors.length > 1 : (link.lanes?.length ?? 0) > 1;
    const expanded = open && expandable && e1 - e0 > 2 * RUN + 16;

    // what gets drawn
    const lines: { d: string; color: string; width: number; key: string; dashed?: boolean }[] = [];
    const samples: Pt[] = [];
    const names: { s: number; o: number; text: string; color: string; swatch?: boolean }[] = [];
    let span = 20;
    let band: string | undefined;
    let straight: [number, number] = [0, L];

    if (ribbonMode) {
      const n = conductors.length;
      if (expanded) {
        const shapes = ribbonExpanded(points, n, e0, e1);
        shapes.forEach((sh, i) => {
          lines.push({ d: sh.d, color: tint(conductors[i]), width: 2.4, key: conductors[i].id });
          samples.push(...sh.samples);
        });
        const offs = offsets(n, LANE_PITCH);
        conductors.forEach((c, i) => names.push({ s: e0 + RUN + 20, o: offs[i], text: c.label, color: tint(c), swatch: true }));
        band = regionOutline(shapes.flatMap((s) => s.samples), 5);
        span = (n - 1) * LANE_PITCH + 16;
        straight = [e0 + RUN, e1 - RUN];
      } else {
        ribbon(points, n).forEach((r, i) => {
          lines.push({ d: r.d, color: tint(conductors[i]), width: 2.4, key: conductors[i].id });
          samples.push(...r.samples);
        });
        span = n * RIBBON_PITCH + 4;
      }
    } else if (expanded) {
      const n = lanes.length;
      const offs = offsets(n, LANE_PITCH);
      const spans = stagedSpans(offs, e0, e1);
      const innerStart = Math.max(...spans.map((s) => s[0]));
      const innerEnd = Math.min(...spans.map((s) => s[1]));
      const near = subpath(data.points, 0, innerStart);
      const far = subpath(data.points, innerEnd, L);
      lines.push({ d: filletPath(near, RADIUS), color: data.color, width: 2, key: "near" }, { d: filletPath(far, RADIUS), color: data.color, width: 2, key: "far" });
      samples.push(...densify(near), ...densify(far));
      lanes.forEach(({ lane: l }, i) => {
        const sh = lane(points, offs[i], spans[i][0], spans[i][1]);
        const color = data.mode === "domain" ? data.color : colorFor(l, data.mode);
        lines.push({ d: sh.d, color, width: 2, key: l.id });
        samples.push(...sh.samples);
        names.push({ s: innerStart + RUN + 6, o: offs[i], text: l.name, color });
      });
      span = (n - 1) * LANE_PITCH + 16;
      straight = [innerStart + RUN, innerEnd - RUN];
    } else {
      samples.push(...densify(points));
      span = 20;
    }

    // harness region: tight to what runs inside the harness span
    let region: string | undefined;
    let regionBox: { x: number; y: number; below: boolean } | undefined;
    if (run) {
      const inside = (p: Pt) => {
        const s = project(points, p);
        return s >= run[0] - 1 && s <= run[1] + 1;
      };
      const core = ribbonMode && !expanded
        ? offsets(conductors.length, RIBBON_PITCH).flatMap((o) => densify(offsetPolyline(subpath(points, run[0], run[1]), o, RADIUS).points))
        : densify(subpath(points, run[0], run[1]));
      const inner = [...core, ...samples.filter(inside)];
      region = regionOutline(inner, 10);
      // the name tab sits on top of the region; on a short run it moves underneath, clear of the label
      const below = run[1] - run[0] < 260;
      regionBox = {
        x: Math.min(...inner.map((p) => p[0])) - 10,
        y: below ? Math.max(...inner.map((p) => p[1])) + 10 : Math.min(...inner.map((p) => p[1])) - 10,
        below,
      };
    }

    // label + toggle: kept on the part of the route where the lanes run straight
    let labelAt = data.labelAt;
    if (labelAt !== undefined && expanded) labelAt = Math.max(straight[0] + 8, Math.min(straight[1] - 8, labelAt));
    const anchor = labelAt !== undefined ? at(points, labelAt) : undefined;

    // nested bundles: a small toggle on each lane that is itself a bundle
    const nested: { id: string; p: Pt; d: Pt; open: boolean; span: number }[] = [];
    if (expanded && !ribbonMode) {
      const offs = offsets(lanes.length, LANE_PITCH);
      // beside the main toggle, on whichever side has room
      const main = labelAt ?? (straight[0] + straight[1]) / 2;
      const s = main + 44 <= straight[1] - 8 ? main + 44 : Math.max(straight[0] + 8, main - 44);
      const seen = new Set<string>();
      lanes.forEach(({ lane: l, parent }, i) => {
        const owner = parent ?? l;
        if (owner.children.length < 2 || seen.has(owner.id)) return;
        seen.add(owner.id);
        const members = lanes.map((x, k) => ({ x, k })).filter(({ x }) => (x.parent ?? x.lane).id === owner.id).map(({ k }) => offs[k]);
        const mid = (Math.min(...members) + Math.max(...members)) / 2;
        const a = at(points, s);
        const nrm: Pt = [a.d[1], -a.d[0]];
        nested.push({ id: owner.id, p: [a.p[0] + nrm[0] * mid, a.p[1] + nrm[1] * mid], d: a.d, open: Boolean(parent), span: parent ? Math.max(...members) - Math.min(...members) + 12 : 16 });
      });
    }

    return { L, lines, samples, names, span, band, region, regionBox, anchor, ribbonMode, expandable, expanded, nested, conductors, tint };
  }, [data]);

  if (!data || !geo) return null;
  const { link, points, color, faded } = data;
  const opacity = faded ? 0.16 : link.passThrough ? 0.55 : 1;
  const main = filletPath(points, RADIUS);
  const toFlow = (e: React.PointerEvent): Pt => {
    const p = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    return [p.x, p.y];
  };
  const snapPt = (p: Pt): Pt => [Math.round(p[0] / GRID) * GRID, Math.round(p[1] / GRID) * GRID];

  const handleAt = (s: number, key: string) => {
    const { p, d } = at(points, s);
    const n = geo.conductors.length;
    const len = n * RIBBON_PITCH + 2;
    const horiz = horizontal(d);
    const offs = offsets(n, RIBBON_PITCH);
    const nrm: Pt = [d[1], -d[0]];
    return (
      <g key={key}>
        <rect
          x={p[0] - (horiz ? 4 : len / 2)}
          y={p[1] - (horiz ? len / 2 : 4)}
          width={horiz ? 8 : len}
          height={horiz ? len : 8}
          rx={3}
          fill="none"
          stroke={color}
          strokeWidth={1.3}
        />
        {geo.conductors.map((c, i) => (
          <circle key={c.id} cx={p[0] + nrm[0] * offs[i]} cy={p[1] + nrm[1] * offs[i]} r={2.2} fill={geo.tint(c)} />
        ))}
      </g>
    );
  };

  const endMark = (s: number, key: string) => {
    const { p } = at(points, s);
    return <rect key={key} x={p[0] - 4} y={p[1] - 4} width={8} height={8} rx={1} fill="var(--canvas-bg)" stroke={color} strokeWidth={1.5} />;
  };

  const toggle = (p: Pt, d: Pt, span: number, isOpen: boolean, onClick: () => void, key: string, small = false) => {
    const horiz = horizontal(d);
    const w = horiz ? 16 : span;
    const h = horiz ? span : 16;
    return (
      <g
        key={key}
        className="link-toggle-box nodrag nopan"
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        style={{ cursor: "pointer", pointerEvents: "all" }}
      >
        <rect x={p[0] - w / 2} y={p[1] - h / 2} width={w} height={h} rx={4} fill="var(--canvas-bg)" stroke={color} strokeWidth={1.5} />
        <path
          d={isOpen ? `M${p[0] - 3.5},${p[1]} h7` : `M${p[0] - 3.5},${p[1]} h7 M${p[0]},${p[1] - 3.5} v7`}
          stroke={color}
          strokeWidth={small ? 1.2 : 1.5}
          strokeLinecap="round"
        />
      </g>
    );
  };

  const commitPins = (dragged: { kind: "pin" | "bend"; index: number }, to: Pt) => {
    const pins = [...data.pins];
    if (dragged.kind === "pin") pins[dragged.index] = to;
    else {
      const s = project(points, data.bends[dragged.index]);
      const order = pins.map((p) => project(points, p));
      const at = order.findIndex((o) => o > s);
      pins.splice(at < 0 ? pins.length : at, 0, to);
    }
    data.onPins(link.linkId, pins);
  };

  const waypoint = (p: Pt, kind: "pin" | "bend", index: number) => {
    const live = drag && drag.kind === kind && drag.index === index ? drag.at : p;
    return (
      <g
        key={`${kind}${index}`}
        className="nodrag nopan"
        style={{ cursor: "move", pointerEvents: "all" }}
        onPointerDown={(e) => {
          e.stopPropagation();
          (e.target as Element).setPointerCapture(e.pointerId);
          setDrag({ kind, index, at: p });
        }}
        onPointerMove={(e) => {
          if (drag && drag.kind === kind && drag.index === index) setDrag({ ...drag, at: snapPt(toFlow(e)) });
        }}
        onPointerUp={(e) => {
          if (!drag) return;
          const to = snapPt(toFlow(e));
          setDrag(null);
          if (Math.hypot(to[0] - p[0], to[1] - p[1]) >= 1) commitPins({ kind, index }, to);
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          if (kind === "pin") data.onPins(link.linkId, data.pins.filter((_, i) => i !== index));
        }}
      >
        <circle cx={live[0]} cy={live[1]} r={9} fill="transparent" />
        {kind === "pin" ? (
          <rect x={live[0] - 4.5} y={live[1] - 4.5} width={9} height={9} rx={2} fill="var(--brand)" stroke="var(--canvas-bg)" strokeWidth={1.5} />
        ) : (
          <circle cx={live[0]} cy={live[1]} r={4.5} fill="var(--canvas-bg)" stroke="var(--text-muted)" strokeWidth={1.5} />
        )}
      </g>
    );
  };

  const anchor = geo.anchor;
  const labelPos = anchor
    ? horizontal(anchor.d)
      ? { x: anchor.p[0], y: anchor.p[1] - geo.span / 2 - 4, tf: "translate(-50%, -100%)" }
      : { x: anchor.p[0] + geo.span / 2 + 6, y: anchor.p[1], tf: "translate(0, -50%)" }
    : undefined;
  const n = geo.ribbonMode ? geo.conductors.length : (link.lanes?.length ?? 0);

  return (
    <>
      {geo.region && (
        <path d={geo.region} fill="#ffffff0d" stroke="var(--text-muted)" strokeWidth={1.8} strokeDasharray="0 6" strokeLinecap="round" opacity={faded ? 0.3 : 1} />
      )}
      {selected && <path d={main} className="edge-glow" stroke={color} strokeWidth={Math.max(8, geo.span * 0.6)} />}
      {geo.ribbonMode &&
        (geo.band ? (
          <path d={geo.band} fill={color} fillOpacity={0.15} stroke="none" />
        ) : (
          <path d={main} fill="none" stroke={color} strokeOpacity={0.15} strokeWidth={geo.conductors.length * RIBBON_PITCH + 4} strokeLinejoin="round" />
        ))}
      {geo.lines.length ? (
        geo.lines.map((l) => <path key={l.key} d={l.d} fill="none" stroke={l.color} strokeWidth={l.width} opacity={opacity} strokeLinecap="round" strokeLinejoin="round" />)
      ) : (
        <BaseEdge
          id={id}
          path={main}
          style={{
            stroke: color,
            strokeWidth: link.passThrough ? 1.4 : geo.expandable ? 3 : 2,
            opacity,
            strokeDasharray: link.passThrough ? "4 4" : undefined,
          }}
        />
      )}
      <path d={main} fill="none" stroke="transparent" strokeWidth={16} className="react-flow__edge-interaction" />

      {geo.ribbonMode && [handleAt(0.5, "h0"), handleAt(geo.L - 0.5, "h1")]}
      {data.run && (geo.ribbonMode ? [handleAt(data.run[0], "r0"), handleAt(data.run[1], "r1")] : [endMark(data.run[0], "m0"), endMark(data.run[1], "m1")])}

      {anchor && geo.expandable && toggle(anchor.p, anchor.d, geo.expanded ? geo.span : geo.ribbonMode ? geo.span : 20, geo.expanded, () => data.onToggle(link.linkId), "toggle")}
      {geo.nested.map((t) => toggle(t.p, t.d, t.open ? t.span : 16, t.open, () => data.onToggleLane(t.id), `n${t.id}`, true))}

      {selected && !link.passThrough && (
        <g>
          {data.bends.map((p, i) => waypoint(p, "bend", i))}
          {data.pins.map((p, i) => waypoint(p, "pin", i))}
        </g>
      )}

      <EdgeLabelRenderer>
        {data.run?.length && link.run?.tab && geo.regionBox && (
          <div
            className={`harness-tab${geo.regionBox.below ? " below" : ""}`}
            style={{ transform: `translate(${geo.regionBox.x}px, ${geo.regionBox.y}px) translate(0, ${geo.regionBox.below ? "0" : "-100%"})`, opacity: faded ? 0.3 : 1 }}
          >
            <Icon name={link.run.icon} size={10} color={color} />
            <span>{link.run.name}</span>
          </div>
        )}
        {geo.expanded &&
          geo.names.map((nm, i) => {
            const a = at(points, nm.s);
            const nrm: Pt = [a.d[1], -a.d[0]];
            const [x, y] = [a.p[0] + nrm[0] * nm.o, a.p[1] + nrm[1] * nm.o];
            // along the lane: rotated on vertical runs, reading in the direction of travel
            const rot = horizontal(a.d) ? (a.d[0] < 0 ? "rotate(180deg)" : "") : a.d[1] > 0 ? "rotate(90deg)" : "rotate(-90deg)";
            return (
              <div
                key={i}
                className="lane-name"
                style={{ transform: `translate(${x}px, ${y}px) ${rot} translate(0, -50%)`, transformOrigin: "0 0", opacity: faded ? 0.3 : 1 }}
              >
                {nm.swatch && <span className="lane-swatch" style={{ background: nm.color }} />}
                {nm.text}
              </div>
            );
          })}
        {!link.passThrough && labelPos && (
          <div
            className={`link-label nodrag nopan${selected ? " selected" : ""}`}
            style={{ transform: `${labelPos.tf} translate(${labelPos.x}px, ${labelPos.y}px)`, borderColor: color, color, opacity: faded ? 0.25 : 1, cursor: "grab" }}
            title="Drag along the link to move the label and toggle"
            onPointerDown={(e) => {
              e.stopPropagation();
              (e.currentTarget as Element).setPointerCapture(e.pointerId);
              labelDrag.current = { x: e.clientX, y: e.clientY, moved: false };
            }}
            onPointerMove={(e) => {
              const d = labelDrag.current;
              if (!d) return;
              if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
              d.moved = true;
              data.onLabel(link.linkId, project(points, toFlow(e)) / geo.L);
            }}
            onPointerUp={() => {
              labelDrag.current = null;
            }}
          >
            {link.manual && <Icon name="lock" size={9} />}
            <span>{link.name.toUpperCase()}</span>
            {geo.expandable && !geo.expanded && <span className="link-count">×{n}</span>}
          </div>
        )}
      </EdgeLabelRenderer>
    </>
  );
}

export const edgeTypes = { link: LinkEdge };
