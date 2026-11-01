/**
 * Small vector and matrix helpers for the measurement tiers, tours and the
 * critic (PB-1187, PB-1188): plain number arrays, no three.js, so every
 * function here is pure and runs the same in the page, in node tests and in
 * an agent's process.
 *
 * Matrices are UHD's `Mat4`: 16 numbers, row-major (UHD `toMatrix4` hands
 * them to three's `Matrix4.set`, which takes rows), translation in mm in
 * elements 3, 7 and 11. Lengths are mm and the frame is Z-up unless a
 * function says otherwise.
 */

export type V3 = [number, number, number];
/** Row-major 4x4 (UHD Mat4). */
export type M4 = number[];

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const dist = (a: V3, b: V3): number => len(sub(a, b));
export const lerp3 = (a: V3, b: V3, k: number): V3 => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
export function norm(a: V3): V3 {
  const l = len(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}
/** Angle between two directions, degrees (0..180). */
export function angleDeg(a: V3, b: V3): number {
  const la = len(a);
  const lb = len(b);
  if (!la || !lb) return NaN;
  return (Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (la * lb)))) * 180) / Math.PI;
}
/** Angle between two lines (directions without sign), degrees (0..90). */
export function lineAngleDeg(a: V3, b: V3): number {
  const d = angleDeg(a, b);
  return d > 90 ? 180 - d : d;
}
/** Any unit vector perpendicular to `a`. */
export function perpendicular(a: V3): V3 {
  const n = norm(a);
  const helper: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return norm(cross(n, helper));
}

export const IDENTITY: M4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function mul(a: M4, b: M4): M4 {
  const o = new Array<number>(16).fill(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) o[r * 4 + c] += a[r * 4 + k] * b[k * 4 + c];
  return o;
}
export const applyPoint = (m: M4, p: V3): V3 => [
  m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
  m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
  m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
];
export const applyDir = (m: M4, d: V3): V3 => [m[0] * d[0] + m[1] * d[1] + m[2] * d[2], m[4] * d[0] + m[5] * d[1] + m[6] * d[2], m[8] * d[0] + m[9] * d[1] + m[10] * d[2]];
export const translation = (t: V3): M4 => [1, 0, 0, t[0], 0, 1, 0, t[1], 0, 0, 1, t[2], 0, 0, 0, 1];

/** Inverse of a rigid transform (rotation + translation). */
export function invertRigid(m: M4): M4 {
  const r = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
  const t: V3 = [m[3], m[7], m[11]];
  const it: V3 = [-(r[0] * t[0] + r[1] * t[1] + r[2] * t[2]), -(r[3] * t[0] + r[4] * t[1] + r[5] * t[2]), -(r[6] * t[0] + r[7] * t[1] + r[8] * t[2])];
  return [r[0], r[1], r[2], it[0], r[3], r[4], r[5], it[1], r[6], r[7], r[8], it[2], 0, 0, 0, 1];
}

/** Rotation by `deg` about the unit axis `a` through `pivot` (Rodrigues). */
export function rotationAbout(axis: V3, deg: number, pivot: V3 = [0, 0, 0]): M4 {
  const [x, y, z] = norm(axis);
  const th = (deg * Math.PI) / 180;
  const c = Math.cos(th);
  const s = Math.sin(th);
  const C = 1 - c;
  const R: M4 = [x * x * C + c, x * y * C - z * s, x * z * C + y * s, 0, y * x * C + z * s, y * y * C + c, y * z * C - x * s, 0, z * x * C - y * s, z * y * C + x * s, z * z * C + c, 0, 0, 0, 0, 1];
  return mul(translation(pivot), mul(R, translation(scale(pivot, -1))));
}

/** The smallest rotation taking unit direction `from` onto `to` (about their common perpendicular). */
export function rotationBetween(from: V3, to: V3, pivot: V3 = [0, 0, 0]): M4 {
  const a = norm(from);
  const b = norm(to);
  const d = dot(a, b);
  if (d > 1 - 1e-12) return IDENTITY.slice();
  if (d < -1 + 1e-12) return rotationAbout(perpendicular(a), 180, pivot);
  return rotationAbout(cross(a, b), angleDeg(a, b), pivot);
}

/**
 * Eigen-decomposition of a symmetric 3x3 matrix (Jacobi rotations): values
 * ascending, vectors as unit columns in the same order. Used for plane
 * normals (smallest eigenvector of a covariance) and cylinder axes (smallest
 * eigenvector of the normals' scatter).
 */
export function eigenSym3(m: number[][]): { values: V3; vectors: [V3, V3, V3] } {
  const a = m.map((r) => r.slice());
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-15) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ]) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p];
        const akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k];
        const aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p];
        const vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
  const values = order.map((i) => a[i][i]) as V3;
  const vectors = order.map((i) => norm([v[0][i], v[1][i], v[2][i]])) as [V3, V3, V3];
  return { values, vectors };
}

/**
 * A placement squared up to a rotation and translation (Gram-Schmidt on the columns, keeping the first): a
 * matrix composed from rounded numbers (a display file's 4-decimal placement) is off orthonormal by about 1e-4,
 * and the view state takes only rigid placements (within 1e-6).
 */
export function orthonormalize(m: M4): M4 {
  const x = norm([m[0], m[4], m[8]]);
  const y0: V3 = [m[1], m[5], m[9]];
  const y = norm(sub(y0, scale(x, dot(y0, x))));
  const z = cross(x, y);
  return [x[0], y[0], z[0], m[3], x[1], y[1], z[1], m[7], x[2], y[2], z[2], m[11], 0, 0, 0, 1];
}

/** Round to a resolution (mm results to the micrometre by default). */
export const round = (x: number, step = 1e-4): number => Math.round(x * (1 / step)) / (1 / step);
export const round3 = (p: V3, step = 1e-4): V3 => [round(p[0], step), round(p[1], step), round(p[2], step)];
