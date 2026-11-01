/**
 * Fits and tessellation statistics over one face's triangles (the mesh tier,
 * PB-1187). A face patch is the triangles a B-rep face became, taken from the
 * view sidecar's per-triangle feature ids (`_FEATURE_ID_0`) or, for a plain
 * GLB, the face's own primitive. Positions are mm in whatever frame the
 * caller chose (the world for assembly measurements, the part's frame for an
 * exact-tier match); ./faces.ts is where metres become mm.
 *
 * Written for this repository (clean room). The approach follows the
 * measurement notes in docs/specs/cad-view-research (review round 2,
 * BumpMesh/ScanRuler lane, section 7.5), in our own words: fit a primitive to
 * the picked region, report the residual and the coverage next to every
 * number, and treat anything finer than the residual as inconclusive.
 */
import { angleDeg, cross, dot, eigenSym3, len, norm, sub, type V3 } from "./linalg";

/** One face's triangles: 9 numbers per triangle (three corners), mm. Optional per-corner normals (unit). */
export interface FacePatch {
  positions: Float64Array;
  normals?: Float64Array;
}

export const triangleCount = (p: FacePatch) => Math.floor(p.positions.length / 9);

const corner = (a: Float64Array, t: number, k: number): V3 => [a[t * 9 + k * 3], a[t * 9 + k * 3 + 1], a[t * 9 + k * 3 + 2]];

/** Triangle normal scaled by twice its area. */
function areaNormal(p: FacePatch, t: number): V3 {
  const a = corner(p.positions, t, 0);
  return cross(sub(corner(p.positions, t, 1), a), sub(corner(p.positions, t, 2), a));
}

export function patchArea(p: FacePatch): number {
  let s = 0;
  for (let t = 0; t < triangleCount(p); t++) s += len(areaNormal(p, t)) / 2;
  return s;
}

/** Area-weighted centroid of the surface. */
export function patchCentroid(p: FacePatch): V3 {
  let w = 0;
  const c: V3 = [0, 0, 0];
  for (let t = 0; t < triangleCount(p); t++) {
    const a = len(areaNormal(p, t)) / 2;
    for (let k = 0; k < 3; k++) {
      const v = corner(p.positions, t, k);
      c[0] += (v[0] * a) / 3;
      c[1] += (v[1] * a) / 3;
      c[2] += (v[2] * a) / 3;
    }
    w += a;
  }
  return w > 0 ? [c[0] / w, c[1] / w, c[2] / w] : corner(p.positions, 0, 0);
}

/** Area-weighted mean of the triangle normals (unit; zero for a closed or symmetric surface such as a full hole). */
export function meanNormal(p: FacePatch): V3 {
  const n: V3 = [0, 0, 0];
  for (let t = 0; t < triangleCount(p); t++) {
    const an = areaNormal(p, t);
    n[0] += an[0];
    n[1] += an[1];
    n[2] += an[2];
  }
  return len(n) < 1e-9 * Math.max(1e-12, patchArea(p)) ? [0, 0, 0] : norm(n);
}

export function patchBounds(p: FacePatch): { min: V3; max: V3 } {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.positions.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p.positions[i + k]);
      max[k] = Math.max(max[k], p.positions[i + k]);
    }
  return { min, max };
}

const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
};

export interface TessellationStats {
  triangles: number;
  /** Edge lengths, mm. */
  edge: { median: number; p95: number; max: number };
  /**
   * Chord (sagitta) error estimate, mm: how far a point on a triangle can be from the true surface. Per edge
   * `L * phi / 8`, phi the angle between the normals at its ends (a circle of radius r cut into chords of
   * length L = r * phi sags by r * phi^2 / 8 = L * phi / 8). Zero for a flat face.
   */
  sagitta: { p95: number; max: number };
}

/**
 * The part of an edge that runs across the surface's bend: the bend between normals na and nb is about their
 * cross product, so only the edge's component perpendicular to that line sags (a long edge along a cylinder's
 * axis sags nothing).
 */
function acrossCurvature(e: V3, na: V3, nb: V3): number {
  const t = cross(na, nb);
  const lt = len(t);
  if (lt < 1e-12) return len(e);
  const u: V3 = [t[0] / lt, t[1] / lt, t[2] / lt];
  const along = dot(e, u);
  return len([e[0] - u[0] * along, e[1] - u[1] * along, e[2] - u[2] * along]);
}

/** DEFAULT: neighbouring triangles turning more than this are a crease, not a curved surface's chords. */
export const CREASE_DEG = 40;

/** Edge lengths and the chord error of the tessellation (the mesh tier's tolerance comes from these). */
export function tessellationStats(p: FacePatch): TessellationStats {
  const n = triangleCount(p);
  const lengths: number[] = [];
  const sag: number[] = [];
  // per-corner normals when the mesh has them; else the normals of the two triangles that share an edge
  const edgeTris = new Map<string, { tris: number[]; normals: V3[] }>();
  const key = (a: V3) => `${Math.round(a[0] * 1e4)},${Math.round(a[1] * 1e4)},${Math.round(a[2] * 1e4)}`;
  for (let t = 0; t < n; t++) {
    const fn = norm(areaNormal(p, t));
    for (let k = 0; k < 3; k++) {
      const a = corner(p.positions, t, k);
      const b = corner(p.positions, t, (k + 1) % 3);
      const L = len(sub(b, a));
      lengths.push(L);
      if (p.normals) {
        const na = corner(p.normals, t, k);
        const nb = corner(p.normals, t, (k + 1) % 3);
        const phi = (angleDeg(na, nb) * Math.PI) / 180;
        if (Number.isFinite(phi) && phi <= (CREASE_DEG * Math.PI) / 180) sag.push((acrossCurvature(sub(b, a), na, nb) * phi) / 8);
      } else {
        const ek = [key(a), key(b)].sort().join("|");
        const e = edgeTris.get(ek) ?? { tris: [], normals: [] };
        e.normals.push(fn);
        e.tris.push(t);
        edgeTris.set(ek, e);
      }
    }
  }
  if (!p.normals)
    for (const e of edgeTris.values()) {
      if (e.normals.length < 2) continue;
      const phi = (angleDeg(e.normals[0], e.normals[1]) * Math.PI) / 180;
      // a crease (an edge between two B-rep faces, a box's corner) is not curvature: DEFAULT 40 degrees, the
      // crease angle the view sidecar splits normals at
      if (!Number.isFinite(phi) || phi === 0 || phi > (CREASE_DEG * Math.PI) / 180) continue;
      // the bend runs along the shared edge: the chord across it is the two triangles' widest extent across the bend
      let across = 0;
      for (const tt of e.tris.slice(0, 2))
        for (let k = 0; k < 3; k++) across = Math.max(across, acrossCurvature(sub(corner(p.positions, tt, (k + 1) % 3), corner(p.positions, tt, k)), e.normals[0], e.normals[1]));
      sag.push((across * phi) / 8);
    }
  let maxL = 0;
  for (const l of lengths) maxL = Math.max(maxL, l);
  let maxS = 0;
  for (const s of sag) maxS = Math.max(maxS, s);
  return { triangles: n, edge: { median: quantile(lengths, 0.5), p95: quantile(lengths, 0.95), max: maxL }, sagitta: { p95: quantile(sag, 0.95), max: maxS } };
}

export interface PlaneFit {
  kind: "plane";
  point: V3;
  normal: V3;
  /** RMS and largest distance of the vertices from the fitted plane, mm. */
  rms: number;
  max: number;
  area: number;
}

/** Total least squares plane through the vertices (area-weighted), normal oriented with the triangles. */
export function fitPlane(p: FacePatch): PlaneFit {
  const c = patchCentroid(p);
  const cov = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const n = triangleCount(p);
  for (let t = 0; t < n; t++) {
    const w = len(areaNormal(p, t)) / 2 || 1e-12;
    for (let k = 0; k < 3; k++) {
      const d = sub(corner(p.positions, t, k), c);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += w * d[i] * d[j];
    }
  }
  let normal = eigenSym3(cov).vectors[0];
  const mean = meanNormal(p);
  if (dot(normal, mean) < 0) normal = [-normal[0], -normal[1], -normal[2]];
  let sq = 0;
  let max = 0;
  for (let i = 0; i < p.positions.length; i += 3) {
    const d = Math.abs(dot(sub([p.positions[i], p.positions[i + 1], p.positions[i + 2]], c), normal));
    sq += d * d;
    max = Math.max(max, d);
  }
  return { kind: "plane", point: c, normal, rms: Math.sqrt(sq / Math.max(1, p.positions.length / 3)), max, area: patchArea(p) };
}

export interface CylinderFit {
  kind: "cylinder";
  /** A point on the axis (the circle's centre in the plane through the patch's centroid). */
  point: V3;
  axis: V3;
  radius: number;
  diameter: number;
  /** RMS and largest deviation of the vertices from the fitted radius, mm. */
  rms: number;
  max: number;
  /** Degrees of the circle the patch covers (360: a full hole or pin). */
  coverageDeg: number;
  /** Extent along the axis, mm. */
  length: number;
  area: number;
}

/**
 * Cylinder through the vertices: the axis is the direction the surface
 * normals avoid (smallest eigenvector of their area-weighted scatter), the
 * circle a least-squares fit in the plane across the axis (algebraic start,
 * then geometric Gauss-Newton). Undefined when the patch is flat.
 */
export function fitCylinder(p: FacePatch): CylinderFit | undefined {
  const n = triangleCount(p);
  if (n < 2) return undefined;
  const S = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  let wsum = 0;
  for (let t = 0; t < n; t++) {
    const an = areaNormal(p, t);
    const w = len(an);
    if (!w) continue;
    const u = norm(an);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) S[i][j] += w * u[i] * u[j];
    wsum += w;
  }
  if (!wsum) return undefined;
  const e = eigenSym3(S);
  // a flat patch has all its normal scatter in one direction: no axis to speak of
  if (e.values[1] / wsum < 1e-3) return undefined;
  const axis = e.vectors[0];
  const [ux, uy] = [e.vectors[1], e.vectors[2]];
  const origin = patchCentroid(p);
  const pts: [number, number, number][] = [];
  for (let i = 0; i < p.positions.length; i += 3) {
    const d = sub([p.positions[i], p.positions[i + 1], p.positions[i + 2]], origin);
    pts.push([dot(d, ux), dot(d, uy), dot(d, axis)]);
  }
  // algebraic circle (Kasa): x^2 + y^2 + D x + E y + F = 0, normal equations
  const A = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const b = [0, 0, 0];
  for (const [x, y] of pts) {
    const r = [x, y, 1];
    const z = -(x * x + y * y);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) A[i][j] += r[i] * r[j];
      b[i] += r[i] * z;
    }
  }
  const sol = solve3(A, b);
  if (!sol) return undefined;
  let cx = -sol[0] / 2;
  let cy = -sol[1] / 2;
  let r = Math.sqrt(Math.max(0, cx * cx + cy * cy - sol[2]));
  // geometric refinement: minimise sum (|p - c| - r)^2
  for (let it = 0; it < 20; it++) {
    const JtJ = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    const Jtr = [0, 0, 0];
    for (const [x, y] of pts) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.hypot(dx, dy) || 1e-12;
      const res = d - r;
      const J = [-dx / d, -dy / d, -1];
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) JtJ[i][j] += J[i] * J[j];
        Jtr[i] += J[i] * res;
      }
    }
    const step = solve3(JtJ, Jtr.map((v) => -v));
    if (!step) break;
    cx += step[0];
    cy += step[1];
    r += step[2];
    if (Math.hypot(step[0], step[1], step[2]) < 1e-10) break;
  }
  if (!(r > 0) || !Number.isFinite(r)) return undefined;
  let sq = 0;
  let max = 0;
  let zmin = Infinity;
  let zmax = -Infinity;
  const angles: number[] = [];
  for (const [x, y, z] of pts) {
    const d = Math.abs(Math.hypot(x - cx, y - cy) - r);
    sq += d * d;
    max = Math.max(max, d);
    zmin = Math.min(zmin, z);
    zmax = Math.max(zmax, z);
    angles.push(Math.atan2(y - cy, x - cx));
  }
  angles.sort((a, c) => a - c);
  let gap = angles.length ? angles[0] + 2 * Math.PI - angles[angles.length - 1] : 2 * Math.PI;
  for (let i = 1; i < angles.length; i++) gap = Math.max(gap, angles[i] - angles[i - 1]);
  const point: V3 = [origin[0] + ux[0] * cx + uy[0] * cy, origin[1] + ux[1] * cx + uy[1] * cy, origin[2] + ux[2] * cx + uy[2] * cy];
  return {
    kind: "cylinder",
    point,
    axis,
    radius: r,
    diameter: 2 * r,
    rms: Math.sqrt(sq / Math.max(1, pts.length)),
    max,
    coverageDeg: ((2 * Math.PI - gap) * 180) / Math.PI,
    length: zmax - zmin,
    area: patchArea(p),
  };
}

/** Solve a 3x3 linear system (Gaussian elimination with partial pivoting); undefined when singular. */
export function solve3(A: number[][], b: number[]): number[] | undefined {
  const m = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (Math.abs(m[p][c]) < 1e-14) return undefined;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

export type SurfaceKind = "plane" | "cylinder" | "other";

export interface SurfaceFit {
  kind: SurfaceKind;
  plane: PlaneFit;
  cylinder?: CylinderFit;
  /** The patch's size (bounding box diagonal), mm. */
  extent: number;
}

/**
 * What the face is, from its fits: a plane when the vertices lie within
 * `1 um + 1e-4 x the patch's size` of the fitted plane (DEFAULT), a cylinder
 * when the circle fit holds to 1 % of the radius (DEFAULT, at least 1 um)
 * over at least 30 degrees of arc (DEFAULT), else other (a fillet, a
 * spline). `quantization` (mm) widens both bands by the position grid of a
 * quantized mesh.
 */
export function classifySurface(p: FacePatch, quantization = 0): SurfaceFit {
  const plane = fitPlane(p);
  const b = patchBounds(p);
  const extent = len(sub(b.max, b.min));
  const flatTol = 1e-3 + 1e-4 * extent + quantization; // DEFAULT
  if (plane.max <= flatTol) return { kind: "plane", plane, extent };
  const cylinder = fitCylinder(p);
  if (cylinder && cylinder.max <= Math.max(1e-3, 0.01 * cylinder.radius) + quantization && cylinder.coverageDeg >= 30) return { kind: "cylinder", plane, cylinder, extent }; // DEFAULT
  return { kind: "other", plane, ...(cylinder ? { cylinder } : {}), extent };
}

// ---------------------------------------------------------------------------
// distances on triangles
// ---------------------------------------------------------------------------

/** Closest point of triangle (a, b, c) to p (by the Voronoi regions of the triangle). */
export function closestOnTriangle(p: V3, a: V3, b: V3, c: V3): V3 {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v];
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w];
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w];
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
}

/** Closest points of segments p1-q1 and p2-q2. */
export function closestSegments(p1: V3, q1: V3, p2: V3, q2: V3): [V3, V3] {
  const d1 = sub(q1, p1);
  const d2 = sub(q2, p2);
  const r = sub(p1, p2);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  let s = 0;
  let t = 0;
  if (a <= 1e-18 && e <= 1e-18) return [p1, p2];
  if (a <= 1e-18) t = Math.min(1, Math.max(0, f / e));
  else {
    const c = dot(d1, r);
    if (e <= 1e-18) s = Math.min(1, Math.max(0, -c / a));
    else {
      const b = dot(d1, d2);
      const den = a * e - b * b;
      s = den > 1e-18 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.min(1, Math.max(0, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.min(1, Math.max(0, (b - c) / a));
      }
    }
  }
  return [
    [p1[0] + d1[0] * s, p1[1] + d1[1] * s, p1[2] + d1[2] * s],
    [p2[0] + d2[0] * t, p2[1] + d2[1] * t, p2[2] + d2[2] * t],
  ];
}

/** Nearest point of the patch's surface to p. */
export function nearestOnPatch(p: V3, patch: FacePatch): { point: V3; distance: number } {
  let best: V3 = corner(patch.positions, 0, 0);
  let bd = Infinity;
  for (let t = 0; t < triangleCount(patch); t++) {
    const q = closestOnTriangle(p, corner(patch.positions, t, 0), corner(patch.positions, t, 1), corner(patch.positions, t, 2));
    const d = len(sub(q, p));
    if (d < bd) {
      bd = d;
      best = q;
    }
  }
  return { point: best, distance: bd };
}

/** DEFAULT: at most this many triangle pairs are compared exhaustively; above it the larger patch is thinned. */
export const MAX_PAIR_WORK = 4_000_000;

/**
 * The minimum distance between two patches (vertex to triangle both ways,
 * and edge to edge), with the closest points. `approximate` when the pair
 * was too big and the larger side was thinned to MAX_PAIR_WORK pairs.
 */
export function patchDistance(a: FacePatch, b: FacePatch): { distance: number; pointA: V3; pointB: V3; approximate: boolean } {
  let A = a;
  let B = b;
  let approximate = false;
  const work = triangleCount(a) * triangleCount(b);
  if (work > MAX_PAIR_WORK) {
    approximate = true;
    const stride = Math.ceil(work / MAX_PAIR_WORK);
    const thin = (p: FacePatch): FacePatch => {
      const n = triangleCount(p);
      const out = new Float64Array(Math.ceil(n / stride) * 9);
      let o = 0;
      for (let t = 0; t < n; t += stride) for (let k = 0; k < 9; k++) out[o++] = p.positions[t * 9 + k];
      return { positions: out.subarray(0, o) };
    };
    if (triangleCount(a) >= triangleCount(b)) A = thin(a);
    else B = thin(b);
  }
  let best = { distance: Infinity, pointA: [0, 0, 0] as V3, pointB: [0, 0, 0] as V3 };
  const consider = (pa: V3, pb: V3) => {
    const d = len(sub(pa, pb));
    if (d < best.distance) best = { distance: d, pointA: pa, pointB: pb };
  };
  const na = triangleCount(A);
  const nb = triangleCount(B);
  for (let i = 0; i < na; i++) {
    const ta = [corner(A.positions, i, 0), corner(A.positions, i, 1), corner(A.positions, i, 2)];
    for (let j = 0; j < nb; j++) {
      const tb = [corner(B.positions, j, 0), corner(B.positions, j, 1), corner(B.positions, j, 2)];
      for (const v of ta) consider(v, closestOnTriangle(v, tb[0], tb[1], tb[2]));
      for (const v of tb) consider(closestOnTriangle(v, ta[0], ta[1], ta[2]), v);
      for (let k = 0; k < 3; k++)
        for (let l = 0; l < 3; l++) {
          const [pa, pb] = closestSegments(ta[k], ta[(k + 1) % 3], tb[l], tb[(l + 1) % 3]);
          consider(pa, pb);
        }
      if (best.distance === 0) return { ...best, approximate };
    }
  }
  return { ...best, approximate };
}
