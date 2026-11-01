/**
 * The Findings control (PB-1184, round-2 note §D.3): the toolbar button
 * toggles the marker layer and shows the worst severity's shape (not always
 * red); its popover has severity chips with counts (each a filter), the
 * findings grouped by severity (a finding with no 3D anchor is listed with
 * "no location", never pinned elsewhere), and the actions: look at, isolate
 * the parts a finding names, open all labels (capped), ghost markers.
 */
import { useEffect, useRef } from "react";
import { IconButton } from "../../ui/Toolbar";
import { MAX_OPEN_FINDINGS, severityCounts } from "./drc";
import { SEVERITY_ORDER, worst, type FindingAnchors, type FindingSeverity } from "./findings-anchors";
import { SEVERITY_LABEL, markerSvg } from "./style";

export interface FindingsControlProps {
  findings: FindingAnchors[];
  markers: boolean;
  onMarkers: (on: boolean) => void;
  shown: Set<FindingSeverity>;
  onShown: (s: FindingSeverity, on: boolean) => void;
  ghosts: boolean;
  onGhosts: (on: boolean) => void;
  open: Set<string>;
  current?: string;
  /** A finding chosen in the list: look at it and pin its card. */
  onChoose: (f: FindingAnchors) => void;
  onIsolate: (f: FindingAnchors | null) => void;
  isolated?: string;
  onOpenAll: (on: boolean) => void;
  menu: boolean;
  onMenu: (open: boolean) => void;
}

function Shape({ s, size = 14 }: { s: FindingSeverity; size?: number }) {
  // static markup from ./style.ts (no record text inside)
  return <span style={{ display: "inline-flex" }} dangerouslySetInnerHTML={{ __html: markerSvg(s, size) }} />;
}

export function FindingsControl(p: FindingsControlProps) {
  const counts = severityCounts(p.findings);
  const worstSev = worst(p.findings.map((f) => f.severity));
  const total = p.findings.length;
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!p.menu) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && p.onMenu(false);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [p.menu]);
  if (!total) return null;
  const allOpen = p.findings.filter((f) => f.anchors.length && p.shown.has(f.severity)).every((f) => p.open.has(f.id));
  return (
    <div className="cad-menu-wrap">
      <IconButton
        icon={worstSev ? <Shape s={worstSev} size={15} /> : "triangle-alert"}
        label={`Findings on the model · ${total}${worstSev ? ` · worst ${SEVERITY_LABEL[worstSev].toLowerCase()}` : ""}`}
        tooltipSide="top"
        pressed={p.markers}
        onClick={() => p.onMarkers(!p.markers)}
      />
      <IconButton icon="chevron-up" size="sm" className="w-5" label="Findings list and filters" tooltipSide="top" aria-expanded={p.menu} onClick={() => p.onMenu(!p.menu)} />
      {p.menu && (
        <div className="cad-menu annot-findings" ref={listRef} role="dialog" aria-label="Findings on the model">
          <div className="cad-menu-label">
            Findings on the model · {total}
          </div>
          <div className="annot-chips" role="group" aria-label="Show severities">
            {SEVERITY_ORDER.filter((s) => counts[s] > 0 || s === "fail" || s === "warn").map((s) => (
              <button key={s} type="button" className="annot-chip-btn" aria-pressed={p.shown.has(s)} onClick={() => p.onShown(s, !p.shown.has(s))} title={`${SEVERITY_LABEL[s]}: show or hide`}>
                <Shape s={s} size={12} />
                {SEVERITY_LABEL[s]} {counts[s]}
              </button>
            ))}
          </div>
          {SEVERITY_ORDER.filter((s) => counts[s] > 0).map((s) => (
            <div key={s}>
              <div className="annot-group">{SEVERITY_LABEL[s]}</div>
              {p.findings
                .filter((f) => f.severity === s)
                .map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    className="annot-row"
                    aria-current={p.current === f.id || undefined}
                    onClick={() => p.onChoose(f)}
                    title={f.anchors.length ? "Look at it and pin its card" : (f.reason ?? "No location on the model")}
                  >
                    <Shape s={f.severity} size={13} />
                    <span>
                      <span className="annot-row-code">{f.code.replace(/_/g, " ")}</span>
                      {!f.anchors.length && <span className="annot-noloc">no location</span>}
                      <div className="annot-row-msg">{f.message}</div>
                    </span>
                  </button>
                ))}
            </div>
          ))}
          <div className="annot-actions">
            {p.current && p.findings.find((f) => f.id === p.current)?.anchors.length ? (
              <button type="button" className="annot-chip-btn" aria-pressed={p.isolated === p.current} onClick={() => p.onIsolate(p.isolated === p.current ? null : p.findings.find((f) => f.id === p.current)!)}>
                {p.isolated === p.current ? "Show everything" : "Isolate its parts"}
              </button>
            ) : null}
            {p.isolated && p.isolated !== p.current && (
              <button type="button" className="annot-chip-btn" aria-pressed={false} onClick={() => p.onIsolate(null)}>
                Show everything
              </button>
            )}
            <button type="button" className="annot-chip-btn" aria-pressed={allOpen} onClick={() => p.onOpenAll(!allOpen)} title={`Open every card (at most ${MAX_OPEN_FINDINGS}; the rest stay markers)`}>
              {allOpen ? "Close all labels" : `Open all labels · max ${MAX_OPEN_FINDINGS}`}
            </button>
            <button type="button" className="annot-chip-btn" aria-pressed={p.ghosts} onClick={() => p.onGhosts(!p.ghosts)}>
              Ghost markers behind parts
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
