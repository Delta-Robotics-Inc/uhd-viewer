/**
 * The 3D view's toolbar (split out of CadView.tsx, PB-1178): every control
 * reads the view state it shows and writes it back through the handlers
 * CadView passes, so a toggle made here, in the URL, by a host or by an
 * agent through the bridge shows the same way.
 */
import { Icon } from "../canvas/Icon";
import {
  IconButton,
  ToggleGroup,
  Toolbar,
  ToolbarSeparator,
} from "../ui/Toolbar";
import { DIRECTIONS, type Direction } from "./model";
import type { LabelKind } from "./labels";
import type { SectionPlane } from "./state";

export interface CadToolbarProps {
  exploded: boolean;
  onExploded: (on: boolean) => void;
  labels: boolean;
  onLabels: (on: boolean) => void;
  labelKinds: Set<LabelKind>;
  onLabelKind: (kind: LabelKind) => void;
  labelMenu: boolean;
  onLabelMenu: (open: boolean) => void;
  /** Mounting hardware and routed harnesses in the model (their toggles show only when there are some). */
  hardwareCount: number;
  hardware: boolean;
  onHardware: (on: boolean) => void;
  harnessCount: number;
  wires: boolean;
  onWires: (on: boolean) => void;
  frames: boolean;
  onFrames: (on: boolean) => void;
  section: SectionPlane | null;
  onSection: (section: SectionPlane | null) => void;
  sectionMenu: boolean;
  onSectionMenu: (open: boolean) => void;
  /** Which side the plane keeps when no side is set: the side away from the camera along `axis`. */
  autoFlip: (axis: 0 | 1 | 2) => boolean;
  /** Bodies that hold another (what x-ray sees through); none: the control is disabled and says so. */
  shells: number;
  xray: boolean;
  onXray: (on: boolean) => void;
  findings: number;
  showFindings: boolean;
  onFindings: (on: boolean) => void;
  direction: Direction;
  onDirection: (d: Direction) => void;
  onFit: () => void;
  onFocus: () => void;
  canFocus: boolean;
}

const LABEL_KINDS: [LabelKind, string][] = [
  ["module", "Modules"],
  ["harness", "Harnesses & hardware"],
  ["interface", "Interfaces (mates)"],
];

export function CadToolbar(p: CadToolbarProps) {
  const { section } = p;
  return (
    // `data-chrome` marks what document mode (`?chrome=none`, W2-D's captures) leaves out; `display: contents` keeps the layout
    <div data-chrome="toolbar" style={{ display: "contents" }}>
      <Toolbar label="3D tools" className="cad-toolbar">
        <ToggleGroup
          label="Assembly"
          tooltipSide="top"
          options={[
            { id: "assembled", icon: "box", label: "Assembled" },
            { id: "exploded", icon: "layers", label: "Exploded" },
          ]}
          value={p.exploded ? "exploded" : "assembled"}
          onChange={(v) => p.onExploded(v === "exploded")}
        />
        <ToolbarSeparator />
        <div className="cad-menu-wrap">
          <IconButton
            icon="tag"
            label="Callout labels"
            tooltipSide="top"
            pressed={p.labels}
            onClick={() => p.onLabels(!p.labels)}
          />
          <IconButton
            icon="chevron-up"
            size="sm"
            className="w-5"
            label="Label types"
            tooltipSide="top"
            aria-expanded={p.labelMenu}
            onClick={() => p.onLabelMenu(!p.labelMenu)}
          />
          {p.labelMenu && (
            <div className="cad-menu">
              <div className="cad-menu-label">Show labels for</div>
              {LABEL_KINDS.map(([k, label]) => (
                <button
                  key={k}
                  className="cad-menu-item"
                  onClick={() => p.onLabelKind(k)}
                >
                  <span
                    className={`cad-check${p.labelKinds.has(k) ? " on" : ""}`}
                  >
                    {p.labelKinds.has(k) && <Icon name="check" size={12} />}
                  </span>
                  <span className={`cad-kind-dot kind-${k}`} />
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
        {p.hardwareCount > 0 && (
          <IconButton
            icon="wrench"
            label="Mounting hardware"
            tooltipSide="top"
            pressed={p.hardware}
            onClick={() => p.onHardware(!p.hardware)}
          />
        )}
        {p.harnessCount > 0 && (
          <IconButton
            icon="cable"
            label="Routed wire harnesses"
            tooltipSide="top"
            pressed={p.wires}
            onClick={() => p.onWires(!p.wires)}
          />
        )}
        <IconButton
          icon="move-3d"
          label="Every interface frame"
          tooltipSide="top"
          pressed={p.frames}
          onClick={() => p.onFrames(!p.frames)}
        />
        <ToolbarSeparator />
        <div className="cad-menu-wrap">
          <IconButton
            icon="scissors"
            label="Section"
            tooltipSide="top"
            pressed={Boolean(section)}
            onClick={() => p.onSection(section ? null : { axis: 1, at: 0.5 })}
          />
          <IconButton
            icon="chevron-up"
            size="sm"
            className="w-5"
            label="Section plane"
            tooltipSide="top"
            aria-expanded={p.sectionMenu}
            onClick={() => p.onSectionMenu(!p.sectionMenu)}
          />
          {p.sectionMenu && (
            <div className="cad-menu cad-section">
              <div className="cad-menu-label">Section plane</div>
              <div className="segmented">
                {(["X", "Y", "Z"] as const).map((a, i) => (
                  <button
                    key={a}
                    className={section?.axis === i ? "on" : ""}
                    onClick={() =>
                      p.onSection({
                        at: section?.at ?? 0.5,
                        axis: i as 0 | 1 | 2,
                      })
                    }
                  >
                    {a}
                  </button>
                ))}
                <button
                  className={section?.flip !== undefined ? "on" : ""}
                  onClick={() => {
                    const axis = section?.axis ?? 1;
                    p.onSection({
                      axis,
                      at: section?.at ?? 0.5,
                      flip: !(section?.flip ?? p.autoFlip(axis)),
                    });
                  }}
                  aria-label="Keep the other side"
                  data-tooltip="Keep the other side"
                >
                  <Icon name="arrow-up-down" size={13} />
                </button>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={section?.at ?? 0.5}
                onChange={(e) =>
                  p.onSection({
                    ...(section ?? { axis: 1 }),
                    at: Number(e.target.value),
                  })
                }
              />
            </div>
          )}
        </div>
        <IconButton
          icon="scan-eye"
          label={p.shells ? "X-ray" : "X-ray: nothing to see through"}
          tooltipSide="top"
          pressed={p.xray && p.shells > 0}
          aria-disabled={!p.shells || undefined}
          className={
            p.shells
              ? undefined
              : "cursor-default opacity-40 hover:bg-transparent"
          }
          onClick={() => p.shells && p.onXray(!p.xray)}
        />
        {p.findings > 0 && (
          <IconButton
            icon="triangle-alert"
            label={`Findings on the model · ${p.findings}`}
            tooltipSide="top"
            pressed={p.showFindings}
            badge={p.findings}
            onClick={() => p.onFindings(!p.showFindings)}
          />
        )}
        <ToolbarSeparator />
        <ToggleGroup
          label="Interface direction"
          tooltipSide="top"
          options={DIRECTIONS.map((d) => ({
            id: d.id,
            icon: d.icon,
            label: `Interface geometry by ${d.label.toLowerCase().replace(/^d/, "D")}: ${d.hint}`,
          }))}
          value={p.direction}
          onChange={p.onDirection}
        />
        <ToolbarSeparator />
        <IconButton
          icon="maximize"
          label="Fit"
          tooltipSide="top"
          onClick={p.onFit}
        />
        <IconButton
          icon="crosshair"
          label="Look along normal"
          tooltipSide="top"
          disabled={!p.canFocus}
          onClick={p.onFocus}
        />
      </Toolbar>
    </div>
  );
}
