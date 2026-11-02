/**
 * The 3D view's navigation chrome (R2-A, walkthrough F1, F2, A3, 2026-11-02): the back and forward buttons beside
 * the level's name, the part's context menu, and the hover tooltip. Styled with the app's tokens and radius
 * (`.context-menu` is the diagram menu's look; ./style.ts adds the rest).
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../../canvas/Icon";
import type { ViewHub } from "../state/hub";
import { goBack, hostDrawsHistory, navOf } from "./history";
import { ensureNavStyle } from "./style";
import { longTipRows, shortTip, tipHint, type MenuItem, type PartTip } from "./target";
import { placeTip, type Box2 } from "./tip";

/**
 * Back and forward (R2-A, F1: "there needs to be a back button; forward and backwards"): the viewer's own history,
 * Alt+Left and Alt+Right as keys. Disabled at the ends. `scope` is the level shown now (a place of another level
 * can only be reached where the mount applies drills).
 */
export function NavButtons({ hub, scope }: { hub: ViewHub; scope: string }) {
  ensureNavStyle();
  const nav = navOf(hub);
  // one set of back and forward (R2 integration): a host that draws its own (VS Code's header) gets none here
  const hidden = hostDrawsHistory(hub);
  const read = () => nav.state(scope);
  const [st, setSt] = useState(read);
  useEffect(() => {
    setSt(read());
    return nav.subscribe(() => setSt(read()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav, scope]);
  const label = (i: number) => st.entries[i]?.label;
  if (hidden) return null;
  return (
    <span className="cad-nav" data-chrome="nav" role="group" aria-label="History">
      <button type="button" className="cad-nav-btn" aria-label="Back" data-tooltip={st.canBack ? `Back to ${label(st.index - 1) ?? "the last view"} (Alt+Left)` : "Back (Alt+Left)"} data-tooltip-side="bottom" disabled={!st.canBack} onClick={() => goBack(hub, -1)}>
        <Icon name="arrow-left" size={14} strokeWidth={1.75} />
      </button>
      <button type="button" className="cad-nav-btn" aria-label="Forward" data-tooltip={st.canForward ? `Forward to ${label(st.index + 1) ?? "the next view"} (Alt+Right)` : "Forward (Alt+Right)"} data-tooltip-side="bottom" disabled={!st.canForward} onClick={() => goBack(hub, 1)}>
        <Icon name="arrow-right" size={14} strokeWidth={1.75} />
      </button>
    </span>
  );
}

/**
 * A part's context menu at the pointer (R2-A, F2): the part's short name as its title, then the items; disabled
 * items say why. Escape, a press outside, or the window losing focus closes it; arrow keys move between items.
 * `x`, `y` are client coordinates.
 */
export function PartMenu({ x, y, title, items, onRun, onClose, kind = "part" }: { x: number; y: number; title?: string; items: MenuItem[]; onRun: (id: MenuItem["id"]) => void; onClose: () => void; kind?: "part" | "void" }) {
  ensureNavStyle();
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // kept inside the window
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = typeof window === "undefined" ? 1e5 : window.innerWidth;
    const vh = typeof window === "undefined" ? 1e5 : window.innerHeight;
    setAt({ left: Math.max(4, Math.min(x, vw - w - 4)), top: Math.max(4, Math.min(y, vh - h - 4)) });
    el.querySelector<HTMLButtonElement>("button:not([aria-disabled='true'])")?.focus({ preventScroll: true });
  }, [x, y]);
  useEffect(() => {
    const away = (e: Event) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // the menu's Escape is its own: not a take-over, not an isolation cleared (as the toolbar's menus, gate R1)
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const list = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
      const i = list.indexOf(document.activeElement as HTMLButtonElement);
      const next = list[(i + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length];
      next?.focus();
      e.preventDefault();
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", onClose);
    // capture (wave R4 gate): the zoom policy stops the canvas's wheel on its holder, so a bubbling listener missed it
    window.addEventListener("wheel", onClose, { capture: true, passive: true });
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("wheel", onClose, { capture: true });
    };
  }, [onClose]);
  return (
    <div ref={ref} className="context-menu cad-part-menu" data-chrome={kind === "void" ? "void-menu" : "part-menu"} data-menu={kind} style={{ left: at.left, top: at.top }} role="menu" aria-label={kind === "void" ? "View actions" : title ? `${title} actions` : "Part actions"} onContextMenu={(e) => e.preventDefault()}>
      {title && <div className="cad-part-menu-title">{title}</div>}
      {items.map((it, i) => (
        <span key={it.id} style={{ display: "contents" }}>
          {(it.rule ?? (kind === "part" && (it.id === "frame" || it.id === "copy"))) && i > 0 && <div role="separator" className="context-menu-rule" />}
          <button
            type="button"
            role={it.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
            data-item={it.id}
            aria-checked={it.checked !== undefined ? it.checked : undefined}
            aria-disabled={it.disabled ? "true" : undefined}
            title={it.disabled}
            onClick={() => {
              if (it.disabled) return;
              onClose();
              onRun(it.id);
            }}
          >
            <span className="context-menu-icon" aria-hidden>
              <Icon name={it.icon} size={14} strokeWidth={1.75} />
            </span>
            <span className="context-menu-label">{it.label}</span>
            {it.hint && <kbd className="context-menu-key">{it.hint}</kbd>}
          </button>
        </span>
      ))}
    </div>
  );
}

/**
 * The hover tooltip (R2-A, A3): short (refdes and name) after 80 ms, long (MPN, package, findings, what a click
 * does) after 900 ms. Placed beside the part's screen box, never over it (`placeTip`). `part` and `pointer` are in
 * the canvas's CSS px; `view` is the canvas size.
 */
export function HoverTip({ tip, stage, part, pointer, view }: { tip: PartTip; stage: "short" | "long"; part: Box2; pointer: { x: number; y: number }; view: { width: number; height: number } }) {
  ensureNavStyle();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const p = placeTip(part, pointer, { width: el.offsetWidth, height: el.offsetHeight }, view);
    setPos((was) => (was && was.left === p.left && was.top === p.top ? was : { left: p.left, top: p.top }));
  }, [tip, stage, part.left, part.top, part.right, part.bottom, pointer.x, pointer.y, view.width, view.height]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = stage === "long" ? longTipRows(tip) : [];
  return (
    <div ref={ref} className={`cad-tip cad-tip-${stage}`} data-chrome="hover-tip" data-stage={stage} role="tooltip" style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}>
      <div className="cad-tip-title">{shortTip(tip)}</div>
      {stage === "long" && (
        <>
          {rows.length > 0 && (
            <dl className="cad-tip-rows">
              {rows.map(([k, v]) => (
                <span key={k} style={{ display: "contents" }}>
                  <dt>{k}</dt>
                  <dd data-row={k}>{v}</dd>
                </span>
              ))}
            </dl>
          )}
          <div className="cad-tip-hint">{tipHint(tip)}</div>
        </>
      )}
    </div>
  );
}
