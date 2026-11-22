// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { plan } from '../src/drive/sync';

const R = (id: string, version: string, modifiedTime = '2026-11-08T10:00:00Z') => ({ id, path: '', version, modifiedTime });
const L = (hash: string, mtime = 0) => ({ hash, mtime });
const S = (id: string, version: string, hash: string) => ({ id, version, hash });

describe('drive sync plan', () => {
  it('copies one-sided changes, new files and deletions', () => {
    expect(plan({ a: L('h1') }, {}, {})).toEqual([{ op: 'push', path: 'a' }]);
    expect(plan({}, { a: R('1', '5') }, {})).toEqual([{ op: 'pull', path: 'a', id: '1' }]);
    expect(plan({ a: L('h2') }, { a: R('1', '5') }, { a: S('1', '5', 'h1') })).toEqual([{ op: 'push', path: 'a', id: '1' }]);
    expect(plan({ a: L('h1') }, { a: R('1', '6') }, { a: S('1', '5', 'h1') })).toEqual([{ op: 'pull', path: 'a', id: '1' }]);
    expect(plan({ a: L('h1') }, { a: R('1', '5') }, { a: S('1', '5', 'h1') })).toEqual([]);
    // Deleted on the other side.
    expect(plan({ a: L('h1') }, {}, { a: S('1', '5', 'h1') })).toEqual([{ op: 'deleteLocal', path: 'a' }]);
    expect(plan({}, { a: R('1', '5') }, { a: S('1', '5', 'h1') })).toEqual([{ op: 'trash', path: 'a', id: '1' }]);
    expect(plan({}, {}, { a: S('1', '5', 'h1') })).toEqual([{ op: 'forget', path: 'a' }]);
  });

  it('keeps an edit over a deletion on the other side', () => {
    expect(plan({ a: L('h2') }, {}, { a: S('1', '5', 'h1') })).toEqual([{ op: 'push', path: 'a' }]);
    expect(plan({}, { a: R('1', '6') }, { a: S('1', '5', 'h1') })).toEqual([{ op: 'pull', path: 'a', id: '1' }]);
  });

  it('goes by the content checksum, not the version, when both sides have one', () => {
    const Rm = (version: string, md5: string) => ({ id: '1', path: '', version, md5, modifiedTime: '2026-11-08T10:00:00Z' });
    const Sm = (version: string, md5: string, hash: string) => ({ id: '1', version, md5, hash });
    // Drive moved the version on by itself: nothing to pull, a local edit is pushed.
    expect(plan({ a: L('h1') }, { a: Rm('7', 'm1') }, { a: Sm('5', 'm1', 'h1') })).toEqual([]);
    expect(plan({ a: L('h2') }, { a: Rm('7', 'm1') }, { a: Sm('5', 'm1', 'h1') })).toEqual([{ op: 'push', path: 'a', id: '1' }]);
    // Changed content in Drive is still seen.
    expect(plan({ a: L('h1') }, { a: Rm('7', 'm2') }, { a: Sm('5', 'm1', 'h1') })).toEqual([{ op: 'pull', path: 'a', id: '1' }]);
  });

  it('lets the newer side win when both changed', () => {
    const remote = { a: R('1', '6', '2026-11-08T10:00:00Z') };
    const at = (iso: string) => Date.parse(iso);
    expect(plan({ a: L('h2', at('2026-11-08T11:00:00Z')) }, remote, { a: S('1', '5', 'h1') })).toEqual([
      { op: 'resolve', path: 'a', id: '1', newer: 'local' },
    ]);
    expect(plan({ a: L('h2', at('2026-11-08T09:00:00Z')) }, remote, { a: S('1', '5', 'h1') })).toEqual([
      { op: 'resolve', path: 'a', id: '1', newer: 'remote' },
    ]);
    // First sync of a device that already has the same file: compared, not copied blindly.
    expect(plan({ a: L('h1') }, { a: R('1', '5') }, {})[0]!.op).toBe('resolve');
  });
});
