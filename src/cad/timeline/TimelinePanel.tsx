/**
 * The assembly timeline (R3-B, 2026-11-02): Kevin's chosen concept (image 1's bottom panel), docked under the 3D
 * view's toolbar while Explode or Assemble is on. Play/pause and loop drive the sequence player; the EXPLODE slider
 * writes `explode.t` through the view state's `explode` op as the person (agents and the person share it; the op log
 * records the gesture); a step chip goes to that step; dragging anywhere on the tracks (or the playhead) scrubs;
 * Space plays or pauses and Left/Right step when the panel has focus. Collapses to one line (remembered per viewer).
 *
 * Tracks on one time axis (assembly, left to right; ./model.ts): STEPS from the sequence, one row per joint with its
 * keyframes and the moving segment, CONTACTS from the interference sweep; the playhead crosses them all.
 *
 * Mounted by CadView as a sibling of `.cad-canvas` (handoffs.md, "R3-A (CadView)"); it renders nothing while hidden.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Icon } from "../../canvas/Icon";
import { HUMAN, SYSTEM, useViewSlice, type ViewStore } from "../state";
import type { ResolvedJoint, ResolvedSequence } from "../sequence/resolve";
import type { ExplodeMode, PlayerSnapshot, SequenceCommand, SequencePlayer } from "../sequence/player";
import {
  LINGER_MS,
  activeSegment,
  axisOf,
  chipState,
  chipText,
  contactText,
  contactsOf,
  headerText,
  jointLabel,
  keyAction,
  loadCollapsed,
  neighbourStep,
  saveCollapsed,
  stepIndexAt,
  tOfAxis,
  timelineModel,
  timelineWanted,
  type InterferenceReportLike,
  type TimelineContact,
  type TimelineStep,
} from "./model";
import { ensureTimelineStyle } from "./style";

/** What the panel reads and drives: CadView's player and its command runner (which resolves the player and poses the model). */
export interface TimelineSource {
  player: () => SequencePlayer | null;
  run: (cmd: SequenceCommand) => { ok: boolean; error?: string };
}

export interface TimelinePanelProps {
  store: ViewStore;
  source: TimelineSource;
  /** The toolbar asked for the panel (Explode turned on, Assemble clicked): it shows at once. */
  requested?: boolean;
  /** Called with false when the panel hides after the parts came to rest together (so the request is spent). */
  onRequested?: (on: boolean) => void;
  /** Contacts from the interference sweep: a `protoboard interference --json` report, or the contacts themselves. Absent: "no sweep run". */
  contacts?: readonly TimelineContact[] | InterferenceReportLike | null;
}

/** What the panel shows of the player, read each frame while something moves. */
interface Live {
  t: number;
  playing: boolean;
  step: string | null;
  mode: ExplodeMode;
  speed: number;
  snap?: PlayerSnapshot;
  resolved?: ResolvedSequence;
  extra: ResolvedJoint[];
}

const ids = new WeakMap<object, number>();
let nextId = 1;
const idOf = (o: object | undefined) => {
  if (!o) return 0;
  let n = ids.get(o);
  if (!n) ids.set(o, (n = nextId++));
  return n;
};

function readLive(p: SequencePlayer | null, storeT: number): Live {
  if (!p) return { t: storeT, playing: false, step: null, mode: "radial", speed: 1, extra: [] };
  const snap = p.snapshot();
  const resolved = p.resolved;
  return { t: p.t, playing: Boolean(p.playing), step: p.currentStep(), mode: p.explodeMode, speed: p.speed, snap, resolved, extra: p.joints.filter((j) => !resolved.joints.includes(j)) };
}
const liveKey = (l: Live) => [l.t.toFixed(4), l.playing, l.step, l.mode, l.speed, l.snap?.loop, l.snap?.clip?.samples ?? "", idOf(l.resolved), l.extra.length, l.snap ? Object.values(l.snap.joints).map((j) => j.value.toFixed(2)).join(",") : ""].join("|");

/** DEFAULT: a press that moves this far (px) is a scrub, not a click on a step chip. */
const DRAG_PX = 3;

export function TimelinePanel(props: TimelinePanelProps) {
  ensureTimelineStyle();
  const { store } = props;
  const src = useRef(props.source);
  src.current = props.source;
  const storeT = useViewSlice(store, (s) => s.explode.t);
  const [live, setLive] = useState<Live>(() => readLive(props.source.player(), storeT));
  const [shown, setShown] = useState(() => Boolean(props.requested) || timelineWanted({ storeT }));
  const [collapsed, setCollapsed] = useState(() => loadCollapsed());
  const [radialLoop, setRadialLoop] = useState(false);
  const radialLoopRef = useRef(radialLoop);
  radialLoopRef.current = radialLoop;
  const storeTRef = useRef(storeT);
  storeTRef.current = storeT;

  // ---- when it shows: asked, apart, moving; and a moment after coming to rest together --------------------------
  const active = timelineWanted({ storeT, playerT: live.t, playing: live.playing });
  useEffect(() => {
    if (props.requested) setShown(true);
  }, [props.requested]);
  useEffect(() => {
    if (active) {
      setShown(true);
      return;
    }
    if (!shown) return;
    const id = setTimeout(() => {
      setShown(false);
      setRadialLoop(false);
      if (props.requested) props.onRequested?.(false);
    }, LINGER_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, shown, props.requested]);

  // ---- reading the player: every frame while something changes, else every 200 ms (only while shown or wanted) ----
  const polling = shown || active;
  useEffect(() => {
    if (!polling) return;
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let last = "";
    let changedAt = performance.now();
    const step = () => {
      if (stopped) return;
      const p = src.current.player();
      const l = readLive(p, storeTRef.current);
      const key = liveKey(l);
      const now = performance.now();
      if (key !== last) {
        last = key;
        changedAt = now;
        setLive(l);
      }
      // the radial loop (Explode mode's ping-pong, DEFAULT: the player's own loop plays the steps): at an end, go back
      if (p && radialLoopRef.current && l.mode === "radial" && !l.playing && Math.abs(l.t - storeTRef.current) < 1e-4) {
        store.dispatch([{ op: "explode", t: l.t > 0.5 ? 0 : 1 }], { actor: SYSTEM, label: "loop the explode (timeline)", source: "timeline" });
      }
      // DEFAULT (R3-B): every frame while something changed in the last 400 ms, else every 200 ms
      if (now - changedAt < 400) raf = requestAnimationFrame(step);
      else timer = setTimeout(step, 200);
    };
    step();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
    };
  }, [polling, store]);

  const model = useMemo(() => (live.resolved ? timelineModel(live.resolved, live.extra) : undefined), [live.resolved, live.extra.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const contacts = useMemo(() => contactsOf(props.contacts), [props.contacts]);

  // ---- actions ------------------------------------------------------------------------------------------------------
  const player = () => src.current.player();
  const human = (ops: unknown[], label: string, gesture?: string) => {
    const r = store.dispatch(ops, { actor: HUMAN, label: label.slice(0, 120), ...(gesture ? { gesture } : {}) });
    if (r && "error" in r) console.warn(`[timeline] ${r.error}`);
  };
  /** Something moves now: the player plays, or the view eases toward the view state's amount. */
  const moving = live.playing || Math.abs(live.t - storeT) > 1e-4;
  const steps = model?.steps ?? [];
  const x = axisOf(live.t);
  const together = x >= 1 - 1e-6 && !moving;
  const current = together ? steps.length : stepIndexAt(steps, x, live.step);

  /** The view state's explode amount (and step, playing the steps) where the player is now. */
  const here = (p: SequencePlayer) => ({ op: "explode", t: Math.min(1, Math.max(0, p.t)), ...(p.explodeMode === "sequence" ? { step: p.currentStep() } : {}) });
  const pause = () => {
    src.current.run({ action: "stop" });
    setRadialLoop(false);
    const p = player();
    // an ease toward the view state's amount (a toolbar toggle, the slider) stops where the parts are
    if (p && Math.abs(p.t - storeT) > 1e-4) human([here(p)], "pause the timeline");
  };
  const play = () => {
    if (!player()) src.current.run({ action: "stop" }); // resolves the sequence (CadView's runner does, lazily)
    const p = player();
    if (!p) return;
    if (p.explodeMode === "radial") {
      // Explode mode: all parts at once, toward the other end (the toolbar's own ease)
      human([{ op: "explode", t: p.t > 0 ? 0 : 1 }], p.t > 0 ? "assemble the parts (timeline play)" : "explode the parts (timeline play)");
      return;
    }
    const first = model?.steps[0];
    if (p.t <= 1e-4 && first) src.current.run({ action: "play", mode: "assemble", from: first.id });
    else src.current.run({ action: "play", mode: "assemble" });
  };
  const togglePlay = () => (moving ? pause() : play());
  const toggleLoop = () => {
    const p = player();
    if (!p) return;
    if (p.explodeMode === "radial") {
      const on = !radialLoop;
      setRadialLoop(on);
      if (on && !moving) play();
      return;
    }
    const on = !live.snap?.loop;
    src.current.run(on ? { action: "loop", on: true, mode: p.t > 0.5 ? "assemble" : "explode" } : { action: "loop", on: false });
  };
  const goStep = (s: TimelineStep | undefined) => {
    if (!s) return;
    // the view state's step drives the player (CadView's effect runs the goto): the person's click is logged as theirs
    human([{ op: "explode", t: tOfAxis(s.x0), step: s.id, mode: "sequence" }], `go to step ${s.n}: ${s.title}`);
  };
  /** Jump the player to axis position `ax` (instant); `scrub`: also the person's gesture in the view state (one log entry per drag). */
  const seek = (ax: number, scrub = false) => {
    if (!player()) src.current.run({ action: "stop" });
    // the person's gesture first (no step: the player's own write-back names the step it lands in, so CadView's step
    // effect does not jump to a step's start), then the player jumps there at once (no ease)
    if (scrub) human([{ op: "explode", t: tOfAxis(ax) }], "scrub the timeline", "timeline-scrub");
    src.current.run({ action: "set", t: tOfAxis(ax) });
  };
  const setExplode = (t: number) => {
    if (live.playing) src.current.run({ action: "stop" });
    human([{ op: "explode", t }], "set the explode amount (timeline)", "timeline-explode");
  };
  const fold = (on: boolean) => {
    setCollapsed(on);
    saveCollapsed(on);
  };

  // ---- scrubbing: a press on the tracks; a move past DRAG_PX scrubs, a still press on a chip goes to its step -----
  const overlay = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x0: number; id: number; scrubbing: boolean; chip?: string } | null>(null);
  const axisAt = (clientX: number) => {
    const r = overlay.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return x;
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("[data-contact]")) return;
    const chip = (target.closest("[data-step]") as HTMLElement | null)?.dataset.step;
    drag.current = { x0: e.clientX, id: e.pointerId, scrubbing: !chip, ...(chip ? { chip } : {}) };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* a synthetic pointer */
    }
    store.setInteracting(true);
    if (!chip) seek(axisAt(e.clientX), true);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (!d.scrubbing && Math.abs(e.clientX - d.x0) > DRAG_PX) d.scrubbing = true;
    if (d.scrubbing) seek(axisAt(e.clientX), true);
  };
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    store.setInteracting(false);
    if (!d.scrubbing && d.chip) return goStep(steps.find((s) => s.id === d.chip));
    // the scrub ends: the view state takes where the parts are, as the person's gesture
    const p = player();
    if (p) human([here(p)], "scrub the timeline", "timeline-scrub");
  };

  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    const a = keyAction(e.key, e.target as HTMLElement);
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    if (a === "toggle") togglePlay();
    else goStep(neighbourStep(steps, current, a === "prev" ? -1 : 1));
  };

  if (!shown) return null;

  const head = headerText(model, { mode: live.mode, t: live.t, step: live.step, speed: live.speed, playing: moving, radial: live.snap?.radial });
  const loopOn = live.mode === "radial" ? radialLoop : Boolean(live.snap?.loop);
  const playLabel = moving ? "Pause (Space)" : live.mode === "radial" ? (live.t > 0 ? "Play: bring the parts together (Space)" : "Play: explode all parts (Space)") : "Play the assembly (Space)";
  const pct = (v: number) => `${(Math.min(1, Math.max(0, v)) * 100).toFixed(3)}%`;
  const noteAt = contacts?.length ? contacts.reduce((best, c) => (Math.abs(axisOf(c.t) - x) < Math.abs(axisOf(best.t) - x) ? c : best), contacts[0]) : undefined;

  return (
    <section
      className="cad-timeline"
      data-chrome="timeline"
      data-mode={live.mode}
      data-collapsed={collapsed || undefined}
      role="region"
      aria-label="Assembly timeline"
      tabIndex={0}
      onKeyDown={onKey}
    >
      <div className="cad-tl-head">
        <button type="button" className="cad-tl-btn cad-tl-play" aria-label={playLabel} data-tooltip={playLabel} data-tooltip-side="top" aria-pressed={moving} onClick={togglePlay}>
          <Icon name={moving ? "pause" : "play"} size={collapsed ? 13 : 15} />
        </button>
        {!collapsed && (
          <button type="button" className="cad-tl-btn cad-tl-loop" aria-label="Loop" data-tooltip={loopOn ? "Loop: on" : "Loop"} data-tooltip-side="top" aria-pressed={loopOn} onClick={toggleLoop}>
            <Icon name="repeat" size={14} />
          </button>
        )}
        <div className="cad-tl-title">
          <div className="cad-tl-name" data-timeline="title" title={head.title}>
            {head.title}
          </div>
          {!collapsed && (
            <div className="cad-tl-sub" data-timeline="sub">
              {head.sub}
            </div>
          )}
        </div>
        {!collapsed && (
          <label className="cad-tl-explode">
            Explode
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={Number(live.t.toFixed(2))}
              aria-label="Explode amount"
              onPointerDown={() => store.setInteracting(true)}
              onPointerUp={() => store.setInteracting(false)}
              onChange={(e) => setExplode(Number(e.target.value))}
            />
            <output>{live.t.toFixed(2)}</output>
          </label>
        )}
        {!collapsed && live.snap && (
          <span className="cad-tl-chip" data-timeline="chip">
            <Icon name={live.snap.clip ? "repeat" : "list-ordered"} size={12} />
            {chipText(live.snap, loopOn)}
          </span>
        )}
        <button type="button" className="cad-tl-btn cad-tl-fold" aria-label={collapsed ? "Show the timeline's tracks" : "Collapse the timeline to one line"} data-tooltip={collapsed ? "Show the tracks" : "Collapse"} data-tooltip-side="top" aria-expanded={!collapsed} onClick={() => fold(!collapsed)}>
          <Icon name={collapsed ? "chevron-up" : "chevron-down"} size={14} />
        </button>
      </div>
      {!collapsed && (
        <div className="cad-tl-tracks" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          <div className="cad-tl-row cad-tl-steps">
            <div className="cad-tl-label">Steps</div>
            <div className="cad-tl-lane" data-track="steps">
              {!steps.length && <span className="cad-tl-empty">{model ? "no steps to play" : "the sequence resolves on the first play"}</span>}
              {steps.map((s, i) => (
                <button
                  key={s.id}
                  type="button"
                  className="cad-tl-stepchip"
                  data-step={s.id}
                  data-state={live.mode === "radial" ? "todo" : chipState(i, current, x, s)}
                  data-sub={s.depth > 0 || undefined}
                  style={{ left: pct(s.x0), width: `calc(${pct(s.x1 - s.x0)} - 2px)` }}
                  aria-label={`Step ${s.n}: ${s.title}`}
                  aria-current={i === current && live.mode !== "radial" ? "step" : undefined}
                  data-tooltip={`${s.n} · ${s.title} · ${s.members} part${s.members === 1 ? "" : "s"}${s.limits?.length ? ` · a joint held at its stop` : ""}${live.mode === "radial" ? " · click: go to this step (plays the steps)" : ""}`}
                  data-tooltip-side="top"
                  tabIndex={-1}
                >
                  <span className="n">{s.n}</span>
                  <span className="t">{s.title}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="cad-tl-joints">
            {(model?.joints ?? []).map((j) => {
              const act = activeSegment(j, x);
              const last = j.keys[j.keys.length - 1];
              const now = live.snap?.joints[j.id]?.value;
              const label = jointLabel(j, x, now, live.snap?.clip);
              // the words beside the keyframes: after the last one when there is room, else before the first segment
              const end = Math.max(...j.segments.map((s) => s.x1), last?.x ?? 0);
              const start = Math.min(...j.segments.map((s) => s.x0), end);
              const noteStyle = end < 0.62 ? { left: `calc(${pct(end)} + 10px)` } : start > 0.38 ? { right: `calc(${pct(1 - start)} + 10px)` } : { left: "14px" };
              return (
                <div key={j.id} className="cad-tl-row" data-joint={j.id}>
                  <div className="cad-tl-label" title={j.id}>
                    {j.id.replace(/[_:]/g, " ")}
                  </div>
                  <div className="cad-tl-lane" data-track="joint">
                    <div className="cad-tl-line" />
                    {j.segments.map((s) => (
                      <div key={s.step} className="cad-tl-seg" data-active={act === s || undefined} style={{ left: pct(s.x0), width: pct(s.x1 - s.x0) }} />
                    ))}
                    {j.keys.map((k, i) => (
                      <span
                        key={`${k.step ?? "rest"}-${i}`}
                        className="cad-tl-key"
                        data-on={(act && (act.step === k.step || j.keys[i + 1]?.step === act.step)) || undefined}
                        data-held={k.held ? true : undefined}
                        style={{ left: pct(k.x) }}
                        title={k.held ? `${k.step}: asked ${k.held.asked}${j.unit}, held at ${k.held.held}${j.unit} (${k.held.stop} stop)` : `${k.step ?? "rest"}: ${k.value}${j.unit}`}
                      />
                    ))}
                    <span className="cad-tl-note" data-timeline="joint-label" style={noteStyle}>
                      {label}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="cad-tl-row cad-tl-contacts">
            <div className="cad-tl-label">Contacts</div>
            <div className="cad-tl-lane" data-track="contacts">
              <div className="cad-tl-line" />
              {contacts === undefined && <span className="cad-tl-empty">no sweep run · protoboard interference</span>}
              {contacts?.length === 0 && <span className="cad-tl-empty">no contacts in the sweep</span>}
              {contacts?.map((c) =>
                c.tEnd !== undefined && axisOf(c.tEnd) - axisOf(c.t) > 1e-4 ? <span key={`${c.id}-span`} className="cad-tl-span" style={{ left: pct(axisOf(c.t)), width: pct(axisOf(c.tEnd) - axisOf(c.t)) }} /> : null,
              )}
              {contacts?.map((c) => {
                const text = contactText(c, model?.durationS ?? 0);
                const cx = axisOf(c.t);
                return (
                  <button
                    key={c.id}
                    type="button"
                    className="cad-tl-contact"
                    data-contact={c.status}
                    style={{ left: pct(cx) }}
                    aria-label={text}
                    data-tooltip={`${text}${c.label ? ` (${c.label})` : ""}${c.keyframes && c.keyframes > 1 ? ` · seen at ${c.keyframes} keyframes` : ""}`}
                    data-tooltip-side="top"
                    tabIndex={-1}
                    onClick={() => seek(cx)}
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                      {c.status === "interference" ? (
                        <>
                          <path d="M4.1 0.5h5.8l3.6 3.6v5.8l-3.6 3.6H4.1L0.5 9.9V4.1z" fill="currentColor" />
                          <path d="M4.6 4.6l4.8 4.8M9.4 4.6l-4.8 4.8" stroke="var(--uhd-surface)" strokeWidth="1.6" strokeLinecap="round" />
                        </>
                      ) : (
                        <circle cx="7" cy="7" r="5.2" fill="var(--uhd-surface)" stroke="currentColor" strokeWidth="2" />
                      )}
                    </svg>
                  </button>
                );
              })}
              {noteAt &&
                (() => {
                  // wave R3 gate: the note ends before the next marker on its side (clipped with an ellipsis; the
                  // whole sentence is each marker's tooltip), so a long label no longer covers the markers after it
                  const at = axisOf(noteAt.t);
                  const right = at < 0.62;
                  const others = (contacts ?? []).map((c) => axisOf(c.t)).filter((v) => (right ? v > at + 1e-6 : v < at - 1e-6));
                  const room = right ? (others.length ? Math.min(...others) : 1) - at : at - (others.length ? Math.max(...others) : 0);
                  const text = contactText(noteAt, model?.durationS ?? 0);
                  // DEFAULT: under 3 % of the lane there is no room for words; the markers' tooltips say it
                  if (room < 0.03) return null;
                  return (
                    <span className="cad-tl-note cad-tl-contact-note" style={{ ...(right ? { left: `calc(${pct(at)} + 12px)` } : { right: `calc(${pct(1 - at)} + 12px)` }), maxWidth: `max(0px, calc(${pct(room)} - 24px))` }}>
                      {text}
                    </span>
                  );
                })()}
            </div>
          </div>
          <div className="cad-tl-overlay" ref={overlay}>
            <div className="cad-tl-playhead" data-timeline="playhead" style={{ left: pct(x) }} />
          </div>
        </div>
      )}
    </section>
  );
}
