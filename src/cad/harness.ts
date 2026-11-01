/**
 * Routed wire harnesses in the 3D view: the route manifest a harness's
 * generator writes, its cable summary, and the surfaces of its nodes.
 * (Split out of CadView.tsx, PB-1178.)
 */
import * as THREE from "three";
import type { HarnessPlacement } from "@uhd/system/geometry.js";
import type { CadModel } from "./model";

/** The route manifest a harness's generator wrote (loaded with the other manifests). */
export interface RouteManifest {
  length_mm: number;
  route_length_mm: number;
  conductor_lengths_mm: number[];
  bundle: { kind: string; conductors: number; conductor_od_mm: number; bundle_od_mm: number; twist_pitch_mm: number | null };
  bend_radius_mm: { target: number; minimum: number; centreline: number; conductors: number };
  clearance_mm: { min_conductor_surface: number | null };
  length_fit: { method: string; slack_mm?: number };
  route: [number, number, number][];
  status: string;
  notes: string[];
  step: string;
}

export function routeManifest(model: CadModel, hp: HarnessPlacement): RouteManifest | undefined {
  const m = [...model.manifests.entries()].find(([k]) => k.startsWith(`${hp.def.id}:`))?.[1] as unknown as RouteManifest | undefined;
  return m && Array.isArray(m.route) ? m : undefined;
}

export function cableTrait(hp: HarnessPlacement): { length_mm?: number; wire_gauge_awg?: number; conductors?: number } {
  return (hp.def.traits?.find((t) => t.type === "performance" && t.params?.kind === "cable")?.params ?? {}) as { length_mm?: number; wire_gauge_awg?: number; conductors?: number };
}

/** "3 × 20 AWG · 78 mm · twisted" */
export function cableSummary(hp: HarnessPlacement, m?: RouteManifest): string {
  const c = cableTrait(hp);
  const n = c.conductors ?? m?.bundle.conductors;
  const gauge = c.wire_gauge_awg ? `${c.wire_gauge_awg} AWG` : m ? `ø${m.bundle.conductor_od_mm} mm` : "";
  return [n ? `${n} × ${gauge}`.trim() : "", c.length_mm ? `${c.length_mm} mm` : "", m?.bundle.kind ?? ""].filter(Boolean).join(" · ");
}

/**
 * Surface for a node of a harness artifact: the generator names every node
 * (conductor_*, *_housing, *_joint_*, *_tip_*) and gives it a base colour;
 * the viewer only sets how each kind of surface reflects light.
 */
const harnessLooks = new WeakMap<THREE.Material, Map<string, THREE.MeshStandardMaterial>>();
export function harnessMaterial(src: THREE.MeshStandardMaterial, name: string): THREE.MeshStandardMaterial {
  // one per (GLB material, kind of surface), shared by every conductor of that colour (PB-1175)
  const kind = /^conductor_/.test(name) ? "conductor" : /_joint_|_tip_/.test(name) ? "metal" : /_housing/.test(name) ? "housing" : "other";
  let byKind = harnessLooks.get(src);
  if (!byKind) harnessLooks.set(src, (byKind = new Map()));
  const have = byKind.get(kind);
  if (have) return have;
  const m = new THREE.MeshStandardMaterial({ color: src.color.clone(), metalness: src.metalness, roughness: src.roughness });
  byKind.set(kind, m);
  if (/^conductor_/.test(name) && src.metalness < 0.5) {
    // silicone insulation: soft satin
    m.roughness = 0.48;
    m.metalness = 0.0;
  } else if (/_joint_|_tip_/.test(name) || src.metalness >= 0.5) {
    m.metalness = 0.9;
    m.roughness = 0.28;
  } else if (/_housing/.test(name)) {
    m.roughness = 0.42;
    m.metalness = 0.0;
  }
  return m;
}
