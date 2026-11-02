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
import { planRadial, type RadialPart } from "../explode";
import { facings, planStackRises } from "../explodeSample";
import { hardwareKeys } from "./generate";
import { sequenceForModel, sequenceFromPlan } from "./fallback";
import { expandRefs } from "./patch";
import { resolveSequence, type Mat, type ResolvedSequence } from "./resolve";
import type { RadialPlan } from "./player";
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
    // assembly mm to the named body's parent node space (GLB metres, Y up, inside cadWrapper): see applyCadPose
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
  // the radial explode (R2-B): read now, at the assembled pose, with the sequence file's overrides
  const radial = radialPlanFor(input, file);
  const needPlan = plannedKeys.size > 0;
  const rises = needPlan ? planStackRises(elements, axis, input.gap) : new Map<string, number>();
  // the sequence's base never moves: it is sampled (others sit on it) but gets no step
  const base = new Set(file?.sequences.find((s) => s.id === file.main)?.base ?? []);
  const planned = new Map([...rises].filter(([k]) => plannedKeys.has(k) && !base.has(k)));
  const resolveInput = { assembly: model.assembly, gap: input.gap, up: v3(axis), planned, parts: partsOff, levels: input.levels };
  if (!file) return Object.assign(resolveSequence(resolveInput, sequenceFromPlan(planned), "planner"), { radial });
  const resolved = resolveSequence(resolveInput, file, input.file ? "file" : "generated");
  reparentHardwareToParts(resolved, model.assembly, input.hardware, bodies);
  // hardware that rides a named body in the sequence rides it in the radial explode too
  for (const [k, parent] of resolved.parents) {
    const host = radial.moves.get(parent);
    if (host && radial.moves.has(k) && radial.moves.get(k)!.from !== "sequence") radial.moves.set(k, { ...host, from: "rides" });
  }
  return Object.assign(resolved, { radial });
}

/**
 * Per part, an explode direction and distance a sequence file sets (R2-B reads, R2-E's generator writes):
 * `explode: { direction?: [x, y, z], distance?: mm }` on a step (every member) or on a member (wins). Read
 * structurally: the shared types (./types.ts, byte-identical with the stack) gain the field on R2-E's side.
 */
export function explodeOverrides(file: SequenceFile | undefined): Map<string, { direction?: Vec3; distance?: number }> {
  const out = new Map<string, { direction?: Vec3; distance?: number }>();
  if (!file) return out;
  const parse = (x: unknown): { direction?: Vec3; distance?: number } | undefined => {
    if (!x || typeof x !== "object") return undefined;
    const e = x as { direction?: unknown; distance?: unknown };
    const dir = Array.isArray(e.direction) && e.direction.length === 3 && e.direction.every((n) => typeof n === "number" && Number.isFinite(n)) && Math.hypot(...(e.direction as number[])) > 1e-9 ? (e.direction as Vec3) : undefined;
    const dist = typeof e.distance === "number" && Number.isFinite(e.distance) && e.distance >= 0 ? e.distance : undefined;
    return dir || dist !== undefined ? { ...(dir ? { direction: dir } : {}), ...(dist !== undefined ? { distance: dist } : {}) } : undefined;
  };
  for (const seq of file.sequences)
    for (const step of seq.steps) {
      const own = parse((step as { explode?: unknown }).explode);
      for (const m of step.members) {
        const mine = parse((m as { explode?: unknown }).explode);
        if (!own && !mine) continue;
        for (const ref of expandRefs(seq, [m.ref])) out.set(ref, { ...out.get(ref), ...own, ...mine });
      }
    }
  return out;
}

/**
 * The radial explode for a loaded model (R2-B, ../explode.ts `planRadial`): every body, named body and hardware
 * part with its facings, read at the assembled pose; hardware rides the smallest body whose box holds its seat
 * (DEFAULT 1 mm), the way a screw through a panel goes out with the panel.
 */
function radialPlanFor(input: CadResolveInput, file: SequenceFile | undefined): RadialPlan {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const { bodies } = input;
  const assembled = new THREE.Box3();
  for (const rec of bodies.values()) if (!rec.box.isEmpty()) assembled.union(rec.box.clone().applyMatrix4(rec.base));
  const sphere = assembled.isEmpty() ? new THREE.Sphere() : assembled.getBoundingSphere(new THREE.Sphere());
  const parts: RadialPart[] = [];
  const boxes: { key: string; box: THREE.Box3 }[] = [];
  for (const rec of bodies.values()) {
    if (rec.box.isEmpty()) continue;
    const world = rec.box.clone().applyMatrix4(rec.base);
    boxes.push({ key: rec.body.key, box: world });
    parts.push({ key: rec.body.key, centre: v3(world.getCenter(new THREE.Vector3())), facings: facings([rec.obj], new Set(rec.parts.map((p) => p.obj))), box: [v3(world.min), v3(world.max)] });
    for (const p of rec.parts) {
      if (p.cadBox.isEmpty()) continue;
      const pw = p.cadBox.clone().applyMatrix4(rec.base);
      parts.push({ key: `${rec.body.key}::${p.obj.name}`, centre: v3(pw.getCenter(new THREE.Vector3())), facings: facings([p.obj]), box: [v3(pw.min), v3(pw.max)] });
    }
  }
  const keys = hardwareKeys(input.model.assembly.hardware);
  input.hardware.forEach((hw, i) => {
    const key = keys[i];
    if (!key) return;
    const seat = new THREE.Vector3().setFromMatrixPosition(hw.base);
    const holders = boxes.filter((b) => b.box.clone().expandByScalar(1).containsPoint(seat));
    const vol = (b: THREE.Box3) => {
      const s = b.getSize(new THREE.Vector3());
      return s.x * s.y * s.z;
    };
    const host = holders.sort((a, b) => vol(a.box) - vol(b.box))[0];
    parts.push({ key, centre: v3(seat), facings: host ? [] : facings([hw.obj]), ...(host ? { rides: host.key } : {}) });
  });
  const up = v3(input.up.clone().normalize());
  const overrides = explodeOverrides(file);
  const moves = planRadial(parts, { centre: v3(sphere.center), radius: sphere.radius, up, overrides });
  const ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
  return { moves, centre: v3(sphere.center), radius: sphere.radius, ms: Math.round(ms * 10) / 10, parts, up, overrides };
}

/** Fasteners through a shell's lid ride with the lid: hardware whose seat lies in a named body's box rides on that body. */
function reparentHardwareToParts(resolved: ResolvedSequence, asm: Assembly, hardware: CadHardwareTarget[], bodies: Map<string, CadBodyTarget>) {
  const keys = hardwareKeys(asm.hardware);
  hardware.forEach((hw, i) => {
    const rec = bodies.get(hw.structure);
    if (!rec?.parts.length || !keys[i]) return;
    // both in the body's own CAD frame, mm: `local` through the inverse of the body's placement, `cadBox` as
    // CadView measured it before parenting (world = CAD coordinates, mm, Z up)
    const local = new THREE.Vector3().setFromMatrixPosition(hw.base).applyMatrix4(rec.base.clone().invert());
    // DEFAULT 1 mm: a seat on the named body's surface (a screw head on the lid) counts as inside its box
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
      // travel is assembly mm (Z up); the named body's node sits inside cadWrapper, in GLB metres (Y up). `toLocal`
      // (the inverse of its parent's world matrix, taken assembled) carries the mm vector into that space: the
      // wrapper's x1000 scale and +90 degree turn about X come out here (mm to metres, Z up to Y up)
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
