// The app's settings in Google Drive: preferences (theme, language, currency, units, the settings
// page's mode), the printer and filament library, the selected presets and each printer's plate
// type. One file, DolphinSlicer/settings.json; for each setting the newer change wins.
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Drive } from '../drive/api';
import { type Library, loadLibrary } from '../presets/library';
import {
  applySelection,
  bedTypes,
  currentBedTypeKey,
  loadPresets,
  loadSaved,
  type SavedSelection,
  saveBedTypes,
  setLibrary,
} from './actions';
import type { Prefs } from './prefs';
import { updatePrefs } from './prefsActions';
import { mergeSettings, type SettingsFile, type Values } from './settingsMerge';
import { applyingSettings, loadMeta, SETTING_KEYS, type SettingKey, saveMeta } from './settingsMeta';
import { get } from './store';

const FILE = 'settings.json';

/** This device's settings, as synced. */
function localSettings(): Values {
  const p = get().prefs;
  return {
    theme: p.theme,
    language: p.language,
    currency: p.currency,
    units: p.units,
    settingsMode: p.settingsMode,
    library: loadLibrary(),
    selection: loadSaved(),
    bedTypes: bedTypes(),
  };
}

/**
 * Settings changed elsewhere, applied here. The library and the selected presets wait while
 * presets have unsaved edits (switching would drop them); they are applied at a later sync.
 */
async function applySettings(apply: Values): Promise<SettingKey[]> {
  const done: SettingKey[] = [];
  const prefs: Partial<Prefs> = {};
  for (const k of ['theme', 'language', 'currency', 'units', 'settingsMode'] as const)
    if (k in apply) {
      Object.assign(prefs, { [k]: apply[k] });
      done.push(k);
    }
  if (Object.keys(prefs).length) await updatePrefs(prefs);

  const st = get().presets.state;
  const editing = !!st?.dirty && Object.values(st.dirty).some(Boolean);
  const sel = apply.selection as SavedSelection | undefined;
  if (!editing && get().presets.status === 'ready') {
    if (apply.library) {
      const lib = apply.library as Library;
      setLibrary(lib);
      done.push('library');
      await loadPresets(lib, sel && get().presets.printers.some((e) => e.name === sel.printer) ? { printer: sel.printer } : undefined);
    }
    if (sel) {
      const now = get().presets.state;
      // A printer this device doesn't have (its vendor not loaded): left as it is.
      if (get().presets.printers.some((e) => e.name === sel.printer)) {
        if (now?.printer !== sel.printer || now.process !== sel.process || now.filaments[0] !== sel.filament)
          await applySelection({ printer: sel.printer, process: sel.process, filaments: sel.filament ? [sel.filament] : undefined });
        done.push('selection');
      }
    }
  }
  if (apply.bedTypes) {
    const m = apply.bedTypes as Record<string, string>;
    const key = currentBedTypeKey();
    const before = key ? bedTypes()[key] : undefined;
    saveBedTypes(m);
    done.push('bedTypes');
    // The current printer's plate, when it was picked elsewhere.
    const cur = get().presets.state;
    if (
      key &&
      cur &&
      m[key] &&
      m[key] !== before &&
      m[key] !== cur.bed_type &&
      cur.bed_types.includes(m[key]) &&
      get().presets.status === 'ready'
    )
      await applySelection({ bed_type: m[key] });
  }
  return done;
}

/** Sync the settings with DolphinSlicer/settings.json. */
export async function syncSettings(drive: Drive) {
  const app = await drive.folder('root', 'DolphinSlicer');
  const file = (await drive.children(app)).find((f) => f.name === FILE && !f.mimeType.endsWith('folder'));
  let remoteText = '';
  let remote: SettingsFile['settings'] = {};
  if (file) {
    remoteText = await drive.download(file.id);
    try {
      const v = JSON.parse(remoteText) as Partial<SettingsFile>;
      if (v.settings && typeof v.settings === 'object') remote = v.settings;
    } catch {
      /* unreadable: written again from this device */
    }
  }
  const before = loadMeta();
  const r = mergeSettings(localSettings(), before, remote, Date.now());
  const text = `${JSON.stringify({ version: 1, settings: r.file } satisfies SettingsFile, null, 1)}\n`;
  if (text !== remoteText && Object.keys(r.file).length) {
    if (file) await drive.update(file.id, text);
    else await drive.create(app, FILE, text);
  }
  const done = new Set(await applyingSettings(() => applySettings(r.apply)));
  // Settings applied, or as they were: what was synced. One not applied yet (unsaved edits) keeps
  // this device's entry, so it is applied at the next sync. Changed here meanwhile: noted again.
  // One applied as near as this device could (a selected preset it doesn't have): what it got is
  // as old as Drive's, so it doesn't replace Drive's, and that one isn't applied again.
  const meta = loadMeta();
  const after = localSettings();
  for (const k of SETTING_KEYS) {
    const synced = r.meta[k];
    if (!synced || (k in r.apply && !done.has(k))) continue;
    if (JSON.stringify(meta[k]) !== JSON.stringify(before[k]) && !(k in r.apply)) continue;
    const got = JSON.stringify(after[k] ?? null);
    meta[k] = k in r.apply && got !== synced.json ? { json: got, modified: synced.modified, tried: synced.json } : synced;
  }
  saveMeta(meta);
}
