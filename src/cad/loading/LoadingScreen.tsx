/**
 * The 3D view's loading screen (PB-1177; R1-B, review 2026-11-01 B1, B3, B4): what shows over the canvas while a
 * model loads, until the first frame of the whole model is drawn, so a heavy model never stalls on a blank canvas.
 *
 * - When: the first load of a model and a change of the model shown (`state.visible`), never a rebuild of the
 *   model on screen, which is swapped body by body in place (the tracker's mode "update"). The screen used to
 *   mount on every rebuild and flash the whole view near-white for 3 to 6 frames each time.
 * - The look: a translucent scrim in the theme's own scene colour (dark on the dark theme, light on paper) over
 *   the live scene, so the model shows through and the parts are seen arriving as each body loads; in the middle a
 *   card with the Protoboard mark in its chamfered triangle and the comet of dots walking the triangle (the
 *   alpha's loading screen, PB-1125, as the stack's viewer tab draws it in `web-viewer/src/vscode/Loading.tsx`),
 *   the title ("Loading model"), the stage line and the bar. No file names.
 * - Soft lock: the scrim takes the pointer and the wheel, so the camera does not move under a half-loaded model;
 *   Escape releases it for this load (the scrim clears, the card stays smaller, the view answers again).
 * - Choices: on a heavy model (over 20,000 draws or 5 M triangles, from the sidecar counts) or a wait over 10 s
 *   it offers "Load coarse" and "Show boxes"; it never refuses: "Load it all" goes on with the full model.
 *
 * The dots move with a CSS keyframe animation scoped to this component; reduced motion stops them. Colours are the
 * theme's tokens (`--uhd-scene-background`, `--uhd-overlay`, `--uhd-text`, `--uhd-accent`). The screen before
 * R1-B named `--uhd-bg` and `--uhd-line`, which are not tokens, so it fell back to 88 % white on every theme:
 * that was the light-grey overlay over the dark theme in the walkthrough (frame 431-1).
 */
import { useEffect, useState, type CSSProperties, type SyntheticEvent } from "react";
import type { LoadSnapshot, LoadTier } from "./stages";

/** The Protoboard "0" mark (PB-916) in a 24 × 24 box (the stack's `web-viewer/src/logo-mark.ts`, ours, Apache-2.0). */
export const MARK_PATH =
  "M8.529 13.629 15.272 6.885C15.348 6.81 15.385 6.715 15.385 6.6C15.385 6.486 15.348 6.39 15.272 6.315L13.815 4.886C13.624 4.695 13.386 4.6 13.101 4.6H10.9C10.614 4.6 10.376 4.695 10.186 4.886L8.529 6.543C8.338 6.733 8.243 6.972 8.243 7.257V13.486C8.243 13.638 8.281 13.714 8.357 13.714C8.414 13.714 8.472 13.686 8.529 13.629ZM10.9 19.4H13.101C13.386 19.4 13.624 19.305 13.815 19.114L15.472 17.457C15.662 17.267 15.757 17.029 15.757 16.743V10.514C15.757 10.362 15.719 10.286 15.643 10.286C15.586 10.286 15.529 10.315 15.472 10.372L8.729 17.115C8.634 17.209 8.586 17.305 8.586 17.4C8.586 17.496 8.634 17.591 8.729 17.685L10.186 19.114C10.376 19.305 10.614 19.4 10.9 19.4ZM6.015 5.372 9.015 2.4C9.243 2.133 9.548 2 9.929 2H14.072C14.433 2 14.738 2.124 14.986 2.372L17.958 5.372C18.224 5.6 18.357 5.905 18.357 6.286V17.714C18.357 18.076 18.224 18.391 17.958 18.657L14.986 21.628C14.738 21.876 14.433 22 14.072 22H9.929C9.548 22 9.243 21.867 9.015 21.6L6.015 18.628C5.767 18.381 5.643 18.076 5.643 17.714V6.286C5.643 5.924 5.767 5.619 6.015 5.372Z";

/** How much of the scene colour the scrim lays over the live view (0..1): the model reads through it. DEFAULT (R1-B). */
export const SCRIM_OPACITY = 0.55;

/** The chamfered triangle's corners in a 100 × 100 box, closed back to the first (as the stack's comet.ts). */
const TRIANGLE: ReadonlyArray<readonly [number, number]> = [
  [81.2, 83.78],
  [18.8, 83.78],
  [11, 70.26],
  [18.8, 56.75],
  [42.2, 16.22],
  [57.8, 16.22],
  [65.6, 29.73],
  [89, 70.26],
];
const DOTS = 24;
const LOOP_S = 1.6;
const STEP_S = 0.018;

/** The point a fraction of the way round the triangle, by length. */
export function trianglePoint(frac: number): [number, number] {
  const n = TRIANGLE.length;
  const seg = TRIANGLE.map((a, i) => Math.hypot(TRIANGLE[(i + 1) % n][0] - a[0], TRIANGLE[(i + 1) % n][1] - a[1]));
  const total = seg.reduce((s, l) => s + l, 0);
  let left = (((frac % 1) + 1) % 1) * total;
  for (let i = 0; i < n; i++) {
    if (left <= seg[i] || i === n - 1) {
      const a = TRIANGLE[i];
      const b = TRIANGLE[(i + 1) % n];
      const t = seg[i] ? left / seg[i] : 0;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    left -= seg[i];
  }
  return [TRIANGLE[0][0], TRIANGLE[0][1]];
}

/** Keyframes that walk the triangle by length (the corners at the fraction of the loop run so far). */
function keyframes(): string {
  const n = TRIANGLE.length;
  const seg = TRIANGLE.map((a, i) => Math.hypot(TRIANGLE[(i + 1) % n][0] - a[0], TRIANGLE[(i + 1) % n][1] - a[1]));
  const total = seg.reduce((s, l) => s + l, 0);
  let run = 0;
  const stops = TRIANGLE.map((p, i) => {
    const at = (run / total) * 100;
    run += seg[i];
    return `${at.toFixed(2)}%{transform:translate(${p[0]}px,${p[1]}px)}`;
  });
  stops.push(`100%{transform:translate(${TRIANGLE[0][0]}px,${TRIANGLE[0][1]}px)}`);
  return `@keyframes cad-loading-comet{${stops.join("")}}`;
}

const SCRIM_PCT = Math.round(SCRIM_OPACITY * 100);
const TEXT = "var(--uhd-text,#e5e5e5)";
const ACCENT = "var(--uhd-accent,#339fee)";
const STYLE = `${keyframes()}
.cad-loading-screen{position:absolute;inset:0;z-index:5;display:grid;place-items:center;background:color-mix(in srgb,var(--uhd-scene-background,var(--uhd-background,#131313)) ${SCRIM_PCT}%,transparent);font:12px var(--uhd-font-ui,system-ui);color:${TEXT};pointer-events:auto;cursor:progress;touch-action:none;transition:background-color .2s linear}
.cad-loading-screen.released{background:transparent;pointer-events:none;cursor:auto}
.cad-loading-card{display:flex;flex-direction:column;align-items:center;gap:10px;max-width:min(360px,calc(100% - 32px));padding:18px 22px 16px;text-align:center;border-radius:var(--uhd-radius,8px);background:var(--uhd-overlay,color-mix(in srgb,var(--uhd-surface,#1c1c1c) 92%,transparent));border:1px solid var(--uhd-border,color-mix(in srgb,${TEXT} 18%,transparent));box-shadow:var(--uhd-shadow-lg,0 8px 24px rgba(0,0,0,.25));cursor:auto;pointer-events:auto;transition:transform .2s ease,opacity .2s ease}
.cad-loading-screen.released .cad-loading-card{transform:scale(.9);opacity:.92}
.cad-loading-comet{position:relative;width:100px;height:100px}
.cad-loading-dot{position:absolute;top:0;left:0;border-radius:9999px;background:${ACCENT};will-change:transform;animation:cad-loading-comet ${LOOP_S}s linear infinite}
.cad-loading-dot.head{box-shadow:0 0 3px .5px ${ACCENT}}
.cad-loading-mark{position:absolute;top:55%;left:50%;width:38px;height:38px;transform:translate(-50%,-50%);color:${TEXT}}
.cad-loading-title{margin:0;font-size:13px;font-weight:600}
.cad-loading-stage{margin:0;color:var(--uhd-text-muted,color-mix(in srgb,${TEXT} 65%,transparent));min-height:1.3em}
.cad-loading-bar{width:220px;max-width:100%;height:3px;border-radius:2px;background:color-mix(in srgb,${TEXT} 14%,transparent);overflow:hidden}
.cad-loading-bar>i{display:block;height:100%;background:${ACCENT};transition:width .2s}
.cad-loading-bar.indeterminate>i{width:30%;animation:cad-loading-slide 1.2s ease-in-out infinite}
@keyframes cad-loading-slide{0%{transform:translateX(-100%)}100%{transform:translateX(340%)}}
.cad-loading-hint{margin:0;padding:0;border:0;background:none;font:inherit;font-size:11px;cursor:pointer;text-decoration:underline dotted;color:var(--uhd-text-faint,color-mix(in srgb,${TEXT} 45%,transparent))}
.cad-loading-actions{display:flex;flex-wrap:wrap;gap:6px;justify-content:center}
.cad-loading-actions button{font:inherit;padding:4px 10px;border-radius:6px;border:1px solid var(--uhd-border,currentColor);background:var(--uhd-surface,transparent);color:inherit;cursor:pointer}
.cad-loading-actions button.primary{border-color:${ACCENT}}
@media (prefers-reduced-motion:reduce){.cad-loading-dot,.cad-loading-bar.indeterminate>i{animation:none}.cad-loading-screen,.cad-loading-card{transition:none}}`;

/** The mark in its triangle with the comet round it, 100 px square. */
function Comet() {
  return (
    <div className="cad-loading-comet" aria-hidden>
      {Array.from({ length: DOTS }, (_, k) => {
        const behind = (DOTS - 1 - k) * STEP_S;
        const size = k === 0 ? 5 : 4;
        const at = trianglePoint(behind / LOOP_S);
        return (
          <div
            key={k}
            className={`cad-loading-dot${k === 0 ? " head" : ""}`}
            style={
              {
                width: size,
                height: size,
                marginLeft: -size / 2,
                marginTop: -size / 2,
                opacity: Math.exp((-3 * k) / (DOTS - 1)),
                animationDelay: `${-behind}s`,
                transform: `translate(${at[0].toFixed(2)}px, ${at[1].toFixed(2)}px)`,
              } as CSSProperties
            }
          />
        );
      })}
      {/* the "0" mark, in the text colour, on the triangle's incentre (below the box's middle) */}
      <svg className="cad-loading-mark" viewBox="0 0 24 24" aria-hidden>
        <path fill="currentColor" d={MARK_PATH} />
      </svg>
    </div>
  );
}

/** Keep an input event on the scrim (the soft lock): it never reaches the canvas or the page under it. */
const hold = (e: SyntheticEvent) => {
  e.stopPropagation();
  // React listens to wheel passively: preventDefault there only logs an error (gate R1); the overlay already keeps the
  // wheel from the canvas, which is not under it
  if (e.cancelable && e.type !== "wheel") e.preventDefault();
};

export interface LoadingScreenProps {
  /** The tracker's snapshot (`LoadTracker.snapshot()` or its subscription). */
  state: LoadSnapshot;
  /** A tier was chosen ("coarse", "boxes", or "fine" to load it all). Omit to hide the choices. */
  onChoose?: (tier: LoadTier) => void;
}

/**
 * The overlay; renders nothing once the first frame is drawn, and nothing for an update of the model on screen.
 * A snapshot without a title (a tracker from before R1-B) reads as "Loading model".
 */
export function LoadingScreen({ state, onChoose }: LoadingScreenProps) {
  // Escape releases the soft lock for this load; a new load locks again
  const [released, setReleased] = useState<number | undefined>(undefined);
  const loadId = state.loadId ?? 0;
  const locked = state.visible && released !== loadId;
  useEffect(() => {
    if (!locked) return;
    // gate R1: in the capture phase and taken (preventDefault), so the same Escape does not also take the view back
    // from the agents (CadView) or clear an isolation (the controller): both skip a handled Escape
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      setReleased(loadId);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [locked, loadId]);
  if (!state.visible) return null;
  const heavy = state.stage === "preflight";
  const pct = state.progress;
  const block = locked ? { onPointerDown: hold, onPointerMove: hold, onWheel: hold, onContextMenu: hold, onDoubleClick: hold } : {};
  return (
    <div
      className={`cad-loading-screen${locked ? "" : " released"}`}
      role="status"
      aria-live="polite"
      aria-busy="true"
      data-stage={state.stage}
      data-mode={state.mode ?? "load"}
      data-locked={locked ? "" : undefined}
      {...block}
    >
      <style>{STYLE}</style>
      <div className="cad-loading-card">
        <Comet />
        <p className="cad-loading-title">{state.title ?? "Loading model"}</p>
        <p className="cad-loading-stage">{state.showStage || heavy ? state.message : " "}</p>
        {!heavy && (
          <div className={`cad-loading-bar${pct === undefined ? " indeterminate" : ""}`} aria-hidden>
            <i style={pct === undefined ? undefined : { width: `${Math.round(pct * 100)}%` }} />
          </div>
        )}
        {onChoose && state.offerLighter && (
          <div className="cad-loading-actions">
            <button type="button" className="primary" onClick={() => onChoose("coarse")}>
              Load coarse
            </button>
            <button type="button" onClick={() => onChoose("boxes")}>
              Show boxes
            </button>
            {heavy && (
              <button type="button" onClick={() => onChoose("fine")}>
                Load it all
              </button>
            )}
          </div>
        )}
        {/* gate R1: also a button, for a pointer only or a webview without keyboard focus */}
        {locked && !heavy && state.showStage && (
          <button type="button" className="cad-loading-hint" onClick={() => setReleased(loadId)}>
            Esc to look around while it loads
          </button>
        )}
      </div>
    </div>
  );
}
