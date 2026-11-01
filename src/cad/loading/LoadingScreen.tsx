/**
 * "Getting your model ready" (PB-1177): what the 3D view shows over the
 * canvas until the first frame of the whole model is drawn, so a heavy model
 * never pops in half built or stalls on a blank canvas.
 *
 * The visual is the comet of the alpha's loading screen (PB-1125, ported for
 * the stack's viewer tab in `protoboard-stack/packages/web-viewer/src/vscode/`
 * `Loading.tsx` and `comet.ts`, Apache-2.0, ours): dots running round the
 * chamfered triangle the Protoboard mark sits in. The viewer did not have it,
 * so the triangle walk is repeated here (`trianglePoint`) and the dots move
 * with a CSS keyframe animation scoped to this component. Reduced motion stops
 * them.
 *
 * Under it: the stage line and a bar (determinate when a total is known). On a
 * heavy model (over 20,000 draws or 5 M triangles, from the sidecar counts) or
 * a wait over 10 s it offers "Load coarse" and "Show boxes"; it never refuses:
 * "Load it all" goes on with the full model.
 */
import type { CSSProperties } from "react";
import type { LoadSnapshot, LoadTier } from "./stages";

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

const STYLE = `${keyframes()}
.cad-loading-screen{position:absolute;inset:0;z-index:5;display:grid;place-items:center;background:color-mix(in srgb,var(--uhd-bg,#fff) 88%,transparent);font:12px var(--uhd-font-ui,system-ui);color:var(--uhd-text,#222)}
.cad-loading-card{display:flex;flex-direction:column;align-items:center;gap:12px;max-width:min(420px,calc(100% - 32px));text-align:center}
.cad-loading-comet{position:relative;width:100px;height:100px}
.cad-loading-dot{position:absolute;top:0;left:0;border-radius:9999px;background:var(--uhd-accent,#339fee);will-change:transform;animation:cad-loading-comet ${LOOP_S}s linear infinite}
.cad-loading-title{margin:0;font-size:13px;font-weight:600}
.cad-loading-stage{margin:0;color:var(--uhd-text-muted,#666);min-height:1.3em}
.cad-loading-bar{width:220px;max-width:100%;height:3px;border-radius:2px;background:var(--uhd-line,#ddd);overflow:hidden}
.cad-loading-bar>i{display:block;height:100%;background:var(--uhd-accent,#339fee);transition:width .2s}
.cad-loading-bar.indeterminate>i{width:30%;animation:cad-loading-slide 1.2s ease-in-out infinite}
@keyframes cad-loading-slide{0%{transform:translateX(-100%)}100%{transform:translateX(340%)}}
.cad-loading-actions{display:flex;flex-wrap:wrap;gap:6px;justify-content:center}
.cad-loading-actions button{font:inherit;padding:4px 10px;border-radius:6px;border:1px solid var(--uhd-line,#ccc);background:var(--uhd-surface,#fff);color:inherit;cursor:pointer}
.cad-loading-actions button.primary{border-color:var(--uhd-accent,#339fee)}
@media (prefers-reduced-motion:reduce){.cad-loading-dot,.cad-loading-bar.indeterminate>i{animation:none}}`;

/** The mark's comet, 100 px square. */
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
            className="cad-loading-dot"
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
    </div>
  );
}

export interface LoadingScreenProps {
  /** The tracker's snapshot (`LoadTracker.snapshot()` or its subscription). */
  state: LoadSnapshot;
  /** A tier was chosen ("coarse", "boxes", or "fine" to load it all). Omit to hide the choices. */
  onChoose?: (tier: LoadTier) => void;
}

/** The overlay; renders nothing once the first frame is drawn. */
export function LoadingScreen({ state, onChoose }: LoadingScreenProps) {
  if (!state.visible) return null;
  const heavy = state.stage === "preflight";
  const pct = state.progress;
  return (
    <div className="cad-loading-screen" role="status" aria-live="polite" data-stage={state.stage}>
      <style>{STYLE}</style>
      <div className="cad-loading-card">
        <Comet />
        <p className="cad-loading-title">Getting your model ready</p>
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
      </div>
    </div>
  );
}
