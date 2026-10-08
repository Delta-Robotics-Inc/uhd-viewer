/**
 * The standalone app's chrome (`uhd-viewer serve`, the dev server): a
 * floating header with the breadcrumb, the view and the scenario, and the activity
 * rail. Icons with tooltips throughout. Hosts that build their own shell use
 * the library's views instead and never load this.
 */
import { memo } from "react";
import type { ViewModel } from "../model/types";
import type { Panel } from "../chrome/Chrome";
import { Icon } from "../canvas/Icon";
import { IconButton, ToggleGroup } from "../ui/Toolbar";

export const VIEW_OPTIONS = [
  { id: "diagram", icon: "workflow", label: "Diagram" },
  { id: "3d", icon: "box", label: "3D assembly" },
] as const;

/** The level's breadcrumb (D9): the root, then each drilled module. */
export function Breadcrumb({ vm, onNavigate }: { vm: ViewModel; onNavigate: (depth: number) => void }) {
  return (
    <nav className="breadcrumb" aria-label="Level">
      {vm.path.map((p, i) => (
        <span key={p.id || "root"} className="crumb-wrap">
          {i > 0 && <Icon name="chevron-right" size={12} className="crumb-sep" />}
          <button className={`crumb${i === vm.path.length - 1 ? " current" : ""}`} onClick={() => onNavigate(i)}>
            {p.label.toUpperCase()}
          </button>
        </span>
      ))}
    </nav>
  );
}

/** The scenario picker: the nominal build or a fault scenario. */
export function ScenarioSelect({ scenarios, scenario, onScenario }: { scenarios: { id: string; label: string }[]; scenario: string; onScenario: (id: string) => void }) {
  if (scenarios.length < 2) return null;
  return (
    <label className="scenario" data-tooltip="Scenario">
      <Icon name="flask-conical" size={12} />
      <select value={scenario} onChange={(e) => onScenario(e.target.value)} aria-label="Scenario">
        {scenarios.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function HeaderView(props: {
  vm: ViewModel;
  onNavigate: (depth: number) => void;
  scenarios: { id: string; label: string }[];
  scenario: string;
  onScenario: (id: string) => void;
  view: "diagram" | "3d";
  onView: (v: "diagram" | "3d") => void;
}) {
  return (
    <header className="header">
      <div className="brand">
        <span className="brand-mark">UHD</span>
        <span className="brand-name">VIEWER</span>
      </div>
      <span className="sep" />
      <Breadcrumb vm={props.vm} onNavigate={props.onNavigate} />
      <div className="header-controls">
        <ToggleGroup label="View" options={VIEW_OPTIONS} value={props.view} onChange={props.onView} />
        <ScenarioSelect scenarios={props.scenarios} scenario={props.scenario} onScenario={props.onScenario} />
      </div>
    </header>
  );
}

function ActivityBarView({ panel, onPanel, errors }: { panel: Panel | null; onPanel: (p: Panel | null) => void; errors: number }) {
  const items: { id: Panel; icon: string; label: string }[] = [
    { id: "hierarchy", icon: "list-tree", label: "Hierarchy" },
    { id: "checks", icon: "shield-check", label: "System checks" },
  ];
  return (
    <aside className="activity-bar">
      {items.map((it) => (
        <IconButton
          key={it.id}
          icon={it.icon}
          label={it.label}
          tooltipSide="right"
          pressed={panel === it.id}
          badge={it.id === "checks" && errors > 0 ? errors : undefined}
          onClick={() => onPanel(panel === it.id ? null : it.id)}
        />
      ))}
    </aside>
  );
}

/** Memoised: re-renders only when its props change, not on every frame of a canvas drag. */
export const Header = memo(HeaderView);
export const ActivityBar = memo(ActivityBarView);
