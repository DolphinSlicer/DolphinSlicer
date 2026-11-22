// The faces an object can be laid on: the flat sides of its convex hull, as desktop's
// lay_on_face_planes (libslic3r/LayOnFace.cpp). Alike hull faces form one side; sides smaller
// than 5 mm², or with a sliver of a corner, are left out; the largest come first.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Hull } from './hull';

export interface FacePlane {
  /** Outward normal under the instance's rotation and scale. */
  normal: [number, number, number];
  /** The side's outline (convex), same coordinates: 3 numbers per corner. */
  outline: number[];
  area: number;
}

const MIN_AREA = 5,
  MIN_SIDE = 1,
  MIN_ANGLE = 1; // mm², mm, degrees

type P2 = { x: number; y: number; i: number };
/** 2D convex hull (monotone chain), counterclockwise. */
function hull2d(pts: P2[]): P2[] {
  const s = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (s.length < 3) return s;
  const cross = (o: P2, a: P2, b: P2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: P2[] = [],
    upper: P2[] = [];
  for (const p of s) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let k = s.length - 1; k >= 0; k--) {
    const p = s[k]!;
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** The sides of a convex hull under `linear` (the instance's matrix without its offset). */
export function layOnFacePlanes(hull: Hull, linear: Matrix4): FacePlane[] {
  const { positions: pos, index: idx } = hull;
  const count = idx.length / 3,
    nv = pos.length / 3;
  // Face normals in the mesh's own coordinates (as desktop), and the faces on each edge.
  const normals = new Float32Array(count * 3);
  const edges = new Map<number, number[]>();
  const a = new Vector3(),
    b = new Vector3(),
    c = new Vector3();
  const edgeKey = (p: number, q: number) => (p < q ? p * nv + q : q * nv + p);
  for (let f = 0; f < count; f++) {
    const [i, j, k] = [idx[f * 3]!, idx[f * 3 + 1]!, idx[f * 3 + 2]!];
    a.fromArray(pos, i * 3);
    b.fromArray(pos, j * 3);
    c.fromArray(pos, k * 3);
    b.sub(a)
      .cross(c.sub(a))
      .normalize()
      .toArray(normals, f * 3);
    for (const key of [edgeKey(i, j), edgeKey(j, k), edgeKey(k, i)]) {
      const list = edges.get(key);
      if (list) list.push(f);
      else edges.set(key, [f]);
    }
  }
  // World positions of the hull's corners.
  const world = new Float32Array(pos.length);
  for (let v = 0; v < nv; v++)
    a.fromArray(pos, v * 3)
      .applyMatrix4(linear)
      .toArray(world, v * 3);

  const visited = new Uint8Array(count);
  const normalMatrix = new Matrix4().copy(linear).invert().transpose();
  const toPlane = new Quaternion(),
    up = new Vector3(0, 0, 1),
    n = new Vector3(),
    q = new Vector3();
  const cosMin = Math.cos((MIN_ANGLE * Math.PI) / 180);
  const planes: FacePlane[] = [];
  for (let start = 0; start < count; start++) {
    if (visited[start]) continue;
    const n0 = [normals[start * 3]!, normals[start * 3 + 1]!, normals[start * 3 + 2]!];
    const queue = [start];
    visited[start] = 1;
    const corners = new Set<number>();
    let faces = 0;
    while (queue.length) {
      const f = queue.pop()!;
      if (
        Math.abs(normals[f * 3]! - n0[0]!) >= 0.001 ||
        Math.abs(normals[f * 3 + 1]! - n0[1]!) >= 0.001 ||
        Math.abs(normals[f * 3 + 2]! - n0[2]!) >= 0.001
      ) {
        visited[f] = 0;
        continue;
      }
      faces++;
      const [i, j, k] = [idx[f * 3]!, idx[f * 3 + 1]!, idx[f * 3 + 2]!];
      corners.add(i);
      corners.add(j);
      corners.add(k);
      for (const key of [edgeKey(i, j), edgeKey(j, k), edgeKey(k, i)])
        for (const x of edges.get(key)!)
          if (!visited[x]) {
            visited[x] = 1;
            queue.push(x);
          }
    }
    const list = [...corners];
    // A lone sliver triangle.
    if (faces === 1) {
      const d = (p: number, r: number) =>
        Math.hypot(world[p * 3]! - world[r * 3]!, world[p * 3 + 1]! - world[r * 3 + 1]!, world[p * 3 + 2]! - world[r * 3 + 2]!);
      if (d(list[0]!, list[1]!) < MIN_SIDE || d(list[0]!, list[2]!) < MIN_SIDE || d(list[1]!, list[2]!) < MIN_SIDE) continue;
    }
    n.set(n0[0]!, n0[1]!, n0[2]!).applyMatrix4(normalMatrix).normalize();
    // Into the side's own plane, where its outline is the 2D hull of its corners.
    toPlane.setFromUnitVectors(n, up);
    const outline = hull2d(
      list.map((i) => {
        q.fromArray(world, i * 3).applyQuaternion(toPlane);
        return { x: q.x, y: q.y, i };
      }),
    );
    let area = 0;
    for (let k = 0; k < outline.length; k++) {
      const p = outline[k]!,
        r = outline[(k + 1) % outline.length]!;
      area += p.x * r.y - r.x * p.y;
    }
    area = Math.abs(area) / 2;
    if (area < MIN_AREA) continue;
    const sharp = outline.some((cur, k) => {
      const p = outline[(k + outline.length - 1) % outline.length]!,
        r = outline[(k + 1) % outline.length]!;
      const ax = p.x - cur.x,
        ay = p.y - cur.y,
        bx = r.x - cur.x,
        by = r.y - cur.y;
      return (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by)) > cosMin;
    });
    if (sharp) continue;
    planes.push({
      normal: [n.x, n.y, n.z],
      outline: outline.flatMap((o) => [world[o.i * 3]!, world[o.i * 3 + 1]!, world[o.i * 3 + 2]!]),
      area,
    });
  }
  // Desktop shows at most 254.
  return planes.sort((x, y) => y.area - x.area).slice(0, 254);
}

/** The rotation that puts a side (its outward normal) down on the bed. */
export const layOnFaceRotation = (normal: Vector3) =>
  new Matrix4().makeRotationFromQuaternion(new Quaternion().setFromUnitVectors(normal.clone().normalize(), new Vector3(0, 0, -1)));
