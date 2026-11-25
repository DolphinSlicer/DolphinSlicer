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
import { type RemoteFile, type RemoteStore, tree as walkTree } from './storage';

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
  const bytes = new TextEncoder().encode(text);
  // Browsers have crypto.subtle only on https:// pages (a self-hosted server may serve http://).
  const d = crypto.subtle ? new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)) : sha256Js(bytes);
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const K = Uint32Array.from(
  '428a2f98 71374491 b5c0fbcf e9b5dba5 3956c25b 59f111f1 923f82a4 ab1c5ed5 d807aa98 12835b01 243185be 550c7dc3 72be5d74 80deb1fe 9bdc06a7 c19bf174 e49b69c1 efbe4786 0fc19dc6 240ca1cc 2de92c6f 4a7484aa 5cb0a9dc 76f988da 983e5152 a831c66d b00327c8 bf597fc7 c6e00bf3 d5a79147 06ca6351 14292967 27b70a85 2e1b2138 4d2c6dfc 53380d13 650a7354 766a0abb 81c2c92e 92722c85 a2bfe8a1 a81a664b c24b8b70 c76c51a3 d192e819 d6990624 f40e3585 106aa070 19a4c116 1e376c08 2748774c 34b0bcb5 391c0cb3 4ed8aa4a 5b9cca4f 682e6ff3 748f82ee 78a5636f 84c87814 8cc70208 90befffa a4506ceb bef9a3f7 c67178f2'
    .split(' ')
    .map((h) => Number.parseInt(h, 16)),
);

/** SHA-256 (FIPS 180-4), for pages without crypto.subtle. */
export function sha256Js(data: Uint8Array): Uint8Array {
  const len = data.length;
  const blocks = Math.ceil((len + 9) / 64);
  const m = new Uint8Array(blocks * 64);
  m.set(data);
  m[len] = 0x80;
  const view = new DataView(m.buffer);
  view.setUint32(m.length - 8, Math.floor(len / 0x20000000));
  view.setUint32(m.length - 4, (len * 8) >>> 0);
  const h = Uint32Array.of(0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < m.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!,
        b = w[i - 2]!;
      w[i] = (w[i - 16]! + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + w[i - 7]! + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) >>> 0;
    }
    const v = Array.from(h);
    for (let i = 0; i < 64; i++) {
      const [a, b, c, d, e, f, g, k] = v as [number, number, number, number, number, number, number, number];
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      v.pop();
      v.unshift((t1 + t2) >>> 0);
      v[4] = (d + t1) >>> 0;
    }
    for (let i = 0; i < 8; i++) h[i] = h[i]! + v[i]!;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]!);
  return out;
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
  drive: RemoteStore,
  files: UserFiles,
  mtimes: Record<string, number>,
  state: SyncState,
  /** Whether a local file may change now (not one of presets with unsaved edits). */
  canChange: (path: string) => boolean,
): Promise<SyncResult> {
  const app = await drive.folder('root', 'DolphinSlicer');
  const root = await drive.folder(app, 'Presets');
  const tree = await walkTree(drive, root);
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
