/**
 * Tooltips for the whole viewer from one layer: any element with
 * `data-tooltip` (every icon-only control) names itself in a themed tooltip
 * after a short hover or on keyboard focus. One listener, no per-button
 * component, and the tooltip lives inside the themed root, so it keeps the
 * host's tokens.
 */
import { useEffect, useRef, useState } from "react";

interface Tip {
  text: string;
  shortcut?: string;
  x: number;
  y: number;
  side: "top" | "bottom" | "left" | "right";
}

const OPEN_DELAY = 350;
/** Moving from one control to the next within this time shows the next tip at once. */
const SKIP_DELAY = 300;

/** Where to put the tip for a target: below it unless it says otherwise, kept inside the root. */
function place(target: HTMLElement, root: HTMLElement): Tip | null {
  const text = target.dataset.tooltip;
  if (!text) return null;
  const r = target.getBoundingClientRect();
  const o = root.getBoundingClientRect();
  let side = (target.dataset.tooltipSide as Tip["side"]) ?? "bottom";
  if (side === "bottom" && r.bottom + 32 > o.bottom) side = "top";
  if (side === "top" && r.top - 32 < o.top) side = "bottom";
  const x = side === "left" ? r.left - o.left - 8 : side === "right" ? r.right - o.left + 8 : r.left - o.left + r.width / 2;
  const y = side === "top" ? r.top - o.top - 8 : side === "bottom" ? r.bottom - o.top + 8 : r.top - o.top + r.height / 2;
  return { text, shortcut: target.dataset.tooltipShortcut, x, y, side };
}

export function Tooltips({ root }: { root: HTMLElement | null }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const shownAt = useRef(0);
  useEffect(() => {
    if (!root) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: HTMLElement | null = null;
    const hide = () => {
      clearTimeout(timer);
      if (current) shownAt.current = Date.now();
      current = null;
      setTip(null);
    };
    const show = (el: HTMLElement, now: boolean) => {
      clearTimeout(timer);
      current = el;
      const open = () => current === el && el.isConnected && setTip(place(el, root));
      if (now || Date.now() - shownAt.current < SKIP_DELAY) open();
      else timer = setTimeout(open, OPEN_DELAY);
    };
    const over = (e: Event) => {
      const el = (e.target as HTMLElement).closest?.<HTMLElement>("[data-tooltip]");
      if (el === current) return;
      if (!el || !root.contains(el)) return hide();
      show(el, false);
    };
    const focus = (e: FocusEvent) => {
      const el = (e.target as HTMLElement).closest?.<HTMLElement>("[data-tooltip]");
      if (el && (e.target as HTMLElement).matches(":focus-visible")) show(el, true);
    };
    root.addEventListener("pointerover", over);
    root.addEventListener("pointerleave", hide);
    root.addEventListener("pointerdown", hide, true);
    root.addEventListener("focusin", focus);
    root.addEventListener("focusout", hide);
    root.addEventListener("wheel", hide, { passive: true });
    const key = (e: KeyboardEvent) => e.key === "Escape" && hide();
    window.addEventListener("keydown", key);
    return () => {
      clearTimeout(timer);
      root.removeEventListener("pointerover", over);
      root.removeEventListener("pointerleave", hide);
      root.removeEventListener("pointerdown", hide, true);
      root.removeEventListener("focusin", focus);
      root.removeEventListener("focusout", hide);
      root.removeEventListener("wheel", hide);
      window.removeEventListener("keydown", key);
    };
  }, [root]);
  // kept inside the root once its size is known
  const [nudge, setNudge] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || !tip || !root) return setNudge(0);
    const w = el.offsetWidth;
    const max = root.clientWidth - 6;
    const left = tip.side === "top" || tip.side === "bottom" ? tip.x - w / 2 : tip.side === "left" ? tip.x - w : tip.x;
    setNudge(left < 6 ? 6 - left : left + w > max ? max - (left + w) : 0);
  }, [tip, root]);
  if (!tip) return null;
  const transform = {
    top: "translate(-50%, -100%)",
    bottom: "translate(-50%, 0)",
    left: "translate(-100%, -50%)",
    right: "translate(0, -50%)",
  }[tip.side];
  return (
    <div
      ref={ref}
      role="tooltip"
      className="uhd-tooltip pointer-events-none absolute z-[1000] flex items-center gap-2 rounded-md border border-line bg-raised px-2 py-1 font-ui text-[11px] leading-4 whitespace-nowrap text-fg shadow-float"
      style={{ left: tip.x + nudge, top: tip.y, transform }}
    >
      {tip.text}
      {tip.shortcut && <kbd className="rounded-sm border border-line-subtle px-1 font-code text-[10px] text-fg-muted">{tip.shortcut}</kbd>}
    </div>
  );
}
