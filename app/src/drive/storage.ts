// Where the sync keeps its files: Google Drive (api.ts) or a folder on the server that hosts the
// app (server.ts). Both hold the same "DolphinSlicer" folder.
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `md5` is the content's checksum: unlike `version`, which counts every change on Google's side,
 * also ones the user cannot see, it changes only with the content.
 */
export interface RemoteFile {
  id: string;
  path: string;
  version: string;
  md5?: string;
  modifiedTime: string;
}

export interface Child {
  id: string;
  name: string;
  folder: boolean;
  version: string;
  md5?: string;
  modifiedTime: string;
}

export interface Written {
  id: string;
  version: string;
  md5?: string;
}

export interface RemoteStore {
  /** Files and folders directly in a folder ('root' = the top). */
  children(parent: string): Promise<Child[]>;
  /** The folder of this name in parent, created if missing. */
  folder(parent: string, name: string): Promise<string>;
  download(id: string): Promise<string>;
  downloadBytes(id: string, signal?: AbortSignal): Promise<ArrayBuffer>;
  /** Store a new binary file. Returns its id. */
  upload(parent: string, name: string, bytes: ArrayBuffer, mimeType?: string, signal?: AbortSignal): Promise<string>;
  create(parent: string, name: string, text: string): Promise<Written>;
  update(id: string, text: string): Promise<Written>;
  /** Remove a file (in Drive: to the trash, recoverable for 30 days). */
  trash(id: string): Promise<void>;
  /** Every file below a folder at once, where the store can list that in one go (Drive). */
  tree?(root: string): Promise<Tree>;
}

export interface Tree {
  files: RemoteFile[];
  /** Folder ids by path ('' = the root). */
  folders: Map<string, string>;
}

/** Run `fn` on each item, at most `limit` at a time; the results in the items' order. */
export async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * The store for one sync: each folder looked up (or made) once, also when several steps ask for
 * it at the same time (two at once would make two folders of the same name in Drive).
 */
export function oneSync(store: RemoteStore): RemoteStore {
  const folders = new Map<string, Promise<string>>();
  return {
    children: (parent) => store.children(parent),
    folder(parent, name) {
      const key = `${parent}\n${name}`;
      let id = folders.get(key);
      if (!id) {
        id = store.folder(parent, name);
        folders.set(key, id);
        id.catch(() => folders.delete(key));
      }
      return id;
    },
    download: (id) => store.download(id),
    downloadBytes: (id, signal) => store.downloadBytes(id, signal),
    upload: (parent, name, bytes, mimeType, signal) => store.upload(parent, name, bytes, mimeType, signal),
    create: (parent, name, text) => store.create(parent, name, text),
    update: (id, text) => store.update(id, text),
    trash: (id) => store.trash(id),
    ...(store.tree ? { tree: (root: string) => store.tree!(root) } : {}),
  };
}

/**
 * Every file below a folder, with its path relative to it ("process/My preset.json"): in one go
 * where the store can, else folder by folder (the subfolders of a folder at the same time).
 */
export async function tree(store: RemoteStore, root: string): Promise<Tree> {
  if (store.tree) return store.tree(root);
  const files: RemoteFile[] = [],
    folders = new Map<string, string>([['', root]]);
  const seen = new Set<string>();
  const walk = async (id: string, prefix: string): Promise<void> => {
    const sub: Promise<void>[] = [];
    for (const f of await store.children(id)) {
      if (!usableName(f.name)) continue;
      const path = prefix ? `${prefix}/${f.name}` : f.name;
      if (f.folder) {
        folders.set(path, f.id);
        sub.push(walk(f.id, path));
      } else if (!seen.has(path)) {
        seen.add(path);
        files.push({ id: f.id, path, version: f.version, md5: f.md5, modifiedTime: f.modifiedTime });
      }
    }
    await Promise.all(sub);
  };
  await walk(root, '');
  return { files, folders };
}

/** Names with a slash cannot be a desktop preset path; they are skipped. */
export const usableName = (name: string) => !name.includes('/') && name !== '..' && name !== '.';
