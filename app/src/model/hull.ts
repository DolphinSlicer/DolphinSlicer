// A mesh's convex hull (desktop's TriangleMesh::convex_hull_3d), indexed, in the mesh's own
// coordinates: the hull of transformed points is the transformed hull, so one per mesh does.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Vector3 } from 'three';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';

/** Triangles: corners (3 numbers each) and their indices (3 per triangle; none: in order). */
export interface MeshData {
  positions: Float32Array;
  index: Uint32Array | null;
}
export interface Hull {
  positions: Float32Array;
  index: Uint32Array;
}

/** The hull's triangles, wound outwards. */
export function convexHull(m: MeshData): Hull {
  const n = m.positions.length / 3;
  const points: Vector3[] = new Array(n);
  for (let i = 0; i < n; i++) points[i] = new Vector3(m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]);
  if (n < 4) return { positions: new Float32Array(), index: new Uint32Array() };
  const hull = new ConvexHull().setFromPoints(points);
  const ids = new Map<Vector3, number>();
  const pos: number[] = [],
    idx: number[] = [];
  const id = (p: Vector3) => {
    let i = ids.get(p);
    if (i === undefined) {
      i = ids.size;
      ids.set(p, i);
      pos.push(p.x, p.y, p.z);
    }
    return i;
  };
  for (const f of hull.faces) {
    // Fan over the face's edge loop (triangles here; a fan keeps any polygon right).
    const loop: number[] = [];
    let e = f.edge;
    do {
      loop.push(id(e.head().point));
      e = e.next;
    } while (e !== f.edge);
    for (let k = 1; k + 1 < loop.length; k++) idx.push(loop[0]!, loop[k]!, loop[k + 1]!);
  }
  return { positions: new Float32Array(pos), index: new Uint32Array(idx) };
}
