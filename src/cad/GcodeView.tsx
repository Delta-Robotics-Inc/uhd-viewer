/**
 * The G-code tab (PB-1192): a sliced print, drawn the way slicers preview it,
 * beside the 3D view. A sibling of ModelView: its own scene from scene.ts
 * (`createScene`, used as it is), its own toolbar, nothing shared with
 * CadView's state.
 *
 *   - One instanced draw for every extrusion, a second only for travel moves
 *     when they are shown (../gcode/geometry.ts).
 *   - A two-ended layer slider over the layers that hold a visible segment
 *     (../gcode/range.ts): hiding a type takes its layers out of the steps.
 *   - A legend that is also the filter: feature types with their time share,
 *     each a toggle; travel is its own toggle.
 *   - Estimates: our time from lengths and feeds (a lower bound, no
 *     acceleration) beside the slicer's own when the file has one; filament.
 *   - Size caps: past 256 MB or 20 M segments the parser decimates, and the
 *     view says so (never a silent cut).
 *
 * Theme: the panels use the viewer's theme tokens (src/theme/) through the
 * token classes ModelView uses; the scene's background and grid follow the
 * theme as in ModelView; the travel colour is the theme's faint text colour.
 * Feature colours are a fixed data palette (../gcode/features.ts, DEFAULT).
 *
 * Quality: the interaction quality curve (src/cad/render/quality) runs on this
 * scene as on every other; this view only reads its state (`quality.report`,
 * `onChange`) to show when it is drawing at reduced quality. It never
 * configures it.
 *
 * Mounting: the tab's mount line in CadToolbar/CadView belongs to W4-D
 * (phase-1/handoffs.md, 2026-11-01, W4-B); until then a host mounts
 * `<GcodeView url=... />` on its own.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { useTheme, tokenColor } from "../theme/ThemeProvider";
import { DEFAULT_SCENE_ACCENT, DEFAULT_SCENE_HIGHLIGHT, createScene, type QualityReport, type SceneHandle } from "./scene";
import { IconButton, Toolbar, ToolbarSeparator } from "../ui/Toolbar";
import { ViewGlyph } from "./viewIcons";
import { cx } from "../ui/cx";
import { FEATURE_COUNT, GCODE_FEATURES, TRAVEL } from "../gcode/features";
import { buildGcodeDraw, type GcodeDraw } from "../gcode/geometry";
import { parseGcode, parseGcodeStream, type GcodeModel, type GcodeParseOptions } from "../gcode/parser";
import { rangeLayers, rebaseRange, setEnd, visibleLayers, visibleMask, type LayerRange } from "../gcode/range";

export interface GcodeViewProps {
  /** A `.gcode` file to fetch (streamed). */
  url?: string;
  /** G-code text a host already holds (used instead of `url`). */
  text?: string;
  /** A file the user dropped or picked (streamed). */
  file?: Blob;
  name?: string;
  /** Caps and tolerances for the parser (tests and measurement). */
  parseOptions?: GcodeParseOptions;
  /** Called once the toolpaths are on screen. */
  onReady?: (info: GcodeViewInfo) => void;
  className?: string;
}

export interface GcodeViewInfo {
  model: GcodeModel;
  drawCalls: number;
}

type ViewDir = "iso" | "top" | "front";
// the standard-view glyphs shared with ModelView (./viewIcons.tsx, R1-D E2)
const VIEWS: { id: ViewDir; label: string; dir: [number, number, number] }[] = [
  { id: "iso", label: "Isometric view", dir: [1, -1.2, 0.9] },
  { id: "top", label: "Top view", dir: [0, -0.0001, 1] },
  { id: "front", label: "Front view", dir: [0, -1, 0.0001] },
];

const hms = (s: number) => {
  const t = Math.round(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  return h ? `${h} h ${m} min` : m ? `${m} min ${t % 60} s` : `${t % 60} s`;
};
const int = (n: number) => n.toLocaleString("en-US");

export function GcodeView({ url, text, file, name, parseOptions, onReady, className }: GcodeViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<SceneHandle | null>(null);
  const draw = useRef<GcodeDraw | null>(null);
  const [model, setModel] = useState<GcodeModel | null>(null);
  const [status, setStatus] = useState<{ kind: "loading" | "ready" | "error"; message?: string; bytes?: number }>({ kind: "loading" });
  const [on, setOn] = useState<boolean[]>(() => new Array(FEATURE_COUNT).fill(true));
  const [travel, setTravel] = useState(false);
  const [dim, setDim] = useState(true);
  const [range, setRange] = useState<LayerRange | undefined>(undefined);
  const [view, setView] = useState<ViewDir>("iso");
  const [quality, setQuality] = useState<QualityReport | null>(null);
  const [showInfo, setShowInfo] = useState(true);

  // the scene: no batching, toon or ink (they are for CAD bodies; the toolpaths bring their own shader)
  useEffect(() => {
    if (!host.current) return;
    let h: SceneHandle;
    try {
      h = createScene(host.current, { batching: false, toon: false, edges: false });
    } catch {
      setStatus({ kind: "error", message: "3D drawing (WebGL) is not available here." });
      return;
    }
    handle.current = h;
    // read-only: the quality curve's state, to say when the view draws at reduced quality
    const off = h.quality.onChange((r) => setQuality(r));
    return () => {
      off();
      draw.current?.dispose();
      draw.current = null;
      h.dispose();
      handle.current = null;
    };
  }, []);

  // theme: background, grid and highlight as ModelView; travel in the theme's faint text colour
  const { theme } = useTheme();
  useEffect(() => {
    const h = handle.current;
    const el = host.current;
    if (!h || !el) return;
    h.setTheme({
      background: tokenColor(el, "sceneBackground"),
      grid: tokenColor(el, "sceneGrid", "#3a3a3a"),
      gridMinor: tokenColor(el, "sceneGridMinor", "#262626"),
      accent: tokenColor(el, "accent", DEFAULT_SCENE_ACCENT),
      highlight: tokenColor(el, "highlight", DEFAULT_SCENE_HIGHLIGHT),
    });
    draw.current?.setPalette(GCODE_FEATURES.map((f) => f.color), tokenColor(el, "textFaint", GCODE_FEATURES[TRAVEL].color));
    h.invalidate();
  }, [theme, model]);

  const frame = (dir: [number, number, number]) => {
    const h = handle.current;
    const b = model?.bounds;
    if (!h || !b) return;
    const box = new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max));
    const centre = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() / 2 || 10;
    const d = new THREE.Vector3(...dir).normalize();
    const dist = (radius / Math.sin((h.camera.fov * Math.PI) / 360)) * 1.08;
    h.camera.near = Math.max(0.01, radius / 200);
    h.camera.far = radius * 200;
    h.camera.updateProjectionMatrix();
    h.controls.target.copy(centre);
    h.camera.position.copy(centre).addScaledVector(d, dist);
    h.controls.update();
    h.invalidate("view");
  };

  // the file: parsed in chunks (the page stays responsive), then one draw built
  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    setStatus({ kind: "loading" });
    setModel(null);
    const progress = (bytes: number) => !cancelled && setStatus({ kind: "loading", bytes });
    const parse = async (): Promise<GcodeModel> => {
      if (text !== undefined) {
        await new Promise((r) => setTimeout(r, 0));
        return parseGcode(text, parseOptions);
      }
      if (file) return parseGcodeStream(file.stream(), { ...parseOptions, size: file.size, onProgress: progress, signal: abort.signal });
      if (url) {
        const res = await fetch(url, { signal: abort.signal });
        if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`.trim() || "the file could not be read");
        const size = Number(res.headers.get("content-length")) || undefined;
        return parseGcodeStream(res.body, { ...parseOptions, ...(size ? { size } : {}), onProgress: progress, signal: abort.signal });
      }
      throw new Error("Nothing to show.");
    };
    parse()
      .then((m) => {
        if (cancelled) return;
        const h = handle.current;
        draw.current?.dispose();
        draw.current = null;
        if (h) {
          h.root.clear();
          const d = buildGcodeDraw(m);
          draw.current = d;
          h.root.add(d.group);
          if (m.bounds) h.setGround(new THREE.Box3(new THREE.Vector3(...m.bounds.min), new THREE.Vector3(...m.bounds.max)));
        }
        setModel(m);
        setStatus({ kind: "ready" });
      })
      .catch((e: Error) => !cancelled && setStatus({ kind: "error", message: e.message }));
    return () => {
      cancelled = true;
      abort.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, text, file]);

  // the visible layers follow the toggles; the range keeps its layers where it can
  const layers = useMemo(() => (model ? visibleLayers(model, visibleMask(on, travel)) : []), [model, on, travel]);
  useEffect(() => setRange((r) => rebaseRange(r, layers)), [layers]);

  // push toggles and range to the draw (uniforms and instance counts only; nothing is rebuilt)
  useEffect(() => {
    const d = draw.current;
    const h = handle.current;
    if (!d || !h || !model) return;
    d.setFeatureVisible(on);
    d.setTravelVisible(travel);
    d.setDim(dim ? 0.72 : 1);
    const [lo, hi] = range ? rangeLayers(range) : [0, model.layers.count - 1];
    d.setLayerRange(lo, hi);
    h.invalidate();
  }, [model, on, travel, dim, range]);

  // first frame once ready
  const readyOnce = useRef<GcodeModel | null>(null);
  useEffect(() => {
    if (!model || readyOnce.current === model) return;
    readyOnce.current = model;
    frame(VIEWS[0].dir);
    onReady?.({ model, drawCalls: draw.current?.drawCalls() ?? 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  const totalTime = model?.features.reduce((n, f) => n + f.timeS, 0) ?? 0;
  const present = model ? model.features.filter((f) => f.feature !== TRAVEL) : [];
  const travelTotals = model?.features.find((f) => f.feature === TRAVEL);
  const [loLayer, hiLayer] = range && range.layers.length ? rangeLayers(range) : [0, -1];
  const reduced = quality && quality.enabled && quality.knobs.length > 0;
  const drawCalls = draw.current?.drawCalls() ?? 0;

  return (
    <div className={cx("uhd-gcode-view relative size-full min-h-[240px] min-w-[280px] overflow-hidden bg-canvas select-none", className)}>
      <div ref={host} className="absolute inset-0 [&>canvas]:block [&>canvas]:size-full" />

      {status.kind !== "ready" && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className={cx("rounded-panel border border-line bg-surface px-4 py-3 text-center shadow-panel", status.kind === "error" ? "text-error" : "text-fg-muted")}>
            <div className="font-label text-[12px] tracking-[0.06em] uppercase">{status.kind === "error" ? "Cannot show this G-code" : "Reading the G-code"}</div>
            {status.message && <div className="mt-1 max-w-[320px] text-[11px] text-fg-muted">{status.message}</div>}
            {status.kind === "loading" && status.bytes !== undefined && <div className="mt-1 font-code text-[11px] text-fg-muted">{(status.bytes / 1024 ** 2).toFixed(1)} MB read</div>}
          </div>
        </div>
      )}

      {model && showInfo && (
        <div role="note" aria-label="Print summary" className="absolute top-[calc(var(--uhd-inset-top,0px)+12px)] left-3 max-h-[calc(100%-80px)] w-[min(300px,calc(100%-90px))] overflow-y-auto rounded-panel border border-line bg-surface px-3 py-2 text-[11px] shadow-panel outline outline-1 -outline-offset-1 outline-contrast">
          {name && <div className="truncate font-label text-[12px] tracking-[0.06em] text-fg uppercase">{name}</div>}
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-code text-fg-muted">
            <span>
              {hms(model.timeS)} <span className="text-fg-faint">our estimate</span>
            </span>
            {model.slicerTimeS !== undefined && (
              <span>
                {hms(model.slicerTimeS)} <span className="text-fg-faint">slicer</span>
              </span>
            )}
            <span>
              {(model.filamentMm / 1000).toFixed(2)} <span className="text-fg-faint">m filament</span>
            </span>
            <span>
              {int(model.layers.count)} <span className="text-fg-faint">layers</span>
            </span>
            <span>
              {int(model.extrude.count + model.travel.count)} <span className="text-fg-faint">segments</span>
            </span>
            <span>
              {drawCalls} <span className="text-fg-faint">{drawCalls === 1 ? "draw" : "draws"}</span>
            </span>
          </div>
          {model.decimation && (
            <div role="status" className="mt-1.5 rounded-sm border border-line bg-sunken px-2 py-1 text-fg">
              Simplified to draw: {model.decimation.reason}. Up to {model.decimation.factor} moves per segment
              {model.decimation.dropped ? `, ${int(model.decimation.dropped)} segments left out` : ""} ({int(model.decimation.inputSegments)} in the file).
            </div>
          )}
          {reduced && <div className="mt-1 text-fg-faint">Drawing at reduced quality while the view moves ({quality!.knobs.join(", ")}).</div>}

          <div className="mt-2 font-label text-[10px] tracking-[0.08em] text-fg-faint uppercase">Feature types</div>
          <ul className="mt-1 space-y-0.5">
            {present.map((f) => {
              const feat = GCODE_FEATURES[f.feature];
              const share = totalTime ? Math.round((100 * f.timeS) / totalTime) : 0;
              return (
                <li key={feat.id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-0.5 hover:bg-hover">
                    <input
                      type="checkbox"
                      checked={on[f.feature]}
                      onChange={(e) => setOn((o) => o.map((v, i) => (i === f.feature ? e.target.checked : v)))}
                      aria-label={`Show ${feat.label}`}
                    />
                    <span aria-hidden className="inline-block size-3 shrink-0 rounded-[2px] border border-line" style={{ background: feat.color }} />
                    <span className="flex-1 truncate text-fg">{feat.label}</span>
                    <span className="font-code text-fg-muted">{share}%</span>
                  </label>
                </li>
              );
            })}
            {travelTotals && (
              <li>
                <label className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-0.5 hover:bg-hover">
                  <input type="checkbox" checked={travel} onChange={(e) => setTravel(e.target.checked)} aria-label="Show travel moves" />
                  <span aria-hidden className="inline-block h-0.5 w-3 shrink-0 bg-fg-faint" />
                  <span className="flex-1 truncate text-fg">Travel</span>
                  <span className="font-code text-fg-muted">{totalTime ? Math.round((100 * travelTotals.timeS) / totalTime) : 0}%</span>
                </label>
              </li>
            )}
          </ul>
          {model.warnings.length > 0 && <div className="mt-1.5 text-fg-faint">{model.warnings.slice(0, 3).join("; ")}</div>}
        </div>
      )}

      {model && range && range.layers.length > 0 && (
        <div aria-label="Layers" role="group" className="absolute top-[calc(var(--uhd-inset-top,0px)+12px)] right-3 w-[180px] rounded-panel border border-line bg-surface px-3 py-2 text-[11px] shadow-panel">
          <div className="font-label text-[10px] tracking-[0.08em] text-fg-faint uppercase">Layers</div>
          <div className="mt-0.5 font-code text-fg">
            {loLayer + 1} – {hiLayer + 1} <span className="text-fg-faint">of {model.layers.count}</span>
          </div>
          <div className="font-code text-fg-muted">
            z {model.layers.z[loLayer]?.toFixed(2)} – {model.layers.z[hiLayer]?.toFixed(2)} mm
          </div>
          <label className="mt-1.5 block text-fg-muted">
            Top
            <input className="block w-full" type="range" min={0} max={range.layers.length - 1} step={1} value={range.hi} onChange={(e) => setRange((r) => (r ? setEnd(r, "hi", Number(e.target.value)) : r))} aria-label="Top layer shown" />
          </label>
          <label className="block text-fg-muted">
            Bottom
            <input className="block w-full" type="range" min={0} max={range.layers.length - 1} step={1} value={range.lo} onChange={(e) => setRange((r) => (r ? setEnd(r, "lo", Number(e.target.value)) : r))} aria-label="Bottom layer shown" />
          </label>
          {range.layers.length < model.layers.count && <div className="mt-1 text-fg-faint">{int(range.layers.length)} layers hold a shown type</div>}
        </div>
      )}

      <div className="absolute right-0 bottom-3 left-0 flex justify-center px-3">
        <Toolbar label="G-code tools" className="max-w-full overflow-x-auto [scrollbar-width:none]">
          <IconButton icon="maximize" label="Fit" tooltipSide="top" disabled={!model} onClick={() => frame(VIEWS.find((v) => v.id === view)!.dir)} />
          <ToolbarSeparator />
          {VIEWS.map((v) => (
            <IconButton
              key={v.id}
              icon={<ViewGlyph face={v.id} />}
              label={v.label}
              tooltipSide="top"
              pressed={view === v.id}
              disabled={!model}
              onClick={() => {
                setView(v.id);
                frame(v.dir);
              }}
            />
          ))}
          <ToolbarSeparator />
          <IconButton icon="route" label="Travel moves" tooltipSide="top" pressed={travel} disabled={!model?.travel.count} onClick={() => setTravel(!travel)} />
          <IconButton icon="layers" label="Dim the layers under the top one" tooltipSide="top" pressed={dim} onClick={() => setDim(!dim)} />
          <ToolbarSeparator />
          <IconButton icon="info" label={showInfo ? "Hide the summary and legend" : "Summary and legend"} tooltipSide="top" pressed={showInfo} onClick={() => setShowInfo(!showInfo)} />
        </Toolbar>
      </div>
    </div>
  );
}
