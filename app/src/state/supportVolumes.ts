// Desktop's Add support blocker / Add support enforcer: a generic shape (cube, cylinder, sphere,
// cone, disc, torus) in an object, where supports are kept away or added. Placed as desktop does
// (GUI_ObjectList::load_generic_subobject): its size a tenth of the bed, beside the object at its
// right front corner on the bed, upright and unscaled whatever the object's rotation and scale.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { ObjectInfo } from '../engine/protocol';
import type { Mat4, SupportShape, SupportVolume } from '../engine/types';
import { N_, tr } from '../i18n/i18n';
import { registerSupportMesh } from '../view/supportShapes';
import { footprint } from './actions';
import { remember } from './history';
import { get, type SceneObject, type SceneVolume, set, touchPlate } from './store';

export const SUPPORT_SHAPES: SupportShape[] = ['cube', 'cylinder', 'sphere', 'cone', 'disc', 'torus'];
/** Desktop's names, translated with its catalog (marked so the build bundles them). */
export const SHAPE_NAMES: Record<SupportShape, string> = {
  cube: N_('Cube'),
  cylinder: N_('Cylinder'),
  sphere: N_('Sphere'),
  cone: N_('Cone'),
  disc: N_('Disc'),
  torus: N_('Torus'),
};
export const TYPE_NAMES: Record<SupportVolume['type'], string> = {
  support_blocker: N_('Support Blocker'),
  support_enforcer: N_('Support Enforcer'),
};
/** Its name: the shape's, or for one the model came with, the file's (else its type). */
export const volumeName = (v: SceneVolume) => (v.shape === 'mesh' ? v.name || tr(TYPE_NAMES[v.type]) : tr(SHAPE_NAMES[v.shape]));

/** Desktop's menu entries (ADD_VOLUME_MENU_ITEMS). */
export const ADD_NAMES: Record<SupportVolume['type'], string> = {
  support_blocker: N_('Add Support Blocker'),
  support_enforcer: N_('Add Support Enforcer'),
};

/** Desktop's sizes (primitive_size_fields), `side` a tenth of the bed's larger side. */
export function defaultSize(shape: SupportShape, side: number): number[] {
  switch (shape) {
    case 'cube':
      return [side, side, side];
    case 'sphere':
      return [side];
    case 'disc':
      return [side, 0.2];
    case 'torus':
      return [0.75 * side, 0.25 * side];
    default:
      return [side, side];
  }
}

/** The shape's extent along its own axes (before its matrix); a model's own: its `size`. */
export function shapeExtent(shape: SupportShape | 'mesh', size: number[]): [number, number, number] {
  switch (shape) {
    case 'mesh':
    case 'cube':
      return [size[0]!, size[1]!, size[2]!];
    case 'sphere':
      return [size[0]!, size[0]!, size[0]!];
    case 'torus': {
      const outer = size[0]! + 2 * size[1]!;
      return [outer, outer, size[1]!];
    }
    default:
      return [size[0]!, size[0]!, size[1]!];
  }
}

let nextId = 1;

/** The support blockers and enforcers a model came with (a project's), as the engine lists them. */
export function loadedVolumes(list: NonNullable<ObjectInfo['support_volumes']>): SceneVolume[] {
  return list.map((v, loaded) => {
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < v.positions.length; i++) {
      const a = i % 3;
      min[a] = Math.min(min[a]!, v.positions[i]!);
      max[a] = Math.max(max[a]!, v.positions[i]!);
    }
    return {
      id: `v${nextId++}`,
      type: v.type,
      shape: 'mesh',
      size: max.map((x, a) => Math.max(x - min[a]!, 0.01)),
      matrix: v.matrix,
      loaded,
      mesh: registerSupportMesh(v.positions, v.indices),
      ...(v.name ? { name: v.name } : {}),
    };
  });
}

const objectOf = (id: string) => get().objects.find((o) => o.id === id);
const withVolumes = (o: SceneObject, volumes: SceneVolume[]): SceneObject => ({ ...o, volumes });

/** Add a support blocker or enforcer of this shape to the one selected object, and select it. */
export function addSupportVolume(type: SupportVolume['type'], shape: SupportShape) {
  const s = get();
  const o = s.selected.length === 1 ? objectOf(s.selected[0]!) : undefined;
  if (!o) return;
  const bed = s.presets.bed;
  const side = 0.1 * (bed ? Math.max(bed.max[0] - bed.min[0], bed.max[1] - bed.min[1]) : 250);
  const size = defaultSize(shape, side);
  const [w, d, h] = shapeExtent(shape, size);
  // In the world: beside the object's first instance, on the bed, unrotated and unscaled.
  const inst = o.instances[0]!;
  const fp = footprint(o.id, inst);
  const world = new Matrix4().makeTranslation(fp.x1 + w / 2, fp.y0 + d / 2, h / 2);
  const matrix = new Matrix4().fromArray(inst).invert().multiply(world).toArray();
  const volume: SceneVolume = { id: `v${nextId++}`, type, shape, size, matrix };
  remember();
  set({
    objects: s.objects.map((x) => (x.id === o.id ? withVolumes(x, [...(x.volumes ?? []), volume]) : x)),
    selectedVolume: { object: o.id, volume: volume.id },
  });
  touchPlate();
}

/** Select a support volume of an object (null: none); the object becomes the selection. */
export function selectVolume(object: string, volume: string | null) {
  set({ selected: [object], selectedVolume: volume ? { object, volume } : null, layOnFace: false });
}

/** The selected support volume, while its object is the one selected and it still exists. */
export function selectedVolume(
  s: Pick<ReturnType<typeof get>, 'selectedVolume' | 'selected' | 'objects'> = get(),
): { object: SceneObject; volume: SceneVolume } | null {
  const sel = s.selectedVolume;
  if (!sel || s.selected.length !== 1 || s.selected[0] !== sel.object) return null;
  const object = s.objects.find((o) => o.id === sel.object);
  const volume = object?.volumes?.find((v) => v.id === sel.volume);
  return object && volume ? { object, volume } : null;
}

/** Place a support volume (`matrix` in its object's coordinates). `key`: one undo step for a run. */
export function setVolumeMatrix(object: string, volume: string, matrix: Mat4, key = '') {
  remember(key);
  set((s) => ({
    objects: s.objects.map((o) =>
      o.id === object
        ? withVolumes(
            o,
            (o.volumes ?? []).map((v) => (v.id === volume ? { ...v, matrix } : v)),
          )
        : o,
    ),
  }));
  touchPlate();
}

export function deleteVolume(object: string, volume: string) {
  remember();
  set((s) => ({
    objects: s.objects.map((o) =>
      o.id === object
        ? withVolumes(
            o,
            (o.volumes ?? []).filter((v) => v.id !== volume),
          )
        : o,
    ),
    selectedVolume: s.selectedVolume?.volume === volume ? null : s.selectedVolume,
  }));
  touchPlate();
}

/** Where a support volume is in the world (its object's first instance): position, rotation, scale. */
export function volumeWorld(o: SceneObject, v: SceneVolume) {
  const m = new Matrix4().fromArray(o.instances[0]!).multiply(new Matrix4().fromArray(v.matrix));
  const position = new Vector3(),
    q = new Quaternion(),
    scale = new Vector3();
  m.decompose(position, q, scale);
  // Desktop's angles (as the object panel's): about the world's X, then Y, then Z.
  const r = new Euler().setFromQuaternion(q, 'ZYX');
  const extent = shapeExtent(v.shape, v.size);
  return {
    position: [position.x, position.y, position.z] as [number, number, number],
    rotation: [r.x, r.y, r.z].map((a) => (a * 180) / Math.PI) as [number, number, number],
    size: [extent[0] * scale.x, extent[1] * scale.y, extent[2] * scale.z] as [number, number, number],
    scale: [scale.x, scale.y, scale.z] as [number, number, number],
  };
}

/** The volume matrix (object coordinates) that puts it there in the world. */
export function volumeMatrixFor(
  o: SceneObject,
  v: SceneVolume,
  at: { position: [number, number, number]; rotation: [number, number, number]; size: [number, number, number] },
): Mat4 {
  const extent = shapeExtent(v.shape, v.size);
  const [rx, ry, rz] = at.rotation.map((a) => (a * Math.PI) / 180) as [number, number, number];
  const world = new Matrix4().compose(
    new Vector3(...at.position),
    new Quaternion().setFromEuler(new Euler(rx, ry, rz, 'ZYX')),
    new Vector3(...at.size.map((x, i) => Math.max(x, 0.01) / extent[i]!)),
  );
  return new Matrix4().fromArray(o.instances[0]!).invert().multiply(world).toArray();
}

/** A drag in the 3D view: moved by (dx, dy, 0) in the world. */
export function moveVolume(object: string, volume: string, dx: number, dy: number) {
  const o = objectOf(object);
  const v = o?.volumes?.find((x) => x.id === volume);
  if (!o || !v) return;
  const inst = new Matrix4().fromArray(o.instances[0]!);
  const world = inst.clone().multiply(new Matrix4().fromArray(v.matrix));
  world.premultiply(new Matrix4().makeTranslation(dx, dy, 0));
  setVolumeMatrix(object, volume, inst.invert().multiply(world).toArray());
}
