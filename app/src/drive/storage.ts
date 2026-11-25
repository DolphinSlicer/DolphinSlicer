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
}

/** Every file below a folder, with its path relative to it ("process/My preset.json"). */
export async function tree(store: RemoteStore, root: string): Promise<{ files: RemoteFile[]; folders: Map<string, string> }> {
  const files: RemoteFile[] = [],
    folders = new Map<string, string>([['', root]]);
  const walk = async (id: string, prefix: string) => {
    for (const f of await store.children(id)) {
      // Names with a slash cannot be a desktop preset path; skip them.
      if (f.name.includes('/') || f.name === '..' || f.name === '.') continue;
      const path = prefix ? `${prefix}/${f.name}` : f.name;
      if (f.folder) {
        folders.set(path, f.id);
        await walk(f.id, path);
      } else if (!files.some((x) => x.path === path))
        files.push({ id: f.id, path, version: f.version, md5: f.md5, modifiedTime: f.modifiedTime });
    }
  };
  await walk(root, '');
  return { files, folders };
}
