// The few Drive v3 calls the sync needs. With the drive.file scope, Drive only shows this app
// the files and folders it created itself.
// SPDX-License-Identifier: AGPL-3.0-or-later

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';

import { type Child, type RemoteFile, type RemoteStore, type Tree, usableName, type Written } from './storage';

/** The token was rejected (expired or revoked): sign in again. */
export class AuthExpired extends Error {}

type ChildJson = {
  id: string;
  name: string;
  mimeType: string;
  version: string;
  md5Checksum?: string;
  modifiedTime: string;
  parents?: string[];
};
type WrittenJson = { id: string; version: string; md5Checksum?: string };
const written = (r: WrittenJson): Written => ({ id: r.id, version: r.version, md5: r.md5Checksum });

export class Drive implements RemoteStore {
  constructor(private readonly token: string) {}

  private async call(url: string, init: RequestInit = {}): Promise<Response> {
    const r = await fetch(url, { ...init, headers: { Authorization: `Bearer ${this.token}`, ...init.headers } });
    if (r.status === 401) throw new AuthExpired('401');
    if (!r.ok) throw new Error(`Google Drive: HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 300)}`);
    return r;
  }
  private json<T>(url: string, init?: RequestInit): Promise<T> {
    return this.call(url, init).then((r) => r.json() as Promise<T>);
  }

  async email(): Promise<string> {
    const r = await this.json<{ user?: { emailAddress?: string } }>(`${API}/about?fields=user(emailAddress)`);
    return r.user?.emailAddress ?? '';
  }

  /** Files and folders directly in a folder ('root' = My Drive). */
  async children(parent: string): Promise<Child[]> {
    const out: Child[] = [];
    let pageToken = '';
    do {
      const q = `'${parent}' in parents and trashed = false`;
      const r = await this.json<{ files: ChildJson[]; nextPageToken?: string }>(
        `${API}/files?${new URLSearchParams({ q, fields: 'nextPageToken,files(id,name,mimeType,version,md5Checksum,modifiedTime)', pageSize: '1000', spaces: 'drive', ...(pageToken ? { pageToken } : {}) })}`,
      );
      for (const f of r.files)
        out.push({
          id: f.id,
          name: f.name,
          folder: f.mimeType === FOLDER,
          version: f.version,
          md5: f.md5Checksum,
          modifiedTime: f.modifiedTime,
        });
      pageToken = r.nextPageToken ?? '';
    } while (pageToken);
    return out;
  }

  /**
   * Every file below a folder in one listing (pages of 1000): with the drive.file scope Drive lists
   * only what this app made, so all of it is the app's folders and files. Paths come from the
   * parents.
   */
  async tree(root: string): Promise<Tree> {
    const all: ChildJson[] = [];
    let pageToken = '';
    do {
      const r = await this.json<{ files: ChildJson[]; nextPageToken?: string }>(
        `${API}/files?${new URLSearchParams({ q: 'trashed = false', fields: 'nextPageToken,files(id,name,mimeType,parents,version,md5Checksum,modifiedTime)', pageSize: '1000', spaces: 'drive', ...(pageToken ? { pageToken } : {}) })}`,
      );
      all.push(...r.files);
      pageToken = r.nextPageToken ?? '';
    } while (pageToken);
    const byId = new Map(all.map((f) => [f.id, f]));
    // A path below root, or null when not below it.
    const paths = new Map<string, string | null>([[root, '']]);
    const pathOf = (id: string, depth = 0): string | null => {
      if (paths.has(id)) return paths.get(id)!;
      const f = byId.get(id);
      const parent = f?.parents?.[0];
      let p: string | null = null;
      if (f && parent && depth < 64 && usableName(f.name)) {
        const up = pathOf(parent, depth + 1);
        if (up !== null) p = up ? `${up}/${f.name}` : f.name;
      }
      paths.set(id, p);
      return p;
    };
    const files: RemoteFile[] = [],
      folders = new Map<string, string>([['', root]]);
    const seen = new Set<string>();
    for (const f of all) {
      const path = pathOf(f.id);
      if (!path) continue;
      if (f.mimeType === FOLDER) {
        if (!folders.has(path)) folders.set(path, f.id);
      } else if (!seen.has(path)) {
        seen.add(path);
        files.push({ id: f.id, path, version: f.version, md5: f.md5Checksum, modifiedTime: f.modifiedTime });
      }
    }
    return { files, folders };
  }

  /** The folder of this name in parent, created if missing. */
  async folder(parent: string, name: string): Promise<string> {
    const hit = (await this.children(parent)).find((f) => f.folder && f.name === name);
    if (hit) return hit.id;
    const r = await this.json<{ id: string }>(`${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
    });
    return r.id;
  }

  async download(id: string): Promise<string> {
    return (await this.call(`${API}/files/${id}?alt=media`)).text();
  }

  async downloadBytes(id: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    return (await this.call(`${API}/files/${id}?alt=media`, { signal })).arrayBuffer();
  }

  /**
   * Upload a binary file (a resumable upload: multipart uploads stop at 5 MB). Returns its id.
   */
  async upload(
    parent: string,
    name: string,
    bytes: ArrayBuffer,
    mimeType = 'application/octet-stream',
    signal?: AbortSignal,
  ): Promise<string> {
    const start = await this.call(`${UPLOAD}/files?uploadType=resumable&fields=id`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mimeType },
      body: JSON.stringify({ name, parents: [parent], mimeType }),
    });
    const session = start.headers.get('Location');
    if (!session) throw new Error('Google Drive: no upload session');
    const r = await fetch(session, { method: 'PUT', body: bytes, signal, headers: { 'Content-Type': mimeType } });
    if (r.status === 401) throw new AuthExpired('401');
    if (!r.ok) throw new Error(`Google Drive: HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 300)}`);
    return ((await r.json()) as { id: string }).id;
  }

  async create(parent: string, name: string, text: string): Promise<Written> {
    const boundary = `dolphin${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const body = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify({ name, parents: [parent] }),
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      text,
      `--${boundary}--`,
      '',
    ].join('\r\n');
    return this.json<WrittenJson>(`${UPLOAD}/files?uploadType=multipart&fields=id,version,md5Checksum`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    }).then(written);
  }

  async update(id: string, text: string): Promise<Written> {
    return this.json<WrittenJson>(`${UPLOAD}/files/${id}?uploadType=media&fields=id,version,md5Checksum`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: text,
    }).then(written);
  }

  /** Move to the trash (recoverable in Drive for 30 days). */
  async trash(id: string): Promise<void> {
    await this.call(`${API}/files/${id}?fields=id`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    });
  }
}
