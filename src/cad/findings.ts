/**
 * Findings on the 3D model (PB-823): where a diagnostic is, in the body that
 * holds what it names. Fit and route findings from a host (a cad provider's
 * check: "swd_window is 0.8 mm off the pads") and the viewer's own system
 * checks both name canonical paths, so both can be pinned to the model:
 *
 *   `enclosure:swd_window`   the interface's frame origin, else the manifest
 *                            feature of that name on the body
 *   `board/l1`, `board/u2:pin_14`
 *                            inside a body that draws its components (a
 *                            board): the manifest feature named by the
 *                            component's instance path
 *   `board`                  the body's centre
 *   `link:<id>`              a mate's frame on its first end
 */
import type { UhdBundleDiagnostic } from "@uhd/types/bundle.js";
import type { Vec3 } from "@uhd/types/geometry.js";
import type { ScopedDiagnostic } from "../model/diagnostics";
import type { CadModel } from "./model";

export interface CadTarget {
  body?: string;
  iface?: string;
  /** A component drawn inside the body (its instance path relative to the body). */
  component?: string;
}

export interface FindingAnchor {
  id: string;
  severity: "error" | "warning";
  title: string;
  message: string;
  /** Body key the point is in, and the point in the body's own coordinates (undefined: the body's centre). */
  body: string;
  local?: Vec3;
  select: CadTarget;
  /** From the host (a provider's fit or route check) rather than the viewer's own checks. */
  host?: boolean;
}

/** Where a canonical path is on the model, if any placed body holds it. */
export function anchorOf(model: CadModel, ref: string): Omit<FindingAnchor, "id" | "severity" | "title" | "message"> | undefined {
  if (ref.startsWith("link:")) {
    const mate = model.assembly.mates.find((m) => m.linkId === ref.slice(5));
    if (!mate) return undefined;
    const key = mate.a.path.join("/") + (mate.a.frame.artifact ? `#${mate.a.frame.artifact}` : "");
    return model.bodies.some((b) => b.key === key) ? { body: key, local: mate.a.frame.origin, select: { body: key, iface: mate.a.iface.id } } : undefined;
  }
  const colon = ref.indexOf(":");
  const modules = colon < 0 ? ref : ref.slice(0, colon);
  const iface = colon < 0 ? undefined : ref.slice(colon + 1).split("/")[0];
  const path = modules ? modules.split("/") : [];
  const body = model.bodies
    .filter((b) => !b.key.includes("#") && b.path.length <= path.length && b.path.every((x, i) => path[i] === x))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (!body) return undefined;
  const manifest = model.manifests.get(`${body.def.id}:${body.bodyArtifact}`);
  const rest = path.slice(body.path.length).join("/");
  if (rest) {
    const f = manifest?.features[rest];
    return { body: body.key, local: f?.centroid, select: { body: body.key, component: rest } };
  }
  if (iface) {
    const frame = body.def.interfaces.find((i) => i.id === iface)?.geometry?.frame;
    const local = frame && !frame.artifact ? frame.origin : manifest?.features[iface]?.centroid;
    return { body: body.key, local, select: { body: body.key, ...(body.def.interfaces.some((i) => i.id === iface) ? { iface } : {}) } };
  }
  return { body: body.key, select: { body: body.key } };
}

/** Errors and warnings that can be pinned to the model, the system's first, then the host's. */
export function findingAnchors(model: CadModel, system: ScopedDiagnostic[], host: UhdBundleDiagnostic[]): FindingAnchor[] {
  const out: FindingAnchor[] = [];
  for (const d of system) {
    if (d.severity === "info") continue;
    // the most specific ref first: a pin or interface, then a link
    const refs = [...d.refs.filter((r) => !r.startsWith("link:")), ...d.refs.filter((r) => r.startsWith("link:"))];
    const a = refs.map((r) => anchorOf(model, r)).find(Boolean);
    if (a) out.push({ id: `s:${d.id}`, severity: d.severity, title: d.rule.replace(/_/g, " ").toUpperCase(), message: d.message, ...a });
  }
  host.forEach((d, i) => {
    if (d.severity === "info" || !d.entity) return;
    const ref = d.entity.kind === "link" ? `link:${d.entity.id}` : d.entity.id;
    const a = anchorOf(model, ref);
    if (a) out.push({ id: `h:${d.code}:${d.entity.id}:${i}`, severity: d.severity as "error" | "warning", title: d.code.replace(/_/g, " "), message: d.message, host: true, ...a });
  });
  return out;
}
