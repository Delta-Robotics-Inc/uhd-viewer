/**
 * The Measure tool (R3-C): a person clicks two points on the model and gets a dimension record, MESH tier (the
 * display mesh: points on its triangles, the tolerance from the faces they hit, ../measure/mesh.ts), written to the
 * view state like any callout (so it is saved with the callouts, undone, and seen by agents). When the host has the
 * geometry service (the CLI's exact tier, ../measure/exact.ts), the record is then updated with the B-rep's number
 * and tier EXACT.
 *
 * The tool owns no pointer listeners: the host sends it the clicks it would have used for a pick while the tool is
 * on (CadView's canvas `onUp`), so a drag still orbits and the selection does not change. Escape ends it.
 */
import * as THREE from "three";
import type { PartHit } from "../annot/resolve";
import { exactRequest } from "../measure/exact";
import { measurePointPoint } from "../measure/mesh";
import { refFace, type MeasureRef } from "../measure/pick";
import type { GeometryRequest, MeasureResult } from "../measure/protocol";
import type { DimensionRecord, Vec3 } from "./record";
import type { DimPreview } from "./layer";

/** One pick: the ref it names (an instance path from the root), the world point, the part as resolved, the mesh ref. */
export interface MeasurePick {
  ref: string;
  /** World mm. */
  point: THREE.Vector3;
  hit: PartHit;
  /** The mesh tier's reference (faces, for the tolerance and the exact request). */
  measure?: MeasureRef;
}

export interface MeasureHost {
  pickAt(clientX: number, clientY: number): MeasurePick | undefined;
  /** Write the record (a new one, or the same id updated). */
  commit(record: DimensionRecord): void;
  /** The exact tier (the CLI's geometry service), when the host has it. */
  exact?(request: GeometryRequest): Promise<MeasureResult | undefined>;
}

/** The hints the tool shows (DEFAULT wording). */
export const MEASURE_HINT = { first: "Measure: click a point", second: "Measure: click a second point · Esc to stop" } as const;

const round = (v: number) => Math.round(v * 1000) / 1000;
const local = (p: MeasurePick): Vec3 => {
  const v = p.point.clone().applyMatrix4(p.hit.frame.clone().invert());
  return [round(v.x), round(v.y), round(v.z)];
};

/**
 * A MESH-tier dimension between two picks: each point in its body's frame (so it follows its part), the tolerance
 * from the faces hit when both picks carry a mesh reference (`measurePointPoint`).
 */
export function dimensionFromPicks(a: MeasurePick, b: MeasurePick, id: string, author = "user"): DimensionRecord {
  let tol: number | undefined;
  if (a.measure && b.measure) {
    try {
      tol = measurePointPoint(a.measure.point, b.measure.point, { a: refFace(a.measure, "assembly"), b: refFace(b.measure, "assembly") }).tolerance.mm;
    } catch {
      tol = undefined;
    }
  }
  return { id, kind: "dimension", ref: a.ref, to: b.ref, author, point: local(a), toPoint: local(b), tier: "mesh", ...(tol !== undefined && Number.isFinite(tol) ? { toleranceMm: round(tol) } : {}) };
}

let counter = 0;
/** A new record id for a person's measurement (DEFAULT `m.<time base 36>.<n>`; agents' ids are issued by the store). */
export const measureId = (): string => `m.${Date.now().toString(36)}.${++counter}`;

export class MeasureTool {
  host: MeasureHost | undefined;
  /** Where the first pick and the hint are drawn (the dims layer). */
  layer: { setPreview(p: DimPreview | null): void } | undefined;
  /** Called when the tool turns on or off (Escape, a toggle). */
  onChange?: (active: boolean) => void;
  private on = false;
  private first: MeasurePick | undefined;
  private keyOff: (() => void) | undefined;

  get active(): boolean {
    return this.on;
  }

  setActive(on: boolean) {
    if (on === this.on) return;
    this.on = on;
    this.first = undefined;
    this.keyOff?.();
    this.keyOff = undefined;
    if (on && typeof window !== "undefined") {
      const onKey = (e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        // Escape drops a first pick, then ends the tool
        if (this.first) {
          this.first = undefined;
          this.show();
        } else this.setActive(false);
        e.preventDefault();
        e.stopPropagation();
      };
      // wave R3 gate (review): in the capture phase, so the view's own Escape (take over from an agent, which revokes
      // every agent lease) never sees the key that ends a measurement
      window.addEventListener("keydown", onKey, true);
      this.keyOff = () => window.removeEventListener("keydown", onKey, true);
    }
    this.show();
    this.onChange?.(on);
  }

  /** A click while the tool is on (a press that did not drag). Returns true when it was used. */
  click(clientX: number, clientY: number): boolean {
    if (!this.on || !this.host) return false;
    const p = this.host.pickAt(clientX, clientY);
    if (!p) return false;
    if (!this.first) {
      this.first = p;
      this.show();
      return true;
    }
    const a = this.first;
    this.first = undefined;
    const rec = dimensionFromPicks(a, p, measureId());
    this.host.commit(rec);
    this.show();
    // the exact tier when the host has it: the same record, the B-rep's number
    const exact = this.host.exact;
    if (exact && a.measure && p.measure) {
      const host = this.host;
      void exact(exactRequest("point-point", a.measure, p.measure))
        .then((r) => {
          if (r && typeof r.distance === "number" && Number.isFinite(r.distance)) host.commit({ ...rec, tier: "exact", valueMm: round(r.distance), toleranceMm: round(r.tolerance.mm) });
        })
        .catch(() => undefined);
    }
    return true;
  }

  private show() {
    this.layer?.setPreview(this.on ? { points: this.first ? [this.first.point.clone()] : [], hint: this.first ? MEASURE_HINT.second : MEASURE_HINT.first } : null);
  }
}
