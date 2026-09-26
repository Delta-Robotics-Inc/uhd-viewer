import { BaseEdge, EdgeLabelRenderer, type Edge, type EdgeProps } from "@xyflow/react";
import type { ViewLink } from "../model/types";
import { filletPath, longestSegmentMid, offsetPolyline, pointAt, type Pt } from "./routing";
import { Icon } from "./Icon";

export interface LinkData extends Record<string, unknown> {
  link: ViewLink;
  points: Pt[];
  color: string;
  faded: boolean;
  /** Link is cut open (editable child links, design D4). */
  open: boolean;
  /** Draw child conductors side by side (design D5). */
  conductors: boolean;
  /** Label anchor from the layout; absent means no label. */
  label?: Pt;
  onToggle: (id: string) => void;
}

export type LinkEdgeType = Edge<LinkData, "link">;

const RADIUS = 12;
const PITCH = 5;

export function LinkEdge({ id, data, selected }: EdgeProps<LinkEdgeType>) {
  if (!data || data.points.length < 2) return null;
  const { link, points, color, faded, open, conductors } = data;
  const n = link.children.length;
  const expandable = n > 1;
  const split = expandable && (open || conductors);
  const opacity = faded ? 0.16 : link.passThrough ? 0.55 : 1;
  const [lx, ly] = data.label ?? pointAt(points, longestSegmentMid(points));
  const main = filletPath(points, RADIUS);

  const lines = split
    ? link.children.map((child, i) => {
        const d = (i - (n - 1) / 2) * PITCH;
        const off = offsetPolyline(points, d, RADIUS);
        return { child, path: filletPath(off.points, off.radii) };
      })
    : [];

  return (
    <>
      {selected && <path d={main} className="edge-glow" stroke={color} strokeWidth={split ? n * PITCH + 8 : 8} />}
      {split && open && (
        <path d={main} fill="none" stroke={color} strokeOpacity={0.13} strokeWidth={n * PITCH + 10} strokeLinecap="round" strokeLinejoin="round" />
      )}
      {split ? (
        lines.map(({ child, path }) => (
          <path key={child.id} d={path} fill="none" stroke={color} strokeWidth={1.4} opacity={opacity} strokeLinecap="round" />
        ))
      ) : (
        <BaseEdge
          id={id}
          path={main}
          style={{
            stroke: color,
            strokeWidth: link.passThrough ? 1.4 : expandable ? 3 : 2,
            opacity,
            strokeDasharray: link.passThrough ? "4 4" : undefined,
          }}
        />
      )}
      {/* wide invisible hit area */}
      <path d={main} fill="none" stroke="transparent" strokeWidth={16} className="react-flow__edge-interaction" />

      {!link.passThrough && data.label && (
        <EdgeLabelRenderer>
          <div
            className={`link-label nodrag nopan${selected ? " selected" : ""}`}
            style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)`, borderColor: color, color, opacity: faded ? 0.25 : 1 }}
          >
            <span>{link.name.toUpperCase()}</span>
            {expandable && !open && <span className="link-count">×{n}</span>}
            {expandable && (
              <button
                className="link-toggle"
                style={{ borderColor: color, color }}
                title={open ? "Close link" : "Open link"}
                onClick={(e) => {
                  e.stopPropagation();
                  data.onToggle(link.id);
                }}
              >
                <Icon name={open ? "chevrons-down-up" : "chevrons-up-down"} size={10} />
              </button>
            )}
            {open && (
              <div className="child-links">
                {link.children.map((c) => (
                  <div key={c.id} className="child-link">
                    <span className="child-name">{c.label}</span>
                    <span className="child-pins">
                      {c.aPin ?? c.a} → {c.bPin ?? c.b}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const edgeTypes = { link: LinkEdge };
