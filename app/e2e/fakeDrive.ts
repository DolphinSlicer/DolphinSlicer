// A fake Google sign-in and Drive v3 for tests: the calls src/drive uses, in memory.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto';
import type { BrowserContext, Route } from '@playwright/test';

interface Item {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  trashed: boolean;
  version: number;
  modifiedTime: string;
  content: string;
  bytes?: Buffer;
}

export class FakeDrive {
  items = new Map<string, Item>();
  private next = 1;
  token = 'fake-token';
  /** File downloads (alt=media) so far. */
  downloads = 0;
  /**
   * As Google's Drive does at times: a file's version moves on again after an upload, with the
   * content as it was ("every change made to the file on the server, even those not visible").
   */
  bumpAfterUpload = false;
  private bumps = new Set<string>();

  /** Files (not folders) by path below "DolphinSlicer/Presets", not trashed. */
  presetFiles(): Record<string, string> {
    return this.filesUnder('Presets');
  }
  /** Files below "DolphinSlicer/Models" (model files as their sizes, library.json as text). */
  modelFiles(): Record<string, string> {
    return this.filesUnder('Models');
  }
  /** The library index, parsed. */
  libraryIndex(): { entries: { id: string; name: string; file: string; tags: string[]; deleted?: number; driveId?: string }[] } | null {
    const t = this.modelFiles()['library.json'];
    return t ? JSON.parse(t) : null;
  }
  /** Not trashed model files (not the index) in "DolphinSlicer/Models", by name. */
  modelBlobs(): Item[] {
    const models = [...this.items.values()].find((it) => it.name === 'Models' && it.mimeType.endsWith('folder'));
    return [...this.items.values()].filter((it) => !it.trashed && it.parents[0] === models?.id && it.name !== 'library.json');
  }
  /** "DolphinSlicer/printers.json", parsed. */
  printersFile(): { printers: { id: string; deleted?: true; printer?: { name: string; apiKey?: string } }[] } | null {
    const t = this.filesUnder('DolphinSlicer')['printers.json'];
    return t ? JSON.parse(t) : null;
  }
  /** "DolphinSlicer/settings.json", parsed. */
  settingsFile(): { settings: Record<string, { value: unknown; modified: number }> } | null {
    const t = this.filesUnder('DolphinSlicer')['settings.json'];
    return t ? JSON.parse(t) : null;
  }
  /** Files below "DolphinSlicer/Conflicts". */
  conflictFiles(): Record<string, string> {
    return this.filesUnder('Conflicts');
  }

  private filesUnder(top: string): Record<string, string> {
    const out: Record<string, string> = {};
    const path = (it: Item): string | null => {
      const parent = this.items.get(it.parents[0] ?? '');
      if (!parent) return null;
      if (parent.name === top) return it.name;
      const p = path(parent);
      return p === null ? null : `${p}/${it.name}`;
    };
    for (const it of this.items.values()) {
      if (it.trashed || it.mimeType.endsWith('folder')) continue;
      const p = path(it);
      if (p !== null) out[p] = it.bytes ? `<${it.bytes.length} bytes>` : it.content;
    }
    return out;
  }

  private add(name: string, mimeType: string, parents: string[], content = ''): Item {
    const it = {
      id: `f${this.next++}`,
      name,
      mimeType,
      parents,
      trashed: false,
      version: 1,
      modifiedTime: new Date().toISOString(),
      content,
    };
    this.items.set(it.id, it);
    return it;
  }
  private touch(it: Item) {
    it.version++;
    it.modifiedTime = new Date().toISOString();
    if (this.bumpAfterUpload) this.bumps.add(it.id);
  }

  async attach(context: BrowserContext, origin: string) {
    // Sign-in: Google redirects straight back with a token (consent already given).
    await context.route('https://accounts.google.com/**', (route) => {
      const q = new URL(route.request().url()).searchParams;
      const hash = new URLSearchParams({
        access_token: this.token,
        expires_in: '3599',
        token_type: 'Bearer',
        scope: q.get('scope')!,
        state: q.get('state')!,
      });
      return route.fulfill({ status: 302, headers: { Location: `${origin}/oauth.html#${hash}` } });
    });
    await context.route('https://oauth2.googleapis.com/**', (route) => route.fulfill({ status: 200, headers: CORS, body: '{}' }));
    await context.route('https://www.googleapis.com/**', (route) => this.handle(route));
  }

  /** The token service (server/googleAuth.ts): signed in on this browser until revoked. */
  service = { signedIn: false, renewals: 0 };
  async attachService(context: BrowserContext, origin: string) {
    await context.route(`${origin}/api/auth/**`, (route) => {
      const url = new URL(route.request().url());
      const json = (status: number, v: unknown) =>
        route.fulfill({ status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v) });
      switch (url.pathname) {
        case '/api/auth/config':
          return json(200, { enabled: true });
        case '/api/auth/start': {
          this.service.signedIn = true;
          const hash = new URLSearchParams({
            access_token: this.token,
            expires_in: '3599',
            token_type: 'Bearer',
            scope: SCOPE,
            state: url.searchParams.get('state')!,
          });
          return route.fulfill({ status: 302, headers: { Location: `${origin}/oauth.html#${hash}` } });
        }
        case '/api/auth/token':
          if (!this.service.signedIn) return json(401, { error: 'signed_out' });
          this.service.renewals++;
          return json(200, { access_token: this.token, expires_in: 3599, scope: SCOPE });
        case '/api/auth/logout':
          this.service.signedIn = false;
          return route.fulfill({ status: 204 });
        default:
          return json(404, {});
      }
    });
  }

  private async handle(route: Route) {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    // The upload session URL carries its own authorization (as Google's does).
    const session = new URL(req.url()).searchParams.has('upload_id');
    if (!session && req.headers().authorization !== `Bearer ${this.token}`)
      return route.fulfill({ status: 401, headers: CORS, body: '{}' });
    const url = new URL(req.url());
    const json = (v: unknown) =>
      route.fulfill({ status: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(v) });
    const meta = (it: Item) => ({
      id: it.id,
      name: it.name,
      mimeType: it.mimeType,
      version: String(it.version),
      modifiedTime: it.modifiedTime,
      ...(it.mimeType.endsWith('folder')
        ? {}
        : {
            md5Checksum: createHash('md5')
              .update(it.bytes ?? it.content)
              .digest('hex'),
          }),
    });
    // The version bumps after uploads show from the next request on.
    const bump = () => {
      for (const id of this.bumps) {
        const it = this.items.get(id);
        if (it) it.version++;
      }
      this.bumps.clear();
    };
    const m = /^\/(upload\/)?drive\/v3\/(about|files)(?:\/([^/]+))?$/.exec(url.pathname);
    if (!m) return route.fulfill({ status: 404, headers: CORS });
    const [, upload, kind, id] = m;
    if (kind === 'about') return json({ user: { emailAddress: 'tester@example.com' } });
    if (!id && req.method() === 'GET') {
      bump();
      const parent = /'([^']+)' in parents/.exec(url.searchParams.get('q') ?? '')?.[1];
      return json({ files: [...this.items.values()].filter((it) => !it.trashed && it.parents.includes(parent!)).map(meta) });
    }
    if (!id && req.method() === 'POST' && !upload) {
      const b = req.postDataJSON() as { name: string; mimeType: string; parents: string[] };
      return json(meta(this.add(b.name, b.mimeType, b.parents)));
    }
    if (!id && upload && url.searchParams.get('uploadType') === 'resumable') {
      if (req.method() === 'POST') {
        const b = req.postDataJSON() as { name: string; mimeType: string; parents: string[] };
        const it = this.add(b.name, b.mimeType, b.parents);
        const location = `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${it.id}`;
        return route.fulfill({
          status: 200,
          headers: { ...CORS, 'Access-Control-Expose-Headers': 'Location', Location: location },
          body: '',
        });
      }
      if (req.method() === 'PUT') {
        const it = this.items.get(url.searchParams.get('upload_id')!)!;
        it.bytes = req.postDataBuffer() ?? Buffer.alloc(0);
        this.touch(it);
        return json(meta(it));
      }
    }
    if (!id && req.method() === 'POST' && upload) {
      const boundary = /boundary=(.+)$/.exec(req.headers()['content-type']!)![1]!;
      const parts = req
        .postData()!
        .split(`--${boundary}`)
        .slice(1, -1)
        .map((p) => p.slice(p.indexOf('\r\n\r\n') + 4, -2));
      const b = JSON.parse(parts[0]!) as { name: string; parents: string[] };
      const it = this.add(b.name, 'application/json', b.parents, parts[1]!);
      if (this.bumpAfterUpload) this.bumps.add(it.id);
      return json(meta(it));
    }
    const it = this.items.get(id!);
    if (!it) return route.fulfill({ status: 404, headers: CORS });
    if (req.method() === 'GET') {
      this.downloads++;
      return route.fulfill({ status: 200, headers: CORS, body: it.bytes ?? it.content });
    }
    if (req.method() === 'PATCH' && upload) {
      it.content = req.postData() ?? '';
      this.touch(it);
      return json(meta(it));
    }
    if (req.method() === 'PATCH') {
      Object.assign(it, req.postDataJSON());
      this.touch(it);
      return json(meta(it));
    }
    return route.fulfill({ status: 405, headers: CORS });
  }
}

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Upload-Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
};
