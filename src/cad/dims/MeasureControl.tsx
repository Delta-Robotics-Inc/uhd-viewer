/**
 * The 3D toolbar's Measure button (R3-C): turns the Measure tool on (click two points: a MESH-tier dimension) and
 * off (also Escape). Mounted in the toolbar's `extra` slot by CadView (handoff to R3-A).
 */
import { IconButton } from "../../ui/Toolbar";

export function MeasureControl({ active, onToggle, disabled }: { active: boolean; onToggle: (on: boolean) => void; disabled?: boolean }) {
  return (
    <IconButton
      icon="ruler"
      label={active ? "Measure: on (click two points; Esc to stop)" : "Measure a distance (click two points)"}
      tooltipSide="top"
      pressed={active}
      data-measure={active ? "on" : "off"}
      disabled={disabled}
      onClick={() => onToggle(!active)}
    />
  );
}
