// Two-way sync of the user preset files (desktop format, as the engine writes them) with a
// "DolphinSlicer/Presets" folder in the user's Drive.
//
// The last synced state (Drive file id + content checksum, content hash) tells which side changed:
//   changed on one side        → copy it to the other side (also deletions);
//   changed on both sides      → the newer one wins, unless both have the same content; the
//                                other is kept in "DolphinSlicer/Conflicts" (nothing is dropped);
//   new on both sides          → the same.
// Local changes are only applied when the caller allows it (no unsaved edits in the app);
// otherwise those steps wait for the next sync.
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { UserFiles } from '../engine/protocol';
import type { Drive, RemoteFile } from './api';

/** `md5`: the Drive file's content checksum when synced (`version` for state saved before it). */
export interface SyncedEntry {
  id: string;
  version: string;
  md5?: string;
  hash: string;
}
export interface SyncState {
  files: Record<string, SyncedEntry>;
}

export interface LocalFile {
  hash: string;
  mtime: number;
}

export type Step =
  | { op: 'push'; path: string; id?: string }
  | { op: 'pull'; path: string; id: string }
  | { op: 'deleteLocal'; path: string }
  | { op: 'trash'; path: string; id: string }
  /** Both sides changed: compare the contents; if they differ, the newer side wins. */
  | { op: 'resolve'; path: string; id: string; newer: 'local' | 'remote' }
  | { op: 'forget'; path: string };

export function plan(local: Record<string, LocalFile>, remote: Record<string, RemoteFile>, synced: Record<string, SyncedEntry>): Step[] {
  const steps: Step[] = [];
  for (const path of new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(synced)])) {
    const L = local[path],
      R = remote[path],
      S = synced[path];
    const localChanged = L ? !S || S.hash !== L.hash : !!S;
    // Drive's version also counts changes on Google's side that leave the content as it was, so
    // the content checksum decides when both have one.
    const remoteChanged = R ? !S || S.id !== R.id || (S.md5 && R.md5 ? S.md5 !== R.md5 : S.version !== R.version) : !!S;
    if (L && R) {
      if (localChanged && remoteChanged)
        steps.push({ op: 'resolve', path, id: R.id, newer: L.mtime >= Date.parse(R.modifiedTime) ? 'local' : 'remote' });
      else if (remoteChanged) steps.push({ op: 'pull', path, id: R.id });
      else if (localChanged) steps.push({ op: 'push', path, id: R.id });
    } else if (L) {
      // Deleted in Drive, or new here. A local edit since the last sync wins over a deletion.
      if (S && !localChanged) steps.push({ op: 'deleteLocal', path });
      else steps.push({ op: 'push', path });
    } else if (R) {
      if (S && !remoteChanged) steps.push({ op: 'trash', path, id: R.id });
      else steps.push({ op: 'pull', path, id: R.id });
    } else {
      steps.push({ op: 'forget', path });
    }
  }
  return steps;
}

export async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface SyncResult {
  /** The new local files, or null when nothing local changed. */
  files: UserFiles | null;
  mtimes: Record<string, number>;
  state: SyncState;
  /** Paths changed on both sides with different contents (the newer one was kept, the other saved in Conflicts). */
  conflicts: string[];
  /** Local changes waiting for the app to allow them. */
  waiting: number;
  pushed: number;
  pulled: number;
}

export async function syncFiles(
  drive: Drive,
  files: UserFiles,
  mtimes: Record<string, number>,
  state: SyncState,
  /** Whether a local file may change now (not one of presets with unsaved edits). */
  canChange: (path: string) => boolean,
): Promise<SyncResult> {
  const app = await drive.folder('root', 'DolphinSlicer');
  const root = await drive.folder(app, 'Presets');
  const tree = await drive.tree(root);
  const remote = Object.fromEntries(tree.files.map((f) => [f.path, f]));
  const local: Record<string, LocalFile> = {};
  for (const [p, text] of Object.entries(files)) local[p] = { hash: await sha256(text), mtime: mtimes[p] ?? 0 };

  const out: UserFiles = { ...files };
  const outMtimes = { ...mtimes };
  const synced = { ...state.files };
  const r: SyncResult = { files: null, mtimes: outMtimes, state: { files: synced }, conflicts: [], waiting: 0, pushed: 0, pulled: 0 };
  let localChanged = false;

  const folderFor = async (path: string) => {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    let id = tree.folders.get(dir);
    if (id) return id;
    let cur = '';
    id = root;
    for (const part of dir.split('/')) {
      cur = cur ? `${cur}/${part}` : part;
      id = tree.folders.get(cur) ?? (await drive.folder(id, part));
      tree.folders.set(cur, id);
    }
    return id;
  };
  let conflictsId: string | undefined;
  const conflicts = async () => (conflictsId ??= await drive.folder(app, 'Conflicts'));
  const push = async (path: string, id?: string) => {
    const text = files[path]!;
    const res = id ? await drive.update(id, text) : await drive.create(await folderFor(path), path.split('/').pop()!, text);
    synced[path] = { id: res.id, version: res.version, md5: res.md5, hash: local[path]!.hash };
    r.pushed++;
  };
  const pull = async (path: string, id: string, text?: string) => {
    if (!canChange(path)) {
      r.waiting++;
      return;
    }
    text ??= await drive.download(id);
    out[path] = text;
    outMtimes[path] = Date.parse(remote[path]!.modifiedTime) || Date.now();
    synced[path] = { id, version: remote[path]!.version, md5: remote[path]!.md5, hash: await sha256(text) };
    localChanged = true;
    r.pulled++;
  };

  for (const s of plan(local, remote, state.files)) {
    switch (s.op) {
      case 'push':
        await push(s.path, s.id);
        break;
      case 'pull':
        await pull(s.path, s.id);
        break;
      case 'trash':
        await drive.trash(s.id);
        delete synced[s.path];
        break;
      case 'deleteLocal':
        if (!canChange(s.path)) {
          r.waiting++;
          break;
        }
        delete out[s.path];
        delete outMtimes[s.path];
        delete synced[s.path];
        localChanged = true;
        break;
      case 'resolve': {
        const text = await drive.download(s.id);
        const hash = await sha256(text);
        if (hash === local[s.path]!.hash) {
          synced[s.path] = { id: s.id, version: remote[s.path]!.version, md5: remote[s.path]!.md5, hash };
          break;
        }
        // Drive still has what was last synced (only its version moved): not changed there after all.
        if (hash === state.files[s.path]?.hash) {
          await push(s.path, s.id);
          break;
        }
        r.conflicts.push(s.path);
        // Keep the losing version: "process/X.json" → "Conflicts/process/X.2026-11-08T10-00-00.json".
        const loser = s.newer === 'local' ? text : files[s.path]!;
        const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
        const dir = s.path.includes('/') ? s.path.slice(0, s.path.lastIndexOf('/')) : '';
        const base = s.path
          .split('/')
          .pop()!
          .replace(/(\.[^.]+)?$/, (ext) => `.${stamp}${ext}`);
        let folder = await conflicts();
        for (const part of dir ? dir.split('/') : []) folder = await drive.folder(folder, part);
        await drive.create(folder, base, loser);
        if (s.newer === 'local') await push(s.path, s.id);
        else await pull(s.path, s.id, text);
        break;
      }
      case 'forget':
        delete synced[s.path];
        break;
    }
  }
  if (localChanged) r.files = out;
  return r;
}
