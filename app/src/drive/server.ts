// A folder on the server that hosts the app, for self-hosting without Google Drive: "storage/"
// next to index.html, written with HTTP PUT, MKCOL and DELETE and listed as JSON (nginx's WebDAV
// methods with `autoindex_format json`, see docs/SELF_HOST_PI.md). Ids are paths in that folder.
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Child, RemoteStore, Written } from './storage';

/** One entry of nginx's JSON folder listing. */
type Listed = { name: string; type: 'file' | 'directory' | 'other'; mtime: string; size?: number };

const join = (parent: string, name: string) => (parent === 'root' || !parent ? name : `${parent}/${name}`);
const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

export class ServerFolder implements RemoteStore {
  /** `base`: the storage folder's URL, ending in a slash. */
  constructor(readonly base: string) {}

  private url(path: string, folder = false): string {
    const p = path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    return this.base + p + (folder && p ? '/' : '');
  }

  private async call(url: string, init: RequestInit = {}): Promise<Response> {
    const r = await fetch(url, { cache: 'no-store', ...init });
    if (!r.ok) throw new Error(`Server storage: HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 300)}`);
    return r;
  }

  async children(parent: string): Promise<Child[]> {
    const dir = parent === 'root' ? '' : parent;
    const r = await fetch(this.url(dir, true), { cache: 'no-store' });
    // Not written yet.
    if (r.status === 404) return [];
    if (!r.ok) throw new Error(`Server storage: HTTP ${r.status}`);
    const list = (await r.json()) as Listed[];
    return list
      .filter((f) => f.type === 'file' || f.type === 'directory')
      .map((f) => {
        const time = Date.parse(f.mtime);
        return {
          id: join(dir, f.name),
          name: f.name,
          folder: f.type === 'directory',
          // The listing has no checksum: the time (to the second) and size stand for the content.
          version: `${time}:${f.size ?? 0}`,
          modifiedTime: new Date(time).toISOString(),
        };
      });
  }

  /** The folder of this name in parent, created if missing (so listing it finds it). */
  async folder(parent: string, name: string): Promise<string> {
    const id = join(parent, name);
    if (!(await this.children(parent)).some((c) => c.folder && c.name === name)) await this.call(this.url(id, true), { method: 'MKCOL' });
    return id;
  }

  async download(id: string): Promise<string> {
    return (await this.call(this.url(id))).text();
  }

  async downloadBytes(id: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    return (await this.call(this.url(id), { signal })).arrayBuffer();
  }

  /** As written, the way the listing shows it. */
  private async written(id: string): Promise<Written> {
    const f = (await this.children(dirOf(id))).find((c) => c.id === id);
    return { id, version: f?.version ?? '' };
  }

  private put(id: string, body: BodyInit, type: string, signal?: AbortSignal) {
    return this.call(this.url(id), { method: 'PUT', body, signal, headers: { 'Content-Type': type } });
  }

  /** A new file never replaces one of the same name (two models may have the same file name). */
  async upload(parent: string, name: string, bytes: ArrayBuffer, mimeType = 'application/octet-stream', signal?: AbortSignal) {
    const taken = new Set((await this.children(parent)).map((c) => c.name));
    let free = name;
    for (let n = 2; taken.has(free); n++) free = name.replace(/(\.[^.]+)?$/, (ext) => ` (${n})${ext}`);
    const id = join(parent, free);
    await this.put(id, bytes, mimeType, signal);
    return id;
  }

  async create(parent: string, name: string, text: string): Promise<Written> {
    return this.update(join(parent, name), text);
  }

  async update(id: string, text: string): Promise<Written> {
    await this.put(id, text, 'application/json; charset=UTF-8');
    return this.written(id);
  }

  async trash(id: string): Promise<void> {
    const r = await fetch(this.url(id), { method: 'DELETE' });
    if (!r.ok && r.status !== 404) throw new Error(`Server storage: HTTP ${r.status}`);
  }
}

/** The storage folder's URL when the server that hosts the app has one, else null. */
export async function findServerStorage(): Promise<string | null> {
  const base = new URL('storage/', document.baseURI).href;
  try {
    const r = await fetch(base, { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!r.ok || !r.headers.get('Content-Type')?.includes('json')) return null;
    return Array.isArray(await r.json()) ? base : null;
  } catch {
    return null;
  }
}
