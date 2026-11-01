/**
 * The 3D view's toolbar (split out of CadView.tsx, PB-1178): every control
 * reads the view state it shows and writes it back through the handlers
 * CadView passes, so a toggle made here, in the URL, by a host or by an
 * agent through the bridge shows the same way.
 */
import type { ReactNode } from "react";
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
import { MAX_SECTIONS, flipped, nextPlane, type ScopedSectionPlane } from "./sections/planes";

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
  /**
   * Several planes (PB-1186): when given, the section menu lists every plane (axis, kept side, a slider to drag it,
   * remove), adds planes (up to three) and sets the scope; `section`/`onSection` are then unused.
   */
  sections?: ScopedSectionPlane[];
  onSections?: (sections: ScopedSectionPlane[]) => void;
  /** The selected part, offered as the scope of the cut ("Cut only <label>"); null: none selected. */
  scopeCandidate?: { path: string; label: string } | null;
  /** Bodies that hold another (what x-ray sees through); none: the control is disabled and says so. */
  shells: number;
  xray: boolean;
  onXray: (on: boolean) => void;
  findings: number;
  showFindings: boolean;
  onFindings: (on: boolean) => void;
  /** The marker-first Findings control (PB-1184, ./annot/FindingsControl.tsx); replaces the plain toggle when given. */
  findingsControl?: ReactNode;
  /** Controls other workstreams mount (W3-C's style toggle, W3-D's measure and tour), after the findings. */
  extra?: ReactNode;
  /**
   * "Take over" (W4-D, PB-1196 D9): shown while an agent holds a lease or the camera; ends every agent lease and
   * gives the camera back to the person (Esc does the same).
   */
  takeOver?: { agents: number; onTakeOver: () => void };
  /**
   * "Save callouts" (W4-D, collaboration D10): writes the callouts, marks and arrows to the project's display file
   * (`saveAnnotations: true`); agents' callouts stay live and per user until the person saves them.
   */
  saveCallouts?: { count: number; onSave: () => void };
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
            pressed={p.onSections ? Boolean(p.sections?.length) : Boolean(section)}
            onClick={() =>
              p.onSections ? p.onSections(p.sections?.length ? [] : [{ axis: 1, at: 0.5 }]) : p.onSection(section ? null : { axis: 1, at: 0.5 })
            }
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
          {p.sectionMenu && p.onSections && <SectionPlanes {...p} />}
          {p.sectionMenu && !p.onSections && (
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
        {p.findingsControl ?? (p.findings > 0 && (
          <IconButton
            icon="triangle-alert"
            label={`Findings on the model · ${p.findings}`}
            tooltipSide="top"
            pressed={p.showFindings}
            badge={p.findings}
            onClick={() => p.onFindings(!p.showFindings)}
          />
        ))}
        {p.extra}
        {p.saveCallouts && p.saveCallouts.count > 0 && (
          <IconButton
            icon="save"
            label={`Save callouts to the display file · ${p.saveCallouts.count}`}
            tooltipSide="top"
            onClick={p.saveCallouts.onSave}
          />
        )}
        {p.takeOver && p.takeOver.agents > 0 && (
          <IconButton
            icon="hand"
            label={`Take over: end ${p.takeOver.agents === 1 ? "the agent's lease" : `${p.takeOver.agents} agents' leases`} and take the camera back (Esc)`}
            tooltipSide="top"
            badge={p.takeOver.agents}
            onClick={p.takeOver.onTakeOver}
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

const AXES = ["X", "Y", "Z"] as const;

/** The section menu with several planes (PB-1186): one row per plane, add, and the scope. */
function SectionPlanes(p: CadToolbarProps) {
  const list = p.sections ?? [];
  const set = (next: ScopedSectionPlane[]) => p.onSections?.(next);
  const at = (i: number, change: Partial<ScopedSectionPlane>) => set(list.map((s, j) => (j === i ? { ...s, ...change } : s)));
  const scope = list[0]?.scope;
  const add = nextPlane(list);
  return (
    <div className="cad-menu cad-section cad-sections">
      <div className="cad-menu-label">Section planes</div>
      {list.length === 0 && <div className="cad-section-empty">No plane: add one to cut the model.</div>}
      {list.map((s, i) => (
        <div key={i} className="cad-section-row" data-plane={i}>
          <div className="segmented">
            {AXES.map((a, k) => (
              <button key={a} className={s.axis === k ? "on" : ""} onClick={() => at(i, { axis: k as 0 | 1 | 2 })}>
                {a}
              </button>
            ))}
            <button
              className={s.flip !== undefined ? "on" : ""}
              onClick={() => set(list.map((x, j) => (j === i ? flipped(x, p.autoFlip(x.axis)) : x)))}
              aria-label="Keep the other side"
              data-tooltip="Keep the other side"
            >
              <Icon name="arrow-up-down" size={13} />
            </button>
            <button onClick={() => set(list.filter((_, j) => j !== i))} aria-label="Remove this plane" data-tooltip="Remove this plane">
              <Icon name="x" size={13} />
            </button>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.005}
            aria-label={`Plane ${i + 1} position along ${AXES[s.axis]}`}
            value={s.at}
            onChange={(e) => at(i, { at: Number(e.target.value) })}
          />
        </div>
      ))}
      <div className="cad-section-foot">
        <button className="cad-menu-item" disabled={!add} onClick={() => add && set([...list, scope ? { ...add, scope } : add])}>
          <Icon name="plus" size={12} />
          {add ? "Add plane" : `At most ${MAX_SECTIONS} planes`}
        </button>
        {list.length > 0 && (
          <div className="segmented cad-section-scope" role="group" aria-label="What the planes cut">
            <button className={!scope ? "on" : ""} onClick={() => set(list.map(({ scope: _s, ...x }) => x))}>
              Whole model
            </button>
            {(p.scopeCandidate || scope) && (
              <button
                className={scope ? "on" : ""}
                onClick={() => {
                  const path = scope ?? p.scopeCandidate?.path;
                  if (path) set(list.map((x) => ({ ...x, scope: path })));
                }}
                data-tooltip={scope ? `Cutting only ${scope}` : `Cut only ${p.scopeCandidate?.label}`}
              >
                {scope ? `Only ${scope.split("/").pop()}` : `Only ${p.scopeCandidate?.label}`}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
