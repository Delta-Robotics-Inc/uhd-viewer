/**
 * Dimensions and angles in the 3D view (R3-C, 2026-11-02; concept B, image 1). Two halves, as the callout layer:
 *
 * - in the scene (`group`, added to the scene handle's overlay group): every line of every dimension and angle in
 *   three draws at most (solid lines, dashed lines, and a faint copy of the solid ones that ignores depth so a
 *   hidden dimension still shows where it is), and every end dot in one more. All depth-tested but the ghost.
 * - on the page (`root`): the label chips, in screen space, so they stay upright and readable while the view
 *   orbits ("158.4 mm NOMINAL", "NOW 62°", "REST 90°", "HARD STOP 95°", "0°").
 *
 * Everything is recomputed from the records on each frame the view draws, so a dimension follows its parts through
 * explode and a hot swap, and an angle follows its joint while it moves (a drive, a clip, the Assemble play: the
 * value is read from the part's pose, ./geometry.ts valueFromDelta). A dimension's number is the distance as
 * assembled (the parts' assembled frames), so pulling the model apart never changes what it says.
 *
 * Units: world units are assembly mm (the glTF metres are scaled at the boundary, ../scene.ts cadWrapper); a host
 * root with its own transform is undone through `rootMatrix` before a number is shown. Text from records is set
 * with textContent only.
 */
import * as THREE from "three";
import type { PartHit } from "../annot/resolve";
import { cssColour } from "../annot/layer";
import { attachWheelForward, canvasIn } from "../annot/wheel";
import { TIER_NOTE, tierOf, type AngleRecord, type DimRecord, type DimensionRecord, type Vec3 } from "./record";
import { ARC_MIN_PX, ARC_SHARE, angleTicks, arcPoints, arcSpan, dimensionOffset, dimensionShape, directionAt, formatMm, perPxAt, restDirection, tickAt, valueFromDelta, type AngleFrame } from "./geometry";
import { SegmentBatch, segmentsOf } from "./lines";
import { DASH_PX, DIM_DOT_PX, DIM_FALLBACK, DIM_GHOST_OPACITY, GAP_PX, ensureDimsStyles } from "./style";

/** A joint the view can draw an angle about (the sequence player's resolved joints: root mm, Z up). */
export interface DimJoint {
  id: string;
  type: "revolute" | "slider";
  /** The body it turns: its placement key in the view's scope. */
  part: string;
  /** The same part as an instance path from the root (the host maps it out of the scope); absent: `part`. */
  path?: string;
  /** A point on the axis and the axis, in the assembly root's frame (mm, Z up). */
  origin: Vec3;
  axis: Vec3;
  min?: number;
  max?: number;
  rest: number;
}

export interface DimsHost {
  /** The part a ref names (an instance path from the root), as the callout layer resolves it. */
  resolve(ref: string): PartHit | null;
  /** A body's frame as assembled (its parent's world matrix times its assembled placement), by placement key. */
  bodyRest?(key: string): THREE.Matrix4 | undefined;
  /** The joints of what is shown (revolute ones get angles). */
  joints?(): DimJoint[];
  /** The assembly root's world matrix (identity when absent). */
  rootMatrix?(): THREE.Matrix4 | undefined;
}

/** What each record did on the last frame (agents read it: no screenshot needed). */
export interface DimStatus {
  id: string;
  kind: "dimension" | "angle";
  status: "placed" | "offscreen" | "orphan" | "hidden" | "unsupported";
  /** The number shown: mm for a dimension, degrees for an angle (NOW). */
  value?: number;
  tier?: string;
  label?: string;
  /** The chip's centre, CSS px. */
  labelPx?: [number, number];
  why?: string;
}

type Colours = Record<keyof typeof DIM_FALLBACK, THREE.Color>;

const ID = new THREE.Matrix4();

/** A round dot texture (no canvas: it is built in memory, so the layer also runs in node tests). */
function dotTexture(): THREE.DataTexture {
  const n = 32;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const d = Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2) / (n / 2);
      const a = Math.max(0, Math.min(1, (1 - d) * 8));
      const i = (y * n + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** One preview point of the measure tool (the first pick, while it waits for the second). */
export interface DimPreview {
  points: THREE.Vector3[];
  hint?: string;
}

export class DimsLayer {
  readonly root: HTMLDivElement;
  readonly group = new THREE.Group();
  private host: DimsHost;
  private records: DimRecord[] = [];
  private solid = new SegmentBatch();
  private dashed = new SegmentBatch();
  /**
   * Wave R3 gate: an angle's arc, ticks and arm, drawn over the parts (no depth test). Drawn depth-tested the arc of a
   * small joint ran through the part it measures and could not be read at a normal zoom (r3c's drone shots); concept
   * image 1 draws the whole arc in front of the model.
   */
  private over = new SegmentBatch();
  private dots = new THREE.BufferGeometry();
  private dotPos = new Float32Array(3 * 64);
  private dotCol = new Float32Array(3 * 64);
  private dotN = 0;
  private solidLines: THREE.LineSegments;
  private ghostLines: THREE.LineSegments;
  private dashedLines: THREE.LineSegments;
  private overLines: THREE.LineSegments;
  private dashMat: THREE.LineDashedMaterial;
  private dotMat: THREE.PointsMaterial;
  private points: THREE.Points;
  private chips = new Map<string, HTMLDivElement>();
  private hint: HTMLDivElement | null = null;
  private preview: DimPreview | null = null;
  private status: DimStatus[] = [];
  private wheelOff: () => void;
  /** Where wheel events over chips go (the renderer's canvas; found in the container when unset). */
  wheelTarget: EventTarget | undefined;
  colours: Colours = Object.fromEntries(Object.entries(DIM_FALLBACK).map(([k, v]) => [k, new THREE.Color(v)])) as Colours;
  /** Called when the layer needs a frame (the preview changed). */
  onChange?: () => void;

  constructor(container: HTMLElement, host: DimsHost) {
    ensureDimsStyles(container.ownerDocument);
    this.host = host;
    this.root = container.ownerDocument.createElement("div");
    this.root.className = "cad-dims";
    container.appendChild(this.root);
    this.group.name = "dimensions";
    this.group.userData.noBatch = true;
    const lineMat = (depth: boolean, opacity: number) => new THREE.LineBasicMaterial({ vertexColors: true, depthTest: depth, depthWrite: false, transparent: true, opacity, toneMapped: false });
    this.solidLines = segmentsOf(this.solid, lineMat(true, 1), 21);
    this.ghostLines = segmentsOf(this.solid, lineMat(false, DIM_GHOST_OPACITY), 18);
    this.dashMat = new THREE.LineDashedMaterial({ vertexColors: true, depthTest: true, depthWrite: false, transparent: true, opacity: 0.95, dashSize: 1, gapSize: 1, toneMapped: false });
    this.dashedLines = segmentsOf(this.dashed, this.dashMat, 20);
    // DEFAULT (wave R3 gate): 92 % over the parts
    this.overLines = segmentsOf(this.over, lineMat(false, 0.92), 23);
    this.dots.setAttribute("position", new THREE.BufferAttribute(this.dotPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.dots.setAttribute("color", new THREE.BufferAttribute(this.dotCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.dotMat = new THREE.PointsMaterial({ size: DIM_DOT_PX, sizeAttenuation: false, vertexColors: true, map: dotTexture(), transparent: true, alphaTest: 0.4, depthTest: true, depthWrite: false, toneMapped: false });
    this.points = new THREE.Points(this.dots, this.dotMat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 22;
    this.points.matrixAutoUpdate = false;
    this.group.add(this.ghostLines, this.dashedLines, this.solidLines, this.overLines, this.points);
    this.group.visible = false;
    // the wheel over a chip zooms the view, as over a callout (walkthrough D2)
    this.wheelOff = attachWheelForward(this.root, () => this.wheelTarget ?? canvasIn(container));
  }

  /** The dimension and angle records to draw (`dimRecordsOf(viewState.annotations)`). */
  setRecords(records: DimRecord[]) {
    this.records = records;
    this.onChange?.();
  }

  /** The measure tool's first pick (a dot) and its hint, or null. */
  setPreview(p: DimPreview | null) {
    this.preview = p;
    this.onChange?.();
  }

  /** How many records there are (the host draws frames for the layer while there are any). */
  get count(): number {
    return this.records.length;
  }

  /** Read the theme's colours (call when the theme changes). */
  refreshColours() {
    const el = this.root;
    const c = (v: string, f: string) => new THREE.Color(cssColour(el, v, f));
    this.colours = {
      line: c("--uhd-dim-line", DIM_FALLBACK.line),
      extension: c("--uhd-dim-extension", DIM_FALLBACK.extension),
      chip: c("--uhd-dim-chip", DIM_FALLBACK.chip),
      chipBorder: c("--uhd-dim-chip-border", DIM_FALLBACK.chipBorder),
      text: c("--uhd-dim-text", DIM_FALLBACK.text),
      tier: c("--uhd-dim-tier-surface", DIM_FALLBACK.tier),
      path: c("--uhd-explode-path", DIM_FALLBACK.path),
      accent: c("--uhd-accent", DIM_FALLBACK.accent),
      stop: c("--uhd-drc-error", DIM_FALLBACK.stop),
    };
    this.onChange?.();
  }

  /** What each record did on the last frame. */
  report(): DimStatus[] {
    return this.status.map((s) => ({ ...s, ...(s.labelPx ? { labelPx: [...s.labelPx] as [number, number] } : {}) }));
  }

  /** Draw calls on the last frame (0 with nothing to draw). */
  drawStats(): { segments: number; dashed: number; dots: number; draws: number } {
    const s = this.solid.count;
    const d = this.dashed.count;
    const o = this.over.count;
    return { segments: s, dashed: d, dots: this.dotN, ...(o ? { over: o } : {}), draws: this.group.visible ? (s ? 2 : 0) + (d ? 1 : 0) + (o ? 1 : 0) + (this.dotN ? 1 : 0) : 0 };
  }

  /** A segment as written on the last frame (tests): `which` batch, index. */
  segment(which: "solid" | "dashed" | "over", i: number) {
    return (which === "solid" ? this.solid : which === "over" ? this.over : this.dashed).segment(i);
  }

  // ---------------------------------------------------------------------------------------------

  /** Lay out and draw; call on every frame the view draws. Returns true while a frame more is needed (never today). */
  update(camera: THREE.PerspectiveCamera, width: number, height: number): boolean {
    const status: DimStatus[] = [];
    const keep = new Set<string>();
    this.solid.begin();
    this.dashed.begin();
    this.over.begin();
    this.dotN = 0;
    camera.updateMatrixWorld();
    const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    const depth = (p: THREE.Vector3) => p.clone().sub(camPos).dot(fwd);
    const toPx = (p: THREE.Vector3): [number, number, boolean] => {
      const v = p.clone().project(camera);
      return [((v.x + 1) / 2) * width, ((1 - v.y) / 2) * height, depth(p) > camera.near * 0.5];
    };
    const root = this.host.rootMatrix?.() ?? ID;
    const rootInv = root.clone().invert();
    const up = new THREE.Vector3(0, 0, 1).transformDirection(root);
    let perPxSum = 0;
    let perPxN = 0;
    const perPx = (p: THREE.Vector3) => {
      const v = perPxAt(camera, depth(p), height);
      perPxSum += v;
      perPxN++;
      return v;
    };
    const C = this.colours;

    for (const r of this.records) {
      if (r.visibility === "off") {
        status.push({ id: r.id, kind: r.kind, status: "hidden" });
        continue;
      }
      if (r.kind === "dimension") status.push(this.drawDimension(r, { toPx, perPx, root, rootInv, up, keep, C, width, height }));
      else status.push(this.drawAngle(r, { toPx, perPx, root, keep, C, width, height }));
    }

    // the measure tool's first pick
    if (this.preview) for (const p of this.preview.points) this.dot(p, C.accent);
    this.hintText(this.preview?.hint);

    // dashes a constant size on screen at the dimensions' mean depth (LineDashedMaterial works in world units)
    const k = perPxN ? perPxSum / perPxN : 1;
    this.dashMat.dashSize = DASH_PX * k;
    this.dashMat.gapSize = GAP_PX * k;
    this.solid.end();
    this.dashed.end();
    this.over.end();
    this.flushDots();
    this.dotMat.size = DIM_DOT_PX * Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
    this.group.visible = this.solid.count + this.dashed.count + this.over.count + this.dotN > 0;
    for (const [id, el] of this.chips)
      if (!keep.has(id)) {
        el.remove();
        this.chips.delete(id);
      }
    this.status = status;
    this.group.updateMatrixWorld(true);
    return false;
  }

  // ---- a dimension ------------------------------------------------------------------------------

  /**
   * One end: the world point now (it follows its part) and as assembled (the number). A picked point is in its
   * body's frame; without one the end is the part's design frame (its placed origin), or its box centre when the
   * frame is the root's (a module drawn by its parts) or lies outside the part (DEFAULT).
   */
  private end(ref: string, point: Vec3 | undefined, root: THREE.Matrix4): { now: THREE.Vector3; rest: THREE.Vector3; hit: PartHit } | { why: "orphan" | "hidden" } {
    const hit = this.host.resolve(ref);
    if (!hit) return { why: "orphan" };
    if (hit.hidden || hit.box.isEmpty()) return { why: "hidden" };
    const isRoot = hit.frame.equals(root);
    let local: THREE.Vector3;
    if (point) local = new THREE.Vector3(...point);
    else {
      const o = new THREE.Vector3().applyMatrix4(hit.frame);
      const size = hit.box.getSize(new THREE.Vector3()).length();
      const near = hit.box.distanceToPoint(o) <= size * 0.25;
      local = !isRoot && near ? new THREE.Vector3() : hit.box.getCenter(new THREE.Vector3()).applyMatrix4(hit.frame.clone().invert());
    }
    const now = local.clone().applyMatrix4(hit.frame);
    const restFrame = isRoot ? undefined : this.host.bodyRest?.(hit.body);
    const rest = restFrame ? local.clone().applyMatrix4(restFrame) : now.clone();
    return { now, rest, hit };
  }

  private drawDimension(
    r: DimensionRecord,
    c: { toPx: (p: THREE.Vector3) => [number, number, boolean]; perPx: (p: THREE.Vector3) => number; root: THREE.Matrix4; rootInv: THREE.Matrix4; up: THREE.Vector3; keep: Set<string>; C: Colours; width: number; height: number },
  ): DimStatus {
    const a = this.end(r.ref, r.point, c.root);
    if ("why" in a) return { id: r.id, kind: "dimension", status: a.why };
    const b = this.end(r.to, r.toPoint, c.root);
    if ("why" in b) return { id: r.id, kind: "dimension", status: b.why };
    const tier = tierOf(r);
    // the number: the distance as assembled, in root mm (glTF metres were converted at the body boundary)
    const assembled = a.rest.clone().applyMatrix4(c.rootInv).distanceTo(b.rest.clone().applyMatrix4(c.rootInv));
    const value = r.valueMm ?? assembled;
    // the record's offset is root mm: turned into world axes by the root's rotation (a rigid root: no scale)
    const off = dimensionOffset(a.now, b.now, c.up, r.offset ? new THREE.Vector3(...r.offset).applyMatrix3(new THREE.Matrix3().setFromMatrix4(c.root)) : undefined);
    const mid = a.now.clone().add(b.now).multiplyScalar(0.5).add(off);
    const s = dimensionShape(a.now, b.now, off, c.perPx(mid));
    // extension lines dashed from the measured points past the dimension line, the line itself solid, dots at all four
    this.dashed.add(s.a, s.a3, c.C.extension);
    this.dashed.add(s.b, s.b3, c.C.extension);
    this.solid.add(s.a2, s.b2, c.C.line);
    for (const p of [s.a, s.b]) this.dot(p, c.C.line);
    for (const p of [s.a2, s.b2]) this.dot(p, c.C.line);
    const [x, y, on] = c.toPx(s.mid);
    const label = formatMm(value, r.toleranceMm);
    const st: DimStatus = { id: r.id, kind: "dimension", status: on ? "placed" : "offscreen", value: Math.round(value * 1000) / 1000, tier, label };
    if (!on || x < -40 || y < -40 || x > c.width + 40 || y > c.height + 40) {
      st.status = "offscreen";
      return st;
    }
    // the chip sits on the line's middle, pushed off it the way the line was offset (away from the parts) on screen
    const [ox, oy] = c.toPx(s.mid.clone().add(s.out.clone().multiplyScalar(c.perPx(s.mid) * 20)));
    const dl = Math.hypot(ox - x, oy - y) || 1;
    const px: [number, number] = [x + ((ox - x) / dl) * 14, y + ((oy - y) / dl) * 14];
    const chip = this.chip(`d:${r.id}`, "dim-chip", c.keep);
    const content = JSON.stringify([label, tier, r.title]);
    if (chip.dataset.content !== content) {
      chip.dataset.content = content;
      chip.replaceChildren();
      const doc = this.root.ownerDocument;
      if (r.title) {
        const t = doc.createElement("span");
        t.className = "dim-title";
        t.textContent = r.title;
        chip.appendChild(t);
      }
      const v = doc.createElement("span");
      v.className = "dim-v";
      v.textContent = label;
      const tg = doc.createElement("span");
      tg.className = "dim-tier";
      tg.textContent = tier.toUpperCase();
      chip.append(v, tg);
      chip.title = `${TIER_NOTE[tier]}${r.title ? ` · ${r.title}` : ""} · by ${r.author}`;
      chip.setAttribute("aria-label", `${r.title ? `${r.title}: ` : ""}${label}, ${tier}`);
    }
    chip.style.transform = `translate(${px[0].toFixed(1)}px, ${px[1].toFixed(1)}px) translate(-50%, -50%)`;
    st.labelPx = [Math.round(px[0]), Math.round(px[1])];
    return st;
  }

  // ---- an angle ---------------------------------------------------------------------------------

  private jointOf(r: AngleRecord): DimJoint | undefined {
    const js = this.host.joints?.() ?? [];
    return js.find((j) => j.id === r.ref) ?? js.find((j) => (j.path ?? j.part) === r.ref && (r.joint === undefined || j.id === r.joint) && j.type === "revolute") ?? js.find((j) => (j.path ?? j.part) === r.ref && (r.joint === undefined || j.id === r.joint));
  }

  private drawAngle(r: AngleRecord, c: { toPx: (p: THREE.Vector3) => [number, number, boolean]; perPx: (p: THREE.Vector3) => number; root: THREE.Matrix4; keep: Set<string>; C: Colours; width: number; height: number }): DimStatus {
    const j = this.jointOf(r);
    if (!j) return { id: r.id, kind: "angle", status: "orphan", why: "no joint with this id or part" };
    if (j.type !== "revolute") return { id: r.id, kind: "angle", status: "unsupported", why: `a ${j.type} joint (angles are drawn for revolute joints)` };
    const hit = this.host.resolve(j.path ?? j.part);
    if (!hit) return { id: r.id, kind: "angle", status: "orphan", why: "the joint's part is not drawn" };
    if (hit.hidden || hit.box.isEmpty()) return { id: r.id, kind: "angle", status: "hidden" };
    const rest = this.host.bodyRest?.(j.part);
    // the part's move since assembled (world): the joint's turn and any explode offset (a translation)
    const delta = rest ? hit.frame.clone().multiply(rest.clone().invert()) : new THREE.Matrix4();
    const originRest = new THREE.Vector3(...j.origin).applyMatrix4(c.root);
    const axis = new THREE.Vector3(...j.axis).transformDirection(c.root);
    const centreNow = hit.box.getCenter(new THREE.Vector3());
    const centreRest = centreNow.clone().applyMatrix4(delta.clone().invert());
    const { dir: restDir, arm } = restDirection(originRest, axis, centreRest);
    const frame: AngleFrame = { origin: originRest.clone().applyMatrix4(delta), axis, restDir, rest: j.rest, ...(j.min !== undefined ? { min: j.min } : {}), ...(j.max !== undefined ? { max: j.max } : {}) };
    const now = valueFromDelta(frame, delta);
    const perPx = c.perPx(frame.origin);
    const radius = Math.max(arm * ARC_SHARE, ARC_MIN_PX * perPx);
    const [lo, hi] = arcSpan(frame, now);
    // the arc over the parts as a 2 px line (WebGL lines are 1 px: two arcs a pixel apart) inside a 1 px halo of the
    // chip colour each side, so it reads on light and dark parts alike (the paper ink vanished on the drone's black
    // battery); the halo goes first, the ink on top (one draw, in order)
    this.over.polyline(arcPoints(frame, lo, hi, Math.max(0, radius - perPx)), c.C.chip);
    this.over.polyline(arcPoints(frame, lo, hi, radius + 2 * perPx), c.C.chip);
    this.over.polyline(arcPoints(frame, lo, hi, radius), c.C.line);
    this.over.polyline(arcPoints(frame, lo, hi, radius + perPx), c.C.line);
    const ticks = angleTicks(frame, now);
    for (const t of ticks) {
      if (t.kind === "now") continue;
      const [p, q] = tickAt(frame, t.value, radius);
      this.over.add(p, q, t.kind === "stop" ? c.C.stop : c.C.line);
    }
    // the arm at the current angle (accent), and a dashed line on along it to the part (the joint's moving direction)
    // the arm at the current angle (accent) through the part to the arc, then a dashed line on past the arc along it
    // (the joint's moving direction); the solid arm shows through the part as the ghost
    const dNow = directionAt(frame, now);
    const armEnd = frame.origin.clone().addScaledVector(dNow, radius);
    this.over.add(frame.origin, armEnd, c.C.accent);
    this.dashed.add(armEnd, frame.origin.clone().addScaledVector(dNow, radius * 1.22), c.C.accent);
    this.dot(frame.origin, c.C.line);
    // labels: NOW, the stops, REST, 0°, each past the arc's end; one that lands on an earlier one is left out
    const placed: { x: number; y: number; w: number }[] = [];
    const [ox, oy, on] = c.toPx(frame.origin);
    const st: DimStatus = { id: r.id, kind: "angle", status: on ? "placed" : "offscreen", value: Math.round(now * 100) / 100, label: ticks[0].label };
    if (!on) return st;
    ticks.forEach((t, i) => {
      const key = `a:${r.id}:${i}`;
      const p = frame.origin.clone().addScaledVector(directionAt(frame, t.value), radius * 1.32);
      const [x0, y, vis] = c.toPx(p);
      if (!vis) return;
      // the label leans away from the arc's centre: left of the axis on screen it ends at the point, right it starts
      // there; its box (about 7 px a character, DEFAULT) is moved down or up a line when it lands on an earlier one,
      // and left out when no line is free
      const w = t.label.length * 7 + 12;
      const left = x0 < ox - 4 ? x0 - w : x0 > ox + 4 ? x0 : x0 - w / 2;
      const free = (yy: number) => !placed.some((b) => left < b.x + b.w && b.x < left + w && yy - 8 < b.y + 8 && b.y - 8 < yy + 8);
      const yy = [y, y + 16, y - 16, y + 32, y - 32].find(free);
      if (yy === undefined) return;
      placed.push({ x: left, y: yy, w });
      const el = this.chip(key, `dim-ang ${t.kind}`, c.keep);
      if (el.textContent !== t.label) el.textContent = t.label;
      el.style.transform = `translate(${left.toFixed(1)}px, ${yy.toFixed(1)}px) translate(0, -50%)`;
      if (i === 0) st.labelPx = [Math.round(left + w / 2), Math.round(yy)];
    });
    return st;
  }

  // ---- pieces -----------------------------------------------------------------------------------

  private dot(p: THREE.Vector3, colour: THREE.Color) {
    if (![p.x, p.y, p.z].every(Number.isFinite)) return;
    if ((this.dotN + 1) * 3 > this.dotPos.length) {
      const pos = new Float32Array(this.dotPos.length * 2);
      const col = new Float32Array(this.dotCol.length * 2);
      pos.set(this.dotPos);
      col.set(this.dotCol);
      this.dotPos = pos;
      this.dotCol = col;
      this.dots.dispose();
      this.dots.setAttribute("position", new THREE.BufferAttribute(this.dotPos, 3).setUsage(THREE.DynamicDrawUsage));
      this.dots.setAttribute("color", new THREE.BufferAttribute(this.dotCol, 3).setUsage(THREE.DynamicDrawUsage));
    }
    const i = this.dotN * 3;
    this.dotPos[i] = p.x;
    this.dotPos[i + 1] = p.y;
    this.dotPos[i + 2] = p.z;
    this.dotCol[i] = colour.r;
    this.dotCol[i + 1] = colour.g;
    this.dotCol[i + 2] = colour.b;
    this.dotN++;
  }

  private flushDots() {
    for (const name of ["position", "color"]) {
      const a = this.dots.getAttribute(name) as THREE.BufferAttribute;
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.dotN * 3);
      a.needsUpdate = true;
    }
    this.dots.setDrawRange(0, this.dotN);
  }

  private chip(key: string, className: string, keep: Set<string>): HTMLDivElement {
    keep.add(key);
    let el = this.chips.get(key);
    if (!el) {
      el = this.root.ownerDocument.createElement("div");
      this.root.appendChild(el);
      this.chips.set(key, el);
    }
    if (el.className !== className) el.className = className;
    return el;
  }

  private hintText(text: string | undefined) {
    if (!text) {
      this.hint?.remove();
      this.hint = null;
      return;
    }
    if (!this.hint) {
      this.hint = this.root.ownerDocument.createElement("div");
      this.hint.className = "dim-hint";
      this.hint.setAttribute("role", "status");
      this.root.appendChild(this.hint);
    }
    if (this.hint.textContent !== text) this.hint.textContent = text;
  }

  dispose() {
    this.wheelOff();
    this.group.removeFromParent();
    this.solid.dispose();
    this.dashed.dispose();
    this.over.dispose();
    this.dots.dispose();
    for (const o of [this.solidLines, this.ghostLines, this.dashedLines, this.overLines]) (o.material as THREE.Material).dispose();
    this.dotMat.map?.dispose();
    this.dotMat.dispose();
    this.root.remove();
  }
}
