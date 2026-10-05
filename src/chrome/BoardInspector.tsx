/**
 * Inspector sections for boards (PB-823): a component's package facts and pin
 * table, a net's members, the functional links UHD derives over the nets (by
 * name), and the board's standard-output drawings (PCB top and bottom,
 * schematic) with pan and zoom, where a selected component is marked and a
 * click on a component selects it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ArtifactDef, InterfaceDef, ModuleDef } from "@uhd/types/index.js";
import type { GeometryManifest } from "@uhd/system/geometry.js";
import { partPackage } from "@uhd/protocols/package.js";
import type { ViewDerived, ViewModel, ViewNode } from "../model/types";
import { circuitOutputs, drawingFits, footprintAt, footprints, parsePnp, toDrawing, type Footprint, type PnpRow } from "../model/outputs";
import type { ArtifactResolver } from "../api";
import type { Selection } from "../canvas/Canvas";
import { Icon } from "../canvas/Icon";
import { ArtifactLink } from "./Artifacts";

const STATE_LABEL: Record<string, string> = { configured: "CONFIGURED", partial: "PARTIAL", incompatible: "INCOMPATIBLE", unconfigured: "NOT CONFIGURED" };

function Row({ k, v }: { k: string; v?: string }) {
  if (!v) return null;
  return (
    <div className="kv">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  );
}

const mm = (n?: number) => (n === undefined ? "" : `${+n.toFixed(2)}`);

/** A part's package as the manufacturer states it (UHD `partPackage`), with its body size. */
export function PackageSection({ def }: { def?: ModuleDef }) {
  const pkg = def ? partPackage(def) : undefined;
  if (!pkg) return null;
  const s = pkg.size_mm;
  return (
    <>
      <div className="section-title">PACKAGE</div>
      <div className="facts package-facts">
        <Row k="NAME" v={pkg.name} />
        <Row k="CODE" v={pkg.code} />
        <Row k="PINS" v={`${pkg.pin_count}${pkg.exposed_pad ? ` + exposed pad${pkg.exposed_pad_pin !== undefined ? ` (${pkg.exposed_pad_pin})` : ""}` : ""}`} />
        <Row k="PITCH" v={pkg.pitch_mm !== undefined ? `${pkg.pitch_mm} mm` : undefined} />
        <Row k="EXPOSED PAD" v={pkg.exposed_pad_mm ? `${mm(pkg.exposed_pad_mm[0])} × ${mm(pkg.exposed_pad_mm[1])} mm` : undefined} />
        <Row k="BODY" v={s ? `${[s.length, s.width, s.height].map(mm).filter(Boolean).join(" × ")} mm` : undefined} />
        {pkg.source && <p className="note">{pkg.source}</p>}
        {pkg.assumption && (
          <p className="note">
            <b>assumed</b> — {pkg.assumption}
          </p>
        )}
      </div>
    </>
  );
}

const pinOrder = (a: InterfaceDef, b: InterfaceDef) => {
  const [x, y] = [String(a.pin), String(b.pin)];
  const [nx, ny] = [Number(x), Number(y)];
  if (Number.isFinite(nx) && Number.isFinite(ny)) return nx - ny;
  if (Number.isFinite(nx)) return -1;
  if (Number.isFinite(ny)) return 1;
  return x.localeCompare(y);
};

/** What a pin is, from its protocols: what a datasheet's pin table calls its type. */
function pinType(i: InterfaceDef): string {
  const p = i.protocols[0];
  if (!p) return "";
  if (p.type === "power") return p.roles.includes("ground") ? "GND" : p.roles.includes("output") ? "PWR OUT" : "PWR IN";
  if (p.type === "passive") return "PASSIVE";
  if (p.roles.includes("no_connect")) return "NC";
  if (p.type === "digital") return p.roles.includes("bidirectional") ? "I/O" : p.roles.includes("output") ? "OUT" : "IN";
  if (p.type === "analog") return p.roles.includes("output") ? "ANALOG OUT" : "ANALOG IN";
  return p.type.toUpperCase();
}

/**
 * Every pin with a designator, in package order, with the net it is on at
 * this level (from the grouped membership lines of `node`).
 */
export function PinTable({ def, node, vm }: { def?: ModuleDef; node: ViewNode; vm: ViewModel }) {
  const pins = useMemo(() => (def?.interfaces ?? []).filter((i) => i.pin !== undefined).sort(pinOrder), [def]);
  const netOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of vm.links) if (l.net && l.source.node === node.id) for (const c of l.children) m.set(c.a, l.net.name);
    return m;
  }, [vm, node]);
  if (!pins.length) return null;
  return (
    <>
      <div className="section-title">
        PINS · {pins.length}
        {netOf.size > 0 && <span className="muted"> · {netOf.size} ON NETS</span>}
      </div>
      <div className="pin-table-wrap">
        <table className="child-table pin-table">
          <thead>
            <tr>
              <th>PIN</th>
              <th>NAME</th>
              <th>TYPE</th>
              <th>NET</th>
            </tr>
          </thead>
          <tbody>
            {pins.map((p) => (
              <tr key={p.id} className={netOf.has(p.id) ? "on-net" : ""}>
                <td>{String(p.pin)}</td>
                <td>{p.name ?? p.id}</td>
                <td className="muted">{pinType(p)}</td>
                <td>{netOf.get(p.id) ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Functional links derived over nets, listed by name. */
export function DerivedList({ items, title, onSelect }: { items: ViewDerived[]; title: string; onSelect: (s: Selection) => void }) {
  if (!items.length) return null;
  return (
    <>
      <div className="section-title">
        {title} · {items.length}
      </div>
      {items.map((d) => (
        <button key={d.id} className="tree-item" onClick={() => onSelect({ kind: "link", id: d.id })} title={d.diagnostics.join("\n")}>
          <span className={`state-dot ${d.state}`} />
          <span>{d.name.toUpperCase()}</span>
          <span className="tree-tag">{d.protocol}</span>
        </button>
      ))}
    </>
  );
}

/** A net: its voltage, its members and their pins, and the links derived over it. */
export function NetDetails({ node, vm, onSelect }: { node: ViewNode; vm: ViewModel; onSelect: (s: Selection) => void }) {
  const net = node.net!;
  const lines = vm.links.filter((l) => l.net && l.target.node === node.id);
  return (
    <div className="details">
      <div className="details-title">
        <Icon name={node.icon} size={16} />
        <span>{node.label}</span>
        <span className="tree-tag">NET</span>
      </div>
      <Row k="VOLTAGE" v={net.voltage ?? (net.ground ? "0 V (ground)" : "not stated")} />
      <Row k="CARRIES" v={net.signal.toUpperCase()} />
      <Row k="PINS" v={String(net.pins)} />
      <Row k="STATE" v={STATE_LABEL[node.status]} />
      <Row k="PATH" v={node.id} />
      <div className="section-title">MEMBERS · {lines.length}</div>
      {lines.map((l) => (
        <button key={l.id} className="tree-item member" onClick={() => onSelect({ kind: "node", id: l.source.node })}>
          <span className={`state-dot ${l.state}`} />
          <span>{vm.nodes.find((n) => n.id === l.source.node)?.label ?? l.source.node}</span>
          <span className="tree-tag">{l.children.map((c) => (c.aPin ? `${c.aPin} ${c.label}` : c.label)).join(" · ")}</span>
        </button>
      ))}
      <DerivedList items={vm.derived.filter((d) => d.nets.includes(node.id))} title="FUNCTIONAL LINKS OVER THIS NET" onSelect={onSelect} />
    </div>
  );
}

/** A link derived over nets, shown by name: its ends, nets, conductors and findings. */
export function DerivedDetails({ d, vm, onSelect }: { d: ViewDerived; vm: ViewModel; onSelect: (s: Selection) => void }) {
  const label = (id: string) => vm.nodes.find((n) => n.id === id)?.label ?? id;
  return (
    <div className="details">
      <div className="details-title">
        <Icon name="git-merge" size={16} />
        <span>{d.name.toUpperCase()}</span>
      </div>
      <Row k="PROTOCOL" v={d.protocol} />
      <Row k="STATE" v={STATE_LABEL[d.state]} />
      <Row k="DERIVED" v="over board nets (not stored)" />
      <div className="section-title">ENDS</div>
      {[d.a, d.b].map((e, i) => (
        <button key={i} className="tree-item" onClick={() => onSelect({ kind: "node", id: e.node })}>
          <Icon name="cpu" size={12} />
          <span>{label(e.node)}</span>
          <span className="tree-tag">{e.iface}</span>
        </button>
      ))}
      <div className="section-title">NETS · {d.nets.length}</div>
      <div className="artifact-parts">
        {d.nets.map((n) => (
          <button key={n} className="mini" onClick={() => onSelect({ kind: "node", id: n })}>
            {label(n)}
          </button>
        ))}
      </div>
      {d.children.length > 0 && (
        <>
          <div className="section-title">CONDUCTORS · {d.children.length}</div>
          <table className="child-table">
            <tbody>
              {d.children.map((c, i) => (
                <tr key={i}>
                  <td>{c.a.toUpperCase()}</td>
                  <td className="muted">{c.aPin ?? ""}</td>
                  <td>→</td>
                  <td>{c.b.toUpperCase()}</td>
                  <td className="muted">{c.bPin ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {d.diagnostics.length > 0 && (
        <>
          <div className="section-title">DIAGNOSTICS</div>
          {d.diagnostics.map((m) => (
            <p key={m} className={`diagnostic ${d.state}`}>
              {m}
            </p>
          ))}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Board drawings
// ---------------------------------------------------------------------------

type Tab = "top" | "bottom" | "schematic";

const TABS: { id: Tab; label: string }[] = [
  { id: "top", label: "PCB TOP" },
  { id: "bottom", label: "PCB BOTTOM" },
  { id: "schematic", label: "SCHEMATIC" },
];

const urlOf = (def: ModuleDef, a: ArtifactDef | undefined, resolve: ArtifactResolver) => (a ? (a.url ?? (a.filePath ? resolve(def.id, a.filePath) : undefined)) : undefined);

/** The pick-and-place rows and geometry manifest of a board, fetched once per board. */
function usePlacement(def: ModuleDef, resolve: ArtifactResolver) {
  const outs = circuitOutputs(def);
  const pnpUrl = urlOf(def, outs?.pnp, resolve);
  const manifestUrl = urlOf(def, outs?.manifest, resolve);
  const [data, setData] = useState<{ pnp: PnpRow[]; manifest?: GeometryManifest } | null>(null);
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      pnpUrl ? fetch(pnpUrl).then((r) => (r.ok ? r.text() : "")).catch(() => "") : Promise.resolve(""),
      manifestUrl ? fetch(manifestUrl).then((r) => (r.ok ? r.json() : undefined)).catch(() => undefined) : Promise.resolve(undefined),
    ]).then(([pnp, manifest]) => !cancelled && setData({ pnp: parsePnp(pnp), manifest }));
    return () => {
      cancelled = true;
    };
  }, [pnpUrl, manifestUrl]);
  return data;
}

/**
 * The board's drawings, one tab each. `highlight` is a component instance
 * (relative to the board) to mark; `onPick` receives the component clicked.
 */
export function BoardViews({
  def,
  lookup,
  resolve,
  highlight,
  onPick,
}: {
  def: ModuleDef;
  lookup: (id: string) => ModuleDef | undefined;
  resolve: ArtifactResolver;
  highlight?: string;
  onPick?: (instance: string) => void;
}) {
  const outs = circuitOutputs(def);
  const placement = usePlacement(def, resolve);
  const fps = useMemo(() => (placement ? footprints(def, lookup, placement.pnp, placement.manifest) : []), [def, lookup, placement]);
  const tabs = TABS.filter((t) => outs?.[t.id]);
  const marked = fps.find((f) => f.instance === highlight);
  const [tab, setTab] = useState<Tab | undefined>(undefined);
  // follow the highlighted component to the side it is on, until a tab is chosen by hand
  const current = tab ?? (marked?.side && outs?.[marked.side] ? marked.side : tabs[0]?.id);
  if (!outs || !tabs.length || !current) return null;
  const files = [outs.bom, outs.pnp, outs.netlist, outs.manifest, outs.glb].filter((a): a is ArtifactDef => Boolean(a));
  const sample = [outs.top, outs.bottom, outs.schematic, ...files].some((a) => a?.tags?.includes("sample"));
  return (
    <>
      <div className="section-title">
        <span>
          BOARD OUTPUTS
          {sample && <span className="sample-tag">SAMPLE</span>}
        </span>
      </div>
      <div className="artifact-parts board-tabs">
        {tabs.map((t) => (
          <button key={t.id} className={`mini${t.id === current ? " on" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <Drawing
        key={current}
        url={urlOf(def, outs[current], resolve)}
        side={current === "schematic" ? undefined : current}
        fps={fps}
        highlight={highlight}
        onPick={onPick}
      />
      {files.length > 0 && (
        <div className="artifact-files">
          {files.map((a) => (
            <ArtifactLink key={a.id} defId={def.id} artifactId={a.id} href={urlOf(def, a, resolve)} title={a.filePath ?? a.url}>
              <Icon name={/csv|json/.test(a.format ?? "") ? "file-text" : "box"} size={11} />
              <span className="artifact-name">{(a.filePath ?? a.url ?? a.name).split("/").pop()}</span>
              <span className="artifact-format">{(a.format ?? a.type).toUpperCase()}</span>
            </ArtifactLink>
          ))}
        </div>
      )}
    </>
  );
}

/** viewBox of an SVG document, or its width × height. */
function viewBoxOf(text: string): [number, number, number, number] | undefined {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const svg = doc.documentElement;
  const vb = svg.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  if (vb?.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) return vb as [number, number, number, number];
  const w = parseFloat(svg.getAttribute("width") ?? "");
  const h = parseFloat(svg.getAttribute("height") ?? "");
  return w > 0 && h > 0 ? [0, 0, w, h] : undefined;
}

/**
 * One drawing with pan and zoom. The SVG is shown as an image (its own
 * markup never enters the page); a second SVG with the same viewBox lies on
 * top for the marks and the clicks.
 */
function Drawing({ url, side, fps, highlight, onPick }: { url?: string; side?: "top" | "bottom"; fps: Footprint[]; highlight?: string; onPick?: (instance: string) => void }) {
  const [vb, setVb] = useState<[number, number, number, number] | null | undefined>(undefined);
  const [view, setView] = useState({ s: 1, x: 0, y: 0 });
  const [hover, setHover] = useState<string | undefined>(undefined);
  const host = useRef<HTMLDivElement>(null);
  const overlay = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  useEffect(() => {
    let cancelled = false;
    setVb(undefined);
    if (!url) return;
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => !cancelled && setVb(viewBoxOf(t) ?? null))
      .catch(() => !cancelled && setVb(null));
    return () => {
      cancelled = true;
    };
  }, [url]);
  const fits = Boolean(side && vb && drawingFits(vb, side, fps));
  const marked = fits && side ? fps.find((f) => f.instance === highlight && f.side === side) : undefined;

  // bring a newly marked component into view (the stage maps drawing units as the image does: centred, contained)
  useEffect(() => {
    const el = host.current;
    if (!marked || !vb || !el || !side) return;
    const [W, H] = [el.clientWidth, el.clientHeight];
    const scale = Math.min(W / vb[2], H / vb[3]);
    const [dx, dy] = toDrawing(side, marked.x, marked.y);
    const mx = (W - vb[2] * scale) / 2 + (dx - vb[0]) * scale;
    const my = (H - vb[3] * scale) / 2 + (dy - vb[1]) * scale;
    setView((v) => {
      const s = Math.max(v.s, 1.6);
      return { s, x: W / 2 - mx * s, y: H / 2 - my * s };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marked?.instance, vb]);

  // wheel zoom about the pointer; a native non-passive listener, so the inspector does not scroll as well
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const cx = e.clientX - r.left;
      const cy = e.clientY - r.top;
      const k = Math.exp(-e.deltaY * 0.0015);
      setView((v) => {
        const s = Math.min(24, Math.max(0.5, v.s * k));
        const f = s / v.s;
        return { s, x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [url]);

  const toDrawingPoint = (e: { clientX: number; clientY: number }) => {
    const svg = overlay.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return undefined;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return [p.x, p.y] as [number, number];
  };
  const pickAt = (e: { clientX: number; clientY: number }) => {
    if (!fits || !side) return undefined;
    const p = toDrawingPoint(e);
    return p ? footprintAt(side, fps, p[0], p[1]) : undefined;
  };

  if (!url) return null;
  return (
    <div className="board-drawing">
      <div
        ref={host}
        className="board-drawing-view"
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
          (e.target as Element).setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) {
            if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 3) d.moved = true;
            if (d.moved) setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
          } else setHover(pickAt(e)?.instance);
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (d && !d.moved) {
            const hit = pickAt(e);
            if (hit) onPick?.(hit.instance);
          }
        }}
        onPointerLeave={() => setHover(undefined)}
        onDoubleClick={() => setView({ s: 1, x: 0, y: 0 })}
      >
        <div className="board-drawing-stage" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }}>
          <img src={url} alt="" draggable={false} />
          {vb && (
            <svg ref={overlay} viewBox={vb.join(" ")} className="board-drawing-marks">
              {fits &&
                side &&
                fps
                  .filter((f) => f.side === side)
                  .map((f) => {
                    const [x, y] = toDrawing(side, f.x, f.y);
                    const on = f.instance === highlight;
                    const pad = Math.max(0.25, Math.min(f.w, f.h) * 0.15);
                    return (
                      <rect
                        key={f.instance}
                        className={`mark${on ? " on" : ""}${f.instance === hover ? " hover" : ""}`}
                        x={x - f.w / 2 - pad}
                        y={y - f.h / 2 - pad}
                        width={f.w + 2 * pad}
                        height={f.h + 2 * pad}
                        vectorEffect="non-scaling-stroke"
                      />
                    );
                  })}
            </svg>
          )}
        </div>
      </div>
      <div className="artifact-cad-hint">
        {vb === undefined
          ? "LOADING DRAWING…"
          : vb === null
            ? "DRAWING NOT FOUND"
            : side && !fits
              ? "NOT IN BOARD MILLIMETRES · NO MARKS"
              : `SCROLL TO ZOOM · DRAG TO PAN${side && onPick ? " · CLICK A PART" : ""}${hover ? ` · ${hover.toUpperCase()}` : ""}`}
      </div>
    </div>
  );
}
