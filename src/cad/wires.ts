/**
 * Wire harness geometry for the 3D view (PB-775).
 *
 * A route's bundle is a rope: a verlet chain pinned at the pads, at zip-tie
 * points along the arm and at the lead ends, with a little slack between
 * pins, under gravity, resting on the frame's top surface instead of passing
 * through it. The individual conductors are then laid around the bundle's
 * centreline with a slow twist, fanning out to their own pads and leads at
 * the ends.
 */
import * as THREE from "three";

export interface RopeOptions {
  /** Extra length over the straight distance between consecutive pins (0.06 = 6 %). */
  slack?: number;
  /** Segment length target (mm). */
  segment?: number;
  /** Returns the lowest z a point at (x, y) may take (surface under the rope, incl. its radius). */
  floor?: (x: number, y: number) => number;
  iterations?: number;
}

/** Verlet rope through pinned points; returns the relaxed centreline. */
export function rope(pins: THREE.Vector3[], o: RopeOptions = {}): THREE.Vector3[] {
  const slack = o.slack ?? 0.06;
  const seg = o.segment ?? 2.5;
  const pts: THREE.Vector3[] = [];
  const pinned: boolean[] = [];
  const rest: number[] = [];
  for (let i = 0; i < pins.length - 1; i++) {
    const a = pins[i];
    const b = pins[i + 1];
    const n = Math.max(2, Math.round(a.distanceTo(b) / seg));
    const len = (a.distanceTo(b) * (1 + slack)) / n;
    for (let k = 0; k < n; k++) {
      pts.push(a.clone().lerp(b, k / n));
      pinned.push(k === 0);
      rest.push(len);
    }
  }
  pts.push(pins[pins.length - 1].clone());
  pinned.push(true);
  const prev = pts.map((p) => p.clone());
  const g = new THREE.Vector3(0, 0, -0.06);
  const iters = o.iterations ?? 240;
  for (let step = 0; step < iters; step++) {
    // integrate
    for (let i = 0; i < pts.length; i++) {
      if (pinned[i]) continue;
      const v = pts[i].clone().sub(prev[i]).multiplyScalar(0.96);
      prev[i].copy(pts[i]);
      pts[i].add(v).add(g);
    }
    // constraints
    for (let c = 0; c < 12; c++) {
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const d = b.clone().sub(a);
        const dist = d.length() || 1e-6;
        const diff = (dist - rest[i]) / dist;
        if (diff <= 0) continue; // ropes resist stretching, not compression
        const wa = pinned[i] ? 0 : pinned[i + 1] ? 1 : 0.5;
        const wb = pinned[i + 1] ? 0 : pinned[i] ? 1 : 0.5;
        a.addScaledVector(d, diff * wa);
        b.addScaledVector(d, -diff * wb);
      }
      if (o.floor) {
        for (let i = 0; i < pts.length; i++) {
          if (pinned[i]) continue;
          const f = o.floor(pts[i].x, pts[i].y);
          if (pts[i].z < f) pts[i].z = f;
        }
      }
    }
  }
  return pts;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/**
 * Conductors around a bundle centreline: each strand starts at its own pad,
 * converges into a twisted bundle (radius `r`, one turn per `pitch` mm) and
 * fans out to its own end.
 */
export function strands(centre: THREE.Vector3[], starts: THREE.Vector3[], ends: THREE.Vector3[], r = 1.0, pitch = 28, fan = 9): THREE.Vector3[][] {
  const n = starts.length;
  const curve = new THREE.CatmullRomCurve3(centre);
  const total = curve.getLength();
  const samples = Math.max(40, Math.round(total / 1.2));
  const frames = curve.computeFrenetFrames(samples, false);
  const out: THREE.Vector3[][] = starts.map(() => []);
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const s = t * total;
    const p = curve.getPointAt(t);
    const nrm = frames.normals[i];
    const bin = frames.binormals[i];
    const wStart = 1 - smooth(Math.min(1, s / fan));
    const wEnd = smooth(Math.max(0, (s - (total - fan)) / fan));
    for (let k = 0; k < n; k++) {
      const a = (2 * Math.PI * k) / n + (2 * Math.PI * s) / pitch;
      const twisted = p.clone().addScaledVector(nrm, Math.cos(a) * r).addScaledVector(bin, Math.sin(a) * r);
      const q = twisted
        .clone()
        .lerp(starts[k].clone().add(p.clone().sub(centre[0])), wStart)
        .lerp(ends[k].clone().add(p.clone().sub(centre[centre.length - 1])), wEnd);
      out[k].push(q);
    }
  }
  return out;
}
