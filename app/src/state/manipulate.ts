// Object operations, as desktop's object manipulation panel (GizmoObjectManipulation) does them for
// one selected object (its first instance). The instance's transformation is kept as desktop's
// Geometry::Transformation: offset, rotation and (possibly mirrored) scaling; so the rotation is
// absolute angles, and the scale ratios and size are along the object's own axes and do not
// change when it turns. After each change the object rests on the bed again, as desktop's
// do_move/do_rotate/do_scale/do_mirror drop it.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Box3, type BufferAttribute, Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { Mat4 } from '../engine/types';
import { geometries, setInstance } from './actions';
import { get } from './store';

export type Coordinates = 'world' | 'object';
export type Axis = 0 | 1 | 2;
type Vec = [number, number, number];

const _v = new Vector3();
/** The mesh's bounding box under matrix m (sampled on large meshes, as footprint()). */
function boxUnder(id: string, m: Matrix4): Box3 {
  const pos = geometries.get(id)!.getAttribute('position') as BufferAttribute;
  const box = new Box3();
  const step = Math.max(1, Math.floor(pos.count / 200000));
  for (let i = 0; i < pos.count; i += step) box.expandByPoint(_v.fromBufferAttribute(pos, i).applyMatrix4(m));
  return box;
}
const centerOf = (id: string, m: Matrix4) => boxUnder(id, m).getCenter(new Vector3());
const localCenter = (id: string) => geometries.get(id)!.boundingBox!.getCenter(new Vector3());

const volumes = new WeakMap<object, number>();
/** The mesh's volume in its own coordinates (mm³). */
function meshVolume(id: string): number {
  const g = geometries.get(id)!;
  let v = volumes.get(g);
  if (v === undefined) {
    const p = g.getAttribute('position') as BufferAttribute,
      idx = g.getIndex();
    const n = idx ? idx.count : p.count;
    const at = (k: number) => (idx ? idx.getX(k) : k);
    const a = new Vector3(),
      b = new Vector3(),
      c = new Vector3();
    v = 0;
    for (let k = 0; k + 2 < n; k += 3) {
      a.fromBufferAttribute(p, at(k));
      b.fromBufferAttribute(p, at(k + 1));
      c.fromBufferAttribute(p, at(k + 2));
      v += a.dot(b.cross(c)) / 6;
    }
    v = Math.abs(v);
    volumes.set(g, v);
  }
  return v;
}

/** Offset, rotation and scaling (negative on a mirrored axis) of an instance matrix. */
function parts(m: Matrix4) {
  const offset = new Vector3(),
    rotation = new Quaternion(),
    scale = new Vector3();
  m.decompose(offset, rotation, scale);
  return { offset, rotation, scale };
}
// Desktop's rotation angles: R = Rz·Ry·Rx (Geometry::rotation_transform), three.js order 'ZYX'.
const ORDER = 'ZYX';

export interface Manipulation {
  position: Vec;
  /** Absolute rotation in degrees. */
  rotation: Vec;
  /** Scale ratios in percent. */
  scale: Vec;
  size: Vec;
  volume: number;
}

/** What the panel shows for an object's first instance. */
export function manipulation(id: string, matrix: Mat4, coords: Coordinates): Manipulation {
  const m = new Matrix4().fromArray(matrix);
  const { rotation, scale } = parts(m);
  const e = new Euler().setFromQuaternion(rotation, ORDER);
  // delete_negative_sign: no "-0".
  const deg = (r: number) => {
    const d = (r * 180) / Math.PI;
    return Math.abs(d) < 5e-3 ? 0 : d;
  };
  const s = scale.clone().set(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z));
  return {
    // World: the object's center. Object: an offset along its own axes, 0 until typed.
    position: coords === 'world' ? centerOf(id, m).toArray() : [0, 0, 0],
    rotation: [deg(e.x), deg(e.y), deg(e.z)],
    scale: s.clone().multiplyScalar(100).toArray(),
    size: geometries.get(id)!.boundingBox!.getSize(new Vector3()).multiply(s).toArray(),
    volume: meshVolume(id) * Math.abs(m.determinant()),
  };
}

const first = (id: string) => {
  const m = get().objects.find((o) => o.id === id)?.instances[0];
  return m ? new Matrix4().fromArray(m) : null;
};

/** Store `next`, moved so its center stays at `center` (X and Y), resting on the bed. */
function place(id: string, next: Matrix4, center: Vector3) {
  const box = boxUnder(id, next);
  const c = box.getCenter(new Vector3());
  const out = next.toArray();
  out[12]! += center.x - c.x;
  out[13]! += center.y - c.y;
  out[14]! -= box.min.z;
  setInstance(id, 0, out);
}

/** About the object's center, along world axes or its own. */
function about(id: string, m: Matrix4, coords: Coordinates, op: Matrix4): Matrix4 {
  const c = coords === 'world' ? centerOf(id, m) : localCenter(id);
  const t = new Matrix4()
    .makeTranslation(c.x, c.y, c.z)
    .multiply(op)
    .multiply(new Matrix4().makeTranslation(-c.x, -c.y, -c.z));
  return coords === 'world' ? t.multiply(m) : m.clone().multiply(t);
}

/** World: move the object's center to `value` on the axis. Object: move it by `value` along its own axis. */
export function setPosition(id: string, coords: Coordinates, axis: Axis, value: number) {
  const m = first(id);
  if (!m || !Number.isFinite(value)) return;
  const center = centerOf(id, m);
  const delta = new Vector3();
  if (coords === 'world') delta.setComponent(axis, value - center.getComponent(axis));
  else delta.setComponent(axis, value).applyQuaternion(parts(m).rotation);
  place(id, m, center.add(delta));
}

/** Set the absolute rotation angles (degrees; null keeps an axis), about the object's center. */
export function setRotation(id: string, angles: [number | null, number | null, number | null]) {
  const m = first(id);
  if (!m || angles.some((a) => a !== null && !Number.isFinite(a))) return;
  const { offset, rotation, scale } = parts(m);
  const e = new Euler().setFromQuaternion(rotation, ORDER);
  const r = (k: Axis) => (angles[k] === null ? [e.x, e.y, e.z][k]! : (angles[k]! * Math.PI) / 180);
  const q = new Quaternion().setFromEuler(new Euler(r(0), r(1), r(2), ORDER));
  // Turn about the mesh's own center so the object stays where it is.
  const lc = localCenter(id);
  const before = lc.clone().applyMatrix4(m);
  const next = new Matrix4().compose(offset, q, scale);
  const after = lc.clone().applyMatrix4(next);
  next.premultiply(new Matrix4().makeTranslation(before.x - after.x, before.y - after.y, before.z - after.z));
  place(id, next, centerOf(id, m));
}

/** Scale by `ratios` (1 = unchanged) along the object's own axes, about its center. */
export function scaleBy3(id: string, ratios: Vec) {
  const m = first(id);
  if (!m || ratios.some((r) => !(r > 0) || !Number.isFinite(r)) || ratios.every((r) => Math.abs(r - 1) < 1e-9)) return;
  place(id, about(id, m, 'object', new Matrix4().makeScale(...ratios)), centerOf(id, m));
}

/** Back to 100 % on every axis (a mirrored axis stays mirrored). */
export function resetScale(id: string) {
  const m = first(id);
  if (!m) return;
  const s = parts(m).scale;
  scaleBy3(id, [1 / Math.abs(s.x), 1 / Math.abs(s.y), 1 / Math.abs(s.z)]);
}

/** Mirror along the axis (world or the object's own), about the object's center. */
export function mirror(id: string, coords: Coordinates, axis: Axis) {
  const m = first(id);
  if (!m) return;
  const flip = new Matrix4().makeScale(axis === 0 ? -1 : 1, axis === 1 ? -1 : 1, axis === 2 ? -1 : 1);
  place(id, about(id, m, coords, flip), centerOf(id, m));
}
