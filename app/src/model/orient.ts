// Auto orient, ported from desktop's libslic3r/Orient.cpp (AutoOrienter), with the parameters
// desktop's orient job uses by default ("Optimize support interface area": min_area on, so
// setMinimalSupportAreaPrams and min_volume off). It tries the directions of the largest faces
// of the mesh and of its convex hull, plus 18 fixed ones, as the bottom, scores each by overhang,
// bottom area and low-angle faces, and turns the best one down. With an auxiliary fan, it then
// turns the object about Z so most overhangs face the fan (find_cooling_direction2).
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Hull, MeshData } from './hull';

// setMinimalSupportAreaPrams (OrientJob.cpp).
const P = {
  RELATIVE_F: 20,
  CONTOUR_F: 0.5,
  BOTTOM_F: 2.5,
  BOTTOM_HULL_F: 0.1,
  TAR_C: 0.1,
  TAR_D: 1,
  FIRST_LAY_H: 0.2,
  LAF_MAX: 0.999,
  LAF_MIN: 0.97,
  TAR_LAF: 0.001,
  TAR_PROJ_AREA: 0.1,
  BOTTOM_MIN: 0.1,
};
const EPSILON = 1e-4; // libslic3r.h

/** Faces as flat arrays: corners (9 per face), unit normals and areas. */
interface Faces {
  v: Float32Array;
  n: Float32Array;
  a: Float32Array;
  count: number;
}

function faces(v: Float32Array): Faces {
  const count = v.length / 9;
  const n = new Float32Array(count * 3),
    a = new Float32Array(count);
  for (let f = 0; f < count; f++) {
    const o = f * 9;
    const ux = v[o + 3]! - v[o]!,
      uy = v[o + 4]! - v[o + 1]!,
      uz = v[o + 5]! - v[o + 2]!;
    const wx = v[o + 6]! - v[o]!,
      wy = v[o + 7]! - v[o + 1]!,
      wz = v[o + 8]! - v[o + 2]!;
    const cx = uy * wz - uz * wy,
      cy = uz * wx - ux * wz,
      cz = ux * wy - uy * wx;
    const len = Math.hypot(cx, cy, cz);
    // Eigen's normalized() leaves a zero vector as it is.
    if (len > 0) {
      n[f * 3] = cx / len;
      n[f * 3 + 1] = cy / len;
      n[f * 3 + 2] = cz / len;
    }
    a[f] = len / 2;
  }
  return { v, n, a, count };
}

/** The triangles of a mesh under the linear part `m` (9 numbers per face). */
function transformed(mesh: MeshData, m: Matrix4): Float32Array {
  const { positions: pos, index: idx } = mesh;
  const n = idx ? idx.length : pos.length / 3;
  const e = m.elements;
  const out = new Float32Array(n * 3);
  for (let k = 0; k < n; k++) {
    const v = (idx ? idx[k]! : k) * 3;
    const x = pos[v]!,
      y = pos[v + 1]!,
      z = pos[v + 2]!;
    out[k * 3] = e[0]! * x + e[4]! * y + e[8]! * z;
    out[k * 3 + 1] = e[1]! * x + e[5]! * y + e[9]! * z;
    out[k * 3 + 2] = e[2]! * x + e[6]! * y + e[10]! * z;
  }
  return out;
}

/** area_cumulation_accurate: the normals (exact, of each group's largest face) of the `count` largest groups of alike faces (normals equal to 0.001). */
function largestDirections(f: Faces, count: number): Vector3[] {
  // The quantized normal as one number (each part floor(x · 1000), within ±1000).
  const groups = new Map<number, { total: number; max: number; at: number }>();
  const q = (x: number) => Math.floor(x * 1000) + 1000;
  for (let i = 0; i < f.count; i++) {
    const key = (q(f.n[i * 3]!) * 2001 + q(f.n[i * 3 + 1]!)) * 2001 + q(f.n[i * 3 + 2]!);
    const a = f.a[i]!;
    const g = groups.get(key);
    if (!g) groups.set(key, { total: a, max: a, at: i });
    else {
      g.total += a;
      if (a > g.max) {
        g.max = a;
        g.at = i;
      }
    }
  }
  return [...groups.values()]
    .sort((x, y) => y.total - x.total)
    .slice(0, count)
    .map((g) => new Vector3(f.n[g.at * 3], f.n[g.at * 3 + 1], f.n[g.at * 3 + 2]));
}

const S = Math.SQRT1_2;
const SUPPLEMENTS: [number, number, number][] = [
  [0, 0, -1],
  [S, 0, -S],
  [0, S, -S],
  [-S, 0, -S],
  [0, -S, -S],
  [1, 0, 0],
  [S, S, 0],
  [0, 1, 0],
  [-S, S, 0],
  [-1, 0, 0],
  [-S, -S, 0],
  [0, -1, 0],
  [S, -S, 0],
  [S, 0, S],
  [0, S, S],
  [-S, 0, S],
  [0, -S, S],
  [0, 0, 1],
];

/** Eigen's isApprox: |a − b| ≤ tol · min(|a|, |b|). */
const approx = (a: Vector3, b: Vector3, tol: number) => a.distanceTo(b) <= tol * Math.min(a.length(), b.length());

export interface OrientOptions {
  /** support_threshold_angle (degrees). */
  overhangAngle: number;
  /** Where the auxiliary fan blows from (fan_direction with auxiliary_fan), or none. */
  coolingDirection?: Vector3 | null;
}

/**
 * The rotation that orients a mesh (with its convex hull) shown under `linear` (the instance's rotation and scale) for
 * printing; premultiply it to the instance's matrix.
 */
export function orientRotation(meshData: MeshData, hullData: Hull, linear: Matrix4, opts: OrientOptions): Matrix4 {
  const mesh = faces(transformed(meshData, linear));
  const hull = faces(transformed(hullData, linear));
  // The overhang threshold, as the dot product of a face's normal with the up direction.
  const ascent = Math.cos(Math.PI - (opts.overhangAngle * Math.PI) / 180);

  // Candidate bottoms: the original one, the largest faces' and hull faces' directions, and 18 fixed ones.
  const candidates = [
    new Vector3(0, 0, -1),
    ...largestDirections(mesh, 10),
    ...largestDirections(hull, 14),
    ...SUPPLEMENTS.map((s) => new Vector3(...s)),
  ];
  const orientations: Vector3[] = [candidates[0]!];
  const zero = new Vector3();
  for (const c of candidates.slice(1)) {
    if (approx(c, zero, 1e-7) || c.equals(zero) || orientations.some((o) => approx(o, c, 1e-7))) continue;
    orientations.push(c);
  }

  const zMax = new Float32Array(mesh.count);
  const mv = mesh.v,
    mn = mesh.n,
    ma = mesh.a,
    hv = hull.v,
    ha = hull.a;
  /** project_vertices, get_features (min_volume off) and target_function for one bottom; `keep` gets the faces' details. */
  const score = (up: Vector3, keep?: { bottom2: Uint8Array; proj: Float32Array }) => {
    const ux = up.x,
      uy = up.y,
      uz = up.z;
    let minZ = Infinity;
    for (let i = 0, k = 0; i < mesh.count; i++, k += 9) {
      const z0 = mv[k]! * ux + mv[k + 1]! * uy + mv[k + 2]! * uz;
      const z1 = mv[k + 3]! * ux + mv[k + 4]! * uy + mv[k + 5]! * uz;
      const z2 = mv[k + 6]! * ux + mv[k + 7]! * uy + mv[k + 8]! * uz;
      const mx = Math.max(z0, z1, z2);
      const mi = Math.min(z0, z1, z2);
      zMax[i] = mx;
      if (mi < minZ) minZ = mi;
    }
    const lim1 = minZ + P.FIRST_LAY_H - EPSILON,
      lim2 = minZ + P.FIRST_LAY_H / 2 - EPSILON,
      limLaf = minZ + P.FIRST_LAY_H;
    let bottom1 = 0,
      bottom2 = 0,
      overhang = 0,
      laf = 0,
      bottomHull = 0;
    for (let i = 0; i < mesh.count; i++) {
      const a = ma[i]!,
        z = zMax[i]!;
      const b2 = z < lim2;
      if (z < lim1) bottom1 += a;
      if (b2) bottom2 += a;
      const np = mn[i * 3]! * ux + mn[i * 3 + 1]! * uy + mn[i * 3 + 2]! * uz;
      if (keep) {
        keep.proj[i] = np;
        keep.bottom2[i] = b2 ? 1 : 0;
      }
      if (np < ascent && !b2) overhang += a;
      const abs = np < 0 ? -np : np;
      if (abs < P.LAF_MAX && abs > P.LAF_MIN && z > limLaf) laf += a;
    }
    for (let i = 0, k = 0; i < hull.count; i++, k += 9) {
      const z0 = hv[k]! * ux + hv[k + 1]! * uy + hv[k + 2]! * uz;
      const z1 = hv[k + 3]! * ux + hv[k + 4]! * uy + hv[k + 5]! * uz;
      const z2 = hv[k + 6]! * ux + hv[k + 7]! * uy + hv[k + 8]! * uz;
      if (Math.fround(Math.max(z0, z1, z2)) < lim1) bottomHull += ha[i]!;
    }
    const bottom = bottom1 * 0.5 + bottom2;
    const contour = 4 * Math.sqrt(bottom);
    // target_function (min_volume off; the projected area is never computed, so 0)
    let cost =
      (P.RELATIVE_F * (overhang * P.TAR_C + P.TAR_D + P.TAR_LAF * laf)) /
      (P.TAR_D + P.CONTOUR_F * contour + P.BOTTOM_F * bottom + P.BOTTOM_HULL_F * bottomHull + P.TAR_PROJ_AREA * 0);
    if (bottom < P.BOTTOM_MIN) cost += 100;
    return cost;
  };
  const results = orientations.map((o) => {
    const up = o.clone().negate();
    return { orientation: up, cost: score(up) };
  });
  // The cheapest; among equally cheap ones, the current orientation, so nothing flips needlessly.
  const sorted = results
    .map((r, i) => ({ r, i }))
    .sort((x, y) => x.r.cost - y.r.cost || x.i - y.i)
    .map((x) => x.r);
  const first = sorted[0]!;
  let best = first.orientation,
    chosen = first;
  const Z = new Vector3(0, 0, 1);
  for (let i = 1; i < sorted.length - 1; i++) {
    if (Math.abs(sorted[i]!.cost - first.cost) < EPSILON && Math.abs(first.orientation.dot(Z) - 1) > EPSILON) {
      if (Math.abs(sorted[i]!.orientation.dot(Z) - 1) < EPSILON * EPSILON) {
        best = Z;
        chosen = sorted[i]!;
        break;
      }
    } else break;
  }
  const rotation = new Matrix4().makeRotationFromQuaternion(new Quaternion().setFromUnitVectors(best.clone().normalize(), Z));

  const fan = opts.coolingDirection;
  if (!fan) return rotation;
  // find_cooling_direction2: the overhangs that need cooling, weighted, after the turn; the side
  // they face most should face the fan. Symmetric objects stay as they are.
  const details = { bottom2: new Uint8Array(mesh.count), proj: new Float32Array(mesh.count) };
  score(chosen.orientation, details);
  const weights = new Float32Array(mesh.count);
  for (let i = 0; i < mesh.count; i++) {
    const np = details.proj[i]!;
    if (np < -0.6427 && np > -0.97 && !details.bottom2[i]) weights[i] = mesh.a[i]! * (1 - np);
  }
  // The normals after the turn, of the faces that count.
  const used: number[] = [],
    rotated: number[] = [];
  const normal = new Vector3();
  for (let i = 0; i < mesh.count; i++) {
    if (!(weights[i]! > 0)) continue;
    normal.set(mesh.n[i * 3]!, mesh.n[i * 3 + 1]!, mesh.n[i * 3 + 2]!).applyMatrix4(rotation);
    used.push(i);
    rotated.push(normal.x, normal.y);
  }
  let bestDir = new Vector3(),
    max = 0,
    origin = 0;
  for (let s = 0; s < 180; s++) {
    const angle = (s * 2 * Math.PI) / 180;
    const dir = new Vector3(Math.cos(angle), Math.sin(angle), 0);
    let sum = 0;
    for (let j = 0; j < used.length; j++) {
      const d = rotated[j * 2]! * dir.x + rotated[j * 2 + 1]! * dir.y;
      if (d > 0) sum += weights[used[j]!]! * d;
    }
    if (sum > max) {
      max = sum;
      bestDir = dir;
    }
    if (dir.dot(fan) > 0.999) origin = sum;
  }
  if (Math.abs(origin - max) < 1) return rotation;
  // A turn about Z (both directions lie flat; desktop's general two-vector rotation could tip over at 180°).
  const turn = Math.atan2(bestDir.x * fan.y - bestDir.y * fan.x, bestDir.dot(fan));
  return new Matrix4().makeRotationZ(turn).multiply(rotation);
}
