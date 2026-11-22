// The model library on this device: an index of entries (name, tags, thumbnail, Drive id) and
// the model files themselves, both in IndexedDB. IndexedDB rather than OPFS because it also
// works over plain HTTP (the self-hosted Pi build), where OPFS is not available.
//
// Files are the source of truth only until they are in Google Drive. After that they are a cache:
// when the cache grows past its limit, the least recently used synced files are dropped and
// downloaded again when opened. Files that are not in Drive yet are never dropped.
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface LibraryEntry {
  id: string;
  /** Shown on the card; editable. */
  name: string;
  /** The model file's name ("benchy.3mf"); its extension tells the format. */
  file: string;
  size: number;
  tags: string[];
  /** Data URL, or '' when none could be drawn. */
  thumb: string;
  added: number;
  /** Last change to the entry itself (name, tags, deletion): the newer one wins in sync. */
  modified: number;
  /** Set when deleted, kept so other devices learn about it. */
  deleted?: number;
  /** The model file in Google Drive, once uploaded. */
  driveId?: string;
}

/** Per-device facts about a cached file. */
export interface CacheInfo {
  size: number;
  used: number;
}

const DB = 'dolphin-library',
  ENTRIES = 'entries',
  FILES = 'files',
  CACHE = 'cache';

let dbPromise: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        for (const s of [ENTRIES, FILES, CACHE]) req.result.createObjectStore(s);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

// Without IndexedDB (some private windows) the library lives in memory for the session.
const mem = { [ENTRIES]: new Map<string, unknown>(), [FILES]: new Map<string, unknown>(), [CACHE]: new Map<string, unknown>() };

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const d = await db();
  if (!d) return undefined;
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

async function getAll<T>(store: typeof ENTRIES | typeof CACHE): Promise<Map<string, T>> {
  const d = await db();
  if (!d) return mem[store] as Map<string, T>;
  const [keys, values] = await Promise.all([
    tx<IDBValidKey[]>(store, 'readonly', (s) => s.getAllKeys()),
    tx<T[]>(store, 'readonly', (s) => s.getAll()),
  ]);
  return new Map((keys ?? []).map((k, i) => [String(k), values![i]!]));
}

async function put(store: string, key: string, value: unknown) {
  if (!(await db())) {
    mem[store as keyof typeof mem].set(key, value);
    return;
  }
  await tx(store, 'readwrite', (s) => s.put(value, key));
}
async function del(store: string, key: string) {
  if (!(await db())) {
    mem[store as keyof typeof mem].delete(key);
    return;
  }
  await tx(store, 'readwrite', (s) => s.delete(key));
}

export const loadEntries = () => getAll<LibraryEntry>(ENTRIES);
export const saveEntry = (e: LibraryEntry) => put(ENTRIES, e.id, e);
export const removeEntry = (id: string) => del(ENTRIES, id);
export const loadCacheInfo = () => getAll<CacheInfo>(CACHE);

export async function readFile(id: string): Promise<ArrayBuffer | null> {
  const v = (await db()) ? await tx<ArrayBuffer>(FILES, 'readonly', (s) => s.get(id)) : (mem[FILES].get(id) as ArrayBuffer | undefined);
  if (!v) return null;
  await put(CACHE, id, { size: v.byteLength, used: Date.now() } satisfies CacheInfo);
  return v;
}
export async function writeFile(id: string, bytes: ArrayBuffer) {
  await put(FILES, id, bytes);
  await put(CACHE, id, { size: bytes.byteLength, used: Date.now() } satisfies CacheInfo);
}
export async function dropFile(id: string) {
  await del(FILES, id);
  await del(CACHE, id);
}

/** How much the cached files may take on this device. */
export const CACHE_LIMIT = 1024 ** 3;

/**
 * Which cached files to drop so the rest fits in `limit`: least recently used first, and only
 * files that are in Drive (they can be downloaded again).
 */
export function pickEvictions(cache: Map<string, CacheInfo>, entries: Map<string, LibraryEntry>, limit: number): string[] {
  let total = [...cache.values()].reduce((a, c) => a + c.size, 0);
  const out: string[] = [];
  const candidates = [...cache].filter(([id]) => entries.get(id)?.driveId).sort(([, a], [, b]) => a.used - b.used);
  for (const [id, c] of candidates) {
    if (total <= limit) break;
    out.push(id);
    total -= c.size;
  }
  return out;
}

export async function evict(limit = CACHE_LIMIT): Promise<string[]> {
  const ids = pickEvictions(await loadCacheInfo(), await loadEntries(), limit);
  for (const id of ids) await dropFile(id);
  return ids;
}

/** A random id. crypto.randomUUID needs a secure context, which the Pi build doesn't have. */
export function newId(): string {
  return [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
