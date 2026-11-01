/**
 * The sequence player on CadView's objects (PB-1183): resolve once per loaded
 * model, then apply each pose. CadView (W2-A's) keeps its records; these
 * functions read them structurally, so the call sites are two lines:
 *
 *   const resolved = resolveForCad({ model, bodies: bodies.current, hardware: hardware.current, file, up, gap, root: h.root });
 *   applyCadPose(player.pose(), bodies.current, hardware.current);
 *
 * Mated parts follow the sequence (fasteners on their own axes, in assembly
 * order). The stack planner (./explodeSample.ts) still places what no mate
 * places and the named bodies along up; a model with no mates at all is the
 * planner alone, so the bottle and quad-motor fixtures keep today's result.
 */
import * as THREE from "three";
import { planStackRises } from "../explodeSample";
import { hardwareKeys } from "./generate";
import { sequenceForModel, sequenceFromPlan } from "./fallback";
import { resolveSequence, type Mat, type ResolvedSequence } from "./resolve";
import type { SequenceFile, Vec3 } from "./types";
import type { Assembly } from "./uhd";

/** A CadView body record, as far as the sequence needs it. */
export interface CadBodyTarget {
  body: { key: string; via?: string };
  obj: THREE.Object3D;
  base: THREE.Matrix4;
  offset: THREE.Vector3;
  box: THREE.Box3;
  parts: CadPartTarget[];
}
/** A named body of one artifact (an enclosure's lid), moved in its parent node's space. */
export interface CadPartTarget {
  obj: THREE.Object3D;
  base: THREE.Vector3;
  cadDir: THREE.Vector3;
  cadBox: THREE.Box3;
  clear: number;
  travel: THREE.Vector3;
  toLocal?: THREE.Matrix3;
}
/** A CadView hardware record, in `model.assembly.hardware` order. */
export interface CadHardwareTarget {
  obj: THREE.Object3D;
  base: THREE.Matrix4;
  offset: THREE.Vector3;
  structure: string;
}

export interface CadResolveInput {
  model: { assembly: Assembly; bodies: { key: string; via?: string }[] };
  bodies: Map<string, CadBodyTarget>;
  hardware: CadHardwareTarget[];
  /** A built sequence.json, if the host or the bundle gave one. */
  file?: SequenceFile;
  /** The view's up axis (CAD coordinates). */
  up: THREE.Vector3;
  /** The view's explode step (mm per rank), CadView's `explodeScale()`. */
  gap: number;
  /** The scene root holding the bodies (world matrices are brought up to date at the assembled pose). */
  root: THREE.Object3D;
  /** The instance path the model was placed from (for the viewer's own generator). */
  rootPath?: string[];
  levels?: "all" | "one";
}

const v3 = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];

/**
 * Resolve the sequence for a loaded model: the built file, else the model's
 * own generated sequence, else the stack planner alone. Leaves every object
 * at its assembled pose (it samples the planner there).
 */
export function resolveForCad(input: CadResolveInput): ResolvedSequence {
  const { model, bodies } = input;
  const axis = input.up.clone().normalize();
  // the assembled pose: planner sampling and part frames are taken there
  for (const rec of bodies.values()) {
    rec.obj.matrix.copy(rec.base);
    rec.obj.matrixWorldNeedsUpdate = true;
    rec.offset.set(0, 0, 0);
    for (const part of rec.parts) part.obj.position.copy(part.base);
  }
  input.root.updateMatrixWorld(true);
  for (const rec of bodies.values())
    for (const part of rec.parts) if (part.obj.parent) part.toLocal = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().copy(part.obj.parent.matrixWorld).invert());

  const mated = new Set(model.bodies.filter((b) => b.via && model.assembly.mates.some((m) => m.linkId === b.via)).map((b) => b.key));
  const hinted = model.bodies.filter((b) => !mated.has(b.key)).map((b) => b.key);
  const file = input.file ?? sequenceForModel(model.assembly, input.rootPath ?? [], hinted);

  // the planner covers what no mate places, plus named bodies along up; every unmated body is sampled
  // (a battery strapped on a plate rises clear of it), mated ones only as what the others sit on
  const elements: { key: string; objects: THREE.Object3D[]; skip: Set<THREE.Object3D> }[] = [];
  const partsOff: { ref: string; body: string; dir: Vec3; distance: number }[] = [];
  const plannedKeys = new Set<string>();
  for (const rec of bodies.values()) {
    if (rec.box.isEmpty()) continue;
    const alongUp = rec.parts.filter((p) => Math.abs(p.cadDir.clone().transformDirection(rec.base).dot(axis)) > 0.7);
    elements.push({ key: rec.body.key, objects: [rec.obj], skip: new Set(alongUp.map((p) => p.obj)) });
    if (!mated.has(rec.body.key)) plannedKeys.add(rec.body.key);
    for (const p of rec.parts) {
      const ref = `${rec.body.key}::${p.obj.name}`;
      if (alongUp.includes(p)) {
        elements.push({ key: ref, objects: [p.obj], skip: new Set() });
        plannedKeys.add(ref);
      } else {
        // off the stack (a plunger through a side wall): out of its bore, just clear of the body
        const dir = p.cadDir.clone().transformDirection(rec.base);
        partsOff.push({ ref, body: rec.body.key, dir: v3(dir), distance: p.clear + input.gap * 0.35 });
      }
    }
  }
  const needPlan = plannedKeys.size > 0;
  const rises = needPlan ? planStackRises(elements, axis, input.gap) : new Map<string, number>();
  // the sequence's base never moves: it is sampled (others sit on it) but gets no step
  const base = new Set(file?.sequences.find((s) => s.id === file.main)?.base ?? []);
  const planned = new Map([...rises].filter(([k]) => plannedKeys.has(k) && !base.has(k)));
  const resolveInput = { assembly: model.assembly, gap: input.gap, up: v3(axis), planned, parts: partsOff, levels: input.levels };
  if (!file) return resolveSequence(resolveInput, sequenceFromPlan(planned), "planner");
  const resolved = resolveSequence(resolveInput, file, input.file ? "file" : "generated");
  reparentHardwareToParts(resolved, model.assembly, input.hardware, bodies);
  return resolved;
}

/** Fasteners through a shell's lid ride with the lid: hardware whose seat lies in a named body's box rides on that body. */
function reparentHardwareToParts(resolved: ResolvedSequence, asm: Assembly, hardware: CadHardwareTarget[], bodies: Map<string, CadBodyTarget>) {
  const keys = hardwareKeys(asm.hardware);
  hardware.forEach((hw, i) => {
    const rec = bodies.get(hw.structure);
    if (!rec?.parts.length || !keys[i]) return;
    const local = new THREE.Vector3().setFromMatrixPosition(hw.base).applyMatrix4(rec.base.clone().invert());
    const part = rec.parts.find((p) => p.cadBox.clone().expandByScalar(1).containsPoint(local));
    if (part) resolved.parents.set(keys[i], `${rec.body.key}::${part.obj.name}`);
  });
}

const toThree = (m: Mat) => new THREE.Matrix4().fromArray(m as unknown as number[]);

/**
 * Put every body, named body and hardware part where the pose says (delta ×
 * assembled placement). Parts the pose leaves out go back to their assembled
 * pose. `offset` on each record is kept as the translation part (labels, the
 * ground and observe() read it).
 */
export function applyCadPose(pose: ReadonlyMap<string, Mat>, model: { assembly: Assembly }, bodies: Map<string, CadBodyTarget>, hardware: CadHardwareTarget[]) {
  const deltaOf = (ref: string) => {
    const m = pose.get(ref);
    return m ? toThree(m) : undefined;
  };
  for (const rec of bodies.values()) {
    const d = deltaOf(rec.body.key);
    rec.obj.matrix.copy(d ? d.clone().multiply(rec.base) : rec.base);
    rec.offset.set(d ? d.elements[12] : 0, d ? d.elements[13] : 0, d ? d.elements[14] : 0);
    rec.obj.matrixWorldNeedsUpdate = true;
    for (const part of rec.parts) {
      // a named body moves relative to its own body: its delta less the body's, in its parent node's space
      const pd = deltaOf(`${rec.body.key}::${part.obj.name}`);
      part.obj.position.copy(part.base);
      part.travel.set(0, 0, 0);
      if (!pd) continue;
      part.travel.set(pd.elements[12] - rec.offset.x, pd.elements[13] - rec.offset.y, pd.elements[14] - rec.offset.z);
      if (part.toLocal) part.obj.position.add(part.travel.clone().applyMatrix3(part.toLocal));
    }
  }
  const keys = hardwareKeys(model.assembly.hardware);
  hardware.forEach((hw, i) => {
    const d = keys[i] ? deltaOf(keys[i]) : undefined;
    hw.obj.matrix.copy(d ? d.clone().multiply(hw.base) : hw.base);
    hw.offset.set(d ? d.elements[12] : 0, d ? d.elements[13] : 0, d ? d.elements[14] : 0);
    hw.obj.matrixWorldNeedsUpdate = true;
  });
}
