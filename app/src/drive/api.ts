// The few Drive v3 calls the sync needs. With the drive.file scope, Drive only shows this app
// the files and folders it created itself.
// SPDX-License-Identifier: AGPL-3.0-or-later

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';

/** The token was rejected (expired or revoked): sign in again. */
export class AuthExpired extends Error {}

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
type Child = { id: string; name: string; mimeType: string; version: string; md5Checksum?: string; modifiedTime: string };

type WrittenJson = { id: string; version: string; md5Checksum?: string };
export interface Written {
  id: string;
  version: string;
  md5?: string;
}
const written = (r: WrittenJson): Written => ({ id: r.id, version: r.version, md5: r.md5Checksum });

export class Drive {
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
    const out = [];
    let pageToken = '';
    do {
      const q = `'${parent}' in parents and trashed = false`;
      const r = await this.json<{ files: Child[]; nextPageToken?: string }>(
        `${API}/files?${new URLSearchParams({ q, fields: 'nextPageToken,files(id,name,mimeType,version,md5Checksum,modifiedTime)', pageSize: '1000', spaces: 'drive', ...(pageToken ? { pageToken } : {}) })}`,
      );
      out.push(...r.files);
      pageToken = r.nextPageToken ?? '';
    } while (pageToken);
    return out;
  }

  /** The folder of this name in parent, created if missing. */
  async folder(parent: string, name: string): Promise<string> {
    const hit = (await this.children(parent)).find((f) => f.mimeType === FOLDER && f.name === name);
    if (hit) return hit.id;
    const r = await this.json<{ id: string }>(`${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
    });
    return r.id;
  }

  /** Every file below a folder, with its path relative to it ("process/My preset.json"). */
  async tree(root: string): Promise<{ files: RemoteFile[]; folders: Map<string, string> }> {
    const files: RemoteFile[] = [],
      folders = new Map<string, string>([['', root]]);
    const walk = async (id: string, prefix: string) => {
      for (const f of await this.children(id)) {
        // Names with a slash cannot be a desktop preset path; skip them.
        if (f.name.includes('/') || f.name === '..' || f.name === '.') continue;
        const path = prefix ? `${prefix}/${f.name}` : f.name;
        if (f.mimeType === FOLDER) {
          folders.set(path, f.id);
          await walk(f.id, path);
        } else if (!files.some((x) => x.path === path))
          files.push({ id: f.id, path, version: f.version, md5: f.md5Checksum, modifiedTime: f.modifiedTime });
      }
    };
    await walk(root, '');
    return { files, folders };
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
