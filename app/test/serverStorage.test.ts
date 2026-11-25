// The self-hosted server's storage folder, against a fake of nginx with WebDAV PUT, MKCOL and
// DELETE and a JSON folder listing (docs/SELF_HOST_PI.md).
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerFolder } from '../src/drive/server';
import { sha256Js, syncFiles } from '../src/drive/sync';

const BASE = 'http://pi.test/dolphin/storage/';

/** Files by path, with nginx's mtime (whole seconds), and folders ("a/b/"). */
function fakeNginx() {
  const files = new Map<string, { body: Uint8Array; mtime: number }>();
  const dirs = new Set<string>(['']);
  const addDirs = (path: string) => {
    for (let i = path.indexOf('/'); i >= 0; i = path.indexOf('/', i + 1)) dirs.add(path.slice(0, i + 1));
  };
  let clock = Date.parse('2026-11-25T10:00:00Z');
  const tick = () => (clock += 1000);
  const fetch = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const path = decodeURIComponent(String(input).slice(BASE.length));
    const method = init.method ?? 'GET';
    if (method === 'PUT') {
      const body = typeof init.body === 'string' ? new TextEncoder().encode(init.body) : new Uint8Array(init.body as ArrayBuffer);
      const had = files.has(path);
      addDirs(path); // create_full_put_path
      files.set(path, { body, mtime: tick() });
      return new Response(null, { status: had ? 204 : 201 });
    }
    if (method === 'MKCOL') {
      if (dirs.has(path)) return new Response(null, { status: 405 });
      dirs.add(path);
      return new Response(null, { status: 201 });
    }
    if (method === 'DELETE') return new Response(null, { status: files.delete(path) ? 204 : 404 });
    if (path === '' || path.endsWith('/')) {
      if (!dirs.has(path)) return new Response('not found', { status: 404 });
      const names = new Map<string, { type: string; mtime: number; size?: number }>();
      for (const d of dirs) {
        const rest = d.slice(path.length);
        if (d.startsWith(path) && rest && rest.indexOf('/') === rest.length - 1)
          names.set(rest.slice(0, -1), { type: 'directory', mtime: clock });
      }
      for (const [p, f] of files) {
        const rest = p.slice(path.length);
        if (p.startsWith(path) && !rest.includes('/')) names.set(rest, { type: 'file', mtime: f.mtime, size: f.body.length });
      }
      const list = [...names].map(([name, v]) => ({ name, type: v.type, mtime: new Date(v.mtime).toUTCString(), size: v.size }));
      return new Response(JSON.stringify(list), { headers: { 'Content-Type': 'application/json' } });
    }
    const f = files.get(path);
    return f ? new Response(f.body.slice().buffer) : new Response('not found', { status: 404 });
  });
  return { files, dirs, fetch };
}

let nginx: ReturnType<typeof fakeNginx>;
beforeEach(() => {
  nginx = fakeNginx();
  vi.stubGlobal('fetch', nginx.fetch);
});
afterEach(() => vi.unstubAllGlobals());

const text = (path: string) => new TextDecoder().decode(nginx.files.get(path)?.body);

describe('server storage', () => {
  it('hashes like crypto.subtle where pages over http:// lack it', async () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 1000, 100_000]) {
      const bytes = new TextEncoder().encode('ä€'.repeat(n).slice(0, n));
      const want = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      expect(sha256Js(bytes)).toEqual(want);
    }
  });

  it('syncs presets between two devices through the folder', async () => {
    const store = new ServerFolder(BASE);
    const a = await syncFiles(store, { 'process/My preset.json': '{"a":1}' }, {}, { files: {} }, () => true);
    expect(a.pushed).toBe(1);
    expect(text('DolphinSlicer/Presets/process/My preset.json')).toBe('{"a":1}');
    // The URL encodes the name.
    expect(nginx.fetch.mock.calls.some(([u]) => String(u).endsWith('process/My%20preset.json'))).toBe(true);

    // Another device gets it.
    const b = await syncFiles(store, {}, {}, { files: {} }, () => true);
    expect(b.files).toEqual({ 'process/My preset.json': '{"a":1}' });

    // Unchanged on both sides: nothing to do (the state's version matches the listing).
    const again = await syncFiles(store, { 'process/My preset.json': '{"a":1}' }, {}, a.state, () => true);
    expect([again.pushed, again.pulled, again.files]).toEqual([0, 0, null]);

    // Changed on device B, then deleted on device A after it pulled the change.
    const b2 = await syncFiles(store, { 'process/My preset.json': '{"a":2}' }, {}, b.state, () => true);
    expect(b2.pushed).toBe(1);
    const a2 = await syncFiles(store, { 'process/My preset.json': '{"a":1}' }, {}, a.state, () => true);
    expect(a2.files).toEqual({ 'process/My preset.json': '{"a":2}' });
    await syncFiles(store, {}, {}, a2.state, () => true);
    expect(nginx.files.has('DolphinSlicer/Presets/process/My preset.json')).toBe(false);
  });

  it('never replaces a model file of the same name', async () => {
    const store = new ServerFolder(BASE);
    const one = await store.upload('DolphinSlicer/Models', 'cube.stl', new Uint8Array([1]).buffer);
    const two = await store.upload('DolphinSlicer/Models', 'cube.stl', new Uint8Array([2]).buffer);
    expect([one, two]).toEqual(['DolphinSlicer/Models/cube.stl', 'DolphinSlicer/Models/cube (2).stl']);
    expect(new Uint8Array(await store.downloadBytes(two))).toEqual(new Uint8Array([2]));
  });

  it('creates a missing folder once, and reads one that is gone as empty', async () => {
    const store = new ServerFolder(BASE);
    expect(await store.folder('root', 'DolphinSlicer')).toBe('DolphinSlicer');
    expect(await store.folder('root', 'DolphinSlicer')).toBe('DolphinSlicer');
    expect(nginx.fetch.mock.calls.filter(([, init]) => init?.method === 'MKCOL')).toHaveLength(1);
    expect(nginx.dirs.has('DolphinSlicer/')).toBe(true);
    expect(await store.children('DolphinSlicer/Models')).toEqual([]);
  });
});
