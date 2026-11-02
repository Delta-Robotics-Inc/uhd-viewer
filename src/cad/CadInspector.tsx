/**
 * The 3D view's inspector card: the selected module's interfaces and their
 * geometry bindings, a harness, a mate or a route, else the assembly's
 * placements, findings and what is not placed. (Split out of CadView.tsx,
 * PB-1178; it reads the selection and writes it back through `onSel`.)
 */
import { useMemo } from "react";
import type { GeometryFrame, ModuleDef } from "@uhd/types/index.js";
import type { LoadedSource } from "../source/source";
import { cadOutputs, circuitOutputs } from "../model/outputs";
import { isNet } from "@uhd/protocols/net.js";
import type { FindingAnchor } from "./findings";
import { DIRECTIONS, interfaceRows, type BindingStatus, type CadBody, type CadModel, type Direction, type InterfaceRow } from "./model";
import { Icon } from "../canvas/Icon";
import { ScrollArea } from "../ui/ScrollArea";
import { ArtifactLink } from "../chrome/Artifacts";
import { cableSummary, cableTrait, routeManifest } from "./harness";
import type { CadSelection } from "./CadView";
import { instancePathIn } from "./render/ids";

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<BindingStatus, string> = {
  bound: "bound",
  stale: "stale",
  missing: "missing",
  unchecked: "unchecked",
  none: "—",
};

function Chips({ row }: { row: InterfaceRow }) {
  if (row.logical) return <span className="gchip logical">LOGICAL</span>;
  if (row.unmapped) return <span className="gchip unmapped">UNMAPPED</span>;
  return (
    <span className="gchips">
      {row.frame ? <span className="gchip ok" title="Has a mating frame">FRAME</span> : row.sources.some((s) => s !== row.iface.id) ? <span className="gchip via" title="Resolved through its children">VIA {row.sources.length}</span> : null}
      {DIRECTIONS.map((d) => {
        const list = row.byDirection[d.id];
        const status: BindingStatus = !list.length ? "none" : list.some((x) => x.status === "stale") ? "stale" : list.some((x) => x.status === "missing") ? "missing" : list.every((x) => x.status === "unchecked") ? "unchecked" : "bound";
        return (
          <span key={d.id} className={`gchip ${status}`} title={`${d.label}: ${STATUS_LABEL[status]}`}>
            {d.label.split(" ")[0]}
          </span>
        );
      })}
    </span>
  );
}

const fmtV = (v?: number[]) => (v ? `[${v.map((x) => +x.toFixed(2)).join(", ")}]` : "—");

function FrameTable({ frame }: { frame: GeometryFrame }) {
  return (
    <div className="kv-grid">
      {frame.artifact && (
        <>
          <span className="k">body</span>
          <span className="v">{frame.artifact}</span>
        </>
      )}
      <span className="k">origin</span>
      <span className="v">{fmtV(frame.origin)}</span>
      <span className="k">normal</span>
      <span className="v">{fmtV(frame.normal)}</span>
      <span className="k">xAxis</span>
      <span className="v">{fmtV(frame.xAxis)}</span>
      <span className="k">symmetry</span>
      <span className="v">{frame.symmetryDeg ? `${frame.symmetryDeg}°` : "none"}</span>
    </div>
  );
}

export function CadInspector({
  model,
  sel,
  onSel,
  direction,
  findings,
  resolve,
  callout,
}: {
  model: CadModel;
  sel: CadSelection;
  onSel: (s: CadSelection) => void;
  direction: Direction;
  findings: FindingAnchor[];
  resolve: LoadedSource["resolveArtifact"];
  /**
   * "Callout" (PB-1184): ring and label the selected part (refdes, MPN, LCSC from the model), as records in the
   * view state written by the person; `on` when this part already has one (the button then removes it).
   */
  callout?: { on: boolean; toggle: () => void; what: string };
}) {
  const body = model.bodies.find((b) => b.key === sel.body);
  // a board's nets are its conductors, drawn by its body and shown in the diagram: not interface geometry
  const rows = useMemo(() => (body ? interfaceRows(body.def, model.manifests).filter((r) => !isNet(r.iface)) : []), [body, model]);
  const row = rows.find((r) => r.iface.id === sel.iface);
  const mate = sel.mate ? model.assembly.mates.find((m) => m.linkId === sel.mate) : undefined;
  const route = sel.mate ? model.assembly.routes.find((m) => m.linkId === sel.mate) : undefined;
  const harness = sel.harness ? model.assembly.harnesses.find((h) => h.key === sel.harness) : undefined;
  const hm = harness && routeManifest(model, harness);
  const nameOf = (path: string[]) => {
    const def = model.defs.get(path.join("/"));
    return def?.name ?? path.join("/");
  };
  // links inside a body that draws its components (a board's nets) are the board design's, not wires to route
  const holders = [...new Set(model.within.values())];
  const unrouted = model.assembly.unrouted.filter((u) => !holders.some((h) => !h || u.linkId.startsWith(`${h}/`)));

  return (
    <aside className="inspector cad-inspector" data-chrome="inspector">
      <div className="inspector-header">
        <span className="section-title">{body && sel.component ? "COMPONENT" : body ? "MODULE" : harness ? "HARNESS" : mate || route ? "LINK" : "ASSEMBLY"}</span>
        {callout && (
          <button className="mini" aria-pressed={callout.on} title={callout.on ? `Remove the callout on ${callout.what}` : `Ring and label ${callout.what} (MPN, LCSC)`} onClick={callout.toggle}>
            CALLOUT
          </button>
        )}
        {(body || mate || route || harness) && (
          <button className="mini" onClick={() => onSel({})}>
            ASSEMBLY
          </button>
        )}
      </div>
      <ScrollArea className="inspector-scroll" contentClassName="inspector-body">
        {body && sel.component && (
          // R1-A (M2): a picked component is what the card shows; its board stays below as its context
          <div className="cad-component" data-component={sel.component}>
            <h3 className="cad-title">{model.defs.get(instancePathIn(body.path.join("/"), sel.component))?.name ?? sel.component.split("/").pop()}</h3>
            <div className="cad-sub">{instancePathIn(body.path.join("/"), sel.component).split("/").join(" / ")}</div>
            <div className="cad-sub">
              in <button className="linklike" onClick={() => onSel({ body: body.key })}>{body.def.name}</button>
            </div>
          </div>
        )}
        {body ? (
          <>
            <h3 className="cad-title">{body.def.name}</h3>
            <div className="cad-sub">
              {body.path.join(" / ") || "the bundle's root"}
              {body.key.includes("#") ? ` · body ${body.key.split("#")[1]}` : ""}
            </div>
            <div className="cad-sub">
              {body.via ? (
                <>
                  placed by link <button className="linklike" onClick={() => onSel({ mate: body.via })}>{body.via}</button>
                </>
              ) : body.hint ? (
                body.hint
              ) : (
                "assembly root"
              )}
            </div>
            <div className="section-title">INTERFACES · GEOMETRY</div>
            <div className="cad-rows">
              {rows.map((r) => (
                <button key={r.iface.id} className={`cad-row${r.iface.id === sel.iface ? " on" : ""}`} onClick={() => onSel({ body: body.key, iface: r.iface.id })}>
                  <span className="cad-row-name">{r.iface.id}</span>
                  <Chips row={r} />
                </button>
              ))}
            </div>
            {row && <InterfaceDetails row={row} direction={direction} />}
            <BodyContents model={model} body={body} sel={sel} onSel={onSel} resolve={resolve} />
            <div className="section-title">ARTIFACTS</div>
            <div className="cad-artifacts">
              {(body.def.artifacts ?? [])
                .filter((a) => a.role)
                .map((a) => (
                  <div key={a.id} className="cad-artifact" title={a.filePath ?? a.url}>
                    <span className={`gchip role-${a.role}`}>{a.role?.toUpperCase()}</span>
                    <span className="cad-artifact-name">{a.id}</span>
                    <span className="cad-artifact-fmt">{a.format}</span>
                    {a.interfaceId && <span className="cad-artifact-if">→ {a.interfaceId}</span>}
                  </div>
                ))}
            </div>
          </>
        ) : harness ? (
          <>
            <h3 className="cad-title">{harness.def.name}</h3>
            <div className="cad-sub">{harness.key} · placed by link {harness.via}</div>
            <div className="kv-grid">
              <span className="k">cable</span>
              <span className="v">{cableSummary(harness, hm)}</span>
              {hm && (
                <>
                  <span className="k">routed</span>
                  <span className="v">
                    {hm.route_length_mm} mm · {hm.length_fit.method ?? "shortest"}
                    {hm.length_fit.slack_mm && hm.length_fit.slack_mm > 0.5 ? ` (${hm.length_fit.slack_mm} mm slack)` : ""}
                  </span>
                  <span className="k">bend</span>
                  <span className="v">
                    min {hm.bend_radius_mm.centreline} mm (target {hm.bend_radius_mm.target})
                  </span>
                  <span className="k">clearance</span>
                  <span className="v">{hm.clearance_mm.min_conductor_surface ?? "—"} mm</span>
                </>
              )}
            </div>
            <div className="section-title">ENDS</div>
            {harness.ends.map((e) => (
              <div key={e.interfaceId} className="cad-row">
                <span className="cad-row-name">
                  {e.interfaceId} → {e.counterpart}
                </span>
                <span className={`gchip ${e.status === "stale" ? "stale" : e.status === "matches" || e.status === "anchor" ? "bound" : "unchecked"}`}>{e.status.toUpperCase()}</span>
              </div>
            ))}
            {hm?.notes.map((n, i) => (
              <div key={i} className="cad-issue warning">
                {n}
              </div>
            ))}
            <div className="section-title">ARTIFACTS</div>
            <div className="cad-artifacts">
              {(harness.def.artifacts ?? [])
                .filter((a) => a.role)
                .map((a) => (
                  <div key={a.id} className="cad-artifact" title={a.filePath ?? a.url}>
                    <span className={`gchip role-${a.role}`}>{a.role?.toUpperCase()}</span>
                    <span className="cad-artifact-name">{a.id}</span>
                    <span className="cad-artifact-fmt">{a.format}</span>
                  </div>
                ))}
            </div>
          </>
        ) : mate ? (
          <>
            <h3 className="cad-title">{mate.linkId}</h3>
            <div className="cad-sub">rigid mate{mate.harness ? ` · harness ${mate.harness}` : ""}</div>
            {[mate.a, mate.b].map((end, i) => (
              <div key={i} className="cad-end">
                <button className="linklike" onClick={() => onSel({ body: end.path.join("/") + (end.frame.artifact ? `#${end.frame.artifact}` : ""), iface: end.iface.id, mate: mate.linkId })}>
                  {end.path.join("/")}.{end.iface.id}
                </button>
                <FrameTable frame={end.frame} />
              </div>
            ))}
            <div className="kv-grid">
              <span className="k">gap</span>
              <span className="v">{mate.mate?.gapMm ?? 0} mm</span>
              <span className="k">rotation</span>
              <span className="v">{mate.mate?.rotationDeg ?? 0}°</span>
            </div>
          </>
        ) : route ? (
          <>
            <h3 className="cad-title">{route.linkId}</h3>
            <div className="cad-sub">wire route: {route.a.frames.length} → {route.b.frames.length} frame(s)</div>
            <div className="cad-sub">
              {route.a.path.join("/")}.{route.a.iface.id} ({route.a.frames.map((f) => f.interfaceId).join(", ")}) → {route.b.path.join("/")}.{route.b.iface.id} (
              {route.b.frames.map((f) => f.interfaceId).join(", ")})
            </div>
          </>
        ) : (
          <>
            <div className="section-title">PLACED FROM LINKS · {model.assembly.placements.length}</div>
            <div className="cad-rows">
              {model.bodies.map((b) => (
                <button key={b.key} className="cad-row" onClick={() => onSel({ body: b.key })}>
                  <span className="cad-row-name">{b.key || b.def.name}</span>
                  <span className="cad-row-via">{b.via ?? (b.hint ? "hint" : "root")}</span>
                </button>
              ))}
            </div>
            {findings.length > 0 && (
              <>
                <div className="section-title">FINDINGS ON THE MODEL · {findings.length}</div>
                {findings.map((f) => (
                  <button key={f.id} className={`cad-finding ${f.severity}`} onClick={() => onSel(f.select)}>
                    <Icon name={f.severity === "error" ? "octagon-x" : "triangle-alert"} size={13} />
                    <span>
                      <b>{f.title}</b>
                      {f.message}
                    </span>
                  </button>
                ))}
              </>
            )}
            <div className="section-title">NOT PLACED</div>
            {model.within.size > 0 && (
              <div className="cad-issue">
                {model.within.size} components are drawn in their board's own body ({[...new Set(model.within.values())].map((k) => model.bodies.find((b) => b.key === k)?.def.name ?? (k || "root")).join(", ")}), not placed one by one.
              </div>
            )}
            {model.assembly.issues
              .filter((i) => i.severity === "info" && !model.bodies.some((b) => b.key === i.subject) && !model.within.has(i.subject))
              .map((i) => (
                <div key={i.subject} className="cad-issue">
                  <b>{nameOf(i.subject.split("/"))}</b> — {i.message}
                </div>
              ))}
            {model.assembly.issues
              .filter((i) => i.severity !== "info")
              .map((i) => (
                <div key={i.subject + i.message} className={`cad-issue ${i.severity}`}>
                  <b>{i.subject}</b> — {i.message}
                </div>
              ))}
            <div className="section-title">HARNESSES · {model.assembly.harnesses.length} ROUTED</div>
            {model.assembly.harnesses.map((hp) => (
              <button key={hp.key} className="cad-row" onClick={() => onSel({ harness: hp.key })}>
                <span className="cad-row-name">{hp.key}</span>
                <span className="cad-row-via">{hp.ends.some((e) => e.status === "stale") ? "stale" : cableTrait(hp).length_mm ? `${cableTrait(hp).length_mm} mm` : ""}</span>
              </button>
            ))}
            {model.assembly.routes.length > 0 && <div className="section-title">DIRECT WIRES · {model.assembly.routes.length}</div>}
            {model.assembly.routes.map((r) => (
              <button key={r.linkId} className="cad-row" onClick={() => onSel({ mate: r.linkId })}>
                <span className="cad-row-name">{r.linkId}</span>
                <span className="cad-row-via">
                  {r.a.frames.length}→{r.b.frames.length}
                </span>
              </button>
            ))}
            {unrouted.length > 0 && (
              <>
                <div className="section-title">UNROUTED · {unrouted.length}</div>
                <div className="cad-issue">
                  No geometry on {[...new Set(unrouted.flatMap((u) => u.missing))].slice(0, 8).join(", ")}
                  {unrouted.length > 8 ? " …" : ""}
                </div>
              </>
            )}
          </>
        )}
      </ScrollArea>
    </aside>
  );
}

/**
 * What a body holds besides its interfaces: the components a board's body
 * draws (named by instance path in its manifest), the named bodies of a
 * multi-body artifact (an enclosure's back and lid), and the manufacturing
 * exports of a cad output.
 */
function BodyContents({ model, body, sel, onSel, resolve }: { model: CadModel; body: CadBody; sel: CadSelection; onSel: (s: CadSelection) => void; resolve: LoadedSource["resolveArtifact"] }) {
  const manifest = model.manifests.get(`${body.def.id}:${body.bodyArtifact}`);
  const components = (body.def.children ?? []).filter((c) => manifest?.features[c.id]);
  const named = Object.entries(manifest?.bodies ?? {});
  const cad = cadOutputs(body.def);
  const circuit = circuitOutputs(body.def);
  return (
    <>
      {components.length > 0 && (
        <>
          <div className="section-title">COMPONENTS · {components.length}</div>
          <div className="cad-rows">
            {components.map((c) => (
              // R1-A (M2): the component by its instance path (the host and the 3D pick name it so), not its bare id
              <button key={c.id} className={`cad-row${sel.component === c.id || sel.component === instancePathIn(body.key.split("#")[0], c.id) ? " on" : ""}`} onClick={() => onSel({ body: body.key, component: instancePathIn(body.key.split("#")[0], c.id) })}>
                <span className="cad-row-name">{c.id}</span>
                <span className="cad-row-via">{c.name ?? c.moduleDefId}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {named.length > 1 && (
        <>
          <div className="section-title">BODIES · {named.length}</div>
          <div className="kv-grid">
            {named.map(([n, v]) => (
              <span key={n} style={{ display: "contents" }}>
                <span className="k">{n}</span>
                <span className="v">{Math.round(v).toLocaleString()} mm³</span>
              </span>
            ))}
          </div>
          <div className="cad-sub">Exploding separates them along the line between their centres.</div>
        </>
      )}
      {cad && cad.exports.length > 0 && (
        <>
          <div className="section-title">MANUFACTURING EXPORTS · {cad.exports.length}</div>
          <div className="artifact-files">
            {cad.exports.map((a) => (
              <ArtifactLink key={a.id} defId={body.def.id} artifactId={a.id} href={a.url ?? (a.filePath ? resolve(body.def.id, a.filePath) : undefined)}>
                <Icon name="printer" size={11} />
                <span className="artifact-name">{(a.filePath ?? a.name).split("/").pop()}</span>
                <span className="artifact-format">{(a.format ?? "").toUpperCase()}</span>
              </ArtifactLink>
            ))}
          </div>
        </>
      )}
      {circuit && <div className="cad-sub">Board drawings, BOM and pick-and-place: select the board in the diagram.</div>}
    </>
  );
}

function InterfaceDetails({ row, direction }: { row: InterfaceRow; direction: Direction }) {
  return (
    <div className="cad-detail">
      <div className="section-title">{row.iface.id.toUpperCase()}</div>
      {row.frame ? <FrameTable frame={row.frame} /> : row.sources.length > 0 && <div className="cad-sub">frames from {row.sources.join(", ")}</div>}
      {row.unmapped && <div className="cad-sub">No frame and no geometry reference, on the interface or its children.</div>}
      {DIRECTIONS.map((d) => (
        <div key={d.id} className={`cad-dir${d.id === direction ? " on" : ""}`}>
          <span className="cad-dir-label">{d.label}</span>
          {row.byDirection[d.id].length === 0 ? (
            <span className="cad-dir-none">—</span>
          ) : (
            row.byDirection[d.id].map((r, i) => (
              <div key={i} className="cad-ref">
                <span className={`gchip ${r.status}`}>{r.status.toUpperCase()}</span>
                <code>
                  {r.ref.kind === "feature" ? `${r.ref.artifact} › ${r.ref.name}` : r.ref.kind === "artifact" ? r.ref.artifact : `${r.ref.generator}()`}
                </code>
                {r.ref.kind !== "procedural" && r.ref.signature && (
                  <span className="cad-sig">
                    {r.ref.signature.area_mm2.toFixed(1)} mm² @ {fmtV(r.ref.signature.centroid)}
                  </span>
                )}
                {r.note && <span className="cad-sig">{r.note}</span>}
              </div>
            ))
          )}
        </div>
      ))}
      {row.issues.map((i, k) => (
        <div key={k} className={`cad-issue ${i.severity}`}>
          {i.message}
        </div>
      ))}
    </div>
  );
}
