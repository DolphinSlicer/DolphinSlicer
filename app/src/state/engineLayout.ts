// The plate as the engine takes it (orca_set_layout): objects by their index in load order, with
// their instances; copies of an object are more instances of it, unless painted otherwise.
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LayoutObject, Mat4, PaintData } from '../engine/types';
import type { SceneObject } from './store';

/**
 * The engine's layout: copies of an object (pasted, cloned) are more instances of the engine's
 * object, which takes each index once.
 */
export function engineLayout(objects: SceneObject[]) {
  return engineLayoutWithOwners(objects).layout;
}

/**
 * The engine's layout, and for each of its instances the scene object and matrix it is. Copies
 * painted otherwise than the others are objects of their own (the index listed again).
 */
export function engineLayoutWithOwners(objects: SceneObject[]) {
  const groups = new Map<number, Map<PaintData | undefined, LayoutObject>>();
  const owners = new Map<LayoutObject, { id: string; m: Mat4 }[]>();
  const layout: LayoutObject[] = [];
  for (const o of objects) {
    const byPaint = groups.get(o.index) ?? new Map<PaintData | undefined, LayoutObject>();
    groups.set(o.index, byPaint);
    let e = byPaint.get(o.supports);
    if (!e) {
      e = { index: o.index, instances: [], ...(o.supports ? { supports: o.supports } : {}) };
      byPaint.set(o.supports, e);
      owners.set(e, []);
      layout.push(e);
    }
    e.instances.push(...o.instances.map((matrix) => ({ matrix })));
    owners.get(e)!.push(...o.instances.map((m) => ({ id: o.id, m })));
  }
  return { layout, owners: layout.map((e) => owners.get(e)!) };
}
