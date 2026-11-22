// Local store for user presets: the desktop-format files the engine writes under
// /orca/user/default, kept in IndexedDB so they survive reloads. (Drive sync uses
// these same files.) Falls back to memory when IndexedDB is unavailable (private windows).
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { UserFiles } from '../engine/protocol';

const DB = 'dolphin-slicer',
  STORE = 'user-presets',
  KEY = 'files';
/** The files and when each last changed here (ms), for Drive sync. */
interface Stored {
  files: UserFiles;
  mtimes: Record<string, number>;
}
let memory: Stored = { files: {}, mtimes: {} };

const listeners = new Set<() => void>();
/** Called after the app saved changed user files (not after a sync wrote them). */
export function onUserFilesSaved(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function load(): Promise<Stored> {
  try {
    const db = await open();
    const v = await new Promise<unknown>((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!v) return { files: {}, mtimes: {} };
    // Before Drive sync, only the files were stored.
    const o = v as Partial<Stored>;
    return typeof o.files === 'object' && typeof o.mtimes === 'object' ? (o as Stored) : { files: v as UserFiles, mtimes: {} };
  } catch {
    return memory;
  }
}

export async function loadUserFiles(): Promise<UserFiles> {
  return (await load()).files;
}
export async function loadUserStore(): Promise<Stored> {
  return load();
}

/**
 * Keep the user files. Files whose content changed are stamped with the current time, unless
 * their times are given (files that came from Drive keep Drive's time).
 */
export async function saveUserFiles(files: UserFiles, mtimes?: Record<string, number>): Promise<void> {
  const prev = await load();
  const stamped: Record<string, number> = {};
  const now = Date.now();
  for (const [p, text] of Object.entries(files)) stamped[p] = mtimes?.[p] ?? (prev.files[p] === text ? (prev.mtimes[p] ?? now) : now);
  const v: Stored = { files, mtimes: stamped };
  memory = v;
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(v, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* kept in memory for this session */
  }
  if (!mtimes) for (const cb of listeners) cb();
}
