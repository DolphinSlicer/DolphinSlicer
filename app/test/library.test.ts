// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { type CacheInfo, type LibraryEntry, pickEvictions } from '../src/library/store';
import { mergeEntries } from '../src/library/sync';
import { matches } from '../src/ui/LibraryView';

const entry = (id: string, o: Partial<LibraryEntry> = {}): LibraryEntry => ({
  id,
  name: id,
  file: `${id}.stl`,
  size: 1,
  tags: [],
  thumb: '',
  added: 1,
  modified: 1,
  ...o,
});

describe('library index merge', () => {
  it('keeps entries from both sides', () => {
    expect(mergeEntries([entry('b')], [entry('a')]).map((e) => e.id)).toEqual(['a', 'b']);
  });
  it('takes the newer edit', () => {
    const [m] = mergeEntries([entry('a', { name: 'local', modified: 5 })], [entry('a', { name: 'remote', modified: 3 })]);
    expect(m!.name).toBe('local');
    const [n] = mergeEntries([entry('a', { name: 'local', modified: 2 })], [entry('a', { name: 'remote', modified: 3 })]);
    expect(n!.name).toBe('remote');
  });
  it('keeps the Drive file id whichever side wins', () => {
    const [m] = mergeEntries([entry('a', { name: 'renamed', modified: 9 })], [entry('a', { modified: 3, driveId: 'd1' })]);
    expect(m).toMatchObject({ name: 'renamed', driveId: 'd1' });
  });
  it('a newer deletion wins over an older edit, and a newer edit over an older deletion', () => {
    expect(mergeEntries([entry('a', { deleted: 5, modified: 5 })], [entry('a', { modified: 4 })])[0]!.deleted).toBe(5);
    expect(mergeEntries([entry('a', { deleted: 5, modified: 5 })], [entry('a', { modified: 6 })])[0]!.deleted).toBeUndefined();
  });
});

describe('cache eviction', () => {
  const cache = new Map<string, CacheInfo>([
    ['old', { size: 40, used: 1 }],
    ['mid', { size: 40, used: 2 }],
    ['new', { size: 40, used: 3 }],
    ['local', { size: 40, used: 0 }],
  ]);
  const entries = new Map([
    ['old', entry('old', { driveId: 'x' })],
    ['mid', entry('mid', { driveId: 'y' })],
    ['new', entry('new', { driveId: 'z' })],
    ['local', entry('local')],
  ]);
  it('drops the least recently used files in Drive until the rest fits', () => {
    expect(pickEvictions(cache, entries, 100)).toEqual(['old', 'mid']);
    expect(pickEvictions(cache, entries, 160)).toEqual([]);
  });
  it('never drops files that are only on this device', () => {
    expect(pickEvictions(cache, entries, 0)).toEqual(['old', 'mid', 'new']);
  });
});

describe('library search', () => {
  const e = entry('x', { name: 'Calibration cube', file: 'xyz_cube.stl', tags: ['test', 'small'] });
  it('matches every word in name, file or tags', () => {
    expect(matches(e, 'cube small', [])).toBe(true);
    expect(matches(e, 'XYZ', [])).toBe(true);
    expect(matches(e, 'cube big', [])).toBe(false);
  });
  it('needs every chosen tag', () => {
    expect(matches(e, '', ['test'])).toBe(true);
    expect(matches(e, '', ['test', 'other'])).toBe(false);
  });
});
