// Plate operations, as desktop's plater: selecting objects, copy/cut/paste, clone, instances,
// moving and turning the selection, delete, arrange, auto orient and lay on face. Each change
// is one undo step (history.ts).
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Matrix4, Vector3 } from 'three';
import type { Mat4 } from '../engine/types';
import { t } from '../i18n/i18n';
import { placeFootprint, type Rect } from '../model/bed';
import { orientInWorker } from '../model/geometryWorker';
import { layOnFaceRotation } from '../model/layOnFace';
import { arrangeAll, clearPlate, deleteObjects, footprint, geometries, newObjectId, translateTo } from './actions';
import { loadedCounts, redo, remember, undo } from './history';
import { get, notify, type SceneObject, type SourceFile, set, touchPlate } from './store';

export { arrangeAll, clearPlate, redo, undo };

const selectedObjects = () => {
  const s = get();
  const ids = new Set(s.selected);
  return s.objects.filter((o) => ids.has(o.id));
};

// ── selection ───────────────────────────────────────────────────────────────────────────
let anchor: string | null = null;
/**
 * Select an object (null: nothing). `toggle` adds or removes it (Ctrl+click), `range` selects
 * from the last clicked one to it in the object list (Shift+click).
 */
export function select(id: string | null, mode: 'replace' | 'toggle' | 'range' = 'replace') {
  const s = get();
  let next: string[];
  if (id === null) next = [];
  else if (mode === 'toggle') next = s.selected.includes(id) ? s.selected.filter((x) => x !== id) : [...s.selected, id];
  else if (mode === 'range' && anchor && s.objects.some((o) => o.id === anchor)) {
    const ids = s.objects.map((o) => o.id);
    const [a, b] = [ids.indexOf(anchor), ids.indexOf(id)].sort((x, y) => x - y);
    next = ids.slice(a, b! + 1);
  } else next = [id];
  if (mode !== 'range') anchor = id;
  // Lay on face stays on while the same one object is selected.
  const keep = s.layOnFace && next.length === 1 && next[0] === s.selected[0] && s.selected.length === 1;
  set({ selected: next, layOnFace: keep });
}

export function selectAll() {
  set((s) => ({ selected: s.objects.map((o) => o.id), layOnFace: false }));
}

export function deselectAll() {
  set({ selected: [], layOnFace: false });
}

export function deleteSelected() {
  deleteObjects(get().selected);
}

export { clearPlate as deleteAll };

// ── clipboard, clone ────────────────────────────────────────────────────────────────────
/** A copied object: what it is, and the file the engine loads it from. */
interface Copied {
  object: SceneObject;
  file: SourceFile;
  fileCount: number;
  local: number;
}
let clipboard: Copied[] = [];
/** The copies' meshes: the plate may let go of them (deleted, cleared). */
const meshes = new Map<string, NonNullable<ReturnType<typeof geometries.get>>>();

/** Where an engine object comes from: its file and its place in it. */
function source(o: SceneObject): Omit<Copied, 'object'> {
  const files = get().files;
  let first = 0;
  for (let i = 0; i < loadedCounts.length; i++) {
    if (o.index < first + loadedCounts[i]!) return { file: files[i]!, fileCount: loadedCounts[i]!, local: o.index - first };
    first += loadedCounts[i]!;
  }
  throw new Error('Object without a file');
}

export function copy() {
  const objs = selectedObjects();
  if (!objs.length) return;
  clipboard = objs.map((o) => ({ object: { ...o, instances: o.instances.map((m) => m.slice()) }, ...source(o) }));
  meshes.clear();
  for (const c of clipboard) meshes.set(c.object.id, geometries.get(c.object.id)!);
  set({ canPaste: true });
}

export function cut() {
  copy();
  deleteSelected();
}

export function paste() {
  if (clipboard.length) addCopies(clipboard);
}

/** Desktop's Clone: copies of the selection, beside it (the clipboard stays as it is). */
export function clone() {
  const objs = selectedObjects();
  if (objs.length) addCopies(objs.map((o) => ({ object: o, ...source(o) })));
}

const union = (rects: Rect[]): Rect => ({
  x0: Math.min(...rects.map((r) => r.x0)),
  y0: Math.min(...rects.map((r) => r.y0)),
  x1: Math.max(...rects.map((r) => r.x1)),
  y1: Math.max(...rects.map((r) => r.y1)),
});
const takenOnPlate = () => get().objects.flatMap((o) => o.instances.map((m) => footprint(o.id, m)));

/**
 * New objects like `sources`, together (keeping their layout) in the nearest free place: next
 * to the originals when they are on the bed, else from the bed's center (as desktop's paste).
 */
function addCopies(sources: Copied[]) {
  remember();
  const s = get();
  const files = [...s.files];
  // The engine object to copy: its file may be gone from the plate (deleted, cleared); load it again.
  const indexOf = (c: Copied) => {
    let i = files.indexOf(c.file);
    if (i < 0) {
      files.push(c.file);
      loadedCounts.push(c.fileCount);
      i = files.length - 1;
    }
    return loadedCounts.slice(0, i).reduce((a, b) => a + b, 0) + c.local;
  };
  const added: SceneObject[] = sources.map((c) => {
    const id = newObjectId();
    geometries.set(id, geometries.get(c.object.id) ?? meshes.get(c.object.id)!);
    return { ...c.object, id, index: indexOf(c), instances: c.object.instances.map((m) => m.slice()) };
  });
  const bed = s.presets.bed;
  if (bed) {
    const area = union(added.flatMap((o) => o.instances.map((m) => footprint(o.id, m))));
    const center: [number, number] = [(area.x0 + area.x1) / 2, (area.y0 + area.y1) / 2];
    const onBed = area.x1 > bed.min[0] && area.x0 < bed.max[0] && area.y1 > bed.min[1] && area.y0 < bed.max[1];
    const [x, y] = placeFootprint(bed, takenOnPlate(), area.x1 - area.x0, area.y1 - area.y0, 6, onBed ? center : undefined);
    for (const o of added)
      o.instances = o.instances.map((m) => {
        const out = m.slice();
        out[12]! += x - center[0];
        out[13]! += y - center[1];
        return out;
      });
  }
  set({ files, objects: [...s.objects, ...added], selected: added.map((o) => o.id), layOnFace: false });
  touchPlate();
}

// ── instances ───────────────────────────────────────────────────────────────────────────
/** Desktop's "+": one more instance of each selected object, in a free place near it. */
export function addInstance() {
  const objs = selectedObjects();
  const bed = get().presets.bed;
  if (!objs.length) return;
  remember();
  const taken = takenOnPlate();
  const next = new Map<string, Mat4[]>();
  for (const o of objs) {
    const last = o.instances.at(-1)!;
    const fp = footprint(o.id, last);
    let m = last.slice();
    if (bed) {
      const [x, y] = placeFootprint(bed, taken, fp.x1 - fp.x0, fp.y1 - fp.y0, 6, [(fp.x0 + fp.x1) / 2, (fp.y0 + fp.y1) / 2]);
      m = translateTo(o.id, last, x, y);
      taken.push(footprint(o.id, m));
    }
    next.set(o.id, [...o.instances, m]);
  }
  set((s) => ({ objects: s.objects.map((o) => (next.has(o.id) ? { ...o, instances: next.get(o.id)! } : o)) }));
  touchPlate();
}

/** Desktop's "−": the last instance of each selected object that has more than one. */
export function removeInstance() {
  const objs = selectedObjects().filter((o) => o.instances.length > 1);
  if (!objs.length) return;
  remember();
  const ids = new Set(objs.map((o) => o.id));
  set((s) => ({ objects: s.objects.map((o) => (ids.has(o.id) ? { ...o, instances: o.instances.slice(0, -1) } : o)) }));
  touchPlate();
}

// ── moving and turning ──────────────────────────────────────────────────────────────────
/** Store moved instances (a drag in the 3D view). */
export function moveInstances(all: { id: string; k: number; matrix: Mat4 }[]) {
  // Not what was deleted during the drag.
  const changes = all.filter((c) => get().objects.some((o) => o.id === c.id && c.k < o.instances.length));
  if (!changes.length) return;
  remember();
  set((s) => ({
    objects: s.objects.map((o) => {
      const mine = changes.filter((c) => c.id === o.id);
      return mine.length ? { ...o, instances: o.instances.map((m, k) => mine.find((c) => c.k === k)?.matrix ?? m) } : o;
    }),
  }));
  touchPlate();
}

/** Change every instance of the selected objects (one undo step; `key`: see remember). */
function eachSelectedInstance(fn: (id: string, m: Mat4) => Mat4, key = '') {
  const ids = new Set(get().selected);
  if (!ids.size) return;
  remember(key);
  set((s) => ({ objects: s.objects.map((o) => (ids.has(o.id) ? { ...o, instances: o.instances.map((m) => fn(o.id, m)) } : o)) }));
  touchPlate();
}

/** Desktop's arrow keys: move the selection along the bed (10 mm, 1 mm with Shift). */
export function moveSelection(dx: number, dy: number) {
  eachSelectedInstance((_, m) => {
    const out = m.slice();
    out[12]! += dx;
    out[13]! += dy;
    return out;
  }, 'move');
}

/** Turn an instance about its center by the world rotation `r`, resting on the bed again. */
function turn(id: string, m: Mat4, r: Matrix4): Mat4 {
  const fp = footprint(id, m);
  return translateTo(id, new Matrix4().fromArray(m).premultiply(r).toArray(), (fp.x0 + fp.x1) / 2, (fp.y0 + fp.y1) / 2);
}

/** Desktop's Page Up / Page Down: turn the selection about Z (degrees, counterclockwise). */
export function rotateSelection(degrees: number) {
  const r = new Matrix4().makeRotationZ((degrees * Math.PI) / 180);
  eachSelectedInstance((id, m) => turn(id, m, r), 'rotate');
}

// ── auto orient, lay on face ────────────────────────────────────────────────────────────
function orientOptions() {
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(get().presets.config ?? '{}') as Record<string, unknown>;
  } catch {
    /* defaults */
  }
  const angle = Number(cfg.support_threshold_angle);
  const fan = String(cfg.fan_direction ?? 'undefine');
  const aux = cfg.auxiliary_fan === true || cfg.auxiliary_fan === '1' || cfg.auxiliary_fan === 1;
  return {
    overhangAngle: Number.isFinite(angle) ? angle : 30,
    coolingDirection: !aux || fan === 'undefine' ? null : new Vector3(fan === 'right' ? 1 : -1, 0, 0),
  };
}

/**
 * Desktop's Q: turn the selected objects (all, when none is selected) to print best. Worked out
 * in the geometry worker; instances changed meanwhile are left as they are.
 */
export async function autoOrient() {
  const s = get();
  if (s.orienting) return;
  const ids = new Set(s.selected.length ? s.selected : s.objects.map((o) => o.id));
  const targets = s.objects.filter((o) => ids.has(o.id)).flatMap((o) => o.instances.map((m) => ({ id: o.id, m })));
  if (!targets.length) return;
  const { overhangAngle, coolingDirection } = orientOptions();
  const fan = coolingDirection ? (coolingDirection.toArray() as [number, number, number]) : null;
  // Instances alike (the same mesh, turned and scaled the same) are worked out once.
  const jobs = new Map<string, Promise<Matrix4>>();
  set({ orienting: true });
  try {
    const rotations = await Promise.all(
      targets.map(({ id, m }) => {
        const g = geometries.get(id)!;
        const linear = new Matrix4().fromArray(m).setPosition(0, 0, 0);
        const key = `${g.uuid}|${linear.elements.join(',')}`;
        let job = jobs.get(key);
        if (!job) jobs.set(key, (job = orientInWorker(g, linear, overhangAngle, fan)));
        return job;
      }),
    );
    const done = new Map(targets.map((x, i) => [x.m, rotations[i]!]));
    if (!get().objects.some((o) => o.instances.some((m) => done.has(m)))) return;
    remember();
    set((st) => ({
      objects: st.objects.map((o) =>
        o.instances.some((m) => done.has(m))
          ? { ...o, instances: o.instances.map((m) => (done.has(m) ? turn(o.id, m, done.get(m)!) : m)) }
          : o,
      ),
    }));
    touchPlate();
  } catch (e) {
    notify({ kind: 'error', title: t('Auto orient'), message: String((e as Error)?.message ?? e) });
  } finally {
    set({ orienting: false });
  }
}

/** Desktop's F: lay on face, for the one selected object. */
export function toggleLayOnFace(on = !get().layOnFace) {
  set({ layOnFace: on && get().selected.length === 1 });
}

/** Put the side with outward `normal` (under the first instance's rotation) on the bed, for every instance. */
export function layOnFace(id: string, normal: Vector3) {
  const r = layOnFaceRotation(normal);
  remember();
  set((s) => ({ objects: s.objects.map((o) => (o.id === id ? { ...o, instances: o.instances.map((m) => turn(id, m, r)) } : o)) }));
  touchPlate();
}
