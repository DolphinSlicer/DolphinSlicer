// The sync's speed-ups: several requests at a time, each folder made once, the tree in one
// listing, and Drive's checksum in place of downloads.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Drive } from '../src/drive/api';
import { md5 } from '../src/drive/md5';
import { type Child, oneSync, pool, type RemoteStore, type Written } from '../src/drive/storage';
import { syncFiles } from '../src/drive/sync';

afterEach(() => vi.unstubAllGlobals());

describe('md5', () => {
  it('matches Node’s', () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 1000, 70_000]) {
      const bytes = new TextEncoder().encode('ä€x'.repeat(n).slice(0, n));
      expect(md5(bytes)).toBe(createHash('md5').update(bytes).digest('hex'));
    }
  });
});

describe('pool', () => {
  it('runs at most `limit` at a time and keeps the order', async () => {
    let now = 0,
      most = 0;
    const out = await pool([5, 1, 4, 2, 3, 0], 3, async (ms, i) => {
      most = Math.max(most, ++now);
      await new Promise((r) => setTimeout(r, ms));
      now--;
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3, 4, 5]);
    expect(most).toBe(3);
  });
});

/** An in-memory store whose calls take a while, counting them. */
class SlowStore implements RemoteStore {
  items = new Map<string, { name: string; parent: string; folder: boolean; text: string; version: number }>();
  calls: Record<string, number> = {};
  running = 0;
  most = 0;
  private next = 1;
  private async call<T>(name: string, f: () => T): Promise<T> {
    this.calls[name] = (this.calls[name] ?? 0) + 1;
    this.most = Math.max(this.most, ++this.running);
    await new Promise((r) => setTimeout(r, 5));
    this.running--;
    return f();
  }
  add(parent: string, name: string, folder: boolean, text = '') {
    const id = `i${this.next++}`;
    this.items.set(id, { name, parent, folder, text, version: 1 });
    return id;
  }
  private child = (id: string): Child => {
    const it = this.items.get(id)!;
    return {
      id,
      name: it.name,
      folder: it.folder,
      version: String(it.version),
      md5: it.folder ? undefined : md5(new TextEncoder().encode(it.text)),
      modifiedTime: '2026-11-26T10:00:00Z',
    };
  };
  children(parent: string) {
    return this.call('children', () => [...this.items.keys()].filter((id) => this.items.get(id)!.parent === parent).map(this.child));
  }
  folder(parent: string, name: string) {
    return this.call('folder', () => {
      const hit = [...this.items.entries()].find(([, it]) => it.folder && it.parent === parent && it.name === name);
      return hit ? hit[0] : this.add(parent, name, true);
    });
  }
  download(id: string) {
    return this.call('download', () => this.items.get(id)!.text);
  }
  downloadBytes(): Promise<ArrayBuffer> {
    throw new Error('not used');
  }
  upload(): Promise<string> {
    throw new Error('not used');
  }
  create(parent: string, name: string, text: string) {
    return this.call('create', (): Written => {
      const id = this.add(parent, name, false, text);
      return { id, version: '1', md5: this.child(id).md5 };
    });
  }
  update(id: string, text: string) {
    return this.call('update', (): Written => {
      const it = this.items.get(id)!;
      it.text = text;
      it.version++;
      return { id, version: String(it.version), md5: this.child(id).md5 };
    });
  }
  trash(id: string) {
    return this.call('trash', () => {
      this.items.delete(id);
    });
  }
}

const presets = (n: number) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`${['process', 'filament', 'machine'][i % 3]}/P${i}.json`, `{"n":${i}}`]));

describe('first sync', () => {
  it('uploads several at a time and makes each folder once', async () => {
    const store = new SlowStore();
    const r = await syncFiles(oneSync(store), presets(30), {}, { files: {} }, () => true);
    expect(r.pushed).toBe(30);
    expect(store.most).toBeGreaterThan(4);
    const folders = [...store.items.values()].filter((it) => it.folder).map((it) => it.name);
    expect(folders.sort()).toEqual(['DolphinSlicer', 'Presets', 'filament', 'machine', 'process']);
  });

  it('downloads what is new, and only compares checksums of what this device has too', async () => {
    const store = new SlowStore();
    const files = presets(30);
    await syncFiles(oneSync(store), files, {}, { files: {} }, () => true);
    // Another device with half of them, never synced.
    const half = Object.fromEntries(Object.entries(files).slice(0, 15));
    store.calls = {};
    const r = await syncFiles(oneSync(store), half, {}, { files: {} }, () => true);
    expect(r.files).toEqual(files);
    expect(store.calls.download).toBe(15);
    expect(r.conflicts).toEqual([]);
  });
});

describe('Drive tree', () => {
  it('lists everything in one request and builds the paths from the parents', async () => {
    const F = 'application/vnd.google-apps.folder';
    const files = [
      { id: 'app', name: 'DolphinSlicer', mimeType: F, parents: ['root0'] },
      { id: 'pre', name: 'Presets', mimeType: F, parents: ['app'] },
      { id: 'proc', name: 'process', mimeType: F, parents: ['pre'] },
      { id: 'a', name: 'A.json', mimeType: 'application/json', parents: ['proc'], md5Checksum: 'm1' },
      { id: 'b', name: 'B.json', mimeType: 'application/json', parents: ['pre'] },
      { id: 'm', name: 'library.json', mimeType: 'application/json', parents: ['app'] },
    ].map((f) => ({ version: '1', modifiedTime: '2026-11-26T10:00:00Z', ...f }));
    const fetch = vi.fn(async () => new Response(JSON.stringify({ files })));
    vi.stubGlobal('fetch', fetch);
    const t = await new Drive('token').tree('pre');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(t.files.map((f) => [f.path, f.id, f.md5])).toEqual([
      ['process/A.json', 'a', 'm1'],
      ['B.json', 'b', undefined],
    ]);
    expect([...t.folders]).toEqual([
      ['', 'pre'],
      ['process', 'proc'],
    ]);
  });
});
