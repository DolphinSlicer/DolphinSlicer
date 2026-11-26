// The plate as the engine takes it (orca_set_layout): objects by their index in load order, with
// their instances; copies of an object are more instances of it, unless painted otherwise or
// with other support blockers and enforcers.
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LayoutObject, Mat4, PaintData } from '../engine/types';
import type { SceneObject, SceneVolume } from './store';

/**
 * The engine's layout: copies of an object (pasted, cloned) are more instances of the engine's
 * object, which takes each index once.
 */
export function engineLayout(objects: SceneObject[]) {
  return engineLayoutWithOwners(objects).layout;
}

/**
 * The engine's layout, and for each of its instances the scene object and matrix it is. Copies
 * painted otherwise than the others, or with other support volumes, are objects of their own (the
 * index listed again).
 */
export function engineLayoutWithOwners(objects: SceneObject[]) {
  const groups = new Map<number, Map<string, LayoutObject>>();
  const owners = new Map<LayoutObject, { id: string; m: Mat4 }[]>();
  const layout: LayoutObject[] = [];
  // Paint data by identity (copies share it until painted), volumes by what they are.
  const paintIds = new Map<PaintData, number>();
  const keyOf = (o: SceneObject) =>
    `${o.supports ? (paintIds.get(o.supports) ?? paintIds.set(o.supports, paintIds.size).get(o.supports)) : '-'}|${JSON.stringify(volumes(o.volumes))}`;
  for (const o of objects) {
    const byKey = groups.get(o.index) ?? new Map<string, LayoutObject>();
    groups.set(o.index, byKey);
    const key = keyOf(o);
    let e = byKey.get(key);
    if (!e) {
      e = {
        index: o.index,
        instances: [],
        ...(o.supports ? { supports: o.supports } : {}),
        ...(o.volumes?.length ? { volumes: volumes(o.volumes) } : {}),
      };
      byKey.set(key, e);
      owners.set(e, []);
      layout.push(e);
    }
    e.instances.push(...o.instances.map((matrix) => ({ matrix })));
    owners.get(e)!.push(...o.instances.map((m) => ({ id: o.id, m })));
  }
  return { layout, owners: layout.map((e) => owners.get(e)!) };
}

/** The volumes as the engine takes them (without the app's ids). */
const volumes = (list: SceneVolume[] | undefined) => (list ?? []).map(({ type, shape, size, matrix }) => ({ type, shape, size, matrix }));
