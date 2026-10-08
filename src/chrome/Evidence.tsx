/**
 * Evidence for a part, in the inspector: whether its facts were audited, the
 * performance its definition states, the assumptions and source conflicts it
 * records, the open data gaps, and its sources, each a card (its title, the
 * kind of source, its host, its authority and when it was fetched).
 *
 * The traits come with the bundle. The sources and the verification record
 * are files of the part (sources.json, verification.json): a host that has
 * them gives them through the host context (`evidence`), or registers them
 * (registerEvidenceFiles).
 */
import type { ModuleDef } from "@uhd/types/index.js";
import { evidenceFor } from "../model/evidence";
import { evidenceSourceCards } from "../model/artifacts";
import { Icon } from "../canvas/Icon";
import { useHost } from "../host/context";
import { ArtifactGrid } from "./ArtifactCards";

function Row({ k, v }: { k: string; v?: string }) {
  if (!v) return null;
  return (
    <div className="kv">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  );
}

const text = (v: unknown): string => (typeof v === "string" ? v : typeof v === "object" && v ? JSON.stringify(v) : String(v));

export function EvidenceSection({ def }: { def?: ModuleDef }) {
  const host = useHost();
  const ev = evidenceFor(def, def ? host.evidence?.(def.id) : undefined);
  if (!def || !ev || (!ev.sources.length && !ev.performance.length && !ev.assumptions.length && !ev.discrepancies.length && !ev.verification)) return null;
  const v = ev.verification;
  // assumptions the verification record lists by name only, when no trait says more
  const named = (v?.assumptions ?? []).map(text).filter((a) => !ev.assumptions.some((t) => t.field === a));
  return (
    <>
      <div className="section-title">EVIDENCE</div>
      <div className="evidence">
        {!ev.filesKnown ? null : v?.audit ? (
          <div className={`audit ${v.audit.wrong + v.audit.unsupported > 0 ? "repaired" : "ok"}`}>
            <Icon name="badge-check" size={13} />
            <span>
              AUDITED {v.audit.confirmed}/{v.audit.checked} FACTS
            </span>
            {v.repairs && <span className="muted"> · {v.repairs}</span>}
          </div>
        ) : (
          <div className="audit pending">
            <Icon name="circle-dashed" size={13} /> <span>NOT YET AUDITED</span>
            {v?.repairs && <span className="muted"> · {v.repairs}</span>}
          </div>
        )}
        {ev.performance.map((p) => (
          <div key={p.kind} className="facts">
            <div className="facts-title">{p.kind.toUpperCase()}</div>
            {p.facts.map(([k, val]) => (
              <Row key={k} k={k.toUpperCase()} v={val} />
            ))}
          </div>
        ))}
        {ev.assumptions.length + named.length > 0 && (
          <div className="facts">
            <div className="facts-title warn">ASSUMPTIONS · {ev.assumptions.length + named.length}</div>
            {ev.assumptions.map((a) => (
              <p key={a.field} className="note">
                <b>{a.field}</b>
                {a.value ? ` = ${a.value}` : ""}
                {a.reason ? ` — ${a.reason}` : ""}
              </p>
            ))}
            {named.length > 0 && <p className="note">{named.join(" · ")}</p>}
          </div>
        )}
        {ev.discrepancies.length > 0 && (
          <div className="facts">
            <div className="facts-title">SOURCE CONFLICTS · {ev.discrepancies.length}</div>
            {ev.discrepancies.map((d) => (
              <p key={d.field} className="note">
                <b>{d.field}</b>
                {d.resolution ? ` — ${d.resolution}` : ""}
              </p>
            ))}
          </div>
        )}
        {ev.gaps.length > 0 && (
          <div className="facts">
            <div className="facts-title">OPEN DATA GAPS · {ev.gaps.length}</div>
            <p className="note">{ev.gaps.join(" · ")}</p>
          </div>
        )}
        {ev.sources.length > 0 && (
          <div className="facts">
            <div className="facts-title">SOURCES · {ev.sources.length}</div>
            <ArtifactGrid cards={evidenceSourceCards(def.id, ev.sources)} />
          </div>
        )}
      </div>
    </>
  );
}
