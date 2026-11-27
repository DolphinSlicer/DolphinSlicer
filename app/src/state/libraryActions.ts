// The model library: adding models (from files or the plate), opening them on the plate,
// names and tags, deleting, and its part of the Google Drive sync.
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RemoteStore } from '../drive/storage';
import { t } from '../i18n/i18n';
import { dropFile, evict, type LibraryEntry, loadEntries, newId, readFile, removeEntry, saveEntry, writeFile } from '../library/store';
import { syncLibrary } from '../library/sync';
import { renderThumbnail } from '../library/thumbnail';
import { describeError } from '../ui/errors';
import { importFiles, inspectModel, isModelFile, liveFiles } from './actions';
import { remoteStore, requestSync, syncing } from './driveActions';
import { get, notify, set } from './store';

const visible = (all: Iterable<LibraryEntry>) =>
  [...all].filter((e) => !e.deleted).sort((a, b) => b.added - a.added || a.name.localeCompare(b.name));

async function refresh() {
  const entries = visible((await loadEntries()).values());
  set((s) => ({ models: { ...s.models, entries, loaded: true } }));
}

export async function initModels() {
  try {
    await refresh();
  } catch (e) {
    notify({ kind: 'error', ...describeError(e) });
  }
}

const busy = (key: 'adding' | 'opening', v: string, on: boolean) =>
  set((s) => ({ models: { ...s.models, [key]: on ? [...s.models[key], v] : s.models[key].filter((x) => x !== v) } }));

/** "Benchy_v2.3mf" → "Benchy v2". */
export const displayName = (file: string) =>
  file
    .replace(/\.[^.]+$/, '')
    .replace(/[_]+/g, ' ')
    .trim() || file;

/** Add model files to the library. Pass the result of readNow(). Returns the new entries. */
export async function addModels(
  list: { name: string; bytes: Promise<ArrayBuffer> | ArrayBuffer }[],
  tags: string[] = [],
): Promise<LibraryEntry[]> {
  const added: LibraryEntry[] = [];
  for (const f of list) {
    if (!isModelFile(f.name)) {
      notify({ kind: 'warning', title: t('{name} was not added', { name: f.name }), message: t('Supported formats: STL, 3MF, OBJ, AMF.') });
      continue;
    }
    busy('adding', f.name, true);
    try {
      const bytes = await f.bytes;
      // Reading it in the engine checks it opens and gives the meshes for the thumbnail.
      const { info, geometries } = await inspectModel(f.name, bytes);
      let thumb = '';
      try {
        thumb = renderThumbnail(
          info.objects.flatMap((o, k) => o.instances.slice(0, 1).map((i) => ({ geometry: geometries[k]!, matrix: i.matrix }))),
        );
      } catch {
        /* shown without a picture */
      }
      for (const g of geometries) g.dispose();
      const now = Date.now();
      const entry: LibraryEntry = {
        id: newId(),
        name: displayName(f.name),
        file: f.name,
        size: bytes.byteLength,
        tags: [...tags],
        thumb,
        added: now,
        modified: now,
      };
      await writeFile(entry.id, bytes);
      await saveEntry(entry);
      added.push(entry);
    } catch (e) {
      notify({ kind: 'error', ...describeError(e), title: t('Could not add {name}', { name: f.name }) });
    } finally {
      busy('adding', f.name, false);
    }
  }
  if (added.length) {
    await refresh();
    requestSync();
  }
  return added;
}

/** Add the models on the plate (their files as imported). */
export async function addPlateToLibrary() {
  // Not the files of objects deleted since.
  const { files } = liveFiles();
  if (!files.length) return;
  const added = await addModels(files.map((f) => ({ name: f.name, bytes: f.bytes })));
  if (added.length) notify({ kind: 'info', title: t('Added to library'), message: added.map((e) => e.name).join(', ') });
}

/** The model file: from this device, or downloaded from Drive (and kept). */
async function modelBytes(e: LibraryEntry): Promise<ArrayBuffer | null> {
  const local = await readFile(e.id);
  if (local) return local;
  if (!e.driveId) {
    notify({
      kind: 'warning',
      title: t('{name} is not here yet', { name: e.name }),
      message: t('It was added on another device and has not been uploaded yet.'),
    });
    return null;
  }
  const remote = await remoteStore();
  if (!remote) {
    notify({ kind: 'info', title: t('Google Drive'), message: t('Sign in to Google Drive to open this model.') });
    return null;
  }
  const bytes = await remote.downloadBytes(e.driveId);
  await writeFile(e.id, bytes);
  await evict();
  return bytes;
}

/** Download a library model's file (a plate: its 3MF), named as it is in the library. */
export async function downloadModel(id: string) {
  const e = get().models.entries.find((x) => x.id === id);
  if (!e) return;
  try {
    const bytes = await modelBytes(e);
    if (!bytes) return;
    const ext = e.file.includes('.') ? e.file.slice(e.file.lastIndexOf('.')) : '';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes]));
    a.download = `${e.name.replace(/[/\\\0]/g, '_')}${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  } catch (err) {
    notify({ kind: 'error', ...describeError(err), title: t('Could not download {name}', { name: e.name }) });
  }
}

/** Put a library model on the plate. */
export async function openModel(id: string) {
  const e = get().models.entries.find((x) => x.id === id);
  if (!e || get().models.opening.includes(id)) return;
  busy('opening', id, true);
  try {
    const bytes = await modelBytes(e);
    if (!bytes) return;
    set({ view: 'prepare' });
    await importFiles([{ name: e.file, bytes: Promise.resolve(bytes) }]);
  } catch (err) {
    notify({ kind: 'error', ...describeError(err), title: t('Could not open {name}', { name: e.name }) });
  } finally {
    busy('opening', id, false);
  }
}

export async function updateModel(id: string, change: Partial<Pick<LibraryEntry, 'name' | 'tags'>>) {
  const e = (await loadEntries()).get(id);
  if (!e) return;
  // One tag per spelling: "Toys" and "toys" are the same tag, the first one written stays.
  const tags = change.tags
    ? change.tags.map((x) => x.trim()).filter((x, i, l) => x && l.findIndex((y) => y.toLocaleLowerCase() === x.toLocaleLowerCase()) === i)
    : e.tags;
  const name = change.name?.trim() || e.name;
  if (name === e.name && JSON.stringify(tags) === JSON.stringify(e.tags)) return;
  await saveEntry({ ...e, name, tags, modified: Date.now() });
  await refresh();
  requestSync();
}

export async function deleteModel(id: string) {
  const e = (await loadEntries()).get(id);
  if (!e) return;
  await dropFile(id);
  // Once in Drive, other devices have to learn it's gone: keep a deletion mark.
  if (e.driveId || syncing())
    await saveEntry({
      id: e.id,
      name: e.name,
      file: e.file,
      size: e.size,
      tags: [],
      thumb: '',
      added: e.added,
      modified: Date.now(),
      deleted: Date.now(),
      ...(e.driveId ? { driveId: e.driveId } : {}),
    });
  else await removeEntry(id);
  await refresh();
  requestSync();
}

/** The library's part of a Drive sync. */
export async function syncModels(drive: RemoteStore) {
  const before = await loadEntries();
  const r = await syncLibrary(drive, [...before.values()], readFile, async (up) => {
    for (const e of up) await saveEntry(e);
  });
  for (const e of r.entries) {
    const old = before.get(e.id);
    if (old && JSON.stringify(old) === JSON.stringify(e)) continue;
    await saveEntry(e);
    if (e.deleted) await dropFile(e.id);
  }
  await evict();
  await refresh();
}
