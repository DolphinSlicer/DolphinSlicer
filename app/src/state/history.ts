// Undo and redo of plate changes (desktop's Ctrl+Z / Ctrl+Y): the plate (files, objects and
// their placement) and the selection before each change. Settings are not part of it.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { get, type SceneObject, type SourceFile, set, touchPlate } from './store';

/** Objects loaded per file (engine load order), independent of later deletions. */
export const loadedCounts: number[] = [];

interface Snapshot {
  files: SourceFile[];
  objects: SceneObject[];
  selected: string[];
  counts: number[];
}
const LIMIT = 100;
/** How much model data the steps may keep alive beyond the plate's own. */
const BYTE_LIMIT = 256 << 20;
const undoStack: Snapshot[] = [];
let redoStack: Snapshot[] = [];
let lastKey = '',
  lastAt = 0;

const snapshot = (): Snapshot => {
  const s = get();
  return { files: s.files, objects: s.objects, selected: s.selected, counts: [...loadedCounts] };
};
const publish = () => set({ history: { undo: undoStack.length > 0, redo: redoStack.length > 0 } });

let collect: ((live: Set<string>) => void) | null = null;
/** Called with the objects any state still refers to, after history was dropped (to free meshes). */
export function onCollect(fn: (live: Set<string>) => void) {
  collect = fn;
}
function collectGarbage() {
  const live = new Set<string>();
  for (const x of [snapshot(), ...undoStack, ...redoStack]) for (const o of x.objects) live.add(o.id);
  collect?.(live);
}

/**
 * Call before changing the plate. Changes with the same `key` within a second are one step
 * (a held arrow key, one field typed into again).
 */
export function remember(key = '') {
  const now = performance.now();
  const merge = key !== '' && key === lastKey && now - lastAt < 1000;
  lastKey = key;
  lastAt = now;
  if (merge) return;
  undoStack.push(snapshot());
  let dropped = undoStack.length > LIMIT || redoStack.length > 0;
  if (undoStack.length > LIMIT) undoStack.shift();
  redoStack = [];
  // The oldest steps go while the files only they still hold (of deleted objects) weigh too much.
  while (undoStack.length > 1 && heldBytes() > BYTE_LIMIT) {
    undoStack.shift();
    dropped = true;
  }
  publish();
  if (dropped) collectGarbage();
}

/** The bytes of the files that only the undo steps hold (the plate has them no more). */
function heldBytes(): number {
  const now = new Set(get().files);
  const held = new Set<SourceFile>();
  for (const x of [...undoStack, ...redoStack]) for (const f of x.files) if (!now.has(f)) held.add(f);
  let n = 0;
  for (const f of held) n += f.bytes.byteLength;
  return n;
}

function restore(x: Snapshot) {
  loadedCounts.splice(0, loadedCounts.length, ...x.counts);
  const ids = new Set(x.objects.map((o) => o.id));
  set({ files: x.files, objects: x.objects, selected: x.selected.filter((id) => ids.has(id)), layOnFace: false });
  touchPlate();
}

export function undo() {
  const x = undoStack.pop();
  if (!x) return;
  redoStack.push(snapshot());
  lastKey = '';
  restore(x);
  publish();
}

export function redo() {
  const x = redoStack.pop();
  if (!x) return;
  undoStack.push(snapshot());
  lastKey = '';
  restore(x);
  publish();
}
