/**
 * The 3D view's toolbar (split out of CadView.tsx, PB-1178): every control
 * reads the view state it shows and writes it back through the handlers
 * CadView passes, so a toggle made here, in the URL, by a host or by an
 * agent through the bridge shows the same way.
 *
 * R1-D (2026-11-01, Kevin's walkthrough G4/G5): no control changes nothing silently. Each one acts, or is shown
 * disabled with a tooltip that says why (no interface frames, no geometry of a kind, no findings). The menus open
 * above the bar; the bar scrolls sideways on a narrow view (`overflow-x: auto` in app.css), which also clipped every
 * menu above it to nothing (the chevrons "did nothing"), so while a menu is open the bar lets its content overflow
 * (`useMenusVisible`).
 *
 * R2-B (2026-11-02, Kevin's walkthrough G5 and H2):
 * - "Section view" asks which plane: the three origin planes of the model's frame (XY, YZ, ZX) or "Pick a face"
 *   (the face under the pointer is highlighted, a press takes its plane; ./sections/gizmo.ts), an offset in mm (a
 *   number, a slider, and an arrow in the view to drag), "Keep the other side"; the plane shows as an outlined
 *   rectangle while the popover is open. The popover stays open while the person turns the view (a press on the
 *   canvas does not close it); Escape ends a face pick first, then closes it.
 * - Explode and Assemble are two controls: Explode (all parts at once, outward along their mounting faces' normals;
 *   a burst glyph) on or off, and Assemble (step by step: the assembly sequence player Kevin liked, unchanged) as the
 *   "assembled" toggle, on when the model is together.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import * as THREE from "three";
import { Icon } from "../canvas/Icon";
import {
  IconButton,
  Toolbar,
  ToolbarSeparator,
} from "../ui/Toolbar";
import { DIRECTIONS, interfaceRows, type CadModel, type Direction } from "./model";
import type { LabelKind } from "./labels";
import { viewHub, type SectionPlane } from "./state";
import { MAX_SECTIONS, ORIGIN_PLANES, autoFlipOf, flipped, isPlaced, nextPlane, offsetOf, offsetRange, originPlane, withOffset, type ScopedSectionPlane } from "./sections/planes";
import { SectionTool, type FaceHit, type ToolScene } from "./sections/gizmo";
import { AssembleGlyph, ExplodeGlyph } from "./viewIcons";
import type { ExplodeMode } from "./sequence/player";

export interface CadToolbarProps {
  exploded: boolean;
  onExploded: (on: boolean) => void;
  /**
   * R2-B: how the parts come apart now, `radial` (Explode) or `sequence` (Assemble's steps): the view state's
   * `explode.mode` once the schema has it. Absent: the mode this bar last chose (DEFAULT radial).
   */
  explodeMode?: ExplodeMode;
  /** R2-B: Explode (all at once) on or off. Absent: the bar sets the player's mode (the page's view hub) and calls `onExploded`. */
  onExplode?: (on: boolean) => void;
  /** R2-B: Assemble (step by step): true brings the parts together through the steps, false takes them apart through them. */
  onAssemble?: (assembled: boolean) => void;
  /**
   * R3-B (the assembly timeline, Kevin 2026-11-02: "pop up underneath the toolbar … when the exploded view or the
   * assembly view is selected"): true when Explode is turned on or Assemble is clicked (either way), false when
   * Explode is turned off. CadView keeps it and passes it to `TimelinePanel` (`requested`). Absent: nothing asks.
   */
  onTimeline?: (on: boolean) => void;
  /**
   * R2-B: the 3D view's scene (CadView's `handle` ref): the section popover's face pick, plane outline and drag
   * handle draw in it. Absent: the popover offers the origin planes and the offset only.
   */
  sceneRef?: { current: ToolScene | null };
  /** R2-B: the assembled bounds (mm) planes are placed in (CadView's `assembledBounds`). Absent: the scene root's bounds. */
  bounds?: () => THREE.Box3;
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
  /**
   * What the model has for the frame and interface-geometry controls (`toolbarAvailability(model)`): a control with
   * nothing to show is disabled and says why. Absent: unknown, every control enabled (as before R1-D).
   */
  availability?: ToolbarAvailability;
  onFit: () => void;
  onFocus: () => void;
  canFocus: boolean;
  /**
   * Export (R2-E's G3, built at the R2 integration): a picture of the view (PNG) or a model of the selected part
   * (STEP, STL, GLB), sent to the host, which writes the file (VS Code: the export folder, no dialog). Absent: the
   * viewer has no host that saves files; the button is disabled and says so.
   */
  onExport?: (format: ExportFormat, target?: string) => void;
  /** The part a model export is of (the selection, by path from the root); null: none selected (the model rows say so). */
  exportTarget?: { path: string; label: string } | null;
}

/** What the Export menu offers (R2-E's formats). */
export type ExportFormat = "png" | "step" | "stl" | "glb";
/** The Export button's tooltip, hosted and not (R2 integration DEFAULT wording). */
export const EXPORT_LABEL = "Export a picture or a model";
export const EXPORT_UNHOSTED = "Export: needs a host that saves files (open this view in Protoboard)";
/** The menu's model rows (R2-E's handoff names). */
export const EXPORT_MODELS: [ExportFormat, string][] = [
  ["step", "STEP"],
  ["stl", "STL"],
  ["glb", "GLB"],
];

const LABEL_KINDS: [LabelKind, string][] = [
  ["module", "Modules"],
  ["harness", "Harnesses & hardware"],
  ["interface", "Interfaces (mates)"],
  // R2-A's handoff (2026-11-02): one label per placed board component of each kind (CadView sends them)
  ["refdes", "Reference designators"],
  ["mpn", "Part numbers"],
];

/** What the model offers the toolbar's frame and interface-geometry controls. */
export interface ToolbarAvailability {
  /** Interface frames the "Every interface frame" toggle would draw (on placed bodies). */
  frames: number;
  /** Interfaces with geometry bound in each direction (D1 feature, D2 artifact, D3 procedural). */
  byDirection: Record<Direction, number>;
}

/**
 * Counts what the frame toggle and the D1/D2/D3 choice can show in `model`: the bodies and interfaces CadView's
 * overlay walks (an interface frame on a body drawn here; a binding of each kind on a body's interfaces). A board's
 * components, drawn inside the board's own mesh, are not bodies: their frames are not drawn, so not counted.
 */
export function toolbarAvailability(model: Pick<CadModel, "bodies" | "manifests">): ToolbarAvailability {
  const keys = new Set(model.bodies.map((b) => b.key));
  let frames = 0;
  const byDirection: Record<Direction, number> = { feature: 0, artifact: 0, procedural: 0 };
  const seen = new Set<string>();
  for (const b of model.bodies) {
    for (const i of b.def.interfaces) {
      const f = i.geometry?.frame;
      if (!f) continue;
      // as CadView's frame loop: a frame on an artifact of its own is drawn when that artifact is a drawn body
      const target = f.artifact ? `${b.path.join("/")}#${f.artifact}` : b.key;
      if (f.artifact ? target === b.key || keys.has(target) : !b.key.includes("#")) frames++;
    }
    const rowsKey = `${b.key.split("#")[0]}|${b.def.id}`;
    if (seen.has(rowsKey)) continue;
    seen.add(rowsKey);
    for (const row of interfaceRows(b.def, model.manifests))
      for (const d of DIRECTIONS) if (row.byDirection[d.id].length) byDirection[d.id]++;
  }
  return { frames, byDirection };
}

/** Tooltip of the "Every interface frame" toggle. */
export function framesLabel(a: ToolbarAvailability | undefined): string {
  if (a && a.frames === 0) return "No interface frames in this model";
  return a ? `Every interface frame · ${a.frames}` : "Every interface frame";
}

/** Tooltip of one interface-geometry choice, disabled when the model has no geometry of that kind. */
export function directionOption(d: (typeof DIRECTIONS)[number], a: ToolbarAvailability | undefined): { label: string; disabled: boolean } {
  const name = `Interface geometry by ${d.label.toLowerCase().replace(/^d/, "D")}`;
  const n = a?.byDirection[d.id];
  if (n === 0) return { label: `${name}: none in this model`, disabled: true };
  return { label: `${name}: ${d.hint}. Drawn on the selected interface${n ? ` (${n} in this model)` : ""}`, disabled: false };
}

/**
 * Menus above a bar that scrolls sideways: while one is open (an `aria-expanded="true"` button inside), the bar
 * shows what overflows it, so the menu is seen. Run after every render (the findings menu's state lives in CadView,
 * which renders this bar again when it changes).
 */
function useMenusVisible(wrap: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const bar = wrap.current?.querySelector<HTMLElement>(".cad-toolbar");
    if (!bar) return;
    const open = Boolean(bar.querySelector('[aria-expanded="true"]'));
    bar.style.overflow = open ? "visible" : "";
  });
}

/**
 * Close a menu on Escape or on a press outside `wrap`. `keepOn(target)`: a press there does not close it (the
 * section popover stays open while the person turns the view, R2-B DEFAULT).
 */
function useDismiss(open: boolean, wrap: RefObject<HTMLElement | null>, close: () => void, keepOn?: (target: EventTarget | null) => boolean) {
  const keepRef = useRef(keepOn);
  keepRef.current = keepOn;
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    // gate R1: an Escape that closes a menu is taken (the view's own Escape, take over, skips a handled one)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      closeRef.current();
    };
    const onDown = (e: PointerEvent) => {
      if (keepRef.current?.(e.target)) return;
      if (wrap.current && e.target instanceof Node && !wrap.current.contains(e.target)) closeRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [open, wrap]);
}

const DISABLED = "cursor-default opacity-40 hover:bg-transparent";

/** Tooltips of the two explode controls (R2-B, the brief's words). */
export const EXPLODE_LABEL = "Explode (all parts at once)";
export const ASSEMBLE_LABEL = "Assemble (step by step)";

/** Switch the mounted 3D view's player to a mode through the page's view hub (until CadView passes `onExplode`). */
function hubMode(mode: ExplodeMode): void {
  try {
    viewHub().sequence?.({ action: "mode", mode } as never);
  } catch {
    /* no view mounted: the next explode resolves the player in its DEFAULT mode */
  }
}

export function CadToolbar(p: CadToolbarProps) {
  const { section } = p;
  const wrap = useRef<HTMLDivElement>(null);
  const labelWrap = useRef<HTMLDivElement>(null);
  const sectionWrap = useRef<HTMLDivElement>(null);
  const exportWrap = useRef<HTMLDivElement>(null);
  const [exportMenu, setExportMenu] = useState(false);
  /** Escape while picking a face ends the pick, not the popover (SectionPlanes sets it while a pick runs). */
  const pickEsc = useRef<(() => void) | null>(null);
  useMenusVisible(wrap);
  useDismiss(p.labelMenu, labelWrap, () => p.onLabelMenu(false));
  useDismiss(exportMenu, exportWrap, () => setExportMenu(false));
  useDismiss(
    p.sectionMenu,
    sectionWrap,
    () => (pickEsc.current ? pickEsc.current() : p.onSectionMenu(false)),
    (t) => t instanceof HTMLCanvasElement || (t instanceof HTMLElement && t.classList.contains("cad-section-offset")),
  );
  const noFrames = p.availability?.frames === 0;
  const cutOn = p.onSections ? Boolean(p.sections?.length) : Boolean(section);
  // R2-B: the explode mode this bar last chose, when the view state does not say (DEFAULT radial, the Explode control's)
  const [ownMode, setOwnMode] = useState<ExplodeMode>("radial");
  const mode = p.explodeMode ?? ownMode;
  const explodeOn = p.exploded && mode === "radial";
  const assembled = !p.exploded;
  const explode = (on: boolean) => {
    p.onTimeline?.(on);
    if (p.onExplode) return p.onExplode(on);
    setOwnMode("radial");
    hubMode("radial");
    p.onExploded(on);
  };
  const assemble = (together: boolean) => {
    // R3-B: the assembly view is selected either way (taking it apart or putting it together in order)
    p.onTimeline?.(true);
    if (p.onAssemble) return p.onAssemble(together);
    setOwnMode("sequence");
    hubMode("sequence");
    p.onExploded(!together);
  };
  const boundsNow = () => p.bounds?.() ?? (p.sceneRef?.current ? new THREE.Box3().setFromObject(p.sceneRef.current.root) : new THREE.Box3());
  return (
    // `data-chrome` marks what document mode (`?chrome=none`, W2-D's captures) leaves out; `display: contents` keeps the layout
    <div data-chrome="toolbar" style={{ display: "contents" }} ref={wrap}>
      <Toolbar label="3D tools" className="cad-toolbar">
        {/* R2-B (H2): Explode, every part at once; Assemble, the steps (the "assembled" toggle) */}
        <IconButton
          icon={<ExplodeGlyph size={16} />}
          label={explodeOn ? `${EXPLODE_LABEL}: on` : EXPLODE_LABEL}
          tooltipSide="top"
          pressed={explodeOn}
          data-explode="radial"
          onClick={() => explode(!explodeOn)}
        />
        <IconButton
          icon={<AssembleGlyph size={16} />}
          label={assembled ? `${ASSEMBLE_LABEL}: assembled (click to take it apart in order)` : `${ASSEMBLE_LABEL}: apart (click to put it together in order)`}
          tooltipSide="top"
          pressed={assembled}
          data-explode="sequence"
          onClick={() => assemble(!assembled)}
        />
        <ToolbarSeparator />
        <div className="cad-menu-wrap" ref={labelWrap}>
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
            aria-haspopup="menu"
            onClick={() => {
              if (!p.labelMenu) p.onSectionMenu(false);
              p.onLabelMenu(!p.labelMenu);
            }}
          />
          {p.labelMenu && (
            <div className="cad-menu" role="menu" aria-label="Label types">
              <div className="cad-menu-label">Show labels for</div>
              {LABEL_KINDS.map(([k, label]) => (
                <button
                  key={k}
                  className="cad-menu-item"
                  role="menuitemcheckbox"
                  aria-checked={p.labelKinds.has(k)}
                  onClick={() => {
                    p.onLabelKind(k);
                    // DEFAULT: turning a type on shows the labels (a choice made with labels off would change nothing on screen)
                    if (!p.labels && !p.labelKinds.has(k)) p.onLabels(true);
                  }}
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
              {/* findings are markers of their own layer (annot/): this row is the same switch as the findings button */}
              <button
                className="cad-menu-item"
                role="menuitemcheckbox"
                aria-checked={p.findings > 0 && p.showFindings}
                aria-disabled={!p.findings || undefined}
                data-tooltip={p.findings ? undefined : "No findings in this model"}
                style={p.findings ? undefined : { opacity: 0.5, cursor: "default" }}
                onClick={() => {
                  if (p.findings) p.onFindings(!p.showFindings);
                }}
              >
                <span className={`cad-check${p.findings > 0 && p.showFindings ? " on" : ""}`}>
                  {p.findings > 0 && p.showFindings && <Icon name="check" size={12} />}
                </span>
                <Icon name="triangle-alert" size={12} />
                {p.findings ? `Findings · ${p.findings}` : "Findings (none)"}
              </button>
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
          label={framesLabel(p.availability)}
          tooltipSide="top"
          pressed={p.frames && !noFrames}
          aria-disabled={noFrames || undefined}
          className={noFrames ? DISABLED : undefined}
          onClick={() => {
            if (!noFrames) p.onFrames(!p.frames);
          }}
        />
        <ToolbarSeparator />
        <div className="cad-menu-wrap" ref={sectionWrap}>
          <IconButton
            icon="scissors"
            label={cutOn ? "Section view: on (click to remove the cut)" : "Section view"}
            tooltipSide="top"
            pressed={cutOn}
            onClick={() => {
              if (!p.onSections) return p.onSection(section ? null : { axis: 1, at: 0.5 });
              if (p.sections?.length) {
                p.onSections([]);
                if (p.sectionMenu) p.onSectionMenu(false);
                return;
              }
              // R2-B: on, with the ZX origin plane (DEFAULT, the vertical cut it always made), and the chooser opens
              const box = boundsNow();
              p.onSections([box.isEmpty() ? { axis: 1, at: 0.5 } : originPlane(1, box)]);
              if (!p.sectionMenu) {
                p.onLabelMenu(false);
                p.onSectionMenu(true);
              }
            }}
          />
          <IconButton
            icon="chevron-up"
            size="sm"
            className="w-5"
            label="Section view: plane, offset, side, scope"
            tooltipSide="top"
            aria-expanded={p.sectionMenu}
            aria-haspopup="dialog"
            onClick={() => {
              if (!p.sectionMenu) p.onLabelMenu(false);
              p.onSectionMenu(!p.sectionMenu);
            }}
          />
          {p.sectionMenu && p.onSections && <SectionPlanes {...p} bounds={boundsNow} pickEsc={pickEsc} />}
          {p.sectionMenu && !p.onSections && (
            <div className="cad-menu cad-section" role="dialog" aria-label="Section plane">
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
          className={p.shells ? undefined : DISABLED}
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
        {/* R2-E (G3): Export, a picture of the view or a model of the selected part, written by the host */}
        <div className="cad-menu-wrap" ref={exportWrap}>
          <IconButton
            icon="download"
            label={p.onExport ? EXPORT_LABEL : EXPORT_UNHOSTED}
            tooltipSide="top"
            data-export="menu"
            aria-haspopup="menu"
            aria-expanded={exportMenu}
            aria-disabled={!p.onExport || undefined}
            className={p.onExport ? undefined : DISABLED}
            onClick={() => {
              if (!p.onExport) return;
              if (!exportMenu) {
                p.onLabelMenu(false);
                p.onSectionMenu(false);
              }
              setExportMenu(!exportMenu);
            }}
          />
          {exportMenu && p.onExport && (
            <div className="cad-menu" role="menu" aria-label="Export">
              <div className="cad-menu-label">Export</div>
              <button
                className="cad-menu-item"
                role="menuitem"
                data-export="png"
                onClick={() => {
                  setExportMenu(false);
                  p.onExport?.("png");
                }}
              >
                <Icon name="image" size={13} />
                Picture of the view (PNG)
              </button>
              {EXPORT_MODELS.map(([format, name]) => {
                const t = p.exportTarget;
                return (
                  <button
                    key={format}
                    className={t ? "cad-menu-item" : `cad-menu-item ${DISABLED}`}
                    role="menuitem"
                    data-export={format}
                    aria-disabled={!t || undefined}
                    data-tooltip={t ? undefined : "Select a part first"}
                    data-tooltip-side="right"
                    onClick={() => {
                      if (!t) return;
                      setExportMenu(false);
                      p.onExport?.(format, t.path);
                    }}
                  >
                    <Icon name="box" size={13} />
                    {t ? `Model of ${t.label}: ${name}` : `Model of the selected part: ${name} (select a part)`}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <ToolbarSeparator />
        <div role="radiogroup" aria-label="Interface geometry" className="flex items-center gap-0.5">
          {DIRECTIONS.map((d) => {
            const o = directionOption(d, p.availability);
            return (
              <IconButton
                key={d.id}
                icon={d.icon}
                label={o.label}
                tooltipSide="top"
                role="radio"
                aria-checked={p.direction === d.id}
                pressed={p.direction === d.id && !o.disabled}
                aria-disabled={o.disabled || undefined}
                className={o.disabled ? DISABLED : undefined}
                onClick={() => {
                  if (!o.disabled) p.onDirection(d.id);
                }}
              />
            );
          })}
        </div>
        <ToolbarSeparator />
        <IconButton
          icon="maximize"
          label="Fit"
          tooltipSide="top"
          onClick={p.onFit}
        />
        <IconButton
          icon="crosshair"
          label={p.canFocus ? "Look along normal: face the selected part" : "Look along normal: select a part first"}
          tooltipSide="top"
          disabled={!p.canFocus}
          onClick={p.onFocus}
        />
      </Toolbar>
    </div>
  );
}

const AXES = ["X", "Y", "Z"] as const;

/** The plane chooser's name for a plane (R2-B): an origin plane, a face, or the axis form. */
export function planeName(s: ScopedSectionPlane): string {
  if (s.source === "face") return `Face of ${(s.face?.path ?? "").split("/").pop() || "the part"}${s.face?.planar === false ? " (curved: tangent plane)" : ""}`;
  return ORIGIN_PLANES.find((o) => o.axis === s.axis)?.label ?? `${AXES[s.axis]} plane`;
}

/** The section popover (PB-1186, R2-B): one row per plane (the plane chooser, the offset, the side), add, the scope. */
function SectionPlanes(p: CadToolbarProps & { bounds: () => THREE.Box3; pickEsc: RefObject<(() => void) | null> }) {
  const list = p.sections ?? [];
  const set = (next: ScopedSectionPlane[]) => p.onSections?.(next);
  const scope = list[0]?.scope;
  // the bounds are read once per render of the popover (cheap: CadView's records, or the root's box)
  const box = useMemo(() => p.bounds(), [p, list]); // eslint-disable-line react-hooks/exhaustive-deps
  const add = nextPlane(list, box);
  // the plane the outline, the handle and a face pick act on
  const [active, setActive] = useState(0);
  const act = Math.min(active, Math.max(0, list.length - 1));
  const [picking, setPicking] = useState(false);
  const [hover, setHover] = useState<FaceHit | null>(null);
  const tool = useSectionTool(p, list, act, setPicking, setHover);
  // Escape while picking ends the pick
  useEffect(() => {
    p.pickEsc.current = picking ? () => tool.current?.stopPick() : null;
    return () => {
      p.pickEsc.current = null;
    };
  }, [picking, p.pickEsc, tool]);
  const pick = (i: number) => {
    setActive(i);
    const t = tool.current;
    if (!t) return;
    if (t.isPicking) t.stopPick();
    else t.startPick();
  };
  const canPick = Boolean(p.sceneRef);
  return (
    <div className="cad-menu cad-section cad-sections" role="dialog" aria-label="Section view" style={{ minWidth: 300 }}>
      <div className="cad-menu-label">Section view</div>
      {list.length === 0 && <div className="cad-section-empty">No plane: choose an origin plane or pick a face to cut the model.</div>}
      {list.map((s, i) => {
        const off = offsetOf(s, box);
        const [lo, hi] = offsetRange(s, box);
        const placed = isPlaced(s);
        return (
          <div key={i} className="cad-section-row" data-plane={i} data-active={i === act || undefined} onPointerDown={() => setActive(i)}>
            <div className="segmented" role="group" aria-label={`Plane ${i + 1}`}>
              {ORIGIN_PLANES.map((o) => (
                <button
                  key={o.id}
                  className={s.source !== "face" && s.axis === o.axis ? "on" : ""}
                  onClick={() => set(list.map((x, j) => (j === i ? originPlane(o.axis, box, x.scope ? { scope: x.scope } : undefined) : x)))}
                  aria-label={`${o.label} (${o.hint})`}
                  data-tooltip={`${o.label} (${o.hint})`}
                >
                  {o.id}
                </button>
              ))}
              <button
                className={s.source === "face" || (picking && i === act) ? "on" : ""}
                disabled={!canPick}
                aria-pressed={picking && i === act}
                onClick={() => pick(i)}
                aria-label="Pick a face"
                data-tooltip={canPick ? (picking && i === act ? "Picking: click a highlighted face (Esc cancels)" : "Pick a face: its plane becomes the cut") : "Pick a face: not available in this view"}
              >
                <Icon name="mouse-pointer-click" size={13} />
              </button>
              <button
                className={s.flip !== undefined ? "on" : ""}
                onClick={() => set(list.map((x, j) => (j === i ? flipped(x, autoFlipOf(x, p.autoFlip)) : x)))}
                aria-label="Keep the other side"
                data-tooltip="Keep the other side"
              >
                <Icon name="arrow-up-down" size={13} />
              </button>
              <button onClick={() => set(list.filter((_, j) => j !== i))} aria-label="Remove this plane" data-tooltip="Remove this plane">
                <Icon name="x" size={13} />
              </button>
            </div>
            <div
              className="cad-section-what"
              style={{ fontSize: 11, color: "var(--uhd-text-muted)" }}
              data-source={s.source ?? "axis"}
              title={picking && i === act && hover ? `face ${hover.face} (${hover.source}), ${hover.areaMm2} mm², flat within ${hover.spreadMm} mm` : undefined}
            >
              {picking && i === act ? (hover ? `${hover.planar ? "Flat face" : "Curved face"} of ${hover.path.split("/").pop() || "the part"} · click to cut there` : "Hover a face, click to cut there · Esc cancels") : planeName(s)}
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
              <span style={{ color: "var(--uhd-text-muted)" }}>Offset</span>
              <OffsetField value={off} onCommit={(v) => set(list.map((x, j) => (j === i ? withOffset(x, v, box) : x)))} label={`Plane ${i + 1} offset (mm)`} />
              <span style={{ color: "var(--uhd-text-muted)" }}>mm</span>
            </label>
            <input
              type="range"
              min={lo}
              max={hi}
              step={0.5}
              aria-label={`Plane ${i + 1} offset along ${placed ? "its normal" : AXES[s.axis]} (mm)`}
              value={Math.min(hi, Math.max(lo, off))}
              onChange={(e) => {
                setActive(i);
                set(list.map((x, j) => (j === i ? withOffset(x, Number(e.target.value), box) : x)));
              }}
            />
          </div>
        );
      })}
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

/** A number field for the offset: typed freely, committed when it reads as a number (Enter or each valid keystroke). */
function OffsetField({ value, onCommit, label }: { value: number; onCommit: (v: number) => void; label: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (Math.round(value * 10) / 10).toString();
  return (
    <input
      type="number"
      step={0.5}
      inputMode="decimal"
      aria-label={label}
      value={shown}
      style={{ width: 72, font: "inherit", padding: "2px 4px", background: "var(--uhd-surface-sunken)", color: "var(--uhd-text)", border: "1px solid var(--uhd-border)", borderRadius: 4 }}
      onChange={(e) => {
        setDraft(e.target.value);
        const v = Number(e.target.value);
        if (e.target.value.trim() !== "" && Number.isFinite(v) && Math.abs(v) <= 1e5) onCommit(v);
      }}
      onBlur={() => setDraft(null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

/**
 * The section tool on the 3D view's scene (./sections/gizmo.ts), while the popover is open: the plane's outline and
 * drag handle, and the face pick. It reads the latest planes through a ref, so a drag always writes over the newest.
 */
function useSectionTool(p: CadToolbarProps & { bounds: () => THREE.Box3 }, list: ScopedSectionPlane[], active: number, onPick: (on: boolean) => void, onHover: (f: FaceHit | null) => void) {
  const tool = useRef<SectionTool | null>(null);
  const latest = useRef({ list, active, p });
  latest.current = { list, active, p };
  const scene = p.sceneRef?.current ?? null;
  useEffect(() => {
    if (!scene) return;
    const t = new SectionTool({
      scene,
      planes: () => latest.current.list,
      setPlanes: (next) => latest.current.p.onSections?.(next),
      bounds: () => latest.current.p.bounds(),
      active: () => latest.current.active,
      onPickChange: onPick,
      onHover,
    });
    tool.current = t;
    t.setShown(true);
    return () => {
      t.dispose();
      if (tool.current === t) tool.current = null;
      onPick(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene]);
  // the planes (or which one is active) changed: lay the outline and handle out again
  const key = JSON.stringify(list) + "|" + active;
  useEffect(() => {
    tool.current?.refresh();
  }, [key]);
  return tool;
}
