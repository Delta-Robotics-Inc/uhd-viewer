import { Handle, Position } from "@xyflow/react";
import type { PlacedPort } from "../layout/layout";

const POSITION = { left: Position.Left, right: Position.Right, top: Position.Top, bottom: Position.Bottom };

export interface PortProps {
  placed: PlacedPort;
  /** Position relative to the node's top-left corner. */
  x: number;
  y: number;
  color: string;
  faded: boolean;
  exported?: boolean;
  label?: boolean;
  ground?: boolean;
  selected?: boolean;
  /** Max label width in px (from port spacing and card size). */
  labelWidth?: number;
}

/** Offsets for the port label, placed inside the node next to the port. */
function labelStyle(side: PortProps["placed"]["side"], x: number, y: number, w: number): React.CSSProperties {
  switch (side) {
    case "left":
      return { left: x + 9, top: y - 7, maxWidth: w };
    case "right":
      return { right: `calc(100% - ${x - 9}px)`, top: y - 7, textAlign: "right", maxWidth: w };
    case "top":
      return { left: x - w / 2, top: y + 7, width: w, maxWidth: w, textAlign: "center" };
    case "bottom":
      return { left: x - w / 2, top: y - 19, width: w, maxWidth: w, textAlign: "center" };
  }
}

/** Ground symbol drawn just outside a port whose ground link is not routed. */
function GroundGlyph({ side, x, y, color }: { side: PortProps["placed"]["side"]; x: number; y: number; color: string }) {
  const rot = { bottom: 0, top: 180, left: 90, right: -90 }[side];
  return (
    <svg className="ground-glyph" style={{ left: x - 9, top: y - 1 }} width={18} height={20} viewBox="0 0 18 20">
      <g transform={`rotate(${rot} 9 1)`} stroke={color} strokeWidth={1.6} strokeLinecap="round">
        <line x1={9} y1={1} x2={9} y2={8} />
        <line x1={2} y1={8} x2={16} y2={8} />
        <line x1={5} y1={12} x2={13} y2={12} />
        <line x1={7.5} y1={16} x2={10.5} y2={16} />
      </g>
    </svg>
  );
}

export function Port({ placed, x, y, color, faded, exported, label, ground, selected, labelWidth = 76 }: PortProps) {
  const mechanical = placed.port.domain === "mechanical";
  const size = exported ? 12 : 10;
  const style: React.CSSProperties = {
    left: x,
    top: y,
    width: size,
    height: size,
    opacity: faded ? 0.25 : 1,
    background: exported ? "var(--canvas-bg)" : color,
    borderColor: exported ? color : "var(--canvas-bg)",
    borderRadius: mechanical ? 2 : "50%",
  };
  const id = `p:${placed.port.id}`;
  return (
    <>
      <Handle
        type="source"
        id={id}
        position={POSITION[placed.side]}
        className={`port${exported ? " port-exported" : ""}${selected ? " port-selected" : ""}`}
        style={style}
        isConnectable={false}
      >
        {exported && <span className="port-core" style={{ background: color, borderRadius: mechanical ? 1 : "50%" }} />}
      </Handle>
      <Handle type="target" id={id} position={POSITION[placed.side]} className="port-target" style={{ left: x, top: y }} isConnectable={false} />
      {ground && <GroundGlyph side={placed.side} x={x} y={y} color={color} />}
      {label && (
        <span className="port-label" style={{ ...labelStyle(placed.side, x, y, labelWidth), opacity: faded ? 0.3 : 1 }}>
          {placed.port.name.replace(/\s*\(.*?\)/g, "").replace(/\s+[—–-]\s+.*$/, "")}
        </span>
      )}
    </>
  );
}
