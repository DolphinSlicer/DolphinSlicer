// Google Drive sync of the model library: "DolphinSlicer/Models" holds the model files and
// library.json, the index every device reads (names, tags, thumbnails, which file is which), so
// listing the library never scans or downloads model files.
//
// Entries merge by id: the newer `modified` wins (deletions are kept as entries too, so they
// reach the other devices). Model files are uploaded once and never change; they are downloaded
// only when a model is opened.
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Drive } from '../drive/api';
import type { LibraryEntry } from './store';

export interface LibraryIndex {
  version: 1;
  entries: LibraryEntry[];
}

/** Merge two versions of the index. Pure; the result is sorted by id. */
export function mergeEntries(local: Iterable<LibraryEntry>, remote: Iterable<LibraryEntry>): LibraryEntry[] {
  const out = new Map<string, LibraryEntry>();
  for (const r of remote) out.set(r.id, r);
  for (const l of local) {
    const r = out.get(l.id);
    if (!r) {
      out.set(l.id, l);
      continue;
    }
    const win = l.modified > r.modified ? l : r;
    // Where the file is in Drive is a fact, not an edit: keep it whichever side wins.
    const driveId = win.driveId ?? l.driveId ?? r.driveId;
    out.set(l.id, driveId ? { ...win, driveId } : win);
  }
  return [...out.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const MIME: Record<string, string> = { stl: 'model/stl', '3mf': 'model/3mf', obj: 'model/obj', amf: 'application/x-amf' };
export const mimeFor = (file: string) => MIME[file.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream';

export interface LibrarySyncResult {
  entries: LibraryEntry[];
  uploaded: number;
  changed: boolean;
}

/**
 * Sync the index and upload the files that aren't in Drive yet. `readFile` gives a model file of
 * this device (null if it isn't here).
 */
export async function syncLibrary(
  drive: Drive,
  local: LibraryEntry[],
  readFile: (id: string) => Promise<ArrayBuffer | null>,
  onUploaded?: (entries: LibraryEntry[]) => Promise<void>,
): Promise<LibrarySyncResult> {
  const app = await drive.folder('root', 'DolphinSlicer');
  const folder = await drive.folder(app, 'Models');
  const children = await drive.children(folder);
  const indexFile = children.find((f) => f.name === 'library.json' && !f.mimeType.endsWith('folder'));
  let remoteText = '';
  let remote: LibraryEntry[] = [];
  if (indexFile) {
    remoteText = await drive.download(indexFile.id);
    try {
      const v = JSON.parse(remoteText) as Partial<LibraryIndex>;
      if (Array.isArray(v.entries)) remote = v.entries.filter((e) => e && typeof e.id === 'string');
    } catch {
      /* unreadable: rebuilt from this device */
    }
  }
  const entries = mergeEntries(local, remote);
  let uploaded = 0;
  const present = new Set(children.map((f) => f.id));
  for (const [i, e] of entries.entries()) {
    if (e.deleted) {
      if (e.driveId && present.has(e.driveId)) await drive.trash(e.driveId);
      continue;
    }
    if (e.driveId) continue;
    const bytes = await readFile(e.id);
    if (!bytes) continue; // Added on another device that hasn't uploaded it yet.
    entries[i] = { ...e, driveId: await drive.upload(folder, e.file, bytes, mimeFor(e.file)) };
    uploaded++;
    // Remember each upload right away, so an interrupted sync doesn't upload it twice.
    await onUploaded?.([entries[i]!]);
  }
  const text = `${JSON.stringify({ version: 1, entries } satisfies LibraryIndex, null, 1)}\n`;
  if (text !== remoteText) {
    if (indexFile) await drive.update(indexFile.id, text);
    else await drive.create(folder, 'library.json', text);
  }
  const before = JSON.stringify(mergeEntries(local, []));
  return { entries, uploaded, changed: JSON.stringify(entries) !== before };
}
